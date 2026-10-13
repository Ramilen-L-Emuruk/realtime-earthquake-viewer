// 控えから流す合成波形のまとまりから、計測震度相当を組み立て直す（`redetect.ts` と `warmStart.ts` が使う）。
//
// **部品はライブと同じ**（`sensorFusion.ts` の IntensityStream・`normalizeIntensity`）。時刻の戻し方も同じ ——
// 流し込みの位置（何サンプル目か）から、そのまとまりの先頭の時刻へ足す。
//
// **途切れたら流し込みを作り直す。** 位置を詰めて繋ぐと、届いていない時間を挟んだ窓で値を出す。
//
// **投げない。** 作れない刻み・流し込みが投げたときは数えて（`failures`）、その区間の値を出さない。

import { IntensityStream } from '../intensity/intensityStream'
import { normalizeIntensity } from '../receiver/intensityPipeline'
import type { TriggerInput } from './quakeTrigger'

/** 流し込みを続けてよい、前のまとまりの末尾からのずれ（刻みに対する割合）。 */
const CONTINUOUS_TOLERANCE = 0.5
/** 刻みが変わったとみなす割合。 */
const RATE_TOLERANCE = 0.05

interface IntensityRun {
  readonly stream: IntensityStream
  readonly msPerSample: number
  /** 流し込んだサンプルの数（次のまとまりの位置）。 */
  pushed: number
  /** 次に来るはずのサンプルの時刻。 */
  nextMs: number
}

export class ChunkIntensity {
  private readonly stepSec: number
  private readonly onPoint: (atMs: number, intensity: number | null) => void
  private run: IntensityRun | null = null
  /** 計測震度相当を出せなかった区間の数（作れない刻み・流し込みが投げた）。 */
  failures = 0

  constructor(options: { readonly stepSec: number; readonly onPoint: (atMs: number, intensity: number | null) => void }) {
    this.stepSec = options.stepSec
    this.onPoint = options.onPoint
  }

  /** 1 まとまり流す（時刻順に）。出た計測震度相当は `onPoint` へ渡す。 */
  push(chunk: TriggerInput): void {
    let run = this.run
    const continuous =
      run !== null &&
      Math.abs(chunk.msPerSample - run.msPerSample) <= run.msPerSample * RATE_TOLERANCE &&
      Math.abs(chunk.firstSampleMs - run.nextMs) <= run.msPerSample * CONTINUOUS_TOLERANCE
    if (!continuous) {
      try {
        run = {
          stream: new IntensityStream({ sampleRateHz: 1000 / chunk.msPerSample, stepSec: this.stepSec }),
          msPerSample: chunk.msPerSample,
          pushed: 0,
          nextMs: chunk.firstSampleMs,
        }
      } catch {
        // 作れないのは刻みがおかしいときだけ。その区間の計測震度相当は出さない（検出は続ける）。
        this.failures++
        this.run = null
        return
      }
      this.run = run
    }
    if (run === null) return
    const n = chunk.gal[0].length
    const firstIndex = run.pushed
    try {
      const points = run.stream.push(firstIndex, Array.from(chunk.gal[0]), Array.from(chunk.gal[1]), Array.from(chunk.gal[2]))
      for (const p of points) {
        const intensity = normalizeIntensity(p.intensity).value
        const atMs = chunk.firstSampleMs + (p.endSampleIndex - firstIndex) * chunk.msPerSample
        this.onPoint(atMs, intensity)
      }
    } catch {
      this.failures++
      this.run = null
      return
    }
    run.pushed += n
    run.nextMs = chunk.firstSampleMs + n * chunk.msPerSample
  }
}
