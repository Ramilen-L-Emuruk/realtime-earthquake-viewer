import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { SOURCE_URL } from './build-epicenter-accents'
import { splitEpicenter, toAccentEntry, type EpicenterSplit } from './epicenterAccent'
import { toHiragana } from './stationReading'

// 生成物（public/data/tts-epicenter-accents.json）の検査。
// 生成には音声合成エンジンが要るため CI では作り直せない。**壊れた生成物をそのまま配らない**のが
// ここの役目で、値の形と「キーが実在する震央地名か」「割り方が再現できるか」を見る。

function readJson(relPath: string): unknown {
  return JSON.parse(readFileSync(relPath, 'utf8'))
}

const epicenters = readJson('public/data/tts-epicenter-accents.json') as Record<string, string>
const entries = Object.entries(epicenters).filter(([key]) => !key.startsWith('_'))

describe('取得元', () => {
  it('気象庁の震央地名を CC0 で GeoJSON 化したものを指す', () => {
    // 一次情報（多言語辞書データ）のルビは漢字の一部にしか付かず読みを復元できない。
    // 取得元を変えるときは build-epicenter-accents.ts の SOURCE_URL のコメントも見直すこと。
    expect(SOURCE_URL).toContain('0Quake/JMA_Region')
  })
})

describe('tts-epicenter-accents.json', () => {
  it('何を収録した辞書かを注記に持つ', () => {
    expect(typeof epicenters._comment).toBe('string')
  })

  it('1 句にまとまる長い震央地名だけを収録している（全件ではない）', () => {
    // 2026-09 時点で全 331 件のうち 85 件。全件収録になっていないことを見る
    // （短い名前まで割ると、かえって細切れに聞こえる）。
    expect(entries.length).toBeGreaterThan(20)
    expect(entries.length).toBeLessThan(200)
  })

  it('値は「前部要素 / 後部要素」の 2 句で、各句にアクセント核がちょうど 1 つある', () => {
    // **核の位置は句末とは限らない。** 構成要素を単独で読ませて採れた核を使うため、
    // `ヨオロ'ッパ`・`カ'ントウ` のように途中へ来る（→ epicenterAccent.ts の `phraseEntry`）。
    // ここで見るのは記法として成立しているか（カナと核だけ・句は 2 つ・核は各句に 1 つ）。
    const bad = entries.filter(([, kana]) => {
      const parts = kana.split('/')
      if (parts.length !== 2) return true
      return parts.some(part => !/^[ァ-ヴ]*'[ァ-ヴ]*$/.test(part) || part.replace(/'/g, '') === '')
    })
    expect(bad).toEqual([])
  })

  it('全件が splitEpicenter で再現できる（後部要素の表と生成物が揃っている）', () => {
    // 生成物だけが更新されて後部要素の表が古くなる（あるいは逆）のを捕まえる。
    // ふりがなは生成時にしか手に入らないので、値のカナをひらがなへ戻して割り直し、
    // **割れ目**（各句のカナ）が元の値と一致するかで見る。
    //
    // **核までは再現できない。** 位置はエンジンへ訊いて決めており、その答えはここでは手に入らない
    // （→ epicenterAccent.ts の `phraseEntry`）。核を渡さずに組み立てると末尾核へ倒れるので、
    // 比べるのはカナだけにする。
    for (const [name, kana] of entries) {
      const parts = kana.split('/').map(part => part.replace(/'/g, ''))
      const split = splitEpicenter(name, toHiragana(parts.join('')))
      expect(split, `${name} を割れない`).not.toBeNull()
      const rebuilt = toAccentEntry(split as EpicenterSplit).split('/').map(part => part.replace(/'/g, ''))
      expect(rebuilt, name).toEqual(parts)
    }
  })
})
