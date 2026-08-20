import { describe, it, expect } from 'vitest'
import { step, initState, buildStationMeta, PARAMS, type Frame } from './kyoshinDetector'

/**
 * 「立ち上がった後まったく値が動かない（横ばい）」波形で確定できるかの回帰テスト。
 *
 * 背景（2026-07-22 の実地震・愛知県西部・最大震度1）:
 *   当時の検知エンジン（v3.21 系の `useKyoshinDetection`。V3 化で撤去済み）は、観測点の
 *   トリガー判定を「隣接フレームとの差分」で行っていた。震度1〜2級の弱い揺れは
 *   「1度だけ立ち上がって以後は横ばい」という波形になりやすく、2フレーム目には差分が 0 に
 *   なって候補から脱落し、クラスタが再形成されないまま 4 秒で失効していた。
 *   実際に 00:42:46 頃「揺れの可能性」が出たまま確定せず消えている。
 *
 * 現行 V3 は判定方式が異なり（`windowRate` は RATE_DT_MS=2.5 秒の時間窓、`sustained` は
 * 変化率を見ないレベル判定）、構造上この失効は起きない。本ファイルはその性質を固定し、
 * 将来エンジンを作り替えたときに同じ波形で取りこぼさないことを保証する。
 *
 * 実データは Yahoo 強震モニタのリアルタイム震度（観測値のみ。EEW は含まない）。
 */

// ============================================================
// テスト用ヘルパー（既存 kyoshinDetector.test.ts と同じ流儀）
// ============================================================

/** value(計測震度) → インデックス。indexToValue の逆変換。 */
function valueToIndex(value: number): number {
  return Math.round(value * 2 + 6)
}

interface StationDef {
  lat: number
  lng: number
}

/** 中心の周りに 3×3 グリッドの観測点を作る（間隔 0.1° なら全点が相互に R_KM(40km) 近傍）。 */
function grid3x3(centerLat: number, centerLng: number, spacingDeg = 0.1): StationDef[] {
  const out: StationDef[] = []
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      out.push({ lat: centerLat + i * spacingDeg, lng: centerLng + j * spacingDeg })
    }
  }
  return out
}

function sitesOf(defs: StationDef[]): [number, number][] {
  return defs.map((d) => [d.lat, d.lng])
}

// ============================================================
// 実観測データ（2026-07-22 00:42:20〜00:43:20 JST・1Hz・61フレーム）
// ============================================================

/**
 * 震源周辺 ±0.5°（愛知県西部・66観測点）。実際の観測点座標をそのまま使う。
 * 近傍グラフ（R_KM=40km）で 1 連結成分になり、揺れた 7 点の avail は 24〜29。
 * この範囲でも広域（±0.9°・125点）と avail がほぼ一致するため、密度正規化の挙動は変わらない。
 */
const AICHI_SITES: [number, number][] = [
  [35.3, 136.9], [35.1, 137], [35.2, 137.2], [35.2, 137.5], [35.1, 137.6],
  [35.1, 137.1], [35, 137.4], [35, 136.9], [34.9, 137], [35, 137.6],
  [34.8, 137.2], [34.8, 137.4], [34.8, 136.9], [34.7, 137.3], [34.6, 137.1],
  [35.5, 136.9], [35.5, 137.1], [35.5, 137.5], [35.4, 137.4], [35.4, 137],
  [35.4, 137.2], [35.3, 137.4], [35.6, 137.6], [35.5, 137.8], [35.3, 137.9],
  [35.1, 137.8], [34.9, 137.8], [34.7, 137.7], [34.7, 137.5], [35, 137.9],
  [34.9, 137.1], [34.6, 137], [35.2, 137.4], [34.9, 137.3], [34.7, 137.4],
  [35, 137.6], [35.3, 137.1], [34.8, 137.1], [35.2, 136.9], [35.2, 137],
  [35.1, 137.3], [35.2, 137.5], [35.2, 137.7], [35, 137.2], [35, 137.4],
  [34.9, 137.5], [34.7, 136.9], [34.8, 137.4], [35.5, 137.2], [35.6, 137.3],
  [35.4, 136.9], [35.5, 137], [35.5, 137.5], [35.5, 137.7], [35.5, 137.9],
  [35.3, 137.6], [35.6, 137.6], [35.6, 137.9], [35.3, 137.9], [34.9, 137.9],
  [34.8, 137.7], [34.7, 137.6], [34.8, 137.9], [34.7, 137.7], [35.2, 137.9],
  [35, 137.8],
]

/** 00:42:55 以降ずっと続く横ばい値（実データ）。 */
const AICHI_FLAT_TAIL = 'ijjjlljjikiihhghhhihjihhjjiijjigihijiihjkkkkjjhijhiijiijificiiiiii'

