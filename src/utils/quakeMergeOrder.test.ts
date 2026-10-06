import { describe, it, expect } from 'vitest'
import { mergeQuakeHistory, mergeQuakeInto } from './quakeMerge'
import type { JMAQuake, IssueType, IntensityScale, EarthquakePoint, DomesticTsunami } from '../types/earthquake'

// 履歴の取り込みは新しい日から 1 日ずつ反映し、「もっと見る」は窓ごとに回を分ける。
// 統合の規則（`mergeQuakeInto`）は発表時刻の順に 1 通ずつ当てることを前提にしているので、
// **回をまたいで古い報が後から当たっても、ライブで到着順に受けたときと同じカードにならなければならない。**
//
// 電文の並びは実電文から写した（種別・発表時刻・震度の有無・津波区分）。点の数は減らしてある。
//   - 山梨県東部・富士五湖 2026-06-26 22:29（EventID 20260626222902）。震源要素更新（VXSE61）だけが
//     翌日 00:40 の発表で、ほかの 5 通と別の日のアーカイブに入る
//   - 大阪府北部 2024-11-26 22:45（EventID 20241126224512）。完全版の 1 分後に、近接した別の地震の
//     揺れを含む震度速報が届いた（→ quakeMerge.ts の `mergeQuakeInto` の据え置き判定の注記）

interface TelegramOpts {
  eventId: string
  key: string
  type: IssueType
  time: string
  quakeTime: string
  tsunami: DomesticTsunami
  hypocenter?: { name: string; depth: number; magnitude: number }
  maxScale?: IntensityScale
  points?: EarthquakePoint[]
  serial?: number
}

function telegram(o: TelegramOpts): JMAQuake {
  const hypo = o.hypocenter
  return {
    kind: 'quake',
    id: `dmdata-quake-${o.eventId}-${o.serial ?? 1}`,
    telegramKey: o.key,
    ...(o.serial !== undefined && { reportSerial: o.serial }),
    time: o.time,
    issue: { source: 'dmdata', time: o.time, type: o.type, correct: 'なし' },
    earthquake: {
      time: o.quakeTime,
      hypocenter: hypo
        ? { name: hypo.name, latitude: 35.5, longitude: 138.9, depth: hypo.depth, magnitude: hypo.magnitude }
        : { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: NaN },
      maxScale: o.maxScale ?? -1,
      domesticTsunami: o.tsunami,
    },
    points: o.points ?? [],
  }
}

const area = (pref: string, addr: string, scale: IntensityScale): EarthquakePoint => ({ pref, addr, isArea: true, scale })
const station = (pref: string, addr: string, scale: IntensityScale): EarthquakePoint => ({ pref, addr, isArea: false, scale })

// --- 山梨県東部・富士五湖 2026-06-26 22:29 ---
const Y_EVENT = '20260626222902'
const Y_QUAKE_TIME = '2026-06-26T22:29:00+09:00'
const Y_HYPO = { name: '山梨県東部・富士五湖', depth: 20, magnitude: 5.5 }
const yamanashi: JMAQuake[] = [
  telegram({
    eventId: Y_EVENT, key: 'y51a', type: '震度速報', time: '2026-06-26T22:30:00+09:00', quakeTime: Y_QUAKE_TIME,
    tsunami: '調査中', maxScale: 55, points: [area('', '山梨県東部・富士五湖', 55)],
  }),
  telegram({
    eventId: Y_EVENT, key: 'y51b', type: '震度速報', time: '2026-06-26T22:30:00+09:00', quakeTime: Y_QUAKE_TIME,
    tsunami: '調査中', maxScale: 55,
    points: [area('', '山梨県東部・富士五湖', 55), area('', '山梨県中・西部', 50), area('', '神奈川県西部', 50)],
  }),
  telegram({
    eventId: Y_EVENT, key: 'y52', type: '震源情報', time: '2026-06-26T22:31:00+09:00', quakeTime: Y_QUAKE_TIME,
    tsunami: 'なし', hypocenter: Y_HYPO,
  }),
  telegram({
    eventId: Y_EVENT, key: 'y53a', type: '震源・震度情報', time: '2026-06-26T22:34:00+09:00', quakeTime: Y_QUAKE_TIME,
    tsunami: 'なし', hypocenter: Y_HYPO, maxScale: 55, serial: 1,
    points: [
      area('', '山梨県東部・富士五湖', 55), station('', '富士河口湖町船津', 55), station('', '山中湖村山中', 50),
      area('', '神奈川県西部', 50), station('', '山北町山北', 50),
    ],
  }),
  telegram({
    eventId: Y_EVENT, key: 'y53b', type: '震源・震度情報', time: '2026-06-26T22:41:00+09:00', quakeTime: Y_QUAKE_TIME,
    tsunami: 'なし', hypocenter: Y_HYPO, maxScale: 55, serial: 2,
    points: [
      area('', '山梨県東部・富士五湖', 55), station('', '富士河口湖町船津', 55), station('', '山中湖村山中', 50),
      station('', '忍野村忍草', 50), area('', '神奈川県西部', 50), station('', '山北町山北', 50),
    ],
  }),
  // 翌日 00:40。震度も津波の固定付加文も持たない（実電文の付加文は自由付加文だけ）
  telegram({
    eventId: Y_EVENT, key: 'y61', type: '顕著な地震の震源要素更新のお知らせ', time: '2026-06-27T00:40:00+09:00',
    quakeTime: Y_QUAKE_TIME, tsunami: '不明', hypocenter: { name: '山梨県東部・富士五湖', depth: 19, magnitude: 5.6 },
  }),
]

