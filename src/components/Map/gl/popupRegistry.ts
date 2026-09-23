import * as maplibregl from 'maplibre-gl'
import type { Map as MapLibreMap, MapMouseEvent, MapGeoJSONFeature, PointLike } from 'maplibre-gl'
import { log } from '../../../utils/logger'
import { reportRenderFailure, clearRenderFailure } from '../../../utils/renderHealth'

// 地図上のポップアップを一元調停する。1クリックにつき必ず1枚だけ開く。
//
// 以前は各レイヤーが独立に map.on('click') を購読して自前の Popup を開いていたため、
// 描画物が重なった場所を押すと吹き出しが複数枚同時に開いた（活断層線の上に区域ラベルや
// 観測点がある場所は珍しくない）。別々の場所を押している間は Popup の closeOnClick が
// 働いて1枚に見えるため表に出にくいが、重なった瞬間に破綻する。
//
// ここで map ごとに単一の click / mousemove ハンドラと単一の Popup インスタンスを持ち、
// 登録された全レイヤーを優先度順に問い合わせて、最初にヒットした1件だけを表示する。
//
// カスタムレイヤー（`gl/depthPointLayer.ts` で描く震源など）は queryRenderedFeatures の対象外
// なので、`pick` に自前の判定を渡してもらう。判定が描画ループの中でしか解けない実装があるため、
// 未解決（`'pending'`）を「何も無い」と区別し、数フレームだけ聞き直す。

/**
 * 当たり判定の優先度。狭くて狙って押したものほど先に拾う。
 * point（観測点・震源）> line（活断層・海岸線）> fill（震度・EEW の区域塗り）>
 * heat（地震活動ヒートマップ＝背景の情報）> basemap（一次細分区域の下地＝最後の受け皿）。
 */
export type PopupPriority = 'point' | 'line' | 'fill' | 'heat' | 'basemap'

const PRIORITY_ORDER: readonly PopupPriority[] = ['point', 'line', 'fill', 'heat', 'basemap']

export interface PopupSource {
  layerId: string
  priority: PopupPriority
  /** 当たり判定の許容半径(px)。細い線・小さい円は素の実描画ヒットだと外すため余裕を持たせる。 */
  tolPx: number
  /** 同一レイヤー内で複数ヒットしたとき、この数値プロパティが最大の feature を採る。 */
  rankKey?: string
  /** ホバー時の簡易表示。省略するとホバーでは吹き出しを出さず、カーソルだけ変える。 */
  buildHoverHtml?: (feature: MapGeoJSONFeature) => string
  buildClickHtml: (feature: MapGeoJSONFeature) => string
  /**
   * 指定するとクリックポップアップを開いている間この間隔(ms)で本文を作り直す。
   * EEW の「主要動の到達まで 約N秒」のように、時間経過で内容が古くなる表示に使う。
   */
  refreshMs?: number
  /**
   * ホバー時にカーソルを pointer にするか（既定 true）。
   * 一次細分区域の下地のように地図全面を覆うレイヤーで true にすると、どこにいても
   * 指マークになって「押せるもの」の区別が付かなくなるため false にする。
   */
  hoverCursor?: boolean
  /**
   * カスタムレイヤー用の自前判定。指定するとこちらを使い、`queryRenderedFeatures` は呼ばない。
   *
   * MapLibre はカスタムレイヤーが何を描いたかを知らないため、`queryRenderedFeatures` に一切
   * ヒットしない。地下に点を置くレイヤー（`gl/depthPointLayer.ts`）のように、描画を自前で持つ
   * ものはここへ判定を渡す。**`tolPx` は使われない**（判定の許容範囲はレイヤー側が決める）。
   *
   * 判定がその場で解けない実装（描画ループの中で解くもの）は `'pending'` を返す。呼び出し側が
   * 次のフレームで聞き直す。**`null` を返してはならない**——「何も無い」と区別が付かず、
   * `mousemove` が先に来ないタッチ操作で 1 回目が必ず空振りする。
   */
  pick?: (point: maplibregl.Point, forClick: boolean) => MapGeoJSONFeature | null | 'pending'
  /**
   * 判定が失敗したときに画面へ出す名前（`utils/renderHealth.ts`）。
   *
   * 省略すると記録だけ残して画面には出さない。**`pick` を持つソースにだけ意味がある**——
   * `queryRenderedFeatures` に任せるソースは MapLibre 側が面倒を見るため、ここで拾う失敗が無い。
   */
  label?: string
}

