// 「保存先」タブ。保存先の表示と変更・容量・前の保存先からの複製と削除（`GET`/`PUT /api/storage`・
// `POST /api/storage/purge-old`）。文言は `storageText.ts`（2026-10-13 ユーザー承認）。
//
// **変更は次の起動から効く**（`receiver/hostSettings.ts`）。ここで保存しても、ホストはいまの場所へ書き続ける。
// 再起動は人が行う（`Restart-Service seismo-host`）—— 画面から再起動させる口は持たない。

import { apiFetch, ApiError, describeAdminAuthFailure } from './api'
import { confirmDialog } from './confirmDialog'
import { escapeHtml, qs } from './dom'
import {
  abandonConfirmBody,
  KIND_LABELS,
  KIND_ORDER,
  daysLeftText,
  formatBytes,
  formatCount,
  growthText,
  purgeConfirmBody,
  purgeProblemText,
  setPendingProblemText,
  spaceShortText,
  storageWarnings,
  type DriveView,
  type MigrationView,
  type StorageReportView,
} from './storageText'
import type { TabContext } from './tabState'
import { tipHtml } from './tip'

/** 進み具合を取り直す間隔。容量は 10 分ごとにしか数え直さないが、複製の進み具合はもっと速く動く。 */
const RELOAD_MS = 10_000

const NEW_ROOT_TIP =
  'フォルダを 1 つ選ぶと、その中に raw・wave・summary・events を作ります。変更は次にホストを再起動したときに有効になります。'
const ENV_LOCK_TIP =
  'SEISMO_RAW_DIR・SEISMO_WAVE_DIR・SEISMO_SUMMARY_DIR・SEISMO_EVENT_DIR のどれかがあると、ここからは変えられません。'
const KEPT_TIP = '新しい保存先に同じ名前のファイルがあったもの、読めなかったものは複製せず、前の保存先からも消しません。'

function describeFailure(error: unknown): string {
  if (error instanceof ApiError) {
    const auth = describeAdminAuthFailure(error.message)
    if (auth !== null) return auth
    const body = error.body as { error?: string; detail?: string | null } | null
    if (body?.error !== undefined && (error.status === 400 || error.status === 409)) {
      return setPendingProblemText(body.error, body.detail ?? null)
    }
  }
  return error instanceof Error ? error.message : String(error)
}

/** 前の保存先の削除を断られた・失敗した理由（`POST /api/storage/purge-old` の 409・500）。 */
function describePurgeFailure(error: unknown): string {
  if (error instanceof ApiError) {
    const auth = describeAdminAuthFailure(error.message)
    if (auth !== null) return auth
    const body = error.body as { error?: string; detail?: string | null } | null
    if (body?.error !== undefined && (error.status === 409 || error.status === 500)) {
      return purgeProblemText(body.error, body.detail ?? null)
    }
  }
  return error instanceof Error ? error.message : String(error)
}

/** ドライブの欄。保存先の 4 つが全部載っていれば保存先のパス、分かれていれば載っている種類を並べる。 */
function driveLabel(report: StorageReportView, d: DriveView): string {
  if (d.kinds.length === KIND_ORDER.length && report.root !== null) return escapeHtml(report.root)
  return d.kinds.map((k) => KIND_LABELS[k]).join('・')
}

export function drivesTableHtml(report: StorageReportView): string {
  const rows = report.usage.drives
    .map(
      (d) => `<tr>
        <td class="path">${driveLabel(report, d)}</td>
        <td class="nowrap">${formatBytes(d.freeBytes)}</td>
        <td class="nowrap">${formatBytes(d.totalBytes)}</td>
        <td class="nowrap">${growthText(d.growthBytesPerDay)}</td>
        <td class="nowrap">${daysLeftText(d.daysLeft)}</td>
      </tr>`,
    )
    .join('')
  return `<table>
    <thead><tr><th>ドライブ</th><th class="nowrap">空き容量</th><th class="nowrap">全体</th><th class="nowrap">増え方</th><th class="nowrap">あと</th></tr></thead>
    <tbody>${rows.length > 0 ? rows : '<tr><td colspan="5" class="muted">集計中…</td></tr>'}</tbody>
  </table>`
}

export function kindsTableHtml(report: StorageReportView): string {
  const kinds = report.usage.kinds
  if (kinds === null) return '<p class="muted">集計中…</p>'
  const rows = KIND_ORDER.map((k) => {
    const u = kinds.find((x) => x.kind === k)
    if (u === undefined) return ''
    return `<tr title="${escapeHtml(u.path)}"><td>${KIND_LABELS[k]}</td><td>${formatBytes(u.bytes)}</td><td>${formatCount(u.files)}</td></tr>`
  }).join('')
  return `<table>
    <thead><tr><th>種類</th><th>使用量</th><th>ファイル数</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`
}

