// 押し出しの口（`GET /stream`）へ繋ぐ受け口。
//
// **管理コンソールがこの口を使うのは、ここが最初。** `/api/*` は要求と応答の往復だが、
// こちらは繋いだままホストから流れてくる（実装は SSE。理由は
// `seismo-host/README.md`「状態と押し出しの口」）。
//
// **認証は無い。** `/stream` は読み取り専用で、出るのは家の揺れと機材の健全性だけなので
// トークンを付けない（`viewStatus.ts` が `/status` を素の `fetch` で取るのと同じ扱い）。
//
// **繋ぎ直しは `EventSource` に任せる。** 切れたら向こうが自分で繋ぎ直し、間隔もホストが
// `retry:` で指定してくる（`statusServer.ts`）。**こちらで開き直す輪を書かない** ——
// 上限で断られた（503）ときに、断られるたび繋ぎ直す形になる。
//
// **そのぶん「なぜ繋がらないか」は分からない。** `EventSource` は応答の本文を読ませて
// くれないので、503 の `too-many-subscribers` はここへ届かない。**繋げないという事実だけを
// 出し、理由の引き当ては画面側が `/status` の `stream` を見て添える**（`viewWaves.ts`）。

import type { WaveChunkView } from './waveBuffer'
import { readFinite, readFiniteArray, readNonEmptyString } from './readJson'

/** `EventSource.CLOSED`。**注入した偽物には静的プロパティが無いので数で持つ。** */
const READY_STATE_CLOSED = 2

/**
 * 繋がり具合。
 *
 * `closed` は**向こうが繋ぎ直しをやめた**状態（HTTP が 200 で返らなかった等）。
 * `reconnecting` との違いは、放っておいても直らないこと。
 */
export type WaveStreamState = 'connecting' | 'open' | 'reconnecting' | 'closed'

/**
 * センサー 1 本の計測震度。
 *
 * **`IntensityReading`（`../receiver/intensityPipeline.ts`）のうち画面で使う欄だけ。**
 * 丸ごと持ってこないのは `WaveChunkView` と同じ理由。
 */
export interface SensorReadingView {
  readonly boardKey: string
  readonly sensorId: string
  /** この値が代表する時刻。読めなければ null。 */
  readonly atMs: number | null
  /**
   * 計測震度相当。**窓の中身が足りなければ null。**
   * 「揺れていない」を意味する値ではないので 0 として扱わないこと。
   */
  readonly intensity: number | null
}

/**
 * `EventSource` のうち、ここで使うところだけ。
 *
 * **テストで差し替えるために絞っている。** 走るのは Node（`vitest.config.ts` の
 * `environment: 'node'`）で、jsdom を指定しても `EventSource` は無い。
 */
export interface WaveStreamLike {
  addEventListener(type: string, listener: (event: { readonly data?: unknown }) => void): void
  close(): void
  readonly readyState: number
}

export interface WaveStreamOptions {
  /** 波形も要るか。**要らないなら送らせない**（9 本ぶんで毎秒およそ 24 KB）。 */
  readonly wave: boolean
  /** これが落ちたら閉じる。**タブを離れたら必ず閉じること**（同時購読は 8 本まで）。 */
  readonly signal: AbortSignal
  readonly onWave?: (chunk: WaveChunkView) => void
  /**
   * 観測点の合成波形（#315）。**`wave` が真のときだけ流れてくる。**
   *
   * 中身は `readStationWaveChunk` が直流を足し戻したもので、センサー単独の
   * `onWave` と同じ単位（校正済み gal）になっている。
   */
  readonly onStationWave?: (chunk: WaveChunkView) => void
  readonly onReading?: (reading: SensorReadingView) => void
  /** 繋がり具合が変わったら呼ぶ。**同じ状態では呼ばない。** */
  readonly onState: (state: WaveStreamState) => void
  /**
   * 読めない押し出しが届いたら呼ぶ。**累計と、最後の理由。**
   *
   * **黙って捨てない。** 形が変わったこと（ホストと管理コンソールの版の食い違い）は、
   * 画面からは「波形が出ない」としか見えない —— 繋がっていないのか、読めていないのかを
   * 分ける手掛かりがここにしか無い。
   */
  readonly onUnreadable?: (count: number, detail: string) => void
  /** テストで差し替える。 */
  readonly create?: (url: string) => WaveStreamLike
}

