// 推計震度分布図（IXAC41）を地震カードへ結び付ける規則。
//
// **この電文は識別子を持たない**ので、突き合わせを外すとボタンが出ないまま黙る。
// 逆に緩すぎると、別の地震の分布を「気象庁の推計」として見せてしまう。両側を固定する。
import { describe, it, expect } from 'vitest'
import {
  matchEstimatedIntensity, matchEstimatedIntensityArrival, estimatedIntensityFor,
  estimatedIntensityAvailability, decideEstimatedIntensityUpdate, isNewEstimatedIntensity,
} from './estimatedIntensity'
import type { JMAQuake, JMAEstimatedIntensity, IntensityScale } from '../types/earthquake'

function quake(time: string, lat = 32.6, lng = 130.7, maxScale: IntensityScale = 70): JMAQuake {
  return {
    kind: 'quake',
    id: 'q1',
    time,
    issue: { source: '気象庁', time, type: '震源・震度情報', correct: 'なし' },
    earthquake: {
      time,
      hypocenter: { name: '熊本県熊本地方', latitude: lat, longitude: lng, depth: 10, magnitude: 7.1 },
      maxScale,
      domesticTsunami: '警報',
    },
    points: [],
  } as unknown as JMAQuake
}

function ei(arrivalTime: string, lat = 32.6, lon = 130.7): JMAEstimatedIntensity {
  return {
    // 発表時刻は実電文と同じ JST 表記。**stale の判定は文字列の辞書順**なので、
    // 表記が混ざると比較が狂う（`Head/ReportDateTime` は常に +09:00）。
    id: 'ix1', time: '2026-07-28T16:32:00+09:00', arrivalTime,
    hypocenter: { lat, lon, depthKm: 10 },
    magnitude: 7.1, areaCode: 741, telegramKind: 0,
    grades: [{ scale: 4, modifier: 'none', lower: 35, upper: 44 }],
    count: 1, lat: new Float32Array([32.6]), lon: new Float32Array([130.7]), si: new Uint8Array([42]),
    bounds: { south: 32.6, north: 32.61, west: 130.7, east: 130.71 },
  }
}

describe('matchEstimatedIntensity', () => {
  // 正: 同じ地震発現時刻・同じ震源なら結び付く。
  // カードの `earthquake.time` は JST 表記、電文側は UTC。**同じ瞬間なら表記が違っても通ること。**
  it('同じ発現時刻の地震に結び付く', () => {
    expect(matchEstimatedIntensity(quake('2026-07-28T16:27:00+09:00'), ei('2026-07-28T07:27:00.000Z'))).toBe(true)
  })

  // 対照: 1 分ずれたら別の地震。**この 1 分がまさに罠**で、発現時刻と発生時刻を取り違えると
  // ここが常にずれる（実電文で 1 分ずれる例がある）。
  it('発現時刻が 1 分でも違えば結び付かない', () => {
    expect(matchEstimatedIntensity(quake('2026-07-28T16:27:00+09:00'), ei('2026-07-28T07:26:00.000Z'))).toBe(false)
    expect(matchEstimatedIntensity(quake('2026-07-28T16:27:00+09:00'), ei('2026-07-28T07:28:00.000Z'))).toBe(false)
  })

  // 正: 秒が違っても同じ分なら結び付く（電文は分までしか持たない）。
  it('秒の違いは無視する', () => {
    expect(matchEstimatedIntensity(quake('2026-07-28T16:27:43+09:00'), ei('2026-07-28T07:27:00.000Z'))).toBe(true)
  })

  // 安全弁: 同じ分でも震源が遠ければ別の地震。**同じ分に別の地震が起きたときの取り違え**を防ぐ。
  it('同じ分でも震源が遠ければ結び付かない', () => {
    // 熊本（32.6N 130.7E）と岩手県沖（39.8N 143.2E）は 1400km 以上離れている
    expect(matchEstimatedIntensity(
      quake('2026-07-28T16:27:00+09:00', 32.6, 130.7),
      ei('2026-07-28T07:27:00.000Z', 39.8, 143.2),
    )).toBe(false)
  })

  // 対照: 震源要素は続報で動く（VXSE61 が訂正する）。**近い範囲のずれでは落とさない。**
  it('震源が少し動いていても結び付く', () => {
    expect(matchEstimatedIntensity(
      quake('2026-07-28T16:27:00+09:00', 32.6, 130.7),
      ei('2026-07-28T07:27:00.000Z', 32.9, 131.0),
    )).toBe(true)
  })

  // 安全弁: 震源が読めないカード（震度速報しか届いていない段階）は時刻だけで判定する。
  // ここで距離を要求すると、位置不明のセンチネル（-200）と比べて必ず外れる。
  it('震源が読めないカードは時刻だけで判定する', () => {
    expect(matchEstimatedIntensity(
      quake('2026-07-28T16:27:00+09:00', -200, -200),
      ei('2026-07-28T07:27:00.000Z'),
    )).toBe(true)
  })

  // 安全弁: 日時として読めない値で真を返さない（P2PQuake 経路の表記など）。
  it('日時として読めなければ結び付かない', () => {
    expect(matchEstimatedIntensity(quake('よくわからない時刻'), ei('2026-07-28T07:27:00.000Z'))).toBe(false)
  })
})

