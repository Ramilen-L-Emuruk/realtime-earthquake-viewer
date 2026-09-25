import { useEffect, useRef } from 'react'
import { mapChunksToRefs, unreceivedChunkRange, type SpeechFollowSession, type SpeechRef } from '../utils/ttsFollow'
import { getSpeechClock } from '../utils/voicevox'
import { log } from '../utils/logger'
import type { UnreceivedOpenResult } from '../utils/quakeOverlay'

/**
 * 未入電を声に出しているあいだだけ、未入電モードを自動で開く。
 *
 * **津波カードの追従と同じ仕組みに乗せる**（→ docs/spec/audio-tts-spec.md §6
 * 「読み上げに合わせたカードの追従」）。読み上げ側が `createSpeechFollowController` の
 * セッションを publish し、こちらはそれを見て開閉するだけ。
 *
 * **タイマーを張らず rAF で解決する。** バックグラウンドのタブではタイマーが間引かれる一方で
 * 音は実時間で鳴り終わるため、滞留したタイマーが後から発火してモードが開いたまま残る。
 * rAF なら非表示中は止まり、戻ったときに一発で正しい状態へ収束する（津波側と同じ理由）。
 *
 * **自分が開いた分しか閉じない。** 利用者が手で開いていたものを読み上げの終わりで閉じると、
 * 見ようとしていた一覧を奪うことになる。
 *
 * **対象はセッションが持つ主題（`subject`）で決める。** 「いま選ばれている地震」で代用すると、
 * 読み上げの順番待ちのあいだに別の地震が届いて選択が移ったとき、読んでいるのとは別の地震の
 * 一覧を開く（選択は受信した瞬間に同期で動き、読み上げの番とは独立している）。
 */

export interface UnreceivedSpeechFollowOptions {
  /** 読み上げの進行（`createSpeechFollowController` が publish するセッション）。 */
  session: SpeechFollowSession | null
  /**
   * いま未入電モードを開いているか。**開閉の主は呼び出し側**で、こちらは要求するだけ。
   * 手で開かれている状態を見分けるのにも使う。
   */
  isOpen: boolean
  /**
   * 未入電モードを開く。引数はその読み上げの主題（`SpeechFollowSession.subject`）。
   * **開けなかったときは `opened` 以外を返すこと。** 返り値を見ずに「開いた」と覚えると、
   * 閉じる番で他人の状態を閉じる。
   */
  open: (subject: string | undefined) => UnreceivedOpenResult
  /** 自分が開いた未入電モードを閉じる。引数は開いたときと同じ主題。 */
  /**
   * 開いた追加表示を閉じる。**録画ツール向けの記録は呼び出し先が出す**ので、ここは
   * 理由を渡すだけでよい（別の経路が先に閉じていれば何も動かず、記録も出ない）。
   */
  close: (subject: string | undefined, reason: string) => void
}