export interface PopupHandle {
  remove: () => void
}

// ホバー側の吹き出しは CSS で pointer-events を切る（index.css）。
// 吹き出し自身がマウスを受け取ると「対象から外れた」と判定され、出る/消えるを繰り返して明滅する。
// HTML マーカーが自前でホバー吹き出しを出す場合も同じクラスを使う必要があるため export する
// （QuakeIntensityPointsGL 等）。
/**
 * 判定が未解決だったとき、何フレームまで聞き直すか（クリックとホバーの両方で使う）。
 *
 * 描画ループの中でしか解けないレイヤー（`gl/depthPointLayer.ts`）があり、**タッチ操作は
 * `mousemove` を伴わない**ため、指が触れた最初の入力では必ず未解決になる。数フレーム待てば解ける。
 */
const CLICK_PICK_RETRY_FRAMES = 3

/**
 * 外から開くとき（`openPopupAt`）に、**何も当たらなかった場合も**聞き直すフレーム数。
 *
 * カメラが着地した直後は、寄り具合で出し入れするレイヤー（震度の観測点ドットなど）の表示切替が
 * まだ反映されていないことがある。切替はズームの変化を React の状態として受けてから行われるので、
 * `moveend` の時点では 1 コミットぶん遅れる。未解決（`'pending'`）とは別の事情なので回数も分ける。
 */
const EXTERNAL_OPEN_RETRY_FRAMES = 10

/**
 * 外から開くときに見る優先度。**点だけに絞る。**
 *
 * 地図には「どこを押しても区域名を出す最後の受け皿」がある（`BaseMapGL` の `basemap` 優先度）。
 * 全部の優先度を見ると**空振りが起きない**ので、目当ての点の層がまだ描かれていない一瞬に
 * 受け皿の区域名を掴み、押した行と無関係な吹き出しが開く（実機で再現した）。絞れば空振りになり、
 * 聞き直しが効く。一覧の行が指すのは常に点なので、絞っても取りこぼす相手はいない。
 */
const POINT_ONLY: readonly PopupPriority[] = ['point']

/**
 * 外から開くときに、その点だと認める画面上の距離（px）。
 *
 * バッジは**絵として重なる**ので、当たり判定には隣の点のバッジも入ってくる（5.5km 離れた
 * 区域の代表点が拾われた）。クリックなら「指の近くでいちばん強いもの」を採るのが正しいが、
 * 一覧の行から開くときは**その座標の点**しか正解が無い。
 *
 * **各レイヤーの `tolPx`（問い合わせる箱の大きさ）とは別に決めた値。** たまたま同じ 8 になって
 * いるが、意味が違う——あちらは「どこまで拾うか」、こちらは「拾ったもののうちどれをその点と
 * 認めるか」。片方を動かすときにもう片方を連れて動かさないこと。
 */
const EXTERNAL_OPEN_MAX_DIST_PX = 8

export const HOVER_CLASS = 'map-hover-popup'
const POPUP_OFFSET = 12

