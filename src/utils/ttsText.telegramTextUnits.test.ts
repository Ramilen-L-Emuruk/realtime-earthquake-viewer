// 気象庁が書いた文を「既読と照合する単位（文）」へ割る処理のテスト。
//
// ここで固定するのは 3 つ ——
//
// 1. **繋ぎ直すと元の本文に戻ること。** 未読の文だけを読むとき、残った単位を連結して
//    読み上げ文を組む。空白や句点が落ちると合成エンジンが置く間が変わる
//    （→ audio-tts-spec.md §3「分割で落ちた句読点・空白を戻す」）。
// 2. **鍵に前後の空白を含めないこと。** 含めると同じ文が位置によって別物になり、既読が効かない。
// 3. **句点で終わらない本文も 1 単位として出ること。** 落とすとその文が永久に既読にならず、
//    報のたびに読み直される。
import { describe, it, expect } from 'vitest'
import { splitTelegramTextUnits } from './ttsText'

/**
 * 題材は能登半島地震（2024-01-01）の津波の固定付加文から。
 * **本文は `normalizeTelegramTextForSpeech` を通した後の形**（電文の改行が空白になっている）
 * なので、テストも空白で繋いだ形を渡す。
 */
const TSUNAMI_COMMENT = '津波による潮位変化が観測されてから最大波が観測されるまでに数時間以上かかることがあります。 場所によっては、観測した津波の高さよりさらに大きな津波が到達しているおそれがあります。 今後、津波の高さは更に高くなることも考えられます。'

describe('気象庁が書いた文を文単位へ割る', () => {
  // 正: 句点ごとに割れる。
  it('句点で割る', () => {
    const units = splitTelegramTextUnits(TSUNAMI_COMMENT)
    expect(units).toHaveLength(3)
    expect(units[0].key).toBe('津波による潮位変化が観測されてから最大波が観測されるまでに数時間以上かかることがあります。')
    expect(units[2].key).toBe('今後、津波の高さは更に高くなることも考えられます。')
  })

  // 対照: 繋ぎ直すと元に戻る（空白も句点も落ちない）。
  it('すべて繋ぐと元の本文に戻る', () => {
    for (const body of [
      TSUNAMI_COMMENT,
      '津波と満潮が重なると、津波はより高くなりますので一層厳重な警戒が必要です。',
      '＜大津波警報＞ 大きな津波が襲い甚大な被害が発生します。 沿岸部や川沿いにいる人はただちに高台や避難ビルなど安全な場所へ避難してください。',
      '階級１ やや大きな揺れ 階級２ 大きな揺れ！ 終わり？ 続き',
    ]) {
      expect(splitTelegramTextUnits(body).map(u => u.text).join('')).toBe(body)
    }
  })

  // 対照: 鍵は前後の空白を持たない（読み上げの素材は持つ）。
  it('鍵は前後の空白を落とし、読み上げの素材は空白を保つ', () => {
    const units = splitTelegramTextUnits('あ。 い。')
    expect(units.map(u => u.key)).toEqual(['あ。', 'い。'])
    expect(units.map(u => u.text)).toEqual(['あ。 ', 'い。'])
  })

  // 安全弁: 句点で終わらない本文・感嘆符・疑問符でも単位が失われない。
  it('句点で終わらない本文も単位として残す', () => {
    expect(splitTelegramTextUnits('句点のない文').map(u => u.key)).toEqual(['句点のない文'])
    expect(splitTelegramTextUnits('終わり。続き').map(u => u.key)).toEqual(['終わり。', '続き'])
    expect(splitTelegramTextUnits('本当ですか？ はい！').map(u => u.key)).toEqual(['本当ですか？', 'はい！'])
  })

  // 安全弁: 空・空白だけの本文で空の単位を作らない（既読へ空文字を入れると全報が既読になる）。
  it('空白だけの本文では単位を作らない', () => {
    expect(splitTelegramTextUnits('')).toEqual([])
    expect(splitTelegramTextUnits('   ')).toEqual([])
  })
})