export function migrationHtml(m: MigrationView): string {
  const lines: string[] = [`<div class="row"><span class="nowrap">前の保存先</span><span class="path">${escapeHtml(m.from)}</span></div>`]
  if (m.state === 'copying') {
    const total =
      m.totalFiles === null || m.totalBytes === null
        ? '集計中…'
        : `${formatCount(m.doneFiles)} / ${formatCount(m.totalFiles)} 件・${formatBytes(m.doneBytes)} / ${formatBytes(m.totalBytes)}`
    lines.push(`<div class="row"><span class="nowrap">複製中</span><span>${total}</span></div>`)
    if (m.blockedBySpace !== null) {
      lines.push(`<p class="error">${spaceShortText(m.blockedBySpace.neededBytes, m.blockedBySpace.freeBytes)}</p>`)
    }
    // 前の保存先が見つからない間だけ、複製をやめられる（2026-10-13 ユーザー承認）。理由は警告の欄に出る。
    if (m.sourceMissing === true) {
      lines.push('<div class="row"><button type="button" class="abandon-migration danger" style="flex: 0 0 auto">複製をやめる</button></div>')
    }
  } else if (m.state === 'purging' && m.purgeable === null) {
    // いま消している最中（途中で止まった削除は `purgeable` を持ち、承認し直せる）。進み具合は
    // 「済んだ件数 / この回に試す件数」（2026-10-13 ユーザー承認）。
    const p = m.purgeProgress ?? null
    lines.push(
      p === null
        ? '<div class="row"><span class="nowrap">削除中</span></div>'
        : `<div class="row"><span class="nowrap">削除中</span><span>${formatCount(p.doneFiles)} / ${formatCount(p.totalFiles)} 件</span></div>`,
    )
  } else {
    lines.push(
      `<div class="row"><span class="nowrap">複製済み</span><span>${formatCount(m.doneFiles)} 件・${formatBytes(m.doneBytes)}</span></div>`,
    )
  }
  const kept = m.skippedExists + m.skippedUnreadable + (m.purged?.kept ?? 0)
  if (kept > 0) {
    lines.push(`<div class="row" data-tip-row><span>${tipHtml('前の保存先に残すもの', KEPT_TIP)}</span><span>${formatCount(kept)} 件</span></div>`)
  }
  if ((m.state === 'copied' || m.state === 'purging') && m.purgeable !== null && m.purgeable.files > 0) {
    lines.push('<div class="row"><button type="button" class="purge-old danger" style="flex: 0 0 auto">前の保存先から削除する</button></div>')
  }
  if (m.state === 'done' && m.purged !== null) {
    lines.push(`<p>前の保存先から ${formatCount(m.purged.files)} 件を削除した</p>`)
  }
  return lines.join('')
}

