// ローカル限定生成の強震モニタ風リプレイデータ（scripts/capture-kyoshin-waveform.ts が生成）。
// NIED K-NET/KiK-netの実波形から気象庁の計測震度アルゴリズムで算出した近似値であり、
// 「本物の強震モニタの記録」ではない（詳細は docs/spec/data-sources-spec.md 参照）。
//
// 出力先（public/data/historical-archives-kyoshin/*.json）はNIEDの再配布禁止規約に触れないよう
// .gitignore 対象で、実行者本人のNIED登録でのみ生成・再生できる。リポジトリには一切含まれない。

export interface LocalKyoshinFrame {
  /** このフレームのデータ時刻（ISO、実際の地震発生当時のUTC時刻）。 */
  time: string
  /** 観測点ごとの震度インデックス(0〜20, kyoshinIndexToJmaと同じ規約)。sitesと同順。欠測は-1。 */
  indices: number[]
}

export interface LocalKyoshinArchive {
  /** 対応する HistoricalArchiveMeta.id（例: "2018-iburi"）。 */
  id: string
  /** 観測点座標（[緯度, 経度]）。インデックスがindicesの位置に対応。 */
  sites: [number, number][]
  /** デバッグ表示用の観測点コード（sitesと同順）。 */
  stationCodes: string[]
  /** 時刻順のフレーム列。 */
  frames: LocalKyoshinFrame[]
}
