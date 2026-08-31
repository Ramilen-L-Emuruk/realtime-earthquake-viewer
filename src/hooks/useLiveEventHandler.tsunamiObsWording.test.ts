// @vitest-environment jsdom
//
// 津波観測情報の読み上げの「言い回し」と「並び」をフックの結線ごと固定するテスト。
//
// 文の組み立て自体は `ttsText.test.ts` が見ている。ここで守るのは、フックが渡すものが
// 正しいかという 2 点。
//
// 1. **新旧の言い分けに渡すのは読み上げ用の記憶**（`spokenObsHeightRef`）。受信時に進む画面用の
//    記憶を渡すと、一度も声にしていない観測点を「更新されました」と言う
// 2. **観測点はカードの並びに揃えて渡す**（`sortObservationsForCardDisplay`）。電文順のままだと
//    カード上を飛び回り、追従スクロールが上下に往復する（→ docs/spec/tsunami-spec.md §9）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLiveEventHandler } from './useLiveEventHandler'
import type { AppSettings } from './useSettings'
import type { JMAQuake, JMATsunami } from '../types/earthquake'

const speeches: { text: string; finish: () => void; done: boolean }[] = []
const speakMock = vi.fn((_url: string, text: string) => {
  for (const s of speeches) {
    if (!s.done) { s.done = true; s.finish() }
  }
  let finish!: () => void
  const p = new Promise<void>(r => { finish = r })
  speeches.push({ text, finish, done: false })
  return p
})
vi.mock('../utils/voicevox', () => ({
  speakWithVoicevox: (...args: unknown[]) => speakMock(...(args as [string, string])),
  prewarmVoicevox: () => null,
  // 既読は「声になった分」だけ進む。チャンクの通知を出さないモックでは全文が鳴った扱いになる
  // （このテストは既読の粒度ではなく、渡す記憶と並びを見る）。
  getSpeechClock: () => null,
}))
// 音の実体だけ差し替える。**通知音との間（`ttsDelayFor`）は本物を使う** ―― 読み上げの順番と
// 待ち合わせはこの間の長さで決まるため、模擬すると検証の前提が変わる。
vi.mock('../utils/alertSound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/alertSound')>()
  return { ...actual, playAlertSound: vi.fn() }
})
vi.mock('../utils/notifications', () => ({ showBrowserNotification: vi.fn() }))

function spokenTexts(): string[] {
  return speeches.map(s => s.text)
}

async function flush() {
  for (let i = 0; i < 400; i++) await Promise.resolve()
}

/** 通知音の遅延を消化し、直前の発話を終わらせてから次を待てる状態にする */
async function settle() {
  await vi.advanceTimersByTimeAsync(5000)
  await flush()
  for (const s of speeches) if (!s.done) { s.done = true; s.finish() }
  await flush()
}

/**
 * 津波の観測情報（等級を伝えない続報）。`areas` を渡すと区域の並べ替えが効く。
 * 実電文と同じく既報の観測点も載せ続ける。
 */
function makeObsReport(
  points: { name: string; district: string; code: string; value?: number }[],
  areas: { name: string; code: string; grade: string }[] = [],
  id = 'tsunami-obs',
): JMATsunami {
  return {
    kind: 'tsunami',
    id,
    time: '2026-01-01T12:00:00Z',
    cancelled: false,
    issue: { source: 'JMA', time: '2026-01-01T12:00:00Z', type: 'Focus' },
    areas: areas.map(a => ({ ...a, immediate: false })),
    observations: points.map(p => ({
      name: p.name,
      districtCode: p.code,
      districtName: p.district,
      height: p.value === undefined ? undefined : { value: p.value, description: `${p.value}m` },
    })),
  } as unknown as JMATsunami
}

/** 波高未確定（観測中）の観測点だけを持つ観測情報。到達確認として読まれる。 */
function makeArrivalReport(names: string[], id = 'tsunami-arr'): JMATsunami {
  return makeObsReport(names.map(n => ({ name: n, district: '石川県能登', code: '390' })), [], id)
}

/** 画面が出している津波（区域はここが持つ。観測情報の続報は区域を持たずに届く）。 */
function displayedTsunami(areas: { name: string; code: string; grade: string; height?: string }[]): JMATsunami {
  return {
    kind: 'tsunami',
    id: 'tsunami-displayed',
    time: '2026-01-01T12:00:00Z',
    cancelled: false,
    issue: { source: 'JMA', time: '2026-01-01T12:00:00Z', type: 'Focus' },
    areas: areas.map(a => ({
      name: a.name, code: a.code, grade: a.grade, immediate: false,
      maxHeight: a.height ? { description: a.height, value: 0 } : undefined,
    })),
  } as unknown as JMATsunami
}

