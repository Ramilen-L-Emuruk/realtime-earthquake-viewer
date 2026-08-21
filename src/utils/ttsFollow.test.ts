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
  return mapChunksToRefs(segments, chunks)
    .map(refs => refs.map(r => (r.kind === 'grade' ? r.grade : r.name)))
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

  // 等級のカードは区域行をすべて抱えているので、区域と同居したら区域を採る（範囲が視野を
  // 超えてカードの先頭へ揃え直すだけになり、読んでいる区域が画面に出ないため）。
  it('等級と区域が同じチャンクに入ったら区域だけを返す', () => {
    const segments = [
      { text: '津波警報。', refs: [{ kind: 'grade', grade: 'Warning' } as SpeechRef] },
      seg('青森県太平洋沿岸', area('青森県太平洋沿岸', '060')),
      plain('に津波警報が発表されました。'),
    ]
    const chunks = splitIntoChunks(joinSegments(segments))
    const refs = mapChunksToRefs(segments, chunks)
    // 「津波警報。」は 5 文字なので独立し、等級だけを指すチャンクになる
    expect(refs[0]).toEqual([{ kind: 'grade', grade: 'Warning' }])
    // 区域名を含むチャンクでは区域が勝つ
    const merged = refs.find(r => r.some(x => x.kind === 'area'))
    expect(merged?.every(x => x.kind === 'area')).toBe(true)
  })

  it('等級だけを指すチャンクは等級を返す', () => {
    const segments = [
      plain('また、'),
      { text: '次の地域に津波注意報が発表されています。', refs: [{ kind: 'grade', grade: 'Watch' } as SpeechRef] },
      seg('北海道太平洋沿岸東部', area('北海道太平洋沿岸東部', '080')),
      plain('で1メートルが予想されています。'),
    ]
    const names = refNames(segments)
    expect(names[0]).toEqual(['Watch'])
    expect(names.some(n => n.includes('北海道太平洋沿岸東部'))).toBe(true)
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

  // 送り先は視野の上端にぴったり貼り付けず、少し下げる（貼り付けるとカードの縁が切れて窮屈）。
  // 判定も同じ余白を見込む ―― 送り先だけ下げると、余白のぶん足りないだけで毎チャンク送り直す。
  it('送り先の上に余白を残し、収まりの判定も同じ基準で見る', () => {
    // 視野 100..500 に対し、上端から 24px の位置に置く
    const next = planFollowScroll({
      ...view,
      currentRects: [{ top: 520, bottom: 560 }],
      upcomingRects: [],
    })
    expect(next).toBe(396) // 520 - 100 - 24
    // 余白の内側（上端から 24px 未満）にいる箇所は「収まっていない」と見る
    expect(planFollowScroll({
      ...view,
      currentScrollTop: 500,
      currentRects: [{ top: 110, bottom: 150 }],
      upcomingRects: [],
    })).not.toBeNull()
    // 余白より下にいれば動かさない
    expect(planFollowScroll({
      ...view,
      currentScrollTop: 500,
      currentRects: [{ top: 130, bottom: 170 }],
      upcomingRects: [],
    })).toBeNull()
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
    expect(next).toBe(396)
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
    expect(next).toBe(396)
  })

  it('これから読む箇所が上に残っているなら、それも視野に含める', () => {
    // 2 周目で同じ区域を読み直す文がこの形になる。上を含めておけば戻るスクロールが起きない
    const next = planFollowScroll({
      ...view,
      currentRects: [{ top: 520, bottom: 560 }],
      upcomingRects: [{ top: 200, bottom: 240 }],
    })
    // 200..560（高さ 360）が収まるので上端 200 に合わせる
    expect(next).toBe(76)
  })

  it('いま読んでいる箇所だけで視野の高さを超えるなら、その上端を視野の上端に合わせる', () => {
    const next = planFollowScroll({
      ...view,
      currentRects: [{ top: 520, bottom: 1100 }], // 高さ 580 > 400
      upcomingRects: [{ top: 200, bottom: 240 }],
    })
    // 上端に揃えるだけ。これから読む箇所は考慮しない
    expect(next).toBe(396)
  })

  it('視野の上に出たら戻る', () => {
    const next = planFollowScroll({
      ...view,
      currentScrollTop: 1000,
      currentRects: [{ top: 20, bottom: 60 }],
      upcomingRects: [],
    })
    expect(next).toBe(896)
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
    expect(next).toBe(276)
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
    expect(next).toBe(1396)
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

  // 送り先は上に余白を残すので、収まりの判定も同じ基準（余白を除いた高さ）で行う必要がある。
  // 揃えていないと、上の未読を含めるために伸ばしすぎて、**いま読んでいる箇所が視野から出る**。
  it('上の未読を含めるときも、いま読んでいる箇所が視野から出ない', () => {
    const next = planFollowScroll({
      ...view,
      currentRects: [{ top: 520, bottom: 560 }],
      // 170..560 は高さ 390。余白を見込まない 400 で測ると「収まる」ことになり、上端 170 に
      // 揃えてしまう。その位置では読んでいる箇所の下端が視野の下へ 14px はみ出す
      upcomingRects: [{ top: 170, bottom: 210 }],
    })
    expect(next).not.toBeNull()
    // 送った量ぶん要素は上へ動く。動いた後の下端が視野の下端を超えないこと
    expect(560 - (next! - view.currentScrollTop)).toBeLessThanOrEqual(view.viewBottom)
  })

  it('収まりの判定は余白を除いた高さで行う（境界）', () => {
    // 実効視野は 400 - 24 = 376
    const inside = planFollowScroll({
      ...view,
      currentRects: [{ top: 520, bottom: 560 }],
      upcomingRects: [{ top: 184, bottom: 224 }], // 184..560 = ちょうど 376
    })
    expect(inside).toBe(60) // 184 - 100 - 24
    const outside = planFollowScroll({
      ...view,
      currentRects: [{ top: 520, bottom: 560 }],
      upcomingRects: [{ top: 183, bottom: 223 }], // 183..560 = 377 で 1px 超える
    })
    expect(outside).toBe(396) // 足さず、読んでいる箇所の上端に揃える
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

  // 前置き（等級カードの帯）の扱い。**これを `currentRects` に混ぜると区域の追従が死ぬ。**
  // 範囲の上端が常に帯になるため、等級のところで一度寄せた後は行き先が現在位置と一致し、
  // 区域行がどれだけ見切れていても動かない。実地震のリプレイでこの形に踏み込んだ。
  describe('前置き（contextRects）', () => {
    it('前置きが視野の外にあっても、それだけを理由には動かさない', () => {
      const next = planFollowScroll({
        ...view,
        currentRects: [{ top: 200, bottom: 240 }], // 視野内
        contextRects: [{ top: -300, bottom: -260 }], // 上に流れて見えない
        upcomingRects: [],
      })
      expect(next).toBeNull()
    })

    it('前置きが視野の上端にいても、読んでいる箇所が視野の外なら送る', () => {
      // 等級で寄せた直後の状態。帯は上端＋余白の位置にいる
      const next = planFollowScroll({
        ...view,
        currentRects: [{ top: 900, bottom: 940 }], // 下に見切れている区域行
        contextRects: [{ top: 124, bottom: 164 }], // 帯（上端 100 ＋余白 24）
        upcomingRects: [],
      })
      // 帯を含めると 124..940（高さ 816）で視野 400 に入らないので捨て、区域行の上端に揃える
      expect(next).toBe(776) // 900 - 100 - 24
    })

    it('前置きを含めても収まるなら、前置きの上端に揃える', () => {
      const next = planFollowScroll({
        ...view,
        currentRects: [{ top: 600, bottom: 640 }],
        contextRects: [{ top: 520, bottom: 560 }],
        upcomingRects: [],
      })
      // 520..640（高さ 120）が収まるので帯の上端に合わせる
      expect(next).toBe(396) // 520 - 100 - 24
    })

    // 前置きを後回しにすると、区域の多い等級カードでは続きの区域で視野が埋まり、
    // 帯が入る余地が残らない。等級が見えている方が「どの警報の話か」が伝わる。
    it('前置きはこれから読む箇所より先に入れる', () => {
      const next = planFollowScroll({
        ...view,
        currentRects: [{ top: 520, bottom: 560 }],
        contextRects: [{ top: 400, bottom: 440 }],
        // 実効視野は 376（400 - 余白 24）。読んでいる箇所＋これから読む箇所は 520..890 = 370 で
        // 収まるが、そこへ帯を足すと 400..890 = 490 で入らない。**どちらを先に試すかで結果が変わる**
        upcomingRects: [{ top: 850, bottom: 890 }],
      })
      // 帯を先に入れて 400..560。続く区域を足すと 490 になるので打ち切り、帯の上端に揃う
      expect(next).toBe(276) // 400 - 100 - 24
    })

    // 混ぜたときに何が起きるかを記録として残す。範囲の上端に揃えるという定義から導かれる
    // 正しい挙動だが、**前置きを混ぜる呼び出し方をすると追従が止まる**ことの証拠。
    // `contextRects` を消して `currentRects` へ寄せる「単純化」をすると、ここが赤くなる。
    it('前置きを読んでいる箇所に混ぜると、上端に揃った時点で動かなくなる', () => {
      const next = planFollowScroll({
        ...view,
        currentRects: [
          { top: 124, bottom: 164 }, // 帯（上端＋余白の位置にいる）
          { top: 900, bottom: 940 }, // 見切れている区域行
        ],
        upcomingRects: [],
      })
      expect(next).toBeNull()
    })

    it('読んでいる箇所だけで視野の高さを超えるときは前置きも足さない', () => {
      const next = planFollowScroll({
        ...view,
        currentRects: [{ top: 520, bottom: 1100 }], // 高さ 580 > 400
        contextRects: [{ top: 400, bottom: 440 }],
        upcomingRects: [],
      })
      expect(next).toBe(396) // 520 - 100 - 24
    })
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
