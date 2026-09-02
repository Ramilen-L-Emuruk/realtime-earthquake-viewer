import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { convertEvent } from './p2pquake'
import type { EEWAlert, JMAQuake, JMATsunami } from '../types/earthquake'
import { log } from '../utils/logger'

// 正常系のフィクスチャは 2026-08-16 に api.p2pquake.net/v2/history から取得した実レスポンス
// （points は 1 件に間引き）。値域の根拠は公式 OpenAPI 仕様:
// https://github.com/p2pquake/epsp-specifications/blob/master/json-api-v2.yaml
const REAL_QUAKE = {
  code: 551,
  comments: { freeFormComment: '' },
  earthquake: {
    domesticTsunami: 'None',
    foreignTsunami: 'Unknown',
    hypocenter: { depth: 10, latitude: 32.5, longitude: 130.6, magnitude: 2.9, name: '熊本県熊本地方' },
    maxScale: 10,
    time: '2026/08/16 01:12:00',
  },
  id: '6a809077e88ee598246bf1f0',
  issue: { correct: 'None', source: '気象庁', time: '2026/08/16 01:14:46', type: 'DetailScale' },
  points: [{ addr: '八代市平山新町', isArea: false, pref: '熊本県', scale: 10 }],
  time: '2026/08/16 01:14:47.041',
  timestamp: { convert: '2026/08/16 01:14:47.026', register: '2026/08/16 01:14:47.041' },
  user_agent: 'jmaxml-seis-parser-go, relay, register-api',
  ver: '20231023',
}

const REAL_EEW = {
  areas: [
    { arrivalTime: '2026/07/29 22:19:44', kindCode: '19', name: '熊本県熊本', pref: '熊本', scaleFrom: 45, scaleTo: 45 },
    { arrivalTime: '2026/07/29 22:19:43', kindCode: '19', name: '熊本県球磨', pref: '熊本', scaleFrom: 40, scaleTo: 40 },
  ],
  cancelled: false,
  code: 556,
  earthquake: {
    arrivalTime: '2026/07/29 22:19:39',
    condition: '',
    hypocenter: {
      depth: 10, latitude: 32.4, longitude: 130.5, magnitude: 4.5,
      name: '熊本県天草・芦北地方', reduceName: '熊本県',
    },
    originTime: '2026/07/29 22:19:36',
  },
  id: '6a69fdf1e88ee598246bf002',
  issue: { eventId: '20260729221939', serial: '1', time: '2026/07/29 22:19:44' },
  time: '2026/07/29 22:19:45.168',
}

// 552 は取得時点で直近の発表が無く実レスポンスを採取できなかったため、公式仕様の
// フィールド定義（areas[] = grade/immediate/name/firstHeight/maxHeight）から組み立てている。
const SPEC_TSUNAMI = {
  code: 552,
  cancelled: false,
  id: '65921e3fe88ee598246ba001',
  issue: { source: '気象庁', time: '2026/01/01 16:22:00', type: 'Focus' },
  areas: [
    {
      grade: 'MajorWarning',
      immediate: true,
      name: '能登',
      firstHeight: { arrivalTime: '2026/01/01 16:22:00', condition: 'ただちに津波来襲と予測' },
      maxHeight: { description: '巨大' },
    },
    {
      grade: 'Watch',
      immediate: false,
      name: '佐渡',
      maxHeight: { description: '１ｍ', value: 1 },
    },
  ],
  time: '2026/01/01 16:22:30.000',
}

/** convertEvent の引数型は `as RawP2PEvent` で通ってくる想定なので、テストでも同様に緩めて渡す。 */
function convert(raw: unknown) {
  return convertEvent(raw as Parameters<typeof convertEvent>[0])
}

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
})

