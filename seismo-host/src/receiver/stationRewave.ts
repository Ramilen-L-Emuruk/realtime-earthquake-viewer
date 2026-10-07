// 欠けを取り戻した区間の合成波形を、生データから作り直す。
//
// **ライブの合成には、取り戻した分が入っていない。** 届かなかったまとまりは基板から取り戻しても
// 生データにしか書かない（`backlogFetcher.ts`）ので、その間の合成波形は効いたセンサーが減ったまま
// （あるいは途切れたまま）控え（`waveArchive.ts`）に残る。ここでは生データを読み直し、ライブ・取り戻した分・
// 遅れて届いた分をまとめて、**ライブと同じ部品**（`IntensityPipeline` → `SensorFusion`）へ流し直す。
// 出てきた合成のまとまりは、呼び出し側が「作り直し」の印を付けて控えへ足す（`WaveArchive.writeRevised`）。
//
// **流す順はデータの時刻。** 評価台（`bench/rawReplay.ts`）は実機と同じ結果を出すために受け取った順で
// 流すが、ここで欲しいのは「全部が間に合って届いていたら」の合成なので、取り戻した分が遅れて届いた
// 順に流しては意味が無い。合成の待ちはデータの時刻で計るので（`sensorFusion.ts`）、この順で流せば
// 間に合って届いた形になる。
//
// **新しい部品で作る。** ライブの合成の状態には触らない。直流（重力）の推定は 20 秒の窓を持つので、
// 区間の {@link REWAVE_LEAD_MS} 前から流して落ち着かせ、その間の出力は捨てる。
//
// **既知の限界: 時刻の刻みはライブと揃わない。** センサーの時間軸は区間の頭からの全アンカーで直線を
// 当てはめる（`../timebase/segmenter.ts`）。ライブの区間は何時間も続いた当てはめ、作り直しは
// {@link REWAVE_LEAD_MS} からの当てはめなので傾きがわずかに違い（実測でライブ 10.0015 ms・作り直し
// 9.99999〜10.0025 ms）、作り直した区間の両端でライブとの継ぎ目が少しずれる。2026-10-06 の 21 時台の
// 4 区間（40 秒〜3 分）で測ると、継ぎ目のずれは ±5 ms 以内、作り直した分の中のまとまりどうしは 0.2 ms
// 以内だった —— 計測震度の途切れの判定（`quakeIntensity.ts` の 1.5 サンプル＝15 ms）より小さく、継ぎ目を
// 途切れと取り違えない。欠けの無い区間を作り直して比べると、補間した値の差は二乗平均 0.32 gal・最大
// 0.92 gal（静穏時のノイズ 1.6 gal より小さい）。長い区間を区切って作り直したときの区切り目も、それぞれが
// 同じ助走から当てはめ直すので、同じ程度のずれになる。

import { IntensityPipeline } from './intensityPipeline'
import type { StoredPacket } from './mseedPacketReader'
import { SensorFusion } from './sensorFusion'
import type { FusedWaveChunk } from './sensorFusion'
import { StationDirectory } from './stationConfig'
import type { StationConfig } from './stationConfig'

/**
 * 区間の前から流し始める長さ。**合成の直流の窓（`FUSION_DC_WINDOW_SEC` = 20 秒）が埋まるまでの
 * 出力は使わない** —— 窓が埋まるまでは溜まった分だけの平均を返すので、作り直した波形の頭だけ
 * 直流がずれる。その 3 倍を取る。
 */
export const REWAVE_LEAD_MS = 60_000

/** 区間の後ろへ流し足す長さ。合成は裏付けを最大 600 ms 待つので、区間の末尾を確定させるため。 */
export const REWAVE_TAIL_MS = 5_000

/**
 * 何パケット流すごとに、受信の流れへ順番を譲るか。**作り直しはホストの受信と同じ流れで回る** ——
 * 3 分ぶん（9 センサーで約 7,300 パケット）を一気に流すと、手元の機械で 0.8〜1.2 秒かかり、
 * その間 UDP を受けられない（2026-10-06 の 21 時台の生データで実測）。256 ごとに譲れば 1 回は
 * 40 ms 前後に収まる。
 */