/**
 * 各フレームの震度インデックス。Yahoo 強震モニタの生表現をそのまま使う
 * （1文字が1観測点。charCode - 100 がインデックス。'd'=0、'c'=-1 は欠測）。
 * 66 点のうち 1 点（添字59）は全期間 'c'＝欠測を返し続ける実データを含む。
 */
const AICHI_FRAMES = [
  'eddddddehddgdddddddddddddddeededddddddfdddddddddddededddgddcdddedd', // 00:42:20
  'eddddddegddgdddddddddddddddeededddddddfdddddddddddededddgddcdddedd', // 00:42:21
  'eddddddegddgdddddddddddddddeededddddddfdddddddddddededddgddcdddedd', // 00:42:22
  'eddddddefddgdddddddddddddddeededddddddfdddddddddddededddgddcdddedd', // 00:42:23
  'eddddddefddgdddddddddddddddeededddddddfdddddddddddededddgddcdddedd', // 00:42:24
  'eddddddefddgdddddddddddddddeededddddddfdddddddddddededddgddcdddedd', // 00:42:25
  'eddddddefddgdddddddddddddddeededddddddfdddddddddddededddgddcdddedd', // 00:42:26
  'eddddddefddgdddddddddddddddeededddddddfdddddddddddededddgddcdddedd', // 00:42:27
  'eddddddeeddgdddddddddddddddeededddddddfdddddddddddededddgddcdddedd', // 00:42:28
  'eddddddeeddgdddddddddddddddeededddddddfdddddddddddededddgddcdddedd', // 00:42:29
  'eddddddeeddgdddddddddddddddeededddddddfdddddddddddededddgddcdddedd', // 00:42:30
  'eddddddeeddgdddddddddddddddeededddddddfdddddddddddededddgddcdddedd', // 00:42:31
  'eddddddeeddgdddddddddddddddeededddddddfdddddddddddededddgddcdddedd', // 00:42:32
  'eddddddeeddgdddddddddddddddeededddddddfdddddddddddfdedddgddcdddedd', // 00:42:33
  'eddddddeeddgdddddddddddddddeededddddddfdddddddddddgdedddgddcdddedd', // 00:42:34
  'eddddddeeddgdddddddddddddddeededddddddfdddddddddddgdedddgddcdddddd', // 00:42:35
  'eddddddeeddgdddddddddddddddeedfdddddddfdddddddddddhdedddgddcdddddd', // 00:42:36
  'edfgdfdeeddgdddddddddfdddddeedfdhdddddfdjgddddddddhdedddgddcdddddd', // 00:42:37
  'edfhjhgeeddgddddddedffdddddeedfdheddddfejidfidddddhdeddegddcdddddd', // 00:42:38
  'eeghjhhefffgddddddeegfdddddeedfdhedeedffjiggigddfdhffddgfddcdddddd', // 00:42:39
  'ffghjhhefgfgddddfeffggddefdeedfdhedeffffjiggigdefdhfgddgfddceddddd', // 00:42:40
  'ffghjhhffgfgdddffeffggedeggefefdhfdeffggjiggigdegdhfgfdgfddcedddef', // 00:42:41
  'ffjijhhffgfgdedffeffghfeeghffgfdifffffggkighigdegdhfgfdgfdecefddef', // 00:42:42
  'fgjjjkifggfgdedffeffhifeeghgfgfdifgfffggkkghigdegehfgfehfdecefffef', // 00:42:43
  'fgjjlljfghfgdedffeifjiffeghgfgfdihgfifgjkkgkjgdegehfggehfdeceffgef', // 00:42:44
  'gijjlljfgjggdedffgifjiffeghgfggdihgjifgjkkjkjidfjehgjgejfdeceffgef', // 00:42:45
  'ijjjlljfikigdfdfhhihjifffghgfgidihgjifgjkkkkjjdfjehijgejfdeceffgef', // 00:42:46
  'ijjjlljgikigefdfhhihjiffgjhgfgidihgjighjkkkkjjdhjgiijgejfdfcfffgef', // 00:42:47
  'ijjjlljjikihefdghhihjigfjjhgfgidihgjiihjkkkkjjeijhiijhfjidfciffghh', // 00:42:48
  'ijjjlljjikiiefdhhhihjihfjjhghhidihgjiihjkkkkjjeijhiijifjidhcigfgii', // 00:42:49
  'ijjjlljjikiighdhhhihjihhjjigijidihhjiihjkkkkjjgijhiijiijidicigfgii', // 00:42:50
  'ijjjlljjikiihhehhhihjihhjjigjjieihijiihjkkkkjjhijhiijiijidiciifgii', // 00:42:51
  'ijjjlljjikiihhghhhihjihhjjihjjifihijiihjkkkkjjhijhiijiijieiciiggii', // 00:42:52
  'ijjjlljjikiihhghhhihjihhjjiijjifihijiihjkkkkjjhijhiijiijificiihhii', // 00:42:53
  'ijjjlljjikiihhghhhihjihhjjiijjifihijiihjkkkkjjhijhiijiijificiiiiii', // 00:42:54
  // 00:42:55 以降は 00:43:20 まで 1 文字も変化しない（実データ）。同一行が続くだけなので繰り返しで表す。
  // HOLD_MS(10秒) を大きく跨ぐ長さがあり、「新規の立ち上がりが無くなった後も維持されるか」を試せる。
  ...Array.from({ length: 26 }, () => AICHI_FLAT_TAIL), // 00:42:55〜00:43:20
]

