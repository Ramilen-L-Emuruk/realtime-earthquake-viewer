// ラベルに説明をホバーで添える部品。PWA の `DescriptionTip`（`src/components/DescriptionTip`）と
// 同じ働きをする：マウスが乗る・フォーカスが当たる・タップする、のどれでも開く。
//
// **管理コンソールは React を使わず、各タブが `innerHTML` で描き直す**（稼働状況は 5 秒ごと）。
// ラベルごとに聞き手を付けると、描き直すたびに付け直しが要り、付け忘れたラベルは黙って開かない。
// そのため聞き手は文書に 1 組だけ置き（`installTips`）、ラベルは HTML の印（`tipHtml`）だけを持つ。
//
// 配置の計算は PWA と同じ関数を使う（`tipPlacement.ts`）。書き写すと、画面端で反転する条件が
// 2 つの画面でずれる。

import { computePlacement, tipMaxWidth } from '../../../src/components/DescriptionTip/tipPlacement'
import { escapeHtml } from './dom'

const TIP_ID = 'admin-tip'

/**
 * 説明の付いたラベル（HTML）。**ラベルも説明もエスケープする。**
 * `type="button"` にするのは、フォームの中に置いても押して送信にならないため。
 */
export function tipHtml(label: string, description: string): string {
  return `<button type="button" class="tip" data-tip="${escapeHtml(description)}">${escapeHtml(label)}</button>`
}

function tipAnchorOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  return target.closest<HTMLElement>('button.tip[data-tip]')
}

function rootFontPx(doc: Document): number {
  const view = doc.defaultView
  if (view === null) return 16
  const root = parseFloat(view.getComputedStyle(doc.documentElement).fontSize)
  return Number.isFinite(root) && root > 0 ? root : 16
}

/**
 * 説明を出す聞き手を文書に置く。**戻り値で外す**（吹き出しの要素も消す）。
 *
 * 開いている理由を 3 つに分けて持つのは PWA と同じ（理由は `DescriptionTip` の冒頭）:
 * - **hovered**: マウスが乗っている間だけ（タッチの pointerover は拾わない）
 * - **focused**: キーボードのフォーカスが当たっている間だけ
 * - **pinned**: 押して固定した状態
 */
