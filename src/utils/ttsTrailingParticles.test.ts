// 辞書キーの直後に続く助詞の列挙と切り出しのテスト。
//
// 切り出した助詞は読みを辞書の値へ足して同じアクセント句に入れる（`voicevox.ts` の
// `buildAccentPhrases`）。ここで固めるのは「どこまでを助詞と見るか」「読みが表記どおりでない
// もの」、そして**このモジュールが外部依存を持たないこと**（検証スクリプトが Node から
// 読めなくなるため）。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { leadingParticle } from './ttsTrailingParticles'

describe('辞書キーの直後の助詞', () => {
  it('読み上げ文に現れる形を切り出せる', () => {
    expect(leadingParticle('で到達を確認しました。')).toEqual({ surface: 'で', kana: 'デ' })
    expect(leadingParticle('では、震度5弱以上と推定されますが、未入電です。'))
      .toEqual({ surface: 'では', kana: 'デワ' })
    expect(leadingParticle('は欠測となっています。')).toEqual({ surface: 'は', kana: 'ワ' })
  })

  it('長い助詞を先に当てる（「では」を「で」で切らない）', () => {
    // 「で」で切ると残った「は」が独立したアクセント句になり、取り込んだ意味が半分になる
    expect(leadingParticle('では、')?.surface).toBe('では')
    // 同じく「に」で切らない（津波の「〇〇にも津波予報が発表されています。」）
    expect(leadingParticle('にも津波予報が発表されています。')?.surface).toBe('にも')
  })

  it('表記をカタカナにするだけでは作れない読みを持つ', () => {
    // 係助詞の「は」と目的格の「を」は、表記をカタカナにするだけでは作れない
    expect(leadingParticle('は')?.kana).toBe('ワ')
    expect(leadingParticle('を')?.kana).toBe('オ')
  })

  it('【対照】助詞でなければ切り出さない', () => {
    // 漢字・数字・区切り文字が直に続く形。取り込まず、辞書境界の間を置く側へ倒れる
    expect(leadingParticle('町で震度3を観測しました。')).toBeNull()
    expect(leadingParticle('3.2メートル以上を観測しました。')).toBeNull()
    expect(leadingParticle('、富山県で3メートル。')).toBeNull()
    expect(leadingParticle('')).toBeNull()
  })

  it('【安全弁】読み上げ文に現れない助詞は取り込まない', () => {
    // 判定は字面だけなので、助詞に見えて語の一部である並びを切りうる。列挙を憶測で増やさないため、
    // 「読み上げ文に現れないものは入っていない」ことを固定する
    // （`も` を入れると気象庁が書いた文の「もしくは」を `モ` ＋「しくは」に割る）
    expect(leadingParticle('もしくは津波注意報が発表されます。')).toBeNull()
    expect(leadingParticle('から南へ')).toBeNull()
    expect(leadingParticle('が発表されました。')).toBeNull()
    expect(leadingParticle('として扱われます。')).toBeNull()
    expect(leadingParticle('へ避難してください。')).toBeNull()
  })

  it('【安全弁】外部依存を持たない（検証スクリプトが Node から読める）', () => {
    // `ttsPhraseBreakDict.ts` は読み込むだけで `import.meta.env` を評価するため、Node から
    // import すると落ちる。列挙をそちら側へ戻したり、ここへ import を足したりすると、
    // `npm run verify-particle-phrases` が**実装の列挙を読めなくなる**（字面を抜く形へ
    // 逃げれば、助詞を足したときに検証だけが古い集合で通り続ける）。
    const src = readFileSync('src/utils/ttsTrailingParticles.ts', 'utf8')
    const imports = [...src.matchAll(/^\s*import\s/gm)]
    expect(imports.length, `import を足すと検証が実装から離れる: ${imports.length} 件`).toBe(0)
  })
})
