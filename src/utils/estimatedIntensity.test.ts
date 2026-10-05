// 推計震度分布図を地震カードへ結び付ける規則。
//
// **この電文は識別子を持たない**ので、突き合わせを外すとボタンが出ないまま黙る。
// 逆に緩すぎると、別の地震の分布を「気象庁の推計」として見せてしまう。両側を固定する。
import { describe, it, expect, vi } from 'vitest'
import {
  matchEstimatedIntensity, matchEstimatedIntensityArrival, estimatedIntensityFor,
  estimatedIntensityAvailability, decideEstimatedIntensityUpdate, isNewEstimatedIntensity,
  isSameEstimatedIntensityQuake, upsertEstimatedIntensity,
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
    expect(estimatedIntensityFor(quake('2026-07-28T16:27:00+09:00'), [])).toBeNull()
  })
  it('別の地震のものしか無ければ null', () => {
    expect(estimatedIntensityFor(quake('2026-07-28T16:27:00+09:00'), [ei('2026-07-28T07:20:00.000Z')])).toBeNull()
  })
  it('同じ地震のものなら返す', () => {
    const x = ei('2026-07-28T07:27:00.000Z')
    expect(estimatedIntensityFor(quake('2026-07-28T16:27:00+09:00'), [x])).toBe(x)
  })

  // 正: **地震ごとに持つので、過去の地震のカードにも引き当たる**（最新の 1 通しか持たなかった
  // 頃は、後から別の地震の分布が届いた時点で前の地震のカードから消えていた）。
  it('別の地震の分布が後から届いていても、自分の地震のものを返す', () => {
    const older = ei('2026-07-28T07:27:00.000Z')
    const newer = { ...ei('2026-07-28T09:05:00.000Z', 35.0, 139.0), time: '2026-07-28T18:20:00+09:00' }
    expect(estimatedIntensityFor(quake('2026-07-28T16:27:00+09:00'), [older, newer])).toBe(older)
    expect(estimatedIntensityFor(quake('2026-07-28T18:05:00+09:00', 35.0, 139.0), [older, newer])).toBe(newer)
  })

  // 安全弁: 同じ地震とみなせるものが複数あっても（一覧の不変条件が崩れた場合）、発表の新しい方を返す。
  it('同じ地震のものが重なっていたら発表の新しい方を返す', () => {
    const a = ei('2026-07-28T07:27:00.000Z')
    const b = { ...a, time: '2026-07-28T16:38:00+09:00' }
    expect(estimatedIntensityFor(quake('2026-07-28T16:27:00+09:00'), [b, a])).toBe(b)
    expect(estimatedIntensityFor(quake('2026-07-28T16:27:00+09:00'), [a, b])).toBe(b)
  })
})

describe('isSameEstimatedIntensityQuake', () => {
  // 正: 発現時刻（分）が同じで震源が近ければ同じ地震。カードとの引き当てと同じ物差し。
  it('同じ分で震源が近ければ同じ地震', () => {
    expect(isSameEstimatedIntensityQuake(ei('2026-07-28T07:27:10.000Z'), ei('2026-07-28T07:27:40.000Z', 32.7, 130.8))).toBe(true)
  })
  // 対照: 分が違えば別の地震。
  it('分が違えば別の地震', () => {
    expect(isSameEstimatedIntensityQuake(ei('2026-07-28T07:27:00.000Z'), ei('2026-07-28T07:28:00.000Z'))).toBe(false)
  })
  // 安全弁: 同じ分でも離れていれば別の地震（同じ分に離れた地方で起きた地震を 1 つに畳まない）。
  it('同じ分でも震源が離れていれば別の地震', () => {
    expect(isSameEstimatedIntensityQuake(ei('2026-07-28T07:27:00.000Z'), ei('2026-07-28T07:27:00.000Z', 43.0, 145.0))).toBe(false)
  })
})

