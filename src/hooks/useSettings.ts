import { useState } from 'react'

// アイドル復帰時に戻すデフォルトタブの選択肢（津波情報・設定は対象外）
export type DefaultTabSetting = 'earthquake' | 'realtime'

export interface AppSettings {
  minDisplayScale: number   // 最低表示震度 (-1 = すべて)
  notifyMinScale: number    // 通知最低震度 (-1 = 通知しない)
  soundEnabled: boolean     // 地震・EEW・津波の受信時に音を鳴らす
  soundVolume: number       // 通知音の全体音量 (0.0 〜 1.0)
  uiScale: number           // UI 倍率 (1 = 100%)
  mapIconScale: number      // 地図アイコンの倍率 (1 = 100%、UI 倍率とは独立)
  showBathymetry: boolean   // 背景に海底地形（ESRI Ocean）を表示する
  defaultTab: DefaultTabSetting    // 起動時・アイドル復帰時に表示するタブ
  tsunamiPriorityDefault: boolean  // 津波発表中はデフォルトタブを津波情報にする
  idleRevertSec: number            // 操作なしでデフォルトタブへ戻るまでの秒数 (0 = 無効)
  periodicReloadHours: number      // 定期自動リロード間隔（時間、0 = 無効）
  notifyEEW: boolean               // 緊急地震速報の発報・昇格時にブラウザ通知を送る
  notifyTsunami: boolean           // 津波注意報以上が発表されたときにブラウザ通知を送る
  notifyDetection: boolean         // 強震モニタの揺れ検知時にブラウザ通知を送る
  homeLat: number | null           // ホーム地点 緯度（null = 未設定）
  homeLng: number | null           // ホーム地点 経度（null = 未設定）
  dmdataApiKey: string             // DMDATA.JP APIキー（DMDSS版のみ使用、空文字 = 未設定）
}

// 通常版とDMDSS版の設定を localStorage 上で分離する
const STORAGE_KEY = import.meta.env.VITE_VARIANT === 'dmdss'
  ? 'quake-viewer-settings-dmdss'
  : 'quake-viewer-settings'

const DEFAULTS: AppSettings = {
  minDisplayScale: -1,
  notifyMinScale: -1,
  soundEnabled: true,
  soundVolume: 1.0,
  uiScale: 1,
  mapIconScale: 1,
  showBathymetry: true,
  defaultTab: 'earthquake',
  tsunamiPriorityDefault: true,
  idleRevertSec: 30,
  periodicReloadHours: 6,
  notifyEEW: true,
  notifyTsunami: true,
  notifyDetection: false,
  homeLat: null,
  homeLng: null,
  dmdataApiKey: '',
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
