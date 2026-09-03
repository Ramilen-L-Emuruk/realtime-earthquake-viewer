import { useMemo } from 'react'
import type { JMAQuake, JMALpgm } from '../types/earthquake'
import { useStationCoords } from './useStationCoords'
import { useSubRegions } from './useSubRegions'
import {
  lookupPointCoords,
  lookupStationRegion,
  buildAreaPrefIndex,
  buildStationPrefIndex,
  type LatLng,
} from '../utils/stationCoords'
import { pointInRings, normalizeEpicenterLng } from '../utils/geo'
import { ringsBounds, type SubRegion } from '../utils/subregions'
import { extractQuakeEventId } from '../utils/quakeMerge'
import { japanWideCornersLatLng } from '../components/Map/gl/bounds'

// 地震モードの描画に必要な派生データ（観測点ごとの震度点／一次細分区域集約／震源）を
// 一箇所で計算する共有フック。Leaflet 版 JapanMap 内の同名 memo 群と同じ導出を行う
// （MapLibre 版 JapanMapGL と Leaflet 版の描画一致を保証するため単一の情報源に集約）。
//
// zoom は地図の現在ズーム。aggregateMaxZoom 以下では観測点個別ではなく一次細分区域ごとの最大震度へ
// 集約する（aggregateByRegion）。どちらも動的なので呼び出し側（各エンジンの地図）が観測して渡す。
//
// aggregateMaxZoom には**カメラの寄り上限をそのまま渡すこと**（gl/camera.ts の fitMaxZoom）。
// 「自動フィット着地後は必ず区域集約になる」という前提に regionMaxByName の常時計算が依存している
// （下の regionMaxByName のコメント参照）。寄り上限は地図ペインの寸法で変わるため定数にできず、
// かつて MAX_ZOOM から導出していたようにこのファイル側で持つことができない。独自の値を置くと、
// 大きな画面で「フィットしたのに区域集約にならない＝震度塗りが出ない」が静かに起きる。
// 震源経度の正規化に使う日本中心の経度（Leaflet 版 JAPAN_CENTER[1] と一致）。
const JAPAN_CENTER_LNG = 137.7

export interface IntensityMarker {
  key: string
  position: LatLng
  scale: number
  pref: string
  addr: string
  /** 電文上の区分。true は観測点ではなく一次細分区域そのものの代表点。 */
  isArea: boolean
  /** 観測点が属する一次細分区域名（座標テーブル由来）。未収録なら null。 */
  region: string | null
}

export interface RegionAggregate {
  name: string
  scale: number
  rings: LatLng[][]
  label: LatLng
}

export interface LpgmMarker {
  position: LatLng
  lgInt: number
  /** 観測点名（ポップアップ表示用）。 */
  name: string
  /** 都道府県名。電文に無ければ座標テーブルの索引から補完する。 */
  pref: string
}

export interface LpgmRegionAggregate {
  name: string
  maxLgInt: number
  rings: LatLng[][]
  label: LatLng
}

/**
 * 集約切替の判定に使う地図の状態。
 *
 * どちらも `number` なので位置引数で並べると取り違えを型が検出できない。入れ替わると集約の判定が
 * 反転し、「フィットしても震度塗りにならない」「常に塗りになる」という劣化が型検査もテストも
 * 素通りする（この判定を直接検証するユニットテストは無い）。名前で渡す形にして構造的に防ぐ。
 */
export interface QuakeAggregateView {
  /** 地図の現在ズーム。 */
  zoom: number
  /**
   * 区域集約へ切り替える上限ズーム。**カメラの寄り上限を渡すこと**（gl/camera.ts の `fitMaxZoom`）。
   * 理由は下の `aggregateMaxZoom` の注記。
   */
  aggregateMaxZoom: number
}