/** 添字 → "00:MM:SS" ラベル（先頭フレームが 00:42:20）。 */
function frameLabel(i: number): string {
  const sec = 20 + i
  return `00:${42 + Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`
}

/** "00:MM:SS" ラベル → フレーム添字。見つからなければ即座に失敗させる（-1 で slice が化けるのを防ぐ）。 */
function indexOfLabel(label: string): number {
  const i = AICHI_FRAMES.findIndex((_, k) => frameLabel(k) === label)
  if (i < 0) throw new Error(`フレームが存在しない: ${label}`)
  return i
}

/** 実データ1行を Frame へ。'c'(-1) は欠測として missing に落とす。 */
function aichiFrame(i: number): Frame {
  const values = Array.from(AICHI_FRAMES[i], (c) => c.charCodeAt(0) - 100)
  return {
    dataTimeMs: i * 1000,
    sites: AICHI_SITES,
    values,
    missing: values.map((v) => v < 0),
  }
}

/** 1 フレーム分の観測結果。 */
interface FrameOutcome {
  label: string
  /** そのフレームで新たに立ち上がった観測点の数。横ばい区間では 0 になる。 */
  triggers: number
  events: number
  /** 検知イベントのメンバー数（最大）。横ばい区間で規模が閾値を割らないかの検証に使う。 */
  size: number
  confirmed: boolean
}

/** 実データを全フレーム流し、各フレームの結果を返す。 */
function driveAichi(): FrameOutcome[] {
  const meta = buildStationMeta(AICHI_SITES)
  let state = initState(-1000)
  const perFrame: FrameOutcome[] = []
  for (let i = 0; i < AICHI_FRAMES.length; i++) {
    const r = step(state, aichiFrame(i), meta)
    state = r.state
    perFrame.push({
      label: frameLabel(i),
      triggers: r.triggers.length,
      events: r.detections.length,
      size: Math.max(0, ...r.detections.map((d) => d.lastSize)),
      confirmed: r.detections.some((d) => d.confidence === 'confirmed'),
    })
  }
  return perFrame
}

// ============================================================
// 実観測波形
// ============================================================

describe('step: 実観測波形での確定（2026-07-22 00:42 愛知県西部・震度1級）', () => {
  it('立ち上がり後に横ばいへ移る実波形で confirmed に到達する', () => {
    const perFrame = driveAichi()
    const firstConfirmed = perFrame.findIndex((f) => f.confirmed)

    expect(firstConfirmed).toBeGreaterThanOrEqual(0)
    // 実測では 00:42:44 に確定する（最初のトリガーが立つ 00:42:37 の 7 秒後）。上限は実測 +2 秒。
    // 旧エンジンはこの波形で確定できず、候補のまま 4 秒で失効していた。
    // CONFIRM_FRAMES など確定条件を意図的に変えるときは、この上限も併せて見直すこと。
    expect(firstConfirmed).toBeLessThanOrEqual(indexOfLabel('00:42:46'))
  })

  it('新規トリガーが完全に途絶した横ばい区間でも confirmed と規模を維持する', () => {
    const perFrame = driveAichi()
    // 00:42:55 以降は入力文字列がまったく変化しない（＝新規に立ち上がる点が 1 つも無い）区間。
    const tail = perFrame.slice(indexOfLabel('00:42:55'))

    // HOLD_MS を跨がない短さだと「維持された」ことの確認にならないので、まず長さを担保する。
    expect(tail.length * 1000).toBeGreaterThan(PARAMS.HOLD_MS)
    expect(tail.every((f) => f.triggers === 0)).toBe(true) // 横ばいであることの確認
    expect(tail.every((f) => f.confirmed)).toBe(true)
    // 立ち上がりが途絶えても規模が CONFIRM_POINTS を割らない。旧エンジンはここで候補が育たず失効した。
    // なお規模そのものは減る: 実データではピーク 24 点 → 7 点まで落ちて安定する（sustained を
    // 割った点が順に外れるため）。CONFIRM_POINTS(5) に対する余裕は +2 しかないので、
    // SUSTAIN_MARGIN を上げる変更をするときはこのテストが警報になる。
    expect(tail.every((f) => f.size >= PARAMS.CONFIRM_POINTS)).toBe(true)
  })
})

