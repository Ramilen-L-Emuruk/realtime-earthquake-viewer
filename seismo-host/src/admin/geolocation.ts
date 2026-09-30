// 観測点の座標を現在地から入れる。
//
// **ブラウザの位置情報は secure context でしか動かない。** `navigator.geolocation`
// そのものは素の HTTP でも生えているので、確かめずにボタンを出すと「押しても
// 何も起きない」だけになる。**このホストはまだ HTTPS で配信していない**
// （REQUIREMENTS.md §13 の Tailscale Serve は方式を決めただけで未実装）ので、
// tailnet の IP で開いた画面では使えないまま——理由を先に出す。

/** 位置情報が使えるかを見るのに要る分だけ。**テストで作れる形にする**ため `Window` を直に取らない。 */
export interface GeolocationScope {
  readonly isSecureContext: boolean
  readonly navigator: { readonly geolocation?: unknown }
}

export type GeolocationAvailability =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

export function checkGeolocationAvailability(scope: GeolocationScope): GeolocationAvailability {
  if (scope.navigator.geolocation === undefined || scope.navigator.geolocation === null) {
    return { ok: false, reason: 'このブラウザは位置情報に対応していない' }
  }
  if (!scope.isSecureContext) {
    // **「HTTPS か localhost」まで書く。** 「使えない」だけだと、運用者は
    // ブラウザの権限設定を疑って時間を使う（原因はアクセスした URL のほう）。
    return { ok: false, reason: '位置情報は HTTPS か localhost でしか使えない（手で入力すること）' }
  }
  return { ok: true }
}

/**
 * 座標を小数 6 桁（約 0.1 m）へ丸める。
 *
 * **倍精度の全桁を入れない。** 欄に 17 桁が並ぶうえ、位置情報の誤差は良くても
 * 数 m なので、下の桁は測っていない値を測ったように見せるだけ。
 */
export function roundCoord(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/** 位置情報の取得が失敗した理由を日本語にする。 */
export function describeGeolocationError(error: { readonly code: number }): string {
  switch (error.code) {
    case 1:
      return '位置情報の利用を許可されていない（ブラウザの設定を確認すること）'
    case 2:
      return '現在地を特定できない'
    case 3:
      return '現在地の取得が時間内に終わらなかった'
    default:
      return '現在地を取得できない'
  }
}

/**
 * 測位の誤差を添える。
 *
 * **これを出さないと、Wi-Fi 測位の数百 m を実測値として信じてしまう。**
 * 観測点の座標は地図の表示位置になるので、ずれたまま気づかないと
 * 「地図に出ている場所」と「実際に置いた場所」が食い違う。
 */
export function describeAccuracy(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return '精度は不明'
  if (meters >= 1000) return `誤差およそ ±${Math.round(meters / 100) / 10} km`
  return `誤差およそ ±${Math.round(meters)} m`
}
