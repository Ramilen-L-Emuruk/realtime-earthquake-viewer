// 自作地震計の波形の縦の下限と「収まった」の閾値を、**測った静かさ**から決める。
//
// **決め打ちの gal にしない。** 以前は MPU6050 だけだった頃の静穏時（最大 1.61 gal）から
// 決めた値を各所に書いていた。IIS2ICLX を観測点の合成へ入れると静かさが 1/7 ほどに下がり、
// 同じ値のままでは静かなときの線が枠の数 % しか振れず、平らにしか見えなくなった。
// 下限が表したいのは「静かなときの振れ」そのもので、それは手元の波形で測れる。
//
// **物差し** は「1 秒ごとの、中心からの振れの最大」の中央値（3 成分のうち最大）。地震カード・
// 詳細の窓は 0 の手前 30 秒で測る（`seismoQuakeWindow.ts` の `measureQuietLevel`）。地図の下端の
// 波形は手元の 60 秒ぶんから測り、揺れに引きずられないよう直近 5 分の最小を使う
// （{@link QuietLevelMemory}）。

import type { SeismoWaveWindow } from './seismoWaveBuffer'

/**
 * 物差しの下限（gal）。**測り値が 0 近くに縮んだときの受け皿**で、ふだんの判定には効かない値に置く
 * （`seismoQuakeWindow.ts` の `NOISE_FLOOR_GAL` と同じ値・同じ理由）。
 */
export const QUIET_LEVEL_MIN_GAL = 0.05

/**
 * 物差しに掛ける倍率。
 *
 * もとは IIS2ICLX を入れる前の見た目から逆算した値（入れる前の 2026-10-09・7 時刻の実測で物差しは 1.32 gal、
 * そのときの決め打ちの値をこれで割った）。入れた後（2026-10-11・同じ 7 時刻）は 0.19 gal。
 *
 * **カード・下端は 7.5 から 3 へ下げた**（2026-10-13 ユーザー承認「ほかのところに比べて最小幅が大きすぎない？」。
 * 7.5 だと詳細の窓の 5 倍・管理コンソールの固定 0.2 gal の 7 倍あり、小さな揺れが平らにしか見えなかった）。
 * 3 成分を重ねる・合成の 1 本で見る絵なので、詳細の窓（段に分けて見る）の 1.5 までは下げない ——
 * 静かなときのノイズが枠いっぱいに広がると、揺れているように見える。
 *
 * | 用途 | 倍率 | いまの物差し（0.19 gal）での下限 |
 * |---|---|---|
 * | 地震カード・地図の下端の波形（畳んだとき）の縦 | 3 | 約 0.6 gal |
 * | 詳細の窓・地図の下端の波形（展開したとき）の縦 | 1.5 | 約 0.3 gal |
 * | カードの繋ぎ足しを止める「収まった」 | 2.3 | 約 0.44 gal |
 */
export const QUIET_SCALE_RATIO = {
  card: 3,
  detail: 1.5,
  settle: 2.3,
} as const

/**
 * 静かさを測れなかったときの値（gal）。**決め打ちだった頃の値をそのまま使う。**
 *
 * 0 の手前に記録が無い（ホストを起動した直後・欠けていた）と測れない。そのときは、ノイズが
 * 枠いっぱいに広がらない側へ倒す —— 静かな絵が平らに見えるほうが、ノイズを揺れと読むより害が小さい。
 */
export const QUIET_SCALE_FALLBACK_GAL: Readonly<Record<QuietScaleUse, number>> = {
  card: 10,
  detail: 2,
  settle: 3,
}

export type QuietScaleUse = keyof typeof QUIET_SCALE_RATIO

/** 物差し（gal・測れなければ `null`）から、用途ごとの値を出す。 */
export function quietScaledGal(use: QuietScaleUse, quietLevelGal: number | null): number {
  if (quietLevelGal === null || !Number.isFinite(quietLevelGal)) return QUIET_SCALE_FALLBACK_GAL[use]
  return QUIET_SCALE_RATIO[use] * Math.max(quietLevelGal, QUIET_LEVEL_MIN_GAL)
}

/** 地図の下端の波形で静かさを測る長さ（ms）。**地震カードの 0 の手前と同じ 30 秒。** */
export const LIVE_QUIET_SPAN_MS = 30_000

