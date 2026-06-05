import { useState } from 'react'

// アイドル復帰時に戻すデフォルトタブの選択肢（津波情報・設定は対象外）
export type DefaultTabSetting = 'earthquake' | 'realtime'

export interface AppSettings {
  minDisplayScale: number   // 最低表示震度 (-1 = すべて)
  notifyMinScale: number    // 通知最低震度 (-1 = 通知しない)
  maxEarthquakeList: number // リスト表示件数
  webhookServerUrl: string  // HA Webhook サーバー URL
  soundEnabled: boolean     // 地震・EEW・津波の受信時に音を鳴らす
  uiScale: number           // UI 倍率 (1 = 100%)
  defaultTab: DefaultTabSetting    // 起動時・アイドル復帰時に表示するタブ
  tsunamiPriorityDefault: boolean  // 津波発表中はデフォルトタブを津波情報にする
  idleRevertSec: number            // 操作なしでデフォルトタブへ戻るまでの秒数 (0 = 無効)
}

const STORAGE_KEY = 'quake-viewer-settings'

const DEFAULTS: AppSettings = {
  minDisplayScale: -1,
  notifyMinScale: -1,
  maxEarthquakeList: 20,
  // 既定では未設定（空）。Home Assistant 連携を使う場合のみ設定画面で URL を指定する。
  // 静的ホスティング（GitHub Pages 等）でローカルサーバーへ無駄に接続しないため。
  webhookServerUrl: '',
  soundEnabled: true,
  uiScale: 1,
  defaultTab: 'earthquake',
  tsunamiPriorityDefault: true,
  idleRevertSec: 30,
}

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppSettings>) }
  } catch {
    return DEFAULTS
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(load)

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch { /* storage full */ }
      return next
    })
  }

  return { settings, updateSetting }
}
