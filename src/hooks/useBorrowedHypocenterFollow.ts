import { useEffect, useRef } from 'react'
import { mapChunksToRefs, borrowedHypocenterChunkRange, type SpeechFollowSession, type SpeechRef } from '../utils/ttsFollow'
import { getSpeechClock } from '../utils/voicevox'
import { log } from '../utils/logger'

/**
 * 津波の読み上げが**借りた震源**を語っているあいだ、その原因地震のカードを画面に見せる。
 *
 * 気象庁は津波警報を伴う地震で、地震情報より先に津波電文で震源を伝える。アプリはその震源を
 * 震度速報のカードへ借りて出しており（→ `utils/borrowFromTsunami.ts`）、津波の読み上げは
 * 末尾でその震源を語る。**声が震源を述べている最中に、その震源が載っているカードを見せる**のが
 * ここの役目。
 *
 * **仕組みは未入電モードの自動開閉（`useUnreceivedSpeechFollow`）と同じ。** 読み上げ側が
 * `createSpeechFollowController` のセッションを publish し、こちらは範囲に入った瞬間だけ
 * 要求を出す。rAF で解決するのも同じ理由 —— 非表示のタブではタイマーが間引かれて後から発火する。
 *
 * **範囲を抜けても戻さない。** ここが未入電側と分かれるところ。あちらが開くのは地図とカードを
 * 覆う追加表示で、関係のない話をしている間ずっと出したままにはできない。こちらが要求するのは
 * タブの移動とカードの選択で、**戻す先という概念がない** —— 震源の句は津波の読み上げの末尾に
 * あり、戻せば画面が一瞬で往復するだけになる。
 *
 * **対象はセッションが持つ主題（`subject`）で決める。** 「いま選ばれている地震」で代用すると、
 * 読み上げの順番待ちのあいだに別の地震が届いて選択が移ったとき、語っているのとは別のカードを
 * 見せることになる（選択は受信した瞬間に同期で動き、読み上げの番とは独立している）。
 */

/** {@link UseBorrowedHypocenterFollowOptions.show} の結果。 */
export type BorrowedHypocenterShowResult =
  /** 見せた */
  | 'shown'
  /** 見せないことを選んだ（正常な見送り。診断には載せない） */
  | 'declined'
  /** 見せるべきなのに見せられなかった（読んでいる地震のカードが画面に無い等） */
  | 'mismatch'

export interface UseBorrowedHypocenterFollowOptions {
  /** 読み上げの進行（`createSpeechFollowController` が publish するセッション）。 */
  session: SpeechFollowSession | null
  /**
   * その地震のカードを見せる。引数はその読み上げの主題（`SpeechFollowSession.subject`）。
   * **見せられなかったときは `shown` 以外を返すこと** —— 返り値を見ずに「見せた」と覚えると、
   * 診断が空振りに気づけなくなる。
   */
  show: (subject: string | undefined) => BorrowedHypocenterShowResult
}

export function useBorrowedHypocenterFollow({ session, show }: UseBorrowedHypocenterFollowOptions): void {
  // 最新の値を rAF ループから読むための箱（ループを作り直さずに済ませる）。
  const latest = useRef({ show })
  latest.current = { show }
  /** この読み上げで既に見せたか（同じ範囲で毎フレーム要求を出さないため）。 */
  const shownRef = useRef(false)
  /**
   * このセッションで見つけた食い違い。**セッションの終わりに 1 回だけ記録する。**
   * rAF は毎フレーム回るので、その場で出すと同じ警告が数十行続く。
   */
  const troubleRef = useRef<'mismatch' | 'noRange' | null>(null)

  useEffect(() => {
    if (!session) {
      // **閉じる処理は無い**（クラス冒頭の注記）。記録だけ残して降りる。
      if (troubleRef.current === 'mismatch') {
        log.warn('[quake] 津波が伝えた震源を読み上げているのに、その地震のカードを見せられませんでした（画面に該当のカードが無い可能性）')
      } else if (troubleRef.current === 'noRange') {
        log.warn('[quake] 借りた震源の読み上げなのに、それを含むチャンクを 1 つも引けませんでした（読み上げ文の分割と参照の対応がずれている可能性）')
      }
      troubleRef.current = null
      shownRef.current = false
      return
    }

    troubleRef.current = null
    shownRef.current = false
    let raf = 0
    let refsPerChunk: SpeechRef[][] | null = null
    let mappedChunks: readonly string[] | null = null

    const tick = () => {
      raf = requestAnimationFrame(tick)
      if (!session.chunks || session.schedule.length === 0) return

      // チャンクと参照の対応は 1 度だけ求める（チャンク列は読み上げの途中で変わらない）。
      if (refsPerChunk === null || mappedChunks !== session.chunks) {
        mappedChunks = session.chunks
        refsPerChunk = mapChunksToRefs(session.segments, session.chunks)
      }
      const range = borrowedHypocenterChunkRange(refsPerChunk)
      if (!range) {
        // セッションが始まっている＝門は真だったので、ここへ来るのはチャンク化の過程で対応が
        // 取れなかったとき（読み仮名辞書の分割・文の組み立ての変更）。
        troubleRef.current ??= 'noRange'
        return
      }
      if (shownRef.current) return

      const now = getSpeechClock()
      if (now === null) return
      // 鳴り始めた予約のうち最後のものが「いま読んでいるチャンク」
      // （`schedule` は届いた順＝ `startAt` の昇順。津波・未入電側と同じ読み方）。
      let currentIndex = -1
      for (const entry of session.schedule) {
        if (entry.startAt > now) break
        currentIndex = entry.index
      }
      if (currentIndex < range.first || currentIndex > range.last) return

      // **一度要求したら、結果によらず二度は出さない。** 見せられなかった（`mismatch`）ときに
      // 毎フレーム試し続けると、そのあいだ他の追従の要求と競り合う。
      shownRef.current = true
      const result = callGuarded(() => latest.current.show(session.subject)) ?? 'declined'
      if (result === 'mismatch') troubleRef.current ??= 'mismatch'
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [session])
}

/**
 * 呼び出し側から渡されたコールバックを、例外で rAF ループを壊さないように呼ぶ。
 *
 * **記録の文脈を残すために包む。** 握らずに投げさせると `utils/globalErrorLog.ts` の汎用捕捉に
 * 落ち、どの機能で起きたか分からなくなる。
 */
function callGuarded<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch (err) {
    log.warn('[quake] 借りた震源のカード表示に失敗', err)
    return undefined
  }
}
