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
  periodicReloadHours: number      // 定期自動リロード（0 = 無効、1以上 = 毎日午前5時に実行）
  notifyEEW: boolean               // 緊急地震速報の発報・昇格時にブラウザ通知を送る
  notifyTsunami: boolean           // 津波注意報以上が発表されたときにブラウザ通知を送る
  notifyDetection: boolean         // 強震モニタの揺れ検知時にブラウザ通知を送る
  homeLat: number | null           // ホーム地点 緯度（null = 未設定）
  homeLng: number | null           // ホーム地点 経度（null = 未設定）
  dmdataApiKey: string             // DMDATA.JP APIキー（DMDSS版のみ使用、空文字 = 未設定）
  dmdataTestDelivery: boolean      // 試験報・訓練報（EEW配信テスト VXSE42 等）を受信する（DMDSS版・検証用）
  eewFinalClearSec: number         // EEW最終報受信後に自動解除するまでの秒数（DMDSS版のみ有効）
  voicevoxEnabled: boolean         // VOICEVOX 読み上げを有効にする
  voicevoxUrl: string              // VOICEVOX の HTTP API ベース URL
  voicevoxSpeakerId: number        // VOICEVOX 話者 ID
  ttsIntensityLevels: number       // 読み上げる震度階数（最大震度から何階級分。0 = 最大震度のみ）
  ttsMaxRegions: number            // 読み上げる最大地域数（0 = 無制限）
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
  periodicReloadHours: 1,
  notifyEEW: true,
  notifyTsunami: true,
  notifyDetection: false,
  homeLat: null,
  homeLng: null,
  dmdataApiKey: '',
  dmdataTestDelivery: false,
  eewFinalClearSec: 180,
  voicevoxEnabled: false,
  voicevoxUrl: 'http://localhost:50021',
  voicevoxSpeakerId: 0,
  ttsIntensityLevels: 2,
  ttsMaxRegions: 10,
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
