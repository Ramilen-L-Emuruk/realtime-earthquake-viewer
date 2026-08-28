import 'fake-indexeddb/auto'
import { describe, expect, test } from 'vitest'
import {
  countImportedEvents,
  deleteImportedEvents,
  getMergedKyoshinArchive,
  hasImportStorageError,
  listImportedEvents,
  saveImportedEvent,
} from './kyoshinImportDb'
import type { EventResult } from './knet/kyoshinEventMerge'

/**
 * `fake-indexeddb/auto` はプロセス全体で1つのIndexedDB実装をグローバルに提供する
 * （テストごとにDBを作り直さない）。テスト間の干渉を避けるため、テストごとに異なる
 * archiveIdを使う（データはarchiveId単位で分離されるため、削除・リセット処理は不要）。
 */
function makeEvent(originTimeJst: string, stations: { code: string; lat: number; lon: number; intensity: number }[]): EventResult {
  const stationSeries = stations.map((s) => ({
    stationCode: s.code,
    latitude: s.lat,
    longitude: s.lon,
    points: [{ epochSec: 1000, intensity: s.intensity }],
  }))
  return { originTimeJst, stationSeries, peakIntensity: Math.max(...stations.map((s) => s.intensity)) }
}

describe('kyoshinImportDb', () => {
  test('正: 保存したイベントをarchiveId単位で読み出せる', async () => {
    const archiveId = 'test-archive-basic'
    const event = makeEvent('20180906030800', [{ code: 'AAA', lat: 1, lon: 1, intensity: 5.0 }])
    expect(await saveImportedEvent(archiveId, event)).toBe(true)

    const events = await listImportedEvents(archiveId)
    expect(events).toHaveLength(1)
    expect(events[0].originTimeJst).toBe('20180906030800')
    expect(await countImportedEvents(archiveId)).toBe(1)
  })

  test('対照: 別のarchiveIdのデータは混ざらない', async () => {
    const archiveA = 'test-archive-a'
    const archiveB = 'test-archive-b'
    await saveImportedEvent(archiveA, makeEvent('20180906030800', [{ code: 'AAA', lat: 1, lon: 1, intensity: 5.0 }]))
    await saveImportedEvent(archiveB, makeEvent('20181005090000', [{ code: 'BBB', lat: 2, lon: 2, intensity: 4.0 }]))

    expect(await countImportedEvents(archiveA)).toBe(1)
    expect(await countImportedEvents(archiveB)).toBe(1)
    expect((await listImportedEvents(archiveA))[0].originTimeJst).toBe('20180906030800')
    expect((await listImportedEvents(archiveB))[0].originTimeJst).toBe('20181005090000')
  })

  test('安全弁: 同じイベント（同じorigin）を再インポートしても重複しない（冪等性）', async () => {
    const archiveId = 'test-archive-idempotent'
    const event = makeEvent('20180906030800', [{ code: 'AAA', lat: 1, lon: 1, intensity: 5.0 }])
    await saveImportedEvent(archiveId, event)
    await saveImportedEvent(archiveId, event)
    await saveImportedEvent(archiveId, event)
    expect(await countImportedEvents(archiveId)).toBe(1)
  })

  test('正: 複数イベントをOrigin Time昇順で返す（保存順ではない）', async () => {
    const archiveId = 'test-archive-order'
    await saveImportedEvent(archiveId, makeEvent('20180906061139', [{ code: 'AAA', lat: 1, lon: 1, intensity: 3.0 }]))
    await saveImportedEvent(archiveId, makeEvent('20180906030800', [{ code: 'BBB', lat: 2, lon: 2, intensity: 5.0 }]))

    const events = await listImportedEvents(archiveId)
    expect(events.map((e) => e.originTimeJst)).toEqual(['20180906030800', '20180906061139'])
  })

  test('正: deleteImportedEventsでアーカイブ単位の全件を削除できる', async () => {
    const archiveId = 'test-archive-delete'
    await saveImportedEvent(archiveId, makeEvent('20180906030800', [{ code: 'AAA', lat: 1, lon: 1, intensity: 5.0 }]))
    expect(await countImportedEvents(archiveId)).toBe(1)

    expect(await deleteImportedEvents(archiveId)).toBe(true)
    expect(await countImportedEvents(archiveId)).toBe(0)
  })

  test('getMergedKyoshinArchive: インポート済みイベントが無ければnullを返す', async () => {
    const archive = await getMergedKyoshinArchive('test-archive-empty', 1)
    expect(archive).toBeNull()
  })

  test('getMergedKyoshinArchive: 複数イベントを統合したLocalKyoshinArchiveを返す', async () => {
    const archiveId = 'test-archive-merged'
    await saveImportedEvent(archiveId, makeEvent('20180906030800', [{ code: 'AAA', lat: 1, lon: 1, intensity: 5.0 }]))
    await saveImportedEvent(archiveId, makeEvent('20181005090000', [{ code: 'BBB', lat: 2, lon: 2, intensity: 4.0 }]))

    const archive = await getMergedKyoshinArchive(archiveId, 1)
    expect(archive).not.toBeNull()
    expect(archive!.id).toBe(archiveId)
    expect(archive!.stationCodes.sort()).toEqual(['AAA', 'BBB'])
    expect(archive!.frames.length).toBeGreaterThan(0)
  })

  test('安全弁（CRITICAL回帰）: 読み取りが失敗した場合はnullではなくrejectし、hasImportStorageErrorがtrueになる', async () => {
    // 「本当に0件だった」と「読み書きに失敗した」を区別できないと、IndexedDB障害時に
    // getMergedKyoshinArchiveが常に「未インポート」を返し、kyoshinLocalArchiveSource.tsの
    // 障害可視化（setStalled(true)）が発火しなくなる（敵対的レビューで検出した回帰）。
    const archiveId = 'test-archive-read-failure'
    const original = IDBIndex.prototype.getAll
    IDBIndex.prototype.getAll = () => { throw new Error('simulated read failure') }
    try {
      await expect(getMergedKyoshinArchive(archiveId, 1)).rejects.toThrow()
      expect(hasImportStorageError()).toBe(true)
    } finally {
      IDBIndex.prototype.getAll = original
    }

    // 回復後は次の成功した操作でフラグが戻ること（一度失敗すると恒久的にtrueへ張り付かない）。
    await saveImportedEvent(archiveId, makeEvent('20180906030800', [{ code: 'AAA', lat: 1, lon: 1, intensity: 5.0 }]))
    expect(hasImportStorageError()).toBe(false)
  })

  test('安全弁: countImportedEventsは読み取り失敗時に例外を投げず0件扱いにする（UI表示用の耐性）', async () => {
    const archiveId = 'test-archive-count-failure'
    const original = IDBIndex.prototype.count
    IDBIndex.prototype.count = () => { throw new Error('simulated count failure') }
    try {
      await expect(countImportedEvents(archiveId)).resolves.toBe(0)
    } finally {
      IDBIndex.prototype.count = original
    }
  })

  test('安全弁: deleteImportedEventsは読み取りに失敗した場合、0件でも成功したと偽らずfalseを返す', async () => {
    const archiveId = 'test-archive-delete-failure'
    const original = IDBIndex.prototype.getAll
    IDBIndex.prototype.getAll = () => { throw new Error('simulated read failure') }
    try {
      expect(await deleteImportedEvents(archiveId)).toBe(false)
    } finally {
      IDBIndex.prototype.getAll = original
    }
  })
})
