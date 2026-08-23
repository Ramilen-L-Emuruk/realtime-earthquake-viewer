import { describe, it, expect } from 'vitest'
import { syncEewFirstSeen } from './eewFirstSeen'
import type { EEWAlert } from '../../../types/earthquake'

// 初出時刻の台帳（`FitToEEWGL` が「新規発報」と「発報中の EEW への入室」を分ける材料）の回帰テスト。
// 台帳は全モードで生きている `JapanMapGL` が持つため、実機では「別タブに居る間に発報 → 数十秒後に
// リアルタイム震度タブへ入る」といった長い時間軸の操作でしか境界を踏めない。純関数として固定する。

/**
 * 台帳が見るのは eventId（`issue.eventId ?? id`）と震源座標だけ。実電文はどの経路でも
 * `issue.eventId` を持つので、フィクスチャもその形にする（`id` は報ごとに変わる識別子）。
 */
const eew = (eventId: string, lat = 37.5, lng = 137.2): EEWAlert =>
  ({
    id: `report-${eventId}`,
    issue: { eventId },
    earthquake: { hypocenter: { latitude: lat, longitude: lng } },
  }) as unknown as EEWAlert

/** 位置不明のセンチネル（標準版の P2PQuake が座標を持たない報で寄こす値）。 */
const COORD_UNKNOWN = -200

describe('syncEewFirstSeen', () => {
  it('初めて見た EEW の時刻を刻み、以降は上書きしない', () => {
    // Arrange
    const seen = new Map<string, number>()
    const focused = { current: null as string | null }

    // Act: 同じ EEW を 2 度見る（続報が届いた状況）。
    syncEewFirstSeen(seen, focused, [eew('a')], 1000)
    syncEewFirstSeen(seen, focused, [eew('a')], 5000)

    // Assert: 初出の時刻のまま。上書きすると、続報が来るたびに「新規発報」に戻ってしまう。
    expect(seen.get('a')).toBe(1000)
  })

  it('発報が終わった EEW は、記録とフォーカス済みの印を一緒に落とす', () => {
    // Arrange: 第一報のフォーカスを与え終えた状態。
    const seen = new Map<string, number>()
    const focused = { current: null as string | null }
    syncEewFirstSeen(seen, focused, [eew('a')], 1000)
    focused.current = 'a'

    // Act: EEW が消える → 同じ eventId で再び現れる（テスト時刻設定で同じ日時を再生し直すと、
    // ID を採番し直さないため実際に起きる）。
    syncEewFirstSeen(seen, focused, [], 2000)
    expect(seen.has('a')).toBe(false)
    expect(focused.current).toBeNull()
    syncEewFirstSeen(seen, focused, [eew('a')], 3000)

    // Assert: 再出現は新しい初出時刻を得る。**印を落とさないと第一報のフォーカスが二度と出ない**
    // （`FitToEEWGL` は focusedEewIdRef と一致する EEW にはフォーカスを与えないため）。
    expect(seen.get('a')).toBe(3000)
    expect(focused.current).toBeNull()
  })

  it('別の EEW が発報中なら、フォーカス済みの印は落とさない', () => {
    // Arrange: 2 本発報中で、新しい方にフォーカスを与えている。
    const seen = new Map<string, number>()
    const focused = { current: null as string | null }
    syncEewFirstSeen(seen, focused, [eew('a'), eew('b')], 1000)
    focused.current = 'b'

    // Act: 古い方だけが終わる。
    syncEewFirstSeen(seen, focused, [eew('b')], 2000)

    // Assert: 生きている EEW の印は残す（落とすと続報のたびに第一報の寄りをやり直す）。
    expect(seen.has('a')).toBe(false)
    expect(focused.current).toBe('b')
  })

  it('震源座標が無い間は記録せず、座標が付いた時点を初出とする', () => {
    // Arrange: 位置不明で届いた報。`FitToEEWGL` はこの間カメラを動かさない。
    const seen = new Map<string, number>()
    const focused = { current: null as string | null }

    // Act
    syncEewFirstSeen(seen, focused, [eew('a', COORD_UNKNOWN, COORD_UNKNOWN)], 1000)
    expect(seen.has('a')).toBe(false)
    syncEewFirstSeen(seen, focused, [eew('a')], 30_000)

    // Assert: 座標が確定した時刻で刻む。位置不明の時点から数えると、寄れるようになったときには
    // 既に第一報の猶予（NEW_EEW_FOCUS_WINDOW_MS）を過ぎていて、入室扱いに倒れてしまう。
    expect(seen.get('a')).toBe(30_000)
  })

  it('eventId は issue.eventId を優先し、無ければ id で代用する', () => {
    // Arrange: 実電文はどの経路でも issue.eventId を持つ。id での代用は欠けていた場合の保険。
    const seen = new Map<string, number>()
    const focused = { current: null as string | null }
    const withEventId = {
      id: 'report-1',
      issue: { eventId: 'ev-1' },
      earthquake: { hypocenter: { latitude: 37.5, longitude: 137.2 } },
    } as unknown as EEWAlert

    // Act: 続報で id（報の識別子）だけが変わる。
    syncEewFirstSeen(seen, focused, [withEventId], 1000)
    syncEewFirstSeen(seen, focused, [{ ...withEventId, id: 'report-2' } as EEWAlert], 5000)

    // Assert: 同じ地震として 1 件に畳まれる（報ごとに別物として数えると、続報のたびに新規発報になる）。
    expect([...seen.entries()]).toEqual([['ev-1', 1000]])

    // Act 2: issue を持たない報。
    const withoutIssue = {
      id: 'report-9',
      earthquake: { hypocenter: { latitude: 37.5, longitude: 137.2 } },
    } as unknown as EEWAlert
    syncEewFirstSeen(seen, focused, [withEventId, withoutIssue], 7000)

    // Assert 2: id を代わりのキーにする。
    expect(seen.get('report-9')).toBe(7000)
  })
})
