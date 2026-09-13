// `stationSource.mjs` の型宣言。**実装は JS 側が正**で、ここはそれを TypeScript から
// 呼ぶための宣言だけ。
//
// 実装を .ts へ移していないのは、`build-station-coords.mjs` が素の node で動かす規定
// （`node scripts/build-station-coords.mjs`）で、そちらから import できる形を保つため。

/** 上流の観測点一覧の 1 件。**中身は上流が決める**ので、使う側が必要な分だけ見る。 */
export interface UpstreamStation {
  readonly name?: string
  readonly furigana?: string
  readonly pref?: { readonly name?: string }
  readonly area?: { readonly name?: string }
  readonly lat?: number
  readonly lon?: number
}

/** 震度観測点一覧の取得元（リビジョン固定）。 */
export const STATION_SOURCE_URL: string

/** 現行の観測点として受け入れる件数の幅。 */
export const LISTED_COUNT_RANGE: { readonly min: number; readonly max: number }

/** 中身を読めたリビジョンの下限。 */
export const MIN_READABLE_REVISIONS: number

/** 観測点の鍵（"都道府県|観測点名"）。名前か都道府県が無ければ null。 */
export function stationKeyOf(station: UpstreamStation | null | undefined): string | null

/** 固定リビジョンの観測点一覧を取る。件数が想定の幅を外れたら投げる。 */
export function fetchListedStations(): Promise<UpstreamStation[]>

/**
 * 現行の一覧に無い観測点を上流のリビジョン履歴から集める。
 *
 * 固定リビジョンが一覧に無い・読めた版が下限を割った場合は投げる。
 */
export function collectUnlistedStations(
  listed: ReadonlySet<string>,
): Promise<Map<string, UpstreamStation>>
