// 揺れの記録を範囲で読み返すときの決まり。**ホスト（`shakeEventStore.ts`・`GET /events`）と管理コンソール
// （`admin/shakeHistory.ts`）で同じものを使う。** 画面側が別の値を持つと、最長の期間だけ
// `400 range-too-wide` で断られる。また画面は「ホストがどのファイルを見直したか」から、読めなかった
// 記録の目印を消してよいかを決めるので、見直す範囲の決め方もここで共有する。
//
// 保存部品は Node の `fs` を読み込むのでブラウザからは引けない。決まりだけをここへ切り出してある。

import { JST_OFFSET_MS } from '../receiver/jstTime'

/** 読み返す範囲の上限（ミリ秒）。掛かる月の記録を全部読むので、際限なく広げさせない。 */
export const EVENT_RANGE_MAX_MS = 93 * 24 * 3_600_000

/** 日本時間の年月（`YYYY-MM`）。揺れの記録はこの月のディレクトリへ置く。 */
export function jstMonth(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 7)
}

/** `[fromMs, toMs)` に掛かる日本時間の月（古い順）。 */
export function monthsBetween(fromMs: number, toMs: number): string[] {
  const out: string[] = []
  let month = jstMonth(fromMs)
  const last = jstMonth(Math.max(fromMs, toMs - 1))
  for (let guard = 0; guard < 1200; guard++) {
    out.push(month)
    if (month === last) break
    const [y, m] = month.split('-').map(Number)
    month = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
  }
  return out
}

/**
 * 記録の `id` から揺れの始まりを読む。**読めなければ null。**
 *
 * `id` は `<stationId>-<始まりを整数へ丸めた値>`（`shakeEvent.ts` の `initialRecord`）。
 * **丸めてあるので、中身の `startMs` とは 0.5 ミリ秒未満ずれうる**（範囲との比べ方は下の 2 つ）。
 */
export function startMsFromEventId(id: string): number | null {
  const m = /-(\d{1,16})$/.exec(id)
  if (m === null) return null
  const n = Number(m[1])
  return Number.isSafeInteger(n) ? n : null
}

/**
 * ファイル名から揺れの始まりを読む。**読めなければ null**（開いて確かめる）。
 * 名前は `eventFileName(id)` で、数字と `-` は逃がさないので、末尾の `-<数字>.json` がそのまま `id` の末尾になる。
 */
export function startMsFromFileName(name: string): number | null {
  return name.endsWith('.json') ? startMsFromEventId(name.slice(0, -'.json'.length)) : null
}

/** 名前の始まり（丸めた値）と中身の始まりのずれの上限に、余裕を足したもの。 */
const NAME_START_SLACK_MS = 1

/**
 * 名前の始まりから見て、**中身の始まりが範囲 `[fromMs, toMs)` に入りうるか**。偽なら開かずに飛ばしてよい。
 * 丸めのずれを見込んで、範囲の両端を 1 ミリ秒ずつ外へ広げて比べる —— 端の内側で始まった揺れを、
 * 名前が外を名乗るというだけで取りこぼさない。
 */
export function nameMayStartInRange(nameStartMs: number, fromMs: number, toMs: number): boolean {
  return nameStartMs >= fromMs - NAME_START_SLACK_MS && nameStartMs < toMs + NAME_START_SLACK_MS
}

/**
 * 名前の始まりから見て、**中身の始まりが範囲 `[fromMs, toMs)` に確実に入るか**。真なら、その範囲の読み返しは
 * 必ずその記録を開いて見直す（画面が古い目印を「直った」として外してよいのはこのときだけ）。
 * 両端を 1 ミリ秒ずつ内へ狭めて比べる。
 */
export function nameSurelyStartsInRange(nameStartMs: number, fromMs: number, toMs: number): boolean {
  return nameStartMs >= fromMs + NAME_START_SLACK_MS && nameStartMs < toMs - NAME_START_SLACK_MS
}
