import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

// 地図描画仕様書（`docs/spec/map-rendering-spec.md`）の列挙が実装から離れていないかを見る。
//
// **この検査が担保できるのは「名前が実在するか」までで、「どの mode に出るか」ではない。**
// `JapanMapGL` はレイヤーをモードで出し分けるのに JSX の条件分岐ではなく `visible` prop を使う
// （GeoJSON ソースの付け外しを避けるため。仕様書 §9）。どのモードで真になるかは props と
// 派生フラグの組み合わせで決まり、静的には導けない。**§7 の mode 対応を直すときは実装を読むこと。**
//
// 実際に離れていた（2026-09-18 に揃えた）。`catalog` モードの項がまるごと無く、§1 の列挙と
// §2 のコード片も 3 つのまま。既存 3 モードにもレイヤーの抜けがあり、§3 のカスタムレイヤーの
// 列挙も 2 つのままだった（何が抜けていたかは仕様書の改訂履歴）。いずれも人が読むまで残る類で、
// 型検査にも既存のテストにも掛からなかった。

const SPEC = 'docs/spec/map-rendering-spec.md'
const MAP_DIR = 'src/components/Map'

// §7 に挙げない地図コンポーネント。**レイヤーではないものだけ**を入れる。
// 「まだ書いていない」ものを避難させる場所ではない。
const NOT_A_LAYER = [
  'JapanMapGL', // 地図の中枢。レイヤーを配る側
  'CameraFollowsGL', // カメラ追従。描画物を持たない
]

/** 見出し番号で節の本文を切り出す。節が無ければ null（見出しの取り違えを検査側で落とすため）。 */
function section(text: string, heading: RegExp): string | null {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(l => heading.test(l))
  if (start < 0) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(l => /^##\s/.test(l))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n')
}

/** ディレクトリを再帰的に辿り、テストを除く .ts / .tsx を返す。 */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path))
      continue
    }
    if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue
    out.push(path)
  }
  return out
}

const spec = readFileSync(SPEC, 'utf-8')
const files = sourceFiles(MAP_DIR)

