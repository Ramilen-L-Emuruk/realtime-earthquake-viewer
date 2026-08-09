import * as maplibregl from 'maplibre-gl'
import type { Map as MapLibreMap, MapMouseEvent, MapGeoJSONFeature, PointLike } from 'maplibre-gl'

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
// HTML マーカー（震源・区域ラベル等）は queryRenderedFeatures の対象外だが、マーカー要素の
// クリックは地図コンテナへバブリングして map の click も発火させる。マーカーは常に最前面の点
// として扱いたいので、claimClickForMarker で「この click はマーカーが取った」と宣言させ、
// レイヤー由来の表示を抑止する（順序はマーカー要素→コンテナのバブリングで保証される）。

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
}

export interface PopupHandle {
  remove: () => void
}

// ホバー側の吹き出しは CSS で pointer-events を切る（index.css）。
// 吹き出し自身がマウスを受け取ると「対象から外れた」と判定され、出る/消えるを繰り返して明滅する。
const HOVER_CLASS = 'map-hover-popup'
const POPUP_OFFSET = 12

interface Registry {
  sources: PopupSource[]
  clickPopup: maplibregl.Popup
  hoverPopup: maplibregl.Popup
  /** 直近に表示したホバー本文。同じ内容なら再設定せず、DOM 作り直しによる明滅を防ぐ。 */
  hoverHtml: string | null
  /** カーソルを pointer にしたのが自分かどうか（他所のカーソル指定を奪って戻さないため）。 */
  cursorOwned: boolean
  /** 直前の click を HTML マーカーが消費したか。 */
  markerClaimed: boolean
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
    markerClaimed: false,
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
  const findTop = (point: maplibregl.Point): { source: PopupSource; feature: MapGeoJSONFeature } | null => {
    for (const priority of PRIORITY_ORDER) {
      for (const source of reg.sources) {
        if (source.priority !== priority) continue
        // 非表示（visibility:none）のレイヤーは queryRenderedFeatures にヒットしないため、
        // 表示切替中のレイヤーは自然に対象から外れる。
        if (!map.getLayer(source.layerId)) continue
        const box: [PointLike, PointLike] = [
          [point.x - source.tolPx, point.y - source.tolPx],
          [point.x + source.tolPx, point.y + source.tolPx],
        ]
        const feats = map.queryRenderedFeatures(box, { layers: [source.layerId] })
        if (feats.length > 0) return { source, feature: pickTop(feats, source.rankKey) }
      }
    }
    return null
  }

  const onClick = (e: MapMouseEvent) => {
    if (reg.markerClaimed) {
      // マーカーが自前の吹き出しを開いた直後。レイヤー由来は出さず、残っていれば閉じる。
      reg.markerClaimed = false
      closeClick()
      closeHover()
      return
    }
    const hit = findTop(e.point)
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

  const onMouseMove = (e: MapMouseEvent) => {
    // パン／ズーム中は吹き出しが地図に引きずられて鬱陶しいので追従しない。
    if (map.isMoving()) {
      closeHover()
      return
    }
    const hit = findTop(e.point)
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
      if (reg.sources.length === 0) {
        reg.detach()
        registries.delete(map)
      }
    },
  }
}

/**
 * HTML マーカーの要素にクリック宣言を仕込む。マーカーは最前面の点として常に優先され、
 * そのクリックではレイヤー由来のポップアップを出さない。戻り値を呼ぶと解除する。
 */
export function attachMarkerClaim(map: MapLibreMap, element: HTMLElement): PopupHandle {
  const onClick = () => {
    const reg = registries.get(map)
    if (!reg) return
    reg.markerClaimed = true
    // 何らかの理由で map の click が続かなかった場合に宣言が残らないようにする
    // （マーカー要素→コンテナのバブリングは通常必ず届くが、保険として次のタスクで倒す）。
    setTimeout(() => {
      reg.markerClaimed = false
    }, 0)
  }
  element.addEventListener('click', onClick)
  return { remove: () => element.removeEventListener('click', onClick) }
}
