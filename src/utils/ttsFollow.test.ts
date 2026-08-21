// 読み上げ追従の計算のテスト。
//
// チャンクの分割は手書きせず `splitIntoChunks` を通す。分割の条件（句読点・5 文字未満の
// 結合）を変えたときに、テストだけが古い境界を前提に通り続けるのを防ぐため。
import { describe, it, expect } from 'vitest'
import { splitIntoChunks } from './voicevox'
import {
  createSpeechFollowController,
  joinSegments,
  mapChunksToRefs,
  plain,
  planFollowScroll,
  type SpeechFollowSession,
  type SpeechRef,
  type SpeechSegment,
} from './ttsFollow'

const area = (name: string, code?: string): SpeechRef => ({ kind: 'area', name, code })
const station = (name: string): SpeechRef => ({ kind: 'station', name })
const seg = (text: string, ...refs: SpeechRef[]): SpeechSegment => ({ text, refs })

/** チャンクごとの対象を「名前の配列」に潰す（比較しやすくするため）。 */
function refNames(segments: SpeechSegment[]): string[][] {
  const chunks = splitIntoChunks(joinSegments(segments))
  return mapChunksToRefs(segments, chunks).map(refs => refs.map(r => r.name))
}

describe('mapChunksToRefs', () => {
  it('区域の列挙が 1 チャンクにまとまっても、含まれる区域をすべて返す', () => {
    // 「岩手県、」は 4 文字なので MIN_CHUNK により次と結合され、1 チャンクに 2 区域入る
    const segments = [
      plain('大津波警報。'),
      seg('岩手県', area('岩手県', '030')),
      plain('、'),
      seg('宮城県', area('宮城県', '040')),
      plain('、'),
      seg('福島県', area('福島県', '050')),
      plain('に大津波警報が発表されました。'),
    ]
    const chunks = splitIntoChunks(joinSegments(segments))
    expect(chunks).toEqual([
      '大津波警報。',
      '岩手県、宮城県、',
      '福島県に大津波警報が発表されました。',
    ])
    expect(refNames(segments)).toEqual([[], ['岩手県', '宮城県'], ['福島県']])
  })

  it('同じ区域が 2 回読まれる文（列挙 → 予想最大波高）で、どちらのチャンクでも引ける', () => {
    const segments = [
      seg('岩手県', area('岩手県', '030')),
      plain('、'),
      seg('宮城県', area('宮城県', '040')),
      plain('に大津波警報が発表されました。予想最大波高は、'),
      seg('岩手県', area('岩手県', '030')),
      plain('、'),
      seg('宮城県', area('宮城県', '040')),
      plain('で10メートル以上です。'),
    ]
    const names = refNames(segments)
    // 前半と後半でそれぞれ引けている（2 周目で「戻る」判定ができる根拠）
    expect(names.filter(n => n.includes('岩手県')).length).toBe(2)
    expect(names.filter(n => n.includes('宮城県')).length).toBe(2)
  })

  it('区域と観測点が同じチャンクに入ったら観測点だけを返す', () => {
    const segments = [
      plain('津波観測情報。'),
      seg('岩手県', area('岩手県', '030')),
      plain('、'),
      seg('宮古', station('宮古')),
      plain('で1.2メートル、'),
      seg('釜石', station('釜石')),
      plain('で0.8メートルです。'),
    ]
    const chunks = splitIntoChunks(joinSegments(segments))
    // 「岩手県、」が短く結合され、区域名と観測点名が同居する
    expect(chunks.some(c => c.includes('岩手県') && c.includes('宮古'))).toBe(true)

    const names = refNames(segments)
    const merged = names.find(n => n.includes('宮古'))
    expect(merged).toEqual(['宮古'])
    // 区域だけを指すチャンクはどこにも無い（観測点に譲っている）
    expect(names.every(n => !n.includes('岩手県'))).toBe(true)
  })

  it('対象を持たないチャンクは空配列を返す', () => {
    const segments = [
      seg('岩手県', area('岩手県', '030')),
      plain('に大津波警報が発表されました。ただちに高台へ避難してください。'),
    ]
    const names = refNames(segments)
    expect(names[names.length - 1]).toEqual([])
  })

  it('戻り値の長さはチャンク数と一致する', () => {
    const segments = [
      plain('大津波警報。'),
      seg('岩手県', area('岩手県', '030')),
      plain('に大津波警報が発表されました。ただちに高台へ避難してください。'),
    ]
    const chunks = splitIntoChunks(joinSegments(segments))
    expect(mapChunksToRefs(segments, chunks).length).toBe(chunks.length)
  })

  it('code が違えば同名でも別の対象として扱い、code が無ければ名前で照合する', () => {
    const segments = [
      seg('宮城県', area('宮城県', '040')),
      plain('、'),
      seg('宮城県', area('宮城県', '041')),
      plain('に大津波警報が発表されました。'),
    ]
    const chunks = splitIntoChunks(joinSegments(segments))
    const refs = mapChunksToRefs(segments, chunks)
    const merged = refs.find(r => r.length > 1)
    expect(merged).toBeDefined()
    expect(merged!.length).toBe(2)
  })

  it('全文に無いチャンクを渡されても取り違えずに空を返す', () => {
    const segments = [seg('岩手県', area('岩手県', '030')), plain('に大津波警報。')]
    expect(mapChunksToRefs(segments, ['まったく別の文。'])).toEqual([[]])
  })
})

