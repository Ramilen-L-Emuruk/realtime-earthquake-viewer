import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { SOURCE_URL } from './build-epicenter-accents'
import { SUFFIXES } from './epicenterAccent'
import { normalizeReading, toHiragana } from './stationReading'

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

// 「〜地方」で終わる名前は句割りではなく**核だけを直す**担当（→ build-epicenter-accents.ts の
// `chihouAccentEntry`）。県名が前に付けば「県」で 2 句に割るが、付かなければ割らずに 1 句のまま
// 核を「チ」へ置く。後部要素の表（SUFFIXES）は通らないので、下の検査では別扱いにする。
const isChihouEntry = (name: string) => name.endsWith('地方')

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
    const bad = entries.filter(([name, kana]) => {
      const parts = kana.split('/')
      // 「〜地方」は割らずに核だけ置くことがある（県名が前に付けば 2 句）
      const allowed = isChihouEntry(name) ? [1, 2] : [2]
      if (!allowed.includes(parts.length)) return true
      return parts.some(part => !/^[ァ-ヴ]*'[ァ-ヴ]*$/.test(part) || part.replace(/'/g, '') === '')
    })
    expect(bad).toEqual([])
  })
  it('「〜地方」は核を「チ」へ置く（句割りではなく核だけを直す）', () => {
    // エンジンは「チホオ」の**「ホ」の後**へ核を置く（`キタミチホ＼オ`）。手書きの句区切り辞書と
    // UniDic の `地方`（aType=1）はどちらも「チ」なので、そこへ揃える。
    const bad: string[] = []
    for (const [name, kana] of entries) {
      if (!isChihouEntry(name)) continue
      const last = kana.split('/').at(-1) as string
      if (!last.endsWith("チ'ホオ")) bad.push(`${name} => ${kana}`)
    }
    expect(bad).toEqual([])
  })

  it('後部要素の表に載る名前は、値の後半がその読みと揃っている', () => {
    // 「生成物だけが新しくなって表が古い」を捕まえる。読みは正規化して比べる（上と同じ理由）。
    const bad: string[] = []
    for (const [name, kana] of entries) {
      if (isChihouEntry(name)) continue
      const parts = kana.split('/').map(part => part.replace(/'/g, ''))
      const at = SUFFIXES.findIndex(([tail, tailKana]) =>
        name.endsWith(tail) && normalizeReading(toHiragana(parts[1])) === normalizeReading(tailKana))
      if (at < 0) { bad.push(`${name} => ${kana}: 後部要素が表に無い`); continue }
      // **前部要素の側も守る。** 後部要素が表に載っているかだけを見ると、`根室半島南東沖` を
      // `根室半島南東 / 沖` と短く割った値も（`沖` は表にあるので）通ってしまう。
      // 表は長い順なので、採った位置より前に名前の末尾と一致するものがあれば割り方が短すぎる
      // （生成側は読みも一致することを求めるので、読みが合わないものは正当に飛ばす）
      const longer = SUFFIXES.slice(0, at)
        .filter(([tail, tailKana]) =>
          name.endsWith(tail) && normalizeReading(toHiragana(parts.join(''))).endsWith(normalizeReading(tailKana)))
      if (longer.length > 0) bad.push(`${name} => ${kana}: ${longer[0][0]} で割れたはず`)
    }
    expect(bad).toEqual([])
  })

})
