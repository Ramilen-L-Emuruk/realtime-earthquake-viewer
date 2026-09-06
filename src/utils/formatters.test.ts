import { describe, it, expect } from 'vitest'
import { formatCoordinate, formatDepth, formatMagnitude, formatMagnitudeCondition, formatMagnitudeValue, formatMagnitudeWithCondition, formatFileStamp } from './formatters'
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

// 規模が数値にならないときの説明（`jmx_eb:Magnitude@description`）。
// 「Ｍ不明」と「Ｍ８を超える巨大地震」はどちらも数値なしで届くが、後者は M8 を超えて
// 速報できないという別の事実で、最も伝えるべき場面に出る。
describe('規模の説明の表示', () => {
  // 正: 全角の記号・数字を半角へ揃える（同じ欄に並ぶ数値表示に合わせる）。
  it('全角の記号・数字を半角にする', () => {
    expect(formatMagnitudeCondition('Ｍ８を超える巨大地震')).toBe('M8を超える巨大地震')
  })

  // 安全弁: 数字を含まない語はそのまま残す。
  it('数字を含まない説明はそのまま残す', () => {
    expect(formatMagnitudeCondition('Ｍ不明')).toBe('M不明')
  })

  // 正: 「マグニチュード」の見出しを別に出す欄では、重ならないよう先頭の記号を落とす。
  it('見出しがある欄では先頭の記号を落とす', () => {
    expect(formatMagnitudeValue(NaN, 'Ｍ８を超える巨大地震')).toBe('8を超える巨大地震')
    expect(formatMagnitudeValue(NaN, 'Ｍ不明')).toBe('不明')
  })

  // 対照: 数値が読めるなら説明があっても数値を出す。
  it('数値が読めれば数値を出す', () => {
    expect(formatMagnitudeValue(7.6, 'Ｍ８を超える巨大地震')).toBe('7.6')
  })

  // 安全弁: 説明が無い規模不明は従来どおり「不明」。
  it('説明が無ければ不明のまま', () => {
    expect(formatMagnitudeValue(NaN)).toBe('不明')
    expect(formatMagnitudeValue(-1)).toBe('不明')
  })
})

// 震源の緯度・経度。遠地地震は世界中で起きるため負の値が来る。
describe('震源の座標の表記', () => {
  // 正: 南半球・西半球は向きを語で書く（気象庁の電文と同じ）。
  it('南半球・西半球を語で書く', () => {
    expect(formatCoordinate(-35.8, -72.7)).toBe('南緯 35.8° 西経 72.7°')
  })

  // 対照: 北半球・東半球は従来どおり。
  it('北半球・東半球は従来どおり', () => {
    expect(formatCoordinate(37.5, 138.6)).toBe('北緯 37.5° 東経 138.6°')
  })

  // 安全弁: 赤道・本初子午線は北緯・東経の側へ倒す（「南緯 0.0°」と書かない）。
  it('0 は北緯・東経として書く', () => {
    expect(formatCoordinate(0, 0)).toBe('北緯 0.0° 東経 0.0°')
  })

  // 桁数は呼び出し側が決める（震源要素は 0.1 度刻み、長期震源カタログはより細かい）。
  it('桁数を指定できる', () => {
    expect(formatCoordinate(-17.234, 178.567, 3)).toBe('南緯 17.234° 東経 178.567°')
  })

  // 安全弁: 読めない値はこの関数の中で弾く。呼び出し側のガードだけに任せると、ガードを持たない
  // 経路が足された日に「NaN°」が出る（`Infinity < 0` は偽なので向きの語まで誤る）。
  it('読めない値は不明にする', () => {
    expect(formatCoordinate(NaN, 138.6)).toBe('不明')
    expect(formatCoordinate(37.5, NaN)).toBe('不明')
    expect(formatCoordinate(Infinity, -Infinity)).toBe('不明')
  })
})

// 規模を出す欄はすべて 1 本の述語を通す。呼び出し側ごとに分岐を書くと経路を足すたびに漏れる。
describe('見出しに M を持たない欄の規模', () => {
  // 正: 数値があれば従来どおり。
  it('数値があれば M 付きで出す', () => {
    expect(formatMagnitudeWithCondition(7.6)).toBe('M7.6')
  })

  // 正: 数値が無くても説明があれば落とさない。
  it('説明があれば落とさない', () => {
    expect(formatMagnitudeWithCondition(NaN, 'Ｍ８を超える巨大地震')).toBe('M8を超える巨大地震')
  })

  // 対照: 説明が無ければ従来どおり「不明」（説明を持たない P2PQuake・EEW・カタログの経路）。
  it('説明が無ければ不明', () => {
    expect(formatMagnitudeWithCondition(NaN)).toBe('不明')
    expect(formatMagnitudeWithCondition(-1)).toBe('不明')
  })

  // 安全弁: 数値が読めるなら説明より数値を優先する。
  it('数値が読めれば数値を優先する', () => {
    expect(formatMagnitudeWithCondition(7.6, 'Ｍ８を超える巨大地震')).toBe('M7.6')
  })
})
