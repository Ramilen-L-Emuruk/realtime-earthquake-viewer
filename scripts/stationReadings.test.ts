import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { JMA_TEC_MATERIAL, SOURCE_URL } from './build-station-readings'
import { isHeaderOnlyStationName, isOffshoreStationName } from './tsunamiStationReading'

// 生成物（public/data/tts-station-readings.json）と生成スクリプトの整合を検査する。
// 生成にはエンジンが要るため CI では作り直せない。**壊れた生成物をそのまま配らないための検査**が
// ここの役目で、値の形と「キーが実在する観測点名か」を見る。

function readJson(relPath: string): unknown {
  return JSON.parse(readFileSync(relPath, 'utf8'))
}

const readings = readJson('public/data/tts-station-readings.json') as Record<string, string>
const stationCoords = readJson('public/data/station-coords.json') as {
  stations: Record<string, [number, number, number?]>
}
const tsunamiObsCoords = readJson('public/data/tsunami-obs-coords.json') as Record<string, unknown>

/** 注記のキー（`_comment` 等）を除いた本体。 */
const entries = Object.entries(readings).filter(([key]) => !key.startsWith('_'))

/**
 * AquesTalk 風カナの 1 アクセント句。**核（`'`）をちょうど 1 つ持つこと**を見る。
 * 核より前にカナが 1 文字以上あることも要求する（核は最初のモーラより後ろに付く）。
 *
 * `_` は無声化記号。沖合の潮位観測点はエンジンが返した表記をそのまま値にするため、
 * エンジンが無声化と判断した箇所に入る（`_クシロ'オ_キ/...`）。比較の正規化
 * （`stationReading.ts` の `normalizeReading`）はこれを落とすので読みの照合には影響しない。
 */
const ACCENT_PHRASE_RE = /^[ァ-ヴ_]*[ァ-ヴ][ァ-ヴ_]*'[ァ-ヴ_]*$/

describe('取得元の URL', () => {
  // 座標側は素の node で動かす規定のため定数を共有できない。片方だけ差し替えると、
  // 座標と読みが別の版から作られたことに誰も気づけない。
  it('build-station-coords.mjs と同じ取得元を指す', () => {
    const coordsScript = readFileSync('scripts/build-station-coords.mjs', 'utf8')
    const match = coordsScript.match(/'(https:\/\/gist\.githubusercontent\.com\/[^']+)'/)
    expect(match?.[1]).toBe(SOURCE_URL)
  })

  it('build-tsunami-obs-coords.mjs と同じ取得元を指す（潮位観測点）', () => {
    const coordsScript = readFileSync('scripts/build-tsunami-obs-coords.mjs', 'utf8')
    const match = coordsScript.match(/'(https:\/\/xml\.kishou\.go\.jp\/[^']+)'/)
    expect(match?.[1]).toBe(JMA_TEC_MATERIAL)
  })
})

describe('tts-station-readings.json', () => {
  it('何を収録した辞書かを注記に持つ', () => {
    expect(typeof readings._comment).toBe('string')
  })

  it('誤読する観測点だけを収録している（全点ではない）', () => {
    // 2026-09 時点で震度観測点 4372 点＋潮位観測点 611 点のうち 2554 点。**全点を収録する形に
    // なっていないこと**を見る（全点だと正しく読める点までカナ経由になり、アクセントと句切れが
    // 崩れる）。分母に潮位観測点の座標表を使うのは、ヘッダ部の簡略名を含む一覧が
    // リポジトリに無いため（その分だけ緩い上限になる）。
    const total = Object.keys(stationCoords.stations).length + Object.keys(tsunamiObsCoords).length
    expect(entries.length).toBeGreaterThan(500)
    expect(entries.length).toBeLessThan(total * 0.9)
  })

  it('値は AquesTalk 風カナ（各アクセント句が核を 1 つ持つ）', () => {
    // 震度観測点と沿岸の潮位観測点はふりがなから組むので 1 句（末尾に核）。沖合の潮位観測点は
    // エンジンが返した表記をそのまま使うため句区切り（`/`）を含む。
    // 長音記号はこの文字クラスに含めない。含めると次のテストの意図（長音を残さない）と
    // 食い違い、こちらだけ見て「形は正しい」と判断できてしまう。
    const bad = entries.filter(([, kana]) => !kana.split('/').every(p => ACCENT_PHRASE_RE.test(p)))
    expect(bad).toEqual([])
  })

  it('値に長音記号を含まない', () => {
    // 長音記号は /accent_phrases?is_kana=true が受け付けず（400 UNKNOWN_TEXT）、混ざると
    // その地名だけ辞書なしへ静かに落ちる。母音の重ねへ開いてあること。
    const withProlonged = entries.filter(([, kana]) => kana.includes('ー'))
    expect(withProlonged).toEqual([])
  })

  it('値に句読点を含まない', () => {
    // 沖合の値は読み上げ文の形（`名前、`）で読ませた表記から採るため、落とし忘れると
    // 読点が値に残る。残ると辞書地名の後ろに二重の間が入る。
    const withPunct = entries.filter(([, kana]) => /[、。]/.test(kana))
    expect(withPunct).toEqual([])
  })

  it('キーは実在する観測点名', () => {
    // 座標表のキーは震度観測点が「都道府県|観測点名」、潮位観測点が観測点名そのまま。
    // 無関係な語が混ざると、読み上げ文の別の箇所に部分一致して読みを壊しうる。
    const names = new Set([
      ...Object.keys(stationCoords.stations).map(key => key.slice(key.indexOf('|') + 1)),
      ...Object.keys(tsunamiObsCoords),
    ])
    // **免除するのは識別英字が付かない形だけ。** ヘッダ部でのみ使う簡略名（`宮城沖５０ｋｍ`）は
    // 座標を持たないため座標表に載らず、名前の形でしか実在と見なせない。識別英字が付く形
    // （246 点）は座標表にあるので、そちらは突き合わせで確かめる —— 一律に免除すると、
    // 取り違えた架空の距離・英字（`宮城沖５５ｋｍＢ` のような）が混ざっても気づけない。
    const unknown = entries
      .map(([name]) => name)
      .filter(name => !names.has(name) && !isHeaderOnlyStationName(name))
    expect(unknown).toEqual([])
  })

  it('沖合の観測点の値は距離を単位付きで読む', () => {
    // 「ｋｍ」が単位として解析されないと「クム」と読まれる（この辞書がそれを直している）。
    // **誤読をそのまま焼き込んでいないこと**を値の文字列から静的に見る。生成側は「読点で
    // 終わる形なら正しく読める」ことを確かめてから値を採るが、そこが崩れた版のエンジンで
    // 作り直された生成物は、この検査でしか捕まらない。
    const offshore = entries.filter(([name]) => isOffshoreStationName(name))
    expect(offshore.length).toBeGreaterThan(0)
    const bad = offshore.filter(([, kana]) => !kana.includes('キロメ') || kana.includes('クム'))
    expect(bad).toEqual([])
  })
})
