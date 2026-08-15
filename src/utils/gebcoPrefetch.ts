import { MAX_ZOOM } from '../components/Map/gl/camera'
import { JAPAN_WIDE_BOUNDS } from '../components/Map/gl/bounds'

// GEBCO 海底地形タイル（BaseMapGL.tsx の背景ラスタソースと同一 URL）の先読み。
// 沖縄（先島諸島）〜択捉島相当の範囲を、アイドル時に低ズーム優先でバックグラウンド fetch し
// ブラウザの HTTP キャッシュへ温めておく。実際にフィットした瞬間の暗転（タイル未取得による
// raster 未描画）を短縮するのが目的。
//
// ArcGIS Online 側のサービスメタデータ（?f=json）で exportTilesAllowed:false となっており、
// タイルの一括エクスポート・静的同梱は許可されていない。そのため通常の表示リクエストと同形の
// fetch を間引いて投げるだけに留め、失敗（404/通信エラー）は無視する（best-effort。実フィット時に
// 通常どおり再取得されるだけで実害はない）。
export const BATHYMETRY_URL =
  'https://tiles.arcgis.com/tiles/C8EMgrsFcRFL6LrL/arcgis/rest/services/GEBCO_basemap_NCEI/MapServer/tile/{z}/{y}/{x}'

/**
 * GEBCO ソースのタイルサイズ（px）。BaseMapGL の addSource と MAX_TILE_ZOOM の算出で共有する。
 * MapLibre の基準は 512px なので、256px のソースはマップズーム z のときタイル z+1 を要求する。
 */
export const GEBCO_TILE_SIZE = 256
/** GEBCO タイルセットに実在する最大タイル z（これを超えるズームはオーバーズーム扱いで新規取得されない）。 */
export const GEBCO_SOURCE_MAX_ZOOM = 10
/**
 * 常時下地として敷くオーバービュー層（BaseMapGL）の最大タイル z。
 * 日本全体を眺める縮尺帯に相当する低ズームを常時カバーする値で、遠距離フィットの直後にもこの精細さの
 * 下地が必ず残る（下げればボケが増え、上げれば保持タイル数が増えるトレードオフ）。fitJapan の着地ズームは
 * ビューポートの大きさで変わるため、その値と厳密に一致させる必要はない。この z のタイルは先読み（下記）にも
 * 含まれるため初回表示から即描画できる。
 */
export const GEBCO_OVERVIEW_MAX_ZOOM = 5
/**
 * MapLibre（512px タイル基準）がマップズーム z のときに要求するタイル z を返す
 * （ラスタソースは丸め方式が round のため `Math.round`）。マップズーム基準とタイル座標系の変換は
 * 混同事故が起きやすいので、両方を扱う箇所はこの関数を通す。
 */
export function desiredTileZoom(mapZoom: number): number {
  return Math.round(mapZoom + Math.log2(512 / GEBCO_TILE_SIZE))
}

/**
 * 高解像度層（BaseMapGL の上層）を描画し始めるマップズーム。**マップズーム基準（512px タイル）** の値で、
 * このファイルの他の定数（タイル座標系の z）とは別の座標系。混同しないこと。
 *
 * 上層が下層より深いタイルを要求し始めるのは `desiredTileZoom(z) > GEBCO_OVERVIEW_MAX_ZOOM` のとき。
 * `Math.round` の境界から、その最小の z は `GEBCO_OVERVIEW_MAX_ZOOM + 0.5 - log2(512 / タイルサイズ)`
 * （256px タイルなら 4.5）。これ未満のズームでは 2 層が同一タイルを要求するだけで見た目は変わらないため
 * （実測: マップズーム 3 で 20 タイルすべてが二重取得）、上層の minzoom に指定して描画対象から外す。
 * 非表示のレイヤーはソースの更新対象にならないため、タイル取得ごと止まる。
 *
 * タイルサイズから導出しているので `GEBCO_TILE_SIZE` を変えてもズレない。境界のタイトさは
 * `src/components/Map/gl/zoomConstants.test.ts` が両側から固定している。
 */
