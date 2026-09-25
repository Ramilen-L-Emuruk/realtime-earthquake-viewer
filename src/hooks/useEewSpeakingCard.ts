import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { log } from '../utils/logger'

/**
 * 語り終わったあと、その地震について**まだ語ることが残っているか**を確かめ直す間隔。
 *
 * **一度確かめるだけでは足りない。** 「残っている」と見て印を保った後に、その予約が
 * 発話へ至らず捨てられることがある（誤報取消・リプレイのリセット・画面を閉じたとき）。
 * 捨てる箇所を数え上げてそこから印を落とす形にすると、**見落とした経路の分だけ印が
 * 永久に残る** —— 残っているあいだ定期的に見直せば、捨てられ方を問わず必ず消える。
 *
 * 短くしても機能は変わらない（消えるのが速くなるだけ）。ここは精度の値で、
 * 見え方は {@link EEW_SPEAKING_CARD_AFTERGLOW_MS} が持つ。
 *
 * **非表示のタブではブラウザがタイマーを間引くので、この周期も残像も伸びる。** 印が実際より
 * 長く残るが、見ている人がいないあいだの話で、戻れば次の見直しで消える。ここは許容している。
 */
export const EEW_SPEAKING_CARD_PENDING_POLL_MS = 500

/**
 * その地震について語ることが尽きたと判ってから、印を消すまでの残像。
 *
 * **鳴り終わった瞬間に落とさないのが要点。** 予想値の発話は「予想最大震度5強。」のように
 * 短く、**声で気づいて画面へ目を移した人には何も残らない**。
 *
 * **{@link EEW_SPEAKING_CARD_PENDING_POLL_MS} と兼ねないこと。** あちらは短いほど正確で、
 * こちらは短すぎると見えない。1 つの値にすると、精度を上げたつもりで残像が消える。
 */
export const EEW_SPEAKING_CARD_AFTERGLOW_MS = 800

/**
 * 語ることが尽きないまま印を保ち続ける上限。超えたら判定の答えによらず落とし、記録を残す。
 *
 * **安全弁であって、通常はここまで来ない。** 予約が正常に消化されれば
 * {@link EEW_SPEAKING_CARD_PENDING_POLL_MS} の見直しで尽きたことが判る。ここが効くのは
 * 「どこかの予約が取り消しも確定もされずに残った」とき —— 見直しを入れたことで
 * 「捨てられた予約」は覆えたが、「消えない予約」は覆えないため、旧実装（一律の猶予）が
 * 副次的に持っていた「最悪でも N 秒で消える」性質をここで残す。
 *
 * 値は「別の地震が長く鳴っていて、この地震の次の発話が待たされている」正常系を切らない長さ。
 * 緊急地震速報どうしの発話はどれも数秒で、非 EEW は優先度が下なので EEW を待たせない。
 *
 * **起点は後始末のたびに引き直す。** 長く続く地震でも、発話が 1 つ済むごとに `begin` → `end` と
 * 進んで新しい起点になるので、ここへ達するのは「60 秒のあいだ一度も声にならないまま予約だけが
 * 残っている」場合に限る。**実配信でそれが起きるかは確かめていない** —— 起きたときに記録が
 * 出るようにしてあるので、出たらその値を見直す。
 */
export const EEW_SPEAKING_CARD_MAX_HOLD_MS = 60_000

/**
 * 緊急地震速報の読み上げが、いまどの地震を語っているかを画面へ伝える受け口。
 *
 * **世代トークンを添えるのは、後始末が別の発話の印を消さないため。** `end` を eventId で
 * 照合すると、**リプレイの開始・停止をまたいで同じ eventId が復帰したときに壊れる** ——
 * `resetTracking` はチェーンの参照を差し替えるだけで、合成の応答を待っている発話は止まらない。
 * その取り残された `end` が、新しい時間軸で同じ地震について始まった発話の印に対して
 * 後始末を掛け、**まだ語っている最中に消す**。トークンが一致するときだけ状態を触れば起きない。
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
   *
   * @param hasPendingSpeech その地震について**まだ声にする予定が残っているか**
   *   （`utils/eewPendingSpeech.ts`）。真を返すあいだ印を保ち、偽になったら
   *   {@link EEW_SPEAKING_CARD_AFTERGLOW_MS} を置いて消す。**呼び出し側が判定を持つのは、
   *   予約の在り処を知っているのが向こうだから**（各フェーズの予約と、震度・長周期階級の
   *   安定待ち）。ここへ時間の代理値（「語り終わってから N 秒」）を置くと、安定待ちが
   *   N を超えれば読み上げの途中で消え、語り終われば N だけ余計に残る —— 両方向にずれる。
   *
   *   **投げたら印を落とす。** 判らないまま保ち続けるより軽い。
   */
  end: (token: number, hasPendingSpeech: () => boolean) => void
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
 * **印を保つのは「その地震について語ることが残っているあいだ」。** 緊急地震速報の読み上げは
 * 名乗り →（警報級なら警報の対象地方 →）予想値と段が分かれ、段と段のあいだには安定待ち（最大 5 秒）が挟まる。
 * 鳴り終わりで落とすと段のたびに点滅するが、**時間で猶予を置くのは代理値**にすぎない ——
 * 「まだ語ることが残っているか」という事実は呼び出し側に key 単位であるので、それを直接見る
 * （{@link EewSpeakingCardFollow.end} の `hasPendingSpeech`）。
 *
 * **「語っているのに画面にカードが無い」を記録しない。** 似た仕組み（未入電モードの自動開閉・
 * 借りた震源のカード表示）は引き当ての失敗を記録するが、こちらは**正常に起きる** ——
 * 誤報取消の読み上げは間を置いてから発火するので、その間に取消カードの後片付け（10 秒）が
 * 済んでいれば、カードの無い地震について語ることになる。記録を置けば誤検知になる。
 */
