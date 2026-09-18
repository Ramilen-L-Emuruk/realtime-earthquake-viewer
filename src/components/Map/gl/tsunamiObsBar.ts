import type * as maplibregl from 'maplibre-gl'
import type { TsunamiObsBar } from '../../../hooks/useTsunamiLayerData'
import { log } from '../../../utils/logger'

// 津波観測棒（波高バー・TsunamiObsBarsGL）の寸法計算。
//
// バー幅・脚・高さは地図アイコン倍率（設定の `mapIconScale`）で拡縮する。角丸だけは倍率に
// 連動させない——枠線・影と同じ「装飾のヘアライン」の扱いに揃えるため（index.css の方針と同じ）。
//
// 倍率の乗算をここに集約するのは、バー本体・コンテナ・ツールチップ位置が同じ値を見る必要が
// あるため。各所に式を散らすと、片方だけ直したときにバーと吹き出しの位置が静かにズレる。

/** バー本体の幅（px・倍率適用前の基準値）。**色の芯が占める幅**で、白フチは含まない。 */
export const BAR_WIDTH = 6
/** 脚の張り出し（px・同上）。バー下端に台座として左右へ出る。 */
export const BAR_FOOT = 3
/** バー上端・脚の角丸（px）。装飾のため倍率に連動しない。 */
export const BAR_RADIUS = 3
/**
 * 白フチの太さ（px・倍率適用前の基準値）。
 *
 * **なぜ棒に白フチが要るか。** 観測点は海岸線上にあるので、棒は必ず津波予報区の海岸線
 * （`TsunamiLinesGL`）の上に立つ。そして**両者は色の値が一致する**——津波警報の線と 1m 以上の棒が
 * どちらも `#ef4444`、津波予報の線と 0.2m 未満の棒がどちらも `#22d3ee`、注意報の線（`#f59e0b`）と
 * 0.2m 以上の棒（`#f97316`）は見分けが付かない。どちらも気象庁の配色（等級色と観測階級色）なので
 * 色を動かせず、輪郭で分けるしかない。入り組んだ海岸線では太線が折り返して塊になるため、
 * フチが無いと棒の根元がどこから始まっているか読めなくなる。
 *
 * **フチは外側へ引く。** 内側へ引くと色の芯が `BAR_WIDTH` から細り、波高の色が持つ面積が減る
 * （等倍で 6px → 3px）。外側なら芯は `BAR_WIDTH` のまま保たれる。
 *
 * **`BAR_FOOT` の半分にしてあるのは偶然ではない。** 等倍では外形（`BAR_WIDTH + 2 * BAR_RING`）が
 * 脚の幅（`BAR_WIDTH + BAR_FOOT`）と一致し、足元の専有幅が変わらない。到達確認マーカーの
 * 直径（`gl/tsunamiArrivalMarker.ts` の `BADGE_RADIUS`）も同じ 9px なので、地図に並ぶ 3 つの印
 * （棒・到達確認・欠測）の足元がそろう。
 *
 * **画面では 1px へ丸められる。** ブラウザは `border-width` を整数のデバイスピクセルへ丸めるため、
 * 等倍・`devicePixelRatio` 1 の端末では実測 1px になる（外形は `box-sizing: border-box` なので
 * 指定どおり 9px のまま。丸めが効くのはフチと芯の配分だけで、芯が 6px → 7px へ広がる）。
 * 共有カードの描き直しは丸めを受けないので 1.5px で描く——**この 0.5px は画面と画像で一致しない**。
 * 到達確認マーカーも同じ値を同じ書き方（`border` ＋ `box-sizing`）で使っており、そちらも以前から
 * 同じ丸めを受けている。整数へ寄せると「外形と脚の幅が一致する」関係が崩れるので、一致を選んだ。
 */
export const BAR_RING = BAR_FOOT / 2
/** 白フチの色。丸バッジの家族（震度観測点・揺れ検知点・到達確認マーカー）と揃える。 */
export const BAR_RING_COLOR = '#ffffff'
/**
 * 影の色とぼかし（px）。白フチと同じ役割——同色の海岸線の上で印が浮いて見えるようにする。
 *
 * **参照するのは津波の 3 つの印だけ**（この棒・到達確認マーカー・欠測マーカー。それぞれ画面の DOM と
 * 共有カードの描き直しで使うので、定数にしないと同じ数値が 6 箇所に散る）。震度観測点・揺れ検知点・
 * 長周期地震動の印は同じ値を各ファイルのリテラルで持っている——あちらは WebGL のアイコンを焼く側で
 * 経路が違い、寄せるなら丸バッジの家族をまとめて扱う別の作業になる。
 */