interface Registry {
  sources: PopupSource[]
  clickPopup: maplibregl.Popup
  hoverPopup: maplibregl.Popup
  /** 直近に表示したホバー本文。同じ内容なら再設定せず、DOM 作り直しによる明滅を防ぐ。 */
  hoverHtml: string | null
  /** カーソルを pointer にしたのが自分かどうか（他所のカーソル指定を奪って戻さないため）。 */
  cursorOwned: boolean
  /** 開いているクリックポップアップの定期再生成（refreshMs 指定時のみ）。 */
  refresh: { source: PopupSource; feature: MapGeoJSONFeature; timer: number } | null
  /**
   * 吹き出しを開こうとしている系列の世代。**新しい系列が始まったら古い系列は降りる。**
   *
   * 聞き直し（`requestAnimationFrame` の再帰）は数フレームにわたるので、その最中に次の要求が
   * 来ると 2 つの系列が 1 枚の吹き出しを取り合う。いまの呼び出し方（常に 1 秒の飛行を挟む）では
   * 先発が先に決着するため事故らないが、**それを保証しているのは呼び出し側の都合**なので、
   * ここで断ち切っておく。
   */
  openGeneration: number
  /** 開いているクリック吹き出しを閉じる（`closeMapPopup` から呼ぶ）。 */
  closeClick: () => void
  /** クリックと同じ経路で吹き出しを開く（`openPopupAt` から呼ぶ）。 */
  openAt: (
    point: maplibregl.Point,
    lngLat: maplibregl.LngLatLike,
    retriesLeft: number,
    retryOnMiss: boolean,
    priorities?: readonly PopupPriority[],
    exact?: boolean,
  ) => void
  detach: () => void
}

const registries = new WeakMap<MapLibreMap, Registry>()

function pickTop(feats: MapGeoJSONFeature[], rankKey?: string): MapGeoJSONFeature {
  if (!rankKey) return feats[0]
  return feats.reduce((best, f) =>
    Number(f.properties?.[rankKey] ?? -Infinity) > Number(best.properties?.[rankKey] ?? -Infinity)
      ? f
      : best,
  )
}

/** 「いま見つかっているいちばん近い点」。優先度 1 段ぶんの走査で持ち回る。 */
interface NearestPick {
  hit: { source: PopupSource; feature: MapGeoJSONFeature } | null
  dist: number
  /** 見た候補の数と、採らなかったもののうち最も近かった距離（px）。記録の切り分けに使う。 */
  stats: ExactStats
}

/**
 * 座標で選んだときに何を見たか。**「候補が 1 つも無かった」と「候補はあったが遠かった」を
 * 分けるため**にだけ持つ —— 前者は描くのが間に合っていない疑い、後者は
 * `EXTERNAL_OPEN_MAX_DIST_PX` の値そのものの疑いで、直す先が違う。
 */
export interface ExactStats {
  seen: number
  nearestRejectedPx: number
}

/**
 * 候補のうち `at` にいちばん近い点を `nearest` へ取り込む（`EXTERNAL_OPEN_MAX_DIST_PX` 以内のみ）。
 *
 * 一覧の行から開くとき、当たり判定に紛れ込んだ隣のバッジを採らないための選び方。
 * **点以外の図形は対象外**（線・面には「その座標の 1 つ」に当たるものが無い）。外から開く経路は
 * 点だけに絞ってあるので取りこぼす相手はいないが、線・面を返す `pick` を持つソースを
 * `exact` の対象へ足すと、ここで黙って落ちる。
 */
function considerNearest(
  map: MapLibreMap,
  nearest: NearestPick,
  source: PopupSource,
  feats: MapGeoJSONFeature[],
  at: maplibregl.Point,
): void {
  for (const f of feats) {
    if (f.geometry.type !== 'Point') continue
    const [lng, lat] = f.geometry.coordinates
    const p = map.project([lng, lat])
    const d = Math.hypot(p.x - at.x, p.y - at.y)
    nearest.stats.seen += 1
    if (d > EXTERNAL_OPEN_MAX_DIST_PX) {
      nearest.stats.nearestRejectedPx = Math.min(nearest.stats.nearestRejectedPx, d)
      continue
    }
    // **同じ距離なら先着**（＝レイヤーの登録順で先の方）。8px 以内でちょうど並ぶのは稀だが、
    // 決め方は書いておく。
    if (d >= nearest.dist) continue
    nearest.dist = d
    nearest.hit = { source, feature: f }
  }
}

