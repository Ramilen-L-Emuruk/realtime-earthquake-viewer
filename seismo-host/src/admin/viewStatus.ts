// 稼働状況タブ（`GET /status` の可視化）。**宛先は運用者**——`/status` 自体の
// 位置づけは `seismo-host/README.md`「状態と押し出しの口」を見ること。
//
// **`/status` は認証を持たない読み取り専用の口。** この画面は `/api/*` と違い
// トークンなしでも表示できる（fetch 自体はトークンを付けない）。
//
// **`boardKey`・`sensorId` は無認証の UDP パケット由来で、文字種検証を持たない
// （`stationConfig.ts` の `nonEmptyString` は空文字でないことしか見ない）。**
// `stationConfigWarning`・`ungroupedMultiBoardStations` も運用者が入力した
// 生の値をそのまま含みうる。**このファイルで組み立てる HTML へ差し込む値は
// 例外なく `escapeHtml` を通すこと** —— 通し忘れると、トークンを持たない
// 攻撃者が UDP パケット 1 個で管理コンソールのトークンを盗めるストアド XSS になる
// （#313 段 C 敵対的レビューで検出）。

import { escapeHtml, qs } from './dom'

/**
 * `GET /status` の形。**`statusReport.ts` の `StatusReport` を丸ごと再定義しない。**
 * ここで使う欄だけを持つ最小限の形にする——`StatusReport` は Node 専用の型
 * （`SegmentState` 等）を経由して定義されており、admin 側のプロジェクト
 * （DOM 型・ブラウザ向け）へ Node 型を持ち込むと衝突する。
 *
 * **欄が増減したら手で追随させる必要がある。** 自動では検知できない
 * （型検査は「この型が JSON と一致するか」までは見ない）。
 */
interface StatusReportView {
  readonly generatedAtMs: number
  readonly uptimeSec: number
  readonly sensors: readonly {
    readonly boardKey: string
    readonly sensorId: string
    readonly lastPacketMs: number | null
    readonly lastIntensity: number | null
    readonly enabled: boolean
    readonly calibrationConfigured: boolean
    readonly station: { readonly displayName: string } | null
  }[]
  readonly stationIntensities: readonly {
    readonly stationId: string
    readonly lastPacketMs: number | null
    readonly lastIntensity: number | null
  }[]
  readonly raw: {
    readonly writeErrors: number
    readonly lostRecords: number
    readonly cutShort: boolean
    readonly currentDay: string | null
    readonly lastWriteError: string | null
  }
  readonly stationConfigWarning: string | null
  readonly ungroupedMultiBoardStations: readonly string[]
}

const STALE_AFTER_MS = 60_000

function ago(nowMs: number, atMs: number | null): string {
  if (atMs === null) return '（未受信）'
  const sec = Math.max(0, Math.round((nowMs - atMs) / 1000))
  return `${sec} 秒前`
}

function isStale(nowMs: number, atMs: number | null): boolean {
  return atMs === null || nowMs - atMs > STALE_AFTER_MS
}

function badge(nowMs: number, atMs: number | null): string {
  const cls = isStale(nowMs, atMs) ? 'stale' : 'ok'
  const label = isStale(nowMs, atMs) ? '途絶' : '受信中'
  return `<span class="badge ${cls}">${label}</span>`
}

