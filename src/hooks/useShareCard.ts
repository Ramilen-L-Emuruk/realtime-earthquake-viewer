import { useCallback, useEffect, useRef, useState } from 'react'
import type { MapHandle } from '../components/Map/mapTypes'
import { captureMapImage } from '../components/Map/gl/captureMap'
import { formatFileStamp } from '../utils/formatters'
import { log } from '../utils/logger'
import {
  composeShareCard,
  DEFAULT_SHARE_CARD_FORMAT,
  shareCardMapHeight,
  shareOrDownloadImage,
} from '../utils/shareCard'
import { buildShareCardContent, type ShareCardContentInput } from '../utils/shareCardContent'

// 共有カードを作る一連の流れ（撮影 → 合成 → 共有／保存）をまとめる。
//
// 撮るのは**画面に見えている構図そのまま**（中心とズームを保つ）。カード用の寸法は画面と縦横比が
// 違うので見える範囲は広がるが、利用者が動かした視点は動かさない。

/** 失敗をボタンに残す時間。押し直せる状態へは自動で戻す。 */
const ERROR_DISPLAY_MS = 4000

export type ShareCardState = 'idle' | 'working' | 'error'

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
  const errorTimerRef = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(errorTimerRef.current), [])

  const share = useCallback(
    () => {
      if (!handle || busyRef.current) return
      busyRef.current = true
      window.clearTimeout(errorTimerRef.current)
      setState('working')
      void (async () => {
        try {
          // **見出しと出典を先に決める。** 出典の行数で地図に割ける高さが変わるため、撮影の
          // 寸法はここが確定してからでないと出せない（`shareCardMapHeight`）。
          const built = buildShareCardContent(contentRef.current)
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
          const result = await shareOrDownloadImage(blob, `${built.filenameLabel}_${formatFileStamp(Date.now())}.png`)
          log.debug('[shareCard] 共有カードを作成しました', {
            result,
            bytes: blob.size,
            incomplete: capture.timedOut,
          })
          setState('idle')
        } catch (e) {
          // 画像が出てこない理由が分からないまま終わらせない。ボタンに残したうえで記録も残す。
          log.error('[shareCard] 共有カードを作成できませんでした', e)
          setState('error')
          errorTimerRef.current = window.setTimeout(() => setState('idle'), ERROR_DISPLAY_MS)
        } finally {
          busyRef.current = false
        }
      })()
    },
    [handle],
  )

  return { share, state, ready: handle !== null }
}
