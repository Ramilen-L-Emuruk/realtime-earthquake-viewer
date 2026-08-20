// 強震モニタの秒データに混じる欠測（`MISSING_INDEX_THRESHOLD` 未満・実測は -1）のうち、
// 1〜2 秒で復帰する「瞬断」を表示側で吸収する。
//
// 【なぜ必要か】Yahoo の秒データは、観測点が現に強く揺れている最中でも単発で欠測を返す。表示側は欠測を
// 「震度階級なし」として描かない（`kyoshinIndexToJma` が null を返す）ため、そのまま渡すと震度6強級の
// バッジが 1 秒だけ消えて次の秒で戻る明滅になる。欠測の継続長の実測と `MISSING_HOLD_MS` の決め方は
// `docs/spec/kyoshin-detection-v3-design.md` §25。
//
// 【何をするか】欠測になった点は直前の有効値を `MISSING_HOLD_MS` の間だけ保持し、保持中であることを
// `stale` で示す。保持期間を過ぎたら欠測のまま＝従来どおり消える（数十秒に及ぶ欠測は本物の観測点停止で
// あり、残してはいけない）。
//
// 【保持中をどう見せるか】`stale` を受け取るレイヤーは `MISSING_HOLD_OPACITY` で薄く描き、「そこに点は
// あるが今は値が無い」と分かるようにする。対象は**震度を読める描画物だけ**:
//   - 検知点バッジ（`KyoshinDetectedPointsGL`）… 半透明にする
//   - 震度1以上のドット（`KyoshinPointsGL`）… 半透明にする
//   - 震度0未満のドット（`KyoshinSubThresholdGL`）… **保持はするが薄くしない**。レベル単位で一括描画する
//     カスタム GL レイヤー（非加算合成のため）で、点ごとの不透明度を持たせるには GL 側の作り直しが要る。
//     一方でこの層は「ノイズ床の分布」を見せるものであり、1 点が保持値かどうかを読み取る使い方をしない。
//
// 【判定に入る範囲】保持値は表示の補完だが、`deriveKyoshinView` を通るため音・通知・地域単位発報の入力
// （`candidateMaxIndex` / `confirmedShocks`）にも入る。**これは意図した設計**。欠測を素通しすると、
// 地域の最大震度を担う観測点が 1 秒欠測した瞬間に「揺れが弱まった」と解釈され、復帰時に
// 「再エスカレーション」の更新音が誤って鳴る（`useKyoshinAlerts` の `postPeakMinLevel`）。検知エンジンが
// 欠測を「揺れ 0」と扱わないのと同じ理由で、表示側の最大値も欠測で落とさない。
// 詳細は `docs/spec/kyoshin-detection-spec.md` §8。
//
// 【検知エンジンには渡さない】`kyoshinDetector` には生のインデックスを渡し続ける（App 参照）。
// 欠測判定・慢性ノイズ床の学習を保持値で汚さない。

import { MISSING_INDEX_THRESHOLD } from '../services/kyoshin'

/** 欠測になった点の直前値を保持する上限（データ時刻基準・ms）。 */
export const MISSING_HOLD_MS = 2000

/** 保持中の点を描くときの不透明度（検知点バッジ・震度ドットで共通）。 */
export const MISSING_HOLD_OPACITY = 0.35

/** 保持値が無いことを表す番兵（`MISSING_INDEX_THRESHOLD` 未満の値）。 */
const NO_HELD_VALUE = -1

/** `stepMissingHold` が観測点ごとに持ち越す状態（呼び出し側が ref で保持する）。 */
export interface MissingHoldState {
  /** 観測点ごとの直近の有効インデックス（未取得は `NO_HELD_VALUE`）。 */
  held: number[]
  /** `held[i]` を観測したデータ時刻(ms)（未取得は `-Infinity`）。 */
  heldAtMs: number[]
  /** `held` が属する観測点集合の識別子（Yahoo では siteConfigId）。 */
  sitesKey: string | null
  /** 直近に処理したデータ時刻(ms)。巻き戻りの検出に使う。 */
  lastMs: number
}

/** 表示用インデックスと、その各点が保持値かどうか。 */
export interface HeldIndices {
  /** 欠測を直前値で埋めた表示用インデックス（保持期間を過ぎた欠測は元の値のまま）。 */
  indices: number[]
  /** 現フレームは欠測だが直前値を描いている点のフラグ。`indices` と同じ長さ。 */
  stale: boolean[]
}

export function createMissingHoldState(): MissingHoldState {
  return { held: [], heldAtMs: [], sitesKey: null, lastMs: -Infinity }
}

/**
 * 1 フレーム分の欠測ホールドを進める。
 *
 * 同じフレームを二度渡しても結果は変わらない（有効値は保持値を同じ値で上書きするだけ、欠測は
 * 保持状態を読むだけ）。React の再レンダーや StrictMode の二重実行で崩れないための性質。
 *
 * @param state 呼び出し側が持ち越す状態（**この関数が破壊的に更新する**）
 * @param indices 生のインデックス列（欠測を含む）
 * @param dataTimeMs フレームのデータ時刻(ms)。`NaN`/`Infinity` なら保持の判断ができないため素通しする
 * @param sitesKey `indices` が属する観測点集合の識別子。変化したら保持値を捨てる
 */
export function stepMissingHold(
  state: MissingHoldState,
  indices: readonly number[],
  dataTimeMs: number,
  sitesKey: string | null,
): HeldIndices {
  const passThrough = (): HeldIndices => ({ indices: [...indices], stale: indices.map(() => false) })
  // データ時刻が読めないフレームでは保持期間を計れない。保持も更新もせず素通しする。
  if (!Number.isFinite(dataTimeMs)) return passThrough()

  // 保持値を捨てる条件。観測点集合が変わったとき（位置対応が変わるため、別の場所の震度を
  // 描いてしまう）と、データ時刻が巻き戻ったとき（ライブ⇄リプレイの切替）。同一時刻の再処理は
  // 巻き戻しに数えない——同じフレームが二度渡ってきただけで保持を捨てると、その瞬間だけ
  // 保持中の点が消えて、防ごうとしている明滅そのものを作ってしまう。
  if (sitesKey !== state.sitesKey || indices.length !== state.held.length || dataTimeMs < state.lastMs) {
    state.held = new Array<number>(indices.length).fill(NO_HELD_VALUE)
    state.heldAtMs = new Array<number>(indices.length).fill(-Infinity)
    state.sitesKey = sitesKey
  }
  state.lastMs = dataTimeMs

  const out = new Array<number>(indices.length)
  const stale = new Array<boolean>(indices.length)
  for (let i = 0; i < indices.length; i++) {
    const raw = indices[i] ?? NO_HELD_VALUE
    if (raw >= MISSING_INDEX_THRESHOLD) {
      state.held[i] = raw
      state.heldAtMs[i] = dataTimeMs
      out[i] = raw
      stale[i] = false
      continue
    }
    const held = state.held[i] ?? NO_HELD_VALUE
    const heldAtMs = state.heldAtMs[i] ?? -Infinity
    if (held >= MISSING_INDEX_THRESHOLD && dataTimeMs - heldAtMs <= MISSING_HOLD_MS) {
      out[i] = held
      stale[i] = true
    } else {
      out[i] = raw
      stale[i] = false
    }
  }
  return { indices: out, stale }
}
