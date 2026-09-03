// 南海トラフ臨時情報・後発地震注意情報を帯へ入れる規則が、1 箇所に収まっていることの検査。
//
// **これは実装の中身ではなくソースの形を見るテスト。** 挙動のテスト（`useEarthquakes.wiring.test.ts`）
// では捕まえられない失敗を防ぐために置いてある。
//
// 経緯: 取消の適用先を識別情報で照合する修正を入れたとき、**書き手を数え漏らした**。
// `nankai` / `kohatsu` を state へ書く場所は 4 つあり（ライブの WebSocket・イベントキュー・
// 初回の履歴取得・テストボタン）、そのうち 2 つにしか照合を入れなかった。残りの経路では
// 照合が素通りするので、テストとリプレイでは防げるのに**本番の受信だけ無条件に帯を消す**
// という状態になった。しかも表示中の識別情報を覚える記憶が進まないため、**照合そのものが
// 機能しなくなる**（「表示していない」と誤判定する）副作用まで付いていた。
//
// 書き手が増えたことは、挙動のテストでは気づけない ―― 新しい経路を通るテストが無いのだから、
// 全部緑のまま穴が空く。そこでソースの形として固定する。
// **この検査で捕まえられないもの。** 行単位の正規表現なので、書き方を変えると素通りする
// （計算プロパティ `{ ...prev, [key]: null }`・ローカル変数へ組み立ててから渡す形・複数行に
// 分ける形）。いまのコードベースは `setState(prev => ({ ...prev, x }))` の直書きで一貫している
// ので実用上は足りるが、**素通りしうることを承知の上で置いている**。頑健にするなら構文木で
// 見る形へ置き換えること。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), 'useEarthquakes.ts')

/**
 * `declaration` で始まる関数・オブジェクトリテラルの行範囲（1 始まり・両端を含む）。
 *
 * 波括弧の深さを数えて閉じ位置を探す。行番号を直接書かないのは、実装が動くたびに
 * テストが嘘になるのを避けるため。
 */
function blockRange(lines: string[], declaration: string): { start: number; end: number } {
  const start = lines.findIndex(l => l.includes(declaration))
  if (start < 0) throw new Error(`宣言が見つかりません: ${declaration}`)
  let depth = 0
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    // 宣言行で開いた括弧が閉じきった行を終端とする
    if (i > start && depth <= 0) return { start: start + 1, end: i + 1 }
  }
  throw new Error(`ブロックの終端が見つかりません: ${declaration}`)
}

describe('南海トラフ臨時情報・後発地震注意情報の帯を書く場所', () => {
  const source = readFileSync(SOURCE, 'utf-8')
  const lines = source.split('\n')

  // 書いてよい場所。**ここを増やすときは、増やす理由をコメントに残すこと。**
  const allowed = [
    // 規則の置き場所。すべての経路はここを通す
    'const applyNankai = useCallback',
    'const applyKohatsu = useCallback',
    // 初期値と全体のリセット。どちらも null を入れるだけで、識別情報の記憶も併せて落とす
    'useState<EarthquakeState>({',
    'const resetState = useCallback',
  ].map(d => blockRange(lines, d))

  const isAllowed = (lineNo: number) => allowed.some(r => lineNo >= r.start && lineNo <= r.end)

  it('state へ nankai / kohatsu を書くのは、規則を置いた関数・初期値・リセットだけ', () => {
    const offenders: string[] = []
    lines.forEach((line, i) => {
      const lineNo = i + 1
      // `setState` の更新式で帯へ値を入れている行だけを見る（型宣言や比較は対象外）
      if (!/\bprev,\s*(nankai|kohatsu)\s*:/.test(line) && !/^\s*(nankai|kohatsu):\s/.test(line)) return
      // 型定義（`nankai: JMANankai | null`）は除く
      if (/:\s*(JMANankai|JMAKohatsu)\b/.test(line)) return
      if (isAllowed(lineNo)) return
      offenders.push(`${lineNo}: ${line.trim()}`)
    })
    expect(
      offenders,
      '帯へ直接書いている場所があります。applyNankai / applyKohatsu を通してください'
      + '（通さないと取消の照合が効かず、表示中の識別情報の記憶も進みません）',
    ).toEqual([])
  })

  it('後発地震の失効タイマーを張るのは applyKohatsu だけ', () => {
    // 初回の履歴取得が独自に張り直していたため、`applyKohatsu` と二重に持っていた。
    // 片方だけが識別情報の記憶を落とす状態になり、規則が食い違う
    const range = blockRange(lines, 'const applyKohatsu = useCallback')
    const offenders: string[] = []
    lines.forEach((line, i) => {
      const lineNo = i + 1
      if (!/kohatsuExpireTimerRef\.current = window\.setTimeout/.test(line)) return
      if (lineNo >= range.start && lineNo <= range.end) return
      offenders.push(`${lineNo}: ${line.trim()}`)
    })
    expect(offenders, '失効タイマーを applyKohatsu の外で張っています').toEqual([])
  })
})
