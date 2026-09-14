// @vitest-environment jsdom
//
// 地震情報の続報を「差分だけ読む」ときの、既読の進め方のテスト。固定するのは 1 点だけ。
//
// **既読になるのは、実際に声になった分だけ。** 読み上げ文を作った時点で既読にすると、
// 割り込み（`speakWithVoicevox` は入口で既存の再生を止める）で鳴らなかった地域が
// 二度と読まれなくなる。2024/1/1 能登の実データでは、地震情報の読み上げ中に EEW 警報が
// 14 通届いた報がある。割り込みは例外ではなく日常。
//
// チャンクの分割は手書きせず実物（`splitIntoChunks`）を通す。分割の条件を変えたときに、
// テストだけが古い境界を前提に通り続けるのを防ぐため。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useLiveEventHandler } from './useLiveEventHandler'
import { DEFAULTS, type AppSettings } from './useSettings'
import type { JMAQuake, JMATsunami, IssueType, IntensityScale, EarthquakePoint } from '../types/earthquake'

/** 予約の通知の受け口。チャンクの開始時刻は 100 秒から 1 秒刻みで置く。 */
const CHUNK_START_BASE = 100

interface Speech {
  text: string
  chunks: readonly string[]
  onChunk?: (index: number, startAt: number, chunks: readonly string[]) => void
  finish: () => void
  done: boolean
}

const speeches: Speech[] = []
/** `getSpeechClock` が返す値（再生時計）。テストが進める。 */
let clock: number | null = null

vi.mock('../utils/voicevox', async () => {
  const actual = await vi.importActual<typeof import('../utils/voicevox')>('../utils/voicevox')
  return {
    splitIntoChunks: actual.splitIntoChunks,
    prewarmVoicevox: () => null,
    getSpeechClock: () => clock,
    speakWithVoicevox: (
      _url: string, text: string, _id: number, _vol: number,
      _ssp: unknown, _prewarmed: unknown,
      onChunk?: (index: number, startAt: number, chunks: readonly string[]) => void,
    ) => {
      // 割り込まれた側は完了扱いになる（実装と同じ連鎖）
      for (const s of speeches) {
        if (!s.done) { s.done = true; s.finish() }
      }
      let finish!: () => void
      const p = new Promise<void>(r => { finish = r })
      speeches.push({ text, chunks: actual.splitIntoChunks(text), onChunk, finish, done: false })
      return p
    },
  }
})
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

/** 通知音の遅延を消化してから発話に到達させる */
async function settle() {
  await vi.advanceTimersByTimeAsync(5000)
  await flush()
}

/**
 * 読み上げの進行を再現する。**終わらせない**（読み上げ中に次の電文が届く形を作るため）。
 *
 * @param index 何番目の読み上げか
 * @param soundedChunks 音が鳴り始めたチャンク数（予約は全チャンク通ったものとして通知する）
 */
async function advanceSpeech(index: number, soundedChunks: number) {
  const s = speeches[index]
  if (!s) throw new Error(`読み上げ ${index} が無い`)
  // 合成は再生より先へ進むため、予約は全チャンク届く
  s.chunks.forEach((_, i) => s.onChunk?.(i, CHUNK_START_BASE + i, s.chunks))
  // 鳴り始めたところまで時計を進める
  clock = CHUNK_START_BASE + soundedChunks - 1 + 0.1
  await flush()
}

/**
 * 読み上げの進行を再現して終わらせる。
 *
 * @param index 何番目の読み上げか
 * @param soundedChunks 音が鳴り始めたチャンク数（予約は全チャンク通ったものとして通知する）
 */
async function playSpeech(index: number, soundedChunks: number) {
  await advanceSpeech(index, soundedChunks)
  const s = speeches[index]
  if (!s.done) { s.done = true; s.finish() }
  await flush()
}

function area(pref: string, addr: string, scale: number): EarthquakePoint {
  return { pref, addr, isArea: true, scale: scale as IntensityScale }
}

