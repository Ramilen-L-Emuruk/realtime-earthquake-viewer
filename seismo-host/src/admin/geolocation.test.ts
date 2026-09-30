// 現在地から座標を入れる部分のうち、DOM に依存しない判定と整形のテスト。

import { describe, expect, it } from 'vitest'
import {
  checkGeolocationAvailability,
  describeAccuracy,
  describeGeolocationError,
  roundCoord,
} from './geolocation'

describe('checkGeolocationAvailability', () => {
  it('HTTPS か localhost なら使える', () => {
    expect(checkGeolocationAvailability({ isSecureContext: true, navigator: { geolocation: {} } })).toEqual({
      ok: true,
    })
  })

  // **ここを見落とすと「押しても何も起きない」画面になる。** `navigator.geolocation`
  // は素の HTTP でも生えているので、有無だけでは判定にならない。
  it('素の HTTP では、URL が原因だと分かる理由を返す', () => {
    const result = checkGeolocationAvailability({ isSecureContext: false, navigator: { geolocation: {} } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('HTTPS か localhost')
  })

  it('位置情報そのものが無いブラウザも弾く', () => {
    const result = checkGeolocationAvailability({ isSecureContext: true, navigator: {} })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('対応していない')
  })
})

describe('roundCoord', () => {
  // 小数 6 桁で約 0.1 m。位置情報の誤差は良くても数 m なので、これより下は測っていない。
  it('小数 6 桁へ丸める', () => {
    expect(roundCoord(35.658034729003906)).toBe(35.658035)
    expect(roundCoord(139.74753570556641)).toBe(139.747536)
  })

  it('負の座標も丸める（南半球・西半球）', () => {
    expect(roundCoord(-33.868819999999999)).toBe(-33.86882)
  })

  it('もともと短い値は変えない', () => {
    expect(roundCoord(35.6)).toBe(35.6)
    expect(roundCoord(0)).toBe(0)
  })
})

describe('describeGeolocationError', () => {
  it('拒否されたことと、設定を見る先を伝える', () => {
    expect(describeGeolocationError({ code: 1 })).toContain('ブラウザの設定')
  })

  it('特定できない・時間切れを言い分ける', () => {
    expect(describeGeolocationError({ code: 2 })).toBe('現在地を特定できない')
    expect(describeGeolocationError({ code: 3 })).toContain('時間内')
  })

  it('知らないコードでも文言を返す', () => {
    expect(describeGeolocationError({ code: 99 })).toBe('現在地を取得できない')
  })
})

describe('describeAccuracy', () => {
  it('m で出す', () => {
    expect(describeAccuracy(32.4)).toBe('誤差およそ ±32 m')
  })

  // Wi-Fi 測位は数百 m〜数 km になる。m のまま出すと桁が読み取りにくい。
  it('1000 m 以上は km で出す', () => {
    expect(describeAccuracy(2400)).toBe('誤差およそ ±2.4 km')
  })

  it('数値として読めない値は「不明」にする（0 m と混同しない）', () => {
    expect(describeAccuracy(Number.NaN)).toBe('精度は不明')
    expect(describeAccuracy(-1)).toBe('精度は不明')
  })
})