function setup(displayed: JMATsunami[] = []) {
  const settings = {
    voicevoxEnabled: true, voicevoxUrl: 'http://x', voicevoxSpeakerId: 1,
    soundEnabled: false, soundVolume: 1, notifyMinScale: -1,
    notifyEEW: false, notifyTsunami: false, notifyDetection: false,
    ttsIntensityLevels: [], ttsMaxRegions: 0, ttsAlwaysReadScale: 0, ttsRegionTolerance: 0,
    minDisplayScale: -1,
  } as unknown as AppSettings
  const title = new Proxy({ alertTitle: null } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : vi.fn()),
  })
  const { result } = renderHook(() => useLiveEventHandler({
    settings, title: title as never,
    earthquakesRef: { current: [] as JMAQuake[] },
    tsunamisRef: { current: displayed },
    kyoshinDetectedRef: { current: false },
    defaultTabRef: { current: 'earthquake' },
    setActiveTabRealtimeForKyoshin: vi.fn(), setActiveTabNonRealtime: vi.fn(),
    setActiveTabRealtimeOnUpdate: vi.fn(),
    setActiveTabRealtimeUrgent: vi.fn(), followSpeechTab: vi.fn(), preSpeechTab: vi.fn(() => true),
    expandPanelForSpecialInfo: vi.fn(), revertToDefaultTab: vi.fn(),
    selectQuake: vi.fn(), setActiveLpgmEventId: vi.fn(),
  }))
  return result.current.handleLiveEvent
}

