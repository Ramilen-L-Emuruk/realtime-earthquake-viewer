// 気象庁が書いた文を、電文種別 × ブロックの単位で読むかどうか。
//
// 現状は `ttsReadTelegramText`（マスタートグル）1 つで全部まとめて切っていた。同じ「自由付加文」
// でも種別によって中身の性質が違う（地震情報は `＊` の説明が主、津波はいつ来ていつまで続くかの
// 説明、南海トラフは評価の本文）ので、種類でまとめて切ると片方を聞くためにもう片方も付いてくる。
//
// 固定するのは 3 種。
//   正  : 切ったブロックだけが本文から落ちる
//   対照: 指定しなければ従来どおり全部読む（設定を足しただけで耳に届く内容を変えない）
//   安全弁: マスタートグルが偽なら、ブロックの指定によらず何も読まない／全部切れば `null`
//           （前置きだけが鳴る形にしない）
import { describe, it, expect } from 'vitest'
import {
  telegramTextToSpeak, TELEGRAM_TEXT_BLOCK_KEYS,
  type TtsSpeechOptions, type TelegramTextBlockKey, type TelegramTextBlocks,
} from './ttsText'
import type { LiveEvent } from '../types/earthquake'

const BASE: TtsSpeechOptions = {
  intensityLevels: 2, maxRegions: 0, alwaysReadScale: -1, regionTolerance: 0, readTelegramText: true,
}

/** 指定したキーだけを切った指定を作る（残りは読む）。 */
function blocksWithout(...off: TelegramTextBlockKey[]): TelegramTextBlocks {
  return Object.fromEntries(
    TELEGRAM_TEXT_BLOCK_KEYS.map(key => [key, !off.includes(key)]),
  ) as TelegramTextBlocks
}

const allOff = Object.fromEntries(
  TELEGRAM_TEXT_BLOCK_KEYS.map(key => [key, false]),
) as TelegramTextBlocks

const quake = (): LiveEvent => ({
  kind: 'quake',
  id: 'q1',
  time: '',
  cancelled: false,
  varCommentText: '＊印は気象庁以外の震度観測点についての情報です。震源要素を訂正します。',
  freeText: '自由付加文の本文です。',
} as unknown as LiveEvent)

const nankai = (): LiveEvent => ({
  kind: 'nankai',
  data: {
    cancelled: false,
    summary: '調査を開始しました。',
    body: '本文です。',
    nextAdvisory: '次回の発表予定です。',
  },
} as unknown as LiveEvent)

const tsunami = (): LiveEvent => ({
  kind: 'tsunami',
  id: 't1',
  time: '',
  cancelled: false,
  bodyText: '津波はくり返し襲ってきます。',
  // 固定付加文は主題ごとに複数ある（鍵は電文から導く実行時の値）。**まとめて 1 つの設定で切る**
  warningComments: [
    { key: 'VTSE41', text: 'ただちに高台へ避難してください。' },
    { key: 'VTSE51|各地の満潮時刻・津波到達予想時刻に関する情報', text: '満潮時刻は次のとおりです。' },
  ],
  freeText: '津波の自由付加文です。',
} as unknown as LiveEvent)

const lpgm = (): LiveEvent => ({
  kind: 'lpgm',
  data: {
    id: 'l1', time: '', eventId: 'e1', originTime: '', maxClass: 3, cancelled: false,
    forecastText: 'この地震について、緊急地震速報を発表しています。',
    // **題材に「＊印は…」を使わない** —— あれは読み上げから落とす定型文
    // （TELEGRAM_TEXT_TEXT_SKIPPED）なので、切り分けを確かめられない
    varCommentText: '震源要素を訂正します。',
    freeFormText: '階級４ 極めて大きな揺れ',
  },
} as unknown as LiveEvent)

const kohatsu = (): LiveEvent => ({
  kind: 'kohatsu',
  data: {
    cancelled: false,
    summary: '後発地震の要約です。',
    body: '後発地震の本文です。',
    nextAdvisory: '後発地震の次回発表予定です。',
  },
} as unknown as LiveEvent)

const earthquakeCount = (): LiveEvent => ({
  kind: 'earthquakeCount',
  data: { cancelled: false, freeText: '地震回数の補足です。' },
} as unknown as LiveEvent)

const nankaiCommentary = (): LiveEvent => ({
  kind: 'nankaiCommentary',
  data: {
    cancelled: false,
    summary: '解説の要約です。',
    body: '解説の本文です。',
    nextAdvisory: '解説の次回発表予定です。',
  },
} as unknown as LiveEvent)