describe('matchEstimatedIntensityArrival', () => {
  // 正: 震源を渡さなければ時刻だけで判定する。
  it('震源を渡さなければ時刻だけで判定する', () => {
    expect(matchEstimatedIntensityArrival(quake('2026-07-28T16:27:00+09:00'), '2026-07-28T07:27:00.000Z')).toBe(true)
  })

  // 安全弁: **震源を渡したら本体を持つ判定と同じ結果になること。** 自動で分布モードを開く側は
  // 3MB の本体を持ち回さないので別の入口を通るが、ここが緩いと違うカードのモードが開く。
  it('震源を渡せば本体を持つ判定と同じになる', () => {
    const far = ei('2026-07-28T07:27:00.000Z', 39.8, 143.2)
    const q = quake('2026-07-28T16:27:00+09:00', 32.6, 130.7)
    expect(matchEstimatedIntensityArrival(q, far.arrivalTime, far.hypocenter.lat, far.hypocenter.lon))
      .toBe(matchEstimatedIntensity(q, far))
    const near = ei('2026-07-28T07:27:00.000Z', 32.9, 131.0)
    expect(matchEstimatedIntensityArrival(q, near.arrivalTime, near.hypocenter.lat, near.hypocenter.lon))
      .toBe(matchEstimatedIntensity(q, near))
  })
})

describe('estimatedIntensityFor', () => {
  it('持っていなければ null', () => {
    expect(estimatedIntensityFor(quake('2026-07-28T16:27:00+09:00'), null)).toBeNull()
  })
  it('別の地震のものなら null', () => {
    expect(estimatedIntensityFor(quake('2026-07-28T16:27:00+09:00'), ei('2026-07-28T07:20:00.000Z'))).toBeNull()
  })
  it('同じ地震のものなら返す', () => {
    const x = ei('2026-07-28T07:27:00.000Z')
    expect(estimatedIntensityFor(quake('2026-07-28T16:27:00+09:00'), x)).toBe(x)
  })
})

describe('estimatedIntensityAvailability', () => {
  // 正: 引き当てられたら公式。
  it('引き当てられたら official', () => {
    expect(estimatedIntensityAvailability(quake('t', 32.6, 130.7, 70), ei('t'))).toBe('official')
  })

  // 対照: 震度5弱以上なら、まだ届いていないだけ（発表の条件は満たしている）。
  it('震度5弱以上で未着なら awaiting', () => {
    for (const s of [45, 50, 55, 60, 70] as IntensityScale[]) {
      expect(estimatedIntensityAvailability(quake('t', 32.6, 130.7, s), null), String(s)).toBe('awaiting')
    }
  })

  // 安全弁: 震度4以下は**そもそも発表されない**。ここを awaiting に倒すと、
  // ほとんどの地震で「待っています」が永久に居座り、欠けていないものが欠けて見える。
  it('震度4以下は notIssued', () => {
    for (const s of [-1, 10, 20, 30, 40] as IntensityScale[]) {
      expect(estimatedIntensityAvailability(quake('t', 32.6, 130.7, s), null), String(s)).toBe('notIssued')
    }
  })
})

