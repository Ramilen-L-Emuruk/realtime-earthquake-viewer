import { describe, it, expect } from 'vitest'
import { formatDepth, formatMagnitude, formatFileStamp } from './formatters'
import { withTz } from '../test-utils/withTz'
import { getMagnitudeColor, getDepthColor } from './intensity'

// 規模・深さの色は文字表示（formatMagnitude / formatDepth）と同じ判定で「不明」を弾く必要がある。
// NaN は比較演算がすべて false になるため、ガードが無いと最終行（M7 以上＝紫）に落ちて
// 「不明」の文字の隣に最も深刻な色が付く、という文字と色の矛盾が起きる。
describe('色付けの不明ガード', () => {
  const UNKNOWN = '#666666'

  it('規模 NaN・負値は不明色（M7 以上の紫に落ちない）', () => {
    expect(getMagnitudeColor(Number.NaN)).toBe(UNKNOWN)
    expect(getMagnitudeColor(-1)).toBe(UNKNOWN)
    expect(getMagnitudeColor(7.4)).not.toBe(UNKNOWN)
  })

  it('深さ NaN・負値は不明色、0 は「ごく浅い」の色', () => {
    expect(getDepthColor(Number.NaN)).toBe(UNKNOWN)
    expect(getDepthColor(-1)).toBe(UNKNOWN)
    expect(getDepthColor(0)).not.toBe(UNKNOWN)
  })
})

describe('formatDepth', () => {
  it('depth=0 は "ごく浅い"', () => {
    expect(formatDepth(0)).toBe('ごく浅い')
  })
  it('負値は "不明"', () => {
    expect(formatDepth(-1)).toBe('不明')
  })
  it('通常値は "Nkm"', () => {
    expect(formatDepth(50)).toBe('50km')
  })
  it('NaN は "不明"', () => {
    expect(formatDepth(Number.NaN)).toBe('不明')
  })
  it('undefined 相当（Number 変換 NaN）は "不明"', () => {
    expect(formatDepth(Number(undefined))).toBe('不明')
  })
  it('Infinity は "不明"', () => {
    expect(formatDepth(Number.POSITIVE_INFINITY)).toBe('不明')
  })
})

describe('formatMagnitude', () => {
  it('負値は "不明"', () => {
    expect(formatMagnitude(-1)).toBe('不明')
  })
  it('通常値は "M X.Y"', () => {
    expect(formatMagnitude(5.3)).toBe('M5.3')
  })
  it('NaN は "不明"', () => {
    expect(formatMagnitude(Number.NaN)).toBe('不明')
  })
  it('undefined 相当（Number 変換 NaN）は "不明"', () => {
    expect(formatMagnitude(Number(undefined))).toBe('不明')
  })
  it('Infinity は "不明"', () => {
    expect(formatMagnitude(Number.POSITIVE_INFINITY)).toBe('不明')
  })
})

// 書き出しファイル名の時刻印。UTC で作ると JST の端末では 9 時間ずれた名前が並び、
// 「この時刻に鳴った」という手元のメモと突き合わせられなくなる（診断ログの用途そのもの）。
describe('formatFileStamp', () => {

  // 2026-01-15T00:00:00Z。時間帯ごとの規則が現行のものになる年を選ぶ
  // （epoch 直後を使うと、当時と今で刻みが違う地域＝ネパールの +0530→+0545 等を踏む）
  const BASE = Date.UTC(2026, 0, 15, 0, 0, 0)

  it('端末のローカル時刻で作る（UTC ではない）', () => {
    expect(withTz('Asia/Tokyo', () => formatFileStamp(BASE))).toBe('20260115_090000+0900')
  })

  it('UTC より west の時間帯は負符号になり、日付も繰り下がる', () => {
    expect(withTz('America/New_York', () => formatFileStamp(BASE))).toBe('20260114_190000-0500')
  })

  it('30 分・45 分刻みの時間帯でも分が落ちない', () => {
    expect(withTz('Asia/Kolkata', () => formatFileStamp(BASE))).toBe('20260115_053000+0530')
    expect(withTz('Asia/Kathmandu', () => formatFileStamp(BASE))).toBe('20260115_054500+0545')
  })

  it('UTC の端末では +0000', () => {
    expect(withTz('UTC', () => formatFileStamp(BASE))).toBe('20260115_000000+0000')
  })

  it('夏時間を持つ地域では、記録した時刻に効いていたオフセットで作る', () => {
    // 現在時刻のオフセットで全件を作ると、季節をまたいだ記録が 1 時間ずれて並ぶ
    expect(withTz('America/New_York', () => formatFileStamp(Date.UTC(2026, 6, 1, 12, 0, 0)))).toBe('20260701_080000-0400')
    expect(withTz('America/New_York', () => formatFileStamp(Date.UTC(2026, 0, 1, 12, 0, 0)))).toBe('20260101_070000-0500')
  })

  it('桁を必ず埋める（ファイル名が時刻順に並ぶため）', () => {
    expect(withTz('Asia/Tokyo', () => formatFileStamp(Date.UTC(2026, 0, 1, 18, 4, 5)))).toBe('20260102_030405+0900')
  })

  // `withTz` が復元することの契約テスト。**同じファイルの後続のテストを守るために置く**
  // （テストファイルどうしは別プロセスで走るので互いには漏れない）。formatFileStamp 自体は
  // 時間帯を読むだけなので、漏れうるのはこのヘルパーだけ
  it('時間帯を元へ戻す（同じファイルの後続を巻き込まない）', () => {
    const before = process.env.TZ
    withTz('Asia/Kathmandu', () => formatFileStamp(BASE))
    expect(process.env.TZ).toBe(before)
  })
})
