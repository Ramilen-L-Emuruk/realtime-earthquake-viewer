import { useState, useCallback } from 'react'
import type { AppSettings } from '../../hooks/useSettings'
import type { ConnectionStatus } from '../../types/earthquake'
import { getIntensityLabel, getIntensityColor, INTENSITY_LABELS } from '../../utils/intensity'
import { playAlertSound, playKyoshinUpdateSound, unlockAudio } from '../../utils/alertSound'

const isDmdss = import.meta.env.VITE_VARIANT === 'dmdss'

export interface TestFunctions {
  earthquake: () => void
  eew: () => void
  eewWarning: () => void
  eewForecast: () => void
  tsunami: () => void
  tsunamiWarning: () => void
  tsunamiWatch: () => void
  notification: () => void
}

interface Props {
  settings: AppSettings
  onUpdate: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  onTest: TestFunctions
  kyoshinTimeOffset: number | null
  onSetKyoshinTimeOffset: (offset: number | null) => void
  kyoshinInputDateTime: string
  onSetKyoshinInputDateTime: (value: string) => void
  dmdataConnectionStatus?: ConnectionStatus
}

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

function Row({ label, description, children }: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className="text-white text-sm">{label}</p>
        {description && <p className="text-secondary text-xs mt-0.5">{description}</p>}
      </div>
      <div className="flex-shrink-0">{children}</div>
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

function ScaleSelect({ value, onChange, noneLabel = 'すべて表示' }: {
  value: number
  onChange: (v: number) => void
  noneLabel?: string
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(Number(e.target.value))}
      className="bg-panel border border-border text-white text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
    >
      <option value={-1}>{noneLabel}</option>
      {SCALE_OPTIONS.map(s => (
        <option key={s} value={s}>震度{getIntensityLabel(s)}以上</option>
      ))}
    </select>
  )
}

function IntensityBadge({ scale }: { scale: number }) {
  if (scale === -1) return null
  return (
    <span
      className="inline-block text-xs font-bold px-1.5 py-0.5 rounded"
      style={{ backgroundColor: getIntensityColor(scale), color: '#fff' }}
    >
      震度{getIntensityLabel(scale)}
    </span>
  )
}

type ButtonColor = 'red' | 'orange' | 'yellow' | 'purple' | 'blue' | 'green'

const BUTTON_CLASSES: Record<ButtonColor, string> = {
  red:    'bg-red-700 hover:bg-red-600',
  orange: 'bg-orange-700 hover:bg-orange-600',
  yellow: 'bg-yellow-600 hover:bg-yellow-500',
  purple: 'bg-purple-700 hover:bg-purple-600',
  blue:   'bg-blue-700 hover:bg-blue-600',
  green:  'bg-green-700 hover:bg-green-600',
}