// --- 大阪府北部 2024-11-26 22:45 ---
const O_EVENT = '20241126224512'
const O_QUAKE_TIME = '2024-11-26T22:45:00+09:00'
const osaka: JMAQuake[] = [
  telegram({
    eventId: O_EVENT, key: 'o53', type: '震源・震度情報', time: '2024-11-26T22:47:00+09:00', quakeTime: O_QUAKE_TIME,
    tsunami: 'なし', hypocenter: { name: '大阪府北部', depth: 10, magnitude: 2.5 }, maxScale: 10, serial: 1,
    points: [area('', '大阪府北部', 10), station('', '高槻市桃園町', 10)],
  }),
  // 1 分後の石川県西方沖の揺れが紛れ込んだ震度速報（震源から 80〜95km の区域に震度3）
  telegram({
    eventId: O_EVENT, key: 'o51', type: '震度速報', time: '2024-11-26T22:48:00+09:00', quakeTime: O_QUAKE_TIME,
    tsunami: '調査中', maxScale: 30, points: [area('', '福井県嶺南', 30), area('', '滋賀県北部', 30)],
  }),
]

const byTime = (list: readonly JMAQuake[]) =>
  [...list].sort((a, b) => Date.parse(a.issue.time) - Date.parse(b.issue.time))

const fold = (batches: readonly JMAQuake[][]): JMAQuake[] => {
  let cards: JMAQuake[] = []
  for (const batch of batches) cards = mergeQuakeHistory(batch, cards, [], null).cards
  return cards
}

/** 画面に出る事実だけを比べる（記録・控えはカードの出し方に効かないので外す）。 */
const shape = (cards: JMAQuake[]) => cards.map(c => ({
  type: c.issue.type,
  time: c.time,
  tsunami: c.earthquake.domesticTsunami,
  maxScale: c.earthquake.maxScale,
  hypocenter: c.earthquake.hypocenter.name,
  magnitude: c.earthquake.hypocenter.magnitude,
  depth: c.earthquake.hypocenter.depth,
  points: c.points.map(p => `${p.addr}:${p.scale}`),
}))

/** ライブ: 発表時刻の順に 1 通ずつ届く。 */
const live = (list: readonly JMAQuake[]) => shape(fold(byTime(list).map(q => [q])))

/**
 * 履歴: 報の列の k 通目の手前で JST の日付が変わったとする。新しい日から読むので、後ろ半分が先に当たる。
 * - 同じ窓: 日ごとの途中反映は「ここまで読んだ全件」を渡し直し、最後に全件をもう一度当てる
 * - 窓をまたぐ: 後ろ半分が前の窓、前半分が次の窓（どちらも途中反映 → 全件の 2 回）
 */
function historyScenarios(list: readonly JMAQuake[]): { label: string; batches: JMAQuake[][] }[] {
  const sorted = byTime(list)
  const out: { label: string; batches: JMAQuake[][] }[] = []
  for (let k = 1; k < sorted.length; k++) {
    const earlier = sorted.slice(0, k)
    const later = sorted.slice(k)
    const at = `${later[0].issue.type}@${later[0].issue.time.slice(5, 16)} の手前で日付が変わる`
    out.push({ label: `同じ窓・${at}`, batches: [byTime(later), sorted, sorted] })
    out.push({ label: `窓をまたぐ・${at}`, batches: [byTime(later), byTime(later), byTime(earlier), byTime(earlier)] })
  }
  return out
}

