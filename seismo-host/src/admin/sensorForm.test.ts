// @vitest-environment jsdom
//
// **DOM を使う（`readSensorCardValues`）ためファイル全体を jsdom 環境にする。**
// `parseSensorFormValues`・`sensorToFormValues` 等の純関数もこの環境で問題なく動く
// （DOM を要求しないため）。

import { describe, expect, it } from 'vitest'
import {
  defaultSensorCalibration,
  IDENTITY_MATRIX,
  type Mat3,
  type SensorEntry,
} from '../receiver/stationConfigTypes'
import type { SensorRestWindow } from './detectedBoards'
import {
  emptySensorFormValues,
  headingTextFor,
  orientationToFormValues,
  parseHeadingText,
  parseOrientationFormValues,
  parseSensorFormValues,
  readHeadingChange,
  readOrientationValues,
  readSensorCardValues,
  renderOrientationHtml,
  renderSensorCardHtml,
  restWindowNote,
  sensorToFormValues,
  writeHeadingFromOrientation,
  writeOrientationValues,
  writeSensorCardAxes,
  type OrientationFormValues,
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

  it('正: 「軸ごとの校正」「ゼロ点（gal）」の意味はホバーで出し、常時の説明文は置かない（2026-10-12 ユーザー承認）', () => {
    const container = mountCard(VALID_VALUES)
    const tips = new Map(
      [...container.querySelectorAll<HTMLElement>('button.tip')].map((b) => [b.textContent, b.dataset.tip]),
    )
    expect(tips.get('軸ごとの校正')).toBe(
      '向きは、その軸が基板の X・Y・Z のどの向きを測るかです。長さは倍率で、1 gal の揺れを何 gal と読むかです。',
    )
    expect(tips.get('ゼロ点（gal）')).toBe('揺れていないときに読む値です。')
    expect(container.textContent).not.toContain('ゼロ点：')
  })

  it('2 軸のセンサーは軸の欄が 2 行だけ描かれる', () => {
    const container = mountCard(TWO_AXIS_VALUES)
    expect(container.querySelectorAll('.s-axis-offset')).toHaveLength(2)
    expect(container.querySelectorAll('.s-axis-vector')).toHaveLength(6)
  })

  // 2026-10-10 に覆した: 6 面法は基板の欄に 1 つだけ置く（全部のセンサーの軸を一緒に解く）。
  it('6 面法の欄はセンサーカードに出さない（3 軸・2 軸とも。基板の欄にある）', () => {
    expect(mountCard(VALID_VALUES).querySelector('.s-sixface')).toBeNull()
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

  // 正（2026-10-10）: 6 面法は基板の欄に 1 つ。ゼロ点を入れる前に出した傾きはずれを抱え込むので、
  // 「鉛直を合わせる」より前に置く。
  it('基板の欄に 6 面法を 1 つ、「鉛直を合わせる」より前に置く', () => {
    const container = document.createElement('div')
    container.innerHTML = renderOrientationHtml(orientationToFormValues())
    expect(container.querySelectorAll('.b-sixface .apply-sixface')).toHaveLength(1)
    const sixFace = container.querySelector('.b-sixface')
    const tilt = container.querySelector('.suggest-tilt')
    if (sixFace === null || tilt === null) throw new Error('欄が無い')
    expect(sixFace.compareDocumentPosition(tilt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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

/** X 軸が方角 `deg` を向き、Z 軸が真上の向き（3x3 の欄の並び＝行ごと）。 */
function headingValues(deg: number): OrientationFormValues {
  const s = Math.sin((deg * Math.PI) / 180)
  const c = Math.cos((deg * Math.PI) / 180)
  // 列が基板の X・Y・Z 軸（東・北・上の成分）。X=(s,c,0)・Y=Z×X=(−c,s,0)・Z=(0,0,1)。
  return [String(s), String(-c), '0', String(c), String(s), '0', '0', '0', '1']
}

describe('headingTextFor', () => {
  it('正: X 軸の向いている方角を、小数 1 桁・`.0` 無しで出す', () => {
    expect(headingTextFor(headingValues(297))).toBe('297')
    expect(headingTextFor(headingValues(45.25))).toBe('45.3')
  })

  it('安全弁: 360 へ丸まる方角は 0 と出す（360 と 0 が別の値に見えないように）', () => {
    expect(headingTextFor(headingValues(359.96))).toBe('0')
  })

  it('対照: 360 の手前で丸まらない方角はそのまま', () => {
    expect(headingTextFor(headingValues(359.94))).toBe('359.9')
  })

  it('安全弁: X 軸が真上を向く・欄が読めないなら空', () => {
    expect(headingTextFor(['0', '0', '1', '0', '1', '0', '-1', '0', '0'])).toBe('')
    expect(headingTextFor(['x', '0', '0', '0', '1', '0', '0', '0', '1'])).toBe('')
  })
})

describe('readHeadingChange / writeHeadingFromOrientation', () => {
  const mount = (deg: number): HTMLElement => {
    const root = document.createElement('div')
    root.innerHTML = renderOrientationHtml(headingValues(deg))
    return root
  }
  const heading = (root: HTMLElement): HTMLInputElement => root.querySelector<HTMLInputElement>('.b-heading')!

  it('対照: 入れておいた値のまま（前後の空白だけ違っても）なら null（保存で回さない）', () => {
    const root = mount(120)
    expect(heading(root).value).toBe('120')
    expect(readHeadingChange(root)).toBeNull()
    heading(root).value = ' 120 '
    expect(readHeadingChange(root)).toBeNull()
  })

  it('正: 手で変えたら、その方角を返す', () => {
    const root = mount(120)
    heading(root).value = '200'
    expect(readHeadingChange(root)).toBe(200)
  })

  // 欄は `type="number"` なので、読めない文字は値が空になる（読めない文字の判定は `parseHeadingText` 側）。
  it('安全弁: 空欄にしたら回さない（入れておいた値と違っても null）', () => {
    const root = mount(120)
    heading(root).value = ''
    expect(readHeadingChange(root)).toBeNull()
  })

  it('正: 3x3 を書き換えた後に入れ直すと、欄と入れておいた値の両方が新しい方角になる', () => {
    const root = mount(120)
    writeOrientationValues(root, parseOrientationFormValues(headingValues(30)) as Mat3)
    writeHeadingFromOrientation(root)
    expect(heading(root).value).toBe('30')
    expect(readHeadingChange(root)).toBeNull()
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
      '揺れている間は合わせられない。静止してから 30 秒待ってください',
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
