import { useState } from 'react'

export interface AppSettings {
  minDisplayScale: number   // 最低表示震度 (-1 = すべて)
  notifyMinScale: number    // 通知最低震度 (-1 = 通知しない)
  maxEarthquakeList: number // リスト表示件数
  webhookServerUrl: string  // HA Webhook サーバー URL
  soundEnabled: boolean     // 地震・EEW・津波の受信時に音を鳴らす
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