describe('履歴の取り込みは届く順番によらず、ライブと同じカードになる', () => {
  for (const [name, list] of [['山梨県東部・富士五湖（VXSE61 が翌日）', yamanashi], ['大阪府北部（完全版の後の震度速報）', osaka]] as const) {
    describe(name, () => {
      const expected = live(list)
      for (const { label, batches } of historyScenarios(list)) {
        it(label, () => {
          expect(shape(fold(batches))).toEqual(expected)
        })
      }
    })
  }

  // **正**: 発端の症状が出ないこと（上の一致だけだと、ライブ側が壊れても一緒に通る）
  it('VXSE61 が先に当たっても、津波は「なし」・震度は震源・震度情報の観測点まで残る', () => {
    const sorted = byTime(yamanashi)
    const cards = fold([[sorted[sorted.length - 1]], sorted.slice(0, -1)])
    expect(cards).toHaveLength(1)
    expect(cards[0].earthquake.domesticTsunami).toBe('なし')
    expect(cards[0].points.filter(p => !p.isArea)).toHaveLength(4)
    expect(cards[0].earthquake.hypocenter.magnitude).toBe(5.6)
    expect(cards[0].issue.type).toBe('顕著な地震の震源要素更新のお知らせ')
  })

  // **安全弁**: ライブで完全版の後に届いた震度速報は、これまでどおり据え置く
  it('ライブで完全版の後に届いた震度速報は据え置く（紛れ込んだ区域を採らない）', () => {
    const card = mergeQuakeInto(mergeQuakeInto(undefined, osaka[0]), osaka[1])
    expect(card.issue.type).toBe('震源・震度情報')
    expect(card.points.map(p => p.addr)).toEqual(['大阪府北部', '高槻市桃園町'])
  })

  // **対照**: 同じ回に全部そろっていれば、当て直しは要らない（今と同じ結果）
  it('同じ回にそろって届いた報は、並びを問わず時刻順に当てた結果になる', () => {
    const reversed = [...yamanashi].reverse()
    expect(shape(fold([reversed]))).toEqual(live(yamanashi))
  })
})

// **標準版（P2PQuake）の形でも同じ答えになる。** あちらは EventID を持たず（`sameQuakeEntry` が
// 地震の時刻と区域で同じ地震を見分ける）、「もっと見る」は件数でページを切るので、ページの境目を
// またいで古い報が後から当たる。鍵（`telegramKey`）を持たない電文の同一判定も通る。
describe('標準版（P2PQuake）の形', () => {
  const p2p = (o: { id: string; type: IssueType; time: string; tsunami: DomesticTsunami; withHypo: boolean; points: EarthquakePoint[] }): JMAQuake => ({
    kind: 'quake',
    id: o.id,
    time: o.time,
    issue: { source: 'p2pquake', time: o.time, type: o.type, correct: 'なし' },
    earthquake: {
      time: '2026/06/26 22:29:00',
      hypocenter: o.withHypo
        ? { name: '山梨県東部・富士五湖', latitude: 35.5, longitude: 138.9, depth: 20, magnitude: 5.5 }
        : { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: -1 },
      maxScale: 55,
      domesticTsunami: o.tsunami,
    },
    points: o.points,
  })
  // P2PQuake の発表時刻はスラッシュ区切り・オフセット無し（→ `mergeQuakeInto` の注記）
  const list = [
    p2p({ id: 'p1', type: '震度速報', time: '2026/06/26 22:30:32', tsunami: '調査中', withHypo: false, points: [area('山梨県', '山梨県東部・富士五湖', 55)] }),
    p2p({ id: 'p2', type: '震源情報', time: '2026/06/26 22:31:51', tsunami: 'なし', withHypo: true, points: [] }),
    p2p({
      id: 'p3', type: '各地の震度情報', time: '2026/06/26 22:34:12', tsunami: 'なし', withHypo: true,
      points: [area('山梨県', '山梨県東部・富士五湖', 55), station('山梨県', '富士河口湖町船津', 55)],
    }),
  ]

  for (const { label, batches } of historyScenarios(list)) {
    it(label, () => {
      expect(shape(fold(batches))).toEqual(live(list))
    })
  }
})

describe('控え（sourceTelegrams）の持ち方', () => {
  it('当てた電文を受け取った順に、同じ電文は 1 回だけ持つ', () => {
    let card = mergeQuakeInto(undefined, yamanashi[0])
    card = mergeQuakeInto(card, yamanashi[2])
    card = mergeQuakeInto(card, yamanashi[2])
    expect(card.sourceTelegrams?.map(t => t.telegramKey)).toEqual(['y51a', 'y52'])
  })

  it('据え置いた電文も持つ（届く順番が違えば採られるため）', () => {
    const card = mergeQuakeInto(mergeQuakeInto(undefined, osaka[0]), osaka[1])
    expect(card.sourceTelegrams?.map(t => t.telegramKey)).toEqual(['o53', 'o51'])
  })

  it('電文を複製せず、受け取ったオブジェクトをそのまま指す', () => {
    const card = mergeQuakeInto(undefined, yamanashi[0])
    expect(card.sourceTelegrams?.[0]).toBe(yamanashi[0])
  })

  it('同じ電文が二度流れても、カードは同じ参照のまま（変化なし＝同一参照）', () => {
    const once = mergeQuakeInto(mergeQuakeInto(undefined, osaka[0]), osaka[1])
    expect(mergeQuakeInto(once, osaka[1])).toBe(once)
  })
})
