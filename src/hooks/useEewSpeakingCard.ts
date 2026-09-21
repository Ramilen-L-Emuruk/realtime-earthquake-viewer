import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/**
 * 語り終わってから、そのカードの強調を消すまでの猶予。
 *
 * **鳴り終わった瞬間に落とさないのが要点。** 予想値の発話は「予想最大震度5強。」のように
 * 短く、**声で気づいて画面へ目を移した人には何も残らない**。長めに取っても、次の発話が
 * 別の地震なら `begin` が上書きするので「もう語っていないものが光り続ける」時間は
 * 続報の間隔（1〜数秒）で打ち切られる。
 */
export const EEW_SPEAKING_CARD_LINGER_MS = 5000

/**
 * 緊急地震速報の読み上げが、いまどの地震を語っているかを画面へ伝える受け口。
 *
 * **世代トークンを添えるのは、後始末が別の発話の印を消さないため。** `end` を eventId で
 * 照合すると、**リプレイの開始・停止をまたいで同じ eventId が復帰したときに壊れる** ——
 * `resetTracking` はチェーンの参照を差し替えるだけで、合成の応答を待っている発話は止まらない。
 * その取り残された `end` が、新しい時間軸で同じ地震について始まった発話の印に対して
 * 猶予を張り、**まだ語っている最中に消す**。トークンが一致するときだけ状態を触れば起きない。
 *
 * この形は `SpeechFollowApi`（津波カードの追従）と、緊急地震速報の各フェーズの予約
 * （`eewPhase1TokensRef` ほか）が既に採っているもの。
 *
 * **対応しない後始末を受けても壊れない。** 世代で照合するので、古い発話の `end` が遅れて
 * 届いても新しい印は落ちない。**呼び出し側（`chainEEWSpeech`）が「印を立てた回だけ `end` を
 * 呼ぶ」ことと、これは別の守り** —— あちらは渡すトークンが無いから呼ばないのであって、
 * こちらはリセットをまたいで遅れて届く分に備える。どちらも要る。
 */
export interface EewSpeakingCardFollow {
  /**
   * その eventId を語り始めた（声に出すものが決まった瞬間に呼ぶ）。
   * 以降の後始末に添える世代トークンを返す。
   */
  begin: (key: string) => number
  /**
   * 語り終わった（合成が 1 音も鳴らずに終わった場合も含む）。{@link begin} が返した
   * トークンを渡すこと。**黙る判断で降りた回は呼ばない** —— 印を立てていないので
   * 渡すトークンが無い。
   */
  end: (token: number) => void
  /** 時間軸が変わった（リプレイの開始・停止）。世代を問わず印ごと落とす。 */
  reset: () => void
}

/**
 * 「いま声が語っている緊急地震速報」を画面へ渡すための状態。
 *
 * 同時に複数の緊急地震速報が発表されると、読み上げは eventId をまたいで交錯する ——
 * 発話そのものは 1 本の待ち行列で直列化しているが、予想値の発火は eventId ごとに独立した
 * 安定待ち（300ms〜5 秒）を経るため、**発報順と読み上げ順は一致しない**。しかも震源名を
 * 声にするのは第 1 フェーズだけなので、予想値の発話だけを聞いても、それがどの地震のものか
 * 判らない。
 *
 * **声で言い分ける道は実データが否定した。** 同時多発するのは同じ震源域なので、
 * 交錯する場面ほど震央地名が重複する（2024-01-03・2024-11-26 の実配信で、重なった 3 組の
 * うち 2 組が同名）。加えて震央地名は続報で変わり（54 地震中 19 件）、その変化は
 * 言い直しの下限（`EEW_HYPOCENTER_RESTATE_KM` = 50km）に届かないので声にならない ——
 * 最新の震央地名を添えると、一度も名乗っていない名前でその地震を呼ぶことになる。
 *
 * そこで「どちらの地震か」は画面が担う。カードは元から全件並んでいるので、足りないのは
 * 「いま声が語っているのはこれ」という印だけ。
 *
 * **「語っているのに画面にカードが無い」を記録しない。** 似た仕組み（未入電モードの自動開閉・
 * 借りた震源のカード表示）は引き当ての失敗を記録するが、こちらは**正常に起きる** ——
 * 誤報取消の読み上げは間を置いてから発火するので、その間に取消カードの後片付け（10 秒）が
 * 済んでいれば、カードの無い地震について語ることになる。記録を置けば誤検知になる。
 */
export function useEewSpeakingCard(): {
  /** いま声が語っている eventId（猶予のあいだも残る）。 */
  speakingKey: string | null
  follow: EewSpeakingCardFollow
} {
  const [speakingKey, setSpeakingKey] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 単調増加の世代。`begin` のたびに進める。 */
  const seqRef = useRef(0)
  /**
   * いま印を持っている発話。**state を読まずこちらで照合する** —— `follow` は一度しか
   * 作らないので（依存が空）、クロージャが掴むのは初回レンダーの値になる。
   */
  const currentRef = useRef<number | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return
    clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  // 画面を閉じたときに猶予のタイマーを残さない。
  useEffect(() => clearTimer, [clearTimer])

  const follow = useMemo<EewSpeakingCardFollow>(() => ({
    begin: key => {
      clearTimer()
      const token = ++seqRef.current
      currentRef.current = token
      setSpeakingKey(key)
      return token
    },
    end: token => {
      // **いま印を持っている発話の語り終わりだけを受ける。** 世代が進んでいれば、
      // その発話は既に別の発話（またはリセット）に置き換わっている。
      if (currentRef.current !== token) return
      clearTimer()
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        if (currentRef.current !== token) return
        currentRef.current = null
        setSpeakingKey(null)
      }, EEW_SPEAKING_CARD_LINGER_MS)
    },
    reset: () => {
      clearTimer()
      currentRef.current = null
      setSpeakingKey(null)
    },
  }), [clearTimer])

  return { speakingKey, follow }
}