describe('decideEstimatedIntensityUpdate', () => {
  // 熊本（先に起きた地震）と、その 4 分後に別の場所で起きた地震。発表もその順。
  const kuma = { arrivalTime: '2026-07-28T07:27:00.000Z', time: '2026-07-28T16:32:00+09:00', count: 1693 }
  const later = { arrivalTime: '2026-07-28T07:31:00.000Z', time: '2026-07-28T16:36:00+09:00', count: 812 }

  // 正: 最初の 1 通は無条件で反映する。
  it('持っていなければ反映する', () => {
    expect(decideEstimatedIntensityUpdate(null, kuma)).toEqual({ apply: true, reason: 'first' })
  })

  // 正: 同じ地震の続報（セル数が増えた・発表時刻が進んだ）は反映する。
  it('同じ地震の新しい報は反映する', () => {
    expect(decideEstimatedIntensityUpdate(kuma, { ...kuma, time: '2026-07-28T16:38:00+09:00', count: 1701 }))
      .toEqual({ apply: true, reason: 'newer' })
  })

  // 正: 別の地震の、より新しい分布へは入れ替える。**アプリが持つのは最新の 1 通だけ。**
  it('別の地震の新しい報へ入れ替える', () => {
    expect(decideEstimatedIntensityUpdate(kuma, later)).toEqual({ apply: true, reason: 'switched' })
  })

  // 対照: 同じ地震の古い報では退行しない。
  it('同じ地震の古い報では退行しない', () => {
    expect(decideEstimatedIntensityUpdate({ ...kuma, time: '2026-07-28T16:38:00+09:00' }, kuma))
      .toEqual({ apply: false, reason: 'stale' })
  })

  // 安全弁: **別の地震のものでも、発表が古ければ採らない。**
  // 到着順は発表順と一致しない（分割の結合が遅れる・当日経路とライブが前後する）ので、
  // 比較を「同じ地震どうし」に限ると、遅れて届いた古い地震の分布が新しいほうを押しのける。
  // 震度5弱以上が短時間に続く場面でだけ起きる——いちばん起きてほしくないときに起きる。
  it('別の地震でも発表が古ければ採らない', () => {
    expect(decideEstimatedIntensityUpdate(later, kuma)).toEqual({ apply: false, reason: 'stale' })
  })

  // 安全弁: 内容が同じ重複配信は反映しない（実電文で観測している）。
  // ここを通すと 3MB の入れ替えと再描画が無駄に走る。
  it('内容が同じ重複配信は反映しない', () => {
    expect(decideEstimatedIntensityUpdate(kuma, { ...kuma })).toEqual({ apply: false, reason: 'duplicate' })
  })

  // 安全弁: 同じ発表時刻でもセル数が違えば別の内容。**重複と混ぜない。**
  it('同じ発表時刻でもセル数が違えば反映する', () => {
    expect(decideEstimatedIntensityUpdate(kuma, { ...kuma, count: 1694 }))
      .toEqual({ apply: true, reason: 'newer' })
  })
})

// 読み上げが「受信しました」と「更新されました」を言い分けるための写像。
//
// **判定そのもの（上の describe）とは別に固定する。** 反映するかどうかと、初報として読むか
// どうかは別の問いで、`switched` の扱いがここだけ違う。
describe('isNewEstimatedIntensity', () => {
  // 正: 同じ地震の続報だけが「更新」。
  it('同じ地震の続報は更新として読む', () => {
    expect(isNewEstimatedIntensity('newer')).toBe(false)
  })

  // 対照: 初めての分布は当然「受信」。
  it('初めての分布は受信として読む', () => {
    expect(isNewEstimatedIntensity('first')).toBe(true)
  })

  // 安全弁: **別の地震へ入れ替えたときも「受信」。** 聞き手にとっては初めて届いた分布で、
  // ここで「更新されました」と言うと、直前まで読んでいた地震の分布が差し替わったように
  // 聞こえる。反映した（`apply: true`）という点では `newer` と同じなので、真偽へ潰すと
  // この区別が消える。
  it('別の地震へ入れ替えたときは受信として読む', () => {
    expect(isNewEstimatedIntensity('switched')).toBe(true)
  })
})
