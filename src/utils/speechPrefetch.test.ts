// リプレイ中の投機的先行合成が組む文（`speechPrefetch.ts`）。
//
// **この仕掛けの存在理由は「投機した文が、本番の読み上げとチャンクを共有すること」**。
// 共有していなければ控えは一度も当たらず、症状は「なんとなく速くならない」だけで
// 画面にもログにも出ない。だから固定するのはそこを中心に据える。
//
// 正・対照・安全弁の分担:
//   正   ＝ 状態に依らない文は、本番と 1 文字も違わない
//   対照 ＝ 読み上げない電文からは何も作らない
//   安全弁＝ 電文が壊れていても投機で再生を壊さない
import { describe, it, expect } from 'vitest'
import { speculativeSpeechTexts, speculativeSpeechTextsSafe } from './speechPrefetch'
import { telegramTextToSpeak, nankaiToText, nankaiCommentaryToText, kohatsuToText, earthquakeCountToText, lpgmToText, estimatedIntensityToText, type TtsSpeechOptions } from './ttsText'
import { splitIntoChunks } from './voicevox'
import {
  createTestNankai, createTestNankaiCommentary, createTestKohatsu,
  createTestEarthquakeCount, createTestQuakeNotice, createTestEEWWarning,
  createTestLpgm, createTestEarthquake,
} from './testData'
import type { ReplayPayload } from '../types/replay'
import type { JMAEstimatedIntensity } from '../types/earthquake'

/**
 * 既定の読み上げオプション（設定を何も触っていない状態に相当）。
 *
 * 値は `useSettings.ts` の `DEFAULTS` に揃えてある。**`ttsRegionOptions` を呼ばないのは、
 * あれが `AppSettings` 全体を要求するため** —— この検証に要るのは読み上げの詳しさだけ。
 */
const OPTS: TtsSpeechOptions = {
  intensityLevels: 2,
  maxRegions: 10,
  alwaysReadScale: 30,
  regionTolerance: 2,
}

/**
 * 気象庁が書いた文まで読む設定。
 *
 * **既定（`ttsReadTelegramText`）は偽**なので、この文が声になるのは設定を入れた利用者だけ。
 * 投機がいちばん効くのはここ（本文が数十チャンクになる）なので、その形で固定しておく。
 */
const OPTS_WITH_TELEGRAM_TEXT: TtsSpeechOptions = { ...OPTS, readTelegramText: true }

describe('状態に依らない電文は、本番と同じ文を先に作れる', () => {
  // **ここが投機の柱。** 南海トラフ解説の本文は 1721 字＝65 チャンクあり、合成が再生に
  // 追いつかなくなるのはまさにこの長さの文。1 文字でもずれると控えが当たらない。
  it('南海トラフ地震関連解説情報：本番の文と完全に一致する（正）', () => {
    const data = createTestNankaiCommentary('臨時解説')
    const payload: ReplayPayload = { kind: 'nankaiCommentary', data }
    expect(speculativeSpeechTexts(payload, OPTS)).toContain(nankaiCommentaryToText(data))
  })

  it('南海トラフ地震臨時情報：本番の文と完全に一致する（正）', () => {
    const data = createTestNankai('巨大地震注意')
    const payload: ReplayPayload = { kind: 'nankai', data }
    expect(speculativeSpeechTexts(payload, OPTS)).toContain(nankaiToText(data))
  })

  it('後発地震注意情報：本番の文と完全に一致する（正）', () => {
    const data = createTestKohatsu()
    const payload: ReplayPayload = { kind: 'kohatsu', data }
    expect(speculativeSpeechTexts(payload, OPTS)).toContain(kohatsuToText(data))
  })

  it('地震回数に関する情報：本番の文と完全に一致する（正）', () => {
    const data = createTestEarthquakeCount()
    const payload: ReplayPayload = { kind: 'earthquakeCount', data }
    expect(speculativeSpeechTexts(payload, OPTS)).toContain(earthquakeCountToText(data))
  })

  // 気象庁が書いた文は本体とは別の発話として最下位の層で読まれる（→ audio-tts-spec.md §6）。
  // **別々に焼くこと**が要る —— 1 つへ繋ぐと、実際に鳴るときのチャンクの割れ目が変わる。
  it('気象庁が書いた文を、本体とは別の文として作る（正）', () => {
    const data = createTestNankai('巨大地震注意')
    const payload: ReplayPayload = { kind: 'nankai', data }
    const expected = telegramTextToSpeak({ kind: 'nankai', data }, OPTS_WITH_TELEGRAM_TEXT)?.text
    expect(expected).toBeTruthy()
    const texts = speculativeSpeechTexts(payload, OPTS_WITH_TELEGRAM_TEXT)
    expect(texts).toContain(expected)
    // 本体と繋がっていない（別の要素として並ぶ）
    expect(texts.length).toBeGreaterThan(1)
  })

  // **設定で切られているものは焼かない（対照）。** 焼いても一度も使われないので、
  // その分だけ控えを圧迫して本当に要るチャンクを追い出す。
  it('気象庁の文を読まない設定なら、その文は作らない（対照）', () => {
    const data = createTestNankai('巨大地震注意')
    const withText = speculativeSpeechTexts({ kind: 'nankai', data }, OPTS_WITH_TELEGRAM_TEXT)
    const without = speculativeSpeechTexts({ kind: 'nankai', data }, OPTS)
    expect(without.length).toBeLessThan(withText.length)
  })
})

