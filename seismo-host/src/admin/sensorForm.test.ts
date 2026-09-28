// @vitest-environment jsdom
//
// **DOM を使う（`readSensorCardValues`）ためファイル全体を jsdom 環境にする。**
// `parseSensorFormValues`・`sensorToFormValues` 等の純関数もこの環境で問題なく動く
// （DOM を要求しないため）。

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SENSOR_CALIBRATION,
  type SensorEntry,
} from '../receiver/stationConfigTypes'
import {
  emptySensorFormValues,
  parseSensorFormValues,
  readSensorCardValues,
  renderSensorCardHtml,
  sensorToFormValues,
  type SensorFormValues,
} from './sensorForm'

const VALID_VALUES: SensorFormValues = {
  sensorId: 'accel-0',
  enabled: true,
  offset: ['0.1', '-0.2', '0.3'],
  sensitivity: ['1', '1', '1'],
  rotation: ['1', '0', '0', '0', '1', '0', '0', '0', '1'],
  noiseDensity: '80',
}

describe('parseSensorFormValues', () => {
  it('正しい入力を SensorEntry へ変換する', () => {
    const result = parseSensorFormValues(VALID_VALUES)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sensor).toEqual<SensorEntry>({
      sensorId: 'accel-0',
      enabled: true,
      offset: [0.1, -0.2, 0.3],
      sensitivity: [1, 1, 1],
      rotation: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      noiseDensity: 80,
    })
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

  it('感度が 0 ならエラーにする（0 や負は軸を殺す・反転するので enabled と役割が重複する）', () => {
    const result = parseSensorFormValues({ ...VALID_VALUES, sensitivity: ['0', '1', '1'] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('感度')
  })

  it('感度が負の値ならエラーにする', () => {
    const result = parseSensorFormValues({ ...VALID_VALUES, sensitivity: ['1', '-1', '1'] })
    expect(result.ok).toBe(false)
  })

  it('オフセットは負の値でもエラーにしない（静止時のゼロ点のずれは正負どちらもありうる）', () => {
    const result = parseSensorFormValues({ ...VALID_VALUES, offset: ['-5', '-5', '-5'] })
    expect(result.ok).toBe(true)
  })

  it('数値として読めない文字列はエラーにする', () => {
    const result = parseSensorFormValues({ ...VALID_VALUES, offset: ['abc', '0', '0'] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('オフセット')
  })

  it('回転行列に数値として読めない文字列があればエラーにする', () => {
    const result = parseSensorFormValues({
      ...VALID_VALUES,
      rotation: ['1', '0', '0', '0', 'x', '0', '0', '0', '1'],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('回転行列')
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
      offset: [1, 2, 3],
      sensitivity: [1.5, 2.5, 3.5],
      rotation: [
        [0, 1, 0],
        [1, 0, 0],
        [0, 0, -1],
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
      ...DEFAULT_SENSOR_CALIBRATION,
    })
    expect(values.noiseDensity).toBe('')
  })

  it('emptySensorFormValues は DEFAULT_SENSOR_CALIBRATION を文字列化したものと一致する', () => {
    const result = parseSensorFormValues({ ...emptySensorFormValues(), sensorId: 'new-sensor' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.sensor.enabled).toBe(DEFAULT_SENSOR_CALIBRATION.enabled)
      expect(result.sensor.rotation).toEqual(DEFAULT_SENSOR_CALIBRATION.rotation)
      expect(result.sensor.offset).toEqual(DEFAULT_SENSOR_CALIBRATION.offset)
      expect(result.sensor.sensitivity).toEqual(DEFAULT_SENSOR_CALIBRATION.sensitivity)
      expect(result.sensor.noiseDensity).toBeNull()
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
    const container = mountCard(VALID_VALUES)
    expect(readSensorCardValues(container)).toEqual(VALID_VALUES)
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
