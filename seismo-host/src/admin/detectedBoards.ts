// `/status` が声を聞いている基板を、入力候補として使える形へ畳む。
//
// **基板 Key・センサー ID を手で打たせないための材料。** 打ち間違えても保存は
// 通ってしまい、しかも気づく手掛かりが無い——とくに `sensorId` が 1 文字でも
// 食い違うと、校正値が 1 つも効かないまま既定値（単位行列・補正なし）で動き
// 続ける（`statusReport.ts` の `SensorStatus.calibrationConfigured`）。
//
// **`/status` は認証を持たない読み取り専用の口。** トークンを入れる前でも候補は
// 出せるので、`viewStatus.ts` と同じく素の `fetch` を使う（`api.ts` の `apiFetch`
// を通すと `Authorization` が乗り、401 でトークンを消す経路にも掛かる）。
//
// **静止窓の診断（`gravity.verdicts`）も同じ口から取る。** 取り付けの傾きを直す材料で、
// 基板の候補と同じタイミングで更新したい（`calibrationSuggest.ts`）。

import type { Vec3 } from '../receiver/stationConfigTypes'
import { readFinite, readVec3 } from './readJson'

/**
 * `/status` の `sensors[]` のうち、ここで使う欄だけ。
 *
 * **`statusReport.ts` の `SensorStatus` を再定義しない。** あちらは Node 専用の型を
 * 経由しており、ブラウザ向けの admin へ持ち込むと衝突する（`viewStatus.ts` の
 * `StatusReportView` と同じ理由）。欄が増減したら手で追随させること。
 */
export interface DetectedSensorView {
  readonly boardKey: string
  readonly sensorId: string
  readonly lastPacketMs: number | null
}

/** 声を聞いている基板 1 枚ぶん。 */
export interface DetectedBoard {
  readonly boardKey: string
  /** その基板が名乗っているセンサー ID。**現れた順**（＝音沙汰の新しい順）。 */
  readonly sensorIds: readonly string[]
  /**
   * その基板のいずれかのセンサーから最後に届いた時刻。
   *
   * **一度も読める時刻が無ければ `null`。** `/status` は壊れた時刻を `null` へ
   * 倒して別に数えている（`statusReport.ts` の `unreadableTimes`）ので、
   * ここでも `0` で埋めない——1970 年として読めてしまう。
   */
  readonly lastPacketMs: number | null
}

/**
 * センサー単位の一覧を基板単位へ畳む。
 *
 * **並びは入力のまま。** `/status` の `sensors[]` は音沙汰の新しい順で返る
 * （`sensorHealth.ts` の `snapshot`）ので、いま生きている基板が上へ来る。
 * ここで並べ替えると、その順序が失われる。
 */
export function groupDetectedBoards(
  sensors: readonly DetectedSensorView[],
): readonly DetectedBoard[] {
  const byKey = new Map<string, { sensorIds: string[]; lastPacketMs: number | null }>()
  for (const s of sensors) {
    // **空の基板 Key・センサー ID は候補にしない。** 設定側は空文字を弾く
    // （`stationConfig.ts` の `nonEmptyString`）ので、選べても保存できない。
    if (s.boardKey.length === 0 || s.sensorId.length === 0) continue
    const found = byKey.get(s.boardKey)
    const entry = found ?? { sensorIds: [], lastPacketMs: null }
    if (found === undefined) byKey.set(s.boardKey, entry)
    if (!entry.sensorIds.includes(s.sensorId)) entry.sensorIds.push(s.sensorId)
    if (s.lastPacketMs !== null && (entry.lastPacketMs === null || s.lastPacketMs > entry.lastPacketMs)) {
      entry.lastPacketMs = s.lastPacketMs
    }
  }
  return [...byKey].map(([boardKey, v]) => ({
    boardKey,
    sensorIds: v.sensorIds,
    lastPacketMs: v.lastPacketMs,
  }))
}

/**
 * 換算の自己診断が出した判定の種類（`/status` の `gravity.verdicts[].scale`）。
 *
 * **`gravityCheck.ts` の `ScaleVerdict` を `import type` しない。** あちらは Node 専用の
 * 型を経由するので、ブラウザ向けの admin へ持ち込むと解決できない（上の
 * `DetectedSensorView` と同じ理由）。**値が増減したら手で追随させること** ——
 * 知らない値が来ても `'unknown'` として扱い、提案は出さない形にしてある。
 */
export type RestScaleView =
  | 'ok'
  | 'too-small'
  | 'too-large'
  | 'not-at-rest'
  | 'too-few-samples'
  | 'unreadable'
  | 'unknown'

