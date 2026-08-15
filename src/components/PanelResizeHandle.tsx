import { memo, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { PANEL_RATIO_MIN, PANEL_RATIO_MAX } from '../hooks/useSettings'

// この距離（px）以内で指・マウスを離した場合はドラッグではなくタップとみなし、
// 折りたたみのトグルとして扱う。小さすぎると畳もうとして僅かに動いただけで
// リサイズ扱いになり、大きすぎると短いドラッグが勝手に折りたたみになる。
const TAP_THRESHOLD_PX = 6
// キーボード（上下キー）操作 1 回あたりの変化量。
const KEY_STEP = 0.05

function clampRatio(ratio: number): number {
  return Math.min(PANEL_RATIO_MAX, Math.max(PANEL_RATIO_MIN, ratio))
}

interface Props {
  /** 現在のパネル高さ比率（0.2〜0.8）。折りたたみ中も「展開したときの比率」を保持する。 */
  ratio: number
  /** パネルが折りたたまれているか。つまみの見た目と aria-expanded に反映する。 */
  collapsed: boolean
  /** ドラッグ中の連続更新（設定への保存は行わない）。 */
  onRatioChange: (ratio: number) => void
  /** ドラッグ確定時の更新（設定へ保存する）。 */
  onRatioCommit: (ratio: number) => void
  /** タップ・Enter/Space による折りたたみトグル。 */
  onToggleCollapse: () => void
}

// 地図とパネルの境界に置くつまみ。縦積みレイアウト（スマホ縦など）専用で、
// 左右分割時（side ブレークポイント）は非表示になりパネル幅は固定になる。
// ドラッグで地図とパネルの比率を変え、タップで折りたたみをトグルする。
export const PanelResizeHandle = memo(function PanelResizeHandle({
  ratio, collapsed, onRatioChange, onRatioCommit, onToggleCollapse,
}: Props) {
  const handleRef = useRef<HTMLDivElement>(null)
  // ドラッグ中の状態。moved=false のまま離されたらタップ（折りたたみトグル）と判定する。
  // startRatio はドラッグ開始時の比率で、以降は「開始位置からの移動量」で比率を求める。
  // pointerId を保持するのは、つまみが画面幅いっぱいの帯で 2 本目の指が触れうるため。
  // 追跡中でない指のイベントは無視し、起点情報が上書きされないようにする。
  const dragRef = useRef<{ pointerId: number; startY: number; startRatio: number; moved: boolean; ratio: number } | null>(null)

  // ドラッグ開始位置からの移動量でパネル高さ比率を求める。
  // ポインタの絶対位置から求めると、親コンテナ（地図＋つまみ＋パネル＋アイコンナビ）の
  // 下端とパネルの下端がナビの高さぶんずれているため、指とつまみの位置が離れていく。
  // 移動量ベースなら比率の変化量が指の移動量と 1 対 1 で対応する。
  const ratioFromPointer = (clientY: number, startY: number, startRatio: number): number | null => {
    const container = handleRef.current?.parentElement
    if (!container) return null
    const height = container.getBoundingClientRect().height
    if (height <= 0) return null
    // 上へ動かすほどパネルが広がる（比率が増える）。
    return clampRatio(startRatio + (startY - clientY) / height)
  }

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // 既に別の指を追跡中なら、そちらを優先して 2 本目以降は無視する。
    if (dragRef.current) return
    // ポインタを捕捉して、指が地図やパネルの上へ滑ってもドラッグを継続させる。
    // 捕捉に失敗しても（無効な pointerId 等）ドラッグ自体は続行できるので、状態の初期化は必ず行う。
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch { /* 捕捉できない環境・状況では通常のイベント伝播にまかせる */ }
    dragRef.current = { pointerId: e.pointerId, startY: e.clientY, startRatio: ratio, moved: false, ratio }
  }

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    // 閾値を超えるまではタップの可能性を残す（微小なブレでリサイズを始めない）。
    if (!drag.moved && Math.abs(e.clientY - drag.startY) < TAP_THRESHOLD_PX) return
    // 閾値を超えた時点でドラッグと確定させる。比率計算の成否より先に立てるのが要点で、
    // 後に回すと「計算に失敗した長いドラッグ」が指を離した瞬間にタップ扱いとなり、
    // 意図しない折りたたみが起きる（危険側の誤動作）。
    drag.moved = true
    const next = ratioFromPointer(e.clientY, drag.startY, drag.startRatio)
    if (next === null) return
    drag.ratio = next
    onRatioChange(next)
  }

  const handlePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    // 追跡していない指が離れただけなら何もしない（2 本目の指で折りたたみが起きるのを防ぐ）。
    if (!drag || drag.pointerId !== e.pointerId) return
    dragRef.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    if (!drag.moved) {
      onToggleCollapse()
      return
    }
    onRatioCommit(drag.ratio)
  }

  // ドラッグ中に他要素がポインタを奪った場合（システムジェスチャー等）。
  // 直前までの比率は onRatioChange で反映済みのため、確定させて状態を揃える。
  const handlePointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    dragRef.current = null
    if (drag.moved) onRatioCommit(drag.ratio)
  }

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      // 上キーでパネルを広げ（地図が狭まる）、下キーで狭める。
      onRatioCommit(clampRatio(ratio + (e.key === 'ArrowUp' ? KEY_STEP : -KEY_STEP)))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onToggleCollapse()
    }
  }

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation="horizontal"
      aria-label="地図と情報パネルの境界（ドラッグで高さ調整・タップで折りたたみ）"
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={Math.round(PANEL_RATIO_MIN * 100)}
      aria-valuemax={Math.round(PANEL_RATIO_MAX * 100)}
      aria-expanded={!collapsed}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onKeyDown={handleKeyDown}
      // touch-none（touch-action: none）でブラウザのスクロール・ズームジェスチャーより
      // ドラッグを優先する。これがないとタッチ操作でポインタイベントが途中で奪われる。
      className="side:hidden flex-shrink-0 h-5 flex items-center justify-center bg-panel border-t border-border cursor-row-resize touch-none select-none focus:outline-none focus-visible:ring-1 focus-visible:ring-white/40"
    >
      <div
        className={`rounded-full transition-all ${collapsed ? 'w-14 h-1.5 bg-white/50' : 'w-10 h-1 bg-white/25'}`}
      />
    </div>
  )
})