describe('convertEvent', () => {
  describe('code=551（地震情報）: 実レスポンス', () => {
    it('実レスポンスを内部型へ過不足なく変換する', () => {
      const q = convert(REAL_QUAKE) as JMAQuake
      expect(q.kind).toBe('quake')
      expect(q.id).toBe('6a809077e88ee598246bf1f0')
      expect(q.time).toBe('2026/08/16 01:14:47.041')
      expect(q.issue).toEqual({
        source: '気象庁', time: '2026/08/16 01:14:46', type: '各地の震度情報', correct: 'なし',
      })
      expect(q.earthquake).toEqual({
        time: '2026/08/16 01:12:00',
        hypocenter: { name: '熊本県熊本地方', latitude: 32.5, longitude: 130.6, depth: 10, magnitude: 2.9 },
        maxScale: 10,
        domesticTsunami: 'なし',
      })
      expect(q.points).toEqual([{ pref: '熊本県', addr: '八代市平山新町', isArea: false, scale: 10 }])
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('内部型に無い P2PQuake 固有フィールドは落とす', () => {
      const q = convert(REAL_QUAKE) as unknown as Record<string, unknown>
      expect(q.comments).toBeUndefined()
      expect(q.timestamp).toBeUndefined()
      expect(q.user_agent).toBeUndefined()
      expect(q.ver).toBeUndefined()
      expect(q.code).toBeUndefined()
      expect((q.earthquake as Record<string, unknown>).foreignTsunami).toBeUndefined()
    })

    it('severity は付与しない（EEW 専用フィールド）', () => {
      expect((convert(REAL_QUAKE) as unknown as { severity?: unknown }).severity).toBeUndefined()
    })
  })

  describe('code=556（EEW）: 実レスポンス', () => {
    it('実レスポンスを内部型へ過不足なく変換する', () => {
      const e = convert(REAL_EEW) as EEWAlert
      expect(e.kind).toBe('eew')
      expect(e.id).toBe('6a69fdf1e88ee598246bf002')
      expect(e.test).toBe(false)
      expect(e.cancelled).toBe(false)
      expect(e.earthquake.originTime).toBe('2026/07/29 22:19:36')
      expect(e.earthquake.hypocenter).toEqual({
        name: '熊本県天草・芦北地方', latitude: 32.4, longitude: 130.5, depth: 10, magnitude: 4.5,
      })
      expect(e.issue).toEqual({ eventId: '20260729221939', serial: '1', time: '2026/07/29 22:19:44' })
      expect(e.areas).toEqual([
        { pref: '熊本', name: '熊本県熊本', scaleFrom: 45, scaleTo: 45, kindCode: '19', arrivalTime: '2026/07/29 22:19:44' },
        { pref: '熊本', name: '熊本県球磨', scaleFrom: 40, scaleTo: 40, kindCode: '19', arrivalTime: '2026/07/29 22:19:43' },
      ])
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('severity=Warning を必ず付与する（P2PQuake ペイロードに severity フィールドは無いため）', () => {
      expect((convert(REAL_EEW) as EEWAlert).severity).toBe('Warning')
    })

    it('生ペイロードに severity フィールドがあっても Warning で確定させる（将来の API 変更に対する保険）', () => {
      const e = convert({ ...REAL_EEW, severity: 'Forecast' }) as EEWAlert
      expect(e.severity).toBe('Warning')
    })

    it('hypocenter.reduceName は内部型に無いので落とす', () => {
      const e = convert(REAL_EEW) as EEWAlert
      expect((e.earthquake.hypocenter as unknown as Record<string, unknown>).reduceName).toBeUndefined()
    })
  })

  describe('code=552（津波）', () => {
    it('仕様どおりのペイロードを内部型へ変換する', () => {
      const t = convert(SPEC_TSUNAMI) as JMATsunami
      expect(t.kind).toBe('tsunami')
      expect(t.cancelled).toBe(false)
      expect(t.issue).toEqual({ source: '気象庁', time: '2026/01/01 16:22:00', type: 'Focus' })
      expect(t.areas).toHaveLength(2)
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('「巨大」など数値表現を持たない予想波高でも maxHeight を落とさない', () => {
      const t = convert(SPEC_TSUNAMI) as JMATsunami
      expect(t.areas[0].maxHeight).toEqual({ description: '巨大', value: undefined })
      expect(t.areas[1].maxHeight).toEqual({ description: '１ｍ', value: 1 })
    })

    it('maxHeight.value が空文字なら「0m」として採用しない', () => {
      const t = convert({
        ...SPEC_TSUNAMI,
        areas: [{ grade: 'Warning', immediate: true, name: '能登', maxHeight: { description: '高い', value: '' } }],
      }) as JMATsunami
      expect(t.areas[0].maxHeight).toEqual({ description: '高い', value: undefined })
    })

    it('firstHeight が無い区域は undefined にする（2023年11月より前のデータ）', () => {
      const t = convert(SPEC_TSUNAMI) as JMATsunami
      expect(t.areas[0].firstHeight).toEqual({ arrivalTime: '2026/01/01 16:22:00', condition: 'ただちに津波来襲と予測' })
      expect(t.areas[1].firstHeight).toBeUndefined()
    })

    it('解除電文（cancelled=true・areas 空）を通す', () => {
      const t = convert({ ...SPEC_TSUNAMI, cancelled: true, areas: [] }) as JMATsunami
      expect(t.cancelled).toBe(true)
      expect(t.areas).toEqual([])
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('未知の grade は Unknown に落として警告する', () => {
      const t = convert({
        ...SPEC_TSUNAMI,
        areas: [{ grade: 'FutureGrade', immediate: false, name: '能登' }],
      }) as JMATsunami
      expect(t.areas[0].grade).toBe('Unknown')
      expect(warnSpy).toHaveBeenCalled()
    })

    it('name が無い区域はその要素だけ落とす（他の区域は残す）', () => {
      const t = convert({
        ...SPEC_TSUNAMI,
        areas: [{ grade: 'Warning', immediate: true }, { grade: 'Watch', immediate: false, name: '佐渡' }],
      }) as JMATsunami
      expect(t.areas.map(a => a.name)).toEqual(['佐渡'])
      expect(warnSpy).toHaveBeenCalled()
    })
  })

  describe('イベントごと破棄する条件', () => {
    it('未対応 code は null', () => {
      expect(convert({ code: 9999 })).toBeNull()
    })

    it('ペイロードが非オブジェクト（null・配列・文字列）でも落ちずに null を返す', () => {
      expect(convert(null)).toBeNull()
      expect(convert([])).toBeNull()
      expect(convert('boom')).toBeNull()
      expect(convert(undefined)).toBeNull()
    })

    it('551: id が無ければ破棄する（同一性キーが作れず別の地震と潰れるため）', () => {
      expect(convert({ ...REAL_QUAKE, id: '' })).toBeNull()
      expect(warnSpy).toHaveBeenCalled()
    })

    it('551: earthquake.time が無ければ破棄する', () => {
      expect(convert({ ...REAL_QUAKE, earthquake: { ...REAL_QUAKE.earthquake, time: '' } })).toBeNull()
    })

    it('551: earthquake ごと欠落していても落ちずに破棄する（従来は例外で履歴取得全体が失敗した）', () => {
      const raw = { ...REAL_QUAKE } as Record<string, unknown>
      delete raw.earthquake
      expect(convert(raw)).toBeNull()
    })

    it('552 / 556: id が無ければ破棄する', () => {
      expect(convert({ ...SPEC_TSUNAMI, id: '' })).toBeNull()
      expect(convert({ ...REAL_EEW, id: '' })).toBeNull()
    })
  })

  describe('震度値の正規化', () => {
    function pointScale(scale: unknown) {
      const q = convert({
        ...REAL_QUAKE,
        points: [{ addr: 'テスト観測点', isArea: false, pref: 'テスト県', scale }],
      }) as JMAQuake
      return q.points[0].scale
    }

    it('正規の階級はそのまま通す', () => {
      for (const s of [10, 20, 30, 40, 45, 50, 55, 60, 70]) expect(pointScale(s)).toBe(s)
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('46（震度5弱以上と推定・震度情報未入手）は 45 として扱い、警告は出さない', () => {
      expect(pointScale(46)).toBe(45)
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('小数が付いた値は整数部で判定する（仕様の「整数部のみ有効」）', () => {
      expect(pointScale(45.0)).toBe(45)
      expect(pointScale(55.4)).toBe(55)
    })

    it('中間値・範囲外は -1 に落として警告する', () => {
      expect(pointScale(25)).toBe(-1)
      expect(pointScale(99)).toBe(-1)
      expect(pointScale(-5)).toBe(-1)
      expect(warnSpy).toHaveBeenCalledTimes(3)
    })

    it('型違い（文字列・オブジェクト・NaN）は -1 に落として警告する', () => {
      expect(pointScale('5弱')).toBe(-1)
      expect(pointScale({})).toBe(-1)
      expect(pointScale(NaN)).toBe(-1)
      expect(warnSpy).toHaveBeenCalledTimes(3)
    })

    it('数値文字列は許容する（JSON の型ゆれに耐える）', () => {
      expect(pointScale('45')).toBe(45)
    })

    it('maxScale の欠落は警告せず -1（震源情報には最大震度が無いのが正常）', () => {
      const raw = { ...REAL_QUAKE, earthquake: { ...REAL_QUAKE.earthquake } } as Record<string, unknown>
      delete (raw.earthquake as Record<string, unknown>).maxScale
      expect((convert(raw) as JMAQuake).earthquake.maxScale).toBe(-1)
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('maxScale=-1（震度情報なし）は警告せずそのまま通す', () => {
      const q = convert({ ...REAL_QUAKE, earthquake: { ...REAL_QUAKE.earthquake, maxScale: -1 } }) as JMAQuake
      expect(q.earthquake.maxScale).toBe(-1)
      expect(warnSpy).not.toHaveBeenCalled()
    })
  })

  describe('EEW 地域別予想震度', () => {
    function areas(raw: unknown[]) {
      return (convert({ ...REAL_EEW, areas: raw }) as EEWAlert).areas
    }

    it('scaleTo=99（〜程度以上）は scaleFrom を上限として採用し、「以上」をフラグで残す', () => {
      // scaleFrom=70/scaleTo=99 は「震度7程度以上」。99 をそのまま通すと eewMaxScale() の
      // 実行時ガードがこの地域を無視し、最強クラスの EEW が特別警報に上がらなくなる。
      // 上限に寄せたことで失われる「以上」は scaleToOrAbove で持ち越す（DMDATA の "over" と同じ）。
      expect(areas([{ pref: '宮城', name: '宮城県北部', scaleFrom: 70, scaleTo: 99, kindCode: '10', arrivalTime: null }]))
        .toEqual([{ pref: '宮城', name: '宮城県北部', scaleFrom: 70, scaleTo: 70, scaleToOrAbove: true, kindCode: '10', arrivalTime: null }])
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('scaleTo=99 でも scaleFrom が不明なら「以上」を立てない（「不明以上」は意味を成さない）', () => {
      const [a] = areas([{ pref: '宮城', name: '宮城県北部', scaleFrom: 0, scaleTo: 99, kindCode: '10', arrivalTime: null }])!
      // scaleFrom=0（震度0）は内部では -1（不明）へ寄せる既存規則。
      expect(a.scaleFrom).toBe(-1)
      expect(a.scaleTo).toBe(-1)
      expect(a.scaleToOrAbove).toBeUndefined()
    })

    it('通常の scaleTo には「以上」を立てない', () => {
      const [a] = areas([{ pref: '宮城', name: '宮城県北部', scaleFrom: 45, scaleTo: 50, kindCode: '10', arrivalTime: null }])!
      expect(a.scaleTo).toBe(50)
      expect(a.scaleToOrAbove).toBeUndefined()
    })

    it('scaleTo が配列など非数値なら「〜程度以上」と誤認せず -1 に落として警告する', () => {
      // Number([99]) は 99 に評価されるため、素の Number() だと無警告で 99 扱いになってしまう
      const [a] = areas([{ pref: '宮城', name: '宮城県北部', scaleFrom: 70, scaleTo: [99], kindCode: '11' }])!
      expect(a.scaleTo).toBe(-1)
      expect(warnSpy).toHaveBeenCalled()
    })

    it('scaleFrom/scaleTo=0（震度0）は -1 として扱い、警告は出さない', () => {
      const [a] = areas([{ pref: '東京', name: '東京都23区', scaleFrom: 0, scaleTo: 0, kindCode: '10' }])!
      expect(a.scaleFrom).toBe(-1)
      expect(a.scaleTo).toBe(-1)
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('scaleTo が中間値なら -1 に落として警告する', () => {
      const [a] = areas([{ pref: '東京', name: '東京都23区', scaleFrom: 20, scaleTo: 25, kindCode: '10' }])!
      expect(a.scaleTo).toBe(-1)
      expect(warnSpy).toHaveBeenCalled()
    })

    it('arrivalTime が無ければ null にする（内部型は undefined ではなく null で表す）', () => {
      const [a] = areas([{ pref: '東京', name: '東京都23区', scaleFrom: 20, scaleTo: 20, kindCode: '10' }])!
      expect(a.arrivalTime).toBeNull()
    })

    it('name が無い地域はその要素だけ落とす', () => {
      const result = areas([
        { pref: '東京', scaleFrom: 20, scaleTo: 20 },
        { pref: '千葉', name: '千葉県北西部', scaleFrom: 30, scaleTo: 30, kindCode: '10' },
      ])
      expect(result?.map(a => a.name)).toEqual(['千葉県北西部'])
    })

    it('地域が 1 件も無い場合は areas を undefined にする（enrichEEW が既存の区域塗りを空で上書きしないため）', () => {
      expect(areas([])).toBeUndefined()
      const cancelled = { ...REAL_EEW, cancelled: true } as Record<string, unknown>
      delete cancelled.areas
      expect((convert(cancelled) as EEWAlert).areas).toBeUndefined()
    })
  })

  describe('震源要素のセンチネル化', () => {
    it('hypocenter ごと欠落していても位置不明センチネルで通す（震度速報の正常形）', () => {
      const raw = { ...REAL_QUAKE, earthquake: { ...REAL_QUAKE.earthquake } } as Record<string, unknown>
      delete (raw.earthquake as Record<string, unknown>).hypocenter
      const q = convert(raw) as JMAQuake
      expect(q.earthquake.hypocenter).toEqual({ name: '', latitude: -200, longitude: -200, depth: -1, magnitude: -1 })
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('座標・深さ・規模が数値でなければセンチネルに落として警告する', () => {
      const q = convert({
        ...REAL_QUAKE,
        earthquake: {
          ...REAL_QUAKE.earthquake,
          hypocenter: { name: '沖合', latitude: 'x', longitude: {}, depth: [], magnitude: 'M4' },
        },
      }) as JMAQuake
      expect(q.earthquake.hypocenter.latitude).toBe(-200)
      expect(q.earthquake.hypocenter.longitude).toBe(-200)
      expect(q.earthquake.hypocenter.magnitude).toBe(-1)
      expect(warnSpy).toHaveBeenCalled()
    })

    it('API が返す不明センチネル（-200 / -1）はそのまま通す', () => {
      const q = convert({
        ...REAL_QUAKE,
        earthquake: {
          ...REAL_QUAKE.earthquake,
          hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: -1 },
        },
      }) as JMAQuake
      expect(q.earthquake.hypocenter).toEqual({ name: '', latitude: -200, longitude: -200, depth: -1, magnitude: -1 })
      expect(warnSpy).not.toHaveBeenCalled()
    })

    it('depth=0（ごく浅い）は有効値として通す', () => {
      const q = convert({
        ...REAL_QUAKE,
        earthquake: { ...REAL_QUAKE.earthquake, hypocenter: { ...REAL_QUAKE.earthquake.hypocenter, depth: 0 } },
      }) as JMAQuake
      expect(q.earthquake.hypocenter.depth).toBe(0)
    })
  })

  describe('points の部分的な破損', () => {
    it('壊れた観測点だけ落として地震そのものは残す', () => {
      const q = convert({
        ...REAL_QUAKE,
        points: [
          { addr: '八代市平山新町', isArea: false, pref: '熊本県', scale: 10 },
          { pref: '熊本県', isArea: false, scale: 20 },   // addr 欠落
          'not-an-object',
          null,
          { addr: '上天草市大矢野町', isArea: false, pref: '熊本県', scale: 20 },
        ],
      }) as JMAQuake
      expect(q.points.map(p => p.addr)).toEqual(['八代市平山新町', '上天草市大矢野町'])
    })

    it('points が配列でなければ空配列にする', () => {
      expect((convert({ ...REAL_QUAKE, points: 'boom' }) as JMAQuake).points).toEqual([])
      const raw = { ...REAL_QUAKE } as Record<string, unknown>
      delete raw.points
      expect((convert(raw) as JMAQuake).points).toEqual([])
    })

    it('isArea は真偽値以外を false に倒す', () => {
      const q = convert({
        ...REAL_QUAKE,
        points: [{ addr: '熊本県熊本', isArea: 'true', pref: '熊本県', scale: 10 }],
      }) as JMAQuake
      expect(q.points[0].isArea).toBe(false)
    })
  })

  describe('issue.type / issue.correct / earthquake.domesticTsunami の変換', () => {
    function quakeWith(patch: Record<string, unknown>) {
      return convert({ ...REAL_QUAKE, ...patch }) as JMAQuake
    }

    it('issue.type の英語コードを日本語に変換する', () => {
      expect(quakeWith({ issue: { ...REAL_QUAKE.issue, type: 'ScalePrompt' } }).issue.type).toBe('震度速報')
    })

    it('未知の issue.type は「その他」にフォールバックして警告する', () => {
      expect(quakeWith({ issue: { ...REAL_QUAKE.issue, type: 'FutureType' } }).issue.type).toBe('その他')
      expect(warnSpy).toHaveBeenCalled()
    })

    it('issue.correct の英語コードを日本語に変換し、未知値は「なし」にフォールバック', () => {
      expect(quakeWith({ issue: { ...REAL_QUAKE.issue, correct: 'ScaleOnly' } }).issue.correct).toBe('震度のみ訂正')
      expect(quakeWith({ issue: { ...REAL_QUAKE.issue, correct: 'FooBar' } }).issue.correct).toBe('なし')
    })

    it('earthquake.domesticTsunami の英語コードを日本語に変換し、未知値は「不明」にフォールバック', () => {
      const known = quakeWith({ earthquake: { ...REAL_QUAKE.earthquake, domesticTsunami: 'Warning' } })
      expect(known.earthquake.domesticTsunami).toBe('警報等')
      const unknown = quakeWith({ earthquake: { ...REAL_QUAKE.earthquake, domesticTsunami: 'FooBar' } })
      expect(unknown.earthquake.domesticTsunami).toBe('不明')
    })

    it('issue ごと欠落していても既定値で通す（必須の issue.time は警告する）', () => {
      const raw = { ...REAL_QUAKE } as Record<string, unknown>
      delete raw.issue
      const q = convert(raw) as JMAQuake
      expect(q.issue).toEqual({ source: '', time: '', type: 'その他', correct: 'なし' })
      expect(warnSpy).toHaveBeenCalled()
    })
  })

  // 従来は `time` がそのまま透過し、欠落時は undefined → useEarthquakes の `?? serverNow()` に
  // 救われていた。バリデーションで '' に正規化すると `??` をすり抜けて Invalid Date になる（回帰）。
  // いまはイベントキューが積む時点で捨てて記録に残すが（`EventQueue.push`）、そこまで届けば
  // その電文は失われる。ここで破棄して電文ごと落とすほうが、何が起きたかが分かりやすい。
  describe('トップレベル time（キューの並び順キー）', () => {
    it('time が空・非文字列なら電文を破棄する', () => {
      for (const bad of ['', 42, null, {}]) {
        expect(convert({ ...REAL_QUAKE, time: bad })).toBeNull()
        expect(convert({ ...SPEC_TSUNAMI, time: bad })).toBeNull()
        expect(convert({ ...REAL_EEW, time: bad })).toBeNull()
      }
    })

    it('time フィールドごと欠落していても破棄する', () => {
      const raw = { ...REAL_QUAKE } as Record<string, unknown>
      delete raw.time
      expect(convert(raw)).toBeNull()
    })

    it('551: earthquake.time が空なら破棄する（カードの表示時刻・ソートキー・同一性キー）', () => {
      expect(convert({ ...REAL_QUAKE, earthquake: { ...REAL_QUAKE.earthquake, time: '' } })).toBeNull()
    })

    // Date のパース可否はブラウザ実装に依存する（P2PQuake の時刻はスラッシュ区切りの非 ISO 形式）。
    // 厳格な実装に当たったときに全電文を捨てないよう、値があるなら警告だけで通す。
    // キュー停止は useEarthquakes の enqueueEvent 側のガードで別途防いでいる。
    it('time に値はあるが Date として読めない場合は警告しつつ通す', () => {
      const q = convert({ ...REAL_QUAKE, time: 'not-a-date' }) as JMAQuake
      expect(q).not.toBeNull()
      expect(q.time).toBe('not-a-date')
      expect(warnSpy).toHaveBeenCalled()
    })

    it('実データの時刻形式は Date として解釈できる', () => {
      for (const fixture of [REAL_QUAKE, SPEC_TSUNAMI, REAL_EEW]) {
        const e = convert(fixture)!
        expect(Number.isFinite(new Date(e.time).getTime())).toBe(true)
      }
      expect(warnSpy).not.toHaveBeenCalled()
    })
  })

  describe('仕様上の必須フィールドの欠落は警告する', () => {
    it('556: issue.eventId が無ければ警告する（続報統合の同一性キー）', () => {
      const e = convert({ ...REAL_EEW, issue: { serial: '1', time: '2026/07/29 22:19:44' } }) as EEWAlert
      expect(e.issue?.eventId).toBeUndefined()
      expect(warnSpy).toHaveBeenCalled()
    })

    it('552/556: cancelled が真偽値でなければ false に倒して警告する（警報を勝手に消さない）', () => {
      const raw = { ...SPEC_TSUNAMI } as Record<string, unknown>
      delete raw.cancelled
      expect((convert(raw) as JMATsunami).cancelled).toBe(false)
      expect(warnSpy).toHaveBeenCalled()
    })

    it('556: earthquake があるのに originTime が無ければ警告する（予報円が半径0のまま描かれるため）', () => {
      convert({ ...REAL_EEW, earthquake: { ...REAL_EEW.earthquake, originTime: '' } })
      expect(warnSpy).toHaveBeenCalled()
    })

    it('556: 取消電文は earthquake ごと欠落していても通す（earthquake 自体は任意）', () => {
      const raw = { ...REAL_EEW, cancelled: true } as Record<string, unknown>
      delete raw.earthquake
      delete raw.areas
      const e = convert(raw) as EEWAlert
      expect(e.cancelled).toBe(true)
      expect(e.severity).toBe('Warning')
      expect(e.earthquake.hypocenter).toEqual({ name: '', latitude: -200, longitude: -200, depth: -1, magnitude: -1 })
      expect(e.areas).toBeUndefined()
    })

    it('551: points[].scale の欠落は警告する（maxScale と違い必須）', () => {
      const q = convert({
        ...REAL_QUAKE,
        points: [{ addr: '八代市平山新町', isArea: false, pref: '熊本県' }],
      }) as JMAQuake
      expect(q.points[0].scale).toBe(-1)
      expect(warnSpy).toHaveBeenCalled()
    })
  })

  describe('数値フィールドの型強制対策', () => {
    // Number('') === 0 / Number(true) === 1 / Number([]) === 0 のため、素の Number() では
    // 壊れた値が「有効な 0」として無警告で通る。緯度 0・経度 0 はギニア湾沖の実在座標。
    it('空文字・真偽値・空配列は 0 として採用せずセンチネルに落として警告する', () => {
      for (const bad of ['', '   ', true, false, []]) {
        warnSpy.mockClear()
        const q = convert({
          ...REAL_QUAKE,
          earthquake: {
            ...REAL_QUAKE.earthquake,
            hypocenter: { ...REAL_QUAKE.earthquake.hypocenter, latitude: bad },
          },
        }) as JMAQuake
        expect(q.earthquake.hypocenter.latitude).toBe(-200)
        expect(warnSpy).toHaveBeenCalled()
      }
    })

    it('震度も空文字を「震度0」として取り込まない', () => {
      const q = convert({
        ...REAL_QUAKE,
        points: [{ addr: 'テスト観測点', isArea: false, pref: 'テスト県', scale: '' }],
      }) as JMAQuake
      expect(q.points[0].scale).toBe(-1)
      expect(warnSpy).toHaveBeenCalled()
    })
  })

  describe('警告の集約', () => {
    it('同じ理由の警告が大量に出ても内容の出力は先頭数件に抑え、件数をまとめて出す', () => {
      const points = Array.from({ length: 50 }, (_, i) => ({
        addr: `観測点${i}`, isArea: false, pref: '熊本県', scale: 25,
      }))
      const q = convert({ ...REAL_QUAKE, points }) as JMAQuake
      expect(q.points).toHaveLength(50)
      // 内容つき 3 件 + 集約 1 行。50 行は出さない
      expect(warnSpy.mock.calls.length).toBeLessThan(10)
      expect(warnSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('計 50 件'))).toBe(true)
    })
  })
})