export interface QuakeLayerData {
  /**
   * 電文の震度点すべて（震度の弱い順）。区域の代表点（isArea:true）を含むため、
   * ドット描画には使わない（→ stationMarkers）。カメラフィットのフォールバック用。
   */
  intensityMarkers: IntensityMarker[]
  /** 観測点だけの震度点（震度の弱い順＝強い震度を前面に描画する想定）。 */
  stationMarkers: IntensityMarker[]
  /**
   * true のとき一次細分区域へ集約して塗る（zoom <= aggregateMaxZoom）。
   * 区域データ（subregions.json）の取得に失敗したときは、集約しても塗るポリゴンが無いため false。
   */
  aggregateByRegion: boolean
  /** 区域ごとの最大震度集約（弱い順）。aggregateByRegion=false のときは空。 */
  regionAggregates: RegionAggregate[]
  /** 震源が有効か。 */
  hasEpicenter: boolean
  /** 震源座標（[lat, lng]・経度は地図中心基準で正規化済み）。無効時は null。 */
  epicenter: LatLng | null
  /** 震源ポップアップ用の都道府県別最大震度（震度の降順）。 */
  prefIntensities: [string, number][]
  /** 長周期地震動（LPGM）電文が進行中か（進行中は quake 震度表示を置き換える）。 */
  lpgmActive: boolean
  /** LPGM 観測点マーカー（階級の弱い順）。 */
  lpgmMarkers: LpgmMarker[]
  /** LPGM 一次細分区域集約（階級の弱い順）。 */
  lpgmRegionAggregates: LpgmRegionAggregate[]
  /** 地震モードのカメラフィット対象（各観測点＋震源）。 */
  quakeFitPositions: LatLng[]
  /** カメラフィットの発火判定用シグネチャ（変化時のみフィット）。 */
  quakeSignature: string
}