export function installTips(doc: Document): () => void {
  const view = doc.defaultView
  if (view === null) return () => {}

  const bubble = doc.createElement('div')
  bubble.id = TIP_ID
  bubble.className = 'tip-bubble'
  bubble.setAttribute('role', 'tooltip')
  bubble.hidden = true
  doc.body.appendChild(bubble)

  let anchor: HTMLElement | null = null
  let hovered = false
  let focused = false
  let pinned = false

  function detach(): void {
    anchor?.removeAttribute('aria-describedby')
    anchor = null
  }

  function close(): void {
    hovered = false
    focused = false
    pinned = false
    detach()
    bubble.hidden = true
  }

  function place(): void {
    if (anchor === null) return
    const viewport = { width: view!.innerWidth, height: view!.innerHeight }
    const maxWidth = tipMaxWidth(viewport.width, rootFontPx(doc))
    bubble.style.maxWidth = `${maxWidth}px`
    // 高さは描いてからでないと測れない。位置が決まるまでは見せない（display:none だと測れない）。
    bubble.style.visibility = 'hidden'
    bubble.hidden = false
    // **基準はラベルではなく行（`data-tip-row`）。** ラベルの直下は入力欄の居場所なので、
    // ラベルを基準にすると吹き出しが欄を覆う（PWA の `DescriptionTip` の `anchorRectFor` と同じ理由）。
    const row = anchor.closest<HTMLElement>('[data-tip-row]') ?? anchor
    const p = computePlacement(row.getBoundingClientRect(), bubble.offsetHeight, maxWidth, viewport)
    bubble.style.left = `${p.left}px`
    bubble.style.top = `${p.top}px`
    bubble.style.visibility = 'visible'
  }

  /** 開いている理由が 1 つでも残っていれば出し、無ければ閉じる。 */
  function sync(): void {
    if (anchor !== null && (hovered || focused || pinned)) {
      anchor.setAttribute('aria-describedby', TIP_ID)
      bubble.textContent = anchor.dataset.tip ?? ''
      place()
    } else {
      close()
    }
  }

  /** 別のラベルへ移るときは、前のラベルの理由を持ち越さない。 */
  function switchTo(next: HTMLElement): void {
    if (anchor === next) return
    detach()
    hovered = false
    focused = false
    pinned = false
    anchor = next
  }

  const onPointerOver = (e: Event): void => {
    // iOS Safari はタップでも hover を合成する。拾うと、押して外した後も hovered が残って閉じない。
    if ((e as PointerEvent).pointerType !== 'mouse') return
    const el = tipAnchorOf(e.target)
    if (el === null) return
    if (anchor !== el && (pinned || focused)) return // 固定・フォーカス中の説明を、通り過ぎたマウスで奪わない
    switchTo(el)
    hovered = true
    sync()
  }
  const onPointerOut = (e: Event): void => {
    const el = tipAnchorOf(e.target)
    if (el === null || el !== anchor) return
    if (el.contains((e as PointerEvent).relatedTarget as Node | null)) return
    hovered = false
    sync()
  }
  const onFocusIn = (e: Event): void => {
    const el = tipAnchorOf(e.target)
    if (el === null) return
    switchTo(el)
    focused = true
    sync()
  }
  const onFocusOut = (e: Event): void => {
    const el = tipAnchorOf(e.target)
    if (el === null || el !== anchor) return
    focused = false
    sync()
  }
  const onClick = (e: Event): void => {
    const el = tipAnchorOf(e.target)
    if (el === null) return
    if (anchor !== el) switchTo(el)
    pinned = !pinned
    // ホバーで開いている最中の 1 回目の押下は「固定する」にあたる。閉じる向きに倒すと押した瞬間に消える。
    if (!pinned) {
      hovered = false
      focused = false
    }
    sync()
  }
  const onPointerDown = (e: Event): void => {
    if (anchor === null) return
    if (anchor.contains(e.target as Node | null)) return
    close()
  }
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && anchor !== null) close()
  }
  // `position: fixed` はスクロールに追従しないので、動いたら閉じる。スクロールするのは
  // 表の枠などの内側のこともあり、scroll は上へ伝わらないため capture で拾う。
  const onScrollOrResize = (): void => {
    if (anchor !== null) close()
  }

  // 描き直しでラベルが入れ替わったら、同じ説明・同じ文字のラベルへ付け替える。無くなったら閉じる。
  // 付け替えないと、稼働状況（5 秒ごとに描き直す）で開いた説明が 5 秒で消える。
  const observer = new view.MutationObserver(() => {
    if (anchor === null || anchor.isConnected) return
    const tip = anchor.dataset.tip
    const text = anchor.textContent
    const next = Array.from(doc.querySelectorAll<HTMLElement>('button.tip[data-tip]')).find(
      (el) => el.dataset.tip === tip && el.textContent === text,
    )
    if (next === undefined) {
      close()
      return
    }
    anchor = next
    // フォーカスは消えた要素と一緒に失われている
    focused = doc.activeElement === next
    sync()
  })
  observer.observe(doc.body, { childList: true, subtree: true })

  doc.addEventListener('pointerover', onPointerOver)
  doc.addEventListener('pointerout', onPointerOut)
  doc.addEventListener('focusin', onFocusIn)
  doc.addEventListener('focusout', onFocusOut)
  doc.addEventListener('click', onClick)
  view.addEventListener('pointerdown', onPointerDown, true)
  view.addEventListener('keydown', onKeyDown)
  view.addEventListener('scroll', onScrollOrResize, true)
  view.addEventListener('resize', onScrollOrResize)

  return () => {
    observer.disconnect()
    doc.removeEventListener('pointerover', onPointerOver)
    doc.removeEventListener('pointerout', onPointerOut)
    doc.removeEventListener('focusin', onFocusIn)
    doc.removeEventListener('focusout', onFocusOut)
    doc.removeEventListener('click', onClick)
    view.removeEventListener('pointerdown', onPointerDown, true)
    view.removeEventListener('keydown', onKeyDown)
    view.removeEventListener('scroll', onScrollOrResize, true)
    view.removeEventListener('resize', onScrollOrResize)
    detach()
    bubble.remove()
  }
}
