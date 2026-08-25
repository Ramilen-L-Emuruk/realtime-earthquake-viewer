import { describe, it, expect } from 'vitest'
import {
  NO_SCOPE,
  hasNearby,
  quakeScaleForScope,
  kyoshinScaleForScope,
  eewScaleForScope,
  type NearbyScope,
} from './actionChecklistTrigger'
import type { EEWAlert, JMAQuake } from '../types/earthquake'

const MIN = 45 // 震度5弱

function scope(partial: Partial<NearbyScope>): NearbyScope {
  return { ...NO_SCOPE, ...partial }
}

function quake(maxScale: number, points: JMAQuake['points']): JMAQuake {
  return {
    id: 'q1',
    time: '2026/08/24 00:00:00',
    issue: { source: '', time: '', type: '震源・震度情報' },
    earthquake: {
      time: '2026/08/24 00:00:00',
      hypocenter: { name: '東京湾', latitude: 35.5, longitude: 139.8, depth: 10, magnitude: 6.0 },
      maxScale,
      domesticTsunami: 'None',
    },
    points,
  } as unknown as JMAQuake
}

const NEAR = scope({ stationNames: new Set(['新宿区西新宿']) })

describe('quakeScaleForScope', () => {
  it('地域を絞れないときは電文の最大震度で判定する', () => {
    expect(quakeScaleForScope(quake(50, []), NO_SCOPE, MIN)).toBe(50)
    expect(quakeScaleForScope(quake(40, []), NO_SCOPE, MIN)).toBe(null)
  })

  it('地域を絞れるときは半径内の観測点だけを見る', () => {
    const q = quake(70, [
      { pref: '静岡県', addr: '静岡市', isArea: false, scale: 70 },
      { pref: '東京都', addr: '新宿区西新宿', isArea: false, scale: 30 },
    ])
    // 全国では震度7だが、自宅の周りは震度3なので出さない
    expect(quakeScaleForScope(q, NEAR, MIN)).toBe(null)
  })

  it('半径内の観測点が閾値に達していれば出す', () => {
    const q = quake(50, [{ pref: '東京都', addr: '新宿区西新宿', isArea: false, scale: 45 }])
    expect(quakeScaleForScope(q, NEAR, MIN)).toBe(45)
  })

  // 真偽ではなく震度を返すのは、判定した範囲と表示する震度をずらさないため。全国の最大震度を
  // 返してしまうと「自宅の周りで判定した」と言いながら遠方の震度をバッジに出すことになる。
  it('返すのは半径内の最大震度で、全国の最大震度ではない', () => {
    const q = quake(70, [
      { pref: '静岡県', addr: '静岡市', isArea: false, scale: 70 },
      { pref: '東京都', addr: '新宿区西新宿', isArea: false, scale: 50 },
    ])
    expect(quakeScaleForScope(q, NEAR, MIN)).toBe(50)
  })

  // 当初は区域の点を一律に無視していたが、震度速報は区域しか持たないため、地点を登録している
  // 人ほど発火しないという逆転が起きた。いまは区域も `regionNames` と突き合わせて見る。
  it('区域の点は区域名の索引で引き当てる（観測点名では引かない）', () => {
    const q = quake(50, [{ pref: '東京都', addr: '東京都23区', isArea: true, scale: 50 }])
    // NEAR は stationNames しか持たないので、この区域は引き当てられない。
    // 該当する点が 1 つも無いため全国基準へ倒れ、maxScale 50 で発火する。
    expect(quakeScaleForScope(q, NEAR, MIN)).toBe(50)
  })

  // DMDATA（DMDSS 版）の電文は観測点も区域も `pref` を空で積む（quake-spec.md §4）。
  // 県名を含むキーで突き合わせていたため、DMDSS 版で地点を登録すると構造的に 1 件も一致せず、
  // この経路が恒久的に死んでいた。
  it('pref が空の電文（DMDSS 版）でも観測点名で引き当てる', () => {
    const q = quake(50, [{ pref: '', addr: '新宿区西新宿', isArea: false, scale: 45 }])
    expect(quakeScaleForScope(q, NEAR, MIN)).toBe(45)
  })

  it('pref が非空の電文（標準版）でも同じく引き当てる', () => {
    const q = quake(50, [{ pref: '東京都', addr: '新宿区西新宿', isArea: false, scale: 45 }])
    expect(quakeScaleForScope(q, NEAR, MIN)).toBe(45)
  })

  it('閾値が -1（出さない）なら常に null', () => {
    expect(quakeScaleForScope(quake(70, []), NO_SCOPE, -1)).toBe(null)
  })
})

