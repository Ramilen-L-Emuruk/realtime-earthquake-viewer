// 問い合わせ文字列の値を読む小道具（`statusServer.ts`・`waveRecordsApi.ts` が共有する）。

/** 波形を落とす列の数の上限（`/waves` と `/api/records/*` で共通）。画面の横幅より多く要る用途は無い。 */
export const COLUMNS_MAX = 4096

/**
 * 10 進の整数だけを通す。**`Number()` に任せない** —— あれは `0x10` も空文字も受ける
 * （`main.ts` の `DECIMAL_PORT_RE` と同じ判断）。時刻は 13 桁なので 16 桁まで許す。
 */
const DECIMAL_INT_RE = /^-?\d{1,16}$/

export function decimalInt(raw: string | null): number | null {
  if (raw === null || !DECIMAL_INT_RE.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) ? n : null
}