// 同一イベントとして扱わせるため earthquake.time と震源名は固定する。
// **id は DMDATA の形にする**（`dmdata-quake-<eventId>-<serial>`）。既読の記録は「その地震」に
// 紐づけるため、キーは `quakeEventKey` ―― eventId を持たない P2PQuake の生電文では報ごとに
// キーが変わりうる（統合済みカードを引けたときだけ安定する）。ここで測りたいのは種別を跨いだ
// 共有なので、キーが安定する経路を使う。
// 震源座標は 0 にして震源距離での並べ替えを通さず、列挙順を points の順に固定する。
function makeQuake(
  points: EarthquakePoint[],
  // `eventId` / `name` を変えると**別の地震**になる（既読は `quakeEventKey` ごとに分かれる）
  over: { type?: IssueType; maxScale?: number; magnitude?: number; serial?: number; eventId?: string; name?: string } = {},
): JMAQuake {
  const maxScale = (over.maxScale ?? 40) as IntensityScale
  const at = over.eventId === undefined ? '2026-01-01T12:00:00Z' : '2026-01-01T13:00:00Z'
  return {
    kind: 'quake',
    id: `dmdata-quake-${over.eventId ?? '20260101210000'}-${over.serial ?? 1}`,
    time: at,
    issue: { source: 'JMA', time: at, type: over.type ?? '震度速報', correct: 'なし' },
    earthquake: {
      time: at,
      hypocenter: { name: over.name ?? '石川県能登地方', latitude: 0, longitude: 0, depth: 10, magnitude: over.magnitude ?? 5.2 },
      maxScale,
      domesticTsunami: 'なし',
    },
    points,
  } as JMAQuake
}

const setActiveTabNonRealtime = vi.fn()
const followSpeechTab = vi.fn()

function setup() {
  const settings = { ...DEFAULTS,
    voicevoxEnabled: true, voicevoxUrl: 'http://x', voicevoxSpeakerId: 1,
    soundEnabled: false, soundVolume: 1, notifyMinScale: -1,
    notifyEEW: false, notifyTsunami: false, notifyDetection: false,
    ttsIntensityLevels: 2, ttsMaxRegions: 0, ttsAlwaysReadScale: -1, ttsRegionTolerance: 0,
    minDisplayScale: -1,
  } as unknown as AppSettings
  const title = new Proxy({ alertTitle: null } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : vi.fn()),
  })
  const { result } = renderHook(() => useLiveEventHandler({
    settings, title: title as never,
    earthquakesRef: { current: [] as JMAQuake[] },
    tsunamisRef: { current: [] as JMATsunami[] },
    kyoshinDetectedRef: { current: false },
    defaultTabRef: { current: 'earthquake' },
    setActiveTabRealtimeForKyoshin: vi.fn(), setActiveTabNonRealtime,
    setActiveTabRealtimeOnUpdate: vi.fn(),
    setActiveTabRealtimeUrgent: vi.fn(), followSpeechTab, preSpeechTab: vi.fn(() => true),
    expandPanelForSpecialInfo: vi.fn(), revertToDefaultTab: vi.fn(),
    selectQuake: vi.fn(), openLpgmFromQuake: vi.fn(), openEstimatedIntensity: vi.fn(), closeDistributionOnQuakeReport: vi.fn(),
  }))
  return result.current.handleLiveEvent
}