describe('planFollowScroll', () => {
  // 視野は 100..500（高さ 400）で固定する。
  // 戻り値は「新しい scrollTop」なので、基準を 0 にしておけば移動量とそのまま読み比べられる。
  const view = { viewTop: 100, viewBottom: 500, currentScrollTop: 0, maxScrollTop: 100000 }

  it('いま読んでいる箇所が視野に収まっていれば動かさない', () => {
    const next = planFollowScroll({
      ...view,
      currentRects: [{ top: 200, bottom: 240 }],
      upcomingRects: [{ top: 900, bottom: 940 }],
    })
    expect(next).toBeNull()
  })

  it('視野の下に出たら、これから読む箇所も入る位置まで送る', () => {
    const next = planFollowScroll({
      ...view,
      currentRects: [{ top: 520, bottom: 560 }],
      upcomingRects: [
        { top: 600, bottom: 640 },
        { top: 700, bottom: 740 },
      ],
    })
    // 520..740（高さ 220）が収まるので、上端 520 を視野上端 100 に合わせる
    expect(next).toBe(420)
  })

  it('これから読む箇所が視野の高さに入らなくなったら、そこで打ち切る', () => {
    const next = planFollowScroll({
      ...view,
      currentRects: [{ top: 520, bottom: 560 }],
      upcomingRects: [
        { top: 600, bottom: 640 },
        { top: 1200, bottom: 1240 }, // 520..1240 は高さ 720 で入らない
      ],
    })
    expect(next).toBe(420)
  })

  it('これから読む箇所が上に残っているなら、それも視野に含める', () => {
    // 2 周目で同じ区域を読み直す文がこの形になる。上を含めておけば戻るスクロールが起きない
    const next = planFollowScroll({
      ...view,
      currentRects: [{ top: 520, bottom: 560 }],
      upcomingRects: [{ top: 200, bottom: 240 }],
    })
    // 200..560（高さ 360）が収まるので上端 200 に合わせる
    expect(next).toBe(100)
  })

  it('いま読んでいる箇所だけで視野の高さを超えるなら、その上端を視野の上端に合わせる', () => {
    const next = planFollowScroll({
      ...view,
      currentRects: [{ top: 520, bottom: 1100 }], // 高さ 580 > 400
      upcomingRects: [{ top: 200, bottom: 240 }],
    })
    // 上端に揃えるだけ。これから読む箇所は考慮しない
    expect(next).toBe(420)
  })

  it('視野の上に出たら戻る', () => {
    const next = planFollowScroll({
      ...view,
      currentScrollTop: 1000,
      currentRects: [{ top: 20, bottom: 60 }],
      upcomingRects: [],
    })
    expect(next).toBe(920)
  })

  it('複数の箇所のうち 1 つでも視野から外れていれば送る', () => {
    const next = planFollowScroll({
      ...view,
      currentRects: [
        { top: 400, bottom: 440 },
        { top: 480, bottom: 520 }, // 下端が視野の外
      ],
      upcomingRects: [],
    })
    expect(next).toBe(300)
  })

  it('移動量が 1px 以下なら動かさない', () => {
    const next = planFollowScroll({
      ...view,
      currentRects: [{ top: 99, bottom: 140 }],
      upcomingRects: [],
    })
    expect(next).toBeNull()
  })

  it('読んでいる箇所が無いとき・視野の高さが 0 のときは動かさない', () => {
    expect(planFollowScroll({ ...view, currentRects: [], upcomingRects: [] })).toBeNull()
    expect(planFollowScroll({
      ...view,
      viewTop: 300,
      viewBottom: 300,
      currentRects: [{ top: 900, bottom: 940 }],
      upcomingRects: [],
    })).toBeNull()
  })

  it('行き先は現在位置からの相対で決まる', () => {
    const next = planFollowScroll({
      ...view,
      currentScrollTop: 1000,
      currentRects: [{ top: 520, bottom: 560 }],
      upcomingRects: [],
    })
    expect(next).toBe(1420)
  })

  // `scrollTo` はブラウザ側で到達できる範囲に丸められる。理論値を返すと呼び出し側が持つ
  // 「行き先」に永久に着かず、補正がずれたまま積もる。
  it('到達できる上限を超える行き先は丸める', () => {
    const next = planFollowScroll({
      ...view,
      currentScrollTop: 0,
      maxScrollTop: 200,
      currentRects: [{ top: 520, bottom: 560 }],
      upcomingRects: [],
    })
    expect(next).toBe(200)
  })

  it('丸めた結果ほとんど動かないなら動かさない（末尾に張り付いている状態）', () => {
    const next = planFollowScroll({
      ...view,
      currentScrollTop: 200,
      maxScrollTop: 200,
      currentRects: [{ top: 520, bottom: 560 }],
      upcomingRects: [],
    })
    expect(next).toBeNull()
  })

  it('上へ戻るときも 0 より小さくならない', () => {
    const next = planFollowScroll({
      ...view,
      currentScrollTop: 30,
      currentRects: [{ top: 20, bottom: 60 }],
      upcomingRects: [],
    })
    expect(next).toBe(0)
  })
})

