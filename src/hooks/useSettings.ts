import { useCallback, useRef, useState } from 'react'
import { log } from '../utils/logger'
import { isDmdss } from '../utils/env'
import { isValidIntensityScale } from '../utils/intensity'

// アイドル復帰時に戻すデフォルトタブの選択肢（津波情報・設定は対象外）
export type DefaultTabSetting = 'earthquake' | 'realtime'

export interface AppSettings {
  minDisplayScale: number   // 最低表示震度 (-1 = すべて)
  notifyMinScale: number    // 通知最低震度 (-1 = 通知しない)
  // 地震後の行動チェックリストを出す最低震度 (-1 = 出さない)。ホーム地点を設定していれば
  // その周り（半径 NEARBY_RADIUS_KM）で、していなければ全国のどこかで、この震度に達したら出す
  actionChecklistMinScale: number
  soundEnabled: boolean     // 地震・EEW・津波の受信時に音を鳴らす
  soundVolume: number       // 通知音・VOICEVOX 読み上げ共通の全体音量 (0.0 〜 1.0)
  // 南海トラフ地震関連解説情報（VYSE51/52）の通知音と読み上げを行う。
  // 平常時でも毎月1回は必ず届く電文なので、煩わしいときに個別に切れるようにしている
  // （臨時情報＝段階の発表はこの設定に関わらず鳴る）。soundEnabled / voicevoxEnabled が
  // 無効ならそちらが優先される。
  nankaiCommentaryAlerts: boolean
  uiScale: number           // UI 倍率 (1 = 100%)
  mapIconScale: number      // 地図アイコンの倍率 (1 = 100%、UI 倍率とは独立)
  // 地図を傾けたとき、震源をどれだけ深く見せるか (1 = 実際の深さ)。水平方向は常に実スケール。
  hypocenterDepthScale: number
  showBathymetry: boolean   // 背景に海底地形（GEBCO・NOAA NCEI）を表示する
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
  ttsIntensityLevels: number       // 読み上げる震度階数（最大震度に加えて何階級下まで。0 = 最大震度のみ）
  ttsMaxRegions: number            // 読み上げる最大地域数（0 = 無制限）
  ttsAlwaysReadScale: number       // 階数の設定を超えても読み上げる下限震度 (-1 = 無効)
  ttsRegionTolerance: number       // 最大地域数をこの数まで超える場合は省略せず全地域を読む (0 = 無効)
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
  actionChecklistMinScale: 45,
  soundEnabled: true,
  soundVolume: 1.0,
  nankaiCommentaryAlerts: true,
  uiScale: 1,
  mapIconScale: 1,
  hypocenterDepthScale: 1,
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
  ttsAlwaysReadScale: 30,
  ttsRegionTolerance: 2,
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

// 震度は気象庁の階級値（10/20/30/40/45/50/55/60/70）と、無効を表す -1 しか取らない。
// 範囲だけを見ると 35 のような中間値が通り、設定画面の震度バッジが「不明」になる
// （getIntensityLabel が該当ラベルを持たないため）。判定自体は数値比較で動き続けるので
// 表示だけが壊れて原因を追えない。階級値でなければ既定値へ落とす。
//
// 範囲外の値をクランプせず既定値へ落とすため、notifyMinScale では「震度7以上のみ通知」ではなく
// 「通知しない」（既定 -1）に倒れる。無言で通知が止まると原因を追えないので、値があるのに弾いた
// ときだけログに残す（未設定は初回起動・項目追加時に必ず通るため対象外）。
function ensureIntensityScale(value: unknown, fallback: number, key: string): number {
  if (typeof value === 'number' && isValidIntensityScale(value)) return value
  if (value !== undefined) {
    log.warn(`[settings] ${key} が気象庁の震度階級値でないため既定値（${fallback}）に戻した`, value)
  }
  return fallback
}

function clampNumberOrNull(value: unknown, min: number, max: number): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(max, Math.max(min, value))
}