// ============================================================
// 合成シナリオ（旧バグの最小再現形）
// ============================================================

describe('step: 横ばい波形の合成シナリオ', () => {
  /**
   * 静穏 → 1 フレームで震度1へ立ち上がり → 以後まったく同じ値のまま。
   * 旧エンジンはこの「2 フレーム目以降 差分 0」で候補が育たず失効していた。
   */
  function riseThenFlat(shakeValue: number, shakenCount: number): Omit<FrameOutcome, 'label'>[] {
    const defs = grid3x3(35.0, 139.0, 0.1)
    const sites = sitesOf(defs)
    const meta = buildStationMeta(sites)
    let state = initState(-1000)
    const perFrame: Omit<FrameOutcome, 'label'>[] = []
    let t = 0

    const push = (values: number[]) => {
      const r = step(state, { dataTimeMs: t, sites, values }, meta)
      state = r.state
      perFrame.push({
        triggers: r.triggers.length,
        events: r.detections.length,
        size: Math.max(0, ...r.detections.map((d) => d.lastSize)),
        confirmed: r.detections.some((d) => d.confidence === 'confirmed'),
      })
      t += 1000
    }

    for (let i = 0; i < 6; i++) push(defs.map(() => valueToIndex(0)))
    // 立ち上がり以降は値を一切変えない（完全な横ばい）。
    // 新規の立ち上がりが止まる TRIG_ACTIVE_MS の先、さらに HOLD_MS を跨ぐまで続ける。
    const shaken = defs.map((_, j) => valueToIndex(j < shakenCount ? shakeValue : 0))
    const flatFrames = Math.ceil((PARAMS.TRIG_ACTIVE_MS + PARAMS.HOLD_MS) / 1000) + 4
    for (let i = 0; i < flatFrames; i++) push(shaken)

    return perFrame
  }

  it('立ち上がり後に値が一切変化しなくても confirmed に到達する', () => {
    const perFrame = riseThenFlat(0.5, 9) // 震度1級・9点すべて
    expect(perFrame.some((f) => f.confirmed)).toBe(true)
  })

  /**
   * イベントが維持される仕組み自体は kyoshinDetector.test.ts の
   * 「揺れが続く限り onset が止まっても size は減衰せずイベントが維持される（早期消滅の回帰）」
   * と同じ（`sustained` の OR 条件）。重複ではなく、あちらが「weak でない・MIN_LIKELY_POINTS 以上」
   * までなのに対し、こちらは confirmed 到達と CONFIRM_POINTS 維持まで踏み込む。片方だけ消さないこと。
   */
  it('新規トリガーが 0 になった後も confirmed と規模を維持する', () => {
    const perFrame = riseThenFlat(0.5, 9)
    // 新規の立ち上がりが完全に止まった時点以降を対象にする。
    const firstQuiet = perFrame.findIndex((f) => f.confirmed && f.triggers === 0)
    expect(firstQuiet).toBeGreaterThanOrEqual(0)

    const tail = perFrame.slice(firstQuiet)
    expect(tail.length * 1000).toBeGreaterThan(PARAMS.HOLD_MS)
    expect(tail.every((f) => f.triggers === 0)).toBe(true)
    expect(tail.every((f) => f.confirmed)).toBe(true)
    // 全点が同じ値で立ち上がる合成波形では sustained が全点で成立し続けるため、規模は 9 点のまま。
    // 点ごとに値がばらつく実データでは減衰する（上の実観測テストを参照）。
    expect(tail.every((f) => f.size >= PARAMS.CONFIRM_POINTS)).toBe(true)
  })

  it('横ばいでも MIN_CLUSTER 未満の点数しか揺れなければイベント化しない', () => {
    // 横ばいを追跡し続ける性質が、少数点の居座りノイズを拾う方向へ働かないことの確認。
    // 見ているのは MIN_CLUSTER フィルタ自体で、横ばい固有の挙動ではない
    //（横ばいであってもこのフィルタが緩まないことを確かめる位置づけ）。
    const perFrame = riseThenFlat(0.5, PARAMS.MIN_CLUSTER - 1)
    expect(perFrame.every((f) => f.events === 0)).toBe(true)
  })

  it('横ばいでも CONFIRM_POINTS 未満の点数なら confirmed まで上げない', () => {
    // イベントにはなるが確定はしない中間帯。実データ（2026-07-22）でも規模が 3→6→11 と
    // 育ってはじめて確定しており、立ち上がり直後の少数点だけでは確定しない。
    const perFrame = riseThenFlat(0.5, PARAMS.CONFIRM_POINTS - 1)
    expect(perFrame.some((f) => f.events > 0)).toBe(true)
    expect(perFrame.every((f) => !f.confirmed)).toBe(true)
  })
})