export const REWAVE_YIELD_EVERY = 256

export interface RewaveInput {
  readonly stationId: string
  /** 作り直して書く区間 `[fromMs, toMs)`。 */
  readonly fromMs: number
  readonly toMs: number
  /**
   * 生データから組み直したパケット（`readMseedRange`）。**区間の {@link REWAVE_LEAD_MS} 前から
   * {@link REWAVE_TAIL_MS} 後までを含むこと。** 範囲の外のものは捨てる。
   */
  readonly packets: readonly StoredPacket[]
  /**
   * 観測点の設定。**区間の {@link REWAVE_LEAD_MS} 前から変わっていないこと**（呼び出し側が確かめる。
   * 変わっていたら作り直さない —— `rewaveRunner.ts`）。
   */
  readonly config: StationConfig
}

export interface RewaveOutput {
  /** 区間に掛かる、その観測点の合成のまとまり（時刻順）。 */
  readonly chunks: readonly FusedWaveChunk[]
  /** 流したパケットの数。 */
  readonly fed: number
  /**
   * 同じまとまりが 2 度入っていたので片方を捨てた数。取り戻しはホストの再起動をまたぐと同じ
   * まとまりを 2 度書くことがある（`backlogBook.ts`）。
   */
  readonly duplicates: number
}

function streamOf(p: StoredPacket): string {
  return `${p.packet.boardKey}|${p.packet.bootId}|${p.packet.sensorId}|${p.packet.firstSeq}`
}

/**
 * 区間の合成波形を作り直す。**投げない作りではない**（呼び出し側が囲う）。
 *
 * `pause` は {@link REWAVE_YIELD_EVERY} パケットごとに待つ口（受信へ順番を譲る）。ホストでは
 * `setImmediate` を待つ。
 */
export async function rewaveStation(input: RewaveInput, pause: () => Promise<void>): Promise<RewaveOutput> {
  const { stationId, fromMs, toMs, config } = input
  const from = fromMs - REWAVE_LEAD_MS
  const to = toMs + REWAVE_TAIL_MS

  const seen = new Set<string>()
  let duplicates = 0
  const picked: StoredPacket[] = []
  for (const p of input.packets) {
    const t = p.packet.firstSampleMs
    if (!(t >= from && t < to)) continue
    const key = streamOf(p)
    if (seen.has(key)) {
      duplicates += 1
      continue
    }
    seen.add(key)
    picked.push(p)
  }
  // データの時刻順。同じ時刻なら受け取った順（受付番号）で揃える —— 並びが一意に決まるように。
  picked.sort(
    (a, b) =>
      a.packet.firstSampleMs - b.packet.firstSampleMs ||
      (a.rx ?? 0) - (b.rx ?? 0) ||
      a.arrival - b.arrival,
  )

  const pipeline = new IntensityPipeline({ stations: new StationDirectory(config) })
  const fusion = new SensorFusion(config)
  const out: FusedWaveChunk[] = []
  const keep = (w: FusedWaveChunk | null): void => {
    if (w === null || w.stationId !== stationId) return
    const last = w.firstSampleMs + (w.gal[0].length - 1) * w.msPerSample
    if (last >= fromMs && w.firstSampleMs < toMs) out.push(w)
  }
  for (const [i, p] of picked.entries()) {
    if (i > 0 && i % REWAVE_YIELD_EVERY === 0) await pause()
    const outcome = pipeline.handlePacket(p.packet)
    if (outcome.wave === null) continue
    keep(fusion.ingest(outcome.wave).fusedWave)
  }
  for (const d of fusion.closeAll().drained) keep(d.fusedWave)
  out.sort((a, b) => a.firstSampleMs - b.firstSampleMs)
  return { chunks: out, fed: picked.length, duplicates }
}