// 世代の管理。読み上げが続けて起きたときの取り違えは実機では再現しにくいので、ここで固定する。
describe('createSpeechFollowController', () => {
  function setup() {
    const changes: (SpeechFollowSession | null)[] = []
    const c = createSpeechFollowController(s => changes.push(s))
    return { c, changes }
  }

  it('開始と終了でだけ通知する（チャンクの予約では通知しない）', () => {
    const { c, changes } = setup()
    const token = c.begin([plain('大津波警報。')])
    expect(changes).toHaveLength(1)

    c.schedule(token, 0, 1.5, ['大津波警報。'])
    c.schedule(token, 1, 3.0, ['大津波警報。'])
    // 予約は通知しない（毎チャンク通知すると全タブが再描画される）
    expect(changes).toHaveLength(1)
    expect(c.current?.schedule).toEqual([{ index: 0, startAt: 1.5 }, { index: 1, startAt: 3.0 }])

    c.end(token)
    expect(changes).toEqual([expect.objectContaining({ token }), null])
  })

  it('古い世代の予約は捨てる', () => {
    const { c } = setup()
    const first = c.begin([plain('ひとつめ。')])
    const second = c.begin([plain('ふたつめ。')])
    expect(second).not.toBe(first)

    c.schedule(first, 0, 1.5, ['ひとつめ。'])
    // 入れ替わった後に届いた古い通知が、新しいセッションを汚さない
    expect(c.current?.token).toBe(second)
    expect(c.current?.schedule).toEqual([])

    c.schedule(second, 0, 2.0, ['ふたつめ。'])
    expect(c.current?.schedule).toEqual([{ index: 0, startAt: 2.0 }])
  })

  it('古い世代の終了で、新しい読み上げの追従を殺さない', () => {
    // これが本題。割り込む側は先行合成が済んでいれば即座に鳴り出す一方、割り込まれた側は
    // まだ完了を待っている。無条件に消すと、後の読み上げの間ずっと画面が動かなくなる。
    const { c, changes } = setup()
    const first = c.begin([plain('ひとつめ。')])
    const second = c.begin([plain('ふたつめ。')])

    c.end(first)
    expect(c.current?.token).toBe(second)
    expect(changes[changes.length - 1]).not.toBeNull()

    c.end(second)
    expect(c.current).toBeNull()
  })

  it('reset は世代を問わず打ち切る', () => {
    const { c, changes } = setup()
    c.begin([plain('リプレイ前の読み上げ。')])
    c.reset()
    expect(c.current).toBeNull()
    expect(changes[changes.length - 1]).toBeNull()
  })

  it('打ち切るものが無ければ通知しない', () => {
    const { c, changes } = setup()
    c.reset()
    c.end(999)
    expect(changes).toEqual([])
  })
})