export const BADGE_SHADOW_COLOR = 'rgba(0,0,0,0.7)'
export const BADGE_SHADOW_BLUR = 3
/** ツールチップの横オフセット（px）。バーの右脇に出す。倍率に連動しない。 */
export const POPUP_OFFSET_X = 10

export interface BarMetrics {
  /** 色の芯の幅（px）。白フチは含まない。 */
  w: number
  /** 脚の張り出し（px）。 */
  foot: number
  /** 色の芯の高さ（px）。波高に比例する。 */
  barPx: number
  /** 白フチの太さ（px）。芯の外側へ引くので、芯の寸法には影響しない。 */
  ring: number
  /** バー本体の外形幅（px）＝芯の幅 + 左右の白フチ。 */
  outerW: number
  /** バー本体の外形高さ（px）＝芯の高さ + 上端の白フチ（下端は脚に接するのでフチを引かない）。 */
  outerH: number
}

/** 倍率適用後の実寸を返す。 */
export function barMetrics(bar: TsunamiObsBar, iconScale: number): BarMetrics {
  const w = BAR_WIDTH * iconScale
  const barPx = bar.barPx * iconScale
  // **白フチは太らせないが、細らせる。** 太らせないのは枠線・影を装飾のヘアラインとして扱う方針
  // （settings-pwa-spec.md §2「主な項目の補足」。角丸と同じ）。一方、倍率の下限 0.5 では芯が 3px まで
  // 縮むので、太さを保つと外形 6px のうち色が半分しか残らず、フチが主役になってしまう。倍率に
  // 合わせて細らせれば、芯の取り分（外形の 2/3）が倍率によらず一定になる——到達確認マーカーが
  // `MIN_CORE_RATIO` で保っている比と同じ値。
  const ring = BAR_RING * Math.min(1, iconScale)
  return { w, foot: BAR_FOOT * iconScale, barPx, ring, outerW: w + ring * 2, outerH: barPx + ring }
}

/**
 * その寸法で棒を描けるか。
 *
 * **共有カードの描き直し（`drawTsunamiObsBars`）だけが使う。** あちらは「芯とフチを重ねない」ために
 * 外形と芯のパスを自分で組むので、寸法が壊れると**別の絵**に化ける——芯を抜けなければ外形が白一色で
 * 塗られ、波高の色が消えたまま画像に残る。画面側（`TsunamiObsBarsGL` の DOM）は `border` が要素の
 * 内側に収まるので、壊れても「細い棒」にしかならない。だからここで弾くのは画像の側だけで、画面側は
 * 上流の保証（`useTsunamiLayerData` が `OBS_MIN_PX` でクランプし、波高の数値が読めない観測点は
 * 棒にしない）に委ねている。
 *
 * **非有限値を先に確かめる。** `NaN <= 0` は偽なので大小の比較では素通りし、そのまま `roundRect` へ
 * 渡すと Canvas が黙って描画を捨てる（`docs/spec/map-rendering-spec.md` §17 と同じ型の穴）。
 */
export function isDrawableBar(m: BarMetrics): boolean {
  const { w, foot, barPx, ring, outerW, outerH } = m
  if (![w, foot, barPx, ring, outerW, outerH].every((v) => Number.isFinite(v))) return false
  // 芯（色の部分）とフチの帯が両方残ることまで見る。どちらかが潰れると「色の無い白い塊」か
  // 「輪郭の無い棒」になり、**どちらも異常の形では画面に出てこない**（前者は白い棒、後者は
  // 同色の海岸線に溶けた棒として、正常な描画に見える）。
  if (w <= 0 || barPx <= 0 || ring <= 0) return false
  return outerW - ring * 2 > 0 && outerH - ring > 0
}

/**
 * ツールチップの表示位置（バーの中ほどの高さ・右脇）。
 * 縦は負値＝アンカー（バー下端）から上方向。
 */
