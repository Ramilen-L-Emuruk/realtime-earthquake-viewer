// 気象庁が書いた文のうち、事象によらずほぼ同じ定型文を「文の単位」で読み上げから落とす指定。
//
// ブロック単位（`ttsText.telegramTextBlocks.test.ts`）は付加文の枠ごと切るので、その枠にだけ
// 入る非定型の告知まで一緒に消える。実配信で文面を確かめられた例が 2 つあり（震源・震度情報の
// 自由付加文に入った震度速報の訂正、震源要素更新の自由付加文に足された精査後のマグニチュード）、
// 文で落とせば定型のあとに足された分だけが声になる。
//
// 固定するのは 3 種。
//   正  : 既定で 4 項目とも落ちる（文面は実配信の電文から採ったもの）
//   対照: 読む側にすれば読まれる／定型のあとに足された文は落とさない
//   安全弁: 落とした結果が空なら読み上げごと起きない／落とし漏れをコードで検出する
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  telegramTextToSpeak, warnUnmatchedBoilerplate,
  TELEGRAM_BOILERPLATE_KEYS, TELEGRAM_BOILERPLATE_DEFAULT_READS,
  type TtsSpeechOptions, type TelegramBoilerplateReads,
} from './ttsText'
import type { LiveEvent } from '../types/earthquake'
import { log } from './logger'
// **トップレベルで読む。** `testData` は実電文由来の JSON を静的に取り込むので、テスト本体の
// 中で初めて読むとその待ちが 1 件目の所要時間へ丸ごと乗る（→ CLAUDE.md「検証」）。
import { createTestEarthquake, createTestLpgm, createTestTsunami } from './testData'

const BASE: TtsSpeechOptions = {
  intensityLevels: 2, maxRegions: 0, alwaysReadScale: -1, regionTolerance: 0, readTelegramText: true,
}

/** 全項目を読む指定（落とさない）。 */
const allRead = Object.fromEntries(
  TELEGRAM_BOILERPLATE_KEYS.map(key => [key, true]),
) as TelegramBoilerplateReads

// ── 以下の文面はすべて実配信の電文から採ったもの（推測で書いた文面を置かない）。

/**
 * 長周期地震動観測情報の自由付加文（2024-01-01 能登半島地震の本震・VXSE62）。
 * **行頭の空白と URL もそのまま**にしてある —— 落とす判定が原文の形で効くことを見るため。
 */
const LPGM_CLASS_TABLE = [
  '各長周期地震動階級に対する簡易な現象表現',
  ' 階級１やや大きな揺れ',
  ' 階級２大きな揺れ',
  ' 階級３非常に大きな揺れ',
  ' 階級４極めて大きな揺れ',
  '波形、スペクトル等、本地震の長周期地震動に関する詳細な情報は気象庁の長周期地震動に関する観測情報のウェブサイト'
    + ' ( https://www.data.jma.go.jp/eew/data/ltpgm/event.php?eventId=20240101160608 ) もあわせてご活用ください。',
].join('\n')

/**
 * 津波警報等（VTSE41）の自由付加文。**波高と被害説明のあいだは全角スペースで桁を揃えてあり、
 * 数も行によって違う** —— 空白の数に依存しないことを見るため実電文どおりに置く。
 */
const TSUNAMI_HEIGHT_LEGEND = [
  '［予想される津波の高さの解説］',
  '予想される津波が高いほど、より甚大な被害が生じます。',
  '１０ｍ超　　巨大な津波が襲い壊滅的な被害が生じる。木造家屋が全壊・流失し、人は津波による流れに巻き込まれる。',
  '１０ｍ　　　巨大な津波が襲い甚大な被害が生じる。木造家屋が全壊・流失し、人は津波による流れに巻き込まれる。',
  '　５ｍ　　　津波が襲い甚大な被害が生じる。木造家屋が全壊・流失し、人は津波による流れに巻き込まれる。',
  '　３ｍ　　　標高の低いところでは津波が襲い被害が生じる。木造家屋で浸水被害が発生し、人は津波による流れに巻き込まれる。',
  '　１ｍ　　　海の中では人は速い流れに巻き込まれる。養殖いかだが流失し小型船舶が転覆する。',
].join('\n')

/** 固定付加文（その他）の文面。**種別で違う**（地震情報 0262 / 長周期 0263）。 */
const STAR_NOTE_QUAKE = '＊印は気象庁以外の震度観測点についての情報です。'
const STAR_NOTE_LPGM = '＊印は気象庁以外の長周期地震動観測点についての情報です。'
/** 固定付加文（0241）。同じ文面が地震情報にも入る。 */
const EEW_ISSUED = 'この地震について、緊急地震速報を発表しています。'

