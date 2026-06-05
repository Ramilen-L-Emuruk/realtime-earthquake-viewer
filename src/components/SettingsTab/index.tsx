import { useState, useCallback } from 'react'
import type { AppSettings } from '../../hooks/useSettings'
import { getIntensityLabel, getIntensityColor, INTENSITY_LABELS } from '../../utils/intensity'

export interface TestFunctions {
  earthquake: () => void
  eew: () => void
  tsunami: () => void
  notification: () => void
}

interface Props {
  settings: AppSettings
  onUpdate: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void
  onTest: TestFunctions
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

type ButtonColor = 'red' | 'orange' | 'purple' | 'blue' | 'green'

const BUTTON_CLASSES: Record<ButtonColor, string> = {
  red:    'bg-red-700 hover:bg-red-600',
  orange: 'bg-orange-700 hover:bg-orange-600',
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

export function SettingsTab({ settings, onUpdate, onTest }: Props) {
  return (
    <div className="flex-1 overflow-y-auto p-3">

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
        <Row label="リスト表示件数">
          <select
            value={settings.maxEarthquakeList}
            onChange={e => onUpdate('maxEarthquakeList', Number(e.target.value))}
            className="bg-panel border border-border text-white text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
          >
            {[10, 20, 30, 50].map(n => <option key={n} value={n}>{n}件</option>)}
          </select>
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
      </Section>

      <Section title="通知設定">
        <Row label="通知音" description="地震・緊急地震速報・津波の受信時に音を鳴らします">
          <Toggle
            checked={settings.soundEnabled}
            onChange={v => onUpdate('soundEnabled', v)}
          />
        </Row>
        <Row label="ブラウザ通知" description="地震発生時にブラウザ通知を表示します">
          <Toggle
            checked={settings.notifyMinScale >= 0}
            onChange={v => onUpdate('notifyMinScale', v ? 40 : -1)}
          />
        </Row>
        {settings.notifyMinScale >= 0 && (
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
        )}
        <Row label="通知許可" description="ブラウザの通知権限を確認・許可します">
          <NotificationPermissionButton />
        </Row>
      </Section>

      <Section title="テスト機能">
        <div className="px-4 py-2 bg-yellow-900/30 border-b border-yellow-700/40">
          <p className="text-yellow-400 text-xs">⚠️ 動作確認用です。実際のデータは変更されません。</p>
        </div>
        <Row label="地震情報" description="東京都 M5.5 震度4 をリストと地図に追加">
          <TestButton color="red" onClick={onTest.earthquake}>地震テスト</TestButton>
        </Row>
        <Row label="緊急地震速報" description="EEW バナーを10秒間表示">
          <TestButton color="orange" onClick={onTest.eew}>EEW テスト</TestButton>
        </Row>
        <Row label="津波警報" description="津波注意報（相模湾）を15秒間表示">
          <TestButton color="purple" onClick={onTest.tsunami}>津波テスト</TestButton>
        </Row>
        <Row label="ブラウザ通知" description="テスト通知を即時送信（要通知許可）">
          <TestButton color="green" onClick={onTest.notification}>通知テスト</TestButton>
        </Row>
      </Section>

      <Section title="このアプリについて">
        <Row label="バージョン"><span className="text-xs text-secondary">1.0.0</span></Row>
        <Row label="地震・津波データ">
          <a href="https://www.p2pquake.net/" target="_blank" rel="noopener noreferrer"
            className="text-xs text-blue-400 hover:text-blue-300">
            P2PQuake API v2
          </a>
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