export function popupOffset(bar: TsunamiObsBar, iconScale: number): [number, number] {
  return [POPUP_OFFSET_X, -barMetrics(bar, iconScale).barPx / 2]
}
/**
 * 観測棒を撮影した画像へ描き足す。
 *
 * バーは `maplibregl.Marker`（DOM 要素）なので **WebGL のキャンバスには写らない**。
 * 共有カードでは撮影後の 2D キャンバスへ同じ形を描き直す（`gl/captureMap.ts` の `drawOverlay`）。
 * 形と不透明度は上記 `updateBarEl` の DOM と対応させてある——片方だけ変えると、画面と画像で
 * 棒の見た目がずれる。
 *
 * 呼ぶのは撮影の同期窓の中だけ。`map.project()` が撮影寸法で答える必要があるため。
 */
export function drawTsunamiObsBars(
  ctx: CanvasRenderingContext2D,
  map: maplibregl.Map,
  scale: number,
  bars: TsunamiObsBar[],
  iconScale: number,
): void {
  if (bars.length === 0) return
  ctx.save()
  // 以降は論理 px で書く（map.project() が返す単位に合わせる）。
  ctx.scale(scale, scale)
  let drawn = 0
  const undrawable: string[] = []
  for (const bar of bars) {
    const p = map.project([bar.lng, bar.lat])
    if (!isOnVisibleSide(map, p, bar)) continue
    const metrics = barMetrics(bar, iconScale)
    // **寸法が壊れた棒は 1 本まるごと飛ばす。** フチだけ・芯だけを描くと、どちらも正常な
    // 描画に見えてしまう（理由と判定の中身は `isDrawableBar`）。
    if (!isDrawableBar(metrics)) {
      undrawable.push(bar.name)
      continue
    }
    const { w, foot, barPx, ring, outerW, outerH } = metrics
    // 脚（下端が観測点。Marker の anchor:'bottom' と揃える）。
    ctx.save()
    ctx.globalAlpha = 0.3
    ctx.shadowColor = BADGE_SHADOW_COLOR
    ctx.shadowBlur = BADGE_SHADOW_BLUR
    ctx.fillStyle = bar.color
    fillRoundRect(ctx, p.x - (w + foot) / 2, p.y - foot, w + foot, foot, [0, 0, BAR_RADIUS, BAR_RADIUS])
    ctx.restore()
    // 本体の白フチ（脚の上に立つ）。
    //
    // **芯とフチを重ねずに描く。** 外形を白で塗ってから芯を重ねると、白の上に色が乗って芯の色が
    // 混ざる（不透明度 0.9 のため下の白が透ける）。DOM 側は 1 つの要素の `border` で描くので
    // 芯に白は混ざらない——重ねると画面と画像で棒の色がずれる。到達確認マーカーが `stroke` で
    // 帯だけを描いているのと同じ理由（`gl/tsunamiArrivalMarker.ts`）。
    ctx.save()
    ctx.globalAlpha = 0.9
    ctx.shadowColor = BADGE_SHADOW_COLOR
    ctx.shadowBlur = BADGE_SHADOW_BLUR
    ctx.fillStyle = BAR_RING_COLOR
    fillRingBand(ctx, p.x - outerW / 2, p.y - foot - outerH, outerW, outerH, ring)
    ctx.restore()
    // 芯（フチの内側）。
    ctx.globalAlpha = 0.9
    ctx.fillStyle = bar.color
    fillRoundRect(ctx, p.x - w / 2, p.y - foot - barPx, w, barPx, [BAR_RADIUS, BAR_RADIUS, 0, 0])
    drawn++
  }
  ctx.restore()
  // **寸法で弾いた分を記録する。** 芯とフチのどちらかが潰れた棒を描くと、白い塊か輪郭の無い棒に
  // なるが**どちらも正常な描画に見える**ので、画像を見ても気づけない。1 本ずつ出すと 1 回の撮影で
  // 数百行になりうるため、件数と見本で 1 行にまとめる。
  if (undrawable.length > 0) {
    log.warn('[shareCard] 寸法が壊れている観測棒を飛ばしました', {
      count: undrawable.length,
      sample: undrawable.slice(0, 3),
      iconScale,
    })
  }
  // **「観測点が無いから描かない」と「観測点はあるのに全部弾かれた」を見分けられるようにする。**
  // 前者はここへ来る前に返しているので、ここで 0 件なら後者——画像から棒が消えた理由が
  // 残らないと、次に同じことが起きたとき手がかりが無い。**弾いた理由は上の記録と併せて読む**
  // （地球の裏側か寸法か、どちらもここへ集まる）。
  if (drawn === 0) {
    log.warn('[shareCard] 観測棒が 1 本も描かれませんでした（地球の裏側と判定された／全件が寸法で弾かれた）', {
      bars: bars.length,
      undrawable: undrawable.length,
    })
  }
}

