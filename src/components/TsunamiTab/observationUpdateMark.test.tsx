// @vitest-environment jsdom
//
// 観測点の行で「この報で動いた項目」を文字色で示すこと（→ docs/spec/tsunami-spec.md §9）。
//
// **描いてみないと確かめられない。** 判定（`changedObservationFields`）は沖合の観測点についても
// 作られているのに、沖合の行（`TsunamiObservationRow`）がそれを受け取っていなかったため、
// **沖合だけ縦線も項目の色も出ていなかった**。props が任意なので型検査では捕まらず、症状も
// 「その行だけ印が出ない」で、例外もログも出ない。
//
// **観測点は 1 件ずつ描く。** 沿岸と沖合を同じ画面へ並べると、色がどちらの行のものかを DOM から
// 辿る必要があり、その辿り方を誤ると「受け渡しを外しても落ちないテスト」になる（実際にそう書いた）。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { TsunamiTab } from './index'
import { UPDATE_MARK_COLOR } from '../../utils/updateMark'
import type { JMATsunami, TsunamiArea, TsunamiObservation } from '../../types/earthquake'
import type { ObsUpdateMark } from '../../utils/tsunami'

afterEach(cleanup)

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = NoopResizeObserver as unknown as typeof ResizeObserver

/** 区域に紐づく観測点（沿岸）。 */
const coastal: TsunamiObservation = {
  name: '大船渡', districtCode: '210', districtName: '岩手県',
  height: { value: 3.0, description: '3.0m' },
  maxHeightDateTime: '2024-01-01T16:23:00',
}

/**
 * 区域に紐づかない観測点（沖合）。**津波予報区を持たない**ので、カードでは区域の下ではなく
 * その他の観測点として並ぶ（`unmatched`）。
 */
const offshore: TsunamiObservation = {
  name: '岩手沖', height: { value: 1.2, description: '1.2m' },
  maxHeightDateTime: '2024-01-01T16:20:00',
  arrivalTime: '2024-01-01T16:12:00', initial: '押し',
  offshore: true,
}

function makeTsunami(observations: TsunamiObservation[]): JMATsunami {
  const areas: TsunamiArea[] = [
    {
      code: '210', name: '岩手県', grade: 'MajorWarning', immediate: true,
      maxHeight: { description: '6m', value: 6.0 },
    },
  ]
  return {
    kind: 'tsunami', id: 'test-obs-mark', eventId: '20240101161000',
    time: '2024-01-01T16:12:00', cancelled: false,
    issue: { source: 'テスト', time: '2024-01-01T16:12:00', type: 'Focus' },
    areas, observations,
  }
}

const marks = (name: string, fields: ObsUpdateMark['fields']): Map<string, ObsUpdateMark> =>
  new Map([[name, { status: 'changed' as const, fields }]])

const draw = (obs: TsunamiObservation, obsUpdateStatus?: Map<string, ObsUpdateMark>) =>
  render(<TsunamiTab tsunamis={[makeTsunami([obs])]} earthquakes={[]} obsUpdateStatus={obsUpdateStatus} />)

/** `#fbbf24` を jsdom が正規化した形。印の色（動いた＝黄）。 */
const MARK_RGB = 'rgb(251, 191, 36)'

/** 印の色が当たっている要素の数（観測点を 1 件しか描かないので、その行のものに決まる）。 */
const colored = () => Array.from(document.querySelectorAll<HTMLElement>('[style]'))
  .filter(el => el.style.color === MARK_RGB).length

describe('観測点の行の更新の印', () => {
  // 色の定義を写し取っていないことを確かめる（値を書き換えたらここで落ちる）。
  it('印の色は共通の語彙から採る', () => {
    expect(UPDATE_MARK_COLOR.changed).toBe('#fbbf24')
  })

  // 正: **沖合の行にも色を出す。** 判定は作られているので、渡していないと画面だけが黙る。
  it('沖合の観測点にも項目の色が出る', () => {
    draw(offshore, marks('岩手沖', new Set(['height', 'maxHeightTime', 'firstWave'])))
    expect(screen.getByText('岩手沖')).toBeTruthy()
    expect(colored()).toBe(3)
  })

  // 正: 波高にも当てられる（既定が白なので等級の色と衝突しない）。
  it('波高だけが動いた報でも色が出る', () => {
    draw(coastal, marks('大船渡', new Set(['height'])))
    expect(colored()).toBe(1)
  })

  // 正: 沿岸の行でも時刻の色は出る（従来から出ていたぶん）。
  it('沿岸の観測点で最大波の時刻が動いたら色が出る', () => {
    draw(coastal, marks('大船渡', new Set(['maxHeightTime'])))
    expect(colored()).toBe(1)
  })

  // 対照: 動いた項目が無ければ色は出ない。**そして波高の既定は白**（等級の色ではない）——
  // 等級は等級カードの枠と見出しが示しているので、ここで繰り返すと動いた項目を塗る余地が無い。
  it('印が無ければ色は出ず、波高は白のまま', () => {
    draw(coastal)
    expect(colored()).toBe(0)
    expect(screen.getByText('3.0m').style.color).toBe('rgb(255, 255, 255)')
  })
})
