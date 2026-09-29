// 自作地震計ホストの接続状態を、設定タブに出す 1 行へ直す。
//
// **繋がらない理由を 1 つへ潰さない。** 設定はトグルと URL の 2 つなので、
// 繋がらない状態が「切っている」「URL が空」「URL の形が違う」「ホストが応えない」の
// 4 通りある。ここを「繋がりません」の一語にすると、利用者は何を直せばよいか
// 分からない —— トグルを持つ形にした代償はここで払う（`useSettings.ts` の
// `seismoEnabled` の説明）。
//
// **文の形は `{状態}（{行動または内訳}）`。** 主節は言い切りで、括弧の中に
// 何をすればよいか（または内訳）を入れる（`docs/spec/settings-pwa-spec.md`
// §5.5「通知の文の形」）。狭いパネルで折り返しても何本出ているか読める。

import type { SeismoHostCheck } from '../../services/seismoStream'

/**
 * 画面に出す前の状態。**`SeismoHostCheck` に、通信する手前で決まる 4 つを足したもの。**
 *
 * **`ok` の枝は、画面が読む 3 つだけを `Pick` で取る。** `SeismoHostCheck` の `ok` を
 * そのまま並べると、あちらへ項目が増えるたびにこのファイルの試験まで直すことに
 * なる（作る側が全部の項目を埋めさせられる）—— 画面が読むのは観測点の一覧と
 * センサーの数だけで、押し出しを寄せるための割り当ては使わない。
 */
export type SeismoUiStatus =
  /** トグルが切れている。 */
  | { readonly kind: 'disabled' }
  /** URL が空。 */
  | { readonly kind: 'no-url' }
  /** URL の形が違う（スキームの書き忘れなど）。 */
  | { readonly kind: 'invalid' }
  /** 問い合わせている途中。 */
  | { readonly kind: 'checking' }
  | Pick<Extract<SeismoHostCheck, { kind: 'ok' }>, 'kind' | 'stations' | 'sensorCount'>
  | Exclude<SeismoHostCheck, { kind: 'ok' }>

export type SeismoStatusTone = 'ok' | 'problem' | 'muted'

export interface SeismoStatusLine {
  readonly text: string
  readonly tone: SeismoStatusTone
}

/**
 * 状態を 1 行へ直す。
 *
 * **失敗の詳細（`detail`）は画面へ出さない。** `fetch` が返す文面
 * （`Failed to fetch` 等）は利用者の行動に繋がらないので、代わりに
 * 「何を確かめればよいか」を書く。詳細は記録へ出る（`seismoStream.ts`）。
 */
export function seismoStatusLine(status: SeismoUiStatus): SeismoStatusLine {
  switch (status.kind) {
    case 'disabled':
      return { text: '—', tone: 'muted' }
    case 'no-url':
      return { text: 'URLが未入力です（ホストのURLを入力）', tone: 'muted' }
    case 'invalid':
      return { text: 'URLの形式が正しくありません（http:// または https:// から入力）', tone: 'problem' }
    case 'checking':
      return { text: '確認中...', tone: 'muted' }
    case 'ok':
      // **0 件のときは別の文にする。** 「接続できました（観測点 0・センサー 0）」は、
      // 文字だけ見ると成功か異常か判らない —— ホストは動いているが観測点の設定が
      // まだ、という状態なので、次にすることを書く。
      if (status.stations.length === 0) {
        return { text: '接続できました（観測点はまだ設定されていません）', tone: 'ok' }
      }
      // **観測点とセンサーの本数を出す。** 「繋がった」だけでは、繋いだ先が
      // 自分の意図したホストかを確かめられない。
      return {
        text: `接続できました（観測点 ${status.stations.length}・センサー ${status.sensorCount}）`,
        tone: 'ok',
      }
    case 'unreachable':
      // **括弧の中は 1 つに絞る。** ホーム画面から開く前提は、この行の上にある
      // 常時表示の但し書き（「要：ホーム画面に追加してから開く」）が受け持つ ——
      // 両方に書くと括弧の中が 2 つの確認事項で膨らみ、狭いパネルで折り返して
      // 何本出ているか読めなくなる（`settings-pwa-spec.md` §5.5「通知の文の形」）。
      return { text: '応答がありません（ホストが起動しているか確認）', tone: 'problem' }
    case 'http-error':
      return { text: `応答がエラーでした（HTTP ${status.status}）`, tone: 'problem' }
    case 'unreadable':
      return { text: '応答を読めませんでした（別のサーバーが応答している可能性）', tone: 'problem' }
  }
}

export const SEISMO_STATUS_TONE_CLASS: Record<SeismoStatusTone, string> = {
  ok: 'text-green-400',
  problem: 'text-red-400',
  muted: 'text-secondary',
}