beforeEach(() => {
  vi.useFakeTimers()
  speeches.length = 0
  speakMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('津波観測情報の読み上げ: 新旧の言い分けと並び', () => {
  // 正: 初報は全件が初出。続報で値が上がった観測点だけが「更新」になる
  it('初報は「新たに」、続報で上がった観測点は「更新されました」', async () => {
    const handle = setup()
    handle(makeObsReport([{ name: '輪島港', district: '石川県能登', code: '390', value: 0.3 }]) as never)
    await settle()
    expect(spokenTexts()[0]).toContain('新たに石川県能登、輪島港で0.3メートルを観測しました。')

    // 同じ観測点の波高が上がり、別の観測点が新たに加わる（実電文は既報も載せ続ける）
    handle(makeObsReport([
      { name: '輪島港', district: '石川県能登', code: '390', value: 1.2 },
      { name: '珠洲市長橋', district: '石川県能登', code: '390', value: 0.5 },
    ], [], 'tsunami-obs-2') as never)
    await settle()
    // 深刻なのは更新された輪島港なので、更新の文が先に来て「また、」で新規が続く
    expect(spokenTexts()[1]).toContain('石川県能登、輪島港で1.2メートルに更新されました。')
    expect(spokenTexts()[1]).toContain('また、新たに石川県能登、珠洲市長橋で0.5メートルを観測しました。')
  })

  // 安全弁: 鳴らなかった観測点を既読にしない。前回の読み上げが割り込まれていれば、
  // その観測点は次でも「新たに」で読まれる（画面用の記憶を渡していたらここで「更新」になる）
  it('声にならなかった観測点は次の報でも「新たに」で読む', async () => {
    const handle = setup()
    // 通知音の遅延中に次の報が来ると、前の報は声にならないまま置き換わる
    handle(makeObsReport([{ name: '輪島港', district: '石川県能登', code: '390', value: 0.3 }]) as never)
    handle(makeObsReport([
      { name: '輪島港', district: '石川県能登', code: '390', value: 0.3 },
    ], [], 'tsunami-obs-2') as never)
    await settle()
    expect(spokenTexts()).toHaveLength(1)
    expect(spokenTexts()[0]).toContain('新たに石川県能登、輪島港で0.3メートルを観測しました。')
    expect(spokenTexts()[0]).not.toContain('更新')
  })

  // 安全弁: 到達確認も件数上限（5 件）で落ちる。**落ちた分を既読にしてはいけない** ――
  // 既読にすると、一度も声にしていない到達確認が二度と読まれない
  it('上限で読まなかった到達確認は既読にせず、次の報で読む', async () => {
    const handle = setup()
    const six = ['輪島港', '七尾港', '珠洲市長橋', '金沢', '富山', '伏木富山港新湊']
    handle(makeArrivalReport(six) as never)
    await settle()
    const first = spokenTexts().join('')
    // 先頭 5 件だけが声になり、6 件目は落ちる（落ちたことは件数で伝える）
    expect(first).toContain('輪島港')
    expect(first).not.toContain('伏木富山港新湊')
    expect(first).toContain('ほか1地点でも到達を確認しています。')

    // 同じ観測点を載せた続報。落ちた 6 件目だけが未読として残っている
    const before = spokenTexts().length
    handle(makeArrivalReport(six, 'tsunami-arr-2') as never)
    await settle()
    const second = spokenTexts().slice(before).join('')
    expect(second).toContain('伏木富山港新湊')
    expect(second).not.toContain('輪島港')
  })

  // 正: 読む順はカードの並び。等級の重い区域の観測点が先に来る（電文順ではない）。
  // **区域は画面が出している津波から引く。** 観測情報の続報は区域を持たずに届くので、
  // 電文の `areas` だけを見ていると並べ替えが何もしない
  it('観測点はカードの並びで読む（電文順ではない）', async () => {
    const handle = setup([displayedTsunami([
      { name: '青森県太平洋沿岸', code: '060', grade: 'Watch' },
      { name: '石川県能登', code: '390', grade: 'Warning' },
    ])])
    handle(makeObsReport([
      // 電文順では注意報の区域が先
      { name: '八戸', district: '青森県太平洋沿岸', code: '060', value: 0.4 },
      { name: '輪島港', district: '石川県能登', code: '390', value: 1.2 },
    ]) as never)
    await settle()
    const text = spokenTexts()[0]
    expect(text).toContain('輪島港')
    expect(text.indexOf('輪島港')).toBeLessThan(text.indexOf('八戸'))
  })

  // 安全弁: 区域の順位付けには**画面が持つ観測点の全体**を使う。今回の電文が運んだ分だけで
  // 並べると、既報の観測点を載せない続報で区域の順位が入れ替わり、カードと逆転する
  it('既報の観測点を載せない続報でも区域の順位はカードと一致する', async () => {
    // 画面には 2 区域。石川県能登は 3.0m（深刻）・青森県太平洋沿岸は 0.4m を既に観測している
    // 予想波高を持たせるのは、カードが**同じ波高の区域だけ**を 1 グループにまとめ、その
    // グループ内を実測の深刻な順に並べるため。波高が無い区域は 1 件ずつ別グループになり、
    // 実測での並べ替えが働かない（実際の警報の区域は波高を持つ）
    const displayed = displayedTsunami([
      { name: '青森県太平洋沿岸', code: '060', grade: 'Warning', height: '3m' },
      { name: '石川県能登', code: '390', grade: 'Warning', height: '3m' },
    ])
    ;(displayed as unknown as { observations: unknown }).observations = [
      { name: '八戸', districtCode: '060', districtName: '青森県太平洋沿岸', height: { value: 0.4, description: '0.4m' } },
      { name: '輪島港', districtCode: '390', districtName: '石川県能登', height: { value: 3.0, description: '3.0m' } },
    ]
    const handle = setup([displayed])
    // 続報は青森の更新と石川の新規観測点だけを載せる（輪島港の 3.0m は再送されない）
    handle(makeObsReport([
      { name: '八戸', district: '青森県太平洋沿岸', code: '060', value: 0.5 },
      { name: '珠洲市長橋', district: '石川県能登', code: '390', value: 0.2 },
    ]) as never)
    await settle()
    const text = spokenTexts().join('')
    // カードは石川県能登（最大 3.0m）を上に置く。読み上げもその順に従う
    expect(text.indexOf('珠洲市長橋')).toBeLessThan(text.indexOf('八戸'))
  })

  // 対照: 画面が津波を出していない（区域を引けない）場合は電文順のまま読む。
  // 並べ替えの基準が無いことを黙って別の順に変えない
  it('区域を引けなければ電文順のまま読む', async () => {
    const handle = setup()
    handle(makeObsReport([
      { name: '八戸', district: '青森県太平洋沿岸', code: '060', value: 0.4 },
      { name: '輪島港', district: '石川県能登', code: '390', value: 1.2 },
    ]) as never)
    await settle()
    const text = spokenTexts()[0]
    expect(text.indexOf('八戸')).toBeLessThan(text.indexOf('輪島港'))
  })
})
