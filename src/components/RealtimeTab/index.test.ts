// @vitest-environment jsdom
//
// 検知カードの「数える集合」のテスト。
//
// 地図の検知点マーカーとこのカードは同じ点集合・同じ下限で数えなければならない
// （docs/spec/kyoshin-detection-spec.md §8）。地図側の描画判定は
// gl/kyoshinDetectedFeatures.test.ts が見ているので、こちらは**カードが渡された点列を
// そのまま集計するか**だけを見る。
//
// ここを固定するのは、以前カード側が同じ入力から同じ計算を自分で組み立てていたため。
// 「同じ結果になること」に頼る形だと、片方の実装を変えた時点で黙って食い違う。点列を
// props で受け取る形に変えた今、その受け取り方が壊れていないことを守るのがこのテスト。
//
// JSX を使わず createElement で書くのは、このプロジェクトのテストが `src/**/*.test.ts` のみを
// 対象にしているため（拡張子を .tsx にすると拾われない）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { render, cleanup, screen, act } from '@testing-library/react'
import { RealtimeTab } from './index'
import { initGates } from '../../utils/kyoshinDetector'
import type { DetectionEvent } from '../../utils/kyoshinDetector'
import type { DetectedPoint } from '../../utils/kyoshinDetectionView'
import type { EEWAlert } from '../../types/earthquake'

afterEach(cleanup)
// `document.visibilityState` を差し替えるテストがあるため、モックはテストごとに戻す
// （個々のテストで後始末を書き忘れても後続へ漏れないようにする。`clock.test.ts` と同じ作法）。
afterEach(() => vi.restoreAllMocks())

/** テスト用の最小 DetectionEvent。カードはティアの判定と地域数にしかこれを使わない。 */
function fakeEvent(
  overrides: Partial<DetectionEvent> & Pick<DetectionEvent, 'id' | 'confidence'>,
): DetectionEvent {
  return {
    memberKeys: [],
    maxIntensity: 1.0,
    cells: [],
    originTimeMs: Date.UTC(2026, 0, 1, 0, 0, 0),
    lastOnsetAtMs: 0,
    lastSize: 0,
    epicenter: null,
    confirmStreak: 0,
    firstConfirmedAtMs: 0,
    everMultiPoint: false,
    everConfirmed: overrides.confidence === 'confirmed',
    lastSpreadAtMs: 0,
    everNeighborRise: overrides.confidence === 'likely' || overrides.confidence === 'confirmed',
    gates: initGates(),
    confirmedBy: null,
    ...overrides,
  }
}

const P = (key: string, index: number): DetectedPoint => ({ key, lat: 35, lng: 139, index })

function tabElement(detections: DetectionEvent[], points: DetectedPoint[], visible: boolean) {
  return createElement(RealtimeTab, {
    eews: [],
    swaveArrival: null,
    kyoshinV2Detections: detections,
    kyoshinDetectedPoints: points,
    visible,
  })
}

/**
 * 点列を差し替えて再描画できる形で描く。バー幅スケールはカードが持つ ref なので、
 * 同じツリー位置で rerender しないと（＝描き直すと）保持が検証できない。
 */
function renderTab(detections: DetectionEvent[], points: DetectedPoint[], visible = true) {
  const r = render(tabElement(detections, points, visible))
  return {
    update: (nextPoints: DetectedPoint[], nextVisible = true) =>
      r.rerender(tabElement(detections, nextPoints, nextVisible)),
  }
}

