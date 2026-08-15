import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  lngLatToTile,
  buildPrefetchTiles,
  shouldSkipPrefetch,
  MAX_TILE_ZOOM,
  GEBCO_OVERVIEW_MAX_ZOOM,
} from './gebcoPrefetch'

describe('lngLatToTile', () => {
  it('zoom0では常に(0,0)を返す（世界全体が1タイル）', () => {
    expect(lngLatToTile(139.767, 35.681, 0)).toEqual([0, 0])
    expect(lngLatToTile(-122.4, 37.8, 0)).toEqual([0, 0])
  })

  it('経度が大きいほどxが大きくなる（単調性）', () => {
    const [xWest] = lngLatToTile(122, 35, 6)
    const [xEast] = lngLatToTile(149, 35, 6)
    expect(xEast).toBeGreaterThan(xWest)
  })

  it('緯度が大きい（北側）ほどyが小さくなる（単調性）', () => {
    const [, yNorth] = lngLatToTile(135, 46, 6)
    const [, ySouth] = lngLatToTile(135, 24, 6)
    expect(yNorth).toBeLessThan(ySouth)
  })

  it('タイル座標は0〜(2^z-1)の範囲にクランプされる', () => {
    const z = 4
    const max = 2 ** z - 1
    const [x, y] = lngLatToTile(-180, 89, z)
    expect(x).toBeGreaterThanOrEqual(0)
    expect(y).toBeGreaterThanOrEqual(0)
    expect(x).toBeLessThanOrEqual(max)
    expect(y).toBeLessThanOrEqual(max)
  })
})

describe('buildPrefetchTiles', () => {
  it('zoom0からmaxZoomまで全ズームぶんのタイルを含む', () => {
    const tiles = buildPrefetchTiles(3)
    const zooms = new Set(tiles.map((t) => t.z))
    expect(zooms).toEqual(new Set([0, 1, 2, 3]))
  })

  it('低ズーム優先（z昇順）で並んでいる', () => {
    const tiles = buildPrefetchTiles(4)
    const zSequence = tiles.map((t) => t.z)
    const sorted = [...zSequence].sort((a, b) => a - b)
    expect(zSequence).toEqual(sorted)
  })

  it('同一タイルの重複がない', () => {
    const tiles = buildPrefetchTiles(4)
    const keys = tiles.map((t) => `${t.z}/${t.x}/${t.y}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('引数なしのとき MAX_TILE_ZOOM までの全ズームを含む（自動フィット上限で使うタイルを漏らさない）', () => {
    const zooms = new Set(buildPrefetchTiles().map((t) => t.z))
    const expected = new Set(Array.from({ length: MAX_TILE_ZOOM + 1 }, (_, z) => z))
    expect(zooms).toEqual(expected)
  })

  it('常時下地のオーバービュー層が使う z のタイルがキューの先頭に固まっている（下地が最速で温まる前提）', () => {
    // 下地層は「遠距離フィットの直後でも必ず描かれている」ことが役割なので、先読みの完走を待たずに
    // 揃う必要がある。低ズーム優先で並ぶ実装ゆえ、下地に要る z のタイルはキュー先頭に連続して収まる。
    const tiles = buildPrefetchTiles()
    const overviewCount = tiles.filter((t) => t.z <= GEBCO_OVERVIEW_MAX_ZOOM).length
    expect(overviewCount).toBeGreaterThan(0)
    expect(tiles.slice(0, overviewCount).every((t) => t.z <= GEBCO_OVERVIEW_MAX_ZOOM)).toBe(true)
    // 先読み全体のごく一部（1 割未満）で下地が揃う。ここが膨らむと下地の温まりが遅れる。
    expect(overviewCount).toBeLessThan(tiles.length * 0.1)
  })
})

describe('shouldSkipPrefetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('navigator.connection が無い場合はスキップしない', () => {
    vi.stubGlobal('navigator', {})
    expect(shouldSkipPrefetch()).toBe(false)
  })

  it('saveData が true の場合はスキップする', () => {
    vi.stubGlobal('navigator', { connection: { saveData: true } })
    expect(shouldSkipPrefetch()).toBe(true)
  })

  it('effectiveType が 2g の場合はスキップする', () => {
    vi.stubGlobal('navigator', { connection: { effectiveType: '2g' } })
    expect(shouldSkipPrefetch()).toBe(true)
  })

  it('effectiveType が 4g の場合はスキップしない', () => {
    vi.stubGlobal('navigator', { connection: { effectiveType: '4g' } })
    expect(shouldSkipPrefetch()).toBe(false)
  })
})
