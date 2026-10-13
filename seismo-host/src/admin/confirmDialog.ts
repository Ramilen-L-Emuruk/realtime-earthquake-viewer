// 確認の窓。`window.confirm` の代わりに使う（2026-10-12 ユーザー承認）。
//
// **`window.confirm` をやめたのは、ボタンが「OK／キャンセル」に固定されるため。** 押した結果
// （「削除する」）をボタンに書けない。見出しは丁寧形の問い、本文で何が起きるかを述べ、
// ボタンに押した結果を書く——Chrome の確認の窓と同じ形（`docs/ui-wording-procedure.md` §3）。
//
// **待ちが非同期になる。** `window.confirm` は答えが出るまでスクリプトを止めるが、こちらは
// `Promise` で返す。呼び出し側は答えを待つ間に画面が動きうる（再読込・タブ移動）ことを前提にする。

import { escapeHtml } from './dom'

export interface ConfirmOptions {
  /** 見出し。丁寧形の問い（「〜しますか？」）。 */
  readonly title: string
  /** 何が起きるか（丁寧形）。要らなければ `null`（省略させない——書き忘れと区別するため）。 */
  readonly body: string | null
  /** 押した結果を書いたボタン（「削除する」）。 */
  readonly confirmLabel: string
}

/** 開いている窓を閉じる手。次の窓を開く前に、前の問いを「キャンセル」で閉じるのに使う。 */
let closeCurrent: ((answer: boolean) => void) | null = null

let idSeq = 0

/**
 * 開いている窓があれば「キャンセル」で閉じる。**タブを替えるときに呼ぶ**（`app.ts` の `mountTab`）。
 * 閉じずに残すと、窓の後ろが別のタブになったまま「削除する」を押せてしまい、押しても
 * 何も起きない（答えを待つ側は打ち切られたタブの `signal` を見て黙って止まる）。
 */
export function dismissConfirmDialog(): void {
  closeCurrent?.(false)
}

/** 確認の窓を出し、押した結果のボタンなら `true`、それ以外（キャンセル・Escape・外側）なら `false`。 */
export function confirmDialog(doc: Document, options: ConfirmOptions): Promise<boolean> {
  // 窓は 1 つだけ。前の問いに答えずに次が来たら（ブラウザの「戻る」等）、前は断ったことにする。
  closeCurrent?.(false)

  const seq = ++idSeq
  const titleId = `confirm-title-${seq}`
  const bodyId = `confirm-body-${seq}`
  const previousFocus = doc.activeElement instanceof HTMLElement ? doc.activeElement : null

  const backdrop = doc.createElement('div')
  backdrop.className = 'confirm-backdrop'
  backdrop.innerHTML = `
    <div class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="${titleId}"${
      options.body === null ? '' : ` aria-describedby="${bodyId}"`
    }>
      <p class="confirm-title" id="${titleId}">${escapeHtml(options.title)}</p>
      ${options.body === null ? '' : `<p class="confirm-body" id="${bodyId}">${escapeHtml(options.body)}</p>`}
      <div class="confirm-actions">
        <button type="button" class="confirm-cancel">キャンセル</button>
        <button type="button" class="confirm-ok danger">${escapeHtml(options.confirmLabel)}</button>
      </div>
    </div>
  `
  doc.body.appendChild(backdrop)
  const cancel = backdrop.querySelector<HTMLButtonElement>('.confirm-cancel')!
  const ok = backdrop.querySelector<HTMLButtonElement>('.confirm-ok')!

  return new Promise<boolean>((resolve) => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        // 説明の吹き出し（`tip.ts`）の Escape まで届かせない——窓だけを閉じる
        e.stopPropagation()
        finish(false)
        return
      }
      // **Tab は 2 つのボタンの間で回す。** 後ろの画面へ出ると、窓を開いたまま裏の操作ができてしまう。
      if (e.key === 'Tab') {
        e.preventDefault()
        ;(doc.activeElement === ok ? cancel : ok).focus()
      }
    }

    function finish(answer: boolean): void {
      if (closeCurrent !== finish) return
      closeCurrent = null
      doc.removeEventListener('keydown', onKeyDown, true)
      backdrop.remove()
      if (previousFocus?.isConnected === true) previousFocus.focus()
      resolve(answer)
    }

    closeCurrent = finish
    doc.addEventListener('keydown', onKeyDown, true)
    backdrop.addEventListener('click', (e) => {
      // 窓の中のクリックは外側に数えない
      if (e.target === backdrop) finish(false)
    })
    cancel.addEventListener('click', () => finish(false))
    ok.addEventListener('click', () => finish(true))
    // **最初はキャンセルに当てる。** 押した結果の側に当てると、Enter を押したまま開いた窓が
    // そのまま消す側で閉じる。
    cancel.focus()
  })
}