describe('upsertEstimatedIntensity', () => {
  const kumaEi = ei('2026-07-28T07:27:00.000Z')
  const otherEi = { ...ei('2026-07-28T07:31:00.000Z', 35.0, 139.0), time: '2026-07-28T16:36:00+09:00', count: 812 }

  // 正: 別の地震の分布は**置き換えずに足す**。
  it('別の地震の分布は足して両方持つ', () => {
    const r = upsertEstimatedIntensity([kumaEi], otherEi)
    expect(r.update).toEqual({ apply: true, reason: 'first' })
    expect(r.list).toEqual([kumaEi, otherEi])
  })

  // 正: 同じ地震の続報は、その地震の 1 通だけを置き換える（他の地震の分布は残る）。
  it('同じ地震の続報はその 1 通だけを置き換える', () => {
    const follow = { ...kumaEi, time: '2026-07-28T16:38:00+09:00', count: 1701 }
    const r = upsertEstimatedIntensity([kumaEi, otherEi], follow)
    expect(r.update).toEqual({ apply: true, reason: 'newer' })
    expect(r.list).toEqual([follow, otherEi])
  })

  // 安全弁: **遅れて届いた古い地震の分布が、新しい地震の分布を押しのけない。**
  // 最新の 1 通しか持たなかった頃は「別の地震でも発表が古ければ採らない」で防いでいたが、
  // その代わりに古い地震の分布を捨てていた。地震ごとに持てば両方残せる。
  it('発表の古い別の地震の分布も、新しい地震の分布を消さずに足す', () => {
    const r = upsertEstimatedIntensity([otherEi], kumaEi)
    expect(r.update).toEqual({ apply: true, reason: 'first' })
    expect(r.list).toEqual([otherEi, kumaEi])
  })

  // 対照: 同じ地震の古い報・重複配信では一覧を変えない（参照も変えない＝再描画を起こさない）。
  it('同じ地震の古い報と重複配信では一覧を変えない', () => {
    const follow = { ...kumaEi, time: '2026-07-28T16:38:00+09:00' }
    const list = [follow, otherEi]
    const stale = upsertEstimatedIntensity(list, kumaEi)
    expect(stale.update).toEqual({ apply: false, reason: 'stale' })
    expect(stale.list).toBe(list)
    const dup = upsertEstimatedIntensity(list, { ...follow })
    expect(dup.update).toEqual({ apply: false, reason: 'duplicate' })
    expect(dup.list).toBe(list)
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

// 同じ地震の 1 通（第 1 引数）と、届いた報（第 2 引数）を比べる。**別の地震との比較はしない**
// —— 地震ごとに持つので、別の地震の分布は `upsertEstimatedIntensity` が足すだけ。
describe('decideEstimatedIntensityUpdate', () => {
  const kuma = { arrivalTime: '2026-07-28T07:27:00.000Z', time: '2026-07-28T16:32:00+09:00', count: 1693 }

  // 正: その地震の分布をまだ持っていなければ反映する。
  it('持っていなければ反映する', () => {
    expect(decideEstimatedIntensityUpdate(null, kuma)).toEqual({ apply: true, reason: 'first' })
  })

  // 正: 同じ地震の続報（セル数が増えた・発表時刻が進んだ）は反映する。
  it('同じ地震の新しい報は反映する', () => {
    expect(decideEstimatedIntensityUpdate(kuma, { ...kuma, time: '2026-07-28T16:38:00+09:00', count: 1701 }))
      .toEqual({ apply: true, reason: 'newer' })
  })


  // 対照: 同じ地震の古い報では退行しない。
  it('同じ地震の古い報では退行しない', () => {
    expect(decideEstimatedIntensityUpdate({ ...kuma, time: '2026-07-28T16:38:00+09:00' }, kuma))
      .toEqual({ apply: false, reason: 'stale' })
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
// **判定そのもの（上の describe）とは別の軸。** 反映するかどうかは「同じ地震の 1 通」との
// 比較で決まるが、初報として読むかどうかは「その地震の分布を前に伝えたか」で決まる ——
// 履歴から黙って取り込んだ分布は持っているが、まだ伝えていない。
describe('isNewEstimatedIntensity / rememberShownEstimatedIntensity', () => {
  // 実電文（2024-01-01 の能登半島地震）の並び。JST では 16:10 が本震・16:18 が余震。
  const NOTO = '2024-01-01T07:10:00.000Z'
  const AFTERSHOCK = '2024-01-01T07:18:00.000Z'

  // 正: 別の地震の分布を挟んでも、前に伝えた地震の続報は「更新」として読む。
  // （かつてアプリが最新の 1 通しか持たなかった頃、反映の判定の理由で言い分けていて
  // この並びで誤った。台帳を分けたのはそのため。）
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