// 実地震テストシナリオの手書き JSON など、型検査を通らない経路から階級表に無い値が来る
// （eew.ts の eewMaxScaleInfo も同じ理由で実行時に弾いている）。
describe('壊れた震度の扱い', () => {
  it('階級表に無い震度の点は「観測できなかった」ものとして全国基準へ倒す', () => {
    // 半径内の点が壊れた値しか持たない。これを matched に数えると全国基準へ倒れず、
    // 黙って出なくなる。
    const q = quake(60, [{ pref: '東京都', addr: '新宿区西新宿', isArea: false, scale: 99 } as unknown as NonNullable<JMAQuake['points']>[number]])
    expect(quakeScaleForScope(q, NEAR, MIN)).toBe(60)
  })

  it('壊れた震度を最大値として返さない', () => {
    const q = quake(50, [
      { pref: '東京都', addr: '新宿区西新宿', isArea: false, scale: 99 } as unknown as NonNullable<JMAQuake['points']>[number],
      { pref: '東京都', addr: '新宿区西新宿', isArea: false, scale: 45 },
    ])
    expect(quakeScaleForScope(q, NEAR, MIN)).toBe(45)
  })

  it('電文の最大震度が壊れていれば全国基準でも出さない', () => {
    expect(quakeScaleForScope(quake(99, []), NO_SCOPE, MIN)).toBe(null)
  })

  it('EEW の壊れた予想震度も採らない', () => {
    const near = scope({ regionNames: new Set(['東京都23区']) })
    const e = eew([
      { pref: '東京都', name: '東京都23区', scaleFrom: 99, scaleTo: 99 },
    ] as unknown as EEWAlert['areas'])
    expect(eewScaleForScope(e, near, MIN)).toBe(null)
  })
})

describe('kyoshinScaleForScope', () => {
  // Yahoo のインデックス -> 震度: value = -3.0 + index * 0.5。index 19 で 6.5（震度7）
  const STRONG = 19
  const WEAK = 8 // 1.0（震度1）

  it('地域を絞れないときは全点を見る', () => {
    expect(kyoshinScaleForScope([WEAK, STRONG], NO_SCOPE, MIN)).not.toBe(null)
    expect(kyoshinScaleForScope([WEAK, WEAK], NO_SCOPE, MIN)).toBe(null)
  })

  it('地域を絞れるときは半径内の添字だけを見る', () => {
    const near = scope({ kyoshinIndices: [0] })
    // 添字 1 が強く揺れていても、自宅の周り（添字 0）は弱いので出さない
    expect(kyoshinScaleForScope([WEAK, STRONG], near, MIN)).toBe(null)
    expect(kyoshinScaleForScope([STRONG, WEAK], near, MIN)).not.toBe(null)
  })

  it('欠測（負のセンチネル）は無視して他の点で判定する', () => {
    const near = scope({ kyoshinIndices: [0, 1] })
    expect(kyoshinScaleForScope([-1, STRONG], near, MIN)).not.toBe(null)
  })

  // 大きな地震では近くの観測点がまとめて途絶しうる。それは「揺れていない」ことの証明ではない
  // ので、ここで諦めると最も情報が要る場面で最も早い経路だけが黙って止まる。
  it('半径内の点がすべて欠測なら全国基準へ倒す', () => {
    const near = scope({ kyoshinIndices: [0] })
    expect(kyoshinScaleForScope([-1, STRONG], near, MIN)).toBe(70)
  })

  // 対照: 震度0 は「観測できて揺れていない」。ここまで倒すと遠方の地震で毎回出ることになる。
  it('半径内の点が観測できていれば、閾値未満でも全国基準へ倒さない', () => {
    const near = scope({ kyoshinIndices: [0] })
    const ZERO = 6 // 0.0（震度0）
    expect(kyoshinScaleForScope([ZERO, STRONG], near, MIN)).toBe(null)
  })

  // 安全弁: 一部だけ欠測している場合は倒さない（残った点で判定する）
  it('半径内に生きている点が 1 つでもあれば、その範囲だけで判定する', () => {
    const near = scope({ kyoshinIndices: [0, 1] })
    const ZERO = 6
    expect(kyoshinScaleForScope([-1, ZERO, STRONG], near, MIN)).toBe(null)
  })

  // 当初は「閾値に達したか」の真偽だけを返していたため、呼び出し側が設定値をそのまま
  // 表示していた（実際に震度7でも「震度5弱」と出る）。実測の最大を返して表示に使う。
  it('閾値ではなく実際に観測した最大震度を返す', () => {
    expect(kyoshinScaleForScope([STRONG], NO_SCOPE, MIN)).toBe(70)
  })

  it('閾値に届かない点しか無ければ null', () => {
    expect(kyoshinScaleForScope([WEAK], NO_SCOPE, MIN)).toBe(null)
  })

  // 強震モニタは震度0 と震度1 の階級値がどちらも 10。設定は震度1 まで下げられるため、
  // 階級値だけで比べると平常時のノイズ（ほぼ全点が震度0 の帯）が閾値を通り、帯が鳴りっぱなしに
  // なる。震度0 は「揺れていない」ことなので、閾値がいくつでも対象にしない。
  describe('震度0 と震度1 の区別（閾値を震度1 まで下げたとき）', () => {
    const MIN1 = 10 // 震度1以上
    const ZERO = 6 // 0.0（震度0）
    const ONE = 8 // 1.0（震度1）

    it('震度0 の点しか無ければ出さない', () => {
      expect(kyoshinScaleForScope([ZERO, ZERO, ZERO], NO_SCOPE, MIN1)).toBe(null)
    })

    it('震度1 の点があれば出す', () => {
      expect(kyoshinScaleForScope([ZERO, ONE], NO_SCOPE, MIN1)).toBe(10)
    })

    // 安全弁: 震度0 を落とすのは「震度1 以上」の判定であって、上の閾値まで緩めない
    it('閾値が高いときの判定は変わらない', () => {
      expect(kyoshinScaleForScope([ZERO, ONE], NO_SCOPE, MIN)).toBe(null)
      expect(kyoshinScaleForScope([ZERO, STRONG], NO_SCOPE, MIN)).toBe(70)
    })
  })
})