/**
 * 地球の手前側にある点か。
 *
 * 球投影では `map.project()` が**裏側の点にも画面内の座標を返す**
 * （docs/spec/map-rendering-spec.md §6）。投影して戻す往復で確かめる。
 *
 * 到達確認マーカー（`gl/tsunamiArrivalMarker.ts`）も同じ判定を通す。観測棒と同じ
 * `maplibregl.Marker` で、共有カードでは同じように 2D で描き直すため。
 */
export function isOnVisibleSide(
  map: maplibregl.Map,
  p: { x: number; y: number },
  point: { lat: number; lng: number },
): boolean {
  const back = map.unproject([p.x, p.y])
  return Math.abs(back.lng - point.lng) < VISIBLE_SIDE_TOLERANCE_DEG && Math.abs(back.lat - point.lat) < VISIBLE_SIDE_TOLERANCE_DEG
}

/** 往復の投影で許す誤差（度）。裏側に回った点はこの桁では収まらないほど大きくずれる。 */
const VISIBLE_SIDE_TOLERANCE_DEG = 0.5

/**
 * 角丸の矩形をパスへ足す。`roundRect` を持たない環境では角丸を諦めて矩形で描く
 * （角丸は装飾で、無くても波高の高さは正しく伝わる）。**`beginPath` はしない**——
 * `fillRingBand` が 2 つの矩形を 1 つのパスへ足して差分を取るため。
 */
function addRoundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radii: [number, number, number, number],
): void {
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, radii)
  else ctx.rect(x, y, w, h)
}

/** 角丸の矩形を塗る。 */
function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radii: [number, number, number, number],
): void {
  if (w <= 0 || h <= 0) return
  ctx.beginPath()
  addRoundRectPath(ctx, x, y, w, h, radii)
  ctx.fill()
}

/**
 * 白フチの帯だけを塗る（外形から芯を抜いた領域）。
 *
 * `x`,`y`,`w`,`h` は**外形**（`barMetrics` の `outerW` / `outerH`）。`evenodd` で芯の領域を
 * 抜くので、芯には白が乗らない（上記「芯とフチを重ねずに描く」）。
 *
 * **下端にはフチを引かない**——脚に接する辺で、白線が入ると棒と台座が分断されて見える。
 * DOM 側の `border-bottom-width: 0` と揃えてある。
 *
 * **寸法の検査はしない。** 呼び出し元（`drawTsunamiObsBars`）が `isDrawableBar` で弾いてから呼ぶ。
 * ここで「芯が潰れたら外形だけ塗る」という逃げ道を持つと、**波高の色が消えた白一色の棒**が
 * 正常な描画として画像に残ってしまう（そちらのほうが、描かないより見つけにくい）。
 *
 * 穴を持つ形に影を掛けるので、内周（芯との境）にも理屈の上ではぼかしが回る。**測ったら、芯の
 * 領域で影の有無による差は最大 2/255 だった**（同じ手順を再現して影あり・なしのピクセルを
 * 突き合わせた実測。差が出るのは芯の縁の 1px だけ）。上から芯を塗るため、ほぼ隠れる。
 */
function fillRingBand(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  ring: number,
): void {
  ctx.beginPath()
  addRoundRectPath(ctx, x, y, w, h, [BAR_RADIUS, BAR_RADIUS, 0, 0])
  addRoundRectPath(ctx, x + ring, y + ring, w - ring * 2, h - ring, [BAR_RADIUS, BAR_RADIUS, 0, 0])
  ctx.fill('evenodd')
}