export const GEBCO_HIRES_MIN_ZOOM = GEBCO_OVERVIEW_MAX_ZOOM + 0.5 - Math.log2(512 / GEBCO_TILE_SIZE)

// 先読み対象範囲は離島まで含めた日本全体の枠（JAPAN_WIDE_BOUNDS）と同一にする。遠地地震のフィットが
// 実際にこの枠へ寄せるため、枠を広げたら先読み範囲も追従すべきという関係にあり、値を二重に持たない。
const [[PREFETCH_WEST, PREFETCH_SOUTH], [PREFETCH_EAST, PREFETCH_NORTH]] = JAPAN_WIDE_BOUNDS

// 同時 fetch 数（外部タイルサーバー・他の通信への負荷を抑える）。
const CONCURRENCY = 3

export interface TileXYZ {
  x: number
  y: number
  z: number
}

/** 緯度経度から Web Mercator タイル座標を算出する（範囲外の値は 0〜(2^z-1) にクランプ）。 */
export function lngLatToTile(lng: number, lat: number, z: number): [number, number] {
  const n = 2 ** z
  const x = Math.floor(((lng + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
  return [Math.min(Math.max(x, 0), n - 1), Math.min(Math.max(y, 0), n - 1)]
}

// 先読みする最大タイルズーム。GEBCO_TILE_SIZE が MapLibre 基準の 512px より小さいため、MapLibre は
// 「マップズーム z のとき タイル z+1」を要求する（実測: マップ zoom 8 で /tile/9/... を取得）。
// MAX_ZOOM（マップズーム基準）をそのままタイル z として使うと、自動フィットの上限で実際に使う
// タイルが先読み対象から 1 段漏れる。タイルセットに実在しない z を叩いても意味が無いので
// GEBCO_SOURCE_MAX_ZOOM でクランプする（fetch 失敗は握りつぶすため、超過しても無症状で
// 先読みだけが空回りする。テストで境界を固定している）。
export const MAX_TILE_ZOOM = Math.min(MAX_ZOOM + 1, GEBCO_SOURCE_MAX_ZOOM)

/** 先読み対象範囲・ズームのタイル一覧を、低ズーム優先（0→maxTileZoom）で並べて返す。 */
export function buildPrefetchTiles(maxTileZoom: number = MAX_TILE_ZOOM): TileXYZ[] {
  const tiles: TileXYZ[] = []
  for (let z = 0; z <= maxTileZoom; z++) {
    const [x0, y0] = lngLatToTile(PREFETCH_WEST, PREFETCH_NORTH, z)
    const [x1, y1] = lngLatToTile(PREFETCH_EAST, PREFETCH_SOUTH, z)
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        tiles.push({ x, y, z })
      }
    }
  }
  return tiles
}

function tileUrl(tile: TileXYZ): string {
  return BATHYMETRY_URL.replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y))
}

/** データセーバー・低速回線（2g/slow-2g）が有効な環境では先読みしない。 */
export function shouldSkipPrefetch(): boolean {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined
  const conn = (nav as unknown as { connection?: { saveData?: boolean; effectiveType?: string } } | undefined)
    ?.connection
  if (!conn) return false
  if (conn.saveData) return true
  return conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g'
}

const requestIdle: (cb: () => void) => void =
  typeof requestIdleCallback === 'function' ? (cb) => requestIdleCallback(cb) : (cb) => setTimeout(cb, 200)

/**
 * 沖縄〜択捉相当の GEBCO タイルを、アイドル時に低ズーム優先・同時 CONCURRENCY 本までで
 * バックグラウンド fetch する。signal を abort すると残りのキューを止める。
 */
export function prefetchBathymetryTiles(signal: AbortSignal): void {
  if (shouldSkipPrefetch()) return
  const tiles = buildPrefetchTiles()
  let index = 0
  let active = 0

  const fillSlots = () => {
    while (!signal.aborted && active < CONCURRENCY && index < tiles.length) {
      active++
      const tile = tiles[index++]
      requestIdle(() => {
        if (signal.aborted) {
          active--
          return
        }
        fetch(tileUrl(tile), { signal })
          .catch(() => {})
          .finally(() => {
            active--
            fillSlots()
          })
      })
    }
  }

  fillSlots()
}
