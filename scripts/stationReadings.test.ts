import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { SOURCE_URL } from './build-station-readings'

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

/** 注記のキー（`_comment` 等）を除いた本体。 */
const entries = Object.entries(readings).filter(([key]) => !key.startsWith('_'))

describe('取得元の URL', () => {
  // 座標側は素の node で動かす規定のため定数を共有できない。片方だけ差し替えると、
  // 座標と読みが別の版から作られたことに誰も気づけない。
  it('build-station-coords.mjs と同じ取得元を指す', () => {
    const coordsScript = readFileSync('scripts/build-station-coords.mjs', 'utf8')
    const match = coordsScript.match(/'(https:\/\/gist\.githubusercontent\.com\/[^']+)'/)
    expect(match?.[1]).toBe(SOURCE_URL)
  })
})

describe('tts-station-readings.json', () => {
  it('何を収録した辞書かを注記に持つ', () => {
    expect(typeof readings._comment).toBe('string')
  })

  it('誤読する観測点だけを収録している（全点ではない）', () => {
    // 2026-09 時点で全 4372 点のうち 2458 点。**全点を収録する形になっていないこと**を見る
    // （全点だと正しく読める点までカナ経由になり、アクセントと句切れが崩れる）。
    expect(entries.length).toBeGreaterThan(500)
    expect(entries.length).toBeLessThan(Object.keys(stationCoords.stations).length * 0.9)
  })

  it('値は AquesTalk 風カナ（末尾にアクセント核）', () => {
    // 長音記号はこの文字クラスに含めない。含めると次のテストの意図（長音を残さない）と
    // 食い違い、こちらだけ見て「形は正しい」と判断できてしまう。
    const bad = entries.filter(([, kana]) => !/^[ァ-ヴ]+'$/.test(kana))
    expect(bad).toEqual([])
  })

  it('値に長音記号を含まない', () => {
    // 長音記号は /accent_phrases?is_kana=true が受け付けず（400 UNKNOWN_TEXT）、混ざると
    // その地名だけ辞書なしへ静かに落ちる。母音の重ねへ開いてあること。
    const withProlonged = entries.filter(([, kana]) => kana.includes('ー'))
    expect(withProlonged).toEqual([])
  })

  it('キーは実在する震度観測点名', () => {
    // 座標表のキーは「都道府県|観測点名」。無関係な語が混ざると、読み上げ文の別の箇所に
    // 部分一致して読みを壊しうる。
    const names = new Set(
      Object.keys(stationCoords.stations).map(key => key.slice(key.indexOf('|') + 1)),
    )
    const unknown = entries.map(([name]) => name).filter(name => !names.has(name))
    expect(unknown).toEqual([])
  })
})
