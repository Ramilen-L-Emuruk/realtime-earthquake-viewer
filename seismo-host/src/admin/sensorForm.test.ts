// @vitest-environment jsdom
//
// **DOM を使う（`readSensorCardValues`）ためファイル全体を jsdom 環境にする。**
// `parseSensorFormValues`・`sensorToFormValues` 等の純関数もこの環境で問題なく動く
// （DOM を要求しないため）。

import { describe, expect, it } from 'vitest'
import {
  defaultSensorCalibration,
  IDENTITY_MATRIX,
  type SensorEntry,
} from '../receiver/stationConfigTypes'
import type { SensorRestWindow } from './detectedBoards'
import {
  emptySensorFormValues,
  orientationToFormValues,
  parseHeadingText,
  parseOrientationFormValues,
  parseSensorFormValues,
  readOrientationValues,
  readSensorCardValues,
  renderOrientationHtml,
  renderSensorCardHtml,
  restWindowNote,
  sensorToFormValues,
  writeOrientationValues,
  writeSensorCardAxes,
  type SensorFormValues,
} from './sensorForm'

const VALID_VALUES: SensorFormValues = {
  sensorId: 'accel-0',
  enabled: true,
  axes: [
    { vector: ['1', '0', '0'], offset: '0.1' },
    { vector: ['0', '1', '0'], offset: '-0.2' },
    { vector: ['0', '0', '1'], offset: '0.3' },
  ],
  noiseDensity: '80',
}

/** 立てて付けた 2 軸（基板の X と Z を測る）。 */
const TWO_AXIS_VALUES: SensorFormValues = {
  sensorId: 'i2c0-6a',
  enabled: true,
  axes: [
    { vector: ['1.0021', '0.0034', '-0.0012'], offset: '4.5' },
    { vector: ['0.0008', '-0.0017', '0.9968'], offset: '-12.25' },
  ],
  noiseDensity: '',
}

