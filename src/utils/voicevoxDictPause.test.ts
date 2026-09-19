// 辞書キーの直後に短い間（`DICT_TRAILING_PAUSE`）を挟むかどうかのテスト。
//
// 挟むのは「キーの終わりが名前の切れ目である」ときだけ。次の 3 つは挟まない。
//   - 直後の助詞を読みへ取り込めた（切れ目が句の内側へ移っている）
//   - **キーそのものが助詞で終わる**（`最大震度4を`・`グアテマラを`。そこは文の途中）
//   - 一般用語（`_terms` に列挙したもの。文中に自然に溶け込む語）
//
// **`voicevox.test.ts` とは別のファイルにしてある。** あちらは読み上げの進み方を見るために
// fake timers と偽の AudioContext を敷いており、その上では `buildAccentPhrases` を直接呼ぶ
// この検証が通らなかった。ここでは素の環境で組み立てだけを見る。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildAccentPhrases } from './voicevox'

/**
 * 1 句だけ返す偽の合成エンジン。**応答の形が口ごとに違う** —— 素のテキストは `/audio_query` が
 * `{ accent_phrases }` で返し、辞書の読み（`is_kana=true`）は `/accent_phrases` が配列その
 * ものを返す。間が載るかだけを見るので、モーラの中身は問わない。
 */
function stubPhraseFetch(): void {
  const one = () => [{ moras: [{ text: 'ア' }], accent: 1, pause_mora: null }]
  vi.stubGlobal('fetch', (url: string) => Promise.resolve({
    ok: true,
    json: () => Promise.resolve(
      String(url).includes('/audio_query') ? { accent_phrases: one() } : one(),
    ),
  }))
}

/** 辞書キーに当たった句（先頭）の `pause_mora` を返す。 */
async function matchedPause(text: string, dict: Record<string, string>): Promise<unknown> {
  stubPhraseFetch()
  const built = await buildAccentPhrases('http://vv', text, 1, dict)
  expect(built, text).not.toBeNull()
  return (built?.phrases[0] as { pause_mora: unknown }).pause_mora
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// **題材は架空の地名。** 実データの地名を使うと、その語が単独語キーかどうか（`_standalone`）で
// 一致の可否まで動いてしまい、間の判定だけを見られない。実データでの当たり方は
// `ttsPhraseBreakDict.test.ts` が見る。
const NAME = 'テスト岬'
const READING = "テストミサキ'"

describe('辞書キーの直後の間', () => {
  // **鍵が助詞で終わるなら挟まない。** 助詞まで鍵に含めるのは核を助詞へ置きたいときで
  // （平板の地名。→ `docs/spec/audio-tts-spec.md` §3「鍵に助詞まで含める場合」）、そこは
  // 名前の切れ目ではなく文の途中。挟むと「〇〇を［間］震源とする」と述語から切り離れて聞こえる。
  it('鍵が助詞で終わるなら挟まない（正）', async () => {
    expect(await matchedPause(`${NAME}を震源とする`, { [`${NAME}を`]: "テストミサキオ'" })).toBeNull()
  })

  // 対照: この規則が広すぎないこと。助詞で終わらない地名の鍵では従来どおり挟む
  it('助詞で終わらない地名の鍵では挟む（対照）', async () => {
    expect(await matchedPause(`${NAME}沿岸`, { [NAME]: READING })).not.toBeNull()
  })

  // 安全弁: 先からある規約（取り込めた切れ目には置かない）を壊していないこと
  it('助詞を取り込めた形でも挟まない（安全弁）', async () => {
    expect(await matchedPause(`${NAME}を震源とする`, { [NAME]: READING })).toBeNull()
  })
})
