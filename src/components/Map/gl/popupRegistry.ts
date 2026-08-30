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
   * EEW の「S波到達まで あと何秒」のように、時間経過で内容が古くなる表示に使う。
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

/** 点 feature は自身の座標に吸着させる。線・面は形状の代表点が無いのでクリック位置に出す。 */
function anchorOf(feature: MapGeoJSONFeature, fallback: maplibregl.LngLat): maplibregl.LngLatLike {
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
  ): { source: PopupSource; feature: MapGeoJSONFeature } | null | 'pending' => {
    for (const priority of PRIORITY_ORDER) {
      let pending = false
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
          if (f) return { source, feature: f }
          continue
        }
        const box: [PointLike, PointLike] = [
          [point.x - source.tolPx, point.y - source.tolPx],
          [point.x + source.tolPx, point.y + source.tolPx],
        ]
        const feats = map.queryRenderedFeatures(box, { layers: [source.layerId] })
        if (feats.length > 0) return { source, feature: pickTop(feats, source.rankKey) }
      }
      // **この優先度に未解決が残っていたら、下位は見ない。** 見に行くと、まだ確定していない上位を
      // 飛び越えて下位が先に当たる。地図には「どこを押しても区域名は出す」最後の受け皿
      // （BaseMapGL の basemap 優先度）があるため、放置すると**未解決のたびに区域名が開く**。
      // 同一優先度内は回し切ってから判定する（同期で当たるものがあればそちらを採る）。
      if (pending) return 'pending'
    }
    return null
  }

  const onClick = (e: MapMouseEvent, retry = 0) => {
    const hit = findTop(e.point, true)
    // 未解決なら数フレームだけ聞き直す。ここで諦めると、タッチ操作の 1 回目が必ず空振りする。
    if (hit === 'pending') {
      if (retry < CLICK_PICK_RETRY_FRAMES) requestAnimationFrame(() => onClick(e, retry + 1))
      return
    }
    if (!hit) {
      closeClick()
      return
    }
    closeHover()
    reg.clickPopup
      .setLngLat(anchorOf(hit.feature, e.lngLat))
      .setHTML(hit.source.buildClickHtml(hit.feature))
      .addTo(map)
    startRefresh(hit.source, hit.feature)
  }

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

