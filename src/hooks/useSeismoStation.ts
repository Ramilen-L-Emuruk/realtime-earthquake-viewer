// 自作地震計ホストから届く震度と波形を、観測点ごとの「いまの姿」へ畳む層。
//
// **強震モニタ（Yahoo）の経路には一切触らない。** `kyoshinDetector` も
// `KyoshinSource` も、入力（全国 700 点の 1 秒ごとの色）も時間軸（リプレイで
// 巻き戻る）も別物で、共通化できるところが無い。
//
// **震度の出どころが 2 つある。** これがこの層の主題 ——
//
//   - `station-reading`（観測点の合成）。複数センサーで裏付けた値
//   - `reading`（センサー単独）。**観測点に有効なセンサーが 2 台未満だと、
//     ホストは合成を作らない**（`seismo-host/src/receiver/sensorFusion.ts` の
//     `buildGroups` が `list.length < 2` で組まない）。そのときはこちらしか無い
//
// **どちらを採るかは「合成が実際に届いたか」で決める。設定は見ない。** ホストの
// 設定を根拠にすると、設定と実際が食い違ったとき（センサーが落ちた・帳面に
// 古い観測点が残っている）判断ごと狂う。届いているものだけを信じる。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  connectSeismoStream,
  isValidSeismoHostUrl,
  SeismoHostDirectory,
  type SeismoMessage,
  type SeismoStreamState,
  type SeismoWaveWant,
} from '../services/seismoStream'
import {
  SeismoWaveBuffer,
  type SeismoWaveTally,
  type SeismoWaveWindow,
} from '../utils/seismoWaveBuffer'
import { createLogThrottle, log } from '../utils/logger'

/**
 * 震度が届かなくなってから落とすまで（ms）。
 *
 * **震度は毎秒 1 件届く**（窓 20 秒・刻み 1 秒。`utils/knet/seismicIntensity` の
 * `STEP_SEC_DEFAULT`）。合成はそこへ裏付けの待ち（300 ms。`sensorFusion.ts` の
 * `FUSION_WAIT_MS_DEFAULT`）が乗るだけなので、5 秒あれば正常な揺らぎを跨げる。
 *
 * **落とす判断をこの層に置く理由。** 届かなくなると再描画も起きないので、
 * 表示側からは「値が古い」を検出できない —— 画面には最後に届いた震度が残り、
 * **「揺れていない」と区別が付かなくなる**（#261 が避けたい形そのもの）。
 *
 * **接続の停滞（`seismoStream.ts` の `STALL_MS` = 45 秒）では代わりにならない。**
 * あちらが見るのは押し出しが生きているかで、**繋がっているのにその観測点だけが
 * 沈黙している**場合（センサーが落ちた・合成が組めなくなった）は掛からない。
 */
const READING_STALE_MS = 5000

/**
 * 波形が届かなくなってから「止まっている」と見なすまで（ms）。
 *
 * **震度の鮮度（{@link READING_STALE_MS}）では代われない。** 押し出しは種別ごとに
 * 独立していて、**観測点の有効なセンサーが 2 台を切ると合成だけが止まり、震度は
 * 単独（`reading`）へ落ちて生き続ける**（`seismo-host/src/receiver/sensorFusion.ts` の
 * `buildGroups` が `list.length < 2` で組まない）。接続層の停滞検出（`seismoStream.ts` の
 * `STALL_MS` = 45 秒）も、震度が届いている限り発火しない。
 *
 * **これが無いと、絵が凍ったまま「いま静かに揺れている」ように見え続ける。**
 * 入れ物（`utils/seismoWaveBuffer.ts`）は押し出しで駆動するだけで、時間が経っても
 * 薄れない —— 読み出すたび最後のスナップショットを返すので、**止まったことが
 * 画面のどこにも現れない**。この機能でいちばん避けたい「揺れていない」と
 * 「届いていない」の混同そのもの。
 *
 * まとまりは 0.3 秒ごとに届く（実機の実測で 12 秒に 40 件）ので、5 秒あれば
 * 正常な揺らぎを跨げる。
 */
const WAVE_STALE_MS = 5000

/**
 * 抱える波形の長さ（秒）。
 *
 * 実機の刻みは約 10 ms（100 Hz）なので、3 成分＋本数で 4 × 6000 サンプル ＝
 * `Float32Array` で 96 KB ほど。**観測点ごとに 1 本**持つ。
 *
 * **絵の横軸もこの長さで引く**（`components/SeismoWaveChart/`）。別々に持つと、
 * 片方だけ動かしたときに絵の左端が「抱えていない区間」なのか「届かなかった区間」
 * なのか分からなくなる。
 */