const quake = (over: Partial<Record<string, unknown>>): LiveEvent => ({
  kind: 'quake', id: 'q1', time: '', cancelled: false, ...over,
} as unknown as LiveEvent)

const lpgm = (over: Partial<Record<string, unknown>>): LiveEvent => ({
  kind: 'lpgm',
  data: {
    id: 'l1', time: '', eventId: 'e1', originTime: '', maxClass: 3, cancelled: false, ...over,
  },
} as unknown as LiveEvent)

const tsunami = (over: Partial<Record<string, unknown>>): LiveEvent => ({
  kind: 'tsunami', id: 't1', time: '', cancelled: false, ...over,
} as unknown as LiveEvent)

describe('気象庁が書いた文の定型文を落とす', () => {
  // ── 正: 既定（落とす側）で 4 項目とも声にならない

  it('長周期地震動観測情報の定型文だけの報は、読み上げごと起きない', () => {
    // 実配信の長周期は固定付加文（0241）と自由付加文（階級の目安表）を持ち、**それ以外の文を
    // 持たない報がほとんど**。両方落ちれば読む中身が無くなる。
    const speech = telegramTextToSpeak(
      lpgm({ forecastText: EEW_ISSUED, freeFormText: LPGM_CLASS_TABLE }),
      BASE,
    )
    expect(speech).toBeNull()
  })

  it('長周期の＊印の説明が落ちる（文面が種別で違うことを取りこぼさない）', () => {
    // **以前は地震情報の文面（0262）だけを落としていた。** 長周期は「長周期地震動観測点」と
    // 書くため、この報だけ説明が声になっていた。
    expect(telegramTextToSpeak(lpgm({ varCommentText: STAR_NOTE_LPGM }), BASE)).toBeNull()
  })

  it('地震情報の＊印の説明が落ちる（この設定より前からの挙動）', () => {
    expect(telegramTextToSpeak(quake({ varCommentText: STAR_NOTE_QUAKE }), BASE)).toBeNull()
  })

  it('津波の「予想される津波の高さの解説」が落ちる', () => {
    expect(telegramTextToSpeak(tsunami({ freeText: TSUNAMI_HEIGHT_LEGEND }), BASE)).toBeNull()
  })

  // ── 対照: 読む側にすれば読まれる／足された文は落とさない

  it('読む側にすれば、落としていた定型文が声になる', () => {
    const speech = telegramTextToSpeak(
      lpgm({ forecastText: EEW_ISSUED, freeFormText: LPGM_CLASS_TABLE }),
      { ...BASE, telegramBoilerplate: allRead },
    )
    expect(speech?.body).toContain('緊急地震速報を発表しています')
    expect(speech?.body).toContain('各長周期地震動階級に対する簡易な現象表現')
    // 読む側でも URL は落ちる（音声で書き取れないため。§3「読む前に整える」）
    expect(speech?.body).not.toContain('https://')
  })

  it('津波の高さの解説も、読む側にすれば声になる', () => {
    const speech = telegramTextToSpeak(
      tsunami({ freeText: TSUNAMI_HEIGHT_LEGEND }),
      { ...BASE, telegramBoilerplate: allRead },
    )
    expect(speech?.body).toContain('予想される津波の高さの解説')
  })

  it('定型文と同じ枠に入った別の文は落とさない', () => {
    // 実電文にこの形がある（`Code="0256 0262"`・1 つの Text 要素へ改行区切りで 2 文）。
    // 訂正の告知を落とすと、気象庁が伝えている事実が声から消える。
    const speech = telegramTextToSpeak(
      quake({ varCommentText: `震源要素を訂正します。\n${STAR_NOTE_QUAKE}` }),
      BASE,
    )
    expect(speech?.body).toContain('震源要素を訂正します。')
    expect(speech?.body).not.toContain('＊印は')
  })

  it('地震情報の自由付加文（訂正の告知）は落とさない', () => {
    // 自由付加文には定型に見えて事象ごとに違う告知が入る。**この形が落ちてはいけない。**
    const speech = telegramTextToSpeak(
      quake({ freeText: '23時05分に震度７の震度速報を発表しましたが、最大震度３の誤りでした。' }),
      BASE,
    )
    expect(speech?.body).toContain('の誤りでした。')
  })

  // ── 安全弁

  it('落とした結果が空でも、前置きだけが鳴る形にはならない', () => {
    const speech = telegramTextToSpeak(lpgm({ freeFormText: LPGM_CLASS_TABLE }), BASE)
    expect(speech).toBeNull()
  })

  it('既定は 4 項目とも落とす側', () => {
    // 既定を読む側へ倒すと、この設定より前から落ちていた＊印の説明が鳴り出す（逆向きの破壊）。
    for (const key of TELEGRAM_BOILERPLATE_KEYS) {
      expect(TELEGRAM_BOILERPLATE_DEFAULT_READS[key]).toBe(false)
    }
  })

  it('指定を省略したときも落とす（既定と同じ扱い）', () => {
    expect(telegramTextToSpeak(quake({ varCommentText: STAR_NOTE_QUAKE }), BASE)).toBeNull()
    expect(
      telegramTextToSpeak(quake({ varCommentText: STAR_NOTE_QUAKE }), {
        ...BASE, telegramBoilerplate: TELEGRAM_BOILERPLATE_DEFAULT_READS,
      }),
    ).toBeNull()
  })
})