export function useUnreceivedSpeechFollow({ session, isOpen, open, close }: UnreceivedSpeechFollowOptions): void {
  // 最新の値を rAF ループから読むための箱（ループを作り直さずに済ませる）。
  const latest = useRef({ isOpen, open, close })
  latest.current = { isOpen, open, close }
  /** この読み上げで自分が開いたか（世代つき）。手で開かれたものと混ぜない。 */
  const openedRef = useRef<{ token: number; subject: string | undefined } | null>(null)
  /**
   * このセッションで見つけた食い違い。**セッションの終わりに 1 回だけ記録する。**
   * rAF は毎フレーム回るので、その場で出すと同じ警告が数十行続く。
   */
  const troubleRef = useRef<'mismatch' | 'noRange' | null>(null)

  useEffect(() => {
    // セッションが終わった（読み上げが終わった・割り込まれた・リセットされた）。
    // **自分が開いた分だけ戻す。**
    if (!session) {
      if (openedRef.current) {
        const { subject } = openedRef.current
        openedRef.current = null
        callGuarded(() => latest.current.close(subject, '読み上げが終わった'))
      }
      // 症状は「読み上げているのに画面が動かない」だけで、表示の不具合と区別できない
      // （津波の追従が引き当ての失敗を記録するのと同じ理由）。
      if (troubleRef.current === 'mismatch') {
        log.warn('[quake] 未入電を読み上げているのに、その地震のカードを開けませんでした（画面が別の地震を出している可能性）')
      } else if (troubleRef.current === 'noRange') {
        log.warn('[quake] 未入電の読み上げなのに、地点名を含むチャンクを 1 つも引けませんでした（読み上げ文の分割と参照の対応がずれている可能性）')
      }
      troubleRef.current = null
      return
    }

    troubleRef.current = null
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
      const range = unreceivedChunkRange(refsPerChunk)
      if (!range) {
        // セッションが始まっている＝`hasUnreceivedFollowTarget` は真だったので、ここへ来るのは
        // チャンク化の過程で対応が取れなかったとき（読み仮名辞書の分割・文の組み立ての変更）。
        troubleRef.current ??= 'noRange'
        return
      }

      const now = getSpeechClock()
      if (now === null) return
      // 鳴り始めた予約のうち最後のものが「いま読んでいるチャンク」。
      // `schedule` は届いた順＝ `startAt` の昇順に積まれる（津波側と同じ読み方）。
      let currentIndex = -1
      for (const entry of session.schedule) {
        if (entry.startAt > now) break
        currentIndex = entry.index
      }
      if (currentIndex < 0) return

      const inRange = currentIndex >= range.first && currentIndex <= range.last
      if (inRange && !openedRef.current) {
        // **手で開かれているものには触らない。** ここで開いたことにすると、読み終えた番で
        // 利用者が自分で開いた一覧を閉じることになる。開いたのが自分かどうかは
        // `openedRef` が持ち、そこへ入れなければ閉じる側も動かない。
        if (latest.current.isOpen) return
        // **開けたときだけ覚える。** 読んでいる地震が画面に無いなど、開けないことがある。
        const result = callGuarded(() => latest.current.open(session.subject)) ?? 'declined'
        if (result === 'opened') {
          // 録画ツール向けの記録は `open` の呼び出し先が出す（開けた回だけ画面が動く）。
          openedRef.current = { token: session.token, subject: session.subject }
        }
        else if (result === 'mismatch') troubleRef.current ??= 'mismatch'
        return
      }
      // 未入電の並びを読み終えた。**読み上げの終わりを待たない** —— この後に続く文
      // （津波区分の言い直しなど）のあいだ開いたままにすると、関係のない話をしている間ずっと
      // 地図とカードが未入電だけの画になる。
      if (!inRange && currentIndex > range.last && openedRef.current) {
        const { subject } = openedRef.current
        openedRef.current = null
        callGuarded(() => latest.current.close(subject, '未入電の並びを読み終えた'))
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [session])

  // 画面から消えるときに開けっ放しにしない。**本体を持たないのは、後始末だけが目的のため**
  // （依存が空なのでマウント時には何もしない）。
  useEffect(() => () => {
    if (openedRef.current) {
      const { subject } = openedRef.current
      openedRef.current = null
      callGuarded(() => latest.current.close(subject, 'アンマウント'))
    }
  }, [])
}

/**
 * 呼び出し側から渡されたコールバックを、例外で rAF ループを壊さないように呼ぶ。
 *
 * **記録の文脈を残すために包む。** 握らずに投げさせると `utils/globalErrorLog.ts` の汎用捕捉に
 * 落ち、どの機能で起きたか分からなくなる（rAF ループ自体は `requestAnimationFrame` を本体より
 * 先に呼んでいるので止まらない）。
 */
function callGuarded<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch (err) {
    log.warn('[quake] 未入電モードの開閉に失敗', err)
    return undefined
  }
}