export const WAVE_RETAIN_SEC = 60

/**
 * 観測点ごとの姿を作り直す間隔（ms）。
 *
 * **1 件ごとに state を差し替えない。** センサー 9 本なら押し出しは毎秒 10 件
 * （`reading` 9 件＋`station-reading` 1 件）届くので、そのたび再描画すると
 * 毎秒 10 回になる。**震度そのものが毎秒 1 件**なので、それより細かく描き直す
 * 意味が無い。
 *
 * この刻みは古さの判定（{@link READING_STALE_MS}）も兼ねる —— 届かなくなっても
 * この巡回は回り続けるので、落とす契機が押し出しの到着に依存しない。
 */
const REBUILD_INTERVAL_MS = 500

/** 同じ理由の記録を間引く間隔（ms）。 */
const LOG_THROTTLE_MS = 300_000

/** その震度をどこから採ったか。 */
export type SeismoIntensitySource =
  /** 観測点の合成（`station-reading`）。複数センサーで裏付けた値。 */
  | { readonly kind: 'station' }
  /**
   * センサー単独（`reading`）の最大値。**合成が届いていない観測点。**
   *
   * @param sensorCount 最大値を選ぶのに見たセンサーの本数（古くないものだけ）。
   *   **1 なら裏付けが 1 本も無い。**
   */
  | { readonly kind: 'sensor'; readonly sensorCount: number }

/** 観測点 1 つの、いまの姿。 */
export interface SeismoStationState {
  readonly stationId: string
  /** 引けた表示名。**引けていなければ識別子そのまま。** */
  readonly displayName: string
  /**
   * 計測震度相当。**出せないなら `null`。**
   *
   * 「揺れていない」を意味する値ではないので 0 として扱わないこと
   * （ホスト側も同じ約束で `null` を返す）。
   */
  readonly intensity: number | null
  /** その値が代表する時刻（ホストの時計）。読めなければ `null`。 */
  readonly atMs: number | null
  readonly source: SeismoIntensitySource
  /** 抱えている波形のサンプル数。**0 なら波形は届いていない。** */
  readonly waveSampleCount: number
  /**
   * 波形が届かなくなっているか（{@link WAVE_STALE_MS}）。
   *
   * **一度も届いていないうちは `false`** —— そちらは {@link waveSampleCount} が 0 で
   * 分かるし、購読を始めた直後と区別が付かない。ここが立つのは「届いていたのに
   * 途絶えた」場合だけ。
   *
   * **絵の側で必ず使うこと。** 抱えている中身は時間で薄れないので、これを見ないと
   * 止まった波形を「いま静かに揺れている」として描き続ける。
   */
  readonly waveStale: boolean
  /**
   * 波形を抱えている間に起きたことの数え上げ。**波形が届いていなければすべて 0。**
   *
   * **画面か記録へ出すために持つ。** 敵対的レビューが見つけた 2 つの不具合
   * （偽の隙間が数秒ごと・巻き戻り中にデータが全損）は**どちらもここでしか
   * 観測できなかった** —— 絵の上では「短くなった」「途切れた」としか見えない。
   * ホスト側が同じものを状態の口へ出している
   * （`seismo-host/src/admin/waveBuffer.ts` の `rewindCount` ほか）。
   */
  readonly waveTally: SeismoWaveTally
}

export interface SeismoStations {
  /** 震度が届いている観測点。**表示名の順。** */
  readonly stations: readonly SeismoStationState[]
  /** 繋がり具合。**無効・URL 不正のときは `null`。** */
  readonly stream: SeismoStreamState | null
  /** 読めない押し出しが届いた累計と、最後の理由。 */
  readonly unreadable: { readonly count: number; readonly detail: string } | null
  /**
   * その観測点の波形を読む。**参照は安定**（毎レンダー変わらない）。
   *
   * **state に載せない。** 60 秒ぶんで 96 KB あるので、毎秒の描き直しで
   * 写し取ると再描画の重さが波形の長さに引きずられる。読む頻度は描く側
   * （`requestAnimationFrame` で回すか、間引くか）が決める。
   */
  readonly readWave: (stationId: string) => SeismoWaveWindow | null
}

export interface UseSeismoStationOptions {
  /** 設定タブのトグル。**切れていれば繋がない。** */
  readonly enabled: boolean
  /** ホストの基点 URL（設定タブの入力）。 */
  readonly baseUrl: string
  /**
   * 波形も要るか。**変えると繋ぎ直す。**
   *
   * 合成波形は毎秒 15 KB あるので、絵にしていない間は `'none'` にする
   * （切り替えは段 4 の担当）。
   */
  readonly wave: SeismoWaveWant
}

