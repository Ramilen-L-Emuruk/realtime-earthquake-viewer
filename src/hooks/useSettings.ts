import { useState } from 'react'

export interface AppSettings {
  minDisplayScale: number   // 最低表示震度 (-1 = すべて)
  notifyMinScale: number    // 通知最低震度 (-1 = 通知しない)
  maxEarthquakeList: number // リスト表示件数
  webhookServerUrl: string  // HA Webhook サーバー URL
}

const STORAGE_KEY = 'quake-viewer-settings'

const DEFAULTS: AppSettings = {
  minDisplayScale: -1,
  notifyMinScale: -1,
  maxEarthquakeList: 20,
  webhookServerUrl: 'http://localhost:3001',
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
