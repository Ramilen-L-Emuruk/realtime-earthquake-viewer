import { describe, it, expect } from 'vitest'
import {
  DiagnosticCapture,
  describeEvent,
  encodeIntensity,
  LEAD_FRAMES,
  OPEN_COOLDOWN_MS,
  TAIL_FRAMES,
  type CaptureSeed,
} from './detectionDiagnostics'
import { initGates } from './kyoshinDetector'
import type { ConfirmSnapshot, DetectionEvent } from './kyoshinDetector'

/** 最小の記録種。イベント ID と確信度だけを変えて使う。 */
function seed(
  id: string,
  dataTimeMs: number,
  confidence = 'likely',
  confirmedBy: ConfirmSnapshot | null = null,
): CaptureSeed {
  return {
    dataTimeMs,
    siteConfigId: '20260123000000',
    sites: [[35, 139]],
    event: {
      id,
      confidence,
      lastSize: 3,
      maxIntensity: 0.5,
      epicenter: [35, 139],
      members: [],
      gates: initGates(),
    },
    confirmedBy,
    learned: null,
  }
}

/** 確定の内訳。`atMs`（確定した時刻）が「どちらを採るか」の比較に使われる。 */
function snapshot(size: number, atMs = 0): ConfirmSnapshot {
  return { atMs, size, intensity: 3.0, gates: initGates() }
}

/** フレームを n 本流す。時刻は 1 秒刻み。 */
function feed(c: DiagnosticCapture, from: number, n: number): number {
  let t = from
  for (let i = 0; i < n; i++, t += 1000) c.pushFrame(t, 'abc')
  return t
}

describe('encodeIntensity', () => {
  it('震度インデックスを 1 文字 1 観測点の文字列へ戻す（services/kyoshin.ts の逆変換）', () => {
    const indices = [0, 1, 20, -1]
    expect(encodeIntensity(indices)).toBe(indices.map((v) => String.fromCharCode(v + 100)).join(''))
    // 受け取り側（charCode - 100）で元に戻ること
    expect(Array.from(encodeIntensity(indices), (ch) => ch.charCodeAt(0) - 100)).toEqual(indices)
  })
})