describe('parseSensorFormValues', () => {
  it('正しい入力を SensorEntry へ変換する', () => {
    const result = parseSensorFormValues(VALID_VALUES)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sensor).toEqual<SensorEntry>({
      sensorId: 'accel-0',
      enabled: true,
      axes: [
        { vector: [1, 0, 0], offset: 0.1 },
        { vector: [0, 1, 0], offset: -0.2 },
        { vector: [0, 0, 1], offset: 0.3 },
      ],
      noiseDensity: 80,
    })
  })

  it('2 軸のセンサーも読める（軸の本数は欄の本数）', () => {
    const result = parseSensorFormValues(TWO_AXIS_VALUES)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.sensor.axes).toHaveLength(2)
  })

  it('noiseDensity が空文字列なら null になる', () => {
    const result = parseSensorFormValues({ ...VALID_VALUES, noiseDensity: '' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.sensor.noiseDensity).toBeNull()
  })

  it('sensorId が空文字列ならエラーにする', () => {
    const result = parseSensorFormValues({ ...VALID_VALUES, sensorId: '  ' })
    expect(result.ok).toBe(false)
  })

  it('3 本の向きが 1 つの面に寄っていればエラーにする（その向きの揺れを解けない）', () => {
    const result = parseSensorFormValues({
      ...VALID_VALUES,
      axes: [VALID_VALUES.axes[0]!, VALID_VALUES.axes[1]!, { vector: ['1', '1', '0'], offset: '0' }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('1 つの面')
  })

  it('2 本の向きが平行ならエラーにする', () => {
    const result = parseSensorFormValues({
      ...TWO_AXIS_VALUES,
      // 軸 1 を −2 倍した向き（逆向きでも平行は平行）。
      axes: [TWO_AXIS_VALUES.axes[0]!, { vector: ['-2.0042', '-0.0068', '0.0024'], offset: '0' }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('平行')
  })

  it('向きが逆（負の長さに当たる）でもエラーにしない（裏返して付けた軸を書ける）', () => {
    const result = parseSensorFormValues({
      ...VALID_VALUES,
      axes: [{ vector: ['-1', '0', '0'], offset: '0' }, VALID_VALUES.axes[1]!, VALID_VALUES.axes[2]!],
    })
    expect(result.ok).toBe(true)
  })

  it('ゼロ点は負の値でもエラーにしない（静止時のゼロ点のずれは正負どちらもありうる）', () => {
    const result = parseSensorFormValues({
      ...VALID_VALUES,
      axes: VALID_VALUES.axes.map((a) => ({ ...a, offset: '-5' })),
    })
    expect(result.ok).toBe(true)
  })

  it('数値として読めない文字列はエラーにする（どの軸のどの欄かが分かる）', () => {
    const offset = parseSensorFormValues({
      ...VALID_VALUES,
      axes: [VALID_VALUES.axes[0]!, { ...VALID_VALUES.axes[1]!, offset: 'abc' }, VALID_VALUES.axes[2]!],
    })
    expect(offset.ok).toBe(false)
    if (!offset.ok) expect(offset.error).toContain('軸 2 のゼロ点')
    const vector = parseSensorFormValues({
      ...VALID_VALUES,
      axes: [{ vector: ['1', 'x', '0'], offset: '0' }, VALID_VALUES.axes[1]!, VALID_VALUES.axes[2]!],
    })
    expect(vector.ok).toBe(false)
    if (!vector.ok) expect(vector.error).toContain('軸 1 の向き')
  })

  it('ノイズ密度が負ならエラーにする', () => {
    const result = parseSensorFormValues({ ...VALID_VALUES, noiseDensity: '-1' })
    expect(result.ok).toBe(false)
  })
})

describe('sensorToFormValues / emptySensorFormValues', () => {
  it('SensorEntry をフォーム値へ変換し、parseSensorFormValues で往復一致する', () => {
    const sensor: SensorEntry = {
      sensorId: 'accel-1',
      enabled: false,
      axes: [
        { vector: [0, 0.66, 0], offset: 1 },
        { vector: [0.4, 0, 0], offset: 2 },
        { vector: [0, 0, -0.2857142857142857], offset: 3 },
      ],
      noiseDensity: 42,
    }
    const values = sensorToFormValues(sensor)
    const result = parseSensorFormValues(values)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.sensor).toEqual(sensor)
  })

  it('noiseDensity が null のセンサーは空文字列になる', () => {
    const values = sensorToFormValues({
      sensorId: 'accel-2',
      ...defaultSensorCalibration(3),
    })
    expect(values.noiseDensity).toBe('')
  })

  it('emptySensorFormValues は補正なしの軸を文字列化したものと一致する（3 軸・2 軸）', () => {
    for (const count of [3, 2] as const) {
      const result = parseSensorFormValues({ ...emptySensorFormValues(count), sensorId: 'new-sensor' })
      expect(result.ok).toBe(true)
      if (result.ok) {
        const want = defaultSensorCalibration(count)
        expect(result.sensor.enabled).toBe(want.enabled)
        expect(result.sensor.axes).toEqual(want.axes)
        expect(result.sensor.noiseDensity).toBeNull()
      }
    }
  })
})

describe('renderSensorCardHtml / readSensorCardValues', () => {
  function mountCard(values: SensorFormValues): HTMLElement {
    const container = document.createElement('div')
    container.innerHTML = renderSensorCardHtml(values)
    return container
  }

  it('renderSensorCardHtml で作ったカードを readSensorCardValues で読むと元の値に一致する', () => {
    expect(readSensorCardValues(mountCard(VALID_VALUES))).toEqual(VALID_VALUES)
    expect(readSensorCardValues(mountCard(TWO_AXIS_VALUES))).toEqual(TWO_AXIS_VALUES)
  })

  it('2 軸のセンサーは軸の欄が 2 行だけ描かれる', () => {
    const container = mountCard(TWO_AXIS_VALUES)
    expect(container.querySelectorAll('.s-axis-offset')).toHaveLength(2)
    expect(container.querySelectorAll('.s-axis-vector')).toHaveLength(6)
  })

  it('6 面法の欄は 3 軸のカードにだけ出す（2 軸では揃う面が無い）', () => {
    expect(mountCard(VALID_VALUES).querySelector('.s-sixface')).not.toBeNull()
    expect(mountCard(TWO_AXIS_VALUES).querySelector('.s-sixface')).toBeNull()
  })

  // **回帰:** 左上の空の見出しを `.muted` にしていて、`.muted:empty` が場所を取らないため
  // 以降のセルが 1 つずつ前へずれ、「軸 1」が見出しの行の右端に出ていた（画面で見つけた）。
  it('軸の欄は 1 行 5 セルで並び、各行の先頭が「軸 N」になる（空のセルを .muted にしない）', () => {
    const cells = Array.from(mountCard(VALID_VALUES).querySelector('.axis-grid')?.children ?? [])
    expect(cells).toHaveLength(5 * 4)
    expect(cells.filter((c) => c.classList.contains('muted') && c.textContent === '')).toHaveLength(0)
    expect([5, 10, 15].map((i) => cells[i]?.textContent)).toEqual(['軸 1', '軸 2', '軸 3'])
  })

  it('writeSensorCardAxes は読むのと同じ欄へ書く（本数が違えば投げる）', () => {
    const container = mountCard(VALID_VALUES)
    const next = VALID_VALUES.axes.map((a, i) => ({ vector: a.vector, offset: String(10 + i) }))
    writeSensorCardAxes(container, next)
    expect(readSensorCardValues(container).axes).toEqual(next)
    expect(() => writeSensorCardAxes(container, next.slice(0, 2))).toThrow()
  })

  it('sensorId に含まれる HTML 特殊文字がタグとして解釈されない（XSS対策）', () => {
    const malicious = { ...VALID_VALUES, sensorId: '<img src=x onerror=alert(1)>' }
    const container = mountCard(malicious)
    expect(container.querySelector('img')).toBeNull()
    // escapeHtml を経由しても、読み取ったときの値は元の文字列と一致する。
    expect(readSensorCardValues(container).sensorId).toBe(malicious.sensorId)
  })

  it('enabled が false のときチェックボックスが未チェックで描画される', () => {
    const container = mountCard({ ...VALID_VALUES, enabled: false })
    const checkbox = container.querySelector<HTMLInputElement>('.s-enabled')
    expect(checkbox?.checked).toBe(false)
  })
})

describe('基板の向きの欄', () => {
  const YAW90 = [
    [0, -1, 0],
    [1, 0, 0],
    [0, 0, 1],
  ] as const

  it('描いた欄を読むと元の値に一致し、書き込んだ値も同じ欄から読める', () => {
    const container = document.createElement('div')
    container.innerHTML = renderOrientationHtml(orientationToFormValues())
    expect(parseOrientationFormValues(readOrientationValues(container))).toEqual(IDENTITY_MATRIX)
    writeOrientationValues(container, YAW90)
    expect(parseOrientationFormValues(readOrientationValues(container))).toEqual(YAW90)
  })

  it('純粋な回転でなければ理由を返す（倍率を含む・鏡映・数でない）', () => {
    const scaled = orientationToFormValues([
      [2, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ])
    expect('error' in (parseOrientationFormValues(scaled) as object)).toBe(true)
    const mirrored = orientationToFormValues([
      [-1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ])
    expect('error' in (parseOrientationFormValues(mirrored) as object)).toBe(true)
    const broken = [...orientationToFormValues()] as string[]
    broken[4] = 'x'
    expect('error' in (parseOrientationFormValues(broken as unknown as ReturnType<typeof orientationToFormValues>) as object)).toBe(true)
  })
})

describe('parseHeadingText', () => {
  // **空欄は誤りではない。** 重力から方角は決まらないので、分からないまま
  // 既定値（0）へ倒すと、合っていた方角を黙って崩す。
  it('空欄は null（方角に触らない）', () => {
    expect(parseHeadingText('')).toBeNull()
    expect(parseHeadingText('   ')).toBeNull()
  })

  it('数として読めれば、そのまま返す（負も 360 超も通す）', () => {
    expect(parseHeadingText('90')).toBe(90)
    expect(parseHeadingText(' -12.5 ')).toBe(-12.5)
    expect(parseHeadingText('400')).toBe(400)
  })

  it('数として読めなければ理由を返す', () => {
    const got = parseHeadingText('きた')
    expect(typeof got === 'object' && got !== null && 'error' in got).toBe(true)
  })
})

describe('restWindowNote', () => {
  const window: SensorRestWindow = {
    boardKey: 'mac:aa',
    sensorId: 'accel-0',
    atMs: 9_500,
    sampleCount: 2_984,
    meanGal: 980.665,
    sdGal: 1.4,
    // 15 度傾けて据えた基板。
    axisMeanGal: [0, 980.665 * Math.sin(Math.PI / 12), 980.665 * Math.cos(Math.PI / 12)],
    scale: 'ok',
    restless: false,
  }

  // **「まだ出ていない」と「出たが使えない」を書き分ける。** 混ぜると、待てば
  // 出るのか何か直さないと出ないのかが読めない。
  it('判定がまだ無いときは、待てば出ることが分かる', () => {
    expect(restWindowNote(null, 10_000)).toContain('まだ無い')
  })

  it('静止した窓では傾きと重力を出す', () => {
    const note = restWindowNote(window, 10_000)
    expect(note).toContain('取り付けの傾き 15°')
    expect(note).toContain('980.7 gal')
  })

  it('提案できない窓では、その理由を出す', () => {
    expect(restWindowNote({ ...window, scale: 'not-at-rest' }, 10_000)).toContain(
      '揺れている間は合わせられない',
    )
    expect(restWindowNote({ ...window, scale: 'too-small' }, 10_000)).toContain('換算の倍率')
  })

  // **経過の基準が無ければ黙って受け手の時計へ倒さない**（端末の時計がずれて
  // いるだけで「10 分前」と出る）。時刻だけを省く。
  it('基準の時刻が無ければ経過を書かない', () => {
    const note = restWindowNote(window, null)
    expect(note).toContain('取り付けの傾き 15°')
    expect(note).not.toContain('前')
  })

  // **倍率の話とは別の異常。** どちらも起きうるので、片方で上書きしない。
  it('静止しているのに震度が高い窓では、その旨も添える', () => {
    expect(restWindowNote({ ...window, restless: true }, 10_000)).toContain('計測震度が高い')
  })
})
