// 辞書キーの直後に続く助詞の列挙と切り出しのテスト。
//
// 切り出した助詞は読みを辞書の値へ足して同じアクセント句に入れる（`voicevox.ts` の
// `buildAccentPhrases`）。ここで固めるのは「どこまでを助詞と見るか」「読みが表記どおりでない
// もの」、そして**このモジュールが外部依存を持たないこと**（検証スクリプトが Node から
// 読めなくなるため）。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { leadingParticle, endsWithParticle, TRAILING_PARTICLES } from './ttsTrailingParticles'

describe('辞書キーの直後の助詞', () => {
  it('読み上げ文に現れる形を切り出せる', () => {
    expect(leadingParticle('で到達を確認しました。')).toEqual({ surface: 'で', kana: 'デ' })
    expect(leadingParticle('では、震度5弱以上と推定されますが、未入電です。'))
      .toEqual({ surface: 'では', kana: 'デワ' })
    expect(leadingParticle('は欠測となっています。')).toEqual({ surface: 'は', kana: 'ワ' })
    // 主格の `が` は津波の等級が動く報に現れる。**辞書キーが地名でない（`_terms` の）形なので、
    // 地名の後ろだけを見ていると取りこぼす** —— 実際に一度落としていた。
    expect(leadingParticle('が津波注意報に切り替えられました。')).toEqual({ surface: 'が', kana: 'ガ' })
    expect(leadingParticle('が発表されました。')).toEqual({ surface: 'が', kana: 'ガ' })
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

  // 方向の「へ」。**津波の観測情報が更新の着点を受ける助詞**で、押し引きの語（`押し波` /
  // `引き波`）は手書きの句区切り辞書の `_terms` にあるため、**辞書キーの直後に「へ」が来る形が
  // 実在する**（「〇〇で16時32分の押し波へ更新されました。」）。着点を「に」で受けていた頃は
  // `に` が取り込んでいたので、助詞を足さないまま着点だけ変えると 1 モーラの独立句として浮く。
  //
  // 副えて、気象庁が書いた文の「〇〇へ避難してください。」も取り込まれるようになった
  // （以前はここが「列挙に無いものは切り出さない」安全弁の例だった）。あちらも助詞なので、
  // 取り込むほうが句の構成として素直。
  it('方向の「へ」を取り込む（読みは エ）', () => {
    expect(leadingParticle('へ更新されました。')).toEqual({ surface: 'へ', kana: 'エ' })
    expect(leadingParticle('へ避難してください。')).toEqual({ surface: 'へ', kana: 'エ' })
  })

  it('【対照】助詞でなければ切り出さない', () => {
    // 漢字・数字・区切り文字が直に続く形。取り込まず、辞書境界の間を置く側へ倒れる
    expect(leadingParticle('町で震度3を観測しました。')).toBeNull()
    expect(leadingParticle('3.2メートル以上を観測しました。')).toBeNull()
    expect(leadingParticle('、富山県で3メートル。')).toBeNull()
    expect(leadingParticle('')).toBeNull()
  })

  it('【安全弁】切り出すのは列挙したものだけ', () => {
    // 判定は字面だけなので、助詞に見えて語の一部である並びを切りうる。列挙を憶測で増やさないため、
    // 「列挙に無いものは切り出さない」ことを固定する
    // （`も` を入れると気象庁が書いた文の「もしくは」を `モ` ＋「しくは」に割る）
    expect(leadingParticle('もしくは津波注意報が発表されます。')).toBeNull()
    expect(leadingParticle('として扱われます。')).toBeNull()
    // **`から` は辞書キーの直後に実在する**（日付・時刻のキー。「9日0時から24時まで」）。
    // それでも入れていないのは、切り出さなくても独立した句にならないため —— 後続と 1 句へ
    // まとまるので浮かない（実測）。**現れないから入れない、ではない。**
    expect(leadingParticle('から南へ')).toBeNull()
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

describe('辞書キーが助詞で終わるか', () => {
  // 見分けたいのは**助詞まで鍵に含めた形**。その鍵の直後は名前の切れ目ではなく文の途中なので、
  // `voicevox.ts` が間を挟まない（→ そちらのテスト「辞書キーの直後の間」）。
  it('助詞まで含めた鍵を見分ける', () => {
    expect(endsWithParticle('最大震度4を')).toBe(true)
    expect(endsWithParticle('グアテマラを')).toBe(true)
    expect(endsWithParticle('地域の方は')).toBe(true)
  })

  it('【対照】助詞で終わらない鍵は偽', () => {
    expect(endsWithParticle('グアテマラ')).toBe(false)
    expect(endsWithParticle('緊急地震速報')).toBe(false)
    expect(endsWithParticle('')).toBe(false)
    // 「と」は列挙に無い（`巨大地震と` は核を助詞へ置くための鍵だが、切り出しの対象外）。
    // ここが真になると、列挙に無い助詞で終わる鍵の直後からも間が消える
    expect(endsWithParticle('巨大地震と')).toBe(false)
  })

  it('【安全弁】列挙と同じ集合を見る', () => {
    for (const [surface] of TRAILING_PARTICLES) {
      expect(endsWithParticle(`能登地方${surface}`), surface).toBe(true)
    }
  })
})