describe('落とし漏れの検出', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('コードが付いているのに文面が一致しなければ記録する', () => {
    // 文面が一字変われば落ちなくなる。症状は「読まれるようになる」だけで異常として現れない
    // ので、記録が無いと気づく手掛かりがどこにもない（＊印の説明で実際にそうなっていた）。
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    warnUnmatchedBoilerplate(
      ['0263'],
      '＊印は気象庁以外の長周期地震動観測点についての情報です！',
      TELEGRAM_BOILERPLATE_DEFAULT_READS,
      '長周期地震動観測情報の固定付加文（その他）',
    )
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('0263')
  })

  it('文面が一致していれば記録しない', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    warnUnmatchedBoilerplate(
      ['0262'], STAR_NOTE_QUAKE, TELEGRAM_BOILERPLATE_DEFAULT_READS, '地震情報の固定付加文（その他）',
    )
    expect(warn).not.toHaveBeenCalled()
  })

  it('読む側にしている項目では記録しない', () => {
    // 落とさない設定なら、一致しなくても困らない。
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    warnUnmatchedBoilerplate(['0262'], '文面が変わりました。', allRead, '地震情報の固定付加文（その他）')
    expect(warn).not.toHaveBeenCalled()
  })

  it('コードを持たない経路では記録しない', () => {
    // P2PQuake は付加文を配信しない。自由付加文はコードそのものを持たない。
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    warnUnmatchedBoilerplate(undefined, '何かの文', TELEGRAM_BOILERPLATE_DEFAULT_READS, '地震情報の固定付加文（その他）')
    warnUnmatchedBoilerplate([], '何かの文', TELEGRAM_BOILERPLATE_DEFAULT_READS, '地震情報の固定付加文（その他）')
    expect(warn).not.toHaveBeenCalled()
  })
})

// テストボタンのデータが、落とす対象と一致していること。
//
// **テストボタンは実機で確かめる唯一の入口**（→ CLAUDE.md「テストボタンは実機確認の唯一の入口」）。
// 文面が近似・短縮版へ戻ると、既定で落ちるはずの文がテストボタンでだけ声になり、**実機では
// 一度も「落ちた状態」を見られない**。実際に津波のデータが短縮版のまま残っていた。
describe('テストボタンのデータで落ちる', () => {
  it('津波テストの自由付加文は「高さの目安」として落ちる', () => {
    const t = createTestTsunami(true)
    expect(telegramTextToSpeak(tsunami({ freeText: t.freeText }), BASE)).toBeNull()
  })

  it('地震テストの固定付加文（その他）から＊印の説明が落ちる', () => {
    // このデータは同じ枠に「震源要素を訂正します。」も持つ（実電文の `Code="0256 0262"` の形）。
    // **そちらは残る**ので、落ちるのは＊印の説明だけ。
    const q = createTestEarthquake(true)
    const speech = telegramTextToSpeak(quake({ varCommentText: q.varCommentText }), BASE)
    expect(speech?.body ?? '').not.toContain('＊印は')
    expect(speech?.body ?? '').toContain('震源要素を訂正します。')
  })

  it('長周期テストの付加文は 2 項目とも落ち、読み上げごと起きない', () => {
    const l = createTestLpgm('test-event')
    const speech = telegramTextToSpeak(lpgm({
      forecastText: l.forecastText,
      varCommentText: l.varCommentText,
      freeFormText: l.freeFormText,
    }), BASE)
    expect(speech).toBeNull()
  })
})