describe('検知カードは渡された点列をそのまま集計する', () => {
  const confirmed = [fakeEvent({ id: 'evt-1', confidence: 'confirmed' })]

  it('反応点数は点列の件数（震度0以上）に一致する', () => {
    // index 6 = 震度0、index 7 = 震度1、index 11 = 震度3
    renderTab(confirmed, [P('a', 6), P('b', 7), P('c', 11)])
    expect(screen.getByText(/3観測点で反応/)).toBeTruthy()
  })

  it('震度0未満・欠測は数えない（地図の描画判定と同じ下限）', () => {
    // index 5 = value -0.5（震度0未満）・index -1 = 欠測。どちらも階級が取れない
    renderTab(confirmed, [P('a', 7), P('sub', 5), P('missing', -1)])
    expect(screen.getByText(/1観測点で反応/)).toBeTruthy()
  })

  it('点列が空なら「反応は収まりました」に切り替わる（イベントは生きている）', () => {
    renderTab(confirmed, [])
    expect(screen.getByText(/観測点の反応は収まりました/)).toBeTruthy()
  })

  it('震度別の内訳を点列から作る', () => {
    renderTab(confirmed, [P('a', 6), P('b', 6), P('c', 7)])
    // 震度0 が 2点・震度1 が 1点。件数だけを見ると「どの震度の件数か」が固定されないため、
    // 件数から行（バー1本）を辿って震度ラベルとの対応まで確かめる。
    // 震度ラベル側から引くと震度スケール凡例の「0」「1」と衝突するので、件数側を起点にする。
    const rowOfCount = (count: string) => screen.getByText(count).parentElement?.textContent ?? ''
    expect(rowOfCount('2点')).toMatch(/^0/)
    expect(rowOfCount('1点')).toMatch(/^1/)
  })

  it('ティアの判定は点列ではなくイベントの確信度で決まる', () => {
    // faint だけのときは見出しが「微弱な揺れの兆候」になる。点列に震度1以上があっても変わらない
    renderTab([fakeEvent({ id: 'evt-2', confidence: 'faint', maxIntensity: 0.0 })], [P('a', 7)])
    expect(screen.getByText('微弱な揺れの兆候')).toBeTruthy()
  })

  it('weak だけのときはカードを出さない', () => {
    renderTab([fakeEvent({ id: 'evt-3', confidence: 'weak' })], [P('a', 7)])
    expect(screen.queryByText(/観測点で反応/)).toBeNull()
    expect(screen.queryByText('強震モニタ検知')).toBeNull()
  })

  it('複数イベントのときは地域数を添える', () => {
    renderTab(
      [
        fakeEvent({ id: 'evt-1', confidence: 'confirmed' }),
        fakeEvent({ id: 'evt-2', confidence: 'confirmed' }),
      ],
      [P('a', 7)],
    )
    // 「2地域」は見出し側にも出るため、反応点数と同じ行であることまで確かめる
    expect(screen.getByText(/1観測点で反応 ・ 2地域/)).toBeTruthy()
  })
})

// ============================================================
// カードの枠色は最大震度で決まる（確信度ではない）
//
// 枠＝震度・チップ＝確信度の 2 軸分離。期待値はソースの色定数を参照せず 16 進数で直接書く
// （色が変わったら気づけるように）。震度1 以上は気象庁の震度配色そのもので変更の余地が無い。
// 震度0 の灰色（SHINDO0_COLOR）は気象庁配色に震度0 が無いためのプロジェクト独自の選択で、
// 気象庁配色だから固定というわけではない。
//
// 枠色を決めるのは **points（地図の検知点と同じ点列）の最大インデックス**で、イベント側の
// maxIntensity ではない。そのためイベントは id と確信度だけを与える。
// ============================================================