/** 帳面に積む 1 観測点ぶん。**state を作る材料。** */
interface StationEntry {
  /** 合成（`station-reading`）の最新。 */
  station: { intensity: number | null; atMs: number | null; receivedAt: number } | null
  /** センサー単独（`reading`）の最新。**鍵は `boardKey/sensorId`。** */
  sensors: Map<string, { intensity: number | null; atMs: number | null; receivedAt: number }>
  wave: SeismoWaveBuffer | null
  /** 波形のまとまりを最後に受け取った時刻。**一度も受け取っていなければ `null`。** */
  waveReceivedAt: number | null
}

/** 空のときの参照を固定する。**毎回新しい配列を作ると再描画が 1 回増える。** */
const EMPTY_STATIONS: readonly SeismoStationState[] = []

/** 波形が 1 件も届いていない観測点の数え上げ。**参照を固定して比較を軽くする。** */
const EMPTY_TALLY: SeismoWaveTally = { gapSamples: 0, restarts: 0, droppedSamples: 0 }

/** 数え上げが同じかを見る。 */
function sameTally(a: SeismoWaveTally, b: SeismoWaveTally): boolean {
  return (
    a.gapSamples === b.gapSamples &&
    a.restarts === b.restarts &&
    a.droppedSamples === b.droppedSamples
  )
}

/** 2 つの姿が同じかを見る。**同じなら state を差し替えない。** */
function sameStates(
  a: readonly SeismoStationState[],
  b: readonly SeismoStationState[],
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]
    const y = b[i]
    if (
      x.stationId !== y.stationId ||
      x.displayName !== y.displayName ||
      x.intensity !== y.intensity ||
      x.atMs !== y.atMs ||
      x.source.kind !== y.source.kind ||
      x.waveSampleCount !== y.waveSampleCount ||
      x.waveStale !== y.waveStale ||
      !sameTally(x.waveTally, y.waveTally)
    ) {
      return false
    }
    if (
      x.source.kind === 'sensor' &&
      y.source.kind === 'sensor' &&
      x.source.sensorCount !== y.source.sensorCount
    ) {
      return false
    }
  }
  return true
}

/**
 * 自作地震計ホストの震度と波形を観測点ごとに持つ。
 *
 * **画面を離れたら購読を落とす。** 同時に繋いでいられるのは 8 本まで
 * （`seismo-host/src/receiver/readingHub.ts`）なので、握ったままにすると
 * 端末を増やしたときに自分で枠を食い潰す。
 */