describe('地図描画仕様書 §7（mode 別レイヤー一覧）', () => {
  const body = section(spec, /^##\s*7\./)

  // 節を取り違えると、以下の検査が 1 件も走らないまま緑になる。
  it('節が見つかる', () => {
    expect(body).not.toBeNull()
  })

  // **拾うのは mode の小見出しより後だけ。** 節の頭のリード文にも共通レイヤーの名前が並ぶので、
  // そこまで数えると「リード文に書いただけで、どのモードにも挙げていない」形を通してしまう。
  //
  // 拾う形は「バッククォートで囲まれ GL で終わる語」。コンポーネント名かどうかは見ていないので、
  // mode の節へ技術用語（`WebGL` 等）をバッククォート付きで書くと実在しないものとして落ちる。
  // **落ちる側へ倒してある** —— 書き方を狭めて拾い漏らすより、書けないことに気づくほうが軽い。
  const modeBlocks = (body ?? '').split(/^### /m).slice(1).join('\n')
  const listed = new Set(modeBlocks.match(/`(\w+GL)`/g)?.map(s => s.slice(1, -1)) ?? [])

  it('挙げたコンポーネントが実在する', () => {
    expect(listed.size).toBeGreaterThan(0)
    const missing = [...listed].filter(n => !files.includes(join(MAP_DIR, `${n}.tsx`)))
    expect(missing, `§7 に挙がっているが ${MAP_DIR} に無い`).toEqual([])
  })

  it('実在する地図コンポーネントが 1 つも漏れていない', () => {
    // **パス区切りを正規表現へ書かない。** Windows では `join` が `\` を返すため、
    // `[/]` と書くと 1 件も拾えず「漏れなし」で緑になる（実際にそうなった）。
    const all = files
      .map(p => basename(p))
      .filter(n => /^\w+GL\.tsx$/.test(n))
      .map(n => n.replace(/\.tsx$/, ''))
    // 1 件も拾えていなければ、上の絞り込みが実態と合っていない。
    expect(all.length, `${MAP_DIR} から地図コンポーネントを 1 つも拾えていない`).toBeGreaterThan(0)
    const unlisted = all.filter(n => !listed.has(n) && !NOT_A_LAYER.includes(n))
    expect(unlisted, '§7 のどのモードにも挙がっていない').toEqual([])
  })

  // 除外リストがリネームで空振りすると、上の検査が黙って緩む。
  it('レイヤーでないとして除いたものが実在する', () => {
    const gone = NOT_A_LAYER.filter(n => !files.includes(join(MAP_DIR, `${n}.tsx`)))
    expect(gone, 'NOT_A_LAYER に実在しない名前がある').toEqual([])
  })
})

describe('地図描画仕様書 §3（カスタムレイヤーの列挙）', () => {
  const body = section(spec, /^##\s*3\./)

  it('節が見つかる', () => {
    expect(body).not.toBeNull()
  })

  /**
   * 同じファイルの `const LYR` からレイヤー id を引く。
   * 文字列を直に持つ形と、別の定数を指す形（`const LYR = DAY_NIGHT_LAYER_ID`）の 2 つを見る。
   */
  function lyrOf(text: string): string | undefined {
    const direct = text.match(/^const LYR = '([^']+)'/m)
    if (direct) return direct[1]
    const alias = text.match(/^const LYR = (\w+)$/m)
    if (!alias) return undefined
    return text.match(new RegExp(`^(?:export )?const ${alias[1]} = '([^']+)'`, 'm'))?.[1]
  }

  // 実装側: `type: 'custom'` を書いているファイルから id を集める。
  // id を引数で受け取る生成関数（`gl/depthPointLayer.ts`）は、呼び出し元の `const LYR` から採る。
  // **どちらの形でも拾えなかったら落とす** —— 収集規則が実装に追いついていない印で、
  // 黙って無視すると列挙の抜けを見逃す側へ倒れる（実際に `gl/dayNightLayer.ts` がここで落ちた）。
  function customLayerIds(): string[] {
    const ids: string[] = []
    for (const path of files) {
      const text = readFileSync(path, 'utf-8')
      // クォートの種類を固定しない。片方だけを見ると、もう片方で書いた新しいカスタムレイヤーが
      // 収集の対象から外れ、§3 へ書き忘れても 0 件のまま緑になる。
      if (!/type:\s*["']custom["']/.test(text)) continue
      const own = lyrOf(text)
      if (own) {
        ids.push(own)
        continue
      }
      const factory = text.match(/export function (\w+)\(\s*id: string/)
      if (!factory) throw new Error(`${path}: カスタムレイヤーの id を収集できない（収集規則を見直すこと）`)
      const callers = files.filter(p => p !== path && readFileSync(p, 'utf-8').includes(`${factory[1]}(`))
      const called = callers
        .map(p => readFileSync(p, 'utf-8').match(/^const LYR = '([^']+)'/m)?.[1])
        .filter((v): v is string => !!v)
      if (called.length === 0) throw new Error(`${path}: ${factory[1]} の呼び出し元から id を収集できない`)
      ids.push(...called)
    }
    return [...new Set(ids)].sort()
  }

  it('挙げた id が実装と一致する', () => {
    const implemented = customLayerIds()
    expect(implemented.length).toBeGreaterThan(0)
    // 列挙はこの段落にしかない。**`implemented` で絞り込まない** —— 絞ると「仕様書に無い id」を
    // 検出できず、片方向の検査に化ける。段落の他のバッククォート表記（`getStyle().layers` 等）は
    // ドット・括弧・スラッシュを含むのでこの形には一致しない。
    const para = (body ?? '').split(/\n\s*\n/).find(p => p.includes('カスタムレイヤーの注意'))
    expect(para, '§3 にカスタムレイヤーの段落が見つからない').toBeDefined()
    const listed = [...new Set((para ?? '').match(/`([a-z][\w-]*)`/g)?.map(s => s.slice(1, -1)) ?? [])].sort()
    expect(listed).toEqual(implemented)
  })
})