/** '#rrggbb' と 'rgb(r, g, b)' を同じ表記に揃える（jsdom が正規化する場合があるため）。 */
function toRgb(color: string): string {
  const hex = color.trim().match(/^#([0-9a-fA-F]{6})$/)
  if (!hex) return color.trim()
  const n = parseInt(hex[1]!, 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

/** 検知カードのルート要素（枠線を持つ要素）。本文から親へ辿る。 */
function cardRoot(): HTMLElement {
  const anchor = screen.getByText(/観測点で反応|観測点の反応は収まりました/)
  let el: HTMLElement | null = anchor as HTMLElement
  while (el && !(el.classList.contains('rounded-lg') && el.classList.contains('overflow-hidden'))) {
    el = el.parentElement
  }
  if (!el) throw new Error('検知カードのルート要素が見つからない')
  return el
}

/** カードの枠色を rgb 表記で取り出す。 */
function cardBorderColor(): string {
  const el = cardRoot()
  const decl =
    el.style.borderColor ||
    el.style.border ||
    (el.getAttribute('style') ?? '').match(/border(?:-color)?\s*:\s*([^;]+)/)?.[1] ||
    ''
  const m = decl.match(/#[0-9a-fA-F]{6}|rgba?\([^)]*\)/)
  if (!m) throw new Error(`枠色が読めない: ${el.getAttribute('style')}`)
  return toRgb(m[0])
}

describe('検知カードの枠色は最大震度で決まる（確信度ではない）', () => {
  it('震度7 の点があれば枠は震度7 の色', () => {
    // index 20 = 計測震度 7.0 = 震度7
    renderTab([fakeEvent({ id: 'evt-1', confidence: 'confirmed' })], [P('a', 20)])
    expect(cardBorderColor()).toBe(toRgb('#9d0099'))
  })

  it('震度1 なら枠は震度1 の色', () => {
    renderTab([fakeEvent({ id: 'evt-1', confidence: 'confirmed' })], [P('a', 7)])
    expect(cardBorderColor()).toBe(toRgb('#7bb4c8'))
  })

  it('震度1未満（震度0級）は震度0の灰色へフォールバックする', () => {
    // 震度色が定まらないので震度0の灰色を使う。ティアの色は使わない（confirmed でも同じ色）。
    // ティア色を混ぜると、確信度のラッチで震度が下がった後も赤枠が残る不整合が起きる。
    renderTab([fakeEvent({ id: 'evt-1', confidence: 'faint' })], [P('a', 6)])
    const faintBorder = cardBorderColor()
    expect(faintBorder).toBe(toRgb('#9ca3af'))
    cleanup()

    renderTab([fakeEvent({ id: 'evt-2', confidence: 'confirmed' })], [P('a', 6)])
    expect(cardBorderColor()).toBe(faintBorder)
  })

  it('同じ点列なら確信度が変わっても枠色は同じ（枠=震度・チップ=確信度）', () => {
    renderTab([fakeEvent({ id: 'evt-1', confidence: 'confirmed' })], [P('a', 7)])
    const confirmedBorder = cardBorderColor()
    expect(screen.getByText('検知')).toBeTruthy()
    cleanup()

    renderTab([fakeEvent({ id: 'evt-2', confidence: 'likely' })], [P('a', 7)])
    expect(cardBorderColor()).toBe(confirmedBorder) // 枠は震度1 の色のまま
    expect(screen.getByText('可能性')).toBeTruthy() // 確信度はチップ側だけが変わる
  })
})

// ============================================================
// 震度分布バーの幅スケール（分母）
//
// 見えている間は分母を下げない。下げると、点数が減っている最中にバーが伸びて「増えた」ように
// 見える（分母が動いただけで実際の点数は減っている）。張り直しは見えていない間だけに行う。

/**
 * 「N点」の行のバー（塗り）の幅を返す。行の構造は
 * span(震度ラベル) / div(トラック) > div(塗り) / span(件数)。トラックを class から引いて
 * その子を取るのは、行内の div をインデックスで数えるとラッパーが 1 つ増えただけで
 * 別の要素の幅を検証し始めるため。
 */
function barWidth(countLabel: string): string {
  const row = screen.getByText(countLabel).parentElement
  if (!row) throw new Error(`行が見つからない: ${countLabel}`)
  const fill = row.querySelector('div.overflow-hidden')?.firstElementChild
  if (!fill) throw new Error(`バーの塗りが見つからない: ${countLabel}`)
  return (fill as HTMLElement).style.width
}

/** ブラウザのタブ・ウィンドウの可視性を切り替える（`usePageVisible` が拾う）。 */
function setPageVisibility(state: 'visible' | 'hidden') {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state)
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
}

describe('震度分布バーの幅スケール', () => {
  const confirmed = [fakeEvent({ id: 'evt-1', confidence: 'confirmed' })]
  /** 震度0（index 6）の点を n 個。バーが 1 本だけになるので分母の動きがそのまま幅に出る。 */
  const shindo0 = (n: number) => Array.from({ length: n }, (_, i) => P(`p${i}`, 6))

  it('見えている間は時間が経っても分母が下がらない（点数が減ってもバーが太らない）', () => {
    // 時計を進めるのは、以前の実装が「直近 15 秒のピーク」を分母にしていて、窓から外れた
    // 瞬間にバーが一斉に太る挙動だったため。時間で減衰する仕組みを再導入したら落ちる。
    vi.useFakeTimers()
    try {
      const { update } = renderTab(confirmed, shindo0(4))
      expect(barWidth('4点')).toBe('100%')

      vi.setSystemTime(Date.now() + 20_000)
      update(shindo0(2))
      // 分母が 4 のままなので半分。ここで 100% に戻ると「点数が減ったのに増えた」と見える
      expect(barWidth('2点')).toBe('50%')
    } finally {
      vi.useRealTimers()
    }
  })

  it('点数が増えたら分母は追従する', () => {
    const { update } = renderTab(confirmed, shindo0(2))
    expect(barWidth('2点')).toBe('100%')

    update(shindo0(8))
    expect(barWidth('8点')).toBe('100%')
  })

  it('見えていない間に張り直し、次に見えたときは現在の点数が基準になる', () => {
    const { update } = renderTab(confirmed, shindo0(8))
    expect(barWidth('8点')).toBe('100%')

    // 不可視のまま減る（タブ移動・パネル折りたたみ・アプリのバックグラウンド）
    update(shindo0(2), false)
    // 可視へ戻すと、前の揺れのピーク 8 ではなく現在の 2 が分母になる
    update(shindo0(2), true)
    expect(barWidth('2点')).toBe('100%')
  })

  it('不可視でも点数が増えている間は現在値に追従する（分母が過大にならない）', () => {
    const { update } = renderTab(confirmed, shindo0(2), false)
    update(shindo0(6), false)
    update(shindo0(6), true)
    expect(barWidth('6点')).toBe('100%')
  })

  it('ブラウザのタブが裏に回っている間も張り直す（可視判定の 3 つ目）', () => {
    // タブ・パネルの可視性（`visible` prop）は true のまま、ページ側だけを裏に回す。
    // 実装は `visible && pageVisible` で合成しており、この AND が崩れる（`||` にする・
    // `usePageVisible()` の呼び出しを落とす）と、ここだけが落ちる。
    const { update } = renderTab(confirmed, shindo0(8))
    expect(barWidth('8点')).toBe('100%')

    setPageVisibility('hidden')
    update(shindo0(2))
    setPageVisibility('visible')

    expect(barWidth('2点')).toBe('100%')
  })
})

describe('検知カードは判定の根拠を出す', () => {
  it('確定したものは確定時の内訳を一行で出す', () => {
    const e = fakeEvent({
      id: 'evt-1',
      confidence: 'confirmed',
      confirmedBy: { atMs: 0, size: 6, intensity: 2.0, gates: initGates() },
    })
    renderTab([e], [P('a', 8)])
    expect(screen.getByText('6点・震度2で確定')).toBeTruthy()
  })

  it('まだのものは確定まで何が足りないかを出す', () => {
    const e = fakeEvent({
      id: 'evt-1',
      confidence: 'likely',
      lastSize: 3,
      gates: { ...initGates(), sizeReq: 5, intenseCount: 2, intenseReq: 2 },
    })
    renderTab([e], [P('a', 8)])
    expect(screen.getByText('確定まで あと2点')).toBeTruthy()
  })

  // 対照: 内訳の表は既定で畳んでおく（カードの主情報を押しのけない）
  it('判定の内訳は既定では畳まれている', () => {
    renderTab([fakeEvent({ id: 'evt-1', confidence: 'confirmed' })], [P('a', 8)])
    expect(screen.getByText('判定の内訳')).toBeTruthy()
    expect(screen.queryByText('揺れ継続中の点')).toBeNull()
  })

  it('開くと判定の内訳が出る', () => {
    const e = fakeEvent({
      id: 'evt-1',
      confidence: 'likely',
      lastSize: 3,
      gates: { ...initGates(), sizeReq: 5 },
    })
    renderTab([e], [P('a', 8)])
    act(() => { screen.getByText('判定の内訳').click() })
    expect(screen.getByText('揺れ継続中の点')).toBeTruthy()
    expect(screen.getByText('/ 5')).toBeTruthy()
  })

  // 安全弁: 検知エンジンの内部用語を利用者へ出さない（「フレーム」は 1 秒ごとの処理単位で、
  // 画面のどこにも定義が無い）。回帰で戻さないよう文言の側で固定する
  it('内訳に検知エンジンの内部用語を出さない', () => {
    const e = fakeEvent({
      id: 'evt-1',
      confidence: 'likely',
      lastSize: 5,
      confirmStreak: 1,
      gates: { ...initGates(), sizeReq: 5, streakReq: 3, intenseCount: 2, intenseReq: 2 },
    })
    renderTab([e], [P('a', 8)])
    act(() => { screen.getByText('判定の内訳').click() })
    expect(document.body.textContent).not.toMatch(/フレーム/)
    expect(screen.getByText('確定まで あと約2秒')).toBeTruthy()
  })

  // 安全弁: 要求が動いた理由は内訳の中でだけ出す（一行の要約に混ぜない）
  it('条件を緩めた理由は内訳を開いたときに出る', () => {
    const e = fakeEvent({
      id: 'evt-1',
      confidence: 'likely',
      gates: { ...initGates(), eewActive: true },
    })
    renderTab([e], [P('a', 8)])
    expect(screen.queryByText(/緊急地震速報の発表中/)).toBeNull()
    act(() => { screen.getByText('判定の内訳').click() })
    expect(screen.getByText(/緊急地震速報の発表中/)).toBeTruthy()
  })
})

// EEW カードの「仮定震源要素の見せ方」。述語そのもの（`canPresentLpgmClass`）は eew.test.ts が
// 固定しているが、カードの `maxScale` / `lpgmClass` へ正しく配線されているかはここでしか確かめられない。
function fakeEEW(over: Partial<EEWAlert> = {}): EEWAlert {
  return {
    kind: 'eew',
    id: 'test-eew',
    time: '2026-01-01T12:00:00Z',
    test: false,
    earthquake: {
      originTime: '2026-01-01T12:00:00Z',
      arrivalTime: '2026-01-01T12:00:20Z',
      condition: '以上',
      hypocenter: { name: '日向灘', latitude: 32, longitude: 132, depth: 30, magnitude: 6.5 },
    },
    severity: 'Forecast',
    cancelled: false,
    issue: { eventId: 'e1', serial: '1', time: '2026-01-01T12:00:00Z' },
    ...over,
  }
}

/** 気象庁が仮定震源要素に入れる固定値（観測点直下・深さ 10km・M1.0）で作る。 */
function assumedEEW(over: Partial<EEWAlert> = {}): EEWAlert {
  return fakeEEW({
    earthquake: {
      originTime: '2026-01-01T12:00:00Z',
      arrivalTime: '2026-01-01T12:00:20Z',
      condition: '仮定震源要素',
      hypocenter: { name: '日向灘', latitude: 32, longitude: 132, depth: 10, magnitude: 1 },
    },
    ...over,
  })
}

function renderEEW(eew: EEWAlert) {
  return render(createElement(RealtimeTab, {
    eews: [eew],
    swaveArrival: null,
    kyoshinV2Detections: [],
    kyoshinDetectedPoints: [],
    visible: true,
  }))
}

describe('EEW カードの仮定震源要素の見せ方', () => {
  // 正: 地名は最初に揺れを検知した観測点の所在地なので、断定して見えないよう注記を添える。
  // M・深さは固定の仮定値なので伏せる（従来からの扱い）。
  it('仮定震源要素では震源名に注記を添え、M・深さを出さない', () => {
    renderEEW(assumedEEW())
    expect(screen.getByText('（震源未確定）')).toBeTruthy()
    expect(screen.queryByText('マグニチュード')).toBeNull()
  })

  // 対照: 震源が確定している報では注記を出さない（出すと確定値まで疑わせる）。
  it('確定震源では注記を出さず M・深さを見せる', () => {
    renderEEW(fakeEEW({ forecastMaxScale: 40 }))
    expect(screen.queryByText('（震源未確定）')).toBeNull()
    expect(screen.getByText('マグニチュード')).toBeTruthy()
  })

  // 正: 震度を出せない報では階級バッジも出さない（`canPresentLpgmClass` の配線）。
  // 出すと「予想震度なし」の真下に階級の断言が並ぶ。
  it('予想震度が無い報では長周期階級バッジを出さない', () => {
    renderEEW(assumedEEW({ forecastMaxLpgmClass: 3 }))
    expect(screen.getByText('予想震度なし')).toBeTruthy()
    expect(screen.queryByText('推定長周期地震動')).toBeNull()
  })

  // 安全弁: 震度が出る報では従来どおり階級バッジを出す（ガードが広すぎないことの確認）。
  it('予想震度がある報では長周期階級バッジを出す', () => {
    renderEEW(fakeEEW({ forecastMaxScale: 40, forecastMaxLpgmClass: 3 }))
    expect(screen.getByText('推定長周期地震動')).toBeTruthy()
  })
})