export function useQuakeLayerData(
  mode: string,
  quake: JMAQuake | null | undefined,
  view: QuakeAggregateView,
  lpgm?: JMALpgm | null,
): QuakeLayerData {
  const { zoom, aggregateMaxZoom } = view
  const stationCoords = useStationCoords()
  const { data: subregions, failed: subregionsFailed } = useSubRegions()

  const areaPrefIndex = useMemo(
    () => (stationCoords ? buildAreaPrefIndex(stationCoords) : new Map<string, string>()),
    [stationCoords],
  )
  const stationPrefIndex = useMemo(
    () => (stationCoords ? buildStationPrefIndex(stationCoords) : new Map<string, string>()),
    [stationCoords],
  )

  const intensityMarkers = useMemo<IntensityMarker[]>(() => {
    if (mode !== 'quake' || !quake || !stationCoords) return []
    const markers: IntensityMarker[] = []
    quake.points.forEach((p, i) => {
      const pref =
        p.pref || ((p.isArea ? areaPrefIndex.get(p.addr) : stationPrefIndex.get(p.addr)) ?? '')
      const position = lookupPointCoords(stationCoords, pref, p.addr, p.isArea)
      if (!position) return
      markers.push({
        key: `${pref}|${p.addr}|${i}`,
        position,
        scale: p.scale,
        pref,
        addr: p.addr,
        isArea: p.isArea,
        region: p.isArea ? p.addr : lookupStationRegion(stationCoords, pref, p.addr),
      })
    })
    return markers.sort((a, b) => a.scale - b.scale)
  }, [mode, quake, stationCoords, areaPrefIndex, stationPrefIndex])

  // 区域の代表点（isArea:true）は区域内観測点の重心であって観測値の位置ではないため、
  // ドット描画からは除く。区域の震度は区域塗り（regionAggregates）が表現する。
  const stationMarkers = useMemo(
    () => intensityMarkers.filter((m) => !m.isArea),
    [intensityMarkers],
  )

  const lpgmActive = !!(lpgm && !lpgm.cancelled)

  // 観測点を1つも持たない電文（震度速報＝DMDATA VXSE51／P2PQuake ScalePrompt）は、
  // 拡大しても増える情報が無い。区域の代表点をドットにすると「その地点の観測値」に
  // 見えてしまうため、ズームに関わらず区域集約を維持する。
  // LPGM 表示中は LPGM 側の粒度（lpgmMarkers）で決まるため対象外。
  //
  // 区域データ（subregions.json）の取得が失敗で確定したときは集約しない。塗る区域ポリゴンが
  // 1件も作れない（regionAggregates が空）のに、JapanMapGL は区域塗りと観測点ドットを排他で
  // 切り替えるため、集約を維持したままだと地図から震度が完全に消えるため。自動フィットの
  // 着地ズームは常に寄り上限でキャップされる（gl/camera.ts）ので、この経路は
  // 「たまたま拡大していれば助かる」ものではなく必ず踏む。
  // 読み込み中（failed=false・data=null）は集約を維持する——データ到着の瞬間にドットから
  // 区域塗りへ切り替わるちらつきを避けるため（regionAggregates を常時計算しているのと同じ理由）。
  //
  // 座標テーブル（station-coords.json）が取得できないときは stationMarkers が空になるため、
  // 上の「観測点 0 件」条件によりズームに関わらず集約が維持される。これは意図した結果で正しい
  // （座標が無ければ観測点ドットも描けないので、集約をやめても表示できるものが増えない）。
  // この場合に地図へ何が残るかは電文次第——区域を持つ電文なら区域塗りは出る（区域塗りは電文の
  // 区域名で引くため座標テーブルに依存しない）。詳細は docs/spec/quake-spec.md §7.3。
  const aggregateByRegion =
    mode === 'quake' && !!quake && !subregionsFailed &&
    (zoom <= aggregateMaxZoom || (!lpgmActive && stationMarkers.length === 0))

  // 一次細分区域に bbox を付与（点内包判定の前段フィルタ用・フィット対象の矩形）。
  // 境界を持たない区域は点内包判定も区域塗りもできないため索引から外す（生成データが正常なら発生しない）。
  // 旧実装は空リングの区域を Infinity の bbox のまま索引に残していたため、その区域名が電文側に
  // 現れると quakeFitPositions へ Infinity 座標が混入しうる穴があった（ringsBounds の null 除外で解消）。
  const subregionIndex = useMemo(() => {
    if (!subregions) return []
    const list: { sr: SubRegion; minLat: number; maxLat: number; minLng: number; maxLng: number }[] = []
    for (const sr of subregions) {
      const b = ringsBounds(sr.rings)
      if (!b) continue
      list.push({ sr, ...b })
    }
    return list
  }, [subregions])

  // 区域名 → 最大震度。aggregateByRegion（現在ズーム依存）とは無関係に常に計算する。
  // quakeFitPositions が「実際に塗られる区域」を zoom の変化を待たずに参照するために必要
  // （QuakeFitGL のフィットは常に寄り上限でキャップされるため、フィット着地後は
  // 必ず aggregateByRegion=true になる。フィット計算時点の現在 zoom がたまたま上限より深くても
  // 着地後の状態を先取りして区域マッチングする必要がある）。
  const regionMaxByName = useMemo<Map<string, number>>(() => {
    const maxByName = new Map<string, number>()
    if (mode !== 'quake' || !quake) return maxByName

    const bump = (name: string, scale: number) => {
      const cur = maxByName.get(name)
      if (cur == null || scale > cur) maxByName.set(name, scale)
    }

    // パス1: 観測点(isArea:false) → 座標テーブルが持つ所属区域名で直接マッチ。
    // 観測点座標は元データが 0.01 度（約 1km）粒度のため、細い島や海岸沿いでは点内包判定が
    // 海側に落ちて集約から漏れる・隣県の区域に誤って入る（lookupStationRegion 参照）。
    // 区域を持たない観測点（テーブル未収録）のみ、従来どおり座標の点内包判定にフォールバックする。
    for (const m of stationMarkers) {
      if (m.region) {
        bump(m.region, m.scale)
        continue
      }
      const [lat, lng] = m.position
      for (const e of subregionIndex) {
        if (lat < e.minLat || lat > e.maxLat || lng < e.minLng || lng > e.maxLng) continue
        if (pointInRings(lat, lng, e.sr.rings)) {
          bump(e.sr.name, m.scale)
          break
        }
      }
    }

    // パス2: isArea:true の地点 → 区域名で直接マッチ（観測点が海上でも確実に塗る）。
    // DMDATA JSON 経路の都道府県ロールアップ点（addr が県名）もここで拾う。他所（quakeMerge /
    // ttsText）は addr !== pref で除くが、ここは除かない——一致する区域名を持つのは単一区域の
    // 奈良県だけで、県の最大震度と区域の最大震度が同値になるため。他県のぶんは参照されない。
    for (const p of quake.points) {
      if (!p.isArea) continue
      bump(p.addr, p.scale)
    }
    return maxByName
  }, [mode, quake, subregionIndex, stationMarkers])

  // aggregateByRegion（ズーム依存）とは無関係に常に計算する。ズームアウトして区域表示に
  // 切り替わる瞬間に初めて実データで setData されるのを避けるため（GeoJSON source の
  // 非同期タイル化待ちで区域塗りが一瞬空になるフリッカーの原因だった）。regionMaxByName・
  // quakeFitPositions と同じ「zoomを待たない」設計に揃える。
  const regionAggregates = useMemo<RegionAggregate[]>(() => {
    if (subregionIndex.length === 0) return []
    const list: RegionAggregate[] = []
    for (const e of subregionIndex) {
      const scale = regionMaxByName.get(e.sr.name)
      if (scale != null) list.push({ name: e.sr.name, scale, rings: e.sr.rings, label: e.sr.label })
    }
    return list.sort((a, b) => a.scale - b.scale)
  }, [subregionIndex, regionMaxByName])

  const hasEpicenter = !!(
    quake &&
    quake.earthquake.hypocenter.latitude > -200 &&
    quake.earthquake.hypocenter.longitude > -200
  )

  const epicenter = useMemo<LatLng | null>(() => {
    if (!hasEpicenter || !quake) return null
    return [
      quake.earthquake.hypocenter.latitude,
      normalizeEpicenterLng(quake.earthquake.hypocenter.longitude, JAPAN_CENTER_LNG),
    ]
  }, [hasEpicenter, quake])

  // 震源ポップアップ用の都道府県別最大震度（Leaflet 版 prefIntensities と同一導出）。
  //
  // QUAKE-2 で XML 経路の観測点も pref: '' に統一されたため、pref が空のケースを
  // 区域名→都道府県逆引き（areaPrefIndex）・観測点名→都道府県逆引き（stationPrefIndex）で
  // 復元する。intensityMarkers（L114-128）と同じフォールバックロジックを揃える。
  const prefIntensities = useMemo<[string, number][]>(() => {
    if (!quake) return []
    const maxByPref = quake.points.reduce<Record<string, number>>((acc, p) => {
      const pref = p.pref || (p.isArea ? areaPrefIndex.get(p.addr) : stationPrefIndex.get(p.addr))
      if (!pref) return acc
      if (!acc[pref] || p.scale > acc[pref]) acc[pref] = p.scale
      return acc
    }, {})
    return Object.entries(maxByPref).sort((a, b) => b[1] - a[1])
  }, [quake, areaPrefIndex, stationPrefIndex])

  // LPGM 観測点マーカー（Leaflet 版 lpgmMarkers と同一導出）。
  const lpgmMarkers = useMemo<LpgmMarker[]>(() => {
    if (!lpgmActive || !lpgm?.points?.length || !stationCoords) return []
    const markers: LpgmMarker[] = []
    for (const p of lpgm.points) {
      const pref = p.pref || stationPrefIndex.get(p.name) || ''
      const position = lookupPointCoords(stationCoords, pref, p.name, false)
      if (!position) continue
      markers.push({ position, lgInt: p.lgInt, name: p.name, pref })
    }
    return markers.sort((a, b) => a.lgInt - b.lgInt)
  }, [lpgmActive, lpgm, stationCoords, stationPrefIndex])

  // LPGM 一次細分区域集約（Leaflet 版 lpgmRegionAggregates と同一導出）。
  const lpgmRegionAggregates = useMemo<LpgmRegionAggregate[]>(() => {
    if (!lpgmActive || !lpgm?.regions?.length || !subregions) return []
    const maxByName = new Map(lpgm.regions.map((r) => [r.name, r.maxLgInt]))
    return subregions
      .filter((sr) => (maxByName.get(sr.name) ?? 0) >= 1)
      .map((sr) => ({ name: sr.name, maxLgInt: maxByName.get(sr.name)!, rings: sr.rings, label: sr.label }))
      .sort((a, b) => a.maxLgInt - b.maxLgInt)
  }, [lpgmActive, lpgm, subregions])

  // 地震モードのカメラフィット対象。観測点の代表点ではなく、実際に塗られる一次細分区域ポリゴンの
  // 外接矩形（bbox）でフィットする（区域が代表点よりはみ出た形のときにフレームから溢れるのを防ぐ）。
  // 区域が1件もマッチしない場合（遠地地震等・区域集約されない）のみ観測点の生座標にフォールバックする。
  //
  // LPGM 表示中（lpgmActive）は quake ではなく lpgm 自身の区域・観測点でフィットする。LPGM は
  // 地震一覧の各行から eventId 単位で個別にトグルできる（App.tsx の onToggleLpgm は
  // selectedQuakeId を変えない）ため、選択中の quake と表示中の LPGM が別の地震のことがある。
  // quake 側のデータでフィットすると無関係な地震の位置にカメラが留まったままになる。
  const quakeFitPositions = useMemo<LatLng[]>(() => {
    if (lpgmActive) {
      const positions: LatLng[] = []
      if (lpgm?.regions?.length && subregionIndex.length > 0) {
        const names = new Set(lpgm.regions.filter((r) => r.maxLgInt >= 1).map((r) => r.name))
        for (const e of subregionIndex) {
          if (!names.has(e.sr.name)) continue
          positions.push([e.minLat, e.minLng], [e.maxLat, e.maxLng])
        }
      }
      if (positions.length === 0) {
        for (const m of lpgmMarkers) positions.push(m.position)
      }
      // quake が LPGM と同一イベントのときのみ震源を加える（無関係な地震の震源を混ぜない）。
      if (epicenter && quake && lpgm && extractQuakeEventId(quake) === lpgm.eventId) {
        positions.push(epicenter)
      }
      return positions
    }
    const positions: LatLng[] = []
    for (const e of subregionIndex) {
      if (!regionMaxByName.has(e.sr.name)) continue
      positions.push([e.minLat, e.minLng], [e.maxLat, e.maxLng])
    }
    // regionMaxByName は座標テーブル由来のため subregions のロードを待たずに埋まる。
    // 「区域が1件もマッチしない」判定は Map のサイズではなく実際に得られたポリゴン数で行う
    // （未ロード時に震源だけへフィットしてしまうのを防ぐ）。
    if (positions.length === 0) {
      for (const m of intensityMarkers) positions.push(m.position)
    }
    if (epicenter) positions.push(epicenter)
    // 遠地地震は国内で震度を観測しないため、フィット対象が震源 1 点だけになる。震源しか無いと
    // 日本が枠外へ出てしまうので、離島まで含めた日本全体の枠の南西・北東 2 隅を加え、
    // 「震源 ∪ 日本全体」が必ず収まるようにする。
    if (quake?.issue.type === '遠地地震' && hasEpicenter) {
      positions.push(...japanWideCornersLatLng())
    }
    return positions
  }, [lpgmActive, lpgm, lpgmMarkers, regionMaxByName, subregionIndex, intensityMarkers, epicenter, hasEpicenter, quake])

  // LPGM 表示の切替（同じ quake のまま lpgmActive だけが変わる、あるいは別イベントの LPGM に
  // 切り替わる）でも再フィットが発火するよう、lpgm の eventId を signature に含める。
  const quakeSignature = `${quake?.id ?? ''}:${lpgmActive ? (lpgm?.eventId ?? '') : ''}:${quakeFitPositions.length}`

  return {
    intensityMarkers,
    stationMarkers,
    aggregateByRegion,
    regionAggregates,
    hasEpicenter,
    epicenter,
    prefIntensities,
    lpgmActive,
    lpgmMarkers,
    lpgmRegionAggregates,
    quakeFitPositions,
    quakeSignature,
  }
}
