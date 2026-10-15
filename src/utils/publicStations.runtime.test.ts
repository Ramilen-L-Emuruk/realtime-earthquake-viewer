// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicStationsFile } from './publicStations'
const h = vi.hoisted(() => ({ load: vi.fn(), verify: vi.fn() }))
vi.mock('./fetchJson', () => ({ fetchJsonWithTimeout: h.load }))
vi.mock('../services/publicStationMetadata', () => ({ fetchPublicStationMetadata: h.verify }))
let stations = await import('./publicStations')
const baseline: PublicStationsFile = { source: { station: '', channel: '' }, fetchedOn: '2026-10-15', stations: [], excluded: [] }
beforeEach(async () => {
  vi.resetModules()
  h.load.mockReset().mockResolvedValue(baseline)
  h.verify.mockReset()
  stations = await import('./publicStations')
})
describe('観測点情報の1回照合', () => {
  it('2つの利用者の要求を1回にまとめ、更新を両方へ渡し、次の読み手にも渡す', async () => {
    const next = { ...baseline, fetchedOn: '2026-10-16' }
    h.verify.mockResolvedValue(next)
    const a = vi.fn(), b = vi.fn()
    const offA = stations.subscribePublicStations(a), offB = stations.subscribePublicStations(b)
    expect(await stations.loadPublicStations()).toBe(baseline)
    expect(h.verify).not.toHaveBeenCalled()
    await Promise.all([stations.checkPublicStations(), stations.checkPublicStations()])
    expect(h.verify).toHaveBeenCalledTimes(1)
    expect(a).toHaveBeenCalledWith(next)
    expect(b).toHaveBeenCalledWith(next)
    expect(await stations.loadPublicStations()).toBe(next)
    offA(); offB()
    await stations.checkPublicStations()
    expect(h.verify).toHaveBeenCalledTimes(1)
  })
  it('照合失敗なら生成済みの表を保ち、再接続のたびに問い合わせない', async () => {
    h.verify.mockRejectedValue(new Error('offline'))
    expect(await stations.checkPublicStations()).toBe(baseline)
    expect(await stations.checkPublicStations()).toBe(baseline)
    expect(await stations.loadPublicStations()).toBe(baseline)
    expect(h.verify).toHaveBeenCalledTimes(1)
  })
})