describe('チャンクの一致', () => {
  // 控えの鍵はチャンクなので、**文が一致すれば割れ方も一致する**。ここを固定しておけば、
  // 将来チャンクの割り方を変えたときに投機と本番がずれていないことを確かめられる。
  it('投機した文を割ると、本番の文を割ったものと同じ並びになる（正）', () => {
    const data = createTestNankaiCommentary('臨時解説')
    const spec = speculativeSpeechTexts({ kind: 'nankaiCommentary', data }, OPTS)
    const real = nankaiCommentaryToText(data)
    const specChunks = spec.flatMap(t => splitIntoChunks(t))
    for (const chunk of splitIntoChunks(real)) {
      expect(specChunks).toContain(chunk)
    }
  })

  // **合成が再生に追いつかなくなるのは、この長さの文。** 本体（名乗りと要約）は短く、
  // 長いのは気象庁が書いた本文のほう ―― そしてそれは状態に依らないので、投機で完全に当たる。
  it('気象庁が書いた本文は数十チャンクになり、投機がそれを丸ごと覆う（正）', () => {
    const data = createTestNankaiCommentary('臨時解説')
    const body = telegramTextToSpeak({ kind: 'nankaiCommentary', data }, OPTS_WITH_TELEGRAM_TEXT)?.text
    expect(body).toBeTruthy()
    const bodyChunks = splitIntoChunks(body as string)
    // 1〜2 チャンクしか出ないなら、テストデータが実電文の形から外れている
    // （→ CLAUDE.md「実電文の形に合わせる」）。
    expect(bodyChunks.length).toBeGreaterThan(10)

    // その全チャンクが投機の対象に入る
    const spec = speculativeSpeechTexts({ kind: 'nankaiCommentary', data }, OPTS_WITH_TELEGRAM_TEXT)
    const specChunks = spec.flatMap(t => splitIntoChunks(t))
    for (const chunk of bodyChunks) {
      expect(specChunks).toContain(chunk)
    }
  })
})

