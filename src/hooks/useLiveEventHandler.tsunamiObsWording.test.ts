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
 * 同一の津波イベントを指す識別子。
 *
 * **区域を持たない続報は DMDATA 経路（VTSE51②・VTSE52）にしか無く、その電文は必ず
 * `eventId` を持つ。** カードが前報の区域・観測点を引き継ぐ条件（`isTsunamiContinuation`）は
 * これで判定するので、実電文の形に合わせて双方へ持たせる。省くと画面の津波から区域を引けず、
 * 並べ替えが働かない状態を検証してしまう。
 */
const EVENT_ID = 'evt-1'

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
    eventId: EVENT_ID,
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

/**
 * 欠測の観測点を持つ観測情報。
 *
 * `condition` は電文の `Condition` を読み取った形（`parseTsunamiObservationCondition` の出力）。
 * `value` を与えると「これまでの最大波を観測した後に観測が途切れた」形になる。
 */
function makeMissingReport(
  points: { name: string; value?: number; firstHeightMissing?: boolean }[],
  id = 'tsunami-missing',
): JMATsunami {
  return {
    kind: 'tsunami',
    id,
    eventId: EVENT_ID,
    time: '2026-01-01T12:00:00Z',
    cancelled: false,
    issue: { source: 'JMA', time: '2026-01-01T12:00:00Z', type: 'Focus' },
    areas: [],
    observations: points.map(p => ({
      name: p.name,
      districtCode: '390',
      districtName: '石川県能登',
      height: p.value === undefined ? undefined : { value: p.value, description: `${p.value}m` },
      condition: { maxHeightMissing: true, firstHeightMissing: p.firstHeightMissing },
    })),
  } as unknown as JMATsunami
}

