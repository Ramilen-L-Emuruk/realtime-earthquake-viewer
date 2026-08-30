// カメラが動くたびに MapLibre が行う「地形めり込み補正」を、地形を使っていない構成では省く。
//
// MapLibre のカメラ更新は、毎フレーム `Camera.applyUpdatedTransform` を通る。この関数は
// カメラが 3D 地形にめり込んだ場合に持ち上げるためのもので、中身はこう動く。
//
//   1. カメラ状態（transform）を丸ごと複製する
//   2. もう一度複製する
//   3. 補正を求める —— 地形が無ければ「直すところは無い」が返る
//   4. 複製へ書き戻す
//   5. 本体へ書き戻す
//
// 3 で何も返らない場合、1・2・4・5 は元と同じ値を作り直しているだけになる。しかも書き戻しの
// たびに投影行列が一式組み直され、球投影ではその単価が高い（球・メルカトル両方の変換を更新する
// ため）。実測では飛行 1 フレームあたりの行列再計算が 7.1 回から 3.8 回へ減った。
//
// 対象は飛行だけではない。手動のドラッグ・ズーム、EEW 追従、津波の俯瞰帰還など、カメラが動く
// 経路はすべてここを通る。
//
// **省略してよい条件は MapLibre 側の早期 return と同じもの**で、呼び出しごとに確かめる。
//   - 地形を使っていない（`terrain` が無い）
//   - `transformCameraUpdate`（利用側が差し込むカメラ補正）が無い
//   - 渡された transform が本体そのもの —— 上 2 つが無いとき MapLibre は複製ではなく本体を渡す
//   - 標高が 0 以上・傾きが 90 度以下 —— 補正が「直すところは無い」を返す条件
//
// **加えて、本物を走らせて前後の状態が一致することを実際に確かめる。** 上の条件は MapLibre
// 6.0.0 の実装を読んで導いたもので、将来のバージョンで補正の中身が変わればこの前提は崩れる。
// 隣のテストは擬似のカメラを相手にこの処理自身の分岐を見るもので、**MapLibre 本体の挙動が
// 変わったかどうかは見られない**（このコードベースに実物の地図を組み立てるテストは無い）。
// 崩れたことに気づけるのは動いているアプリ自身だけなので、一致しなければ二度と省略しない。
//
// **確認は起動直後だけでなく、以後も一定間隔で続ける。** `package.json` の依存指定は
// `^6.0.0` なので MapLibre のマイナー更新が自動で入る。仮に補正の条件が 1 つ増えても、
// 起動直後の数回でたまたま空振りなら確認を通過してしまい、そのまま気づかず省き続けることになる。
//
// **この確認が見張れるのは transform の観測できる状態だけ。** 「transform の値は変えないが
// カメラや地図の別の状態を書き換える」という形の変更が将来入った場合、前後の写しは一致し続ける
// ため見逃す。MapLibre のバージョンを上げるときは実装差分の目視確認が要る
// （docs/spec/map-rendering-spec.md §6「カメラ更新の空振りを省く」）。

import type { Map as MapLibreMap } from 'maplibre-gl'
import { log } from '../../../utils/logger'

/** 省略に切り替える前に、本物を走らせて状態の一致を確かめる回数。 */
const VERIFY_CALLS = 8

/**
 * 省略に入ったあと、あらためて本物と突き合わせる間隔（省略できた回数で数える）。
 *
 * 飛行中は 1 秒あたり数十回この関数を通るため、500 回はおよそ十数秒の連続操作にあたる。
 * 500 回に 1 回だけ本物を走らせる負荷は 0.2% 程度で、見張りを恒久的に残す対価としては安い。
 */
const REVERIFY_INTERVAL = 500

/**
 * 一致の判定に使う transform の数値。**GlobeTransform で実際に読める項目だけを挙げる**
 * （`pixelMatrix` などは球投影では null を返すため、入れると常に一致してしまい検査が骨抜きになる）。
 */
const SCALAR_KEYS = [
  'zoom',
  'bearing',
  'pitch',
  'roll',
  'elevation',
  'nearZ',
  'farZ',
  'cameraToCenterDistance',
  'scale',
  'worldSize',
] as const

