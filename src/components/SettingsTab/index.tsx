import { memo, useState, useCallback, useEffect, useRef } from 'react'
import type { AppSettings } from '../../hooks/useSettings'
import type { ConnectionStatus } from '../../types/earthquake'
import { getIntensityLabel, getIntensityColor, INTENSITY_LABELS } from '../../utils/intensity'
import { readableTextColor } from '../../utils/contrast'
import { playAlertSound, playCountdownBeep, playKyoshinUpdateSound, unlockAudio } from '../../utils/alertSound'
import { checkVoicevoxAvailable, fetchVoicevoxSpeakers, isValidVoicevoxUrl, speakWithVoicevox, type VoicevoxSpeaker } from '../../utils/voicevox'
import { serverDate, getServerClockOffsetMs } from '../../utils/clock'
import type { UseTestScenariosResult } from '../../hooks/useTestScenarios'
import type { ScenarioCategory } from '../../types/testScenario'
import type { HistoricalArchiveIndex } from '../../types/historicalArchive'
import { isDmdss } from '../../utils/env'
import { isValidDmdataApiKey, DMDATA_API_KEY_INVALID_MESSAGE } from '../../utils/dmdataApiKey'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import { DescriptionTip } from './DescriptionTip'
import { zipSync } from 'fflate'
import { countRecords, listRecords, clearRecords, onRecordsChanged, hasStorageError } from '../../utils/detectionDiagnosticsDb'
import { formatFileStamp } from '../../utils/formatters'
import { useKyoshinImport } from '../../hooks/useKyoshinImport'

export interface TestFunctions {
  earthquake: () => void
  foreignQuake: () => void
  eew: () => void
  eewWarning: () => void
  eewForecast: () => void
  eewAssumed: () => void
  eewDeep: () => void
  eewRetraction: () => void
  tsunami: () => void
  tsunamiWarning: () => void
  tsunamiWatch: () => void
  tsunamiForecast: () => void
  tsunamiRetraction: () => void
  nankaiChecking?: () => void
  nankaiWatch?: () => void
  nankaiWarning?: () => void
  nankaiCommentaryAdHoc?: () => void
  nankaiCommentaryRoutine?: () => void
  kohatsu?: () => void
  notification: () => void
}

interface Props {
  settings: AppSettings
  onUpdate: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  onTest: TestFunctions
  /** リプレイ中なら再生時刻と実時刻の差（null = 再生していない）。「再生中」表示の判定に使う。 */
  kyoshinTimeOffset: number | null
  kyoshinInputDateTime: string
  onSetKyoshinInputDateTime: (value: string) => void
  dmdataConnectionStatus?: ConnectionStatus
  replayIsFetching?: boolean
  /** 直近のリプレイ取得エラー（null = 正常）。ボタン下に赤字で表示する。 */
  replayError?: string | null
  onStartReplay: (date: Date) => void
  onStopReplay: () => void
  /** 収録済みローカル履歴アーカイブの一覧（DMDATA/P2PQuakeに無い期間を代替する）。表示専用。 */
  historicalArchives?: HistoricalArchiveIndex
  /** 上記一覧の読み込みが完了していないか。読み込み中に「確定」を押すとローカルアーカイブが判定から漏れるため、完了まで「確定」を無効化する。 */
  historicalArchivesLoading?: boolean
  scenarioTest: UseTestScenariosResult
}

// historicalArchivesはoptionalなpropのため、未指定時に`?? []`をインライン展開すると毎レンダーで
// 新しい配列インスタンスが生まれる。KyoshinImportRow内部のuseCallback/useEffectの依存配列に
// そのまま渡ると、参照の不安定さが原因で不要な再フェッチ・エフェクト再実行を招くため、
// モジュールレベルの安定した空配列を使い回す。
const EMPTY_HISTORICAL_ARCHIVES: HistoricalArchiveIndex = []

// ---- Reusable UI parts ----

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-card rounded-lg border border-border overflow-hidden mb-3">
      <div className="px-4 py-2.5 bg-panel border-b border-border">
        <h2 className="text-white text-sm font-bold">{title}</h2>
      </div>
      <div className="divide-y divide-border">{children}</div>
    </section>
  )
}

/**
 * 診断ログの件数表示と書き出し・消去。
 *
 * 書き出しはブラウザのダウンロードとして行う（許可なくファイルシステムへ書き込む口が無いため、
 * 自動保存はできない）。1 件あたり 100KB 前後になるので ZIP に固めて出す。
 */
