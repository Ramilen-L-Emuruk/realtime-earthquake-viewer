import { describe, it, expect } from 'vitest'
import {
  advanceQuakeMarks, changedQuakeFacts, diffQuakeRows, lpgmMarkKey, lpgmRowSnapshot,
  pruneQuakeMarks, quakeFactSnapshot, quakeRowSnapshot, rowMarkKey, rowMarkOf,
  type QuakeMarkMemory,
} from './quakeUpdateMark'
import { UPDATE_MARK_TTL_MS } from './updateMark'
import type { EarthquakePoint, IntensityScale, JMAQuake, JMAQuakeCity } from '../types/earthquake'

function makeQuake(over: {
  name?: string
  lat?: number
  lng?: number
  depth?: number
  magnitude?: number
  magnitudeCondition?: string
  domesticTsunami?: JMAQuake['earthquake']['domesticTsunami']
  maxScale?: IntensityScale
} = {}): JMAQuake {
  return {
    kind: 'quake',
    id: 'test-1',
    time: '2024-01-01T16:10:00+09:00',
    issue: { source: 'テスト', time: '2024-01-01T16:10:00+09:00', type: '震源・震度情報', correct: 'なし' },
    earthquake: {
      time: '2024-01-01T16:10:00+09:00',
      hypocenter: {
        name: over.name ?? '能登半島沖',
        latitude: over.lat ?? 37.5,
        longitude: over.lng ?? 137.2,
        depth: over.depth ?? 10,
        magnitude: over.magnitude ?? 7.6,
        ...(over.magnitudeCondition ? { magnitudeCondition: over.magnitudeCondition } : {}),
      },
      maxScale: over.maxScale ?? 70,
      domesticTsunami: over.domesticTsunami ?? '警報等',
    },
    points: [],
  } as JMAQuake
}

const station = (addr: string, scale: IntensityScale, over: Partial<EarthquakePoint> = {}): EarthquakePoint =>
  ({ pref: '石川県', addr, isArea: false, scale, ...over }) as EarthquakePoint
const area = (addr: string, scale: IntensityScale): EarthquakePoint =>
  ({ pref: '', addr, isArea: true, scale }) as EarthquakePoint
const city = (name: string, areaName: string, scale: IntensityScale, over: Partial<JMAQuakeCity> = {}): JMAQuakeCity =>
  ({ name, area: areaName, pref: '石川県', scale, ...over }) as JMAQuakeCity

const snapRows = (points: EarthquakePoint[], cities: JMAQuakeCity[] = []) =>
  quakeRowSnapshot(points, cities)

/**
 * 都道府県ロールアップ点（電文の `Pref/MaxInt` 由来）。**`isArea` が真で `pref` を持つ。**
 * 行にはならず、県の最大にしか効かない（→ `buildIntensityRows`）。
 */
const prefRollup = (pref: string, scale: IntensityScale): EarthquakePoint =>
  ({ pref, addr: pref, isArea: true, scale }) as EarthquakePoint

