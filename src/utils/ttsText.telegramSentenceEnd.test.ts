// 気象庁が書いた文を読み上げへ差し込む 5 箇所で、末尾の句点の扱いが揃っていることを固定する。
//
// **気象庁は見出し文が句点で終わることを保証していない。** 控えにある 5 日分の電文では、
// 見出し文 505 件のうち 29 件が句点以外で終わっていた（緊急地震速報 27・地震・津波に関する
// お知らせ 1・長周期地震動観測情報 1。「…石川西方沖で地震　北陸で強い揺れ」のように体言で切る）。
// **そのどれも読み上げで見出し文を使わない種別**なので、いま声になる経路では観測できていない
// —— ここで固定するのは「壊れている形」ではなく「壊れうる形への手当て」。
//
// 直す前は 3 通りに分かれていた（→ docs/spec/tts-sentence-inventory.md §4-8）。
//   条件付きで足す … 取消の理由
//   何もしない     … 遠地地震の付加文・津波観測情報の見出し文・各地の満潮時刻の見出し文
//   無条件に足す   … 後発地震注意情報の見出し文（句点で終わる文を「。。」にする）
//
// 正・対照・安全弁の分担:
//   正   ＝ 5 箇所とも、句点で終わらない文には句点が足る
//   対照 ＝ 5 箇所とも、句点で終わる文には重ねない
//   安全弁＝ 足す側と、下流の 2 つの「割る側」が同じ記号を文末とみなす／式が書き写されていない
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  earthquakeCancelToText, earthquakeToText, tsunamiObservationUpdateToText,
  tsunamiTideToSegments, kohatsuToText, splitTelegramTextUnits, type TtsSpeechOptions,
} from './ttsText'
import { splitIntoChunks } from './voicevox'
import { joinSegments } from './ttsFollow'
import { createTestKohatsu } from './testData'
import type { JMAQuake, TsunamiObservation } from '../types/earthquake'

const TTS_OPTS: TtsSpeechOptions = { intensityLevels: 0, maxRegions: 0, alwaysReadScale: -1, regionTolerance: 0 }

/** 遠地地震（`forecastText` が本文の主体になる唯一の種別）。 */
function distantQuake(forecastText: string): JMAQuake {
  return {
    kind: 'quake',
    id: 'dmdata-quake-20260717234900-1',
    time: '2026-07-17T23:52:00+09:00',
    issue: { source: '気象庁', time: '2026-07-17T23:52:00+09:00', type: '遠地地震', correct: 'なし' },
    earthquake: {
      time: '2026-07-17T23:49:00+09:00',
      hypocenter: { name: 'メキシコ、チアパス州沿岸', latitude: 14.4, longitude: -93.0, depth: -1, magnitude: 7.4 },
      maxScale: -1,
      domesticTsunami: 'なし',
    },
    points: [],
    forecastText,
  }
}

const OBSERVATION: TsunamiObservation = {
  name: '宮古', districtCode: '210', districtName: '岩手県',
  height: { value: 1.2, description: '1.2m' },
}

/**
 * 電文の文を 1 つ受け取り、それを含む読み上げ文を返す 5 箇所。
 *
 * **公開関数から通すこと。** 述語を直に呼ぶと「述語は正しいが呼び出し側が通していない」
 * 形を見逃す —— 直す前の 4 箇所がまさにその状態だった。
 */
const PLACES: ReadonlyArray<readonly [string, (text: string) => string]> = [
  ['取消の理由', (t) => earthquakeCancelToText('2026-01-01T12:00:00+09:00', t)],
  ['遠地地震の付加文', (t) => earthquakeToText(distantQuake(t), TTS_OPTS, true)],
  ['津波観測情報の見出し文', (t) => tsunamiObservationUpdateToText([OBSERVATION], t)],
  ['各地の満潮時刻の見出し文', (t) => joinSegments(tsunamiTideToSegments('tide', t))],
  ['後発地震注意情報の見出し文', (t) => kohatsuToText({ ...createTestKohatsu(), headline: t })],
]

// 取消の宣言の形（「先ほどの、〇〇を取り消します。」）にすると、読み上げを省く判定に掛かって
// 文ごと消える。どの箇所でもそのまま声になる文を選ぶ。
const BODY = 'この地震による日本への津波の影響はありません'