function DiagnosticLogRow() {
  const [count, setCount] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(() => {
    void countRecords().then(setCount)
    if (hasStorageError()) setError('この端末では記録を保存できません（プライベートモード・容量不足など）')
  }, [])
  // 記録が増減したら読み直す。設定タブは常時マウントされたまま CSS で隠れるだけなので、
  // 一定間隔で問い合わせる作りにすると、開いていない間も IndexedDB を叩き続けることになる
  useEffect(() => {
    refresh()
    return onRecordsChanged(refresh)
  }, [refresh])

  const download = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const records = await listRecords()
      if (records.length === 0) {
        setError('書き出せる記録がありません')
        return
      }
      const enc = new TextEncoder()
      const files: Record<string, Uint8Array> = {}
      for (const r of records) {
        const ts = formatFileStamp(r.dataTimeMs)
        files[`${ts}_${r.reachedConfidence}_${r.event.id}.json`] = enc.encode(JSON.stringify(r))
      }
      const stamp = formatFileStamp(Date.now())
      const blob = new Blob([zipSync(files)], { type: 'application/zip' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${stamp}_kyoshin-diagnostics_${records.length}件.zip`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      // 失敗を黙って飲み込むと、押しても何も起きない理由が利用者に分からない
      setError(`書き出しに失敗しました（${e instanceof Error ? e.message : String(e)}）`)
    } finally {
      setBusy(false)
    }
  }, [])

  const clear = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      if (!(await clearRecords())) setError('消去に失敗しました')
    } finally {
      setBusy(false)
    }
  }, [])

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <span className="text-xs text-secondary">{count == null ? '—' : `${count} 件`}</span>
        <button
          onClick={() => { void download() }}
          disabled={busy || !count}
          className="px-3 py-1.5 rounded text-xs bg-panel border border-border text-white disabled:opacity-40"
        >
          書き出す
        </button>
        <button
          onClick={() => { void clear() }}
          disabled={busy || !count}
          className="px-3 py-1.5 rounded text-xs bg-panel border border-border text-secondary disabled:opacity-40"
        >
          消去
        </button>
      </div>
      {error && <span className="text-xs text-red-400 text-right">{error}</span>}
    </div>
  )
}

/**
 * NIEDから手動でダウンロードしたK-NET/KiK-net ZIPを取り込む。対応するアーカイブは
 * ZIPヘッダーのOrigin Timeから自動検出するため、ファイルを選ぶだけでよい（useKyoshinImport参照）。
 */
function KyoshinImportRow({ historicalArchives }: { historicalArchives: HistoricalArchiveIndex }) {
  const { summaries, importing, deletingArchiveId, errors, deleteError, storageError, importFiles, deleteArchive } = useKyoshinImport(historicalArchives)
  const inputRef = useRef<HTMLInputElement>(null)
  const busy = importing || deletingArchiveId !== null

  const handleFiles = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) void importFiles(files)
    // 同じファイルを選び直しても onChange が発火するようにする（selectしたまま失敗を直して
    // 再選択するケースがあるため）。
    e.target.value = ''
  }, [importFiles])

  return (
    <div className="flex flex-col items-end gap-2">
      <input
        ref={inputRef}
        type="file"
        accept=".zip"
        multiple
        onChange={handleFiles}
        disabled={busy}
        className="hidden"
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="px-3 py-1.5 rounded text-xs bg-panel border border-border text-white disabled:opacity-40"
      >
        {importing ? '取り込み中...' : 'ZIPを選択'}
      </button>
      {summaries.length > 0 && (
        <div className="flex flex-col gap-1.5 items-end">
          {summaries.map((s) => (
            <div key={s.archiveId} className="flex items-center gap-2">
              <span className="text-xs text-secondary whitespace-nowrap">{s.label}: {s.eventCount}件</span>
              <button
                onClick={() => { void deleteArchive(s.archiveId) }}
                disabled={busy}
                className="px-2 py-1 rounded text-xs bg-panel border border-border text-secondary disabled:opacity-40"
              >
                {deletingArchiveId === s.archiveId ? '削除中...' : '削除'}
              </button>
            </div>
          ))}
        </div>
      )}
      {storageError && (
        <span className="text-xs text-red-400 text-right">
          読み込み済みのデータをうまく読み出せていません（一覧に出ていない地震があるかもしれません）
        </span>
      )}
      {deleteError && <span className="text-xs text-red-400 text-right">{deleteError}</span>}
      {errors.length > 0 && (
        <div className="flex flex-col gap-0.5 items-end">
          {errors.map((e, i) => (
            <span key={`${i}-${e.fileName}`} className="text-xs text-red-400 text-right break-all">{e.fileName}: {e.message}</span>
          ))}
        </div>
      )}
    </div>
  )
}

function Row({ label, description, hint, children }: {
  label: string
  description?: string
  /**
   * 常時表示する前置き。説明文（`description`）はホバー・タップまで隠れるため、
   * **隠すと失敗の原因が辿れなくなる前提条件**だけをここに置く。
   * 例: VOICEVOX 読み上げは別アプリの起動が要る。それを知らないまま ON にすると
   * 「接続状態: 起動していません」だけが出て、何を起動すべきか分からない。
   */
  hint?: string
  children?: React.ReactNode
}) {
  // ラベル側に最低幅（basis-32 = 8rem）を与えたうえで折り返しを許可する。右のコントロールは
  // 幅を譲らない（select の選択肢や URL 入力は縮めると読めなくなる）ため、両方を 1 行に詰めると
  // パネル幅が最も狭いスマホ横（sideNarrow = w-panel-narrow）でラベルが数文字幅まで潰れ、
  // 1 文字ずつ改行される。
  // flex-wrap なら収まらない行だけがラベル上・コントロール下の 2 段に落ち、トグルのような
  // 細いコントロールの行は 1 行のまま保たれる（スマホ横は画面高が狭く、一律の縦積みは割に合わない）。
  // 最低幅は「2 段に落とす行」を選ぶ閾値でもある。sideNarrow・UI 倍率 100%・既定の表示状態での
  // 実測では行の内寸が 289px で、閾値は 289 -（最低幅 128 + gap 16）= 145px。これを超える
  // コントロールだけが 2 段になり、対象は APIキーの入力欄（192px）・震度更新の試聴ボタン列
  // （231px）・開始時刻の入力（206px）の 3 行。1 段に留まる最大は活断層線の濃さのスライダー
  // （136px）。寸法はすべて rem なので倍率を変えても比率は保たれる。VOICEVOX 設定のように
  // 条件付きで現れる行はこの数に含めていない。
  // 広げすぎると通知種別の行（コントロール 63〜98px）まで巻き込んで画面高を浪費する。
  // 伸長指定に flex-1 を使わないこと: flex ショートハンドが flex-basis を 0% で上書きし、
  // 最低幅が効かなくなる（Tailwind は flex-basis より flex を後に出力する）。
  return (
    // data-settings-row は説明の吹き出しが基準にする矩形の目印。ラベルではなく行を基準に
    // することで、2 段に折り返した行でコントロールを覆わない（DescriptionTip 参照）。
    <div data-settings-row className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 grow basis-32">
        {/* 説明文は常時表示せず、ラベルをホバー・タップしたときだけ吹き出しで出す。
            設定タブは行数が多く、全行に説明文を敷くと縦が 3 割伸びる（4804px→6310px）。 */}
        {description
          ? <DescriptionTip label={label} description={description} />
          : <p className="text-white text-sm">{label}</p>}
        {hint && <p className="text-secondary text-xs mt-0.5">{hint}</p>}
      </div>
      {/* ml-auto は 2 段に落ちた行のためにある。折り返した 2 行目はコントロール 1 個だけの行になり、
          アイテムが 1 個の行では justify-between が flex-start にフォールバックして左寄せになる
          （コントロール側が自前で持つ justify-end は中身の並びにしか効かない）。
          1 行に収まる行では先にラベルの grow が余白を使い切るので、この ml-auto は何もしない。
          max-w-full は行幅を超える中身への歯止め。flex-shrink-0 は「余白が足りないとき縮まない」
          という指定でしかなく、中身が行より広い場合ははみ出して Section の overflow-hidden に
          切り取られる（データ出典の一行がこれに当たった。その行は現在 CreditRow へ移している）。
          max-width なら shrink とは別の制約として効くので、幅を譲らせたくない select や
          入力欄はそのままに、超過分だけ折り返せる。 */}
      <div className="flex-shrink-0 ml-auto max-w-full">{children}</div>
    </div>
  )
}

/**
 * 出典表記の行。`Row` の「ラベルに最低幅を与える」規則をあえて使わない。
 *
 * `Row` はラベルに最低幅 8rem（128px）を確保するが、出典行はラベルが短く値が長いため
 * この規則と噛み合わない。「地図」は 2 文字でも 128px を取り、値（実測 285px）と間隔を
 * 足すと 429px になって行の内寸（PC 幅で 353px）を超え、ラベル上・値下の 2 段に
 * 折り返してしまう。ラベルを自然幅にすれば 325px で 1 行に収まる。
 *
 * 値は折り返せるテキスト（出典・リンク）に限るため、幅が足りないときは 2 段に落とすのではなく
 * 右側で折り返させる（`min-w-0`）。ラベル側は潰さない（`flex-shrink-0`）。
 *
 * 値側に `grow` が要る。付けないと値の枠が中身の最大幅ちょうどで確定し、1px 未満の
 * 端数で折り返してしまう（余白は残っているのに 2 行になる）。余った幅を吸わせて回避する。
 * 右寄せは `grow` と `text-right` で成立するので `justify-between` は置かない
 * （2 要素の一方が余白を吸い切る配置では `justify-content` は何もしない）。
 */
function CreditRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // data-settings-row は Row と同じ目印。この行は今のところ説明文を持たないため吹き出しは
    // 出ないが、後から説明を足したときに基準が行全体になるよう先に付けておく（付け忘れると
    // ラベル 1 個分の矩形が基準になり、値を覆わないための設計が効かなくなる）。
    <div data-settings-row className="flex items-baseline gap-x-4 px-4 py-3">
      <p className="text-white text-sm flex-shrink-0">{label}</p>
      <div className="min-w-0 grow text-right">{children}</div>
    </div>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`
        relative inline-flex h-6 w-11 items-center rounded-full transition-colors
        ${checked ? 'bg-blue-500' : 'bg-border'}
      `}
    >
      <span
        className={`
          inline-block h-4 w-4 rounded-full bg-white shadow transition-transform
          ${checked ? 'translate-x-6' : 'translate-x-1'}
        `}
      />
    </button>
  )
}

const SCALE_OPTIONS = [10, 20, 30, 40, 45, 50, 55, 60, 70] as const

function ScaleSelect({ value, onChange, noneLabel = 'すべて表示', includeNone = true }: {
  value: number
  onChange: (v: number) => void
  noneLabel?: string
  /**
   * 「絞らない」を表す -1 の選択肢を出すか。
   *
   * 有効・無効を別のトグルで持つ項目では出さない。出すと `SCALE_OPTIONS` の最小値と同じ文言
   * （「震度1以上」）が 2 つ並び、どちらを選んでも同じ結果になる紛らわしい一覧になる。
   */
  includeNone?: boolean
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(Number(e.target.value))}
      className="bg-panel border border-border text-white text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
    >
      {includeNone && <option value={-1}>{noneLabel}</option>}
      {SCALE_OPTIONS.map(s => (
        <option key={s} value={s}>震度{getIntensityLabel(s)}以上</option>
      ))}
    </select>
  )
}

function IntensityBadge({ scale }: { scale: number }) {
  if (scale === -1) return null
  const fill = getIntensityColor(scale)
  return (
    <span
      className="inline-block text-xs font-bold px-1.5 py-0.5 rounded"
      style={{ backgroundColor: fill, color: readableTextColor(fill) }}
    >
      震度{getIntensityLabel(scale)}
    </span>
  )
}

type ButtonColor = 'red' | 'orange' | 'yellow' | 'purple' | 'blue' | 'green' | 'teal'

// 白文字（text-white）を載せるため、通常時・ホバー時とも WCAG AA（4.5:1）を満たす濃さにする。
// orange / yellow / green は従来の色だとホバー時に 3.56 / 1.92 / 3.30 まで落ちていたため、
// 一段ずつ暗い側へずらした（従来の通常時の色がホバー時の色に来る形）。最小は yellow のホバー 4.92。
const BUTTON_CLASSES: Record<ButtonColor, string> = {
  red:    'bg-red-700 hover:bg-red-600',
  orange: 'bg-orange-800 hover:bg-orange-700',
  yellow: 'bg-yellow-800 hover:bg-yellow-700',
  purple: 'bg-purple-700 hover:bg-purple-600',
  blue:   'bg-blue-700 hover:bg-blue-600',
  green:  'bg-green-800 hover:bg-green-700',
  // 解説情報バナー（teal）に合わせた色。green と同じ理由で一段暗い側を使う（ホバー時 5.4:1）
  teal:   'bg-teal-800 hover:bg-teal-700',
}

function TestButton({ color, onClick, children, disabled }: {
  color: ButtonColor
  onClick: () => void
  children: React.ReactNode
  disabled?: boolean
}) {
  const [fired, setFired] = useState(false)

  const handle = () => {
    onClick()
    setFired(true)
    setTimeout(() => setFired(false), 2000)
  }

  return (
    <button
      onClick={handle}
      disabled={disabled}
      className={`text-xs text-white px-3 py-1.5 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        fired ? 'bg-gray-600' : BUTTON_CLASSES[color]
      }`}
    >
      {fired ? '送信済み' : children}
    </button>
  )
}

const SCENARIO_CATEGORY_COLOR: Record<ScenarioCategory, ButtonColor> = {
  'eew-special': 'red',
  'eew-warning': 'orange',
  'eew-forecast': 'yellow',
  quake: 'red',
  tsunami: 'purple',
  lpgm: 'blue',
  foreign: 'green',
}

// 震度別の色付き小ボタン（通知音テスト用）
function IntensityPlayButton({ scale, kyoshinIndex }: { scale: number; kyoshinIndex: number }) {
  const [active, setActive] = useState(false)
  const handle = () => {
    unlockAudio()
    playKyoshinUpdateSound(kyoshinIndex)
    setActive(true)
    setTimeout(() => setActive(false), 600)
  }
  const fill = getIntensityColor(scale)
  return (
    <button
      onClick={handle}
      title={`震度${getIntensityLabel(scale)} の更新音を試聴`}
      className={`text-xs font-bold px-2 py-1 rounded transition-opacity ${active ? 'opacity-40' : 'hover:opacity-75'}`}
      style={{ backgroundColor: fill, color: readableTextColor(fill) }}
    >
      {getIntensityLabel(scale)}
    </button>
  )
}

/**
 * S 波到達カウントダウン音（残り 5〜1 秒）を 1 段階だけ試聴する小ボタン。
 * 実運用ではホーム位置を設定したうえで S 波到達が残り 5 秒を切らないと鳴らないため、
 * 段階ごとの差（ゲート周波数の上昇・残り 1 秒の重ね音）はここでしか聞き分けられない。
 */
function CountdownPlayButton({ second }: { second: number }) {
  const [active, setActive] = useState(false)
  const handle = () => {
    unlockAudio()
    playCountdownBeep(second)
    setActive(true)
    setTimeout(() => setActive(false), 600)
  }
  // 残り 1 秒だけ音の構成が変わる（サブ低音とトーンを重ねる）ため、色でも区別する。
  return (
    <button
      onClick={handle}
      title={`S 波到達まで残り ${second} 秒の音を試聴`}
      className={`text-xs font-bold text-white px-2 py-1 rounded transition-opacity ${
        active ? 'opacity-40' : ''
      } ${second === 1 ? BUTTON_CLASSES.red : BUTTON_CLASSES.blue}`}
    >
      {second}
    </button>
  )
}

function NotificationPermissionButton() {
  const [perm, setPerm] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied',
  )

  const request = useCallback(async () => {
    if (typeof Notification === 'undefined') return
    const result = await Notification.requestPermission()
    setPerm(result)
  }, [])

  if (perm === 'granted') return <span className="text-xs text-green-400 font-medium">許可済み</span>
  if (perm === 'denied') return <span className="text-xs text-red-400">ブラウザで拒否済み</span>
  return (
    <button
      onClick={request}
      className="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded transition-colors"
    >
      通知を許可する
    </button>
  )
}

// LOW-A5: サーバー時刻オフセット表示。Yahoo 強震モニタ経由で較正済みなら差分（ms）を、
// 未較正（Yahoo 到達不能など）なら「未較正」を表示する。5 秒ごとに再取得。
function ServerClockOffsetDisplay() {
  const [offsetMs, setOffsetMs] = useState<number | null>(getServerClockOffsetMs())
  useEffect(() => {
    const id = window.setInterval(() => setOffsetMs(getServerClockOffsetMs()), 5000)
    return () => window.clearInterval(id)
  }, [])
  if (offsetMs === null) {
    return <span className="text-xs text-secondary">未較正</span>
  }
  const sign = offsetMs > 0 ? '+' : ''
  return <span className="text-xs text-secondary">{sign}{offsetMs} ms</span>
}

// VOICEVOX の接続確認を遅らせる時間。入力欄は 1 文字ごとに設定を保存するため、生の値を
// 確認 effect の依存に渡すと打鍵のたびに /version を叩く（実測: 「192」と打つ途中の「1」「19」
// 「192」がそれぞれ IPv4 の 0.0.0.1 / 0.0.0.19 / 0.0.0.192 として接続され、全部失敗した）。
// DMDATA の APIキー（App.tsx の API_KEY_DEBOUNCE_MS）と同じ 800ms に揃える。
const VOICEVOX_URL_DEBOUNCE_MS = 800

// ---- Main component ----

function HomeLocationSection({
  homeLat,
  homeLng,
  onUpdate,
}: {
  homeLat: number | null
  homeLng: number | null
  onUpdate: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleGetLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setError('このブラウザは位置情報をサポートしていません')
      return
    }
    setLoading(true)
    setError(null)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        onUpdate('homeLat', pos.coords.latitude)
        onUpdate('homeLng', pos.coords.longitude)
        setLoading(false)
      },
      (err) => {
        setError(err.code === 1 ? '位置情報の許可が必要です' : '位置情報の取得に失敗しました')
        setLoading(false)
      },
      { enableHighAccuracy: false, timeout: 10000 },
    )
  }, [onUpdate])

  const handleClear = useCallback(() => {
    onUpdate('homeLat', null)
    onUpdate('homeLng', null)
    setError(null)
  }, [onUpdate])

  const isSet = homeLat !== null && homeLng !== null

  return (
    <div className="px-4 py-3 space-y-2">
      <p className="text-xs text-secondary">現在地をS波到達の基準点として使用します。HTTPS または localhost が必要です。</p>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-xs text-white font-mono">
          {isSet
            ? `北緯${homeLat!.toFixed(4)}° 東経${homeLng!.toFixed(4)}°`
            : '未設定'}
        </span>
        <div className="flex gap-2">
          <button
            onClick={handleGetLocation}
            disabled={loading}
            className="text-xs bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white px-3 py-1.5 rounded transition-colors"
          >
            {loading ? '取得中…' : '現在地を取得'}
          </button>
          {isSet && (
            <button
              onClick={handleClear}
              className="text-xs bg-gray-700 hover:bg-gray-600 text-white px-3 py-1.5 rounded transition-colors"
            >
              クリア
            </button>
          )}
        </div>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  )
}

// React.memo 化の理由と props 参照安定性の要件は docs/spec/architecture-spec.md 参照。
export const SettingsTab = memo(function SettingsTab({ settings, onUpdate, onTest, kyoshinTimeOffset, kyoshinInputDateTime, onSetKyoshinInputDateTime, dmdataConnectionStatus, replayIsFetching, replayError, onStartReplay, onStopReplay, historicalArchives, historicalArchivesLoading, scenarioTest }: Props) {
  const [voicevoxStatus, setVoicevoxStatus] = useState<'idle' | 'checking' | 'available' | 'unavailable' | 'invalid'>('idle')
  const [voicevoxSpeakers, setVoicevoxSpeakers] = useState<VoicevoxSpeaker[]>([])

  // 通信を起こす側へ渡す URL は入力が落ち着くまで待つ。保存と入力欄の表示は即座に反映したいので、
  // 遅らせるのは確認 effect だけにする（試聴・実際の読み上げはユーザー操作の時点でしか通信しない）。
  const debouncedVoicevoxUrl = useDebouncedValue(settings.voicevoxUrl, VOICEVOX_URL_DEBOUNCE_MS)
  // 入力が止まって確認が走るまでの間、前回の結果（例:「起動中」）を出したままにすると、
  // 入力欄に見えている URL とは別の URL の結果を指してしまう。確認予定であることを見せる。
  const isVoicevoxCheckPending = settings.voicevoxUrl !== debouncedVoicevoxUrl

  useEffect(() => {
    if (!settings.voicevoxEnabled) {
      setVoicevoxStatus('idle')
      setVoicevoxSpeakers([])
      return
    }
    // URL として成立していない値では通信しない。「起動していません」と出すと VOICEVOX 側の
    // 問題に見えるため、入力の誤りとして区別する。
    if (!isValidVoicevoxUrl(debouncedVoicevoxUrl)) {
      setVoicevoxStatus('invalid')
      setVoicevoxSpeakers([])
      return
    }
    let cancelled = false
    setVoicevoxStatus('checking')
    checkVoicevoxAvailable(debouncedVoicevoxUrl).then(ok => {
      if (cancelled) return
      if (!ok) { setVoicevoxStatus('unavailable'); return }
      return fetchVoicevoxSpeakers(debouncedVoicevoxUrl).then(spks => {
        if (cancelled) return
        setVoicevoxSpeakers(spks)
        setVoicevoxStatus('available')
      })
    }).catch(() => { if (!cancelled) setVoicevoxStatus('unavailable') })
    return () => { cancelled = true }
  }, [settings.voicevoxEnabled, debouncedVoicevoxUrl])

  const handleTimeConfirm = () => {
    if (!kyoshinInputDateTime) return
    const specified = new Date(kyoshinInputDateTime)
    if (isNaN(specified.getTime())) return
    onStartReplay(specified)
  }

  const replayStartLabel = kyoshinTimeOffset != null
    ? serverDate().toLocaleString('ja-JP')
    : null

  // 入力済みのキーが通信に載せられない文字を含んでいるか。空欄は「未設定」として別に扱うため
  // ここには含めない（入力途中に赤字が出続けるのを避ける）。
  const isApiKeyInvalid = settings.dmdataApiKey !== '' && !isValidDmdataApiKey(settings.dmdataApiKey)

  // 現状は親が flex コンテナでないため flex-1 が効かず、実スクロールは App.tsx 側のタブ領域が担う。
  // ただし親に flex が付けばこの要素自身がスクロール領域に変わるため、横スクロールの抑止は
  // 先に付けておく（overflow-y だけだと overflow-x も auto に格上げされる）。
  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden overscroll-x-none p-3">

      {isDmdss && (
        <Section title="DM-D.S.S 接続設定">
          <div className="px-4 py-2 bg-yellow-900/30 border-b border-yellow-700/40">
            <p className="text-yellow-400 text-xs">APIキーはこのブラウザにのみ保存されます。第三者と共有しないでください。</p>
          </div>
          <Row label="接続状態">
            {dmdataConnectionStatus === 'connected' ? (
              <span className="text-xs text-green-400 font-medium">接続中</span>
            ) : dmdataConnectionStatus === 'connecting' ? (
              <span className="text-xs text-blue-400">接続試行中...</span>
            ) : dmdataConnectionStatus === 'replay' ? (
              // 過去再生中はライブ受信を意図的に止めている。「切断」と出すと異常のように見え、
              // 更新しないままだと「接続中」が残って実態と食い違うため、専用の文言にする。
              <span className="text-xs text-blue-400">再生中（ライブ受信は停止）</span>
            ) : (
              // キーが不正なときは接続を試みていない。「切断」だと通信の失敗に見えるため区別する。
              <span className={`text-xs ${isApiKeyInvalid ? 'text-red-400' : 'text-secondary'}`}>
                {!settings.dmdataApiKey ? 'APIキー未設定' : isApiKeyInvalid ? 'APIキーが不正' : '切断'}
              </span>
            )}
          </Row>
          <Row label="APIキー" description="DMDATA.JP のAPIキーを入力してください">
            {/* 不正な文字は入力時に弾かず、入ったことを見せて本人に直させる。入力欄から黙って
                取り除くと、貼り付けたキーが勝手に変わって「合っているのに繋がらない」状態になる。 */}
            <div className="flex flex-col items-end gap-1">
              <input
                type="password"
                value={settings.dmdataApiKey}
                onChange={e => onUpdate('dmdataApiKey', e.target.value)}
                placeholder="APIキーを入力"
                autoComplete="off"
                className={`bg-panel border text-white text-xs rounded px-2 py-1.5 focus:outline-none w-48 ${
                  isApiKeyInvalid ? 'border-red-500 focus:border-red-500' : 'border-border focus:border-blue-500'
                }`}
              />
              {isApiKeyInvalid && (
                <p className="text-xs text-red-400 w-48 text-left leading-snug">{DMDATA_API_KEY_INVALID_MESSAGE}</p>
              )}
            </div>
          </Row>
          <Row label="試験報を受信（検証用）" description="試験報・訓練報を受信します（VXSE42は疎通確認のみ・VXSE43/45は表示されます）">
            <Toggle
              checked={settings.dmdataTestDelivery}
              onChange={v => onUpdate('dmdataTestDelivery', v)}
            />
          </Row>

        </Section>
      )}

      <Section title="表示設定">
        <Row label="最低表示震度" description="これ未満の地震はリストに表示しません">
          <div className="flex items-center gap-2">
            <IntensityBadge scale={settings.minDisplayScale} />
            <ScaleSelect
              value={settings.minDisplayScale}
              onChange={v => onUpdate('minDisplayScale', v)}
            />
          </div>
        </Row>
        <Row label="UI 倍率" description="画面全体の表示倍率を変更します">
          <select
            value={settings.uiScale}
            onChange={e => onUpdate('uiScale', Number(e.target.value))}
            className="bg-panel border border-border text-white text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
          >
            {[0.5, 0.6, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.25, 2.5].map(s => (
              <option key={s} value={s}>{Math.round(s * 100)}%</option>
            ))}
          </select>
        </Row>
        <Row label="地図アイコンの倍率" description="地図上の震度マーカー等の大きさを変更します（UI 倍率とは独立）">
          <select
            value={settings.mapIconScale}
            onChange={e => onUpdate('mapIconScale', Number(e.target.value))}
            className="bg-panel border border-border text-white text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
          >
            {[0.5, 0.6, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.25, 2.5].map(s => (
              <option key={s} value={s}>{Math.round(s * 100)}%</option>
            ))}
          </select>
        </Row>
        {/* ── 地図レイヤー: 地形 → 地質構造 → 観測データ の順 ── */}
        <Row label="海底地形を表示" description="背景の海域に海底地形（陰影）を表示します">
          <Toggle
            checked={settings.showBathymetry}
            onChange={v => onUpdate('showBathymetry', v)}
          />
        </Row>
        <Row label="プレート境界線を表示" description="地震情報・リアルタイムタブの地図に世界のプレート境界線を表示します（PB2002モデル）">
          <Toggle
            checked={settings.showPlateBoundaries}
            onChange={v => onUpdate('showPlateBoundaries', v)}
          />
        </Row>
        <Row label="活断層線を表示" description="地震情報・リアルタイムタブの地図に全国の活断層線を表示します（産総研 活断層データベース）">
          <Toggle
            checked={settings.showActiveFaults}
            onChange={v => onUpdate('showActiveFaults', v)}
          />
        </Row>
        <Row label="活断層線の濃さ" description="活断層線の不透明度を調整します（濃くするほど目立ちます）">
          <div className="flex items-center gap-2">
            <span className="text-xs text-secondary w-8 text-right">
              {Math.round(settings.activeFaultOpacity * 100)}%
            </span>
            <input
              type="range"
              min={0.05}
              max={1}
              step={0.05}
              value={settings.activeFaultOpacity}
              onChange={e => onUpdate('activeFaultOpacity', Number(e.target.value))}
              disabled={!settings.showActiveFaults}
              className="w-24 accent-blue-500 disabled:opacity-40"
            />
          </div>
        </Row>
        <Row label="地震活動ヒートマップを表示" description="地震情報・リアルタイムタブの地図に直近1ヶ月の地震活動をヒートマップで表示します（初回表示時にAPIから取得）">
          <Toggle
            checked={settings.showQuakeHeatmap}
            onChange={v => onUpdate('showQuakeHeatmap', v)}
          />
        </Row>
      </Section>

      <Section title="ホーム地点">
        <HomeLocationSection
          homeLat={settings.homeLat}
          homeLng={settings.homeLng}
          onUpdate={onUpdate}
        />
      </Section>

      <Section title="タブ自動切替設定">
        <Row label="デフォルトタブ" description="操作や情報更新が一定時間ないとこのタブに戻ります">
          <select
            value={settings.defaultTab}
            onChange={e => onUpdate('defaultTab', e.target.value as AppSettings['defaultTab'])}
            className="bg-panel border border-border text-white text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
          >
            <option value="earthquake">地震情報</option>
            <option value="realtime">リアルタイム</option>
          </select>
        </Row>
        <Row label="津波発表中は津波情報を優先" description="津波情報の発表中はデフォルトタブを津波情報にします">
          <Toggle
            checked={settings.tsunamiPriorityDefault}
            onChange={v => onUpdate('tsunamiPriorityDefault', v)}
          />
        </Row>
        <Row label="津波タイトル表示を一定時間に制限" description="ONで受信のたびに自動復帰までの時間だけ表示し、発表中でも自動的に戻ります">
          <Toggle
            checked={settings.tsunamiTitleTemporary}
            onChange={v => onUpdate('tsunamiTitleTemporary', v)}
          />
        </Row>
        <Row label="自動復帰までの時間" description="操作・情報更新がこの時間ないとデフォルトタブに戻ります">
          <select
            value={settings.idleRevertSec}
            onChange={e => onUpdate('idleRevertSec', Number(e.target.value))}
            className="bg-panel border border-border text-white text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
          >
            <option value={0}>無効</option>
            <option value={15}>15秒</option>
            <option value={30}>30秒</option>
            <option value={60}>1分</option>
            <option value={120}>2分</option>
            <option value={180}>3分</option>
            <option value={300}>5分</option>
          </select>
        </Row>
      </Section>

      <Section title="動作設定">
        <Row label="定期自動リロード" description="毎日午前5時に画面を再起動してメモリを解放します（地震・津波・EEW 発報中は延期）">
          <Toggle
            checked={settings.periodicReloadHours > 0}
            onChange={v => onUpdate('periodicReloadHours', v ? 1 : 0)}
          />
        </Row>
      </Section>

      <Section title="通知設定">
        <Row label="通知音" description="地震・緊急地震速報・津波の受信時に音を鳴らします">
          <Toggle
            checked={settings.soundEnabled}
            onChange={v => onUpdate('soundEnabled', v)}
          />
        </Row>
        {(settings.soundEnabled || settings.voicevoxEnabled) && (
          <Row label="音量" description="通知音・読み上げ（下記 VOICEVOX を含む）共通の音量">
            <div className="flex items-center gap-2">
              <span className="text-xs text-secondary w-8 text-right">
                {Math.round(settings.soundVolume * 100)}%
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={settings.soundVolume}
                onChange={e => onUpdate('soundVolume', Number(e.target.value))}
                className="w-24 accent-blue-500"
              />
            </div>
          </Row>
        )}
        {/* 「要：VOICEVOXアプリ起動」は hint に置いて常時見せる。説明文に混ぜて隠すと、
            ON にしたとき「接続状態: 起動していません」だけが見えて原因に辿り着けない。 */}
        <Row
          label="VOICEVOX 読み上げ"
          description="地震・EEW・津波情報をVOICEVOXで読み上げます"
          hint="要：VOICEVOXアプリ起動"
        >
          <Toggle checked={settings.voicevoxEnabled} onChange={v => onUpdate('voicevoxEnabled', v)} />
        </Row>
        {settings.voicevoxEnabled && (
          <>
            <Row label="VOICEVOX URL" description="VOICEVOXのHTTP APIのURL">
              {/* 赤枠と理由は入力が落ち着いてから出す（判定に使うのはデバウンス後の値）。
                  打鍵ごとに判定すると、書き直している最中ずっと赤いままになる。 */}
              <div className="flex flex-col items-end gap-1">
                <input
                  type="text"
                  value={settings.voicevoxUrl}
                  onChange={e => onUpdate('voicevoxUrl', e.target.value)}
                  className={`bg-input border rounded px-2 py-1 text-xs text-white w-44 ${
                    voicevoxStatus === 'invalid' ? 'border-red-500' : 'border-border'
                  }`}
                  spellCheck={false}
                />
                {voicevoxStatus === 'invalid' && (
                  <p className="text-xs text-red-400 w-44 text-left leading-snug">
                    URLの形式が正しくありません。http:// または https:// で始まる、ホスト名を含むURLを入力してください。
                  </p>
                )}
              </div>
            </Row>
            <Row label="接続状態" description="">
              <span className={`text-xs ${
                isVoicevoxCheckPending ? 'text-secondary'
                : voicevoxStatus === 'available' ? 'text-green-400'
                : voicevoxStatus === 'unavailable' || voicevoxStatus === 'invalid' ? 'text-red-400'
                : 'text-secondary'
              }`}>
                {isVoicevoxCheckPending || voicevoxStatus === 'checking' ? '確認中...'
                  : voicevoxStatus === 'available' ? '起動中'
                  : voicevoxStatus === 'unavailable' ? '起動していません'
                  : voicevoxStatus === 'invalid' ? 'URLが不正'
                  : '—'}
              </span>
            </Row>
            {voicevoxStatus === 'available' && voicevoxSpeakers.length > 0 && (
              <>
                <Row label="話者" description="読み上げに使う声を選択します">
                  <select
                    value={settings.voicevoxSpeakerId}
                    onChange={e => onUpdate('voicevoxSpeakerId', Number(e.target.value))}
                    className="bg-input border border-border rounded px-2 py-1 text-xs text-white"
                  >
                    {voicevoxSpeakers.flatMap(spk =>
                      spk.styles.map(st => (
                        <option key={st.id} value={st.id}>{spk.name}（{st.name}）</option>
                      ))
                    )}
                  </select>
                </Row>
                <Row label="テスト読み上げ" description="">
                  {/* 通信先はデバウンス後の URL。ここに並ぶ話者は「確認が済んだ URL」から取ったもので、
                      選べる話者と鳴らす相手が食い違わないよう揃える。生の値を使うと、URL を書き換えている
                      最中（接続状態が「確認中...」の間）に押したとき、入力途中の未検証の宛先へ投げて
                      黙って無音に終わる。 */}
                  <TestButton color="blue" onClick={() => {
                    unlockAudio()
                    speakWithVoicevox(debouncedVoicevoxUrl, '緊急地震速報。三陸沖を震源とするマグニチュード7.2の地震が発生しました。予想最大震度6強。', settings.voicevoxSpeakerId, settings.soundVolume).catch(() => {})
                  }}>▶ 試聴</TestButton>
                </Row>
              </>
            )}
            <Row label="読み上げ震度階数" description="最大震度に加えて何階級下まで地域名を読み上げるか（0 = 最大震度のみ）">
              <select
                value={settings.ttsIntensityLevels}
                onChange={e => onUpdate('ttsIntensityLevels', Number(e.target.value))}
                className="bg-input border border-border rounded px-2 py-1 text-xs text-white"
              >
                {[0, 1, 2, 3, 4].map(n => (
                  <option key={n} value={n}>{n === 0 ? '最大震度のみ' : `最大＋${n}階級`}</option>
                ))}
              </select>
            </Row>
            <Row label="必ず読み上げる震度" description="階数の設定を超えても、この震度以上の階級は地域名を読み上げます（長周期地震動には適用されません）">
              <div className="flex items-center gap-2">
                <IntensityBadge scale={settings.ttsAlwaysReadScale} />
                <ScaleSelect
                  value={settings.ttsAlwaysReadScale}
                  onChange={v => onUpdate('ttsAlwaysReadScale', v)}
                  noneLabel="階数の設定どおり"
                />
              </div>
            </Row>
            <Row label="読み上げ最大地域数" description="1階級あたりに読み上げる地域名の上限（0 = 無制限）">
              <select
                value={settings.ttsMaxRegions}
                onChange={e => onUpdate('ttsMaxRegions', Number(e.target.value))}
                className="bg-input border border-border rounded px-2 py-1 text-xs text-white"
              >
                {[0, 3, 5, 10, 15, 20].map(n => (
                  <option key={n} value={n}>{n === 0 ? '無制限' : `${n}地域`}</option>
                ))}
              </select>
            </Row>
            {settings.ttsMaxRegions > 0 && (
              <Row label="地域数の許容超過" description="上限をこの数まで超えるだけなら「ほかN地域」とせず全地域を読み上げます">
                <select
                  value={settings.ttsRegionTolerance}
                  onChange={e => onUpdate('ttsRegionTolerance', Number(e.target.value))}
                  className="bg-input border border-border rounded px-2 py-1 text-xs text-white"
                >
                  {[0, 1, 2, 3, 5].map(n => (
                    <option key={n} value={n}>{n === 0 ? '許容しない' : `+${n}地域まで`}</option>
                  ))}
                </select>
              </Row>
            )}
          </>
        )}
        {/* 解説情報は平常時でも毎月1回は必ず届くため、音と読み上げを個別に切れるようにしている。
            臨時情報（段階の発表）はこの設定に関わらず鳴る。 */}
        {isDmdss && (
          <Row
            label="解説情報の音・読み上げ"
            description="南海トラフ関連解説情報（平常時も毎月届く）の通知音と読み上げを行います"
          >
            <Toggle
              checked={settings.nankaiCommentaryAlerts}
              onChange={v => onUpdate('nankaiCommentaryAlerts', v)}
            />
          </Row>
        )}
        <Row label="行動チェックリスト" description="強い揺れのときに、とるべき行動と持ち出すものを画面上部に出します。緊急地震速報・リアルタイム震度・地震情報のいずれかで判定します">
          <Toggle
            checked={settings.actionChecklistMinScale >= 0}
            onChange={v => onUpdate('actionChecklistMinScale', v ? 45 : -1)}
          />
        </Row>
        {settings.actionChecklistMinScale >= 0 && (
          <Row label="出す最低震度" description="地点を登録していればその周辺（半径30km）で、していなければ全国のどこかでこの震度に達したときに出します">
            <div className="flex items-center gap-2">
              <IntensityBadge scale={settings.actionChecklistMinScale} />
              <ScaleSelect
                value={settings.actionChecklistMinScale}
                onChange={v => onUpdate('actionChecklistMinScale', v)}
                includeNone={false}
              />
            </div>
          </Row>
        )}
        <Row label="ブラウザ通知" description="地震発生時にブラウザ通知を表示します">
          <Toggle
            checked={settings.notifyMinScale >= 0}
            onChange={v => onUpdate('notifyMinScale', v ? 40 : -1)}
          />
        </Row>
        {settings.notifyMinScale >= 0 && (
          <>
            <Row label="通知する最低震度" description="この震度以上で通知を送信します">
              <div className="flex items-center gap-2">
                <IntensityBadge scale={settings.notifyMinScale} />
                <ScaleSelect
                  value={settings.notifyMinScale}
                  onChange={v => onUpdate('notifyMinScale', v === -1 ? 10 : v)}
                  noneLabel="震度1以上"
                />
              </div>
            </Row>
            {/* ── 種別トグル: テスト系と同じ 揺れ検知 → EEW → 津波 の順 ── */}
            <Row label="揺れ検知通知" description="強震モニタで揺れを検知したときに通知（推定値・頻度高め）">
              <Toggle checked={settings.notifyDetection} onChange={v => onUpdate('notifyDetection', v)} />
            </Row>
            <Row label="EEW 通知" description="緊急地震速報の発報・昇格時に通知（重複送信しない）">
              <Toggle checked={settings.notifyEEW} onChange={v => onUpdate('notifyEEW', v)} />
            </Row>
            <Row label="津波通知" description="津波注意報以上が発表されたときに通知">
              <Toggle checked={settings.notifyTsunami} onChange={v => onUpdate('notifyTsunami', v)} />
            </Row>
          </>
        )}
        <Row label="通知許可" description="ブラウザの通知権限を確認・許可します">
          <NotificationPermissionButton />
        </Row>
      </Section>

      <Section title="通知音テスト">
        <div className="px-4 py-2 bg-blue-900/30 border-b border-blue-700/40">
          <p className="text-blue-300 text-xs">クリックで各通知音を試聴できます（設定の通知音 ON/OFF に関わらず鳴ります）</p>
        </div>
        {/* ── 揺れ検知（候補 → 初回 → 更新の順） ── */}
        <Row label="揺れ検知（候補）" description="控えめな単発チャイム（確定前の予兆通知）">
          <TestButton color="blue" onClick={() => { unlockAudio(); playAlertSound('kyoshinCandidate') }}>▶ 試聴</TestButton>
        </Row>
        <Row label="揺れ検知（初回）" description="打撃2音 + シマー高周波">
          <TestButton color="blue" onClick={() => { unlockAudio(); playAlertSound('kyoshin') }}>▶ 試聴</TestButton>
        </Row>
        <Row label="揺れ検知・震度更新" description="震度をタップして試聴">
          <div className="flex flex-wrap gap-1.5 justify-end">
            <IntensityPlayButton scale={20} kyoshinIndex={9}  />
            <IntensityPlayButton scale={30} kyoshinIndex={11} />
            <IntensityPlayButton scale={40} kyoshinIndex={13} />
            <IntensityPlayButton scale={45} kyoshinIndex={15} />
            <IntensityPlayButton scale={50} kyoshinIndex={16} />
            <IntensityPlayButton scale={55} kyoshinIndex={17} />
            <IntensityPlayButton scale={70} kyoshinIndex={19} />
          </div>
        </Row>
        {/* ── 緊急地震速報（EEW） ── */}
        <Row label="EEW 予報（低震度）" description="ダークピアノ F4→A4（緩やか）">
          <TestButton color="blue" onClick={() => { unlockAudio(); playAlertSound('eewForecast') }}>▶ 試聴</TestButton>
        </Row>
        <Row label="EEW 初報（警報）" description="警報音 Bb3 の2連">
          <TestButton color="orange" onClick={() => { unlockAudio(); playAlertSound('eew') }}>▶ 試聴</TestButton>
        </Row>
        <Row label="EEW 特別警報" description="警報音 Bb4/F4 の交互9連打 + 低音（震度6弱以上）">
          <TestButton color="red" onClick={() => { unlockAudio(); playAlertSound('eewSpecial') }}>▶ 試聴</TestButton>
        </Row>
        <Row label="EEW 続報" description="ダークピアノ F4 単音">
          <TestButton color="orange" onClick={() => { unlockAudio(); playAlertSound('eewUpdate') }}>▶ 試聴</TestButton>
        </Row>
        <Row label="EEW 最終報" description="ダークピアノ F4→C4 の降下2音">
          <TestButton color="blue" onClick={() => { unlockAudio(); playAlertSound('eewFinal') }}>▶ 試聴</TestButton>
        </Row>
        <Row label="EEW キャンセル" description="ダークピアノ A4→F4→C4 降下3音">
          <TestButton color="blue" onClick={() => { unlockAudio(); playAlertSound('eewCancel') }}>▶ 試聴</TestButton>
        </Row>
        {/* S 波到達カウントダウンは重大度の系列とは別軸の補助音のため EEW の末尾に置く */}
        <Row label="S 波到達カウントダウン" description="残り秒数をタップして試聴（秒が減るほど速く・多く鳴る。残り 1 秒はサブ低音2本と高音を重ねる）">
          <div className="flex flex-wrap gap-1.5 justify-end">
            <CountdownPlayButton second={5} />
            <CountdownPlayButton second={4} />
            <CountdownPlayButton second={3} />
            <CountdownPlayButton second={2} />
            <CountdownPlayButton second={1} />
          </div>
        </Row>
        {/* ── 地震情報 ── */}
        <Row label="地震情報（震度速報）" description="ピアノ上昇3音 G#4→B4→E5">
          <TestButton color="orange" onClick={() => { unlockAudio(); playAlertSound('earthquakePrompt') }}>▶ 試聴</TestButton>
        </Row>
        <Row label="地震情報（震源・震度 / 各地の震度）" description="ピアノ上昇4音 E4→G#4→B4→E5">
          <TestButton color="red" onClick={() => { unlockAudio(); playAlertSound('earthquake') }}>▶ 試聴</TestButton>
        </Row>
        <Row label="地震情報（震源情報・遠地地震）" description="ピアノ2音 G4→B4（控えめ）">
          <TestButton color="blue" onClick={() => { unlockAudio(); playAlertSound('earthquakeInfo') }}>▶ 試聴</TestButton>
        </Row>
        {/* ── 津波情報 ── */}
        <Row label="津波予報（若干の海面変動）" description="sine 380→460Hz スイープ × 2回">
          <TestButton color="blue" onClick={() => { unlockAudio(); playAlertSound('tsunamiForecast') }}>▶ 試聴</TestButton>
        </Row>
        <Row label="津波注意報" description="sine 300→500Hz スイープ × 2回">
          <TestButton color="blue" onClick={() => { unlockAudio(); playAlertSound('tsunamiWatch') }}>▶ 試聴</TestButton>
        </Row>
        <Row label="津波警報" description="sawtooth 260→560Hz スイープ × 3回">
          <TestButton color="purple" onClick={() => { unlockAudio(); playAlertSound('tsunami') }}>▶ 試聴</TestButton>
        </Row>
        <Row label="大津波警報" description="sawtooth 200→500Hz スイープ × 5回">
          <TestButton color="red" onClick={() => { unlockAudio(); playAlertSound('tsunamiMajor') }}>▶ 試聴</TestButton>
        </Row>
        <Row label="津波情報更新（グレード不変）" description="ding 低音 → 高音（穏やかな通知）">
          <TestButton color="blue" onClick={() => { unlockAudio(); playAlertSound('tsunamiUpdate') }}>▶ 試聴</TestButton>
        </Row>
        <Row label="津波解除・取消・期限切れ" description="ピアノ G4→C4 の終止形（3 つの理由を単一音で伝える）">
          <TestButton color="blue" onClick={() => { unlockAudio(); playAlertSound('tsunamiCancel') }}>▶ 試聴</TestButton>
        </Row>
        {/* ── 臨時情報・関連解説情報・後発地震 ── */}
        {isDmdss && (
          <Row label="南海トラフ臨時情報・後発地震注意情報" description="ピアノA4×2連打 → D5">
            <TestButton color="orange" onClick={() => { unlockAudio(); playAlertSound('specialInfo') }}>▶ 試聴</TestButton>
          </Row>
        )}
        {isDmdss && (
          <Row label="南海トラフ関連解説情報" description="ピアノ下降2音 D5→A4（臨時情報の上昇と向きで区別）">
            <TestButton color="teal" onClick={() => { unlockAudio(); playAlertSound('specialInfoCommentary') }}>▶ 試聴</TestButton>
          </Row>
        )}
      </Section>

      <Section title="テスト機能">
        <div className="px-4 py-2 bg-yellow-900/30 border-b border-yellow-700/40">
          <p className="text-yellow-400 text-xs">動作確認用です。実際のデータは変更されません。</p>
        </div>
        {/* ── 緊急地震速報（EEW）: 軽 → 重、取消は末尾 ── */}
        <Row label="地震動予報" description="震度4程度（予報域） – eewForecast 音 / 10秒以内に再度押すと続報、押さなければ最終報確定→無音で自動解除（数分後）">
          <TestButton color="yellow" onClick={onTest.eewForecast}>予報テスト</TestButton>
        </Row>
        <Row label="地震動予報（単独点処理）" description="1観測点のみで検知した震源未確定の初報（日向灘・仮定値 M5.0 深さ10km） – eewForecast 音 / 地域別予想が載らないため「単独点処理のため、予想震度なし。」を待たずに読み上げ。10秒以内に再度押すと震源確定＋震度5強予想の警報へ格上げ（eew 音）。格上げの伝え方は押すタイミングで変わる（読み上げ中に押すと割り込んで言い直し）。押さなくても最終報が確定震源になるため同じ格上げが起きる→無音で自動解除（数分後）">
          <TestButton color="yellow" onClick={onTest.eewAssumed}>単独点処理テスト</TestButton>
        </Row>
        <Row label="地震動予報（深発地震）" description="深さ450km（小笠原諸島西方沖 M6.5） – eewForecast 音 / 深発地震には地域別の震度予想が発表されないため「深発地震のため、予想震度なし。」を待たずに読み上げ。気象庁は深さ150km超に警報を出さないため続報も予報級のまま / 10秒以内に再度押すと続報、押さなければ最終報確定→無音で自動解除（数分後）">
          <TestButton color="yellow" onClick={onTest.eewDeep}>深発地震テスト</TestButton>
        </Row>
        <Row label="緊急地震速報（警報）" description="震度5強相当 – eew 音 / 10秒以内に再度押すと続報、押さなければ最終報確定→無音で自動解除（数分後）">
          <TestButton color="orange" onClick={onTest.eewWarning}>警報テスト</TestButton>
        </Row>
        <Row label="緊急地震速報（特別警報）" description="震度6強 – eewSpecial 音 / 10秒以内に再度押すと続報、押さなければ最終報確定→無音で自動解除（数分後）">
          <TestButton color="red" onClick={onTest.eew}>特別警報テスト</TestButton>
        </Row>
        <Row label="緊急地震速報（誤報取消）" description="警報相当（日向灘 M6.5） – eewCancel 音 / 10秒後に誤報として取消（音・通知・読み上げあり）">
          <TestButton color="purple" onClick={onTest.eewRetraction}>誤報取消テスト</TestButton>
        </Row>
        {/* ── 地震情報 ── */}
        <Row label="地震情報" description="令和6年能登半島地震・本震 M7.6 最大震度7（実データ）をリストと地図に追加">
          <TestButton color="red" onClick={onTest.earthquake}>地震テスト</TestButton>
        </Row>
        <Row label="遠地地震" description="メキシコ・チアパス州沿岸 M7.4 深さ不明（実データ）– earthquakeInfo 音 / 国内震度なし・日本への津波影響なし">
          <TestButton color="purple" onClick={onTest.foreignQuake}>遠地地震テスト</TestButton>
        </Row>
        {/* ── 津波情報: 軽 → 重、取消は末尾 ── */}
        <Row label="津波予報（若干の海面変動）" description={`北海道沿岸 – tsunamiForecast 音 / 90秒後に${isDmdss ? '有効期間終了' : '解除（standard 版は有効期限を持たないため解除電文で消える）'}`}>
          <TestButton color="blue" onClick={onTest.tsunamiForecast}>予報テスト</TestButton>
        </Row>
        <Row label="津波警報（注意報）" description="北海道沿岸 – tsunamiWatch 音 / 90秒後に解除">
          <TestButton color="blue" onClick={onTest.tsunamiWatch}>注意報テスト</TestButton>
        </Row>
        <Row label="津波警報（津波警報）" description="青森・茨城等 – tsunami 音 / 90秒後に解除">
          <TestButton color="orange" onClick={onTest.tsunamiWarning}>警報テスト</TestButton>
        </Row>
        <Row label="津波警報（大津波警報）" description="岩手・宮城・福島等 – tsunamiMajor 音 / 90秒後に解除">
          <TestButton color="purple" onClick={onTest.tsunami}>大警報テスト</TestButton>
        </Row>
        <Row label="津波警報（誤報取消）" description={`青森・北海道等 – tsunami 音 / 90秒後に${isDmdss ? '誤報として取消' : '解除（standard 版は取消と解除を区別できないため「解除」表示）'}`}>
          <TestButton color="red" onClick={onTest.tsunamiRetraction}>誤報取消テスト</TestButton>
        </Row>
        {/* ── 臨時情報・関連解説情報・後発地震 ── */}
        {isDmdss && onTest.nankaiChecking && (
          <Row label="南海トラフ臨時情報（調査中）" description="バナー表示 + specialInfo 音（バナー消去ボタンなし・再テストで上書き）">
            <TestButton color="yellow" onClick={onTest.nankaiChecking}>調査中テスト</TestButton>
          </Row>
        )}
        {isDmdss && onTest.nankaiWatch && (
          <Row label="南海トラフ臨時情報（巨大地震注意）" description="バナー表示 + specialInfo 音">
            <TestButton color="orange" onClick={onTest.nankaiWatch}>注意テスト</TestButton>
          </Row>
        )}
        {isDmdss && onTest.nankaiWarning && (
          <Row label="南海トラフ臨時情報（巨大地震警戒）" description="バナー表示 + specialInfo 音">
            <TestButton color="red" onClick={onTest.nankaiWarning}>警戒テスト</TestButton>
          </Row>
        )}
        {isDmdss && onTest.nankaiCommentaryAdHoc && (
          <Row label="南海トラフ関連解説情報（臨時解説）" description="バナー表示 + specialInfoCommentary 音（閉じるボタンあり・7日で自動消去）">
            <TestButton color="teal" onClick={onTest.nankaiCommentaryAdHoc}>臨時解説テスト</TestButton>
          </Row>
        )}
        {isDmdss && onTest.nankaiCommentaryRoutine && (
          <Row label="南海トラフ関連解説情報（定例解説）" description="平常時に毎月届く電文。バナー表示 + specialInfoCommentary 音（閉じるボタンあり・7日で自動消去）">
            <TestButton color="teal" onClick={onTest.nankaiCommentaryRoutine}>定例解説テスト</TestButton>
          </Row>
        )}
        {isDmdss && onTest.kohatsu && (
          <Row label="北海道・三陸沖後発地震注意情報" description="バナー表示 + specialInfo 音">
            <TestButton color="blue" onClick={onTest.kohatsu}>後発地震テスト</TestButton>
          </Row>
        )}
        {/* ── その他 ── */}
        <Row label="ブラウザ通知" description="テスト通知を即時送信（要通知許可）">
          <TestButton color="green" onClick={onTest.notification}>通知テスト</TestButton>
        </Row>
      </Section>

      <Section title="実地震テスト">
        <div className="px-4 py-2 bg-yellow-900/30 border-b border-yellow-700/40">
          <p className="text-yellow-400 text-xs">実際に発生した地震の電文データを、発生時と同じ間隔で再生します。動作確認用です。</p>
        </div>
        {scenarioTest.loadState === 'error' && (
          <Row label="シナリオ一覧の取得に失敗しました" />
        )}
        {scenarioTest.loadState === 'loaded' && scenarioTest.scenarios.length === 0 && (
          <Row label="利用可能なシナリオがありません" />
        )}
        {scenarioTest.scenarios.map(s => {
          const playing = scenarioTest.playingIds.has(s.id)
          const failed = scenarioTest.errorIds.has(s.id)
          return (
            <Row
              key={s.id}
              label={s.label}
              description={failed ? `${s.description}（取得に失敗しました。再度押すとリトライします）` : s.description}
            >
              <TestButton
                color={failed ? 'red' : SCENARIO_CATEGORY_COLOR[s.category]}
                disabled={playing}
                onClick={() => scenarioTest.play(s.id)}
              >
                {playing ? '再生中…' : failed ? '再試行' : '再生'}
              </TestButton>
            </Row>
          )
        })}
      </Section>

      <Section title="テスト時刻設定">
        <div className="px-4 py-2 bg-blue-900/30 border-b border-blue-700/40">
          <p className="text-blue-300 text-xs">
            指定した日時の地震情報・津波を再生します（{isDmdss ? '2020年4月' : '2015年'}以降）。
            リアルタイム震度は直近の期間と、下記の地震でのみ再生できます。
          </p>
        </div>
        {historicalArchives != null && historicalArchives.length > 0 && (
          <Row
            label="収録済みの地震"
            description="ここから再生すると地震情報・津波は再現されますが、リアルタイム震度は含まれません。必要な場合は下記の「K-NETデータの取り込み」から読み込んでください。"
          >
            <div className="flex flex-col gap-1.5 items-end">
              {historicalArchives.map(a => (
                <div key={a.id} className="flex items-center gap-2">
                  <DescriptionTip
                    label={a.label}
                    description={`${new Date(a.from).toLocaleString('ja-JP')} 〜 ${new Date(a.to).toLocaleString('ja-JP')}`}
                  />
                  <button
                    onClick={() => onStartReplay(new Date(new Date(a.firstEventTime).getTime() - 60_000))}
                    disabled={replayIsFetching || historicalArchivesLoading}
                    className="text-xs bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white px-2 py-1 rounded transition-colors whitespace-nowrap"
                  >
                    再生
                  </button>
                </div>
              ))}
            </div>
          </Row>
        )}
        <Row label="開始時刻" description="確定すると指定時刻から1秒ずつ進みます">
          <div className="flex gap-2 items-center flex-wrap justify-end">
            <input
              type="datetime-local"
              value={kyoshinInputDateTime}
              onChange={e => onSetKyoshinInputDateTime(e.target.value)}
              className="bg-panel border border-border text-white text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={handleTimeConfirm}
              disabled={!kyoshinInputDateTime || replayIsFetching || historicalArchivesLoading}
              className="text-xs bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white px-3 py-1.5 rounded transition-colors"
            >
              {replayIsFetching ? '取得中...' : historicalArchivesLoading ? '準備中...' : '確定'}
            </button>
          </div>
        </Row>
        {replayError && (
          // 再生が始まっていれば「再生中に起きたこと」（部分的な取りこぼし、先読みの失敗）、
          // 始まっていなければ取得そのものの失敗。同じ赤字でも、再生中に「取得失敗」と
          // 大書きすると本文の「継続中」と矛盾して見える。深刻度の差は本文で伝える。
          <Row label={replayStartLabel != null ? '再生中の警告' : '取得失敗'}>
            <span className="text-xs text-red-400 break-all">{replayError}</span>
          </Row>
        )}
        {replayStartLabel != null && (
          <Row label="再生中">
            <div className="flex gap-2 items-center">
              <span className="text-xs text-green-400">{replayStartLabel} から</span>
              <button
                onClick={onStopReplay}
                className="text-xs bg-gray-600 hover:bg-gray-500 text-white px-3 py-1.5 rounded transition-colors"
              >
                リセット
              </button>
            </div>
          </Row>
        )}
      </Section>

      <Section title="K-NETデータの取り込み">
        <Row
          label="地震波形データを読み込む"
          description="防災科研（NIED）のサイトからダウンロードしたK-NET/KiK-netの地震波形ファイル（ZIP）を選ぶと、その地震の揺れを「リアルタイム震度」タブで再生できるようになります。複数のファイルをまとめて選ぶと、1つの地震としてまとめて読み込まれます。データはこの端末だけに保存され、外部には送信されません。"
          hint="上の地震一覧にある地震のみ読み込めます"
        >
          <KyoshinImportRow historicalArchives={historicalArchives ?? EMPTY_HISTORICAL_ARCHIVES} />
        </Row>
      </Section>

      <Section title="診断ログ">
        <Row
          label="揺れ検知の記録"
          description="揺れ検知が走ったとき、その前後 30 秒の観測値・検知の内訳・学習状態を端末内に残します。地震でないのに検知した場合、この記録があれば原因を追えます。書き出すまで端末の外へは出ません。"
        >
          <DiagnosticLogRow />
        </Row>
      </Section>

      <Section title="このアプリについて">
        <Row label="バージョン"><span className="text-xs text-secondary">{__APP_VERSION__}</span></Row>
        <CreditRow label="地震・津波データ">
          {isDmdss ? (
            <a href="https://dmdata.jp/" target="_blank" rel="noopener noreferrer"
              className="text-xs text-blue-400 hover:text-blue-300">
              Project DM-D.S.S
            </a>
          ) : (
            <a href="https://www.p2pquake.net/" target="_blank" rel="noopener noreferrer"
              className="text-xs text-blue-400 hover:text-blue-300">
              P2PQuake API v2
            </a>
          )}
        </CreditRow>
        <CreditRow label="リアルタイム震度">
          <a href="https://www.kmoni.bosai.go.jp/" target="_blank" rel="noopener noreferrer"
            className="text-xs text-blue-400 hover:text-blue-300">
            防災科研 強震モニタ
          </a>
        </CreditRow>
        <CreditRow label="地図">
          <span className="text-xs text-secondary">
            国土数値情報（行政区域）国土交通省 / Natural Earth
          </span>
        </CreditRow>
        <Row label="サーバー時刻オフセット" description="Yahoo 強震モニタ経由でサーバー時刻に較正した際の壁時計との差分（診断用）。「未較正」は Yahoo 到達不能などで較正が動いていないことを示す">
          <ServerClockOffsetDisplay />
        </Row>
      </Section>

      <Section title="震度スケール">
        <div className="px-4 py-3 flex flex-wrap gap-2">
          {Object.entries(INTENSITY_LABELS)
            .filter(([k]) => k !== '-1')
            .map(([scale, label]) => {
              const fill = getIntensityColor(Number(scale))
              return (
                <div key={scale} className="flex items-center gap-1.5">
                  <span
                    className="w-6 h-6 rounded flex items-center justify-center text-xs font-bold"
                    style={{ backgroundColor: fill, color: readableTextColor(fill) }}
                  >
                    {label}
                  </span>
                  <span className="text-xs text-secondary">震度{label}</span>
                </div>
              )
            })}
        </div>
      </Section>

    </div>
  )
})