/** 点 feature は自身の座標に吸着させる。線・面は形状の代表点が無いのでクリック位置に出す。 */
function anchorOf(feature: MapGeoJSONFeature, fallback: maplibregl.LngLatLike): maplibregl.LngLatLike {
  if (feature.geometry.type !== 'Point') return fallback
  const [lng, lat] = feature.geometry.coordinates
  return [lng, lat]
}

function createRegistry(map: MapLibreMap): Registry {
  const reg: Registry = {
    sources: [],
    clickPopup: new maplibregl.Popup({
      closeButton: true,
      // closeOnClick は使わない。同じ click イベント内で「閉じる」と「開く」が競合するため、
      // 何もヒットしなかったときの明示的な remove（onClick 内）で閉じる。
      closeOnClick: false,
      offset: POPUP_OFFSET,
      maxWidth: '280px',
    }),
    hoverPopup: new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      className: HOVER_CLASS,
      offset: POPUP_OFFSET,
      maxWidth: '240px',
    }),
    hoverHtml: null,
    cursorOwned: false,
    refresh: null,
    openGeneration: 0,
    closeClick: () => {},
    openAt: () => {},
    detach: () => {},
  }

  const closeHover = () => {
    reg.hoverPopup.remove()
    reg.hoverHtml = null
  }

  const stopRefresh = () => {
    if (!reg.refresh) return
    clearInterval(reg.refresh.timer)
    reg.refresh = null
  }

  const startRefresh = (source: PopupSource, feature: MapGeoJSONFeature) => {
    stopRefresh()
    if (!source.refreshMs) return
    const timer = window.setInterval(() => {
      if (!reg.clickPopup.isOpen()) {
        stopRefresh()
        return
      }
      reg.clickPopup.setHTML(source.buildClickHtml(feature))
    }, source.refreshMs)
    reg.refresh = { source, feature, timer }
  }

  // 閉じるボタンで閉じられたときも再生成を止める。
  reg.clickPopup.on('close', stopRefresh)

  const closeClick = () => {
    stopRefresh()
    reg.clickPopup.remove()
  }
  reg.closeClick = closeClick

  const releaseCursor = () => {
    if (!reg.cursorOwned) return
    map.getCanvas().style.cursor = ''
    reg.cursorOwned = false
  }

  // 優先度順に全登録レイヤーを問い合わせ、最初にヒットした1件を返す。
  /**
   * `forClick` は判定の予約が競合したときの優先度に使う（クリックの予約はホバーに奪われない）。
   */
  const findTop = (
    point: maplibregl.Point,
    forClick: boolean,
    priorities: readonly PopupPriority[] = PRIORITY_ORDER,
    /** 立てると「いちばん強いもの」ではなく「`point` にいちばん近い点」を採る（外から開くとき）。 */
    exact = false,
    /** `exact` のとき、何を見たかをここへ書き出す（記録の切り分け用）。 */
    stats?: ExactStats,
  ): { source: PopupSource; feature: MapGeoJSONFeature } | null | 'pending' => {
    for (const priority of priorities) {
      let pending = false
      const nearest: NearestPick = {
        hit: null,
        dist: Infinity,
        stats: stats ?? { seen: 0, nearestRejectedPx: Infinity },
      }
      for (const source of reg.sources) {
        if (source.priority !== priority) continue
        // 非表示（visibility:none）のレイヤーは queryRenderedFeatures にヒットしないため、
        // 表示切替中のレイヤーは自然に対象から外れる。
        if (!map.getLayer(source.layerId)) continue
        if (source.pick) {
          let f: MapGeoJSONFeature | null | 'pending'
          try {
            f = source.pick(point, forClick)
          } catch (err) {
            // **1 つの判定の失敗で全部を止めない。** ここは全ソースを回す唯一の場所なので、
            // 投げさせると**どのレイヤーもクリックに応じなくなる**（最後の受け皿である
            // 区域名の表示まで巻き添えになる）。そのソースだけ飛ばして続ける。
            log.error(`[popupRegistry] ${source.layerId} の判定が失敗しました`, err)
            if (source.label) reportRenderFailure(source.layerId, source.label, 'interact')
            continue
          }
          // **成功に転じたら取り下げる。** 報告済みかどうかを別に覚えない——覚えると
          // ストアと二重に持つことになり、片方だけ消えたときに食い違う。どちらの呼び出しも
          // 変化が無ければ何もせずに返る。
          if (source.label) clearRenderFailure(source.layerId, 'interact')
          if (f === 'pending') { pending = true; continue }
          if (!f) continue
          if (exact) { considerNearest(map, nearest, source, [f], point); continue }
          return { source, feature: f }
        }
        const box: [PointLike, PointLike] = [
          [point.x - source.tolPx, point.y - source.tolPx],
          [point.x + source.tolPx, point.y + source.tolPx],
        ]
        const feats = map.queryRenderedFeatures(box, { layers: [source.layerId] })
        if (feats.length === 0) continue
        if (exact) { considerNearest(map, nearest, source, feats, point); continue }
        return { source, feature: pickTop(feats, source.rankKey) }
      }
      // **座標で選ぶときは、登録順で決め打たない。** その優先度のソースを回し切ってから、
      // 全部の候補の中でいちばん近いものを採る。最初に条件を満たしたソースを返す形だと、
      // 同じ場所に候補を持つレイヤーが複数あったとき**登録順で勝敗が決まる**。いまは
      // `JapanMapGL` の表示条件でそれらが相互排他になっているが、それを保証しているのは
      // 呼び出し側であって、この調停役ではない。
      if (exact && nearest.hit) return nearest.hit
      // **この優先度に未解決が残っていたら、下位は見ない。** 見に行くと、まだ確定していない上位を
      // 飛び越えて下位が先に当たる。地図には「どこを押しても区域名は出す」最後の受け皿
      // （BaseMapGL の basemap 優先度）があるため、放置すると**未解決のたびに区域名が開く**。
      // 同一優先度内は回し切ってから判定する（同期で当たるものがあればそちらを採る）。
      if (pending) return 'pending'
    }
    return null
  }

  /**
   * 画面座標を 1 点受け取り、そこにある描画物の吹き出しを開く（何も無ければ閉じる）。
   *
   * 地図のクリックと、一覧の行からの呼び出し（`openPopupAt`）が共有する。**呼び出し元によって
   * 違うのは「当たらなかったときに聞き直すか」だけ** —— クリックは何も無い場所を押したのだから
   * 即座に閉じてよいが、外から開く経路は着地直後でレイヤーがまだ出ていないことがある。
   */
  const openAt = (
    point: maplibregl.Point,
    lngLat: maplibregl.LngLatLike,
    retriesLeft: number,
    retryOnMiss: boolean,
    priorities?: readonly PopupPriority[],
    exact = false,
    generation = ++reg.openGeneration,
  ) => {
    // 自分より後に始まった系列がいるなら、何も触らずに降りる（`openGeneration` の注記）。
    if (generation !== reg.openGeneration) return
    const stats: ExactStats | undefined = exact ? { seen: 0, nearestRejectedPx: Infinity } : undefined
    const hit = findTop(point, true, priorities, exact, stats)
    // 未解決なら数フレームだけ聞き直す。ここで諦めると、タッチ操作の 1 回目が必ず空振りする。
    if (hit === 'pending') {
      if (retriesLeft > 0) {
        requestAnimationFrame(() => openAt(point, lngLat, retriesLeft - 1, retryOnMiss, priorities, exact, generation))
        return
      }
      // **諦めたら、確定した空振りと同じように閉じる。** 押した場所に何も出せないのに前の
      // 吹き出しが残ると、**別の場所の情報を、押した場所の答えとして見せる**ことになる
      // （このファイルの冒頭が約束している「1 クリックにつき 1 枚」もそこで破れる）。
      // 判定が確定していないことと、いま開いているものを残してよいかは別の話。
      //
      // **記録の文面は分ける。** 前者は「そこに無い」、後者は「判定が返ってこない」で、
      // 疑う先が違う（後者はカスタムレイヤーの描画ループ側）。
      if (retryOnMiss) logGaveUp('判定が未解決のまま', lngLat, stats)
      closeClick()
      return
    }
    if (!hit) {
      if (retryOnMiss && retriesLeft > 0) {
        requestAnimationFrame(() => openAt(point, lngLat, retriesLeft - 1, retryOnMiss, priorities, exact, generation))
        return
      }
      // **外から開く要求が空振りしたら記録を残す。** 画面には「寄ったのに吹き出しだけ出ない」
      // としか現れないので、記録が無いと聞き直しの予算や距離の値が実運用で妥当かを確かめられない。
      //
      // **ただし異常とは限らない。** 震度分布モードのあいだは観測点ドットを出さない決まりなので
      // （`JapanMapGL` の `QuakeIntensityPointsGL` に渡す `visible`）、そのとき観測点の行を押せば
      // 正常に空振りする。だから警告ではなく詳細の側へ置く。クリックの空振りは数えない。
      if (retryOnMiss) logGaveUp('開ける点が無い', lngLat, stats)
      closeClick()
      return
    }
    closeHover()
    reg.clickPopup
      .setLngLat(anchorOf(hit.feature, lngLat))
      .setHTML(hit.source.buildClickHtml(hit.feature))
      .addTo(map)
    startRefresh(hit.source, hit.feature)
  }
  reg.openAt = openAt

  const onClick = (e: MapMouseEvent) => openAt(e.point, e.lngLat, CLICK_PICK_RETRY_FRAMES, false)

  const onMouseMove = (e: MapMouseEvent, retry = 0) => {
    // パン／ズーム中は吹き出しが地図に引きずられて鬱陶しいので追従しない。
    if (map.isMoving()) {
      closeHover()
      return
    }
    const hit = findTop(e.point, false)
    // 未解決のときはカーソルも吹き出しも触らずに聞き直す。**ここで消すと、判定の 1 フレーム遅れが
    // 明滅として現れる。** そして「次の mousemove で解ける」に頼ってもいけない——**目的の点で
    // マウスを止めると次のイベントが来ない**ので、解決済みの値を読む機会が永久に来ない。
    if (hit === 'pending') {
      if (retry < CLICK_PICK_RETRY_FRAMES) requestAnimationFrame(() => onMouseMove(e, retry + 1))
      return
    }
    if (!hit) {
      releaseCursor()
      closeHover()
      return
    }
    if (hit.source.hoverCursor === false) {
      releaseCursor()
    } else {
      map.getCanvas().style.cursor = 'pointer'
      reg.cursorOwned = true
    }
    if (reg.clickPopup.isOpen()) return
    if (!hit.source.buildHoverHtml) {
      closeHover()
      return
    }
    const html = hit.source.buildHoverHtml(hit.feature)
    if (reg.hoverHtml === html && reg.hoverPopup.isOpen()) return
    reg.hoverHtml = html
    reg.hoverPopup.setLngLat(anchorOf(hit.feature, e.lngLat)).setHTML(html).addTo(map)
  }

  const onMouseOut = () => {
    releaseCursor()
    closeHover()
  }

  map.on('click', onClick)
  map.on('mousemove', onMouseMove)
  map.on('mouseout', onMouseOut)

  reg.detach = () => {
    map.off('click', onClick)
    map.off('mousemove', onMouseMove)
    map.off('mouseout', onMouseOut)
    closeHover()
    closeClick()
    releaseCursor()
  }

  return reg
}