describe('読み上げない電文', () => {
  // 地震・津波に関するお知らせは音も読み上げも起こさない運用連絡
  // （→ data-sources-spec.md §2「扱う電文種別」）。焼いても一度も使われない。
  it('お知らせ（VZSE40）からは何も作らない（対照）', () => {
    const payload: ReplayPayload = { kind: 'quakeNotice', data: createTestQuakeNotice() }
    expect(speculativeSpeechTexts(payload, OPTS)).toEqual([])
  })

  // 緊急地震速報の固定付加文は読まない（秒を争うため）。第 1 フェーズの文だけが出る。
  it('緊急地震速報：第 1 フェーズの文は作るが、固定付加文は作らない（対照）', () => {
    const event = createTestEEWWarning(true)
    const texts = speculativeSpeechTexts({ kind: 'event', event }, OPTS)
    expect(texts.length).toBe(1)
    expect(texts[0]).toContain('で地震。')
  })

  // **区分を選ばないでよい理由の固定。** 切り出し語（「緊急地震速報、」等）は 3 通りとも
  // 独立したチャンクになり、起動時の作り置きが既に焼いている。残る「〇〇で地震。」は
  // 区分に依らず同じなので、どれか 1 つで焼けば足りる。
  it('緊急地震速報：震源の句は区分に依らず同じチャンクになる（安全弁）', () => {
    const event = createTestEEWWarning(true)
    const texts = speculativeSpeechTexts({ kind: 'event', event }, OPTS)
    const chunks = splitIntoChunks(texts[0])
    // 先頭は切り出し語、その後ろが震源の句
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks[chunks.length - 1]).toMatch(/で地震。$/)
    expect(chunks[chunks.length - 1]).not.toContain('緊急地震速報')
  })
})

// 真偽 1 つで文頭が変わるものは、**両方とも焼く**。分岐に投機の精度を賭ける理由がなく、
// 外した側の損は控えの 1 件ぶんに収まる。
describe('真偽 1 つで変わる文は 2 通りとも作る', () => {
  it('長周期地震動：初報・続報の両方を作る（正）', () => {
    const data = createTestLpgm('20240101161000')
    const texts = speculativeSpeechTexts({ kind: 'lpgm', data }, OPTS)
    expect(texts).toContain(lpgmToText(data, OPTS, true))
    expect(texts).toContain(lpgmToText(data, OPTS, false))
  })

  it('推計震度分布図：初報・続報の両方を作る（正）', () => {
    const arrivalTime = '2024-01-01T16:10:00+09:00'
    const data = { arrivalTime } as unknown as JMAEstimatedIntensity
    const texts = speculativeSpeechTexts({ kind: 'estimatedIntensity', data }, OPTS)
    expect(texts).toContain(estimatedIntensityToText(arrivalTime, true))
    expect(texts).toContain(estimatedIntensityToText(arrivalTime, false))
    // 文頭が違うので 2 通りとも並ぶ（同じ文なら 1 つに畳まれてしまう）
    expect(new Set(texts).size).toBe(2)
  })
})

// 取消は本体が理由を読む（付加文は添えない）。**分岐を間違えると投機が空になる**が、
// 症状は「取消の読み上げだけ控えが当たらない」で、聞いても気づけない。
describe('取消の報', () => {
  it('地震の取消：取消の文を作る（正）', () => {
    const base = createTestEarthquake(true)
    const cancelled = { ...base, cancelled: true, cancelText: '先ほどの地震情報を取り消します。' }
    const texts = speculativeSpeechTexts({ kind: 'event', event: cancelled }, OPTS)
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.some(t => t.includes('取り消'))).toBe(true)
  })

  it('地震の発表報：取消の文は作らない（対照）', () => {
    const base = createTestEarthquake(true)
    const texts = speculativeSpeechTexts({ kind: 'event', event: base }, OPTS)
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.some(t => t.includes('取り消'))).toBe(false)
  })
})

describe('投機で再生を壊さない', () => {
  // **1 通ずつ受け止める。** ここが投げると、覗いた電文の並びごと処理が止まって
  // 以降の投機が走らなくなる。実データにしか無い形は必ずあるので、落ちても次へ進む。
  it('文を組む途中で例外が出ても、空を返して次へ進む（安全弁）', () => {
    // `data` が欠けた電文（型の上ではありえないが、実データの取り違えでは起こりうる）
    const broken = { kind: 'nankai', data: undefined } as unknown as ReplayPayload
    expect(() => speculativeSpeechTextsSafe(broken, OPTS)).not.toThrow()
    expect(speculativeSpeechTextsSafe(broken, OPTS)).toEqual([])
  })

  it('壊れていない電文なら、安全側の入口でも同じ結果を返す（対照）', () => {
    const data = createTestKohatsu()
    const payload: ReplayPayload = { kind: 'kohatsu', data }
    expect(speculativeSpeechTextsSafe(payload, OPTS)).toEqual(speculativeSpeechTexts(payload, OPTS))
  })
})
