import { useCallback, useState } from 'react'
import { log } from '../utils/logger'
import { isDmdss } from '../utils/env'

// アイドル復帰時に戻すデフォルトタブの選択肢（津波情報・設定は対象外）
export type DefaultTabSetting = 'earthquake' | 'realtime'

export interface AppSettings {
  minDisplayScale: number   // 最低表示震度 (-1 = すべて)
  notifyMinScale: number    // 通知最低震度 (-1 = 通知しない)
  soundEnabled: boolean     // 地震・EEW・津波の受信時に音を鳴らす
  soundVolume: number       // 通知音・VOICEVOX 読み上げ共通の全体音量 (0.0 〜 1.0)
  uiScale: number           // UI 倍率 (1 = 100%)
  mapIconScale: number      // 地図アイコンの倍率 (1 = 100%、UI 倍率とは独立)
  showBathymetry: boolean   // 背景に海底地形（ESRI Ocean）を表示する
  showActiveFaults: boolean // 地震情報・リアルタイムタブの地図に活断層線を表示する
  activeFaultOpacity: number // 活断層線の不透明度（濃さ、0.05〜1.0）
  showQuakeHeatmap: boolean // 地震情報・リアルタイムタブの地図に直近1ヶ月の地震活動ヒートマップを表示する
  showPlateBoundaries: boolean // 地震情報・リアルタイムタブの地図にプレート境界線を表示する
  defaultTab: DefaultTabSetting    // 起動時・アイドル復帰時に表示するタブ
  tsunamiPriorityDefault: boolean  // 津波発表中はデフォルトタブを津波情報にする
  tsunamiTitleTemporary: boolean   // ウィンドウタイトルの津波表示を受信後一定時間のみにする（false = 発表中ずっと表示）
  idleRevertSec: number            // 操作なしでデフォルトタブへ戻るまでの秒数 (0 = 無効)
  periodicReloadHours: number      // 定期自動リロード（0 = 無効、1以上 = 毎日午前5時に実行）
  notifyEEW: boolean               // 緊急地震速報の発報・昇格時にブラウザ通知を送る
  notifyTsunami: boolean           // 津波注意報以上が発表されたときにブラウザ通知を送る
  notifyDetection: boolean         // 強震モニタの揺れ検知時にブラウザ通知を送る
  homeLat: number | null           // ホーム地点 緯度（null = 未設定）
  homeLng: number | null           // ホーム地点 経度（null = 未設定）
  dmdataApiKey: string             // DMDATA.JP APIキー（DMDSS版のみ使用、空文字 = 未設定）
  dmdataTestDelivery: boolean      // 試験報・訓練報（EEW配信テスト VXSE42 等）を受信する（DMDSS版・検証用）
  voicevoxEnabled: boolean         // VOICEVOX 読み上げを有効にする
  voicevoxUrl: string              // VOICEVOX の HTTP API ベース URL
  voicevoxSpeakerId: number        // VOICEVOX 話者 ID
  ttsIntensityLevels: number       // 読み上げる震度階数（最大震度から何階級分。0 = 最大震度のみ）
  ttsMaxRegions: number            // 読み上げる最大地域数（0 = 無制限）
  panelRatio: number               // 縦積みレイアウト（スマホ縦など）でのパネル高さ比率（0.2〜0.8）
}

// パネル高さ比率の可動範囲。境界のつまみをドラッグしたときのクランプ幅と、
// localStorage 復元時の sanitize で同じ値を使う（UI とストレージで範囲がずれないようにする）。
export const PANEL_RATIO_MIN = 0.2
export const PANEL_RATIO_MAX = 0.8

// 通常版とDMDSS版の設定を localStorage 上で分離する
const STORAGE_KEY = isDmdss
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
  showActiveFaults: true,
  activeFaultOpacity: 0.4,
  showQuakeHeatmap: false,
  showPlateBoundaries: true,
  defaultTab: 'earthquake',
  tsunamiPriorityDefault: true,
  tsunamiTitleTemporary: false,
  idleRevertSec: 30,
  periodicReloadHours: 1,
  notifyEEW: true,
  notifyTsunami: true,
  notifyDetection: false,
  homeLat: null,
  homeLng: null,
  dmdataApiKey: '',
  dmdataTestDelivery: false,
  voicevoxEnabled: false,
  voicevoxUrl: 'http://localhost:50021',
  voicevoxSpeakerId: 0,
  ttsIntensityLevels: 2,
  ttsMaxRegions: 10,
  panelRatio: 0.45,
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function ensureBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function ensureString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function ensureDefaultTab(value: unknown, fallback: DefaultTabSetting): DefaultTabSetting {
  return value === 'earthquake' || value === 'realtime' ? value : fallback
}

function clampNumberOrNull(value: unknown, min: number, max: number): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(max, Math.max(min, value))
}

