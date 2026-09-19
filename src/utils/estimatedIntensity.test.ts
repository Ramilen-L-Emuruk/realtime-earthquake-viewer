// 推計震度分布図を地震カードへ結び付ける規則。
//
// **この電文は識別子を持たない**ので、突き合わせを外すとボタンが出ないまま黙る。
// 逆に緩すぎると、別の地震の分布を「気象庁の推計」として見せてしまう。両側を固定する。
import { describe, it, expect, vi } from 'vitest'
import {
  matchEstimatedIntensity, matchEstimatedIntensityArrival, estimatedIntensityFor,
  estimatedIntensityAvailability, decideEstimatedIntensityUpdate, isNewEstimatedIntensity,
  rememberShownEstimatedIntensity, MAX_SHOWN_ESTIMATED_INTENSITY_ARRIVALS,
} from './estimatedIntensity'
import type { JMAQuake, JMAEstimatedIntensity, IntensityScale } from '../types/earthquake'
import { CELL_LAT_DEG, CELL_LON_DEG } from './bufrEstimatedIntensity'

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
    cellLatDeg: CELL_LAT_DEG, cellLonDeg: CELL_LON_DEG,
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

// 読み上げが「受信しました」と「更新されました」を言い分けるための台帳。
//
// **判定そのもの（上の describe）とは別の軸。** 反映するかどうかは「いま出している 1 通」との
// 比較で決まるが、初報として読むかどうかは「その地震の分布を前に伝えたか」で決まる。
describe('isNewEstimatedIntensity / rememberShownEstimatedIntensity', () => {
  // 実電文（2024-01-01 の能登半島地震）の並び。JST では 16:10 が本震・16:18 が余震。
  const NOTO = '2024-01-01T07:10:00.000Z'
  const AFTERSHOCK = '2024-01-01T07:18:00.000Z'

  // 正: 別の地震の分布を挟んでも、前に伝えた地震の続報は「更新」として読む。
  // **これは `decideEstimatedIntensityUpdate` の理由では出せない** —— 挟まれた時点で
  // 「いま出している 1 通」が別の地震のものになり、続報が `switched` になる。
  it('別の地震の分布を挟んでも、前に伝えた地震の続報は更新として読む', () => {
    const shown: string[] = []
    expect(isNewEstimatedIntensity(shown, NOTO)).toBe(true)          // 16:20 本震の初報
    rememberShownEstimatedIntensity(shown, NOTO)
    expect(isNewEstimatedIntensity(shown, AFTERSHOCK)).toBe(true)    // 16:23 余震
    rememberShownEstimatedIntensity(shown, AFTERSHOCK)
    expect(isNewEstimatedIntensity(shown, NOTO)).toBe(false)         // 16:26 本震の続報
  })

  // 対照: 初めて見る地震は「受信」。直前に別の分布を伝えていても変わらない。
  it('初めて見る地震は受信として読む', () => {
    const shown: string[] = []
    rememberShownEstimatedIntensity(shown, NOTO)
    expect(isNewEstimatedIntensity(shown, AFTERSHOCK)).toBe(true)
  })

  // 安全弁: **積まなければ「受信」のまま。** 音も声も伴わない注入では積まない、という
  // 呼び出し側の規約をこの向きで支える。積んでしまうと、聞いていない報を前提に
  // 「更新されました」と読むことになる。
  it('積んでいない分布は台帳に残らない', () => {
    const shown: string[] = []
    expect(isNewEstimatedIntensity(shown, NOTO)).toBe(true)
    expect(isNewEstimatedIntensity(shown, NOTO)).toBe(true)
    expect(shown).toHaveLength(0)
  })

  // 安全弁: 同じ地震を二度積んでも枠を食わない。続報は何通でも届くので、積むたびに伸ばすと
  // 上限がその地震だけで埋まり、並行している別の地震が押し出される。
  it('同じ地震を二度積んでも枠を食わない', () => {
    const shown: string[] = []
    rememberShownEstimatedIntensity(shown, NOTO)
    rememberShownEstimatedIntensity(shown, NOTO)
    expect(shown).toEqual([NOTO])
  })

  // 安全弁: 上限を超えたら古いものから落ちる（落ちた地震は「受信」へ戻る）。
  // 際限なく覚えると、長時間つないだ端末で伸び続ける。**落としたことは記録に残す** ——
  // ライブ運用では台帳が空になる契機が無いので、数日つなぎ続ければ上限に届きうる。そこで
  // 誤読（続報を「受信しました」と読む）が起きたとき、記録が無いと原因を追えない。
  it('上限を超えたら古いものから落ち、落とした分を記録する', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const shown: string[] = [NOTO]
      for (let i = 0; i < MAX_SHOWN_ESTIMATED_INTENSITY_ARRIVALS; i++) {
        rememberShownEstimatedIntensity(shown, `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`)
      }
      expect(shown).toHaveLength(MAX_SHOWN_ESTIMATED_INTENSITY_ARRIVALS)
      expect(isNewEstimatedIntensity(shown, NOTO)).toBe(true)
      expect(info).toHaveBeenCalledWith(expect.anything(), expect.stringContaining(NOTO))
    } finally {
      info.mockRestore()
    }
  })

  // 対照: 上限に届かないうちは何も落とさず、記録も出さない（通常運転でログを汚さない）。
  it('上限に届かないうちは記録を出さない', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      const shown: string[] = []
      rememberShownEstimatedIntensity(shown, NOTO)
      rememberShownEstimatedIntensity(shown, AFTERSHOCK)
      expect(info).not.toHaveBeenCalled()
    } finally {
      info.mockRestore()
    }
  })
})