function getRegistry(map: MapLibreMap): Registry {
  const existing = registries.get(map)
  if (existing) return existing
  const created = createRegistry(map)
  registries.set(map, created)
  return created
}

/**
 * 開いている吹き出しを閉じる。
 *
 * 一覧の行から**範囲**へ寄せるときに使う（→ `FocusTargetGL`）。別の場所へカメラを動かすのに
 * 前に選んだ点の吹き出しを残すと、寄せた範囲の外を指したまま画面の端に取り残される。
 */
export function closeMapPopup(map: MapLibreMap): void {
  const reg = registries.get(map)
  if (!reg) {
    warnNoRegistry('closeMapPopup')
    return
  }
  reg.closeClick()
}

/**
 * 調停役がいない地図を外から触ろうとしたときの記録。
 *
 * レイヤーの登録が 1 件も無い状態で、これは通常のアプリ起動では起きない —— 地図の下地
 * （`BaseMapGL`）が地図の生存期間を通じて 1 件登録し続けるため。起きるとすれば登録側が
 * 例外を握った結果か、初期化の順序が崩れたとき。**正常系ではないので警告の側へ置く。**
 */
function warnNoRegistry(from: string): void {
  log.warn(`[popupRegistry] ${from}: 吹き出しの登録が 1 件も無い地図でした`)
}