const KNOWN_SCALES: readonly string[] = [
  'ok',
  'too-small',
  'too-large',
  'not-at-rest',
  'too-few-samples',
  'unreadable',
]

/**
 * センサー 1 個の、最後に閉じた静止窓。
 *
 * **取り付けの向きを直す材料。** 静止している窓の軸ごとの平均は重力ベクトルそのもので、
 * そこから鉛直に対する傾きが出る（`gravityCheck.ts`・REQUIREMENTS.md §16）。
 */
export interface SensorRestWindow {
  readonly boardKey: string
  readonly sensorId: string
  /** 判定を確定した時刻。読めなければ null。 */
  readonly atMs: number | null
  readonly sampleCount: number
  /** 3 軸合成の平均（gal）。 */
  readonly meanGal: number | null
  /** 3 軸合成のばらつき（gal）。**静止していたかはこれで読む。** */
  readonly sdGal: number | null
  /** 軸ごとの平均（gal）。**静止していれば重力ベクトル。** */
  readonly axisMeanGal: Vec3 | null
  readonly scale: RestScaleView
  /** 静止しているのに計測震度が高い。**換算の倍率とは別の異常。** */
  readonly restless: boolean
}

/** `/status` の `gravity.verdicts[]` を読む。**読めない欄は `null` へ倒す。** */
export function readRestWindows(value: unknown): readonly SensorRestWindow[] {
  if (!Array.isArray(value)) return []
  const out: SensorRestWindow[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const v = raw as Record<string, unknown>
    const boardKey = typeof v.boardKey === 'string' ? v.boardKey : ''
    const sensorId = typeof v.sensorId === 'string' ? v.sensorId : ''
    if (boardKey.length === 0 || sensorId.length === 0) continue
    const scale = typeof v.scale === 'string' && KNOWN_SCALES.includes(v.scale) ? v.scale : 'unknown'
    out.push({
      boardKey,
      sensorId,
      atMs: readFinite(v.atMs),
      sampleCount: readFinite(v.sampleCount) ?? 0,
      meanGal: readFinite(v.meanGal),
      sdGal: readFinite(v.sdGal),
      axisMeanGal: readVec3(v.axisMeanGal),
      scale: scale as RestScaleView,
      restless: v.restless === true,
    })
  }
  return out
}

export interface DetectedBoardsSnapshot {
  /**
   * 経過を測る基準の時刻。**受け手の時計ではなくサーバーが答えを作った時刻**
   * （`/status` の `generatedAtMs`）。ブラウザの時計を基準にすると、端末の時計が
   * ずれているだけで「10 分前」と出る（`viewStatus.ts` も同じ基準を使っている）。
   *
   * **読めなければ `null`。受け手の時計へ黙って倒さない。** そうすると「N 秒前」の
   * 表示だけが別の時計を基準にすり替わり、画面は一見正常なまま経過だけが嘘になる。
   * サーバー側は必ず有限の値を入れる（`statusReport.ts` の `generatedAtMs: input.nowMs`）
   * ので、ここが `null` なのは応答の形が変わった合図。
   */
  readonly generatedAtMs: number | null
  readonly boards: readonly DetectedBoard[]
  /**
   * センサーごとの、最後に閉じた静止窓。
   *
   * **まだ窓を 1 つも閉じていないセンサーは出ない**（`gravityCheck.ts` の `snapshot`）。
   * 窓は波形が届いたときにしか閉じないので、黙った基板の判定はそのまま残る ——
   * 古さは `atMs` で読むこと。
   */
  readonly restWindows: readonly SensorRestWindow[]
}

/** `/status` を読んで基板単位へ畳む。**取れなければ投げる**——候補が出ないだけで編集は続けられる。 */
export async function fetchDetectedBoards(): Promise<DetectedBoardsSnapshot> {
  const res = await fetch('/status')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = (await res.json()) as {
    readonly generatedAtMs?: number
    readonly sensors?: readonly DetectedSensorView[]
    readonly gravity?: { readonly verdicts?: unknown }
  }
  const generatedAtMs =
    typeof body.generatedAtMs === 'number' && Number.isFinite(body.generatedAtMs)
      ? body.generatedAtMs
      : null
  if (generatedAtMs === null) {
    // **候補そのものは使えるので投げない。** ただし黙りもしない——応答の形が
    // 変わったことを追える手掛かりをここにしか残せない。
    console.warn('[admin] /status の generatedAtMs が読めない。受信からの経過は出せない')
  }
  return {
    generatedAtMs,
    boards: groupDetectedBoards(body.sensors ?? []),
    restWindows: readRestWindows(body.gravity?.verdicts),
  }
}