function defaultCreate(url: string): WaveStreamLike {
  // **ここだけキャストする。** `EventSource` の `addEventListener` は種別ごとに
  // 型付けされており、任意の種別名を受ける上の形とは重ならない（`wave` のような
  // 独自の種別名は DOM の型に無い）。
  return new EventSource(url) as unknown as WaveStreamLike
}

/** 波形 1 チャンクとして読めるか。**1 欄でも欠ければ通さない。** */
export function readWaveChunk(value: unknown): WaveChunkView | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>

  const boardKey = readNonEmptyString(v.boardKey)
  const sensorId = readNonEmptyString(v.sensorId)
  const streamKey = readNonEmptyString(v.streamKey)
  if (boardKey === null || sensorId === null || streamKey === null) return null

  const segmentId = readFinite(v.segmentId)
  const firstSampleMs = readFinite(v.firstSampleMs)
  const msPerSample = readFinite(v.msPerSample)
  if (segmentId === null || firstSampleMs === null || msPerSample === null) return null
  // **刻みが 0 以下だと時刻が進まない。** 同じ時刻に全サンプルが積まれ、
  // 窓の切り出しが 1 列へ潰れる。
  if (msPerSample <= 0) return null

  if (!Array.isArray(v.gal) || v.gal.length !== 3) return null
  const x = readFiniteArray(v.gal[0])
  const y = readFiniteArray(v.gal[1])
  const z = readFiniteArray(v.gal[2])
  if (x === null || y === null || z === null) return null

  return {
    source: { kind: 'sensor', boardKey, sensorId },
    streamKey,
    segmentId,
    firstSampleMs,
    msPerSample,
    timebaseNominalReason: readNonEmptyString(v.timebaseNominalReason),
    gal: [x, y, z],
    memberCount: null,
  }
}

/**
 * 観測点の合成波形 1 チャンクとして読めるか（`FusedWaveChunk`・#315）。
 *
 * **直流を足し戻して返す。** 押し出しで来る `gal` は変動分（各センサーから重力を
 * 落としてから混ぜた値。#362）で、センサー単独の `gal` は校正済み gal（重力込み）——
 * **そのまま同じ画面へ重ねると、縦の目盛りが 2 つの意味を持つ。** `dcGal` は
 * そのために捨てずに添えてあるので、ここで足して単位を揃える。
 *
 * **形が合わなければ通さない。** 足し算の相手（`dcGal`）が欠けていれば、
 * 変動分だけを「校正済み gal」として出すことになる。
 */
export function readStationWaveChunk(value: unknown): WaveChunkView | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>

  const stationId = readNonEmptyString(v.stationId)
  if (stationId === null) return null

  const firstSampleMs = readFinite(v.firstSampleMs)
  const msPerSample = readFinite(v.msPerSample)
  if (firstSampleMs === null || msPerSample === null) return null
  // **刻みが 0 以下だと時刻が進まない**（`readWaveChunk` と同じ理由）。
  if (msPerSample <= 0) return null

  if (!Array.isArray(v.gal) || v.gal.length !== 3) return null
  if (!Array.isArray(v.dcGal) || v.dcGal.length !== 3) return null
  const restored: number[][] = []
  for (let axis = 0; axis < 3; axis++) {
    const wave = readFiniteArray(v.gal[axis])
    const dc = readFiniteArray(v.dcGal[axis])
    if (wave === null || dc === null) return null
    // **長さが揃っていなければ通さない。** 短いほうに合わせると、足し戻せた分と
    // 足し戻せなかった分が同じ 1 本の中に混ざる。
    if (wave.length !== dc.length) return null
    const sum = new Array<number>(wave.length)
    for (let i = 0; i < wave.length; i++) sum[i] = wave[i] + dc[i]
    restored.push(sum)
  }

  const memberCount = readFiniteArray(v.memberCount)
  if (memberCount === null) return null
  // **サンプル数と揃っていなければ通さない。** いまは同じ `n` から同時に作られる
  // （`sensorFusion.ts` の `combine`）ので起きないが、片方の生成だけが変わったとき
  // **「混ざった本数」の要約が、描いているサンプル範囲と別の範囲を数えた値になる**
  // ——エラーもログも出ない。ここは「形が違っても落ちない形で読む」のが仕事なので、
  // 長さの検査を `gal`/`dcGal` と非対称にしない。
  if (memberCount.length !== restored[0].length) return null

  return {
    source: { kind: 'station', stationId },
    // **合成には区間の識別子が無い。** 連続性は時刻の隔たりで見る
    // （`waveBuffer.ts` の `WaveChunkView.streamKey` を見ること）。
    streamKey: null,
    segmentId: null,
    firstSampleMs,
    msPerSample,
    // **合成波形は時刻の当てはめの状態を持たない。** 駆動役の区間から引いた値で
    // 組んであるが、`FusedWaveChunk` はそれを外へ出さない。
    timebaseNominalReason: null,
    gal: [restored[0], restored[1], restored[2]],
    memberCount,
  }
}

