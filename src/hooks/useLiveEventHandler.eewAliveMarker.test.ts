// 緊急地震速報の「まだ生きているか」の印について、**挙動では再現できない不変条件**を
// ソースの形で固定する。
//
// ここで守るものは 2 つ。どちらも壊しても**そのときは何も起きない**——壊れた状態が表に出るのは
// 「読み上げを切ったまま報を受け、後で有効にした」ときと「リプレイの窓の手前に誤報取消があった」
// ときだけで、しかも症状は音の不在・画面が戻らないという形なので、例外もログも出ない。
//
// **だから振る舞いのテストでは捉えられない。** 読み上げが無効な間は読み上げ自体が走らないので、
// 書く側が動いていようがいまいが観測できる差が出ない。捉えられるのは配置そのものだけ。
//
//   1. 「生きているか」の印を**書く側**が、読み上げ設定のブロックの**外**にあること
//      —— 消す側（取消・自動解除の受信）は元から外にある。片方だけ中へ入ると、読み上げを
//      切っている端末で印が片方向にしか動かず、後から有効にしたときに発話を黙らせる向きの
//      食い違いが残る
//   2. 解除で捨てる記憶の**顔ぶれが 1 箇所に集約**されていること —— ライブの解除処理と
//      リプレイの復元が別々に並べる形だと、ref を 1 つ足すたびに片方へ書き忘れる。
//      実際に復元側で漏れていて、取り消された緊急地震速報が「発表中」として居座っていた
//
// 規約は docs/spec/audio-tts-spec.md §6「『まだ生きているか』の印は、読み上げ設定と独立に持つ」。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SOURCE = readFileSync(fileURLToPath(new URL('./useLiveEventHandler.ts', import.meta.url)), 'utf8')
const LINES = SOURCE.split(/\r?\n/)

/** その行の字下げ幅（スペース数）。 */
function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/**
 * `from` 行から始まるブロックの範囲を返す（開始行・終了行とも 0 起点・両端を含む）。
 *
 * **閉じを探すのに括弧を数えず、字下げで見る。** このファイルは 2 スペース字下げで整形されて
 * いるので、ブロックを閉じる `}` は開始行と同じ深さに来る。括弧を数える形にすると、文字列や
 * コメントの中の括弧を拾って静かにずれる。
 */
function blockRange(from: number): { from: number; to: number } {
  const depth = indentOf(LINES[from])
  for (let i = from + 1; i < LINES.length; i++) {
    const t = LINES[i].trimStart()
    if (t.startsWith('}') && indentOf(LINES[i]) === depth) return { from, to: i }
  }
  throw new Error(`ブロックの閉じが見つかりません（${from + 1} 行目から）`)
}

/** その行を含む行の番号（0 起点）。1 つだけ在ることを確かめる。 */
function soleLineWith(needle: string): number {
  const hits = LINES.flatMap((l, i) => (l.includes(needle) ? [i] : []))
  expect(hits.length, `1 箇所だけのはずです: ${needle}`).toBe(1)
  return hits[0]
}

/**
 * `anchor` 行から上へ遡って、直近の `open` を含む行を返す。
 *
 * **同じ字下げの `if (settings.voicevoxEnabled) {` はこのファイルに 5 つある**（地震情報・
 * 津波・長周期…）ので、素直に前から探すと別のブロックを掴む。中にしか無いものを目印にして
 * 遡る形にすれば、目的のブロックだけを一意に指せる。
 */
function enclosingBlockStart(anchor: number, open: string): number {
  for (let i = anchor; i >= 0; i--) if (LINES[i].includes(open)) return i
  throw new Error(`${anchor + 1} 行目から遡って見つかりません: ${open}`)
}

/** `needle` を含む行の番号（0 起点）をすべて返す。 */
function linesWith(needle: string): number[] {
  return LINES.flatMap((l, i) => (l.includes(needle) ? [i] : []))
}

