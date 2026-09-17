import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error -- 型定義を持たない .mjs（`scripts/lib/stationSource.mjs` と同じ扱い）
import {
  sampleCollectionMarkPath, rareSampleCollectionMarkPath,
  clearCollectionMark, absorbSampleCollectionMarks,
} from './collection-mark.mjs'
// @ts-expect-error -- 同上
import {
  incompleteNotes, noteIncomplete, writeArtifact, resetIncompletenessForTest,
} from '../lib/incompleteness.mjs'

// 実電文サンプルの収集は成果物がファイルの山（XML・二進）なので、**取りこぼしを載せる場所が
// ディレクトリの中に無い**。札はその代わりで、下流（計測台・`triage.mjs`・
// `testdata-shapes.mjs`・`header-survey.mjs`）はこれを読んで収集の完全性を知る。
//
// **ここを固定するのは、1 巡目の敵対的レビューで実際に破れた形があるため。** 札を 1 枚に
// まとめていたので、取りこぼした収集の直後に別の対象を成功させただけで印が消えた
// （`fetch-rare-samples.mjs` は対象を変えて複数回走らせる設計）。「1 枚を共有すると印が消える」は
// スクリプト間だけでなく、**同じスクリプトの実行対象のあいだでも**成り立つ。
describe('収集の札', () => {
  let dir: string

  beforeEach(() => {
    resetIncompletenessForTest()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-mark-'))
  })
  afterEach(() => {
    // **モックを外すのが先。** このファイルは `fs.rmSync` / `fs.readdirSync` を差し替える
    // テストを持つので、後始末の側が差し替えられたままだと例外で落ち、**そのまま
    // `restoreAllMocks` に到達せず次のテストまで巻き添えにする**（実際に 2 件落ちた）。
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // 正: 対象ごとに別のファイルになること。**これが破れると後から走らせた対象の成否しか残らない**
  it('稀な種別の札は対象ごとに別のファイルになる', () => {
    const paths = ['eew', 'ixac41', 'type:VXSE60'].map(t => rareSampleCollectionMarkPath(dir, t))

    expect(new Set(paths).size).toBe(3)
    // ファイル名に使えない文字（`:`）が落ちていること
    for (const p of paths) expect(path.basename(p)).not.toContain(':')
  })

  // 正: 先に走らせた対象の取りこぼしが、後から走らせた対象の成功で消えないこと
  it('取りこぼした対象の印が、別の対象の成功で消えない', () => {
    noteIncomplete('アーカイブの取得', 'eew.forecast 一覧: HTTP 500')
    writeArtifact(rareSampleCollectionMarkPath(dir, 'eew'), { target: 'eew' })

    resetIncompletenessForTest()
    writeArtifact(rareSampleCollectionMarkPath(dir, 'ixac41'), { target: 'ixac41' })

    resetIncompletenessForTest()
    absorbSampleCollectionMarks(dir)

    expect(incompleteNotes()).toContain('アーカイブの取得: 1 件（eew.forecast 一覧: HTTP 500）')
  })

  // 正: 置いてある札を全部読むこと（どの対象を走らせたかは読む側からは分からない）
  it('置いてある稀な種別の札を全部読む', () => {
    for (const t of ['eew', 'ixac41']) {
      resetIncompletenessForTest()
      noteIncomplete('アーカイブの取得', `${t} の走査: HTTP 500`)
      writeArtifact(rareSampleCollectionMarkPath(dir, t), { target: t })
    }
    writeArtifact(sampleCollectionMarkPath(dir), { perType: {} })

    resetIncompletenessForTest()
    absorbSampleCollectionMarks(dir)

    const notes = incompleteNotes() as string[]
    expect(notes.some(n => n.includes('eew の走査'))).toBe(true)
    expect(notes.some(n => n.includes('ixac41 の走査'))).toBe(true)
  })

  // 安全弁: **札が無いことを「完全」と読まない。** 必須の札（サンプル収集）は無ければ印を積む
  it('必須の札が無ければ印を積む。稀な種別の札は無くても積まない', () => {
    absorbSampleCollectionMarks(dir)

    const notes = incompleteNotes() as string[]
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('実電文サンプルの収集')
  })

  // 安全弁: 走査の前に札を消す。**消したあと落ちたら「不明」へ倒れる**ことが前提
  it('札を消しても、対象違いの札は巻き込まない', () => {
    writeArtifact(rareSampleCollectionMarkPath(dir, 'eew'), { target: 'eew' })
    writeArtifact(rareSampleCollectionMarkPath(dir, 'ixac41'), { target: 'ixac41' })

    clearCollectionMark(rareSampleCollectionMarkPath(dir, 'eew'))

    expect(fs.existsSync(rareSampleCollectionMarkPath(dir, 'eew'))).toBe(false)
    expect(fs.existsSync(rareSampleCollectionMarkPath(dir, 'ixac41'))).toBe(true)
  })

  // 対照: 消す対象が無いのは正常（初回の走査）。印を積まない
  it('消す札が無いときは何も起きない', () => {
    clearCollectionMark(rareSampleCollectionMarkPath(dir, 'eew'))

    expect(incompleteNotes()).toHaveLength(0)
  })

  // 安全弁: **消せなかったことは印として残す。** 標準エラーだけに出すと、この仕組みが
  // 排除したはずの「見えない失敗」へ戻る（消せないまま走査が落ちると、古い札が
  // 「今回も完了した」として読まれる）
  it('札を消せなかったら印を積む', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(fs, 'rmSync').mockImplementation(() => { throw new Error('EBUSY') })

    clearCollectionMark(sampleCollectionMarkPath(dir))

    const notes = incompleteNotes() as string[]
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('札の初期化')
  })

  // 安全弁: ディレクトリが無いだけなら黙る（必須の札の側が「入力がありません」を積む）。
  // それ以外の理由で読めないなら、**任意の入力でも印を積む** —— 黙ると痕跡が残らない
  it('札を探せない理由が「まだ無い」以外なら印を積む', () => {
    // ディレクトリが無い場合（＝まだ収集していない）は、必須の札の 1 件だけ
    absorbSampleCollectionMarks(path.join(dir, 'nope'))
    expect(incompleteNotes()).toHaveLength(1)

    resetIncompletenessForTest()
    const err = Object.assign(new Error('EACCES'), { code: 'EACCES' })
    vi.spyOn(fs, 'readdirSync').mockImplementation(() => { throw err })

    absorbSampleCollectionMarks(dir)

    const notes = incompleteNotes() as string[]
    expect(notes.some(n => n.includes('稀な種別の収集'))).toBe(true)
  })
})