describe('気象庁が書いた文をブロックごとに選ぶ', () => {
  // 対照: 指定しなければ全部読む。**設定を足しただけで、これまで声になっていた文が消えない**
  it('指定が無ければ全ブロックを読む', () => {
    expect(telegramTextToSpeak(nankai(), BASE)?.body)
      .toBe('調査を開始しました。本文です。次回の発表予定です。')
  })

  // 正: 切ったブロックだけが落ちる
  it('要約だけを切ると、本文と次回発表予定が残る', () => {
    const speech = telegramTextToSpeak(nankai(), { ...BASE, telegramTextBlocks: blocksWithout('nankaiSummary') })
    expect(speech?.body).toBe('本文です。次回の発表予定です。')
  })

  it('本文と次回発表予定を切ると、要約だけが残る', () => {
    const speech = telegramTextToSpeak(nankai(), {
      ...BASE,
      telegramTextBlocks: blocksWithout('nankaiBody', 'nankaiNextAdvisory'),
    })
    expect(speech?.body).toBe('調査を開始しました。')
  })

  // 正: 種別が違えば別の設定。臨時情報を切っても関連解説情報は残る
  it('臨時情報を切っても、関連解説情報は読む', () => {
    const opts = {
      ...BASE,
      telegramTextBlocks: blocksWithout('nankaiSummary', 'nankaiBody', 'nankaiNextAdvisory'),
    }
    expect(telegramTextToSpeak(nankai(), opts)).toBeNull()
    expect(telegramTextToSpeak(nankaiCommentary(), opts)?.body)
      .toBe('解説の要約です。解説の本文です。解説の次回発表予定です。')
  })

  // 正: 地震情報は 2 ブロック。固定付加文だけを切る形が実用の主眼
  // （`＊` の説明は震度を伝える電文のほぼ全てに入るため）
  it('地震情報の固定付加文だけを切ると、自由付加文が残る', () => {
    const speech = telegramTextToSpeak(quake(), { ...BASE, telegramTextBlocks: blocksWithout('quakeVarComment') })
    expect(speech?.body).toBe('自由付加文の本文です。')
  })

  // 安全弁: 全部切れば `null`。前置き（「地震情報について、気象庁の文をお伝えします。」）だけが
  // 鳴る形にしない
  it('全ブロックを切ると何も返さない（前置きだけを鳴らさない）', () => {
    for (const event of [quake(), tsunami(), lpgm(), nankai(), nankaiCommentary(), kohatsu(), earthquakeCount()]) {
      expect(telegramTextToSpeak(event, { ...BASE, telegramTextBlocks: allOff })).toBeNull()
    }
  })

  // 安全弁: マスタートグルが偽なら、ブロックを全部入れても読まない
  it('マスタートグルが偽なら、ブロックの指定によらず読まない', () => {
    const allOn = Object.fromEntries(
      TELEGRAM_TEXT_BLOCK_KEYS.map(key => [key, true]),
    ) as TelegramTextBlocks
    expect(telegramTextToSpeak(nankai(), { ...BASE, readTelegramText: false, telegramTextBlocks: allOn }))
      .toBeNull()
  })

  // 正: **津波の分岐だけ構造が違う**（固定付加文は配列で、`pick` ではなく三項で落とす）ので
  // 個別に確かめる。主題ごとに分けず 1 つの設定でまとめて切るのが意図した挙動
  it('津波の固定付加文は、主題によらずまとめて落ちる', () => {
    const speech = telegramTextToSpeak(tsunami(), {
      ...BASE, telegramTextBlocks: blocksWithout('tsunamiVarComment'),
    })
    expect(speech?.body).toBe('津波はくり返し襲ってきます。津波の自由付加文です。')
    expect(speech?.body).not.toContain('避難')
    expect(speech?.body).not.toContain('満潮')
  })

  it('津波の本文だけを切ると、固定付加文と自由付加文が残る', () => {
    const speech = telegramTextToSpeak(tsunami(), { ...BASE, telegramTextBlocks: blocksWithout('tsunamiBody') })
    expect(speech?.body)
      .toBe('ただちに高台へ避難してください。満潮時刻は次のとおりです。津波の自由付加文です。')
  })

  // 正: 長周期は 3 ブロック。固定付加文が 2 種類あるので、切り分けられることを見る
  it('長周期地震動観測情報のブロックを 1 つずつ切り分けられる', () => {
    const only = (...off: Parameters<typeof blocksWithout>) =>
      telegramTextToSpeak(lpgm(), { ...BASE, telegramTextBlocks: blocksWithout(...off) })?.body
    expect(only('lpgmForecast')).toBe('震源要素を訂正します。階級４ 極めて大きな揺れ。')
    expect(only('lpgmVarComment')).toBe('この地震について、緊急地震速報を発表しています。階級４ 極めて大きな揺れ。')
    expect(only('lpgmFreeText'))
      .toBe('この地震について、緊急地震速報を発表しています。震源要素を訂正します。')
  })

  // 正: 後発地震注意情報（南海トラフ系と同じ構造だが、設定は別）
  it('後発地震注意情報の本文だけを切れる', () => {
    const speech = telegramTextToSpeak(kohatsu(), { ...BASE, telegramTextBlocks: blocksWithout('kohatsuBody') })
    expect(speech?.body).toBe('後発地震の要約です。後発地震の次回発表予定です。')
  })

  // 正: 地震回数は 1 ブロックしかないので、切れば `null`
  it('地震回数に関する情報を切ると何も返さない', () => {
    expect(telegramTextToSpeak(earthquakeCount(), BASE)?.body).toBe('地震回数の補足です。')
    expect(telegramTextToSpeak(earthquakeCount(), {
      ...BASE, telegramTextBlocks: blocksWithout('earthquakeCountFreeText'),
    })).toBeNull()
  })

  // 安全弁: 既読の鍵（`body`）は読んだ本文そのもの。ブロックを切れば鍵も変わる
  // （＝読み直しへ倒れる。設定を触った直後に「読んでいないのに既読」にならない）
  it('ブロックを切ると既読の鍵も変わる', () => {
    const full = telegramTextToSpeak(nankai(), BASE)?.body
    const partial = telegramTextToSpeak(nankai(), {
      ...BASE, telegramTextBlocks: blocksWithout('nankaiSummary'),
    })?.body
    expect(full).not.toBe(partial)
  })
})