export function useSeismoStation(options: UseSeismoStationOptions): SeismoStations {
  const { enabled, baseUrl, wave } = options
  const [stations, setStations] = useState<readonly SeismoStationState[]>(EMPTY_STATIONS)
  const [stream, setStream] = useState<SeismoStreamState | null>(null)
  const [unreadable, setUnreadable] = useState<{ count: number; detail: string } | null>(null)

  // **帳面は ref に持つ。** 押し出しは毎秒 10 件届くので、1 件ごとに state を
  // 差し替えると再描画がそのぶん増える（{@link REBUILD_INTERVAL_MS}）。
  const bookRef = useRef<Map<string, StationEntry>>(new Map())

  const readWave = useCallback((stationId: string): SeismoWaveWindow | null => {
    return bookRef.current.get(stationId)?.wave?.snapshot() ?? null
  }, [])

  // **URL の形はここでも見る。** 形が違えば `fetch` が投げるだけだが、
  // 繋ぎ直しの輪が 1 秒ごとに同じ例外を繰り返すことになる。
  const canConnect = enabled && isValidSeismoHostUrl(baseUrl)

  useEffect(() => {
    // **繋がない間は帳面ごと捨てる。** 残すと、URL を書き換えて繋ぎ直したときに
    // 前のホストの観測点が混ざる。
    bookRef.current = new Map()
    setStations(EMPTY_STATIONS)
    setUnreadable(null)
    if (!canConnect) {
      setStream(null)
      return
    }

    const ctrl = new AbortController()
    const directory = new SeismoHostDirectory(baseUrl)
    // **繋ぐ前に 1 回引く。** 押し出しは識別子だけを名乗るので、これが済むまでは
    // 表示名が識別子のまま出て、センサー単独の震度はどの観測点にも寄せられない。
    //
    // **この `catch` は通常は発火しない。** `refresh` は失敗を投げずに戻り値へ
    // 収める作り（`fetchSeismoStatus` が全経路を囲っている）なので、ここが拾うのは
    // その前提が将来崩れたときだけ —— 待たない呼び出しなので、崩れたときに
    // `unhandledRejection` として外へ漏れるのを防ぐためだけに置く。
    void directory.refresh().catch((error: unknown) => {
      log.warn('[seismo] 観測点の台帳を引けなかった', error)
    })

    const book = bookRef.current
    // **枠を用途ごとに分ける。** 1 つを共有すると、先に鳴った側が別種の障害の
    // 「初めて起きた 1 行」を隠す（接続層が同じ理由で分けている）。
    const throttledUnassigned = createLogThrottle(LOG_THROTTLE_MS)
    const throttledRebuildError = createLogThrottle(LOG_THROTTLE_MS)

    // **波形の作り直しは観測点ごとに枠を持つ。** 1 つを共有すると、ホストの
    // 再起動や時刻の補正で**複数の観測点が同時に作り直されたとき、最初の 1 件しか
    // 残らない**（他は間引きの間ずっと隠れる）。用途で分ける規約を、観測点の
    // 単位まで下ろした形。
    const waveRestartLogs = new Map<string, ReturnType<typeof createLogThrottle>>()
    const throttledWaveRestart = (stationId: string, emit: () => void): void => {
      let gate = waveRestartLogs.get(stationId)
      if (gate === undefined) {
        gate = createLogThrottle(LOG_THROTTLE_MS)
        waveRestartLogs.set(stationId, gate)
      }
      gate(emit)
    }

    /** その観測点の項目。**無ければ作る。** */
    const entryFor = (stationId: string): StationEntry => {
      const found = book.get(stationId)
      if (found !== undefined) return found
      const created: StationEntry = {
        station: null,
        sensors: new Map(),
        wave: null,
        waveReceivedAt: null,
      }
      book.set(stationId, created)
      return created
    }

    const onMessage = (message: SeismoMessage): void => {
      // **経過時間は `performance.now()` で測る**（{@link READING_STALE_MS}）。
      // 端末の壁時計を使うと、スリープからの復帰や時刻補正で跳ねたときに
      // 届いている値がまとめて「古い」へ倒れる。ホストが言う `atMs` も
      // 使わない —— あちらはホストの時計で、こちらとのずれを測る術が無い。
      const receivedAt = performance.now()
      switch (message.kind) {
        case 'station-reading': {
          const { stationId, intensity, atMs } = message.reading
          directory.require(stationId)
          entryFor(stationId).station = { intensity, atMs, receivedAt }
          return
        }
        case 'reading': {
          const { boardKey, sensorId, intensity, atMs } = message.reading
          directory.requireBoard(boardKey)
          const stationId = directory.stationIdForBoard(boardKey)
          // **観測点へ寄せられないセンサーは持たない。** 画面に出せるのは
          // 観測点の単位までで、`mac:020000000003` を利用者へ見せる意味が無い。
          //
          // **捨てたことは記録へ残す。** ここが無音だと、台帳を引けていない間
          // （＝合成が出ない観測点では震度が 1 件も出ない間）に**画面からは
          // 「揺れていない」と同じに見える** —— この機能でいちばん避けたい形。
          // 次の取り直しで寄せられるようになるが、それが来ない場合の手掛かりが
          // ここにしか無い。
          if (stationId === null) {
            throttledUnassigned(() =>
              log.warn(
                `[seismo] どの観測点にも寄せられないセンサーの震度を捨てた（${boardKey}）。` +
                  '台帳をまだ引けていないか、ホスト側で観測点へ割り当てられていない',
              ),
            )
            return
          }
          entryFor(stationId).sensors.set(`${boardKey}/${sensorId}`, { intensity, atMs, receivedAt })
          return
        }
        case 'station-wave': {
          const w = message.wave
          directory.require(w.stationId)
          const entry = entryFor(w.stationId)
          entry.wave ??= new SeismoWaveBuffer(WAVE_RETAIN_SEC)
          // **届いたことを生存の印にする。中身が使えたかは問わない**（接続層の
          // 停滞検出と同じ扱い）。重なりで捨てた場合も押し出しは生きているので、
          // ここで更新しないと正常な取り直しが「途絶えた」に見える。
          entry.waveReceivedAt = receivedAt
          const result = entry.wave.push(w)
          // **作り直したことは記録へ出す。** 起点が引き直されたのは時刻が飛んだ
          // 印で、絵の上では「急に短くなった」としか見えない。
          if (result.kind === 'restarted') {
            throttledWaveRestart(w.stationId, () =>
              log.warn(`[seismo] 波形を作り直した（${w.stationId}）: ${result.why}`),
            )
          }
          return
        }
      }
    }

    const handle = connectSeismoStream({
      baseUrl,
      wave,
      signal: ctrl.signal,
      onMessage,
      onState: setStream,
      onUnreadable: (count, detail) => setUnreadable({ count, detail }),
    })

    /** 帳面から姿を作り、変わっていれば差し替える。 */
    const rebuild = (): void => {
      const now = performance.now()
      const next: SeismoStationState[] = []
      for (const [stationId, entry] of book) {
        const waveSampleCount = entry.wave?.sampleCount ?? 0
        const waveTally = entry.wave?.tally ?? EMPTY_TALLY
        // **一度も届いていないうちは立てない。** 購読を始めた直後と区別が付かない。
        const waveStale =
          entry.waveReceivedAt !== null && now - entry.waveReceivedAt >= WAVE_STALE_MS

        // **合成が古くなければそれを採る。** 単独へ落ちるのは、合成が
        // 一度も届いていないか、届かなくなったとき。
        const fresh = entry.station !== null && now - entry.station.receivedAt < READING_STALE_MS
        if (fresh && entry.station !== null) {
          next.push({
            stationId,
            displayName: directory.displayName(stationId),
            intensity: entry.station.intensity,
            atMs: entry.station.atMs,
            source: { kind: 'station' },
            waveSampleCount,
            waveStale,
            waveTally,
          })
          continue
        }

        // **単独は最大値を採る。** 同じ観測点の複数センサーのうち、いちばん強く
        // 振れたものがそこで観測された揺れ（合成が組めない＝裏付けが無い状態なので、
        // 平均や中央で薄める根拠が無い）。**何本から採ったかを添える**ので、
        // 裏付けの有無は受け取る側が示せる。
        let best: number | null = null
        let bestAtMs: number | null = null
        let count = 0
        for (const [key, r] of entry.sensors) {
          // **古い項目はここで落とす。** 残すと、止まったセンサーの値が
          // 「いまの震度」として最大値の選抜に残り続ける。
          if (now - r.receivedAt >= READING_STALE_MS) {
            entry.sensors.delete(key)
            continue
          }
          count += 1
          if (r.intensity !== null && (best === null || r.intensity > best)) {
            best = r.intensity
            bestAtMs = r.atMs
          }
        }
        if (count === 0) {
          // **震度が 1 つも無い観測点は並べない。** 波形だけが届いている状態は
          // 通常起きない（合成波形が出ているなら合成震度も出ている）が、
          // 起きたときに「震度不明の行」を作らない。
          //
          // **帳面からは消さない** —— 波形の入れ物を捨てると、震度が戻った
          // ときに絵が 60 秒ぶん巻き戻る。
          continue
        }
        next.push({
          stationId,
          displayName: directory.displayName(stationId),
          intensity: best,
          atMs: bestAtMs,
          source: { kind: 'sensor', sensorCount: count },
          waveSampleCount,
          waveStale,
          waveTally,
        })
      }
      // **並びを固定する。** 帳面の順（初めて届いた順）で出すと、ホストを
      // 繋ぎ直すたびに行が入れ替わる。
      next.sort((a, b) => a.displayName.localeCompare(b.displayName, 'ja'))
      setStations((prev) => (sameStates(prev, next) ? prev : next))
    }

    // **投げても飲み込む。** ここが例外で抜けると、そのひと巡ぶんの「古い震度を
    // 落とす」「単独へ落ちる」が止まる —— この層の主目的そのもの。
    // `setInterval` は次の巡回を続けるので止まり続けはしないが、**`[seismo]` の
    // 記録には何も残らない**（押し出しの受け手が `callSafely` で守られているのと
    // 同じ扱いへ揃える）。
    const timer = setInterval(() => {
      try {
        rebuild()
      } catch (error) {
        throttledRebuildError(() => log.error('[seismo] 観測点の姿の作り直しが投げた', error))
      }
    }, REBUILD_INTERVAL_MS)

    return () => {
      clearInterval(timer)
      // **`signal` を落としてから閉じる。** どちらか一方でも購読は畳まれるが、
      // 揃えておくと「閉じたのに枠が空かない」形を作らない。
      ctrl.abort()
      handle.close()
    }
  }, [canConnect, baseUrl, wave])

  return useMemo(
    () => ({ stations, stream, unreadable, readWave }),
    [stations, stream, unreadable, readWave],
  )
}