describe('「まだ生きているか」の印は、読み上げ設定のブロックの外で書く', () => {
  // **対象は EEW の読み上げブロック 1 つだけ。** 第 2 フェーズの予約を組む関数はその中にしか
  // 無いので、そこを目印にして開始行まで遡る。
  const phase2 = soleLineWith('const enqueuePhase2 = () => {')
  const ttsBlock = blockRange(enclosingBlockStart(phase2, 'if (settings.voicevoxEnabled) {'))

  // 正: 発表中の電文を覚える書き込みは、ブロックの手前にある。
  it('発表中の電文を覚える書き込みは、読み上げブロックの外にある', () => {
    const writes = linesWith('eewTtsEventsRef.current.set(')
    expect(writes.length, '書き込みはライブ経路と復元の 2 箇所').toBe(2)
    for (const at of writes) {
      expect(at < ttsBlock.from || at > ttsBlock.to,
        `${at + 1} 行目の書き込みが読み上げブロック（${ttsBlock.from + 1}〜${ttsBlock.to + 1} 行目）の中にあります`,
      ).toBe(true)
    }
  })

  // 正: 誤報取消の記録を落とす操作も同じ。
  it('誤報取消の記録を落とす操作も、読み上げブロックの外にある', () => {
    const clears = linesWith('eewRetractedKeysRef.current.delete(')
    expect(clears.length, '落とすのは報を受けた時点の 1 箇所').toBe(1)
    expect(clears[0] < ttsBlock.from || clears[0] > ttsBlock.to,
      `${clears[0] + 1} 行目が読み上げブロックの中にあります`,
    ).toBe(true)
  })

  // 安全弁: ブロックの範囲を取り違えていない（極端に短い範囲を掴んでいない）。
  // **この検査が無いと、範囲の取得が壊れて数行しか見ていなくても上の 2 件が通る。**
  // 実際、最初に書いたときは別の `if (settings.voicevoxEnabled) {` を掴んで 13 行しか
  // 見ておらず、ここだけが落ちた。
  it('読み上げブロックの範囲を正しく掴んでいる', () => {
    const size = ttsBlock.to - ttsBlock.from
    expect(size, '第 1〜第 2 フェーズを組み立てるブロックなので数百行ある').toBeGreaterThan(300)
    // 目印が範囲の内側にあること（遡り方が壊れて手前のブロックを掴んでいないこと）。
    expect(phase2).toBeGreaterThan(ttsBlock.from)
    expect(phase2).toBeLessThan(ttsBlock.to)
  })
})

describe('解除で捨てる記憶の顔ぶれは 1 箇所に集約する', () => {
  const helper = blockRange(soleLineWith('const forgetEewTracking = (key: string) => {'))

  // 正: ライブの解除処理と復元の両方が同じヘルパーを通る。
  it('ライブの解除処理と復元の両方がヘルパーを呼ぶ', () => {
    const calls = linesWith('forgetEewTracking(key)').filter(at => at < helper.from || at > helper.to)
    expect(calls.length, 'ライブの解除処理と復元の 2 箇所から呼ぶ').toBe(2)
  })

  // 安全弁: 顔ぶれを迂回して直接消す経路が生えていないこと。
  //
  // **`activeEEWLevelsRef` で代表させる。** あれは「いま発表中のもの」を表していて、解除で
  // 消し忘れると幽霊が残る（`size === 0` が成立せず、画面が既定へ戻らない）。全部の ref を
  // 並べて数えると、この検査自体が数え上げになって同じ穴を開ける。
  it('発表中の帳面から消す操作は、ヘルパーの中だけにある', () => {
    const deletes = linesWith('activeEEWLevelsRef.current.delete(')
    expect(deletes.length, '消すのはヘルパーの 1 行だけ').toBe(1)
    expect(deletes[0]).toBeGreaterThan(helper.from)
    expect(deletes[0]).toBeLessThan(helper.to)
  })

  // 対照: ヘルパーは「立てる側」（誤報取消の記録）を持たない。あれは誤報取消と自動解除で
  // 扱いが分かれるので、判断は呼び出し側にある。
  it('ヘルパーは誤報取消の記録を触らない', () => {
    const body = LINES.slice(helper.from, helper.to + 1).join('\n')
    expect(body).not.toContain('eewRetractedKeysRef')
  })
})