describe('DiagnosticCapture', () => {
  it('検知の前後を切り出す（前は直近 LEAD_FRAMES、後ろは TAIL_FRAMES たまってから確定）', () => {
    const c = new DiagnosticCapture()
    const t = feed(c, 0, LEAD_FRAMES + 10) // 前側を十分に貯める
    c.open(seed('evt-1', t), '9.9.9', 'dmdss')

    // 後ろ側が足りないうちは確定しない
    feed(c, t, TAIL_FRAMES - 1)
    expect(c.takeFinished()).toHaveLength(0)

    feed(c, t + (TAIL_FRAMES - 1) * 1000, 1)
    const done = c.takeFinished()
    expect(done).toHaveLength(1)
    expect(done[0].event.id).toBe('evt-1')
    expect(done[0].version).toBe('9.9.9')
    expect(done[0].variant).toBe('dmdss')
    // 前側（LEAD_FRAMES + 検知フレーム）と後ろ側が入っている
    expect(done[0].frames.length).toBe(LEAD_FRAMES + 1 + TAIL_FRAMES)
    // データ時刻の昇順
    const ms = done[0].frames.map((f) => f.ms)
    expect([...ms].sort((a, b) => a - b)).toEqual(ms)
  })

  it('同じイベントでは二度開かない（faint→likely→confirmed で同じ記録が並ばない）', () => {
    const c = new DiagnosticCapture()
    const t = feed(c, 0, 5)
    c.open(seed('evt-1', t), '1.0.0', 'standard')
    c.open(seed('evt-1', t + 1000), '1.0.0', 'standard') // 確信度が上がって再度呼ばれた想定
    feed(c, t, TAIL_FRAMES)
    expect(c.takeFinished()).toHaveLength(1)
  })

  it('間隔を空ければ別のイベントは別の記録になる', () => {
    const c = new DiagnosticCapture()
    const t = feed(c, 0, 5)
    c.open(seed('evt-1', t), '1.0.0', 'standard')
    c.open(seed('evt-2', t + OPEN_COOLDOWN_MS), '1.0.0', 'standard')
    feed(c, t, TAIL_FRAMES)
    expect(c.takeFinished().map((r) => r.event.id).sort()).toEqual(['evt-1', 'evt-2'])
  })

  it('立て続けの別イベントは記録を開かない（1 つの地震が上限を食い潰さないため）', () => {
    // 揺れが広がる過程で成分が分かれ、別イベントとして次々に立ち上がる。窓は互いに重なっており
    // 中身もほとんど同じなので、先頭の 1 本だけ残す
    const c = new DiagnosticCapture()
    const t = feed(c, 0, 5)
    c.open(seed('evt-1', t), '1.0.0', 'standard')
    c.open(seed('evt-2', t + 3000), '1.0.0', 'standard')
    c.open(seed('evt-3', t + 10_000), '1.0.0', 'standard')
    feed(c, t, TAIL_FRAMES)
    expect(c.takeFinished().map((r) => r.event.id)).toEqual(['evt-1'])
  })

  it('後から育った確信度を記録に残す（抑えた分と画面に出た検知を見分けるため）', () => {
    const c = new DiagnosticCapture()
    const t = feed(c, 0, 5)
    // 開いた時点は faint（周囲の裏付けが取れていない）
    c.open(seed('evt-1', t, 'faint'), '1.0.0', 'standard')
    // その後 confirmed まで育つ
    c.open(seed('evt-1', t + 2000, 'confirmed'), '1.0.0', 'standard')
    feed(c, t, TAIL_FRAMES)
    const done = c.takeFinished()
    expect(done[0].event.confidence).toBe('faint') // 開いた瞬間の姿はそのまま
    expect(done[0].reachedConfidence).toBe('confirmed') // 到達した先も分かる
  })

  // 正: 記録を開いた後に確定へ育っても、その内訳が記録に残る
  it('開いた後で確定した場合も、確定の内訳を記録に残す', () => {
    const c = new DiagnosticCapture()
    const t = feed(c, 0, 5)
    // 開いた時点は faint で、まだ確定していない
    c.open(seed('evt-1', t, 'faint'), '1.0.0', 'standard')
    // 2 フレーム後に確定へ育つ
    c.open(seed('evt-1', t + 2000, 'confirmed', snapshot(6)), '1.0.0', 'standard')
    feed(c, t, TAIL_FRAMES)
    const done = c.takeFinished()
    expect(done[0].confirmedBy?.size).toBe(6)
    // 開いた瞬間のイベントの姿は据え置き（reachedConfidence と同じ切り分け）
    expect(done[0].event.confidence).toBe('faint')
  })

  // 対照: 確定しなかった記録は内訳を持たない
  it('確定しなかった記録の confirmedBy は null', () => {
    const c = new DiagnosticCapture()
    const t = feed(c, 0, 5)
    c.open(seed('evt-1', t, 'likely'), '1.0.0', 'standard')
    c.open(seed('evt-1', t + 2000, 'faint'), '1.0.0', 'standard')
    feed(c, t, TAIL_FRAMES)
    expect(c.takeFinished()[0].confirmedBy).toBeNull()
  })

  // 安全弁: 選ぶ基準は到着順ではなく確定時刻。エンジン側の併合（より早く確定したほうへ
  // 差し替える）と基準を揃えないと、画面が出している根拠と記録が食い違ったまま固定される
  it('後から届いた内訳でも、確定が早ければそちらを採る（併合で差し替わる経路）', () => {
    const c = new DiagnosticCapture()
    const t = feed(c, 0, 5)
    c.open(seed('evt-1', t, 'confirmed', snapshot(4, t)), '1.0.0', 'standard')
    // 併合で「もっと早く確定していた別イベントの内訳」が持ち込まれる
    c.open(seed('evt-1', t + 2000, 'confirmed', snapshot(9, t - 3000)), '1.0.0', 'standard')
    feed(c, t, TAIL_FRAMES)
    expect(c.takeFinished()[0].confirmedBy?.size).toBe(9)
  })

  // 対照: 確定が遅いほうへは差し替えない（単に後から届いただけでは動かない）
  it('後から届いた内訳の確定が遅ければ採らない', () => {
    const c = new DiagnosticCapture()
    const t = feed(c, 0, 5)
    c.open(seed('evt-1', t, 'confirmed', snapshot(4, t)), '1.0.0', 'standard')
    c.open(seed('evt-1', t + 2000, 'confirmed', snapshot(9, t + 2000)), '1.0.0', 'standard')
    feed(c, t, TAIL_FRAMES)
    expect(c.takeFinished()[0].confirmedBy?.size).toBe(4)
  })

  it('確信度は上がる方向にだけ動かす（保持で下がっても到達点は残る）', () => {
    const c = new DiagnosticCapture()
    const t = feed(c, 0, 5)
    c.open(seed('evt-1', t, 'likely'), '1.0.0', 'standard')
    c.open(seed('evt-1', t + 2000, 'faint'), '1.0.0', 'standard')
    feed(c, t, TAIL_FRAMES)
    expect(c.takeFinished()[0].reachedConfidence).toBe('likely')
  })

  it('flush は後ろ側が足りなくても確定する（画面を閉じるときフレームがもう来ない）', () => {
    const c = new DiagnosticCapture()
    const t = feed(c, 0, 5)
    c.open(seed('evt-1', t), '1.0.0', 'standard')
    feed(c, t, 3)
    expect(c.takeFinished()).toHaveLength(0)
    const flushed = c.flush()
    expect(flushed).toHaveLength(1)
    expect(flushed[0].frames.length).toBeLessThan(TAIL_FRAMES)
  })

  it('reset は溜めた分と開いている記録を捨てる（観測点集合が入れ替わると座標と値の対応が変わる）', () => {
    const c = new DiagnosticCapture()
    let t = feed(c, 0, 5)
    c.open(seed('evt-1', t), '1.0.0', 'standard')
    c.reset()
    t = feed(c, t, TAIL_FRAMES)
    expect(c.takeFinished()).toHaveLength(0)
    // reset 後は同じ ID でも開き直せる（時刻は前へ進める。後退させると不連続として捨てられる）
    c.open(seed('evt-1', t), '1.0.0', 'standard')
    feed(c, t, TAIL_FRAMES)
    expect(c.takeFinished()).toHaveLength(1)
  })

  it('データ時刻が後退したら溜めた分を捨てる（ライブ→リプレイの切替）', () => {
    // 捨てないと 2 つ壊れる。ライブと過去のフレームが混ざった記録ができること、
    // クールダウンの引き算が負値になって記録が二度と開かれないこと
    const c = new DiagnosticCapture()
    const live = 1_700_000_000_000
    feed(c, live, 5)
    c.open(seed('evt-live', live + 5000), '1.0.0', 'standard')
    // 過去へ巻き戻る（リプレイ開始）
    const past = live - 30 * 24 * 3600 * 1000
    feed(c, past, 5)
    expect(c.takeFinished()).toHaveLength(0) // 開いていた記録も捨てられる
    // 巻き戻った先でも新しい記録を開ける
    c.open(seed('evt-replay', past + 5000), '1.0.0', 'standard')
    feed(c, past + 5000, TAIL_FRAMES)
    const done = c.takeFinished()
    expect(done.map((r) => r.event.id)).toEqual(['evt-replay'])
    // 混ざっていないこと（フレームはすべて巻き戻った先の時刻）
    expect(done[0].frames.every((f) => f.ms < live)).toBe(true)
  })

  it('データ時刻が大きく飛んでも捨てる（欠測で数分止まった後の復帰）', () => {
    const c = new DiagnosticCapture()
    const t = feed(c, 0, 5)
    c.open(seed('evt-1', t), '1.0.0', 'standard')
    feed(c, t + 5 * 60 * 1000, TAIL_FRAMES) // 5 分飛ぶ
    expect(c.takeFinished()).toHaveLength(0)
  })

  it('取り出した記録は内部から消える（同じものを二度保存しない）', () => {
    const c = new DiagnosticCapture()
    const t = feed(c, 0, 5)
    c.open(seed('evt-1', t), '1.0.0', 'standard')
    feed(c, t, TAIL_FRAMES)
    expect(c.takeFinished()).toHaveLength(1)
    expect(c.takeFinished()).toHaveLength(0)
  })
})

describe('describeEvent', () => {
  it('メンバーの座標と値を並べる（観測点キーから座標を引く）', () => {
    const sites: [number, number][] = [
      [35.0, 139.0],
      [35.1, 139.1],
    ]
    const keyToIndex = new Map([
      ['35.000,139.000', 0],
      ['35.100,139.100', 1],
    ])
    const e = {
      id: 'evt-1',
      confidence: 'likely',
      memberKeys: ['35.000,139.000', '35.100,139.100', '欠番'],
      lastSize: 2,
      maxIntensity: 0.5,
      epicenter: [35.05, 139.05],
    } as unknown as DetectionEvent
    const d = describeEvent(e, keyToIndex, sites, [7, 6, 0])

    // 引けなかったキーは落ちる（座標が分からないので記録しても再生できない）
    expect(d.members).toEqual([
      { lat: 35.0, lng: 139.0, value: 0.5 },
      { lat: 35.1, lng: 139.1, value: 0.0 },
    ])
    expect(d.id).toBe('evt-1')
  })
})
