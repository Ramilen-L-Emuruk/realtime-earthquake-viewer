import { useCallback, useEffect, useRef, useState } from 'react'
import type { MapHandle } from '../components/Map/mapTypes'
import { captureMapImage } from '../components/Map/gl/captureMap'
import { formatFileStamp } from '../utils/formatters'
import { log } from '../utils/logger'
import {
  composeShareCard,
  currentAppUrl,
  DEFAULT_SHARE_CARD_FORMAT,
  shareCardMapHeight,
  shareOrDownloadImage,
} from '../utils/shareCard'
import { buildShareCardContent, type ShareCardContentInput } from '../utils/shareCardContent'

// 共有カードを作る一連の流れ（撮影 → 合成 → 共有／保存）をまとめる。
//
// 共有シートへは画像と一緒に本文も渡す。共有シートを持たない環境（デスクトップ等）では画像を
// 保存し、渡し先の無くなった本文はクリップボードへ置く。
//
// 撮るのは**画面に見えている構図そのまま**（中心とズームを保つ）。カード用の寸法は画面と縦横比が
// 違うので見える範囲は広がるが、利用者が動かした視点は動かさない。

/** 結果をボタンに残す時間。押し直せる状態へは自動で戻す。 */
const RESULT_DISPLAY_MS = 4000

export type ShareCardState = 'idle' | 'working' | 'error' | 'copied' | 'copyFailed'

export interface UseShareCard {
  share: () => void
  state: ShareCardState
  /** 地図がまだ無い間は押させない。 */
  ready: boolean
}

export function useShareCard(handle: MapHandle | null, content: ShareCardContentInput): UseShareCard {
  const [state, setState] = useState<ShareCardState>('idle')
  // 見出しの材料は毎レンダー新しいオブジェクトになる。依存に置くと share が作り直され、
  // それを受け取るボタンも毎回描き直しになるため、ref 越しに読む。
  const contentRef = useRef(content)
  useEffect(() => {
    contentRef.current = content
  }, [content])
  // 二重起動の防止は ref で持つ。state を条件にすると、押した直後の再レンダーが来る前の
  // 2 回目のクリックを通してしまい、撮影が二重に走る（寸法の退避と復元が交錯する）。
  const busyRef = useRef(false)
  const resetTimerRef = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(resetTimerRef.current), [])

  const share = useCallback(
    () => {
      if (!handle || busyRef.current) return
      busyRef.current = true
      window.clearTimeout(resetTimerRef.current)
      setState('working')
      void (async () => {
        try {
          // **見出しと出典を先に決める。** 出典の行数で地図に割ける高さが変わるため、撮影の
          // 寸法はここが確定してからでないと出せない（`shareCardMapHeight`）。
          const built = buildShareCardContent(contentRef.current, currentAppUrl())
          const format = DEFAULT_SHARE_CARD_FORMAT
          const capture = await captureMapImage(handle.map, {
            width: format.width,
            height: shareCardMapHeight(format, built.notices.length),
            drawOverlay: handle.drawExtras,
          })
          const blob = await composeShareCard({ capture, header: built.header, notices: built.notices, format })
          // 保存名の時刻は**書き出した時刻**なので壁時計で採る（アプリ時計 `serverNow` ではない）。
          // 電文ログ・診断ログのダウンロードも同じで、データ自身の時刻を名前にするときだけ
          // そのデータの時刻を渡す（`components/TelegramTab` / `components/SettingsTab`）。
          const outcome = await shareOrDownloadImage(
            blob,
            `${built.filenameLabel}_${formatFileStamp(Date.now())}.png`,
            built.shareText,
          )
          log.debug('[shareCard] 共有カードを作成しました', {
            result: outcome.result,
            // クリップボードを使うのは保存へ落ちたときだけ。共有シートが応じた記録に偽を並べると、
            // 「コピーに失敗した」と読めてしまう。
            ...(outcome.result === 'downloaded' ? { textCopied: outcome.textCopied } : {}),
            bytes: blob.size,
            incomplete: capture.timedOut,
          })
          // 本文をクリップボードへ置いたか（置けなかったか）は、画面に出さないと伝わらない。
          // **共有シートが応じた場合と混ぜない**——そちらは本文も一緒に渡っており、クリップボードは
          // 使っていない。判定に `textCopied` だけを使うと、その正常系と「置けなかった」が同じ扱いになる。
          if (outcome.result === 'downloaded') {
            setState(outcome.textCopied ? 'copied' : 'copyFailed')
            resetTimerRef.current = window.setTimeout(() => setState('idle'), RESULT_DISPLAY_MS)
          } else {
            setState('idle')
          }
        } catch (e) {
          // 画像が出てこない理由が分からないまま終わらせない。ボタンに残したうえで記録も残す。
          log.error('[shareCard] 共有カードを作成できませんでした', e)
          setState('error')
          resetTimerRef.current = window.setTimeout(() => setState('idle'), RESULT_DISPLAY_MS)
        } finally {
          busyRef.current = false
        }
      })()
    },
    [handle],
  )

  return { share, state, ready: handle !== null }
}