function eew(areas: EEWAlert['areas']): EEWAlert {
  return { id: 'e1', areas } as unknown as EEWAlert
}

describe('eewScaleForScope', () => {
  const NEAR_REGION = scope({ regionNames: new Set(['東京都23区']) })

  it('地域を絞れないときは全区域を見る', () => {
    const e = eew([{ pref: '静岡県', name: '静岡県中部', scaleFrom: 50, scaleTo: 50 }] as EEWAlert['areas'])
    expect(eewScaleForScope(e, NO_SCOPE, MIN)).toBe(50)
  })

  it('地域を絞れるときは自宅の区域だけを見る', () => {
    const e = eew([
      { pref: '静岡県', name: '静岡県中部', scaleFrom: 60, scaleTo: 60 },
      { pref: '東京都', name: '東京都23区', scaleFrom: 30, scaleTo: 30 },
    ] as EEWAlert['areas'])
    expect(eewScaleForScope(e, NEAR_REGION, MIN)).toBe(null)
  })

  it('自宅の区域が閾値に達していれば出す', () => {
    const e = eew([{ pref: '東京都', name: '東京都23区', scaleFrom: 45, scaleTo: 45 }] as EEWAlert['areas'])
    expect(eewScaleForScope(e, NEAR_REGION, MIN)).toBe(45)
  })

  // 判定は自宅の区域だけを見ているのに、表示する震度が全国最大では「強い揺れが来ます」と
  // 言いながら遠方の震度を出すことになる。
  it('返すのは自宅の区域の予想震度で、全区域の最大ではない', () => {
    const e = eew([
      { pref: '熊本県', name: '熊本県熊本', scaleFrom: 60, scaleTo: 60 },
      { pref: '東京都', name: '東京都23区', scaleFrom: 50, scaleTo: 50 },
    ] as EEWAlert['areas'])
    expect(eewScaleForScope(e, NEAR_REGION, MIN)).toBe(50)
  })

  it('上限が定まらない報でも下限が閾値に達していれば出す', () => {
    const e = eew([
      { pref: '東京都', name: '東京都23区', scaleFrom: 45, scaleTo: 45, scaleToOrAbove: true },
    ] as EEWAlert['areas'])
    expect(eewScaleForScope(e, NEAR_REGION, MIN)).toBe(45)
  })

  it('区域名を引けない（旧データ等）ときは全国基準へ倒す', () => {
    const e = eew([{ pref: '静岡県', name: '静岡県中部', scaleFrom: 50, scaleTo: 50 }] as EEWAlert['areas'])
    const emptyRegions = scope({ stationNames: new Set(['新宿区西新宿']) })
    expect(eewScaleForScope(e, emptyRegions, MIN)).toBe(50)
  })
})