// 壊れた JSON・型不一致・範囲外の値は既定値に落とす（不正な localStorage で App がクラッシュしない
// ようにするための境界防御。ここでは意味的な妥当性までは検証せず、型と範囲だけを担保する）。
// export はテスト向け（ランタイムからは load() 経由でのみ使う）。
export function sanitize(partial: Partial<AppSettings>): AppSettings {
  return {
    minDisplayScale: clampNumber(partial.minDisplayScale, -1, 70, DEFAULTS.minDisplayScale),
    notifyMinScale: clampNumber(partial.notifyMinScale, -1, 70, DEFAULTS.notifyMinScale),
    soundEnabled: ensureBool(partial.soundEnabled, DEFAULTS.soundEnabled),
    soundVolume: clampNumber(partial.soundVolume, 0, 1, DEFAULTS.soundVolume),
    uiScale: clampNumber(partial.uiScale, 0.5, 3, DEFAULTS.uiScale),
    mapIconScale: clampNumber(partial.mapIconScale, 0.5, 3, DEFAULTS.mapIconScale),
    showBathymetry: ensureBool(partial.showBathymetry, DEFAULTS.showBathymetry),
    showActiveFaults: ensureBool(partial.showActiveFaults, DEFAULTS.showActiveFaults),
    activeFaultOpacity: clampNumber(partial.activeFaultOpacity, 0.05, 1, DEFAULTS.activeFaultOpacity),
    showQuakeHeatmap: ensureBool(partial.showQuakeHeatmap, DEFAULTS.showQuakeHeatmap),
    showPlateBoundaries: ensureBool(partial.showPlateBoundaries, DEFAULTS.showPlateBoundaries),
    defaultTab: ensureDefaultTab(partial.defaultTab, DEFAULTS.defaultTab),
    tsunamiPriorityDefault: ensureBool(partial.tsunamiPriorityDefault, DEFAULTS.tsunamiPriorityDefault),
    tsunamiTitleTemporary: ensureBool(partial.tsunamiTitleTemporary, DEFAULTS.tsunamiTitleTemporary),
    idleRevertSec: clampNumber(partial.idleRevertSec, 0, 3600, DEFAULTS.idleRevertSec),
    periodicReloadHours: clampNumber(partial.periodicReloadHours, 0, 168, DEFAULTS.periodicReloadHours),
    notifyEEW: ensureBool(partial.notifyEEW, DEFAULTS.notifyEEW),
    notifyTsunami: ensureBool(partial.notifyTsunami, DEFAULTS.notifyTsunami),
    notifyDetection: ensureBool(partial.notifyDetection, DEFAULTS.notifyDetection),
    homeLat: clampNumberOrNull(partial.homeLat, -90, 90),
    homeLng: clampNumberOrNull(partial.homeLng, -180, 180),
    dmdataApiKey: ensureString(partial.dmdataApiKey, DEFAULTS.dmdataApiKey),
    dmdataTestDelivery: ensureBool(partial.dmdataTestDelivery, DEFAULTS.dmdataTestDelivery),
    voicevoxEnabled: ensureBool(partial.voicevoxEnabled, DEFAULTS.voicevoxEnabled),
    voicevoxUrl: ensureString(partial.voicevoxUrl, DEFAULTS.voicevoxUrl),
    voicevoxSpeakerId: clampNumber(partial.voicevoxSpeakerId, 0, 100000, DEFAULTS.voicevoxSpeakerId),
    ttsIntensityLevels: clampNumber(partial.ttsIntensityLevels, 0, 10, DEFAULTS.ttsIntensityLevels),
    ttsMaxRegions: clampNumber(partial.ttsMaxRegions, 0, 100, DEFAULTS.ttsMaxRegions),
    panelRatio: clampNumber(partial.panelRatio, PANEL_RATIO_MIN, PANEL_RATIO_MAX, DEFAULTS.panelRatio),
  }
}

// export はテスト向け（ランタイムからは useSettings 内でのみ使う）。
export function load(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') {
      log.warn('[settings] localStorage の値が object でないため既定値で復旧', { key: STORAGE_KEY })
      return DEFAULTS
    }
    return sanitize(parsed as Partial<AppSettings>)
  } catch (e) {
    log.warn('[settings] localStorage の読み込みに失敗、既定値で復旧', e)
    return DEFAULTS
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(load)

  // useCallback で参照を安定化する（React.memo 化された SettingsTab へ props として
  // 渡されるため、毎レンダー新関数だと memo が破られる）。
  const updateSetting = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch (e) {
        // 容量超過・プライベートブラウジング等で保存できないケース。state には反映するので
        // 操作自体は効くが、次回の起動時には既定値へ戻る。無言だと「設定が勝手に戻る」
        // 症状の原因を追えないため、読み込み側（load）と同じくログには残す。
        log.warn('[settings] localStorage への保存に失敗（この変更は次回起動時に失われる）', e)
      }
      return next
    })
  }, [])

  return { settings, updateSetting }
}