beforeEach(() => {
  vi.useFakeTimers()
  speeches.length = 0
  clock = null
  setActiveTabNonRealtime.mockClear()
  followSpeechTab.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('地震情報の続報: 既読は声になった分だけ進む', () => {
  const threeAreas = [
    area('石川県', '石川県能登', 40),
    area('石川県', '石川県加賀', 40),
    area('富山県', '富山県東部', 40),
  ]

  // 2026-08-22 に反転: 変化のない続報でも**名乗りだけは読む**（黙ると電文が来たことが伝わらない）。
  it('正: 最後まで鳴ったら、変化のない続報は名乗りだけで終える', async () => {
    const handle = setup()
    handle(makeQuake(threeAreas))
    await settle()
    expect(spokenTexts()[0]).toBe('震度速報。最大震度4を石川県能登、石川県加賀、富山県東部で観測しました。')
    await playSpeech(0, speeches[0].chunks.length)

    handle(makeQuake(threeAreas))
    await settle()
    expect(spokenTexts()[1]).toBe('震度速報が更新されました。')
  })

  // 差分が空でも読み上げ文は非空（名乗りが残る）ため、タブ移動は**読み上げ追従が担う**。
  // 受信時要求へ落とす経路は、読み上げが無効なときだけ通る（`useLiveEventHandler` の UI ブロック）。
  it('正: 差分が空でも読み上げ経由で earthquake タブへ移る', async () => {
    const handle = setup()
    handle(makeQuake(threeAreas))
    await settle()
    await playSpeech(0, speeches[0].chunks.length)
    followSpeechTab.mockClear()

    handle(makeQuake(threeAreas))
    await settle()
    expect(followSpeechTab).toHaveBeenCalledWith('earthquake', expect.anything(), { alreadyShown: true })
  })

  it('正: 途中で切られたら、鳴った区域だけが既読になる', async () => {
    const handle = setup()
    handle(makeQuake(threeAreas))
    await settle()
    // チャンクは ['震度速報。', '最大震度4を石川県能登、', '石川県加賀、', '富山県東部で観測しました。']
    expect(speeches[0].chunks).toHaveLength(4)
    // 3 チャンク目まで鳴り始めた（＝鳴り始めた最後の 1 つは数えないので、能登までが既読）
    await playSpeech(0, 3)

    handle(makeQuake(threeAreas))
    await settle()
    // 石川県加賀・富山県東部はまだ一度も声にしていない＝初出の群（「新たに」が付き「最大」は冠さない）
    expect(spokenTexts()[1]).toBe('震度速報が更新されました。新たに震度4を石川県加賀、富山県東部で観測しました。')
  })

  // ここから 3 件は読み上げの**最中**に次の報が届く形（2026-09-11）。既読の記録は読み上げの
  // 完了時にしか進まないのに差分は受信時に同期で組まれるため、読み切る前に次が届くと
  // 「まだ何も声になっていない」古い状態を基準にし、**先頭から読み直していた**。
  it('正: 読み上げ中に次の報が届いても、そこまで鳴った分は既読になる', async () => {
    const handle = setup()
    handle(makeQuake(threeAreas))
    await settle()
    expect(speeches[0].chunks).toHaveLength(4)
    // 3 チャンク目まで鳴り始めた。**まだ読み終えていない**
    await advanceSpeech(0, 3)

    handle(makeQuake(threeAreas))
    await settle()
    // 能登は声になっているので読み直さない（修正前はここが全文だった）
    expect(spokenTexts()[1]).toBe('震度速報が更新されました。新たに震度4を石川県加賀、富山県東部で観測しました。')
  })

  it('対照: 読み上げ中でも 1 チャンクも鳴っていなければ全文を読み直す', async () => {
    const handle = setup()
    handle(makeQuake(threeAreas))
    await settle()
    // 予約は全チャンク通ったが、音はまだ 1 つも鳴っていない
    await advanceSpeech(0, 0)

    handle(makeQuake(threeAreas))
    await settle()
    expect(spokenTexts()[1]).toBe('震度速報が更新されました。最大震度4を石川県能登、石川県加賀、富山県東部で観測しました。')
  })

  // `flushSpoken` は主題で絞らず、進行中の読み上げが何であっても呼ぶ。**記録は地震ごとに
  // 分かれている**（`quakeSpokenStateFor` が eventKey ごとに別オブジェクトを返す）ので混ざらない、
  // というのが設計の前提。群発で顕在化する形なので固定しておく。
  //
  // **このテストは flush を外しても落ちない。** 割り込みが入れば前の読み上げの `finally` が
  // 走って記録されるため、混ざらないこと自体は変更前から成り立っている。守っているのは
  // 「flush を足したことで記録の分離が緩んでいないか」で、変更が効くことを見る「正」の
  // テスト（上の 3 件）とは役割が違う。
  it('安全弁: 別の地震が割り込んでも、既読は地震ごとに独立して進む', async () => {
    const handle = setup()
    // 地震 A を 3 チャンク目まで鳴らす（能登までが既読になる）
    handle(makeQuake(threeAreas))
    await settle()
    await advanceSpeech(0, 3)

    // 別の地震 B が割り込む。ここで A に対して flushSpoken が走る
    handle(makeQuake([area('富山県', '富山県西部', 30)], { eventId: '20260101220000', name: '富山県西部' }))
    await settle()
    await playSpeech(1, speeches[1].chunks.length)

    // 地震 A の続報。B の割り込みで A の記録が壊れていなければ、能登は読み直さない
    handle(makeQuake(threeAreas))
    await settle()
    const text = spokenTexts()[2]
    expect(text).not.toContain('石川県能登')
    expect(text).toContain('石川県加賀')

    // 地震 B の続報。A の記録に引きずられず、B は据え置きとして扱われる
    handle(makeQuake([area('富山県', '富山県西部', 30)], { eventId: '20260101220000', name: '富山県西部', serial: 2 }))
    await settle()
    expect(spokenTexts()[3]).not.toContain('富山県西部')
  })

  it('安全弁: 読み上げ中の見直しでは、最終チャンクが鳴り始めていても完走とみなさない', async () => {
    const handle = setup()
    handle(makeQuake(threeAreas))
    await settle()
    // 最終チャンク（富山県東部）が鳴り始めた。完了後ならここは完走扱いだが、途中なので
    // 言い終えたとは言えない。**完走扱いにすると、割り込まれた分が既読として残る**
    await advanceSpeech(0, 4)

    handle(makeQuake(threeAreas))
    await settle()
    expect(spokenTexts()[1]).toBe('震度速報が更新されました。新たに震度4を富山県東部で観測しました。')
  })

  it('安全弁: 1 チャンクも鳴らなければ、続報は全文を読み直す', async () => {
    const handle = setup()
    handle(makeQuake(threeAreas))
    await settle()
    // 予約は届いたが音は出ていない（鳴り出す前に割り込まれた）
    await playSpeech(0, 0)

    handle(makeQuake(threeAreas))
    await settle()
    expect(spokenTexts()[1]).toBe('震度速報が更新されました。最大震度4を石川県能登、石川県加賀、富山県東部で観測しました。')
  })

  it('安全弁: 再生時計が無い（VOICEVOX 未起動）なら、続報は全文を読み直す', async () => {
    const handle = setup()
    handle(makeQuake(threeAreas))
    await settle()
    const s = speeches[0]
    s.chunks.forEach((_, i) => s.onChunk?.(i, CHUNK_START_BASE + i, s.chunks))
    clock = null
    s.done = true; s.finish()
    await flush()

    handle(makeQuake(threeAreas))
    await settle()
    expect(spokenTexts()[1]).toContain('石川県能登')
  })

  // **確定情報だけは例外**。その地震で最初の 1 通は地域も通しで読む（速報を細切れに聞いた耳へ、
  // 確定した観測を 1 度だけまとめて示す）。2 通目以降は差分に戻る。
  it('正: その地震で最初の確定情報は、既読の区域も通しで読む', async () => {
    const handle = setup()
    handle(makeQuake(threeAreas, { type: '震度速報' }))
    await settle()
    await playSpeech(0, speeches[0].chunks.length)

    handle(makeQuake(threeAreas, { type: '震源・震度情報', serial: 2 }))
    await settle()
    expect(spokenTexts()[1]).toContain('マグニチュード5.2')
    expect(spokenTexts()[1]).toContain('最大震度4を石川県能登、石川県加賀、富山県東部で観測しました。')
    expect(spokenTexts()[1]).not.toContain('新たに')
    await playSpeech(1, speeches[1].chunks.length)

    // 2 通目の確定情報では**地域を通しで読まない**（差分に戻る＝変化が無いので地域は挙げない）。
    // 震源要素はその種別として初めてなので通しで言う（種別ごとの初報の扱い。従来どおり）。
    handle(makeQuake(threeAreas, { type: '各地の震度情報', serial: 3 }))
    await settle()
    expect(spokenTexts()[2]).toContain('マグニチュード5.2')
    expect(spokenTexts()[2]).not.toContain('観測しました')
  })
})
