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

import { ago, escapeHtml, isStale, qs, receptionBadgeHtml } from './dom'
import { readFinite } from './readJson'

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
    /** 最後に合成したまとまりで実際に混ざった本数（#315）。 */
    readonly lastMemberCountMin: number | null
    readonly lastMemberCountMax: number | null
    /** センサー対ごとの差分の強さ（#315）。 */
    readonly pairDiffs: readonly {
      readonly a: { readonly boardKey: string; readonly sensorId: string }
      readonly b: { readonly boardKey: string; readonly sensorId: string }
      readonly rmsGal: readonly (number | null)[]
      readonly sampleCount: readonly number[]
    }[]
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

type PairDiffView = StatusReportView['stationIntensities'][number]['pairDiffs'][number]

/**
 * いちばん離れているセンサー対（#315）。1 組も無ければ null。
 *
 * **36 組を並べない。** 9 台なら全ペアで 36 行になり、観測点の表が読めなくなる。
 * 運用者が知りたいのは「おかしい対があるか」で、**あれば必ず最大に現れる**
 * ——細かく見たいときは `/status` の生の値を読む。
 *
 * **軸ごとの最大を採る。** 感度のずれは軸ごとに現れる（#367）ので、
 * 3 軸を平均すると 1 軸だけおかしい対が薄まる。
 */
export function worstPairDiff(
  pairs: readonly PairDiffView[],
): { readonly pair: PairDiffView; readonly rmsGal: number } | null {
  let best: { pair: PairDiffView; rmsGal: number } | null = null
  for (const pair of pairs) {
    for (const rms of pair.rmsGal) {
      // **測れなかった軸（null）は候補にしない。** 0 で埋めると
      // 「差が無かった」対として最大の争いに混ざる。
      if (rms === null) continue
      if (best === null || rms > best.rmsGal) best = { pair, rmsGal: rms }
    }
  }
  return best
}

/**
 * 混ざった本数の欄。**揃っていなければ幅で出す。**
 *
 * **幅が出ていても警めの色にしない。** 実機では正常運転でも幅が出る
 * （まとまりの末尾で 1〜3 本欠ける。REQUIREMENTS.md §7）ので、色を付けると
 * **常に警告が出ている状態**になり、#362 の本物の乱れと区別が付かない。
 * **どこからが異常かの物差しは未設計**（#374）。
 *
 * **`readFinite` を通す。** `/status` は無検証のキャストで読んでいるので、
 * 欄が無ければ `undefined` が来る（版がずれたとき）——`undefined === null` は偽だが
 * `undefined === undefined` は真なので、`null` だけを見る形だと
 * **「undefined 本」というそれらしい文字列が画面へ出る**。同じ行の隣の欄
 * （`lastIntensity.toFixed`）は同じ状況で例外を投げ「状態を取得できていない」へ
 * 倒れるので、ここだけ弱いままにしない（2026-09-28 のレビューが指摘）。
 */
export function memberCell(min: unknown, max: unknown): string {
  const lo = readFinite(min)
  const hi = readFinite(max)
  if (lo === null || hi === null) return '—'
  if (lo === hi) return `${lo} 本`
  return `${lo}〜${hi} 本`
}

