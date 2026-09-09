// @vitest-environment jsdom
//
// **網羅性の動的計測。** 実電文を本物のパーサーへ流し、「どの要素から値を取り出したか」を
// 実行時に記録する。電文と実装の突き合わせに使う計測台で、**環境変数
// `TELEGRAM_CACHE`（実電文を置いたディレクトリ）と `COVERAGE_OUT`（出力先）を
// 渡したときだけ動く**（通常の `npm test` では飛ばす）。
//
//   TELEGRAM_CACHE=<...> COVERAGE_OUT=<...> npx vitest run src/services/dmdataCoverage.probe.test.ts
//
// 静的解析（正規表現でアクセサ呼び出しを追う）は 4 巡の敵対的レビューで、毎巡新しい
// 取りこぼしが出た —— 複数行にまたがる束縛・手前の `const` の横取り・TS の型引数付き
// 呼び出し・`getElementsByTagName`・配列添字つきの門番・兄弟ブロックでの変数名の使い回し。
// **JavaScript の書き方が増えるたびに穴が開く構造**なので、推論をやめて実測に切り替えた。
//
// 「読んだ」の定義は **`textContent` を取ったか、`getAttribute` を呼んだか**。
// `localName` の参照は数えない —— `xmlQ` / `xmlAll` が全子孫を走査して名前を比べるため、
// 数えると電文の全要素が「読んだ」ことになってしまう（走査は読み取りではない）。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  parseEEWFromXml, parseEarthquakeFromXml, parseTsunamiFromXml,
  parseLpgmFromXml, parseNankaiFromXml, parseNankaiCommentaryFromXml, parseVyse60FromXml,
} from './dmdataParser'

const CACHE = process.env.TELEGRAM_CACHE ?? ''
const OUT = process.env.COVERAGE_OUT ?? ''

const RUN: Record<string, (headType: string, xml: string) => unknown> = {
  VTSE41: (h, x) => parseTsunamiFromXml(h, x),
  VTSE51: (h, x) => parseTsunamiFromXml(h, x),
  VTSE52: (h, x) => parseTsunamiFromXml(h, x),
  VXSE45: (h, x) => parseEEWFromXml(h, x),
  VXSE51: (h, x) => parseEarthquakeFromXml(h, x),
  VXSE52: (h, x) => parseEarthquakeFromXml(h, x),
  VXSE53: (h, x) => parseEarthquakeFromXml(h, x),
  VXSE61: (h, x) => parseEarthquakeFromXml(h, x),
  VXSE62: (_h, x) => parseLpgmFromXml(x),
  VYSE50: (_h, x) => parseNankaiFromXml(x),
  VYSE51: (_h, x) => parseNankaiCommentaryFromXml(x),
  VYSE52: (_h, x) => parseNankaiCommentaryFromXml(x),
  VYSE60: (_h, x) => parseVyse60FromXml(x),
}

/** 要素の根からの経路（名前空間の接頭辞は落とす。静的側の表記と揃える） */
function pathOf(el: Element): string {
  const parts: string[] = []
  let cur: Node | null = el
  while (cur && cur.nodeType === 1) {
    parts.unshift((cur as Element).localName)
    cur = cur.parentNode
  }
  return parts.join('/')
}

/** 記録用に `Node.prototype` を差し替える。返り値で元へ戻す */
function instrument(readPaths: Set<string>, readAttrs: Set<string>) {
  const nodeProto = Node.prototype as unknown as Record<string, unknown>
  const textDesc = Object.getOwnPropertyDescriptor(nodeProto, 'textContent')!
  const origGet = textDesc.get!
  Object.defineProperty(nodeProto, 'textContent', {
    ...textDesc,
    get(this: Node) {
      if (this.nodeType === 1) readPaths.add(pathOf(this as Element))
      return origGet.call(this)
    },
  })
  const elProto = Element.prototype
  const origAttr = elProto.getAttribute
  elProto.getAttribute = function (this: Element, name: string) {
    readAttrs.add(`${pathOf(this)}@${name.replace(/^[\w]+:/, '')}`)
    return origAttr.call(this, name)
  }
  return () => {
    Object.defineProperty(nodeProto, 'textContent', textDesc)
    elProto.getAttribute = origAttr
  }
}

describe('電文と実装の突き合わせ（動的計測）', () => {
  // 環境変数を渡したときだけ動く。**常に通るだけのテストにしない** —— 何も確かめて
  // いないものが緑で並ぶと、テストの一覧が信用できなくなる。
  it.skipIf(!CACHE || !OUT)('実電文を流して、値を取り出した要素・属性を記録する', () => {
    const readPaths = new Set<string>()
    const readAttrs = new Set<string>()
    const allPaths = new Set<string>()
    const allAttrs = new Set<string>()
    const perType: Record<string, { read: string[]; all: string[]; readAttrs: string[]; allAttrs: string[] }> = {}

    for (const f of fs.readdirSync(CACHE)) {
      if (!f.endsWith('.xml')) continue
      const type = f.split('_')[0]
      const run = RUN[type]
      if (!run) continue
      const xml = fs.readFileSync(path.join(CACHE, f), 'utf8')

      // その電文が持つ要素・属性を先に数える（比較の分母）
      const doc = new DOMParser().parseFromString(xml, 'application/xml')
      const typeAll = new Set<string>()
      const typeAllAttrs = new Set<string>()
      for (const el of Array.from(doc.getElementsByTagName('*'))) {
        const p = pathOf(el)
        typeAll.add(p); allPaths.add(p)
        for (const a of Array.from(el.attributes)) {
          if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) continue
          const k = `${p}@${a.name.replace(/^[\w]+:/, '')}`
          typeAllAttrs.add(k); allAttrs.add(k)
        }
      }

      // **記録の器は電文ごとに作り直す。** 使い回して「新しく増えた分」を数えると、
      // 先に処理した種別で読んだ経路が後の種別で記録されない（ディレクトリの並びで
      // 種別が入り混じるため、取りこぼしは種別によってまちまちに出る）。
      const fileRead = new Set<string>()
      const fileAttrs = new Set<string>()
      const restore = instrument(fileRead, fileAttrs)
      try {
        run(type, xml)
      } finally {
        restore()
      }

      const rec = perType[type] ?? { read: [], all: [], readAttrs: [], allAttrs: [] }
      for (const p of fileRead) { rec.read.push(p); readPaths.add(p) }
      for (const a of fileAttrs) { rec.readAttrs.push(a); readAttrs.add(a) }
      rec.all.push(...typeAll)
      rec.allAttrs.push(...typeAllAttrs)
      perType[type] = rec
    }

    const result = Object.fromEntries(Object.entries(perType).map(([t, r]) => [t, {
      read: [...new Set(r.read)].sort(),
      all: [...new Set(r.all)].sort(),
      readAttrs: [...new Set(r.readAttrs)].sort(),
      allAttrs: [...new Set(r.allAttrs)].sort(),
    }]))
    fs.writeFileSync(OUT, JSON.stringify(result, null, 1), 'utf8')
    expect(Object.keys(result).length).toBeGreaterThan(0)
  })
})
