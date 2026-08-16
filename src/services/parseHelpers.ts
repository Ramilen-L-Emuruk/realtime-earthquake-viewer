// 外部 API のレスポンスを内部型へ組み立てるときの値取り出しヘルパ。
// DMDATA.JP の JSON 電文（dmdataParser.ts）と P2PQuake API v2（p2pquake.ts）で共用する。
//
// 外部データは信頼しない。型が合わない値は「無かったこと」にできる無害な既定値
// （空文字・空オブジェクト・空配列・NaN）へ寄せ、呼び出し側が必須判定・センチネル変換を行う。
// 例外を投げないのは、1 フィールドの不整合で電文 1 通が丸ごと落ちるのを避けるため。

/** 数値として読む。取れない場合は NaN（`Number.isFinite()` で判定して既定値へ寄せる）。 */
export function parseNum(v: unknown): number {
  if (v === null || v === undefined) return NaN
  return Number(v)
}

/** 文字列として読む。文字列でなければ空文字（`|| undefined` で optional に落とせる）。 */
export function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** オブジェクトとして読む。配列・null・プリミティブは空オブジェクトに落とす（ネスト参照を安全にする）。 */
export function obj(v: unknown): Record<string, unknown> {
  return (typeof v === 'object' && v !== null && !Array.isArray(v))
    ? (v as Record<string, unknown>)
    : {}
}

/** 配列として読む。配列でなければ空配列（`for...of` を安全にする）。 */
export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}
