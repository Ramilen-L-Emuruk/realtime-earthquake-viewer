// 保存の置き場所を日本時間で切るための下駄。
//
// **プロセスの時間帯設定（`TZ`）は読まない。** `getDate()` の類はホストの設定で答えが
// 変わるので、別の機械へ移した日や CI（UTC で回る）を境に、同じ名前のファイルが別の
// 24 時間を指すようになる。ずれても例外は出ず、**ファイル名だけが黙って 9 時間ずれる**。
//
// 日本時間を選んだのは、このリポジトリが既に「1 日＝日本時間の日」と決めているため
// （長期震源カタログの `fromMs`/`toMs`。あちらも `Date.UTC` で組んでから引く形で `TZ` を避けている）。
// 突き合わせる相手（気象庁の電文）も日本時間で、揺れているのは日本の家。
//
// **生データ（`mseedStore.ts`）と合成波形（`waveArchive.ts`）で同じ下駄を使う**（どちらも時ごと）。
// 別々に持つと、片方だけ時間帯の扱いを変えたときに同じ瞬間が別の日付に属することになり、
// 生と合成を突き合わせる側からは理由の分からないずれとして現れる。

import { MAX_TIME_MS } from '../protocol/parsePacket'

/** 日本時間の下駄。 */
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000

/**
 * 時刻として表せるか。**有限なだけでは足りない** —— 下駄を足した結果が `Date` の範囲を
 * 出ると `toISOString()` が投げる。
 */
function representable(ms: number): boolean {
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_TIME_MS - JST_OFFSET_MS
}

/**
 * 日本時間でのその日（`YYYY-MM-DD`）。
 *
 * **時刻として表せない値では `null` を返す。** 名前を作れない以上、呼び出し側は
 * 「回さない」を選ぶしかない（当て推量の名前でファイルを分けるより、同じ本へ書き続けるほうがまし）。
 */
export function jstDay(ms: number): string | null {
  if (!representable(ms)) return null
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * 日本時間でのその時（`YYYY-MM-DDTHH`）。**`jstDay` の頭に時を足しただけ**なので、
 * 先頭 10 文字はその日の `jstDay` と必ず一致する。
 *
 * 返す値にコロンは入らない（`toISOString` の 13 文字目までを採る）—— Windows の
 * ファイル名に使えない文字を含まないことが、この切り出し位置の条件。
 */
export function jstHour(ms: number): string | null {
  if (!representable(ms)) return null
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 13)
}

/**
 * 日本時間の日時（`YYYY-MM-DD HH:MM:SS`）。**ログへ書く人向け。** ファイル名には使わない
 * （コロンを含む）。
 */
export function jstDateTime(ms: number): string | null {
  if (!representable(ms)) return null
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * その時の始まり（unix ミリ秒）。**`jstHour` の逆。**
 *
 * 読み返しが「範囲の端が属する時」から「どのファイルを開くか」を数えるのに使う。
 * **時の並びを文字列の足し算で作らない** —— 日をまたぐたびに桁上がりを自前で解くことになる。
 */
export function jstHourStartMs(ms: number): number | null {
  if (!representable(ms)) return null
  const HOUR_MS = 60 * 60 * 1000
  return Math.floor((ms + JST_OFFSET_MS) / HOUR_MS) * HOUR_MS - JST_OFFSET_MS
}