/**
 * 一致の判定に使う行列・ベクトル。
 *
 * **回転行列（`rotationMatrix`）は入れない。** これは地図を一度でも回すまで作られず（MapLibre は
 * 方位が実際に変わったときにだけ生成する）、回さない使い方では永久に揃わないため、検査が
 * いつまでも始まらない。そもそも書き戻し（`apply`）はこのフィールドに触れず、値は方位から
 * 一意に決まる。その方位は上の一覧に入っているので、外しても見落としは生じない。
 */
const ARRAY_KEYS = [
  'modelViewProjectionMatrix',
  'projectionMatrix',
  'inverseProjectionMatrix',
  'pixelsToClipSpaceMatrix',
  'clipSpaceToPixelsMatrix',
  'pixelsToGLUnits',
] as const

/** 一致の判定に使う中心座標。写しの上ではこの名前で持つ。 */
const CENTER_KEYS = ['lng', 'lat'] as const

/** 検査が意味を持つために最低限そろっていてほしい項目数。 */
const REQUIRED_SNAPSHOT_KEYS = SCALAR_KEYS.length + ARRAY_KEYS.length + CENTER_KEYS.length

/**
 * 状態を読み切れない呼び出しを見送る上限。
 *
 * 地図の組み立て中は行列がまだ埋まっていない段階の呼び出しがあり、そこで検査すると項目が
 * 足りない。**足りない 1 回で見限ってはいけない**（数フレーム後には揃う）。一方で、読めない
 * 形が恒久的に続くなら検査は永久に成立しないので、その場合は諦めて記録を残す。
 */
const MAX_SNAPSHOT_SHORTFALLS = 200

/** MapLibre の内部形（型定義には現れない）。読み取りは全て存在確認を通す。 */
type CameraTransform = {
  readonly elevation?: unknown
  readonly pitch?: unknown
  readonly center?: { lng?: unknown; lat?: unknown }
}

type InternalCamera = {
  transform?: CameraTransform
  terrain?: unknown
  transformCameraUpdate?: unknown
  applyUpdatedTransform?: (tr: CameraTransform) => void
}

type MapWithCamera = MapLibreMap & { _camera?: InternalCamera }

/** 省略の効き具合。ブラウザから読んで診断するためのもの。 */
export type CameraUpdateSkipStatus = {
  /** いま省略に入っているか。 */
  engaged: boolean
  /** 前提が崩れて省略をやめたか。 */
  disabled: boolean
  /** 本物と突き合わせて一致を確かめた回数。 */
  verified: number
  /** 状態を読み切れず検査を見送った回数。 */
  shortfalls: number
  /** 省略できた回数。 */
  skipped: number
}

/**
 * transform の観測できる状態を平たい文字列表に写す。
 *
 * 読めなかった項目は**入れない**。呼び出し側は項目数が揃っているかを見て、検査が骨抜きに
 * なっていないことを確かめる（読めない項目を「一致」として数えると、実装が変わったときに
 * 検査が素通りする）。
 */
function snapshot(tr: CameraTransform): Map<string, string> {
  const out = new Map<string, string>()
  const src = tr as unknown as Record<string, unknown>
  for (const key of SCALAR_KEYS) {
    const v = src[key]
    if (typeof v === 'number' && Number.isFinite(v)) out.set(key, String(v))
  }
  for (const key of ARRAY_KEYS) {
    const v = src[key]
    // 行列は gl-matrix の Float64Array（`pixelsToGLUnits` だけ素の配列）。`ArrayBuffer.isView`
    // では DataView も通り、それは length を持たないので黙って空文字列になる。型を名指しする。
    if (v instanceof Float64Array || v instanceof Float32Array) out.set(key, Array.from(v).join(','))
    else if (Array.isArray(v)) out.set(key, v.join(','))
  }
  const center = tr.center
  if (center && typeof center.lng === 'number' && typeof center.lat === 'number') {
    out.set('lng', String(center.lng))
    out.set('lat', String(center.lat))
  }
  return out
}