// 気象庁が書いた文の日時表記は**全角でゼロ埋め**されている（実電文で `００時` 48 件・`０１時`
// 43 件・`００分` 19 件。ローカル履歴アーカイブ 4 本）。合成エンジンは先頭の 0 を桁として読むため、
// そのままでは `０１時` が「ぜろ いちじ」、`００分` が「ぜろ ぜろふん」になる。読む前に半角・
// ゼロ埋めなしへ揃えておくと、句区切り辞書は半角の形（`17日`・`0時`）だけを持てば済む。
describe('気象庁が書いた文の日時表記を揃える', () => {
  const speak = (freeText: string) =>
    telegramTextToSpeak({ ...quake(), freeText } as LiveEvent, BASE)?.body ?? ''

  // 正: 全角を半角にし、先頭の 0 を落とす
  it('全角の日時を半角にし、ゼロ埋めを外す', () => {
    expect(speak('１６日０１時２５分ころ、地震がありました。')).toContain('16日1時25分ころ')
    expect(speak('１５日００時０３分ころ、地震がありました。')).toContain('15日0時3分ころ')
    // 「1日」は読みへ直す。**この経路（本文と付加文）にも掛ける** —— 同じ「気象庁が書いた文」
    // なのに、読まれる場所によって「ついたち」と「いちにち」に分かれてはいけない
    expect(speak('０１日０９時０８分ころ、地震がありました。')).toContain('ついたち9時8分ころ')
    // 対照: 「N時」が続かない形は日付と決めつけない（頻度・期間の用法を巻き込まない）
    expect(speak('1日2回程度の余震があります。')).toContain('1日2回')
    expect(speak('今後1日程度は注意してください。')).toContain('1日程度')
  })

  // 対照: 日・時・分以外の数値には触らない。マグニチュードや震度を半角へ直す意図はない
  it('マグニチュード・震度・波高の数値は変えない', () => {
    expect(speak('マグニチュード７．６、最大震度５強、津波の高さ１０ｍを観測しました。'))
      .toContain('マグニチュード７．６、最大震度５強、津波の高さ１０ｍ')
  })

  // 安全弁: 3 桁以上の数字には触らない。`{1,2}` だけだと末尾 2 桁を拾って桁を静かに落とす
  // （`１５０分後` → `１50分後`、`1000分の1` → `100分の1`。半角でも起きる）
  it('3 桁以上の数字は桁を落とさない', () => {
    expect(speak('地震発生から１５０分後に余震がありました。')).toContain('１５０分後')
    expect(speak('１００日以内に発生する確率です。')).toContain('１００日以内')
    expect(speak('1000分の1程度の確率です。')).toContain('1000分の1')
  })

  // 安全弁: 単位が続く形も一致するが、半角へ直すだけで語は壊さない
  it('「2時間」「10分の1」「2日間」は語を保つ', () => {
    expect(speak('２時間後、１０分の１程度、２日間にわたり注意してください。'))
      .toContain('2時間後、10分の１程度、2日間にわたり')
  })
})