describe('地震カードの更新の印', () => {
  describe('震源要素・最大震度', () => {
    // 正: 値が上がったら「上がった」の印。
    it('規模が上がったら上がったの印が出る', () => {
      const before = quakeFactSnapshot(makeQuake({ magnitude: 7.4 }))
      const after = quakeFactSnapshot(makeQuake({ magnitude: 7.6 }))
      expect(changedQuakeFacts(after, before).get('magnitude')).toBe('raised')
    })

    // 対照: 下がったら別の印。**同じ「動いた」で畳まない。**
    it('規模が下がったら下がったの印が出る', () => {
      const before = quakeFactSnapshot(makeQuake({ magnitude: 7.6 }))
      const after = quakeFactSnapshot(makeQuake({ magnitude: 7.4 }))
      expect(changedQuakeFacts(after, before).get('magnitude')).toBe('lowered')
    })

    // 正: **浅くなったら「上がった」**（浅いほど危険なので、赤が「より深刻」を指す約束を守る）。
    it('震源が浅くなったら上がったの印が出る', () => {
      const before = quakeFactSnapshot(makeQuake({ depth: 30 }))
      const after = quakeFactSnapshot(makeQuake({ depth: 10 }))
      expect(changedQuakeFacts(after, before).get('depth')).toBe('raised')
    })

    // 正: 大小の無い欄は向きを言わない。
    it('震央地名が変わったら向きの無い印が出る', () => {
      const before = quakeFactSnapshot(makeQuake({ name: '能登半島沖' }))
      const after = quakeFactSnapshot(makeQuake({ name: '石川県能登地方' }))
      expect(changedQuakeFacts(after, before).get('hypocenterName')).toBe('changed')
    })

    // 対照: 津波区分の「調査中」「不明」は値ではなく「まだ決まっていない」なので、
    // **そこから確定した報には印を付けない**（震源が未確定から確定した報と同じ扱い）。
    it('津波区分は調査中から確定しても印を出さない', () => {
      const before = quakeFactSnapshot(makeQuake({ domesticTsunami: '調査中' }))
      const after = quakeFactSnapshot(makeQuake({ domesticTsunami: 'なし' }))
      expect(changedQuakeFacts(after, before).size).toBe(0)
    })

    // 正: **逆向きは印を付ける。** 確定していた区分が調査中へ戻るのは気象庁が取り下げた事実。
    it('津波区分が確定から調査中へ戻ったら印を出す', () => {
      const before = quakeFactSnapshot(makeQuake({ domesticTsunami: 'なし' }))
      const after = quakeFactSnapshot(makeQuake({ domesticTsunami: '調査中' }))
      expect(changedQuakeFacts(after, before).get('domesticTsunami')).toBe('changed')
    })

    // 対照: 重さの決まっている値どうしなら向きが出る。
    it('津波区分が警報等から注意報へ下がったら下がったの印が出る', () => {
      const before = quakeFactSnapshot(makeQuake({ domesticTsunami: '警報等' }))
      const after = quakeFactSnapshot(makeQuake({ domesticTsunami: '注意報' }))
      expect(changedQuakeFacts(after, before).get('domesticTsunami')).toBe('lowered')
    })

    // 対照: **値が無いところへ値が付いただけなら印を付けない。** 震度速報 → 震源情報 の遷移が
    // これで、付けると震源が確定した報で欄が一斉に光る。欄の顔ぶれは決まっていて常に見えて
    // いるので、値が付いたこと自体をその欄が語っている。
    it('震源が未確定から確定しただけでは印を出さない', () => {
      const prompt = quakeFactSnapshot(makeQuake({ name: '', lat: -200, lng: -200, depth: -1, magnitude: -1 }))
      const settled = quakeFactSnapshot(makeQuake())
      expect(changedQuakeFacts(settled, prompt).size).toBe(0)
    })

    // 正: 値が消えたのは向きの無い変化。**「下がった」ではない** —— 小さくなったのではなく
    // 気象庁が取り下げたので、大小の話にしない。
    it('値が取り下げられたら向きの無い印が出る', () => {
      const before = quakeFactSnapshot(makeQuake({ magnitude: 7.6 }))
      const after = quakeFactSnapshot(makeQuake({ magnitude: -1 }))
      expect(changedQuakeFacts(after, before).get('magnitude')).toBe('changed')
    })

    // 対照: 前report が無ければ何も出ない（全欄が初出になって画面を埋める）。
    it('そのカードで最初に見た報では印を出さない', () => {
      expect(changedQuakeFacts(quakeFactSnapshot(makeQuake()), undefined).size).toBe(0)
    })

    // 対照: 同じ値なら出ない。
    it('値が動いていなければ印を出さない', () => {
      const snap = quakeFactSnapshot(makeQuake())
      expect(changedQuakeFacts(snap, snap).size).toBe(0)
    })

    // 安全弁: 規模は**数値と説明の両方**を鍵に含める。「Ｍ８を超える巨大地震」は本文が NaN で
    // `description` だけが値を持つので、数値だけで比べるとその変化が消える。
    it('数値が読めないまま説明だけが変わっても印が出る', () => {
      const before = quakeFactSnapshot(makeQuake({ magnitude: NaN, magnitudeCondition: '不明' }))
      const after = quakeFactSnapshot(makeQuake({ magnitude: NaN, magnitudeCondition: 'Ｍ８を超える巨大地震' }))
      // 数値が無いので大小は言えない。向きの無い変化として出す。
      expect(changedQuakeFacts(after, before).get('magnitude')).toBe('changed')
    })

    // 安全弁: 位置不明のセンチネル（-200）を座標として扱わない。
    it('位置不明のセンチネルは座標として扱わない', () => {
      const snap = quakeFactSnapshot(makeQuake({ lat: -200, lng: -200 }))
      expect(snap.get('coordinate')?.key).toBe('')
    })
  })

  describe('震度一覧の行', () => {
    // 正: 既にあった行の値が動いたら「更新」。
    it('観測点の震度が上がったら上がったの印が出る', () => {
      const before = snapRows([station('輪島', 50), station('珠洲', 40)])
      const after = snapRows([station('輪島', 60), station('珠洲', 40)])
      const marks = diffQuakeRows(after, before)
      expect(marks.get(rowMarkKey.station('輪島'))).toBe('raised')
      expect(marks.has(rowMarkKey.station('珠洲'))).toBe(false)
    })

    // 対照: 下がった行は別の印。
    it('観測点の震度が下がったら下がったの印が出る', () => {
      const before = snapRows([station('輪島', 60)])
      const after = snapRows([station('輪島', 50)])
      expect(diffQuakeRows(after, before).get(rowMarkKey.station('輪島'))).toBe('lowered')
    })

    // 正: その段が既に出ている報で新しい行が増えたら「初出」。
    it('観測点が増えたら初出の印が出る', () => {
      const before = snapRows([station('輪島', 50)])
      const after = snapRows([station('輪島', 50), station('珠洲', 40)])
      expect(diffQuakeRows(after, before).get(rowMarkKey.station('珠洲'))).toBe('new')
    })

    // 対照: **その段が初めて現れた報では印を付けない。**
    // 「震度速報 → 各地の震度」では観測点の行がいっぺんに全部現れる（実測で最大 2,825 行）。
    it('観測点の段が初めて現れた報では印を付けない', () => {
      const prompt = snapRows([area('能登', 70)])
      const detail = snapRows([area('能登', 70), station('輪島', 70), station('珠洲', 60)])
      const marks = diffQuakeRows(detail, prompt)
      expect(marks.has(rowMarkKey.station('輪島'))).toBe(false)
      expect(marks.has(rowMarkKey.station('珠洲'))).toBe(false)
    })

    // 安全弁: **都道府県ロールアップ点を観測点として数えない。**
    //
    // 電文の `Pref/MaxInt` は `isArea` が真で `pref` を持つ点として届く。これを観測点の側へ
    // 振り分けると、震度速報の段階で `st:` の記憶ができ、**次の「各地の震度」で観測点が
    // 数千行いっぺんに光る**（上の抑止が効かなくなる）。
    it('都道府県ロールアップ点は観測点の段として数えない', () => {
      const prompt = snapRows([prefRollup('石川県', 70), area('能登', 70)])
      expect([...prompt.keys()].some(k => k.startsWith('st:'))).toBe(false)
      // その結果、次の報で初めて現れる観測点は抑止される。
      const detail = snapRows([prefRollup('石川県', 70), area('能登', 70), station('輪島', 70)])
      expect(diffQuakeRows(detail, prompt).has(rowMarkKey.station('輪島'))).toBe(false)
    })

    // 対照: ロールアップ点は県の最大としては効く（落としているのではなく、行にしないだけ）。
    it('都道府県ロールアップ点は県の最大には効く', () => {
      expect(snapRows([prefRollup('石川県', 70)]).get(rowMarkKey.pref('石川県'))?.key).toBe('70')
    })

    // 対照: 区域の段は既に出ているので、同じ報で区域が増えれば印は付く（段ごとに見ている）。
    it('既に出ている段の行は、同じ報でも印が付く', () => {
      const prompt = snapRows([area('能登', 70)])
      const detail = snapRows([area('能登', 70), area('加賀', 50), station('輪島', 70)])
      const marks = diffQuakeRows(detail, prompt)
      expect(marks.get(rowMarkKey.area('加賀'))).toBe('new')
      expect(marks.has(rowMarkKey.station('輪島'))).toBe(false)
    })

    // 対照: 前が無ければ何も出ない。
    it('そのカードで最初に見た報では行の印を出さない', () => {
      expect(diffQuakeRows(snapRows([station('輪島', 50)]), undefined).size).toBe(0)
    })

    // 安全弁: 未入電は下限の 45 が入るので、階級だけで比べると観測値が届いた瞬間を取りこぼす。
    it('未入電から観測値へ変わったら印が出る（階級が同じでも）', () => {
      const before = snapRows([station('輪島', 45, { unreceived: true })])
      const after = snapRows([station('輪島', 45)])
      // 階級は動いていないので**向きは言わない**。未入電が解けたのは大小の話ではない。
      expect(diffQuakeRows(after, before).get(rowMarkKey.station('輪島'))).toBe('changed')
    })

    // 安全弁: 市町村は区域との組で鍵にする（名前だけでは一意にならない）。
    it('同名の市町村を区域で見分ける', () => {
      const before = snapRows([], [city('府中市', '東京都多摩北部', 30), city('府中市', '広島県南西部', 20)])
      const after = snapRows([], [city('府中市', '東京都多摩北部', 40), city('府中市', '広島県南西部', 20)])
      const marks = diffQuakeRows(after, before)
      expect(marks.get(rowMarkKey.city('東京都多摩北部', '府中市'))).toBe('raised')
      expect(marks.has(rowMarkKey.city('広島県南西部', '府中市'))).toBe(false)
    })

    // 安全弁: 県の行は配下の最大。点の順序で上書きされない。
    it('県の行は配下の最大を採る（点の並び順に依らない）', () => {
      const ascending = snapRows([station('a', 30), station('b', 60)])
      const descending = snapRows([station('b', 60), station('a', 30)])
      expect(ascending.get(rowMarkKey.pref('石川県'))?.key).toBe('60')
      expect(descending.get(rowMarkKey.pref('石川県'))?.key).toBe('60')
    })
  })

  describe('親の行への持ち上げ', () => {
    // 正: 配下が動いていれば親にも印が出る（一覧は既定で畳んである）。
    it('配下が動いたら親の行にも印が出る', () => {
      const marks = new Map([[rowMarkKey.station('輪島'), 'raised' as const]])
      expect(rowMarkOf(rowMarkKey.area('能登'), [rowMarkKey.station('輪島')], marks)).toBe('raised')
    })

    // 正: 配下の向きが混ざったら**いちばん重いものを採る**（畳んだ親は 1 つしか言えない）。
    it('配下の向きが混ざったら上がった側を採る', () => {
      const marks = new Map<string, 'raised' | 'lowered'>([
        [rowMarkKey.station('輪島'), 'lowered'],
        [rowMarkKey.station('珠洲'), 'raised'],
      ])
      const keys = [rowMarkKey.station('輪島'), rowMarkKey.station('珠洲')]
      expect(rowMarkOf(rowMarkKey.area('能登'), keys, marks)).toBe('raised')
    })

    // 対照: 配下も自分も動いていなければ印は出ない。
    it('配下が動いていなければ印は出ない', () => {
      expect(rowMarkOf(rowMarkKey.area('能登'), [rowMarkKey.station('輪島')], new Map())).toBeUndefined()
    })

    // 安全弁: 自分自身が初出なら、配下より自分の印を優先する。
    it('自分自身の印を配下より優先する', () => {
      const marks = new Map([
        [rowMarkKey.area('能登'), 'new' as const],
        [rowMarkKey.station('輪島'), 'raised' as const],
      ])
      expect(rowMarkOf(rowMarkKey.area('能登'), [rowMarkKey.station('輪島')], marks)).toBe('new')
    })
  })

  describe('記憶の持ち回り', () => {
    const memoryOf = (q: JMAQuake, points: EarthquakePoint[]): QuakeMarkMemory =>
      ({ facts: quakeFactSnapshot(q), rows: snapRows(points) })

    // 正: 続報で動いた分が印になり、記憶は進む。
    it('続報で動いた分を印にして記憶を進める', () => {
      const first = advanceQuakeMarks({
        prev: { memory: new Map(), marks: new Map() },
        key: 'q1',
        snapshot: memoryOf(makeQuake({ magnitude: 7.4 }), [station('輪島', 50)]),
        liveKeys: new Set(['q1']),
        now: 1000,
      })
      expect(first.marks.size).toBe(0)
      const second = advanceQuakeMarks({
        prev: { memory: first.memory, marks: first.marks },
        key: 'q1',
        snapshot: memoryOf(makeQuake({ magnitude: 7.6 }), [station('輪島', 60)]),
        liveKeys: new Set(['q1']),
        now: 2000,
      })
      expect(second.marks.get('q1')?.facts.get('magnitude')).toBe('raised')
      expect(second.marks.get('q1')?.rows.get(rowMarkKey.station('輪島'))).toBe('raised')
    })

    // 対照: 動いたものが無ければ印を置かない（TTL の掃除が空の鍵を抱えないように）。
    it('何も動かなければ印を置かない', () => {
      const snapshot = memoryOf(makeQuake(), [station('輪島', 50)])
      const first = advanceQuakeMarks({
        prev: { memory: new Map(), marks: new Map() }, key: 'q1', snapshot, liveKeys: new Set(['q1']), now: 1000,
      })
      const second = advanceQuakeMarks({
        prev: { memory: first.memory, marks: first.marks }, key: 'q1', snapshot, liveKeys: new Set(['q1']), now: 2000,
      })
      expect(second.marks.has('q1')).toBe(false)
    })

    // 安全弁: **動いたものが無い報で、前の印を消さない。**
    //
    // `mergeQuakeInto` は中身を据え置いた報でも新しいオブジェクトを返すことがある（受け取った
    // 種別の記録が増えるため）ので、種別の違う報が続けて届くだけで差分が空のまま呼ばれる。
    // そこで消すと、直前の報で付いた印が利用者の目に入る前に消える。
    it('動いたものが無い報では前の印を残す', () => {
      const first = advanceQuakeMarks({
        prev: { memory: new Map(), marks: new Map() },
        key: 'q1',
        snapshot: memoryOf(makeQuake({ magnitude: 7.4 }), [station('輪島', 50)]),
        liveKeys: new Set(['q1']), now: 1000,
      })
      const second = advanceQuakeMarks({
        prev: { memory: first.memory, marks: first.marks },
        key: 'q1',
        snapshot: memoryOf(makeQuake({ magnitude: 7.6 }), [station('輪島', 50)]),
        liveKeys: new Set(['q1']), now: 2000,
      })
      expect(second.marks.get('q1')?.facts.get('magnitude')).toBe('raised')
      // 同じ中身のまま、もう 1 通処理される（種別の記録だけが動いた報）。
      const third = advanceQuakeMarks({
        prev: { memory: second.memory, marks: second.marks },
        key: 'q1',
        snapshot: memoryOf(makeQuake({ magnitude: 7.6 }), [station('輪島', 50)]),
        liveKeys: new Set(['q1']), now: 3000,
      })
      expect(third.marks.get('q1')?.facts.get('magnitude')).toBe('raised')
      expect(third.marks.get('q1')?.markedAt).toBe(1000 + 1000)
    })

    // 対照: 寿命を過ぎていれば残さない（残す条件は TTL の中だけ）。
    it('寿命を過ぎた印は、動きの無い報で残さない', () => {
      const first = advanceQuakeMarks({
        prev: { memory: new Map(), marks: new Map() },
        key: 'q1',
        snapshot: memoryOf(makeQuake({ magnitude: 7.4 }), [station('輪島', 50)]),
        liveKeys: new Set(['q1']), now: 1000,
      })
      const second = advanceQuakeMarks({
        prev: { memory: first.memory, marks: first.marks },
        key: 'q1',
        snapshot: memoryOf(makeQuake({ magnitude: 7.6 }), [station('輪島', 50)]),
        liveKeys: new Set(['q1']), now: 2000,
      })
      const later = advanceQuakeMarks({
        prev: { memory: second.memory, marks: second.marks },
        key: 'q1',
        snapshot: memoryOf(makeQuake({ magnitude: 7.6 }), [station('輪島', 50)]),
        liveKeys: new Set(['q1']), now: 2000 + UPDATE_MARK_TTL_MS,
      })
      expect(later.marks.has('q1')).toBe(false)
    })

    // 安全弁: 一覧から消えたカードの記憶と印は捨てる（群発で観測点の写しが積み上がる）。
    it('一覧に残っていないカードの記憶と印を捨てる', () => {
      const first = advanceQuakeMarks({
        prev: { memory: new Map(), marks: new Map() },
        key: 'gone',
        snapshot: memoryOf(makeQuake(), [station('輪島', 50)]),
        liveKeys: new Set(['gone']),
        now: 1000,
      })
      const second = advanceQuakeMarks({
        prev: { memory: first.memory, marks: first.marks },
        key: 'q2',
        snapshot: memoryOf(makeQuake(), [station('珠洲', 40)]),
        liveKeys: new Set(['q2']),
        now: 2000,
      })
      expect(second.memory.has('gone')).toBe(false)
      expect(second.marks.has('gone')).toBe(false)
    })

    // 安全弁: 長周期の鍵は地震の鍵と混ざらない（行の鍵は同じ名前空間を使うため）。
    it('長周期の印は地震の印と別の鍵に入る', () => {
      const withQuake = advanceQuakeMarks({
        prev: { memory: new Map(), marks: new Map() },
        key: 'q1',
        snapshot: memoryOf(makeQuake(), [station('輪島', 50)]),
        liveKeys: new Set(['q1']),
        now: 1000,
      })
      const withLpgm = advanceQuakeMarks({
        prev: { memory: withQuake.memory, marks: withQuake.marks },
        key: lpgmMarkKey('20240101161000'),
        snapshot: { facts: new Map(), rows: lpgmRowSnapshot([{ name: '能登', maxLgInt: 4 }], [], []) },
        liveKeys: new Set(['q1', lpgmMarkKey('20240101161000')]),
        now: 2000,
      })
      expect(withLpgm.memory.has('q1')).toBe(true)
      expect(withLpgm.memory.has(lpgmMarkKey('20240101161000'))).toBe(true)
    })

    // 安全弁: 寿命を過ぎた印は落ちる。落とすものが無ければ同じ参照を返す。
    it('寿命を過ぎた印を落とす', () => {
      const marks = new Map([['q1', { facts: new Map(), rows: new Map(), markedAt: 1000 }]])
      expect(pruneQuakeMarks(marks, 1000 + UPDATE_MARK_TTL_MS).size).toBe(0)
      expect(pruneQuakeMarks(marks, 1000 + UPDATE_MARK_TTL_MS - 1)).toBe(marks)
    })
  })

  describe('長周期地震動の行', () => {
    // 正: 階級が動いたら印が出る。
    it('階級が上がったら上がったの印が出る', () => {
      const before = lpgmRowSnapshot([{ name: '能登', maxLgInt: 3 }], [], [])
      const after = lpgmRowSnapshot([{ name: '能登', maxLgInt: 4 }], [], [])
      expect(diffQuakeRows(after, before).get(rowMarkKey.area('能登'))).toBe('raised')
    })

    // 安全弁: 階級が据え置きでも震度だけが動いたら印が出る（カードは 2 つを並べて出す）。
    it('階級が同じでも震度が動いたら印が出る', () => {
      const before = lpgmRowSnapshot([{ name: '能登', maxLgInt: 4, maxInt: 50 }], [], [])
      const after = lpgmRowSnapshot([{ name: '能登', maxLgInt: 4, maxInt: 60 }], [], [])
      expect(diffQuakeRows(after, before).get(rowMarkKey.area('能登'))).toBe('raised')
    })

    // 安全弁: 順序は**階級を主、震度を従**にする。階級が下がったなら、震度が上がっていても
    // 「下がった」と言う（カードが階級を先に出しているのと揃える）。
    it('階級が下がれば、震度が上がっていても下がったの印が出る', () => {
      const before = lpgmRowSnapshot([{ name: '能登', maxLgInt: 4, maxInt: 10 }], [], [])
      const after = lpgmRowSnapshot([{ name: '能登', maxLgInt: 3, maxInt: 70 }], [], [])
      expect(diffQuakeRows(after, before).get(rowMarkKey.area('能登'))).toBe('lowered')
    })
  })
})