/** 2 つの写しが同じ内容かを見る。項目の増減も不一致として扱う。 */
function sameSnapshot(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

/**
 * 地形を使っていない構成での「何も変えないカメラ更新」を省く。
 *
 * @param map 対象の地図
 * @returns `restore` は元へ戻す関数（地図を捨てるときに呼ぶ。差し替えが自分のものであるときだけ戻す）。
 *   `status` は効き具合を読む関数で、診断用に `window.__cameraUpdateSkip` からも呼べる
 */
export function installNoopCameraUpdateSkip(map: MapLibreMap): {
  restore: () => void
  status: () => CameraUpdateSkipStatus
} {
  const camera = (map as MapWithCamera)._camera
  const original = camera?.applyUpdatedTransform
  if (!camera || typeof original !== 'function') {
    // MapLibre の内部形が変わった。省略はできないが、地図は普通に動く。
    log.warn('[JapanMapGL] カメラ更新の空振り省略を適用できませんでした（MapLibre の内部形が想定と異なる）')
    const never: CameraUpdateSkipStatus = { engaged: false, disabled: true, verified: 0, shortfalls: 0, skipped: 0 }
    return { restore: () => {}, status: () => never }
  }

  // 省略してよいと確かめられた回数。VERIFY_CALLS に達したら省略に入る。
  let verified = 0
  // 一致しなかった＝前提が崩れた。以後は一切省略しない。
  let disabled = false
  // 状態を読み切れず検査を見送った回数。
  let shortfalls = 0
  // 省略できた回数。
  let skipped = 0
  // 最後に検査してからの省略回数。REVERIFY_INTERVAL に達したらもう一度突き合わせる。
  let sinceVerify = 0
  // 検査した相手の transform。**差し替わったら確認をやり直す** —— MapLibre は style の投影が
  // 決まる時点で transform 自体を別の実装（メルカトル ↔ 球）へ挿げ替えるため、前の実体で
  // 得た確認をそのまま新しい実体へ持ち越してはいけない。
  let verifiedAgainst: CameraTransform | null = null

  /** 本物を走らせ、前後の状態が一致するかを確かめる。省略してよければ true。 */
  const verify = (self: InternalCamera, tr: CameraTransform): void => {
    const before = snapshot(tr)
    if (before.size < REQUIRED_SNAPSHOT_KEYS) {
      // まだ状態が出そろっていない。この回は検査に数えず、そのまま本物へ通す。
      original.call(self, tr)
      shortfalls++
      if (shortfalls >= MAX_SNAPSHOT_SHORTFALLS) {
        disabled = true
        log.warn('[JapanMapGL] カメラ更新の空振り省略を無効にしました（transform から状態を読み切れない）', {
          読めた項目数: before.size,
          必要: REQUIRED_SNAPSHOT_KEYS,
        })
      }
      return
    }
    original.call(self, tr)
    const after = snapshot(tr)
    if (!sameSnapshot(before, after)) {
      disabled = true
      log.warn('[JapanMapGL] カメラ更新の空振り省略を無効にしました（省略できない更新でした）')
      return
    }
    verified++
    sinceVerify = 0
  }

  const patched = function (this: InternalCamera, tr: CameraTransform): void {
    const skippable =
      !disabled &&
      !this.terrain &&
      !this.transformCameraUpdate &&
      tr === this.transform &&
      typeof tr.elevation === 'number' &&
      tr.elevation >= 0 &&
      typeof tr.pitch === 'number' &&
      tr.pitch <= 90
    if (!skippable) {
      original.call(this, tr)
      return
    }
    if (verifiedAgainst !== tr) {
      verifiedAgainst = tr
      verified = 0
      sinceVerify = 0
    }
    if (verified < VERIFY_CALLS || sinceVerify >= REVERIFY_INTERVAL) {
      verify(this, tr)
      return
    }
    skipped++
    sinceVerify++
  }

  camera.applyUpdatedTransform = patched
  const status = (): CameraUpdateSkipStatus => ({
    engaged: !disabled && verified >= VERIFY_CALLS,
    disabled,
    verified,
    shortfalls,
    skipped,
  })
  return {
    restore: () => {
      if (camera.applyUpdatedTransform === patched) camera.applyUpdatedTransform = original
    },
    status,
  }
}