export async function initStatusView(container: HTMLElement, signal: AbortSignal): Promise<void> {
  container.innerHTML = `
    <div class="status-error"></div>
    <div class="status-body muted">読み込み中…</div>
  `

  const errorEl = qs(container, '.status-error')
  const bodyEl = qs(container, '.status-body')

  const render = (status: StatusReportView): void => {
    const now = status.generatedAtMs

    const sensorRows = status.sensors
      .map(
        (s) => `
          <tr>
            <td>${escapeHtml(s.station?.displayName ?? '（未割当）')}</td>
            <td>${escapeHtml(s.boardKey)} / ${escapeHtml(s.sensorId)}</td>
            <td>${badge(now, s.lastPacketMs)} ${ago(now, s.lastPacketMs)}</td>
            <td>${s.lastIntensity !== null ? s.lastIntensity.toFixed(2) : '—'}</td>
            <td>${s.enabled ? '有効' : '無効'}</td>
            <td>${s.calibrationConfigured ? '設定あり' : '既定値'}</td>
          </tr>`,
      )
      .join('')

    const stationRows = status.stationIntensities
      .map(
        (s) => `
          <tr>
            <td>${escapeHtml(s.stationId)}</td>
            <td>${badge(now, s.lastPacketMs)} ${ago(now, s.lastPacketMs)}</td>
            <td>${s.lastIntensity !== null ? s.lastIntensity.toFixed(2) : '—'}</td>
          </tr>`,
      )
      .join('')

    // **警告文は `describeFailure`（サーバー側）が組み立てる際、運用者が入力した
    // 生の値（`JSON.stringify(f.value)`）を埋め込むことがある。** `stationId`
    // （`ungroupedMultiBoardStations`）も同様に運用者由来。どちらもエスケープが
    // 要る——`boardKey`/`sensorId` と同じ理由（下記コメント参照）。
    const warnings: string[] = []
    if (status.stationConfigWarning !== null) {
      warnings.push(`観測点設定: ${escapeHtml(status.stationConfigWarning)}`)
    }
    if (status.ungroupedMultiBoardStations.length > 0) {
      warnings.push(
        `複数基板を割り当てたが合成グループが組めていない観測点: ${escapeHtml(status.ungroupedMultiBoardStations.join('、'))}`,
      )
    }
    if (status.raw.cutShort) warnings.push('生データの保存が途中で打ち切られた')
    if (status.raw.lastWriteError !== null) {
      warnings.push(`生データの書き込みエラー: ${escapeHtml(status.raw.lastWriteError)}`)
    }

    bodyEl.innerHTML = `
      <p>稼働時間: ${Math.floor(status.uptimeSec / 3600)} 時間 ${Math.floor((status.uptimeSec % 3600) / 60)} 分</p>
      ${
        warnings.length > 0
          ? `<p class="error">${warnings.map((w) => `⚠ ${w}`).join('<br>')}</p>`
          : '<p class="muted">警告なし</p>'
      }
      <h3>センサー</h3>
      <table>
        <thead><tr><th>観測点</th><th>基板 / センサー</th><th>受信</th><th>計測震度相当</th><th>有効</th><th>校正</th></tr></thead>
        <tbody>${sensorRows.length > 0 ? sensorRows : '<tr><td colspan="6" class="muted">センサーなし</td></tr>'}</tbody>
      </table>
      <h3>観測点（複数センサー合成）</h3>
      <table>
        <thead><tr><th>観測点</th><th>受信</th><th>計測震度相当</th></tr></thead>
        <tbody>${stationRows.length > 0 ? stationRows : '<tr><td colspan="3" class="muted">2 台以上を割り当てた観測点なし</td></tr>'}</tbody>
      </table>
      <h3>生データ保存</h3>
      <p>書き込みエラー: ${status.raw.writeErrors} / 失った記録: ${status.raw.lostRecords} /
      現在の日: ${escapeHtml(status.raw.currentDay ?? '（不明）')}</p>
    `
  }

  // **`signal.aborted` を確認してから DOM を書く。** タブ切替直後（初回 fetch の
  // 完了前に別タブへ移った場合）に、差し替わった DOM への書き込みや、二度と
  // 止まらないポーリングを始めてしまう事故を防ぐ（`app.ts` の `mountTab` 参照。
  // 旧 `teardown` イベント方式は、初回 fetch 完了前の切替でリスナー登録前に
  // イベントが飛んでしまい、タイマーを止められなかった）。
  const reload = async (): Promise<void> => {
    try {
      const res = await fetch('/status')
      if (signal.aborted) return
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const status = (await res.json()) as StatusReportView
      if (signal.aborted) return
      render(status)
      errorEl.textContent = ''
    } catch (error) {
      if (signal.aborted) return
      errorEl.textContent = error instanceof Error ? error.message : String(error)
      // **取得できていない間、古い「受信中」バッジを凍結させない。** バッジは
      // 直前に成功した応答の時刻を基準に「途絶」を判定するため、`/status`
      // 自体への到達性が失われている間は実際の経過時間を反映せず、失敗が
      // 始まった瞬間の見た目のまま残り続ける——運用者がエラー文言（小さく
      // 添えているだけ）を見落とすと「センサーは生きている」と誤認しうる
      // （#313 段 C 敵対的レビューで検出）。表示ごと「不明」へ倒す。
      bodyEl.innerHTML = '<p class="muted">最新の状態を取得できていない（上のエラーを参照）。</p>'
    }
  }

  await reload()
  if (signal.aborted) return
  // **見に来ている間だけ更新すればよい。** 他タブが選ばれている間は
  // `initStatusView` を再度呼び直すまで動かさない（`abort` で止める）。
  const timer = window.setInterval(() => void reload(), 5000)
  signal.addEventListener('abort', () => window.clearInterval(timer), { once: true })
}
