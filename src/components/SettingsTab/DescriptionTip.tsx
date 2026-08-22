import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { computePlacement, tipMaxWidth, type TipPlacement } from './tipPlacement'

/**
 * ルートの font-size（px）。UI 倍率はこの値を変える設計なので、rem 基準の寸法は
 * これを掛けて実 px にする。読めない環境では既定の 16px を仮定する
 * （倍率は効かなくなるが位置は破綻しない）。
 */
function rootFontPx(): number {
  const root = parseFloat(getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(root) && root > 0 ? root : 16
}

function currentViewport() {
  return { width: window.innerWidth, height: window.innerHeight }
}

/**
 * 吹き出しを出す基準の矩形。ラベルではなく**行全体**を基準にする。
 *
 * パネルが狭いとき（sideNarrow）、行は「ラベル上・コントロール下」の 2 段に折り返す。
 * ラベルの直下を基準にすると、そこはもうコントロールの居場所なので、APIキーや VOICEVOX URL の
 * 入力欄と、その下に出る検証エラーの赤字を吹き出しが覆ってしまう（実測で 28x119px 重なった）。
 * 行の下端を基準にすれば、折り返しの有無に関わらず操作対象を隠さない。
 *
 * 現状の呼び出し元は `Row` だけで、そこでは必ず目印が付く。フォールバックは
 * `Row` 以外から使われたときに位置が壊れないための保険。
 */
function anchorRectFor(label: HTMLElement): DOMRect {
  const row = label.closest<HTMLElement>('[data-settings-row]')
  return (row ?? label).getBoundingClientRect()
}

interface Props {
  label: string
  description: string
}

/**
 * 設定行のラベル。説明文は常時表示せず、ホバー・フォーカス・タップで吹き出しとして出す。
 *
 * 開いている理由を 3 つに分けて持つ:
 * - **hovered**: マウスが乗っている間だけ
 * - **focused**: キーボードフォーカスが当たっている間だけ
 * - **pinned**: クリック（タップ）で固定した状態
 *
 * 1 つの状態でトグルにすると、PC でホバー中にクリックしたときに「開いているものを閉じる」
 * 動作になり、押した瞬間に説明が消える。タッチには hover が無いので pin だけが効く。
 * ホバーとフォーカスを同じ状態にまとめると、フォーカスで開いている最中にマウスがラベルを
 * 通り過ぎるだけで（pointerleave が来て）フォーカス由来の表示まで消えてしまう。
 */
export function DescriptionTip({ label, description }: Props) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [placement, setPlacement] = useState<TipPlacement | null>(null)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const tipId = useId()

  const open = hovered || focused || pinned

  const close = useCallback(() => {
    setHovered(false)
    setFocused(false)
    setPinned(false)
  }, [])

  // hover を立てるのはマウスのときだけ。iOS Safari は :hover を成立させるためタップでも
  // mouseenter 相当を合成発火する。それを拾うと、タップで開いたあと再タップして pin を
  // 外しても hovered が残って閉じない（タッチでは mouseleave が来ない）。
  // 倒す側は絞らない — 立ったままにするより、閉じる方へ倒す。
  const handlePointerEnter = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === 'mouse') setHovered(true)
  }, [])

  // 位置は「実際に描かれた高さ」が分からないと決まらない（下に出しきれるかの判定に使う）。
  // そのため開いた最初のレンダーでは折り返し幅だけを与えて隠したまま描き、ここで測ってから
  // 位置を確定させる。位置が決まるまで描画を遅らせると、測る対象が DOM に無いまま
  // この effect が走ってしまい、反転がまったく効かなくなる。
  // useEffect ではなく useLayoutEffect なのは、ブラウザが描く前に確定させてちらつきを防ぐため。
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null)
      return
    }
    const anchor = anchorRef.current
    const tip = tipRef.current
    if (!anchor || !tip) return
    const viewport = currentViewport()
    const maxWidth = tipMaxWidth(viewport.width, rootFontPx())
    setPlacement(computePlacement(anchorRectFor(anchor), tip.offsetHeight, maxWidth, viewport))
  }, [open, description])

  // fixed 配置はスクロールに追従しないため、動いたら閉じる（追従させると基準の行が
  // 画面外へ出た後も吹き出しだけが残る）。capture で拾うのは、スクロールするのが
  // window ではなくタブ内のスクロール領域で、scroll イベントが上へバブルしないため。
  // resize は UI 倍率の変更でも届く（App.tsx がルートの font-size を変えた直後に発火している）。
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    // 吹き出し自身は pointer-events を持たないため、判定に入れる必要はない（ラベルだけ除外する）。
    // つまみのドラッグ（PanelResizeHandle）もここで拾って閉じる。掴んだ時点で pointerdown が
    // 来るので、レイアウトが動く前に閉じられる。
    const onPointerDown = (e: PointerEvent) => {
      if (anchorRef.current?.contains(e.target as Node | null)) return
      close()
    }
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open, close])

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        // 説明を持つ行だけ点線下線を出す。border-b では <button> の幅いっぱいに線が伸びて
        // 文字より長く残るため、テキストに追従する text-decoration を使う。
        className="text-white text-sm text-left underline decoration-dotted decoration-secondary/60 underline-offset-4 cursor-help focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500 rounded"
        // 紐づけは aria-describedby だけでよい（WAI-ARIA の tooltip パターン）。
        // aria-expanded は disclosure 系の属性で、読み上げが「展開」と「説明」を二重に伝える。
        aria-describedby={open ? tipId : undefined}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onClick={() => setPinned(p => !p)}
      >
        {label}
      </button>
      {open && (
        <div
          ref={tipRef}
          id={tipId}
          role="tooltip"
          // マウスを遮らせない。吹き出しは行の下に出るぶん次の行に重なるため、操作を
          // 受け付けると覆った下のコントロールが押せなくなる（本文の選択より操作を優先する）。
          className="fixed z-50 rounded-md border border-border bg-panel px-2.5 py-1.5 text-xs text-secondary leading-snug shadow-lg shadow-black/50 pointer-events-none"
          style={{
            left: placement?.left ?? 0,
            top: placement?.top ?? 0,
            maxWidth: tipMaxWidth(window.innerWidth, rootFontPx()),
            // 位置が決まるまでは見せない。display:none にすると高さが測れなくなる。
            visibility: placement ? 'visible' : 'hidden',
          }}
        >
          {description}
        </div>
      )}
    </>
  )
}