/**
 * 外から開く要求を諦めたときの記録。
 *
 * **見た候補の数と、採らなかったもののうち最も近かった距離を添える。** 「候補が 1 つも無かった」
 * なら描くのが聞き直しの予算に間に合っていない疑いで、「候補はあったが遠かった」なら
 * `EXTERNAL_OPEN_MAX_DIST_PX` の値そのものの疑い。同じ文言で出すと、次に閾値を疑うときに
 * 切り分けられない。
 */
function logGaveUp(reason: string, lngLat: maplibregl.LngLatLike, stats?: ExactStats): void {
  const seen = stats?.seen ?? 0
  const rejected = stats && Number.isFinite(stats.nearestRejectedPx)
    ? `・最短 ${Math.round(stats.nearestRejectedPx)}px`
    : ''
  log.debug(
    `[popupRegistry] ${JSON.stringify(lngLat)} の吹き出しを開けませんでした`
    + `（${reason}・候補 ${seen} 件${rejected}）`,
  )
}

/**
 * 指定した場所の吹き出しを、地図上のその描画物をクリックしたのと同じ状態で開く。
 * カードの一覧の行から観測点へ寄せたとき、寄り先の点を選んだ状態にするために使う（`FocusTargetGL`）。
 *
 * **どのレイヤーの吹き出しかは呼び出し側が決めない。** クリックと同じ優先度判定を通すので、
 * 震度の観測点・未入電の地点・長周期の観測点のどれであっても呼び出しは 1 つで済む。
 *
 * 何も当たらなければ開いている吹き出しを閉じる（別の場所へ寄ったのに前の選択が残らないように）。
 * **登録されたレイヤーが 1 つも無い地図では何もしない** —— 調停役ごと存在しないため、開ける
 * 吹き出しも無い。
 */
export function openPopupAt(map: MapLibreMap, lngLat: maplibregl.LngLatLike): void {
  const reg = registries.get(map)
  if (!reg) {
    warnNoRegistry('openPopupAt')
    return
  }
  reg.openAt(map.project(lngLat), lngLat, EXTERNAL_OPEN_RETRY_FRAMES, true, POINT_ONLY, true)
}

/**
 * レイヤーをポップアップの当たり判定に登録する。戻り値を呼ぶと登録を解除する
 * （最後の1件が外れたら map のハンドラごと解放する）。
 */
export function registerPopupSource(map: MapLibreMap, source: PopupSource): PopupHandle {
  const reg = getRegistry(map)
  reg.sources.push(source)
  return {
    remove: () => {
      const i = reg.sources.indexOf(source)
      if (i >= 0) reg.sources.splice(i, 1)
      // 外したソースの不調は画面に残さない（もう判定に呼ばれないので、直ったかも判らない）。
      if (source.label) clearRenderFailure(source.layerId, 'interact')
      if (reg.sources.length === 0) {
        reg.detach()
        registries.delete(map)
      }
    },
  }
}