describe('気象庁が書いた文の末尾の句点', () => {
  it.each(PLACES)('%s: 句点で終わらない文には足す（正）', (_label, produce) => {
    expect(produce(BODY)).toContain(`${BODY}。`)
  })

  it.each(PLACES)('%s: 句点で終わる文には重ねない（対照）', (_label, produce) => {
    const text = produce(`${BODY}。`)
    expect(text).toContain(`${BODY}。`)
    expect(text).not.toContain('。。')
  })

  // **断片列へ分けても逃げられない。** `joinSegments` が区切り文字なしで 1 本へ潰してから
  // チャンクへ割るので、句点が落ちれば 5 箇所とも同じように
  // 「…お知らせします満潮時刻が更新されました。」という 1 文になる。ここはその代表。
  it('各地の満潮時刻: 見出し文と続く文が句点で分かれる', () => {
    const text = joinSegments(tsunamiTideToSegments('tide', '各地の満潮時刻をお知らせします'))
    expect(text).toBe('各地の満潮時刻をお知らせします。満潮時刻が更新されました。')
  })
})

// 足す側が「もう終わっている」と判断した記号は、**下流の 2 つの「割る側」も同じ判断をして
// いなければならない**。揃っていないと次の 2 つが起きる。
//
//   - チャンクを割る側（`splitIntoChunks`）が見ない記号だと、**入れようとした 0.355 秒の間が
//     そのまま消える** —— 直そうとした症状に戻る
//   - 既読の単位へ割る側（`splitTelegramTextUnits`）が見ない記号だと、2 つのブロックが 1 つの
//     既読単位へ融合し、片方だけ変わった続報で**既に読んだ分まで読み直す**
//
// **この describe が守るのは 3 者の整合性だけ。** `ttsPunctuation.ts` が 3 つとも
// `SENTENCE_END` から導出するようになったので、**集合へ記号を足す変化はここでは落ちない**
// （3 者が揃ったまま動くため）。中身の妥当性は次の describe が受け持つ。
describe('【安全弁】足す側と、下流の 2 つの「割る側」が揃っている', () => {
  // 5 文字未満のチャンクは次と結合されるので（`splitIntoChunks` の `MIN_CHUNK`）、
  // 前半はそれより長くする。短い文で測ると「割れなかった」と区別が付かない。
  const HEAD = 'まえのぶんしょう'
  const TAIL = 'つぎのぶんしょう'

  it.each(['。', '．', '！', '？', '、'])('「%s」の扱いが 3 者で揃っている', (ch) => {
    // 足す側は公開関数から通す（`endTelegramSentence` は export していない）。
    // 句点を足していない ＝ その記号を文末とみなした、ということ。
    const spoken = earthquakeCancelToText('2026-01-01T12:00:00+09:00', `${HEAD}${ch}`)
    const endsSentence = !spoken.includes(`${HEAD}${ch}。`)

    expect(splitTelegramTextUnits(`${HEAD}${ch}${TAIL}`).length > 1,
      `「${ch}」: 既読の単位へ割る側と食い違う`).toBe(endsSentence)
    if (endsSentence) {
      expect(splitIntoChunks(`${HEAD}${ch}${TAIL}`).length,
        `「${ch}」: チャンクが割れず、入れたはずの間が消える`).toBeGreaterThan(1)
    }
  })
})

// 3 者の整合性が保たれていても、**集合の中身が間違っていれば別の壊れ方をする**。
// `．`（全角ピリオド）を足すと 3 者は揃ったまま動くが、今度は `Ｍ７．１` のような数値表記が
// 文の切れ目になり、既読の単位が数値の途中で割れ、合成も「Ｍ７．」「１」と分けて読む。
describe('【安全弁】数値表記を文の切れ目にしない', () => {
  const TEXT = 'マグニチュードＭ７．１の地震が発生しました。'

  it('全角ピリオドで既読の単位が割れない', () => {
    expect(splitTelegramTextUnits(TEXT).map(u => u.key)).toEqual([TEXT])
  })

  it('全角ピリオドでチャンクが割れない', () => {
    expect(splitIntoChunks(TEXT)).toEqual([TEXT])
  })
})

describe('【安全弁】述語と前処理の式を書き写していない', () => {
  const source = readFileSync(new URL('./ttsText.ts', import.meta.url), 'utf8')

  // 文末の記号を正規表現リテラルへ書き写していない（`SENTENCE_END` から組む）。
  // 書き写すと、上の 3 者の揃いが静かに崩れる。
  it('文末判定を正規表現リテラルで書いていない', () => {
    const found = source.match(/\[[^\]]*。[^\]]*\]\$\//g) ?? []
    expect(found, '文末の判定は SENTENCE_END から組む').toHaveLength(0)
  })

  // 見出し文の前処理（半角化 → 日時の読み直し）は `speakableHeadline` の 1 つだけ。
  // かつてこの式が 2 箇所に並んでおり、**どちらにも句点の手当てが入っていなかった**。
  it('見出し文の前処理の式は 1 つだけ', () => {
    const found = source.match(/normalizeDateTimeForSpeech\(tsunamiHeightToSpeech\(/g) ?? []
    expect(found, '見出し文の前処理は speakableHeadline に集約する').toHaveLength(1)
  })
})