// 壊れた JSON・型不一致・範囲外の値は既定値に落とす（不正な localStorage で App がクラッシュしない
// ようにするための境界防御。基本は型と範囲だけを担保し、震度を取る項目のみ階級値かどうかまで見る）。
// export はテスト向け（ランタイムからは load() 経由でのみ使う）。
export function sanitize(partial: Partial<AppSettings>): AppSettings {
  return {
    minDisplayScale: ensureIntensityScale(partial.minDisplayScale, DEFAULTS.minDisplayScale, 'minDisplayScale'),
    notifyMinScale: ensureIntensityScale(partial.notifyMinScale, DEFAULTS.notifyMinScale, 'notifyMinScale'),
    actionChecklistMinScale: ensureIntensityScale(partial.actionChecklistMinScale, DEFAULTS.actionChecklistMinScale, 'actionChecklistMinScale'),
    soundEnabled: ensureBool(partial.soundEnabled, DEFAULTS.soundEnabled),
    soundVolume: clampNumber(partial.soundVolume, 0, 1, DEFAULTS.soundVolume),
    nankaiCommentaryAlerts: ensureBool(partial.nankaiCommentaryAlerts, DEFAULTS.nankaiCommentaryAlerts),
    uiScale: clampNumber(partial.uiScale, 0.5, 3, DEFAULTS.uiScale),
    mapIconScale: clampNumber(partial.mapIconScale, 0.5, 3, DEFAULTS.mapIconScale),
    hypocenterDepthScale: clampNumber(partial.hypocenterDepthScale, 1, 20, DEFAULTS.hypocenterDepthScale),
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
    // 地域数は連続量なので、UI の選択肢（最大 20 / 許容 5）を超える値でも表示は破綻しない。
    // sanitize の上限を UI に合わせると選択肢を増やすたび両方直す必要があるため、緩いままにする。
    ttsMaxRegions: clampNumber(partial.ttsMaxRegions, 0, 100, DEFAULTS.ttsMaxRegions),
    ttsAlwaysReadScale: ensureIntensityScale(partial.ttsAlwaysReadScale, DEFAULTS.ttsAlwaysReadScale, 'ttsAlwaysReadScale'),
    ttsRegionTolerance: clampNumber(partial.ttsRegionTolerance, 0, 100, DEFAULTS.ttsRegionTolerance),
    panelRatio: clampNumber(partial.panelRatio, PANEL_RATIO_MIN, PANEL_RATIO_MAX, DEFAULTS.panelRatio),
  }
}

/**
 * dev サーバーで自動投入する API キーを決める（検証のたびに設定タブへ貼り直す手間を省く経路）。
 *
 * 値を渡しているのは vite.config.ts の devApiKeyDefine で、dev サーバー・DMDSS 版・`--host` なし
 * のときだけ define する。ここで重ねて見るのは本番ビルドとテストの 2 つ。
 *   - 本番ビルドでは `DEV` が false に畳まれ、この分岐ごと消える。
 *   - テスト（`MODE === 'test'`）では、vitest が vite.config.ts を読まない独立設定
 *     （vitest.config.ts）なので値がそもそも届かない。届くようになっても `.env.local` を持つ
 *     手元だけテストが落ちないようにする。
 *
 * 判定材料を引数で受けるのはテストのため（実行時は下の devApiKey が実際の値を渡す）。
 */
export function resolveDevApiKey(
  env: { DEV: boolean; MODE: string; DMDATA_API_KEY?: string },
  isDmdssVariant: boolean,
): string | undefined {
  if (!env.DEV || env.MODE === 'test') return undefined
  if (!isDmdssVariant) return undefined
  return env.DMDATA_API_KEY
}

function devApiKey(): string | undefined {
  return resolveDevApiKey(import.meta.env, isDmdss)
}

/**
 * 未設定のときだけ dev の API キーを差し込む。設定タブで手入力した値は踏み潰さない。
 * 差し込むのは state の初期値だけで、localStorage には保存しない（保存側は stripDevApiKey）。
 *
 * export はテスト向け（ランタイムからは load 内でのみ使う）。
 */
export function injectDevApiKey(settings: AppSettings, key: string | undefined): AppSettings {
  if (!key || settings.dmdataApiKey !== '') return settings
  return { ...settings, dmdataApiKey: key }
}

/**
 * localStorage へ書き出す形に整える。dev で自動投入したキーは保存しない。
 *
 * updateSetting は変更対象以外も含めた全項目を毎回保存するため、素通しにすると API キー欄に
 * 触れていなくても注入値が永続化される。そうなると以降は手入力と区別できず（injectDevApiKey は
 * 空でない値を上書きしないため）、`.env.local` を書き換えても反映されないブラウザが残る。
 *
 * export はテスト向け（ランタイムからは useSettings 内でのみ使う）。
 */
export function stripDevApiKey(settings: AppSettings, injectedKey: string | undefined): AppSettings {
  if (!injectedKey || settings.dmdataApiKey !== injectedKey) return settings
  return { ...settings, dmdataApiKey: '' }
}

// export はテスト向け（ランタイムからは useSettings 内でのみ使う）。
export function load(): AppSettings {
  return injectDevApiKey(loadStored(), devApiKey())
}

function loadStored(): AppSettings {
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
  // dev で自動投入した値を保存対象から外すために覚えておく（理由は stripDevApiKey）。
  const injectedApiKey = useRef(devApiKey())

  // useCallback で参照を安定化する（React.memo 化された SettingsTab へ props として
  // 渡されるため、毎レンダー新関数だと memo が破られる）。
  // UI から来る値は、選択肢が限定されているか、型チェックだけで足りる自由入力（URL・API キー）の
  // どちらかなので sanitize を通さない（設定 1 つの変更で全項目を検証し直す必要がない）。
  // localStorage を直接書き換えられた場合は次回起動の load() で正される。
  const updateSetting = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value }
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(stripDevApiKey(next, injectedApiKey.current)))
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