/** 計測震度 1 件として読めるか。 */
export function readSensorReading(value: unknown): SensorReadingView | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const boardKey = readNonEmptyString(v.boardKey)
  const sensorId = readNonEmptyString(v.sensorId)
  if (boardKey === null || sensorId === null) return null
  return {
    boardKey,
    sensorId,
    atMs: readFinite(v.atMs),
    // **`null` は「窓の中身が足りない」で、0 ではない。** `readFinite` が
    // そのまま `null` へ倒すので、ここで 0 を埋めないこと。
    intensity: readFinite(v.intensity),
  }
}

/** 押し出しへ繋ぐ。**閉じるのは `signal` 側。** */
export function openWaveStream(options: WaveStreamOptions): void {
  if (options.signal.aborted) return

  const create = options.create ?? defaultCreate
  const source = create(options.wave ? '/stream?wave=1' : '/stream')

  let state: WaveStreamState = 'connecting'
  options.onState(state)
  const setState = (next: WaveStreamState): void => {
    if (state === next) return
    state = next
    options.onState(next)
  }

  let unreadable = 0
  const noteUnreadable = (detail: string): void => {
    unreadable++
    options.onUnreadable?.(unreadable, detail)
  }

  options.signal.addEventListener(
    'abort',
    () => {
      try {
        source.close()
      } catch {
        // 既に閉じている。閉じる以上にできることは無い。
      }
    },
    { once: true },
  )

  const listen = <T>(
    type: string,
    read: (value: unknown) => T | null,
    use: ((value: T) => void) | undefined,
  ): void => {
    source.addEventListener(type, (event) => {
      if (options.signal.aborted) return
      // **欲しがっていない種別は読まない。** 観測点の合成（`station-reading`）は
      // 購読の種類によらず流れてくるので、使う気の無いものを毎回パースする理由が無い。
      if (use === undefined) return
      if (typeof event.data !== 'string') {
        noteUnreadable(`${type}: 本文が文字列でない`)
        return
      }
      let json: unknown
      try {
        json = JSON.parse(event.data)
      } catch (error) {
        noteUnreadable(`${type}: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      const parsed = read(json)
      if (parsed === null) {
        noteUnreadable(`${type}: 形が合わない`)
        return
      }
      // **ここは囲わない。** 使う側が投げるのは画面の欠陥で、読めなかったこととは
      // 別の事実。混ぜると「読めなかった件数」に画面の不具合が紛れ、どちらが
      // 起きているのか読めなくなる（`readingHub.ts` が配達の失敗と報せの失敗を
      // 分けて数えているのと同じ判断）。囲わなければコンソールへ出る。
      use(parsed)
    })
  }

  source.addEventListener('open', () => {
    if (options.signal.aborted) return
    setState('open')
  })
  source.addEventListener('error', () => {
    if (options.signal.aborted) return
    setState(source.readyState === READY_STATE_CLOSED ? 'closed' : 'reconnecting')
  })
  listen('wave', readWaveChunk, options.onWave)
  listen('station-wave', readStationWaveChunk, options.onStationWave)
  listen('reading', readSensorReading, options.onReading)
}