function TestButton({ color, onClick, children }: {
  color: ButtonColor
  onClick: () => void
  children: React.ReactNode
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
      className={`text-xs text-white px-3 py-1.5 rounded transition-colors ${
        fired ? 'bg-gray-600' : BUTTON_CLASSES[color]
      }`}
    >
      {fired ? '送信済み ✓' : children}
    </button>
  )
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
  return (
    <button
      onClick={handle}
      title={`震度${getIntensityLabel(scale)} の更新音を試聴`}
      className={`text-xs font-bold text-white px-2 py-1 rounded transition-opacity ${active ? 'opacity-40' : 'hover:opacity-75'}`}
      style={{ backgroundColor: getIntensityColor(scale) }}
    >
      {getIntensityLabel(scale)}
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

export function SettingsTab({ settings, onUpdate, onTest, kyoshinTimeOffset, onSetKyoshinTimeOffset, kyoshinInputDateTime, onSetKyoshinInputDateTime, dmdataConnectionStatus }: Props) {
  const handleTimeConfirm = () => {
    if (!kyoshinInputDateTime) return
    const specified = new Date(kyoshinInputDateTime)
    if (isNaN(specified.getTime())) return
    onSetKyoshinTimeOffset(specified.getTime() - Date.now())
  }

  const replayStartLabel = kyoshinTimeOffset != null
    ? new Date(Date.now() + kyoshinTimeOffset).toLocaleString('ja-JP')
    : null

  return (
    <div className="flex-1 overflow-y-auto p-3">

      {isDmdss && (
        <Section title="DM-D.S.S 接続設定">
          <div className="px-4 py-2 bg-yellow-900/30 border-b border-yellow-700/40">
            <p className="text-yellow-400 text-xs">⚠️ APIキーはこのブラウザにのみ保存されます。第三者と共有しないでください。</p>
          </div>
          <Row label="接続状態">
            {dmdataConnectionStatus === 'connected' ? (
              <span className="text-xs text-green-400 font-medium">接続中</span>
            ) : dmdataConnectionStatus === 'connecting' ? (
              <span className="text-xs text-blue-400">接続試行中...</span>
            ) : (
              <span className="text-xs text-secondary">
                {settings.dmdataApiKey ? '切断' : 'APIキー未設定'}
              </span>
            )}
          </Row>
          <Row label="APIキー" description="DMDATA.JP のAPIキーを入力してください">
            <input
              type="password"
              value={settings.dmdataApiKey}
              onChange={e => onUpdate('dmdataApiKey', e.target.value)}
              placeholder="APIキーを入力"
              autoComplete="off"
              className="bg-panel border border-border text-white text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-500 w-48"
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
        <Row label="海底地形を表示" description="背景の海域に海底地形（陰影）を表示します">
          <Toggle
            checked={settings.showBathymetry}
            onChange={v => onUpdate('showBathymetry', v)}
          />
        </Row>
      </Section>

      <Section title="デフォルト表示">
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
        <Row label="定期自動リロード" description="指定した時間ごとに画面を再起動してメモリを解放します（地震・津波・EEW 発報中は延期）">
          <select
            value={settings.periodicReloadHours}
            onChange={e => onUpdate('periodicReloadHours', Number(e.target.value))}
            className="bg-panel border border-border text-white text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
          >
            <option value={0}>無効</option>
            <option value={1}>1時間ごと</option>
            <option value={3}>3時間ごと</option>
            <option value={6}>6時間ごと</option>
            <option value={12}>12時間ごと</option>
            <option value={24}>24時間ごと</option>
          </select>
        </Row>
      </Section>

      <Section title="通知設定">
        <Row label="通知音" description="地震・緊急地震速報・津波の受信時に音を鳴らします">
          <Toggle
            checked={settings.soundEnabled}
            onChange={v => onUpdate('soundEnabled', v)}
          />
        </Row>
        {settings.soundEnabled && (
          <Row label="音量" description="通知音の音量を調整します">
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
            <Row label="EEW 通知" description="緊急地震速報の発報・昇格時に通知（重複送信しない）">
              <Toggle checked={settings.notifyEEW} onChange={v => onUpdate('notifyEEW', v)} />
            </Row>
            <Row label="津波通知" description="津波注意報以上が発表されたときに通知">
              <Toggle checked={settings.notifyTsunami} onChange={v => onUpdate('notifyTsunami', v)} />
            </Row>
            <Row label="揺れ検知通知" description="強震モニタで揺れを検知したときに通知（推定値・頻度高め）">
              <Toggle checked={settings.notifyDetection} onChange={v => onUpdate('notifyDetection', v)} />
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
        {/* ── 揺れ検知 ── */}
        <Row label="揺れ検知（初回）" description="FM ベル 上昇2音">
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
        <Row label="EEW 予報（低震度）" description="FM ベル 下降2音">
          <TestButton color="blue" onClick={() => { unlockAudio(); playAlertSound('eewForecast') }}>▶ 試聴</TestButton>
        </Row>
        <Row label="EEW 初報（警報）" description="3連ビープ + 長音（di-di-di-DAA）">
          <TestButton color="orange" onClick={() => { unlockAudio(); playAlertSound('eew') }}>▶ 試聴</TestButton>
        </Row>
        <Row label="EEW 特別警報" description="上昇スイープ + 高速8連打（震度6弱以上）">
          <TestButton color="red" onClick={() => { unlockAudio(); playAlertSound('eewSpecial') }}>▶ 試聴</TestButton>
        </Row>
        <Row label="EEW 続報" description="FM ベル 短2音">
          <TestButton color="orange" onClick={() => { unlockAudio(); playAlertSound('eewUpdate') }}>▶ 試聴</TestButton>
        </Row>
        <Row label="EEW キャンセル" description="FM ベル 下降3和音">
          <TestButton color="blue" onClick={() => { unlockAudio(); playAlertSound('eewCancel') }}>▶ 試聴</TestButton>
        </Row>
        {/* ── 地震情報 ── */}
        <Row label="地震情報（震度速報）" description="FM ベル 3音">
          <TestButton color="orange" onClick={() => { unlockAudio(); playAlertSound('earthquakePrompt') }}>▶ 試聴</TestButton>
        </Row>
        <Row label="地震情報（震源・震度 / 各地の震度）" description="FM ベル 2音（残響チャイム）">
          <TestButton color="red" onClick={() => { unlockAudio(); playAlertSound('earthquake') }}>▶ 試聴</TestButton>
        </Row>
        <Row label="地震情報（震源情報・遠地地震）" description="FM ベル 単音（控えめ）">
          <TestButton color="blue" onClick={() => { unlockAudio(); playAlertSound('earthquakeInfo') }}>▶ 試聴</TestButton>
        </Row>
        {/* ── 津波情報 ── */}
        <Row label="津波注意報" description="sine 300→500Hz スイープ × 2回">
          <TestButton color="blue" onClick={() => { unlockAudio(); playAlertSound('tsunamiWatch') }}>▶ 試聴</TestButton>
        </Row>
        <Row label="津波警報" description="sawtooth 260→560Hz スイープ × 3回">
          <TestButton color="purple" onClick={() => { unlockAudio(); playAlertSound('tsunami') }}>▶ 試聴</TestButton>
        </Row>
        <Row label="大津波警報" description="sawtooth+sine ダブルスイープ × 5回">
          <TestButton color="red" onClick={() => { unlockAudio(); playAlertSound('tsunamiMajor') }}>▶ 試聴</TestButton>
        </Row>
      </Section>

      <Section title="テスト機能">
        <div className="px-4 py-2 bg-yellow-900/30 border-b border-yellow-700/40">
          <p className="text-yellow-400 text-xs">⚠️ 動作確認用です。実際のデータは変更されません。</p>
        </div>
        <Row label="地震情報" description="三陸沖 M9.0 最大震度7 をリストと地図に追加">
          <TestButton color="red" onClick={onTest.earthquake}>地震テスト</TestButton>
        </Row>
        <Row label="緊急地震速報（特別警報）" description="震度6弱以上 – eewSpecial 音 / 10秒間表示">
          <TestButton color="red" onClick={onTest.eew}>特別警報テスト</TestButton>
        </Row>
        <Row label="緊急地震速報（警報）" description="震度5弱相当 – eew 音 / 10秒間表示">
          <TestButton color="orange" onClick={onTest.eewWarning}>警報テスト</TestButton>
        </Row>
        <Row label="緊急地震速報（予報）" description="震度2程度 – eewForecast 音 / 10秒間表示">
          <TestButton color="yellow" onClick={onTest.eewForecast}>予報テスト</TestButton>
        </Row>
        <Row label="津波警報（大津波警報）" description="岩手・宮城・福島等 – tsunamiMajor 音 / 15秒間表示">
          <TestButton color="purple" onClick={onTest.tsunami}>大警報テスト</TestButton>
        </Row>
        <Row label="津波警報（津波警報）" description="青森・茨城等 – tsunami 音 / 10秒間表示">
          <TestButton color="orange" onClick={onTest.tsunamiWarning}>警報テスト</TestButton>
        </Row>
        <Row label="津波警報（注意報）" description="北海道沿岸 – tsunamiWatch 音 / 10秒間表示">
          <TestButton color="blue" onClick={onTest.tsunamiWatch}>注意報テスト</TestButton>
        </Row>
        <Row label="ブラウザ通知" description="テスト通知を即時送信（要通知許可）">
          <TestButton color="green" onClick={onTest.notification}>通知テスト</TestButton>
        </Row>
      </Section>

      <Section title="テスト時刻設定（強震モニタ）">
        <div className="px-4 py-2 bg-blue-900/30 border-b border-blue-700/40">
          <p className="text-blue-300 text-xs">指定した時刻から強震モニタのデータを再生します。2020年以降のデータを参照できます。</p>
        </div>
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
              disabled={!kyoshinInputDateTime}
              className="text-xs bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white px-3 py-1.5 rounded transition-colors"
            >
              確定
            </button>
          </div>
        </Row>
        {replayStartLabel != null && (
          <Row label="再生中">
            <div className="flex gap-2 items-center">
              <span className="text-xs text-green-400">{replayStartLabel} から</span>
              <button
                onClick={() => onSetKyoshinTimeOffset(null)}
                className="text-xs bg-gray-600 hover:bg-gray-500 text-white px-3 py-1.5 rounded transition-colors"
              >
                リセット
              </button>
            </div>
          </Row>
        )}
      </Section>

      <Section title="ホーム地点">
        <HomeLocationSection
          homeLat={settings.homeLat}
          homeLng={settings.homeLng}
          onUpdate={onUpdate}
        />
      </Section>

      <Section title="このアプリについて">
        <Row label="バージョン"><span className="text-xs text-secondary">3.0.6</span></Row>
        <Row label="地震・津波データ">
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
        </Row>
        <Row label="リアルタイム震度">
          <a href="https://www.kmoni.bosai.go.jp/" target="_blank" rel="noopener noreferrer"
            className="text-xs text-blue-400 hover:text-blue-300">
            防災科研 強震モニタ
          </a>
        </Row>
        <Row label="地図">
          <span className="text-xs text-secondary text-right">
            国土数値情報（行政区域）国土交通省 / Natural Earth
          </span>
        </Row>
      </Section>

      <Section title="震度スケール">
        <div className="px-4 py-3 flex flex-wrap gap-2">
          {Object.entries(INTENSITY_LABELS)
            .filter(([k]) => k !== '-1')
            .map(([scale, label]) => (
              <div key={scale} className="flex items-center gap-1.5">
                <span
                  className="w-6 h-6 rounded flex items-center justify-center text-xs font-bold text-white"
                  style={{ backgroundColor: getIntensityColor(Number(scale)) }}
                >
                  {label}
                </span>
                <span className="text-xs text-secondary">震度{label}</span>
              </div>
            ))}
        </div>
      </Section>

    </div>
  )
}