/** 測るのに要る秒数。**地震カードと同じ 10 秒**（`seismoQuakeWindow.ts` の `NOISE_MIN_SECONDS`）。 */
const LIVE_QUIET_MIN_SECONDS = 10

/**
 * 地図の下端の波形が抱えている窓の、末尾 {@link LIVE_QUIET_SPAN_MS} から静かさを測る。
 * **測れなければ `null`。**
 *
 * 測り方は地震カードと同じ（成分ごとに中心を中央値で取り、1 秒ごとの振れの最大の中央値。3 成分のうち最大）。
 * 届いていない区間（`NaN`）は混ぜない。
 */
export function measureWindowQuietLevel(win: SeismoWaveWindow): number | null {
  const n = win.gal[0].length
  if (n === 0 || !(win.msPerSample > 0)) return null
  const endMs = win.firstSampleMs + n * win.msPerSample
  const fromMs = endMs - LIVE_QUIET_SPAN_MS
  const start = Math.max(0, Math.ceil((fromMs - win.firstSampleMs) / win.msPerSample))
  let level: number | null = null
  for (const axis of win.gal) {
    const values: number[] = []
    for (let i = start; i < n; i += 1) if (Number.isFinite(axis[i])) values.push(axis[i])
    if (values.length === 0) continue
    const center = median(values)
    const peaks = new Map<number, number>()
    for (let i = start; i < n; i += 1) {
      const v = axis[i]
      if (!Number.isFinite(v)) continue
      const sec = Math.floor((win.firstSampleMs + i * win.msPerSample - fromMs) / 1000)
      peaks.set(sec, Math.max(peaks.get(sec) ?? 0, Math.abs(v - center)))
    }
    if (peaks.size < LIVE_QUIET_MIN_SECONDS) continue
    const m = median([...peaks.values()])
    if (level === null || m > level) level = m
  }
  return level
}

/** {@link QuietLevelMemory} が覚えておく長さ（ms）。**5 分。** */
export const LIVE_QUIET_MEMORY_MS = 5 * 60_000

/**
 * 地図の下端の波形の静かさを、**直近 5 分の最小**で覚える。
 *
 * 手元の窓は 60 秒しか無いので、揺れが 30 秒を超えると、その場で測った値は揺れの強さに引きずられる。
 * そのまま下限にすると**揺れている最中に縦が伸び、揺れが小さく描かれる**。揺れの前に測った値を
 * 覚えておき、いちばん静かだったものを使う。5 分を超えて揺れ続けると引きずられ始めるが、
 * そのときは揺れの大きさのほうが下限を超えているので、絵の縦は揺れで決まる。
 *
 * **時刻はデータの時刻で渡す**（壁時計は使わない）。時刻が覚えている長さより前へ戻ったら（再生の
 * 切り替えなど）、覚えていた値を捨てる —— 別の時間の静かさを混ぜない。
 *
 * **物差しの下限（`minLevel`）未満の値は覚えない**（測れなかったものとして扱う）。値が張り付いた窓
 * （センサーの固着・同じ値の連続）は 0 を返し、最小を採る作りでは 1 回でその後 5 分間の下限を決めてしまう。
 * 下限は単位で違う（自作地震計は {@link QUIET_LEVEL_MIN_GAL}、公開観測点は
 * `components/SeismoWaveChart/waveUnit.ts` の値）ので、作るときに渡す。
 */
export class QuietLevelMemory {
  private entries: { atMs: number; level: number }[] = []

  constructor(private readonly minLevel: number) {}

  observe(atMs: number, level: number | null): void {
    if (!Number.isFinite(atMs)) return
    const last = this.entries[this.entries.length - 1]
    if (last !== undefined && atMs < last.atMs - LIVE_QUIET_MEMORY_MS) this.entries = []
    if (level !== null && Number.isFinite(level) && level >= this.minLevel) this.entries.push({ atMs, level })
    const from = atMs - LIVE_QUIET_MEMORY_MS
    this.entries = this.entries.filter((e) => e.atMs >= from && e.atMs <= atMs)
  }

  /** 覚えている中でいちばん静かだった値。**何も覚えていなければ `null`。** */
  current(): number | null {
    let min: number | null = null
    for (const e of this.entries) if (min === null || e.level < min) min = e.level
    return min
  }
}

function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
