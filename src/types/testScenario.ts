import type { ReplayPayload } from './replay'

// UI表示のグルーピング・ボタン色分けに使う分類
export type ScenarioCategory =
  | 'eew-special' | 'eew-warning' | 'eew-forecast'
  | 'quake' | 'tsunami' | 'lpgm' | 'foreign'

// index.json 1件分・シナリオ本体のヘッダ部分を兼ねる
export interface TestScenarioMeta {
  id: string            // ファイル名（拡張子なし）と一致させる
  label: string          // ボタン隣のラベル
  description: string    // 震源要素・最大震度・津波有無などの短い要約
  category: ScenarioCategory
  durationMs: number     // 最後のエントリの offsetMs（UI・再有効化タイマーに使用）
}

export interface TestScenarioEntry {
  // シナリオ内で最初のエントリを 0 とした相対オフセット(ms)。再生時は「今」を基準に加算する。
  offsetMs: number
  payload: ReplayPayload
  silent?: boolean
}

export interface TestScenarioFile extends TestScenarioMeta {
  // キャプチャ時点での先頭エントリ(offsetMs:0)の絶対時刻(ISO)。
  // 再生時、イベント内部の時刻フィールドを「今 - baseTime」の差分だけシフトするための基準点。
  baseTime: string
  entries: TestScenarioEntry[]
}

export type TestScenarioIndex = TestScenarioMeta[]