describe('hasNearby', () => {
  it('3 つとも空なら地域を絞れない', () => {
    expect(hasNearby(NO_SCOPE)).toBe(false)
  })

  it('どれか 1 つでもあれば絞れる', () => {
    expect(hasNearby(scope({ kyoshinIndices: [0] }))).toBe(true)
    expect(hasNearby(scope({ stationNames: new Set(['どこかの観測点']) }))).toBe(true)
    expect(hasNearby(scope({ regionNames: new Set(['x']) }))).toBe(true)
  })
})

// ── レビューで見つかった 2 つの穴の回帰テスト ──
// どちらも「地点を登録している人ほど出なくなる」という逆転を起こしていた。

describe('区域しか持たない地震情報（震度速報）', () => {
  // 震度速報は観測点を持たず区域別震度だけを載せる（quake-spec.md §4）。
  // 観測点だけを見ていたため、地点を登録していると永久に発火しなかった。
  const NEAR_REGION = scope({
    stationNames: new Set(['新宿区西新宿']),
    regionNames: new Set(['東京都23区']),
  })

  it('半径内の区域が閾値に達していれば出す', () => {
    const q = quake(50, [{ pref: '東京都', addr: '東京都23区', isArea: true, scale: 50 }])
    expect(quakeScaleForScope(q, NEAR_REGION, MIN)).toBe(50)
  })

  it('半径内の区域が閾値未満なら、半径外がいくら強くても出さない', () => {
    // 半径内の区域（東京都23区）が電文に載っていて閾値未満。これは「自宅は揺れていない」と
    // 読めるので全国基準へは倒さない。倒すと遠方の地震で毎回出ることになる。
    const q = quake(70, [
      { pref: '静岡県', addr: '静岡県中部', isArea: true, scale: 70 },
      { pref: '東京都', addr: '東京都23区', isArea: true, scale: 30 },
    ])
    expect(quakeScaleForScope(q, NEAR_REGION, MIN)).toBe(null)
  })

  it('半径内に該当する点が 1 つも無ければ全国基準へ倒す（出さない方へ倒さない）', () => {
    // 区域名の索引と電文の区域名が噛み合わない場合。揺れが無い証明ではないので全国基準で見る。
    const q = quake(60, [{ pref: '不明県', addr: '未知の区域', isArea: true, scale: 60 }])
    expect(quakeScaleForScope(q, NEAR_REGION, MIN)).toBe(60)
  })

  it('半径内の点があって閾値未満なら出さない（全国基準へ倒さない）', () => {
    const q = quake(70, [{ pref: '東京都', addr: '新宿区西新宿', isArea: false, scale: 30 }])
    expect(quakeScaleForScope(q, NEAR_REGION, MIN)).toBe(null)
  })
})

describe('区域を持たない EEW（standard 版・Yahoo hypoInfo 由来の初期検知）', () => {
  // standard 版は Yahoo hypoInfo で先に検知し、後着の P2PQuake が区域を補う（eew-spec.md §3）。
  // 補われる前の報は areas を持たず、予想震度は forecastMaxScale にしか入らない。
  // areas だけを見ていたため、この窓ではこの経路が丸ごと死んでいた。
  function eewNoAreas(forecastMaxScale: number): EEWAlert {
    return {
      id: 'e-std',
      areas: [],
      forecastMaxScale,
      earthquake: { condition: undefined },
    } as unknown as EEWAlert
  }

  it('区域が無くても forecastMaxScale が閾値に達していれば出す', () => {
    expect(eewScaleForScope(eewNoAreas(50), NO_SCOPE, MIN)).toBe(50)
  })

  it('区域が無く forecastMaxScale が閾値未満なら出さない', () => {
    expect(eewScaleForScope(eewNoAreas(30), NO_SCOPE, MIN)).toBe(null)
  })

  it('地点を登録していても、区域が無ければ全国基準で判定する', () => {
    const near = scope({
      stationNames: new Set(['新宿区西新宿']),
      regionNames: new Set(['東京都23区']),
    })
    expect(eewScaleForScope(eewNoAreas(50), near, MIN)).toBe(50)
  })
})
