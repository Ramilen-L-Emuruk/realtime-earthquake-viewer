// 外から来た JSON を、形が違っても落ちない形で読む道具。
//
// **`/status` も `/stream` も、形が変わりうる相手。** どちらもホスト側の型を
// そのまま持ってこられない（Node 専用の型を経由しているため。`viewStatus.ts` の
// `StatusReportView` が言う事情）ので、admin 側は**手で書いた形に合うかを自分で見る**
// ほかない。
//
// **同じ判断を 2 箇所に置かない。** 数として読めるかの見方が別々にあると、
// 片方だけ直った状態が生まれる —— 症状は「ある画面でだけ値が出ない」で、
// どちらが正しいのか読む手掛かりが無い。

import type { Vec3 } from '../receiver/stationConfigTypes'

/** 数として読めるものだけ通す。**`null`・文字列・`NaN`・無限は通さない。** */
export function readFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 中身のある文字列だけ通す。 */
export function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 3 つ組として読めるものだけ通す。 */
export function readVec3(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length !== 3) return null
  if (!value.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  return [value[0] as number, value[1] as number, value[2] as number]
}

/**
 * 数の並びとして読めるものだけ通す。**1 つでも読めなければ `null`。**
 *
 * **読めない点だけを飛ばして繋がない。** 波形の途中の 1 点を抜いて前後を詰めると、
 * **そこだけ時間が縮んだ波形**になる —— 絵としては普通に見えるので、
 * 見ている人には確かめる手立てが無い。
 */
export function readFiniteArray(value: unknown): readonly number[] | null {
  if (!Array.isArray(value)) return null
  for (const n of value) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return null
  }
  return value as readonly number[]
}
