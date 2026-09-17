import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error -- 型定義を持たない .mjs（`scripts/lib/rateGate.mjs` と同じ扱い）
import {
  noteIncomplete, readArtifact, writeArtifact, markResult, incompletenessBanner,
  incompleteNotes, reportIncompleteness, resetIncompletenessForTest, checkpoint,
} from './incompleteness.mjs'

// 調査スクリプトの出力は「この種別は 0 件だった」という**網羅性の主張の根拠**になる。
// だから「集めたが 0 件」と「集められなかった」を区別できない形で残ってはいけない。
//
// **この仕組みを作った理由は、個別の `if` で引き継ぐ形が 3 巡続けて破れたため。**
// 1 巡目は永続化するファイルへ印を書いておらず、2 巡目は下流が読んでおらず、3 巡目で
// ようやく末端へ届いた。どれも「動くけれど印だけが消える」形で、型検査もテストも通っていた。
// パイプラインが 3 段で済んだから 3 巡で収束しただけで、設計が正しかったからではない。
//
// ここで固定するのは **「読んだら引き継ぐ」が呼び出し側の記述ではないこと**。
// `readArtifact` を通ればそれだけで台帳へ積まれ、`writeArtifact` で自動的に出ていく。
describe('不完全さの印の伝播', () => {
  let dir: string

  beforeEach(() => {
    // **台帳はモジュールに溜まる。** 前のテストが残した印が見えると、「印が無いとき」の
    // 振る舞いを確かめるテストが実行順によって落ちる
    resetIncompletenessForTest()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incompleteness-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))

  // ---- 正: 印が下流へ渡る ----

  // **引き継ぎを 1 行も書いていないのに印が出ること**がこのテストの主眼。
  // 呼び出し側が書くのは「読む」「書く」だけで、伝播はその副作用として起きる
  it('上流の印は、読んだだけで自分の出力へ引き継がれる', () => {
    // 上流（プロデューサー）が、取りこぼしたうえで結果を書く
    noteIncomplete('P2PQuake の履歴', 'code=552: HTTP 429')
    writeArtifact(path.join(dir, 'p2p-history.json'), { codes: { 551: [] } })

    // 下流は別のプロセスなので、台帳は空から始まる
    resetIncompletenessForTest()
    expect(incompleteNotes()).toHaveLength(0)

    const hist = readArtifact(path.join(dir, 'p2p-history.json'), { source: 'P2PQuake の履歴' })
    expect(hist.codes).toEqual({ 551: [] })

    writeArtifact(path.join(dir, 'testdata-shapes.json'), { meta: { parsed: 0 } })

    const shapes = read('testdata-shapes.json')
    expect(shapes.meta).toEqual({ parsed: 0 })        // データの形は変えない
    expect(shapes._incomplete.notes).toEqual(['P2PQuake の履歴: 1 件（code=552: HTTP 429）'])
    expect(shapes._incomplete.warning).toContain('「無い」の根拠にしないこと')
  })

  // ホップが増えても手当てが要らないこと。**3 段で足りたのはたまたま**なので、
  // 段数に依存しない形であることを固定する
  it('多段のパイプラインでも先頭の印が末端まで残る', () => {
    noteIncomplete('アーカイブの取得', 'telegram.earthquake 2026-01-03: HTTP 500')
    writeArtifact(path.join(dir, 'a.json'), { stage: 'a' })

    resetIncompletenessForTest()
    readArtifact(path.join(dir, 'a.json'), { source: 'a' })
    writeArtifact(path.join(dir, 'b.json'), { stage: 'b' })

    resetIncompletenessForTest()
    readArtifact(path.join(dir, 'b.json'), { source: 'b' })
    writeArtifact(path.join(dir, 'c.json'), { stage: 'c' })

    expect(read('c.json')._incomplete.notes).toEqual([
      'アーカイブの取得: 1 件（telegram.earthquake 2026-01-03: HTTP 500）',
    ])
  })

  // **引き継いだ行は畳み直さない。** 畳み直すと源が「上流」に丸められ、どこで
  // 取りこぼしたのかが段を下るほど薄くなる
  it('自分の分は源ごとに畳み、引き継いだ分はそのまま持ち回る', () => {
    noteIncomplete('アーカイブの取得', '2026-01-03: HTTP 500')
    writeArtifact(path.join(dir, 'up.json'), {})

    resetIncompletenessForTest()
    readArtifact(path.join(dir, 'up.json'), { source: 'up' })
    noteIncomplete('テストデータの実行', 'createTestTsunami: 例外')
    noteIncomplete('テストデータの実行', 'createTestEEW: 例外')
    writeArtifact(path.join(dir, 'down.json'), {})

    expect(read('down.json')._incomplete.notes).toEqual([
      // 自分の分は 1 源 1 行へ畳む（件数が増えても行数は源の数で止まる）
      'テストデータの実行: 2 件（createTestTsunami: 例外 / createTestEEW: 例外）',
      // 引き継いだ分は原文のまま
      'アーカイブの取得: 1 件（2026-01-03: HTTP 500）',
    ])
  })

  // **少数なら全部見せる。** 畳みは件数が多いときのための仕組みで、2〜3 件のときまで
  // 要約すると「何が落ちたか」が読めなくなる
  it('見本の上限を超えたときだけ件数へ要約する', () => {
    for (const d of ['01', '02', '03', '04', '05']) {
      noteIncomplete('アーカイブの取得', `2026-01-${d}: HTTP 500`)
    }
    writeArtifact(path.join(dir, 'many.json'), {})

    expect(read('many.json')._incomplete.notes).toEqual([
      'アーカイブの取得: 5 件（例: 2026-01-01: HTTP 500 / 2026-01-02: HTTP 500 / 2026-01-03: HTTP 500 ほか 2 件）',
    ])
  })

  // **同じ印が 2 つの経路で届く形は実在する。** `triage.mjs` は計測台の生データ
  // （そこに収集の札の印が入っている）を読んだうえで、同じ札を自分でも読む
  it('同じ印が複数の経路で届いても 1 行にまとめる', () => {
    noteIncomplete('アーカイブの取得', '2026-01-03: HTTP 500')
    writeArtifact(path.join(dir, 'mark.json'), {})

    // 中間の段が札を読んで自分の出力へ引き継ぐ
    resetIncompletenessForTest()
    readArtifact(path.join(dir, 'mark.json'), { source: '札' })
    writeArtifact(path.join(dir, 'middle.json'), {})

    // 末端は中間の出力と札の両方を読む
    resetIncompletenessForTest()
    readArtifact(path.join(dir, 'middle.json'), { source: '中間' })
    readArtifact(path.join(dir, 'mark.json'), { source: '札' })

    expect(incompleteNotes()).toEqual(['アーカイブの取得: 1 件（2026-01-03: HTTP 500）'])
  })

  // ---- 区間（1 つのプロセスが独立した成果物を複数書くとき） ----

  // **区切らないと、完璧に走査できた分類の成果物にも別の分類の取りこぼしが載る。**
  // 下流はそれを読んで「このレポートのどの節も『無い』の根拠にするな」と出すので、
  // 事実に反する警告になる（事実に反する警告は、本物の警告を軽く見せる）
  it('区間を渡すと、その間に積まれた分だけを印にする', () => {
    // 分類 A: 取りこぼし無し
    const cpA = checkpoint()
    writeArtifact(path.join(dir, 'a.json'), { cls: 'A' }, { since: cpA })

    // 分類 B: 取りこぼしあり
    const cpB = checkpoint()
    noteIncomplete('アーカイブの取得', 'B 2026-01-02: HTTP 500')
    writeArtifact(path.join(dir, 'b.json'), { cls: 'B' }, { since: cpB })

    expect(read('a.json')._incomplete.notes).toEqual([])
    expect(read('b.json')._incomplete.notes).toEqual(['アーカイブの取得: 1 件（B 2026-01-02: HTTP 500）'])
  })

  // 対照: 区間を渡さなければ台帳の全部が載る（成果物が 1 つのスクリプトはこちら）
  it('区間を渡さなければ台帳の全部が載る', () => {
    noteIncomplete('アーカイブの取得', 'A 2026-01-01: HTTP 500')
    const cp = checkpoint()
    noteIncomplete('アーカイブの取得', 'B 2026-01-02: HTTP 500')

    writeArtifact(path.join(dir, 'all.json'), {})
    expect(read('all.json')._incomplete.notes).toEqual([
      'アーカイブの取得: 2 件（A 2026-01-01: HTTP 500 / B 2026-01-02: HTTP 500）',
    ])
    // 同じ台帳から、区間を渡せば後半だけになる
    expect(incompleteNotes(cp)).toEqual(['アーカイブの取得: 1 件（B 2026-01-02: HTTP 500）'])
  })

  // 安全弁: 引き継いだ分も区間で切れること（上流の印が前の区間に属していたら載せない）
  it('引き継いだ印も区間で切れる', () => {
    noteIncomplete('上流', '失敗')
    writeArtifact(path.join(dir, 'up.json'), {})

    resetIncompletenessForTest()
    readArtifact(path.join(dir, 'up.json'), { source: 'up' })
    const cp = checkpoint()          // 引き継いだ後に区切る

    writeArtifact(path.join(dir, 'after.json'), {}, { since: cp })
    expect(read('after.json')._incomplete.notes).toEqual([])

    // 区間を渡さなければ引き継いだ分は載る（＝取りこぼしたわけではない）
    writeArtifact(path.join(dir, 'whole.json'), {})
    expect(read('whole.json')._incomplete.notes).toEqual(['上流: 1 件（失敗）'])
  })

  // ---- 対照: 印が無いときに余計なことをしない ----

  // **ファイルには必ず `_incomplete` を書く。** 「キーが無い」を「完全」ではなく
  // 「この仕組みを通っていない＝不明」と読ませるため（下の安全弁のテストと対になる）
  it('取りこぼしが無ければ、ファイルには空の notes だけを書く', () => {
    writeArtifact(path.join(dir, 'clean.json'), { codes: { 551: [1] } })

    const o = read('clean.json')
    expect(o.codes).toEqual({ 551: [1] })
    expect(o._incomplete).toEqual({ notes: [] })
    // 取りこぼしが無いのに警告文を置くと、平常時の出力が「疑わしい」と読める
    expect(o._incomplete.warning).toBeUndefined()
  })

  // **標準出力はファイルと前提が違う。** あちらは機械が読むので常に印の欄を置くが、
  // こちらは人が読むので平常時に余計なキーを混ぜない（既存の `withCompletenessMark` の判断）
  it('標準出力向けは、取りこぼしが無ければ結果をそのまま返す', () => {
    expect(markResult({ VXSE53: 8 })).toEqual({ VXSE53: 8 })

    noteIncomplete('アーカイブの取得', '2026-01-03: HTTP 500')
    const marked = markResult({ VXSE53: 8 }) as Record<string, any>
    expect(marked.VXSE53).toBe(8)                    // 集計は書き換えない
    expect(marked._incomplete.warning).toContain('「無い」の根拠にしないこと')
    expect(marked._incomplete.notes).toHaveLength(1)
  })

  // ---- 安全弁: 印が消える形を再現する ----

  // **これがこの仕組みの肝。** `_incomplete` を持たないファイルは「取りこぼしが無かった」
  // のではなく「この仕組みを通っていない」。無印を完全と読むと、旧い形のまま手元に残っている
  // 中間ファイルが黙って「完全」に化ける
  it('印の欄を持たないファイルを読んだら、完全とみなさず不明として積む', () => {
    fs.writeFileSync(path.join(dir, 'legacy.json'), JSON.stringify({ codes: {} }))

    readArtifact(path.join(dir, 'legacy.json'), { source: 'P2PQuake の履歴' })

    writeArtifact(path.join(dir, 'out.json'), {})
    const notes = read('out.json')._incomplete.notes as string[]
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('P2PQuake の履歴')
    expect(notes[0]).toContain('古い形')
  })

  // 旧 `withCompletenessMark` が書いた文字列形式。**読めるものは読む** ——
  // 形が違うことを理由に捨てると、上流が伝えてきた取りこぼしが消える
  it('旧い文字列形式の印も引き継ぐ', () => {
    fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({
      VXSE53: 0,
      _incomplete: '取得できなかった範囲が 3 件あります',
    }))

    readArtifact(path.join(dir, 'old.json'), { source: 'サンプル収集' })
    writeArtifact(path.join(dir, 'out.json'), {})

    expect(read('out.json')._incomplete.notes).toEqual([
      'サンプル収集: 取得できなかった範囲が 3 件あります',
    ])
  })

  // **ファイルが無いことは「0 件だった」ではない。** 既定で積み、任意の入力のときだけ
  // 呼び出し側が明示的に降りる
  it('ファイルが無ければ不明として積む（optional のときだけ積まない）', () => {
    const missing = path.join(dir, 'nope.json')

    expect(readArtifact(missing, { source: 'P2PQuake の履歴' })).toBeNull()
    expect(incompleteNotes()).toHaveLength(1)

    resetIncompletenessForTest()
    expect(readArtifact(missing, { source: 'P2PQuake の履歴', optional: true })).toBeNull()
    expect(incompleteNotes()).toHaveLength(0)
  })

  // 壊れたファイルを「空」と読まない。JSON が壊れているのは取りこぼしより重い事実
  it('読めないファイルは不明として積む（例外で走査全体を止めない）', () => {
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ これは JSON では')

    expect(readArtifact(path.join(dir, 'broken.json'), { source: '計測結果' })).toBeNull()
    expect(incompleteNotes()[0]).toContain('計測結果')
  })

  // ---- 迂回すると印が消えること（静的検査が要る理由） ----

  // **ヘルパーを作っても、通さない経路を足せば同じ穴が開く。**
  // ここで固定するのは「迂回すると実際に消える」という事実そのもの。
  // 迂回を禁じるのは `scripts/incompletenessPropagation.test.ts`（静的検査）の担当で、
  // このテストはその検査が守っている中身を示す
  it('素の JSON.parse で読むと印は引き継がれない（だから静的検査で禁じる）', () => {
    noteIncomplete('P2PQuake の履歴', 'code=552: HTTP 429')
    writeArtifact(path.join(dir, 'p2p-history.json'), { codes: {} })

    resetIncompletenessForTest()
    // 迂回（この書き方を静的検査が落とす）
    JSON.parse(fs.readFileSync(path.join(dir, 'p2p-history.json'), 'utf8'))
    writeArtifact(path.join(dir, 'out.json'), {})

    expect(read('out.json')._incomplete.notes).toEqual([])
  })

  // ---- 報告と終了コード ----

  // **exit code はここで立てない。** 副作用を「報告する関数」へ隠すと、テストが
  // ランナーの終了コードを汚す（`reportArchiveCacheStats` と同じ判断）
  it('報告は件数を返すだけで、終了コードを立てない', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const before = process.exitCode

    expect(reportIncompleteness('点検')).toBe(0)
    expect(err).not.toHaveBeenCalled()               // 平常時は黙る

    noteIncomplete('アーカイブの取得', '2026-01-03: HTTP 500')
    expect(reportIncompleteness('点検')).toBe(1)
    expect(err).toHaveBeenCalled()
    expect(process.exitCode).toBe(before)
  })

  // 人が読むレポートへ差す文面。**装飾を呼び出し側に書かせない** ——
  // 書かせると `.md` と `.txt` で文面が割れ、片方だけ古くなる
  it('レポート用の文面は、取りこぼしが無ければ空を返す', () => {
    expect(incompletenessBanner('markdown')).toEqual([])
    expect(incompletenessBanner('plain')).toEqual([])

    noteIncomplete('アーカイブの取得', '2026-01-03: HTTP 500')
    const md = incompletenessBanner('markdown') as string[]
    const txt = incompletenessBanner('plain') as string[]

    expect(md.every(l => l.startsWith('>'))).toBe(true)
    expect(txt.some(l => l.startsWith('>'))).toBe(false)
    // どちらも同じ事実を述べる（装飾だけが違う）
    expect(md.join('\n')).toContain('2026-01-03: HTTP 500')
    expect(txt.join('\n')).toContain('2026-01-03: HTTP 500')
  })

  // ---- リセット ----

  it('リセットは自分の分も引き継いだ分も空にする', () => {
    noteIncomplete('自分', '失敗')
    fs.writeFileSync(path.join(dir, 'up.json'), JSON.stringify({ _incomplete: { notes: ['上流: 1 件'] } }))
    readArtifact(path.join(dir, 'up.json'), { source: 'up' })
    expect(incompleteNotes().length).toBeGreaterThan(1)

    resetIncompletenessForTest()

    expect(incompleteNotes()).toEqual([])
  })
})
