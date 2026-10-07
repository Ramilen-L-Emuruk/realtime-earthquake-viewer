// 地震検出の状態を文にするときの言い方。**ホストのログ（1 時間に 1 度の行・`stationDetection.ts`）と
// 管理コンソール（揺れの記録タブの見張りの行・`admin/shakeHistory.ts`）で共有する。**
//
// **同じ事実を 2 通りに書かない。** 片方だけ言い回しや丸め方を変えると、ログと画面で
// 同じ状態が違う言葉に見え、どちらを信じればよいか分からなくなる。
//
// ブラウザでも読むので、Node 専用のものを持ち込まない。

import { JST_OFFSET_MS } from '../receiver/jstTime'

/**
 * 検出器が最後にサンプルを使えてから（ホストの時計で）これだけ経っていたら「波形が届いていない」と
 * 書く（ミリ秒）。
 *
 * **短い途切れは拾わなくてよい**（途切れは `resets` と毎分の要約が拾う）。合成波形は 0.3 秒ごとに
 * 届くので、1 分来なければ止まっていると言える。
 */
export const SILENT_AFTER_MS = 60_000

/** 日本時間の `HH:MM`。`nowMs` と日本時間の日付が違えば `MM/DD HH:MM`。 */
export function jstClock(ms: number, nowMs: number): string {
  const d = new Date(ms + JST_OFFSET_MS)
  const now = new Date(nowMs + JST_OFFSET_MS)
  const two = (n: number): string => String(n).padStart(2, '0')
  const hm = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`
  const sameDay =
    d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth() && d.getUTCDate() === now.getUTCDate()
  return sameDay ? hm : `${two(d.getUTCMonth() + 1)}/${two(d.getUTCDate())} ${hm}`
}

/**
 * 平常時の揺れの見せ方。**0 と 0.01 未満を分ける** —— 小数 2 桁へ丸めるだけだと、平らな値しか
 * 来ていない（センサーが動いていない）のと、ごく静かなのが同じ「0.00」に見える。
 */
export function formatBaseline(gal: number | null): string {
  if (gal === null || !Number.isFinite(gal)) return '不明'
  if (gal === 0) return '0 gal'
  if (gal < 0.01) return '0.01 gal 未満'
  return `${gal.toFixed(2)} gal`
}

/** 状態の語に要る欄だけ（`StationTriggerStatus` の一部）。 */
export interface TriggerStateFields {
  readonly inEvent: boolean
  readonly armed: boolean
  readonly warmUntilMs: number | null
  readonly lastSampleMs: number | null
}

/**
 * いまの状態の語。「揺れを記録中」「見張り中」「助走中（あと N 秒）」。
 *
 * **助走が明ける時刻を持たないのは、フィルタを組めずに待っているとき。** 残り秒数は言えないので
 * 「助走中」だけにする（「あと 0 秒」と書くと、もうすぐ明けるように読める）。
 */
export function triggerStateWord(s: TriggerStateFields): string {
  if (s.inEvent) return '揺れを記録中'
  if (s.armed) return '見張り中'
  const warmLeft =
    s.warmUntilMs !== null && s.lastSampleMs !== null
      ? `（あと ${Math.max(0, Math.round((s.warmUntilMs - s.lastSampleMs) / 1000))} 秒）`
      : ''
  return `助走中${warmLeft}`
}