/** 画面が出している津波（区域はここが持つ。観測情報の続報は区域を持たずに届く）。 */
function displayedTsunami(areas: { name: string; code: string; grade: string; height?: string }[]): JMATsunami {
  return {
    kind: 'tsunami',
    id: 'tsunami-displayed',
    eventId: EVENT_ID,
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

/** `setup` と同じ結線で、リプレイ復元も呼べるようにフックの戻り値ごと返す。 */
function setupFull(displayed: JMATsunami[] = []) {
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
  return result.current
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

// 波高の文と到達確認の文は別々の関数が組む。連結するときに「また、」を挟まないと、どちらも
// 「地名で〜しました」の形なので後ろの文が前の続きに聞こえる（2024/01/01 17:40 の実電文で
// 隠岐西郷の波高と豊岡市津居山の到達確認が並んだ形）。
describe('津波の読み上げ: 話題が変わるところを「また、」で継ぐ', () => {
  // 正: 同じ電文に「波高が付いた観測点」と「到達だけ確認された観測点」が混ざったら間に挟む
  it('波高の文の後に到達確認が続くときは「また、」で継ぐ', async () => {
    const handle = setup()
    handle(makeObsReport([
      { name: '隠岐西郷', district: '隠岐', code: '551', value: 0.1 },
      { name: '豊岡市津居山', district: '兵庫県北部', code: '520' },
    ]) as never)
    await settle()
    expect(spokenTexts()[0])
      .toContain('新たに隠岐、隠岐西郷で0.1メートルを観測しました。また、兵庫県北部、豊岡市津居山で到達を確認しました。')
  })

  // 正: 等級の発表と同時に到達が確認された場合も同じ（連結している箇所が別なので個別に固定する）
  it('等級の発表の後に到達確認が続くときも「また、」で継ぐ', async () => {
    const handle = setup()
    handle(makeObsReport(
      [{ name: '輪島港', district: '石川県能登', code: '390' }],
      [{ name: '石川県能登', code: '390', grade: 'MajorWarning' }],
    ) as never)
    await settle()
    const text = spokenTexts()[0]
    expect(text).toContain('大津波警報')
    expect(text).toContain('また、石川県能登、輪島港で到達を確認しました。')
  })

  // 正: 群分けの「また、新たに」と到達確認の「また、」は同じ電文に同居しうる。**2 回とも要る** ――
  // 前者は新規と更新の境目、後者は波高と到達確認の境目で、示している切れ目が違う
  it('上がった区域・初出・到達確認が同居したら「また、」は 2 回', async () => {
    const handle = setup()
    handle(makeObsReport([{ name: '輪島港', district: '石川県能登', code: '390', value: 0.3 }]) as never)
    await settle()

    handle(makeObsReport([
      { name: '輪島港', district: '石川県能登', code: '390', value: 1.2 },
      { name: '珠洲市長橋', district: '石川県能登', code: '390', value: 0.5 },
      { name: '七尾港', district: '石川県能登', code: '390' },
    ], [], 'tsunami-obs-2') as never)
    await settle()
    const text = spokenTexts()[1]
    expect(text).toContain('石川県能登、輪島港で1.2メートルに更新されました。')
    expect(text).toContain('また、新たに石川県能登、珠洲市長橋で0.5メートルを観測しました。')
    expect(text).toContain('また、石川県能登、七尾港で到達を確認しました。')
    expect(text.match(/また、/g)).toHaveLength(2)
    // 到達確認は最後（波高の 2 群を読み終えてから継ぐ）
    expect(text.indexOf('珠洲市長橋')).toBeLessThan(text.indexOf('七尾港'))
  })

  // 正: 区域はあるのに等級が 1 つも取れない電文（全区域が Unknown）は、引き下げ側で
  // 「全て解除されました」になる。ここに到達確認を継ぐと、解除の直後に新たな到達を伝える
  // 矛盾した並びになるので継がない
  it('等級を語れない電文では到達確認を継がない', async () => {
    const handle = setup()
    // 先に等級を発表して、次の報が「引き下げ」と判定される状態を作る
    handle(makeObsReport([], [{ name: '石川県能登', code: '390', grade: 'MajorWarning' }]) as never)
    await settle()

    const before = spokenTexts().length
    handle(makeObsReport(
      [{ name: '七尾港', district: '石川県能登', code: '390' }],
      [{ name: '石川県能登', code: '390', grade: 'Unknown' }],
      'tsunami-unknown',
    ) as never)
    await settle()
    const text = spokenTexts().slice(before).join('')
    expect(text).toContain('全て解除されました')
    expect(text).not.toContain('また、')
    expect(text).not.toContain('七尾港')
  })

  // 安全弁: 上で読まなかった到達確認を既読にしない。続く観測情報の続報で読まれること
  it('継がなかった到達確認は既読にせず、次の観測情報で読む', async () => {
    const handle = setup()
    handle(makeObsReport([], [{ name: '石川県能登', code: '390', grade: 'MajorWarning' }]) as never)
    await settle()
    handle(makeObsReport(
      [{ name: '七尾港', district: '石川県能登', code: '390' }],
      [{ name: '石川県能登', code: '390', grade: 'Unknown' }],
      'tsunami-unknown',
    ) as never)
    await settle()

    const before = spokenTexts().length
    handle(makeArrivalReport(['七尾港'], 'tsunami-arr-after') as never)
    await settle()
    expect(spokenTexts().slice(before).join('')).toContain('七尾港で到達を確認しました。')
  })

  // 対照: 到達確認だけの電文は継ぐ前段が無い。「また、」で始まる文にしない
  it('到達確認だけの電文には「また、」を付けない', async () => {
    const handle = setup()
    handle(makeArrivalReport(['輪島港']) as never)
    await settle()
    expect(spokenTexts()[0]).toContain('津波観測情報。石川県能登、輪島港で到達を確認しました。')
    expect(spokenTexts()[0]).not.toContain('また、')
  })

  // 安全弁: 到達確認が無ければ「また、」は増えない。新規と更新の群分けが使う「また、」
  // （`tsunamiObservationUpdateToSegments`）と二重にならないこと
  it('到達確認が無ければ「また、」は群分けのぶんだけ', async () => {
    const handle = setup()
    handle(makeObsReport([{ name: '輪島港', district: '石川県能登', code: '390', value: 0.3 }]) as never)
    await settle()
    expect(spokenTexts()[0]).not.toContain('また、')

    handle(makeObsReport([
      { name: '輪島港', district: '石川県能登', code: '390', value: 1.2 },
      { name: '珠洲市長橋', district: '石川県能登', code: '390', value: 0.5 },
    ], [], 'tsunami-obs-2') as never)
    await settle()
    // 群分けの「また、新たに」だけ。到達確認のぶんは足されない
    expect(spokenTexts()[1].match(/また、/g)).toHaveLength(1)
    expect(spokenTexts()[1]).toContain('また、新たに')
  })
})

// 欠測（観測データが得られていない観測点）をフックの結線ごと固定する。
// 文の組み立ては `ttsText.test.ts`。ここで守るのは「到達確認の経路へ流れ込まないこと」と
// 「既読の記憶を到達確認と混ぜないこと」（→ docs/spec/tsunami-spec.md §10）。
describe('津波観測情報の読み上げ: 欠測', () => {
  // 正: 欠測の観測点は欠測として読まれる
  it('欠測の観測点は「到達を確認」ではなく欠測として読む', async () => {
    const handle = setup()
    handle(makeMissingReport([{ name: '輪島港' }]) as never)
    await settle()
    expect(spokenTexts()[0]).toBe('津波観測情報。石川県能登、輪島港は欠測となっています。')
  })

  // 正: 値を持つ欠測はその値も読む（電文が「これまでの最大波の高さ」を載せてくる）
  it('これまでに観測できた波高がある欠測は値も読む', async () => {
    const handle = setup()
    handle(makeMissingReport([{ name: '輪島港', value: 1.2 }]) as never)
    await settle()
    expect(spokenTexts()[0]).toContain('これまでに石川県能登、輪島港で1.2メートルを観測したのち、欠測となっています。')
  })

  // 対照: 欠測でない波高未確定は従来どおり到達確認として読む
  it('欠測でない波高未確定は従来どおり「到達を確認しました」', async () => {
    const handle = setup()
    handle(makeArrivalReport(['輪島港']) as never)
    await settle()
    expect(spokenTexts()[0]).toContain('輪島港で到達を確認しました。')
    expect(spokenTexts()[0]).not.toContain('欠測')
  })

  // 正: 到達確認と欠測が同じ電文で来たら、確定した事実を先に読み「また、」で継ぐ
  it('到達確認と欠測が同じ電文なら到達確認を先に読む', async () => {
    const handle = setup()
    handle({
      ...makeArrivalReport(['珠洲市長橋']),
      observations: [
        ...makeArrivalReport(['珠洲市長橋']).observations!,
        ...makeMissingReport([{ name: '輪島港' }]).observations!,
      ],
    } as never)
    await settle()
    const text = spokenTexts()[0]
    expect(text).toContain('珠洲市長橋で到達を確認しました。')
    expect(text).toContain('また、石川県能登、輪島港は欠測となっています。')
    expect(text.indexOf('到達を確認')).toBeLessThan(text.indexOf('欠測'))
  })

  // 安全弁: 同じ欠測を続報で読み直さない
  it('同じ欠測は続報で読み直さない', async () => {
    const handle = setup()
    handle(makeMissingReport([{ name: '輪島港' }]) as never)
    await settle()
    handle(makeMissingReport([{ name: '輪島港' }], 'tsunami-missing-2') as never)
    await settle()
    expect(spokenTexts().filter(t => t.includes('欠測'))).toHaveLength(1)
  })

  // 安全弁: 欠測の既読と到達確認の既読を混ぜない。混ぜると、欠測を読んだ観測点が
  // 復帰して到達を確認できても「一度読んだ」と見なされて黙る
  it('欠測を読んだ観測点は、復帰後の到達確認をきちんと読む', async () => {
    const handle = setup()
    handle(makeMissingReport([{ name: '輪島港' }]) as never)
    await settle()
    const before = spokenTexts().length
    handle(makeArrivalReport(['輪島港'], 'tsunami-arr-recovered') as never)
    await settle()
    expect(spokenTexts().slice(before).join('')).toContain('輪島港で到達を確認しました。')
  })

  // 安全弁: 復帰したあと再び欠測になったら、新しい事実として読む
  it('復帰後にもう一度欠測になったら読み直す', async () => {
    const handle = setup()
    handle(makeMissingReport([{ name: '輪島港' }]) as never)
    await settle()
    handle(makeArrivalReport(['輪島港'], 'tsunami-arr-recovered') as never)
    await settle()
    const before = spokenTexts().length
    handle(makeMissingReport([{ name: '輪島港' }], 'tsunami-missing-again') as never)
    await settle()
    expect(spokenTexts().slice(before).join('')).toContain('欠測となっています。')
  })
})

// 値を持つ欠測（電文が「これまでの最大波の高さ」を載せる形）を二重に読まないこと。
// 波高更新の文と欠測の文が同じ観測点・同じ値を語ると、いま観測できているのかが伝わらない。
describe('津波観測情報の読み上げ: 欠測と波高更新の切り分け', () => {
  it('正: 値を持つ欠測は欠測の文だけで読む（「新たに観測しました」と重ねない）', async () => {
    const handle = setup()
    handle(makeMissingReport([{ name: '輪島港', value: 1.2 }]) as never)
    await settle()
    const text = spokenTexts()[0]
    expect(text).toContain('これまでに石川県能登、輪島港で1.2メートルを観測したのち、欠測となっています。')
    expect(text).not.toContain('を観測しました。')
  })

  it('対照: 欠測でない観測点は従来どおり「新たに…を観測しました」', async () => {
    const handle = setup()
    handle(makeObsReport([{ name: '輪島港', district: '石川県能登', code: '390', value: 1.2 }]) as never)
    await settle()
    expect(spokenTexts()[0]).toContain('新たに石川県能登、輪島港で1.2メートルを観測しました。')
  })

  it('安全弁: 欠測の観測点と普通の観測点が混ざっても、それぞれ 1 度だけ読む', async () => {
    const handle = setup()
    handle({
      ...makeObsReport([{ name: '珠洲市長橋', district: '石川県能登', code: '390', value: 0.5 }]),
      observations: [
        ...makeObsReport([{ name: '珠洲市長橋', district: '石川県能登', code: '390', value: 0.5 }]).observations!,
        ...makeMissingReport([{ name: '輪島港', value: 1.2 }]).observations!,
      ],
    } as never)
    await settle()
    const text = spokenTexts()[0]
    expect(text.match(/珠洲市長橋/g)).toHaveLength(1)
    expect(text.match(/輪島港/g)).toHaveLength(1)
    expect(text).toContain('新たに石川県能登、珠洲市長橋で0.5メートルを観測しました。')
    expect(text).toContain('また、これまでに石川県能登、輪島港で1.2メートルを観測したのち、欠測となっています。')
  })
})

// リプレイ復元（窓の手前の全報を順に舐める）と、ライブ経路の記憶の対称性。
// 復元が「欠測になった」だけを積んで「復帰した」を落とさないと、再生開始後の再欠測が黙る。
describe('津波観測情報の読み上げ: リプレイ復元と欠測の記憶', () => {
  const entry = (event: JMATsunami) => ({
    payload: { kind: 'event' as const, event },
    replayTime: new Date('2026-01-01T12:00:00Z'),
  })

  it('正: 窓の手前で欠測から復帰していれば、再生開始後の欠測を読む', async () => {
    const d = setupFull()
    // 手前の 2 報: 欠測 → 復帰（到達確認）
    d.restorePreWindowTracking([
      entry(makeMissingReport([{ name: '輪島港' }], 'pre-1')),
      entry(makeArrivalReport(['輪島港'], 'pre-2')),
    ] as never)
    d.handleLiveEvent(makeMissingReport([{ name: '輪島港' }], 'live-1') as never)
    await settle()
    expect(spokenTexts().join('')).toContain('欠測となっています。')
  })

  it('対照: 窓の手前の時点で欠測のままなら、その欠測は読み直さない', async () => {
    const d = setupFull()
    d.restorePreWindowTracking([entry(makeMissingReport([{ name: '輪島港' }], 'pre-1'))] as never)
    d.handleLiveEvent(makeMissingReport([{ name: '輪島港' }], 'live-1') as never)
    await settle()
    expect(spokenTexts().join('')).not.toContain('欠測')
  })

  it('安全弁: 手前で欠測だった観測点が復帰したら、到達確認は読む', async () => {
    // 復元が欠測の観測点名を「到達確認を声にした」側へ入れていると、ここで黙る
    const d = setupFull()
    d.restorePreWindowTracking([entry(makeMissingReport([{ name: '輪島港' }], 'pre-1'))] as never)
    d.handleLiveEvent(makeArrivalReport(['輪島港'], 'live-1') as never)
    await settle()
    expect(spokenTexts().join('')).toContain('輪島港で到達を確認しました。')
  })
})

// 欠測のまま「これまでの最大波」の値だけが上がる続報（断続的な欠測）。
// 名前だけで既読を判定すると、最初の欠測報のあとに届いたより深刻な値が一度も伝わらない。
describe('津波観測情報の読み上げ: 欠測のまま値が上がる続報', () => {
  it('正: 欠測が続いていても値が上がったら読み直す', async () => {
    const handle = setup()
    handle(makeMissingReport([{ name: '輪島港', value: 1.2 }]) as never)
    await settle()
    const before = spokenTexts().length
    handle(makeMissingReport([{ name: '輪島港', value: 3.5 }], 'tsunami-missing-2') as never)
    await settle()
    expect(spokenTexts().slice(before).join('')).toContain('3.5メートルを観測したのち、欠測となっています。')
  })

  it('対照: 値が変わらない続報は読み直さない', async () => {
    const handle = setup()
    handle(makeMissingReport([{ name: '輪島港', value: 1.2 }]) as never)
    await settle()
    const before = spokenTexts().length
    handle(makeMissingReport([{ name: '輪島港', value: 1.2 }], 'tsunami-missing-2') as never)
    await settle()
    expect(spokenTexts().slice(before).join('')).not.toContain('欠測')
  })

  it('安全弁: 値が下がった続報では読み直さない（気象庁が取り下げた値を強調しない）', async () => {
    const handle = setup()
    handle(makeMissingReport([{ name: '輪島港', value: 3.5 }]) as never)
    await settle()
    const before = spokenTexts().length
    handle(makeMissingReport([{ name: '輪島港', value: 1.2 }], 'tsunami-missing-2') as never)
    await settle()
    expect(spokenTexts().slice(before).join('')).not.toContain('欠測')
  })
})

// 「到達確認 → 欠測 → 復帰」の順で届いたとき、復帰の到達確認を読むこと。
// 記憶の遷移はライブ経路とリプレイ復元で同じ規則を通す
// （`forgetSpokenOnObservationStateChange`）。片方だけに書くと非対称が生まれる。
describe('津波観測情報の読み上げ: 到達確認と欠測を行き来する観測点', () => {
  it('正: 到達確認を読んだ後に欠測へ入り、復帰したらもう一度到達確認を読む', async () => {
    const handle = setup()
    handle(makeArrivalReport(['輪島港']) as never)
    await settle()
    handle(makeMissingReport([{ name: '輪島港' }], 'tsunami-missing') as never)
    await settle()
    const before = spokenTexts().length
    handle(makeArrivalReport(['輪島港'], 'tsunami-arr-2') as never)
    await settle()
    expect(spokenTexts().slice(before).join('')).toContain('輪島港で到達を確認しました。')
  })

  it('対照: 欠測を挟まなければ到達確認は読み直さない', async () => {
    const handle = setup()
    handle(makeArrivalReport(['輪島港']) as never)
    await settle()
    const before = spokenTexts().length
    handle(makeArrivalReport(['輪島港'], 'tsunami-arr-2') as never)
    await settle()
    expect(spokenTexts().slice(before).join('')).not.toContain('到達を確認しました')
  })

  it('安全弁: 復帰を読んだ後に再び欠測へ入ったら、その欠測も読む', async () => {
    const handle = setup()
    handle(makeArrivalReport(['輪島港']) as never)
    await settle()
    handle(makeMissingReport([{ name: '輪島港' }], 'tsunami-missing') as never)
    await settle()
    handle(makeArrivalReport(['輪島港'], 'tsunami-arr-2') as never)
    await settle()
    const before = spokenTexts().length
    handle(makeMissingReport([{ name: '輪島港' }], 'tsunami-missing-2') as never)
    await settle()
    expect(spokenTexts().slice(before).join('')).toContain('欠測となっています。')
  })
})