/** 保存先タブは選択も表示の好みも持たない。使うのは打ち切りの合図だけ。 */
export async function initStorageView(container: HTMLElement, ctx: TabContext): Promise<void> {
  const { signal } = ctx
  container.innerHTML = `
    <div class="storage-error error"></div>
    <div class="storage-warnings"></div>
    <section class="panel">
      <h2>保存先</h2>
      <div class="storage-root"></div>
      <form class="storage-form">
        <div class="label-like" data-tip-row>
          <span id="storage-new-label">${tipHtml('新しい保存先', NEW_ROOT_TIP)}</span>
          <input type="text" class="storage-new" placeholder="例: E:\\seismo" aria-labelledby="storage-new-label" />
        </div>
        <div class="row">
          <button type="submit" style="flex: 0 0 auto">保存</button>
          <span class="storage-form-status muted" style="align-self: center"></span>
        </div>
      </form>
    </section>
    <section class="panel">
      <h2>容量</h2>
      <div class="storage-drives"></div>
      <div class="storage-kinds"></div>
    </section>
    <section class="panel storage-migration-panel" hidden>
      <h2>前の保存先からの複製</h2>
      <div class="storage-migration"></div>
      <p class="storage-purge-error error"></p>
    </section>
  `
  const errorEl = qs(container, '.storage-error')
  const warningsEl = qs(container, '.storage-warnings')
  const rootEl = qs(container, '.storage-root')
  const form = qs<HTMLFormElement>(container, '.storage-form')
  const input = qs<HTMLInputElement>(container, '.storage-new')
  const formStatus = qs(container, '.storage-form-status')
  const drivesEl = qs(container, '.storage-drives')
  const kindsEl = qs(container, '.storage-kinds')
  const migrationPanel = qs(container, '.storage-migration-panel')
  const migrationEl = qs(container, '.storage-migration')
  // 削除を断られた・失敗した理由。**取り直しでは消さない**（10 秒ごとの取り直しで消えると読む前に消える）。
  // 次に削除を押したときに消す。
  const purgeErrorEl = qs(container, '.storage-purge-error')
  let last: StorageReportView | null = null

  const render = (r: StorageReportView): void => {
    last = r
    const warnings = storageWarnings({
      drives: r.usage.drives,
      lastError: r.usage.lastError,
      migration:
        r.migration === null
          ? null
          : { state: r.migration.state, blockedBySpace: r.migration.blockedBySpace !== null, lastError: r.migration.lastError },
      startupProblem: r.startupProblem,
      journalProblem: r.journalProblem,
    })
    warningsEl.innerHTML = warnings.length > 0 ? `<p class="error">${warnings.map((w) => `⚠ ${w}`).join('<br>')}</p>` : ''

    const rows: string[] = []
    if (r.source === 'env') {
      rows.push(`<div class="row" data-tip-row><span>${tipHtml('保存先は環境変数で決めている', ENV_LOCK_TIP)}</span></div>`)
    } else if (r.root !== null) {
      rows.push(`<div class="row"><span class="nowrap">いまの保存先</span><span class="path">${escapeHtml(r.root)}</span></div>`)
    }
    if (r.pendingRoot !== null && r.source !== 'env') {
      rows.push(
        `<div class="row"><span class="nowrap">次の再起動から</span><span class="path">${escapeHtml(r.pendingRoot)}</span>` +
          '<button type="button" class="storage-cancel" style="flex: 0 0 auto">取り消す</button></div>',
      )
    }
    rootEl.innerHTML = rows.join('')
    form.hidden = r.source === 'env'

    drivesEl.innerHTML = drivesTableHtml(r)
    kindsEl.innerHTML = kindsTableHtml(r)
    migrationPanel.hidden = r.migration === null
    migrationEl.innerHTML = r.migration === null ? '' : migrationHtml(r.migration)
  }

  const reload = async (): Promise<void> => {
    try {
      const r = await apiFetch<StorageReportView>('/api/storage', { signal })
      if (signal.aborted) return
      render(r)
      errorEl.textContent = ''
    } catch (error) {
      if (signal.aborted) return
      errorEl.textContent = describeFailure(error)
    }
  }

  const setPending = async (root: string | null): Promise<void> => {
    formStatus.textContent = ''
    try {
      const r = await apiFetch<StorageReportView>('/api/storage', {
        method: 'PUT',
        body: JSON.stringify({ pendingDataRoot: root }),
        signal,
      })
      if (signal.aborted) return
      render(r)
      if (root !== null) {
        formStatus.textContent = `次の再起動から ${root} を使う`
        input.value = ''
      }
    } catch (error) {
      if (signal.aborted) return
      formStatus.textContent = describeFailure(error)
    }
  }

  form.addEventListener(
    'submit',
    (e) => {
      e.preventDefault()
      const value = input.value.trim()
      if (value.length === 0) return
      void setPending(value)
    },
    { signal },
  )

  container.addEventListener(
    'click',
    (e) => {
      const target = e.target
      if (!(target instanceof HTMLElement)) return
      if (target.classList.contains('storage-cancel')) {
        void setPending(null)
        return
      }
      if (target.classList.contains('abandon-migration')) {
        const m = last?.migration
        if (m === null || m === undefined || m.sourceMissing !== true) return
        void (async () => {
          const ok = await confirmDialog(document, {
            title: '前の保存先からの複製をやめますか？',
            body: abandonConfirmBody(m.from),
            confirmLabel: 'やめる',
          })
          if (!ok || signal.aborted) return
          ;(target as HTMLButtonElement).disabled = true
          purgeErrorEl.textContent = ''
          try {
            await apiFetch('/api/storage/abandon-migration', { method: 'POST', signal })
          } catch (error) {
            // 断られた（前の保存先が見えるようになった）ときは、取り直した画面にボタンが出ないことで分かる。
            if (!signal.aborted && !(error instanceof ApiError && error.status === 409)) {
              purgeErrorEl.textContent = describeFailure(error)
            }
          }
          if (!signal.aborted) await reload()
        })()
        return
      }
      if (target.classList.contains('purge-old')) {
        const m = last?.migration
        if (m === null || m === undefined || m.purgeable === null) return
        void (async () => {
          const ok = await confirmDialog(document, {
            title: '前の保存先のファイルを削除しますか？',
            body: purgeConfirmBody(m.from, m.purgeable!.files, m.purgeable!.bytes),
            confirmLabel: '削除する',
          })
          if (!ok || signal.aborted) return
          ;(target as HTMLButtonElement).disabled = true
          purgeErrorEl.textContent = ''
          try {
            await apiFetch('/api/storage/purge-old', { method: 'POST', signal })
          } catch (error) {
            if (!signal.aborted) purgeErrorEl.textContent = describePurgeFailure(error)
          }
          if (!signal.aborted) await reload()
        })()
      }
    },
    { signal },
  )

  await reload()
  if (signal.aborted) return
  const timer = window.setInterval(() => void reload(), RELOAD_MS)
  signal.addEventListener('abort', () => window.clearInterval(timer), { once: true })
}