/** 差分の欄。**いちばん離れている対だけ**を出す。 */
function pairDiffCell(pairs: readonly PairDiffView[]): string {
  const worst = worstPairDiff(pairs)
  if (worst === null) return '—'
  const a = `${escapeHtml(worst.pair.a.boardKey)}/${escapeHtml(worst.pair.a.sensorId)}`
  const b = `${escapeHtml(worst.pair.b.boardKey)}/${escapeHtml(worst.pair.b.sensorId)}`
  return `${worst.rmsGal.toFixed(2)} gal <span class="muted">${a} ↔ ${b}</span>`
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
            <td>${escapeHtml(s.station?.displayName ?? '未割当')}</td>
            <td>${escapeHtml(s.boardKey)} / ${escapeHtml(s.sensorId)}</td>
            <td>${receptionBadgeHtml(now, s.lastPacketMs)} ${ago(now, s.lastPacketMs)}</td>
            <td>${s.lastIntensity !== null ? s.lastIntensity.toFixed(2) : '—'}</td>
            <td>${s.enabled ? '有効' : '無効'}</td>
            <td>${s.calibrationConfigured ? '設定あり' : '既定値のまま'}</td>
          </tr>`,
      )
      .join('')

    const stationRows = status.stationIntensities
      .map(
        (s) => `
          <tr>
            <td>${escapeHtml(s.stationId)}</td>
            <td>${receptionBadgeHtml(now, s.lastPacketMs)} ${ago(now, s.lastPacketMs)}</td>
            <td>${s.lastIntensity !== null ? s.lastIntensity.toFixed(2) : '—'}</td>
            <td>${memberCell(s.lastMemberCountMin, s.lastMemberCountMax)}</td>
            <td>${pairDiffCell(s.pairDiffs)}</td>
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
        `複数基板だが合成グループが組めていない観測点: ${escapeHtml(status.ungroupedMultiBoardStations.join('、'))}`,
      )
    }
    if (status.raw.cutShort) warnings.push('生データの保存が途中で打ち切られた')
    if (status.raw.lastWriteError !== null) {
      warnings.push(`生データの書き込みエラー: ${escapeHtml(status.raw.lastWriteError)}`)
    }

    const liveSensorCount = status.sensors.filter((s) => !isStale(now, s.lastPacketMs)).length
    const hours = Math.floor(status.uptimeSec / 3600)
    const minutes = Math.floor((status.uptimeSec % 3600) / 60)

    bodyEl.innerHTML = `
      <div class="stat-cards">
        <div class="stat-card">
          <div class="stat-label">稼働時間</div>
          <div class="stat-value">${hours} 時間 ${minutes} 分</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">受信中のセンサー</div>
          <div class="stat-value">${liveSensorCount} / ${status.sensors.length}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">複数センサー合成の観測点</div>
          <div class="stat-value">${status.stationIntensities.length}</div>
        </div>
      </div>
      ${
        warnings.length > 0
          ? `<p class="error">${warnings.map((w) => `⚠ ${w}`).join('<br>')}</p>`
          : '<p class="muted">警告なし</p>'
      }
      <section class="panel">
        <h2>センサー</h2>
        <table>
          <thead><tr><th>観測点</th><th>基板 / センサー</th><th>受信</th><th>計測震度相当</th><th>有効</th><th>校正</th></tr></thead>
          <tbody>${sensorRows.length > 0 ? sensorRows : '<tr><td colspan="6" class="muted">未受信</td></tr>'}</tbody>
        </table>
      </section>
      <section class="panel">
        <!-- **「複数センサー合成」を見出しから外さない。** \`stationIntensities\` は
             2 台以上を割り当てた観測点にしか現れない（\`statusReport.ts\`）。見出しを
             「観測点ごとの震度」と一般化すると、センサー 1 台の構成では正常に動いて
             いても永久に空のままで、運用者が登録の失敗を疑う。 -->
        <h2>複数センサー合成の震度</h2>
        <table>
          <!-- **「混ざった本数」と「差分の最大」を並べて出す。** 前者が揃っていない
               ことと、特定の対だけ差分が大きいことは、どちらも据え付けを疑う手掛かり
               （#362・#315）。震度だけでは、値が高いときに「本当に揺れた」のか
               「顔ぶれの入れ替わりで段差が乗った」のかを見分けられない。 -->
          <thead><tr><th>観測点</th><th>受信</th><th>計測震度相当</th><th>混ざった本数</th><th>差分の最大（対）</th></tr></thead>
          <tbody>${stationRows.length > 0 ? stationRows : '<tr><td colspan="5" class="muted">該当なし（2 台以上を割り当てた観測点のみ）</td></tr>'}</tbody>
        </table>
      </section>
      <section class="panel">
        <h2>生データの保存</h2>
        <p>書き込みエラー: ${status.raw.writeErrors} 件 / 失った記録: ${status.raw.lostRecords} 件 /
        現在の日: ${escapeHtml(status.raw.currentDay ?? '不明')}</p>
      </section>
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
      bodyEl.innerHTML = '<p class="muted">状態を取得できていない</p>'
    }
  }

  await reload()
  if (signal.aborted) return
  // **見に来ている間だけ更新すればよい。** 他タブが選ばれている間は
  // `initStatusView` を再度呼び直すまで動かさない（`abort` で止める）。
  const timer = window.setInterval(() => void reload(), 5000)
  signal.addEventListener('abort', () => window.clearInterval(timer), { once: true })
}