export function useEewSpeakingCard(): {
  /** いま声が語っている eventId（語り終わりの残像のあいだも残る）。 */
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
  /**
   * いま印を持っている eventId。**記録のためだけに持つ** —— 判定も照合も世代トークン
   * （{@link currentRef}）で行う。同時多発がこの機能の想定場面なので、安全弁や判定の失敗が
   * 記録に出たとき「どの地震の印が落ちたか」が判らないと、原因を他の記録と時刻で
   * 突き合わせるしかなくなる。
   */
  const currentKeyRef = useRef<string | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return
    clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  // 画面を閉じたときに見直しのタイマーを残さない。
  useEffect(() => clearTimer, [clearTimer])

  const follow = useMemo<EewSpeakingCardFollow>(() => ({
    begin: key => {
      clearTimer()
      const token = ++seqRef.current
      currentRef.current = token
      currentKeyRef.current = key
      setSpeakingKey(key)
      return token
    },
    end: (token, hasPendingSpeech) => {
      // **いま印を持っている発話の語り終わりだけを受ける。** 世代が進んでいれば、
      // その発話は既に別の発話（またはリセット）に置き換わっている。
      if (currentRef.current !== token) return
      clearTimer()

      // 上限（{@link EEW_SPEAKING_CARD_MAX_HOLD_MS}）の起点。**実時計で測る** ——
      // 表示の寿命なので、リプレイの再生時計には乗せない。
      const heldSince = Date.now()

      /** 印を落とす。世代が進んでいれば何もしない（次の発話の印を奪わない）。 */
      const drop = () => {
        timerRef.current = null
        if (currentRef.current !== token) return
        currentRef.current = null
        currentKeyRef.current = null
        setSpeakingKey(null)
      }

      /** まだ語ることが残っているか。判らなければ null（落とす側へ倒す）。 */
      const check = (): boolean | null => {
        try {
          return hasPendingSpeech()
        } catch (err) {
          log.warn('[eew] 語る予定が残っているか判らず、カードの印を落とす', currentKeyRef.current, err)
          return null
        }
      }

      /** まだ語ることが残っているかを見る。残っていれば保ち、尽きていれば残像へ移る。 */
      const poll = () => {
        timerRef.current = null
        if (currentRef.current !== token) return
        const heldMs = Date.now() - heldSince
        if (heldMs >= EEW_SPEAKING_CARD_MAX_HOLD_MS) {
          // 予約が取り消しも確定もされずに残っている。印を残し続けるより落とす。
          log.warn('[eew] 語る予定が尽きないまま上限に達したので、カードの印を落とす', { key: currentKeyRef.current, heldMs })
          drop()
          return
        }
        const pending = check()
        if (pending === null) { drop(); return }
        timerRef.current = pending
          ? setTimeout(poll, EEW_SPEAKING_CARD_PENDING_POLL_MS)
          : setTimeout(afterglow, EEW_SPEAKING_CARD_AFTERGLOW_MS)
      }

      /**
       * 残像が明けた。**ここでもう一度確かめる** —— 残像のあいだに次の電文が届いて新しい
       * 予約が積まれることがある（実配信の続報の間隔は 0.3〜2 秒で、**残像より短いことがある**）。
       * 確かめずに落とすと印が一瞬消えて次の発話で点き直し、窓が縮んだだけで点滅が残る。
       *
       * **残像を続報の間隔の上限（2 秒）まで延ばすことはしない。** 残像を過ぎてから続報が
       * 届く場合、そのあいだは本当にその地震について何も語っていない —— 印が消えているのが
       * 正しく、次の発話で点き直すのは点滅ではない。直したかったのは「**安定待ちの最中**に
       * 消える」ことで、あちらは「これから語る」と確定しているぶん性質が違う。
       */
      const afterglow = () => {
        timerRef.current = null
        if (currentRef.current !== token) return
        if (check() === true) {
          timerRef.current = setTimeout(poll, EEW_SPEAKING_CARD_PENDING_POLL_MS)
          return
        }
        drop()
      }

      // 1 回目はその場で見る。語り終わりに残っていなければ、待たずに残像へ移る。
      poll()
    },
    reset: () => {
      clearTimer()
      currentRef.current = null
      currentKeyRef.current = null
      setSpeakingKey(null)
    },
  }), [clearTimer])

  return { speakingKey, follow }
}
