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
import type { DetectedPoint } from './kyoshinDetectionView'

const MIN = 45 // 震度5弱

/**
 * 全件版（`known*`）は既定で半径内の集合と同じにする。
 *
 * 実運用では両者は同じ座標テーブルから作られ、全件版は必ず半径内の集合を含む。索引が噛み合って
 * いるかの判定はこの関係に依存するので、テストでも保つ。噛み合わない状況を作りたいときは、
 * こちらが知らない名前を電文側に置く。
 */
function scope(partial: Partial<NearbyScope>): NearbyScope {
  const merged = { ...NO_SCOPE, ...partial }
  return {
    ...merged,
    knownStationNames: partial.knownStationNames ?? merged.stationNames,
    knownRegionNames: partial.knownRegionNames ?? merged.regionNames,
  }
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
  const HOME_KEY = '35.700,139.700'
  const FAR_KEY = '34.700,135.500'

  /** 検知エンジンが確定と判断したメンバー観測点（`deriveKyoshinView` の解決結果）。 */
  function pt(key: string, index: number): DetectedPoint {
    return { key, lat: 35, lng: 139, index }
  }

  // 生の観測値を素通しで走査していたため、1 点の跳ね上がりがそのまま表示される震度になっていた
  // （実データ 793 窓の再生で、気象庁発表が震度1 の地震に震度5弱、震度4 の地震に震度6弱と出た）。
  // 渡すのは検知エンジンが「近傍の点が揃って上がった」と認めたメンバーだけ。
  it('確定した揺れが無ければ出さない', () => {
    expect(kyoshinScaleForScope([], NO_SCOPE, MIN)).toBe(null)
  })

  it('地域を絞れないときは確定メンバー全体を見る', () => {
    expect(kyoshinScaleForScope([pt(FAR_KEY, WEAK), pt(HOME_KEY, STRONG)], NO_SCOPE, MIN)).toBe(70)
    expect(kyoshinScaleForScope([pt(FAR_KEY, WEAK), pt(HOME_KEY, WEAK)], NO_SCOPE, MIN)).toBe(null)
  })

  it('地域を絞れるときは半径内の観測点だけを見る', () => {
    const near = scope({ kyoshinKeys: new Set([HOME_KEY]) })
    // 遠方が強く揺れていても、自宅の周りが弱いので出さない
    expect(kyoshinScaleForScope([pt(FAR_KEY, STRONG), pt(HOME_KEY, WEAK)], near, MIN)).toBe(null)
    expect(kyoshinScaleForScope([pt(FAR_KEY, WEAK), pt(HOME_KEY, STRONG)], near, MIN)).toBe(70)
  })

  // 対照: 半径内に確定メンバーが無いのは「近所は揺れていない」。ここで全国基準へ倒すと、
  // 遠方の地震で毎回出ることになり、地点を登録した意味が消える。
  it('半径内に確定メンバーが無ければ出さない', () => {
    const near = scope({ kyoshinKeys: new Set([HOME_KEY]) })
    expect(kyoshinScaleForScope([pt(FAR_KEY, STRONG)], near, MIN)).toBe(null)
  })

  // 安全弁: 離島など半径内に強震モニタの観測点が 1 つも無い端末では絞れない。
  // 「近くに点が無いから出さない」は、まさに情報が要る人に出さない結果になる。
  it('半径内に強震モニタの観測点が無ければ確定メンバー全体で判定する', () => {
    const near = scope({ stationNames: new Set(['どこかの観測点']) })
    expect(kyoshinScaleForScope([pt(FAR_KEY, STRONG)], near, MIN)).toBe(70)
  })

  it('欠測（負のセンチネル）は無視して他の点で判定する', () => {
    const near = scope({ kyoshinKeys: new Set([HOME_KEY, FAR_KEY]) })
    expect(kyoshinScaleForScope([pt(FAR_KEY, -1), pt(HOME_KEY, STRONG)], near, MIN)).toBe(70)
  })

  // 安全弁: 大きな地震では近くの観測点がまとめて途絶しうる。それは「揺れていない」ことの証明では
  // ないので、ここで諦めると最も情報が要る場面で最も早い経路だけが黙って止まる。確定メンバーでも
  // 値は欠測へ戻りうる（`deriveKyoshinView` は値の有無に関わらず点を作る）。
  it('半径内の確定メンバーがすべて欠測なら全国基準へ倒す', () => {
    const near = scope({ kyoshinKeys: new Set([HOME_KEY]) })
    expect(kyoshinScaleForScope([pt(HOME_KEY, -1), pt(FAR_KEY, STRONG)], near, MIN)).toBe(70)
  })

  // 対照: 震度0 は「観測できて揺れていない」。ここまで倒すと遠方の地震で毎回出ることになる。
  it('半径内の点が観測できていれば、閾値未満でも全国基準へ倒さない', () => {
    const near = scope({ kyoshinKeys: new Set([HOME_KEY]) })
    const ZERO = 6 // 0.0（震度0）
    expect(kyoshinScaleForScope([pt(HOME_KEY, ZERO), pt(FAR_KEY, STRONG)], near, MIN)).toBe(null)
  })

  // 安全弁: 一部だけ欠測している場合は倒さない（残った点で判定する）
  it('半径内に生きている点が 1 つでもあれば、その範囲だけで判定する', () => {
    const near = scope({ kyoshinKeys: new Set([HOME_KEY, 'near-b']) })
    const ZERO = 6
    const points = [pt(HOME_KEY, -1), pt('near-b', ZERO), pt(FAR_KEY, STRONG)]
    expect(kyoshinScaleForScope(points, near, MIN)).toBe(null)
  })

  // 当初は「閾値に達したか」の真偽だけを返していたため、呼び出し側が設定値をそのまま
  // 表示していた（実際に震度7でも「震度5弱」と出る）。実測の最大を返して表示に使う。
  it('閾値ではなく実際に観測した最大震度を返す', () => {
    expect(kyoshinScaleForScope([pt(HOME_KEY, STRONG)], NO_SCOPE, MIN)).toBe(70)
  })

  it('閾値に届かない点しか無ければ null', () => {
    expect(kyoshinScaleForScope([pt(HOME_KEY, WEAK)], NO_SCOPE, MIN)).toBe(null)
  })

  // 強震モニタは震度0 と震度1 の階級値がどちらも 10。設定は震度1 まで下げられるため、
  // 階級値だけで比べると平常時のノイズ（ほぼ全点が震度0 の帯）が閾値を通り、帯が鳴りっぱなしに
  // なる。震度0 は「揺れていない」ことなので、閾値がいくつでも対象にしない。
  describe('震度0 と震度1 の区別（閾値を震度1 まで下げたとき）', () => {
    const MIN1 = 10 // 震度1以上
    const ZERO = 6 // 0.0（震度0）
    const ONE = 8 // 1.0（震度1）

    it('震度0 の点しか無ければ出さない', () => {
      const points = [pt('a', ZERO), pt('b', ZERO), pt('c', ZERO)]
      expect(kyoshinScaleForScope(points, NO_SCOPE, MIN1)).toBe(null)
    })

    it('震度1 の点があれば出す', () => {
      expect(kyoshinScaleForScope([pt('a', ZERO), pt('b', ONE)], NO_SCOPE, MIN1)).toBe(10)
    })

    // 安全弁: 震度0 を落とすのは「震度1 以上」の判定であって、上の閾値まで緩めない
    it('閾値が高いときの判定は変わらない', () => {
      expect(kyoshinScaleForScope([pt('a', ZERO), pt('b', ONE)], NO_SCOPE, MIN)).toBe(null)
      expect(kyoshinScaleForScope([pt('a', ZERO), pt('b', STRONG)], NO_SCOPE, MIN)).toBe(70)
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
    expect(hasNearby(scope({ kyoshinKeys: new Set(['35.700,139.700']) }))).toBe(true)
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

  it('索引と噛み合わない電文は全国基準へ倒す（出さない方へ倒さない）', () => {
    // 区域名の索引と電文の区域名が噛み合わない場合。揺れが無い証明ではないので全国基準で見る。
    const q = quake(60, [{ pref: '不明県', addr: '未知の区域', isArea: true, scale: 60 }])
    expect(quakeScaleForScope(q, NEAR_REGION, MIN)).toBe(60)
  })

  it('半径内の点があって閾値未満なら出さない（全国基準へ倒さない）', () => {
    const q = quake(70, [{ pref: '東京都', addr: '新宿区西新宿', isArea: false, scale: 30 }])
    expect(quakeScaleForScope(q, NEAR_REGION, MIN)).toBe(null)
  })
})

// 「半径内の点が電文に載っていない」の読み方は 2 通りある（近所が揺れていない／索引が噛み合って
// いない）。両方を後者として扱っていたため、遠方の地震では地点を登録した意味が消えていた
// （実測: 2018 年大阪府北部地震を東京の地点で受けると、最初に届く震度速報 3 本がいずれも半径内
// 0 件になり、全国基準の震度6弱で発火する。電文には震度1以上の観測点しか載らないため、
// 自宅の周りが無感なら 0 件になるのが普通）。
describe('半径内が電文に載っていないとき', () => {
  const NEAR_TOKYO = scope({
    stationNames: new Set(['新宿区西新宿']),
    regionNames: new Set(['東京都23区']),
    // 全件版は全国を知っている（半径外の観測点・区域も引ける）
    knownStationNames: new Set(['新宿区西新宿', '大阪北区茶屋町']),
    knownRegionNames: new Set(['東京都23区', '大阪府北部']),
  })

  it('電文の点を 1 件でも引けるなら、近所は揺れていないと読んで出さない', () => {
    const q = quake(55, [{ pref: '', addr: '大阪北区茶屋町', isArea: false, scale: 55 }])
    expect(quakeScaleForScope(q, NEAR_TOKYO, MIN)).toBe(null)
  })

  it('区域しか持たない電文（震度速報）でも同じ', () => {
    const q = quake(55, [{ pref: '', addr: '大阪府北部', isArea: true, scale: 55 }])
    expect(quakeScaleForScope(q, NEAR_TOKYO, MIN)).toBe(null)
  })

  // 対照: 1 件も引けないなら索引が古い等で判定できない。揺れが無い証明ではないので全国基準。
  it('電文の点を 1 件も引けなければ全国基準へ倒す', () => {
    const q = quake(55, [{ pref: '', addr: '未知の観測点', isArea: false, scale: 55 }])
    expect(quakeScaleForScope(q, NEAR_TOKYO, MIN)).toBe(55)
  })

  // 安全弁: 引けた点の震度が壊れていたら噛み合いの証拠にしない（走査でも飛ばしている点なので、
  // ここだけ数えると値の使えない点で「近所は揺れていない」と結論することになる）
  it('引ける点が壊れた震度しか持たなければ全国基準へ倒す', () => {
    const q = quake(55, [
      { pref: '', addr: '大阪北区茶屋町', isArea: false, scale: 99 } as unknown as NonNullable<JMAQuake['points']>[number],
    ])
    expect(quakeScaleForScope(q, NEAR_TOKYO, MIN)).toBe(55)
  })

  // 安全弁: 地点を登録していない端末では絞れないので、この判定は働かない（従来どおり全国基準）
  it('地点を登録していなければ従来どおり全国基準', () => {
    const q = quake(55, [{ pref: '', addr: '大阪北区茶屋町', isArea: false, scale: 55 }])
    expect(quakeScaleForScope(q, NO_SCOPE, MIN)).toBe(55)
  })

  // 「載っていない」から言えることは電文の粒度で決まる。震度速報は震度3以上の区域しか載せない
  // ので、そこから言えるのは「震度3未満」まで。それより低い閾値では判定できない。
  describe('区域しか持たない電文（震度速報）の下限', () => {
    const areaOnly = quake(55, [{ pref: '', addr: '大阪府北部', isArea: true, scale: 55 }])

    it('閾値が震度3以上なら、載っていない区域は閾値未満と読んで出さない', () => {
      expect(quakeScaleForScope(areaOnly, NEAR_TOKYO, 30)).toBe(null)
    })

    // 対照: 判定できない閾値では全国基準へ倒す。**ここで保留すると二度と評価されないことがある**
    // ——見るのは常に最新の 1 件なので、観測点を載せた続報が届く前に別の地震が起きると、
    // 古い方は先頭へ戻れない。
    it('閾値が震度1・2 なら判定できないので全国基準へ倒す', () => {
      expect(quakeScaleForScope(areaOnly, NEAR_TOKYO, 10)).toBe(55)
      expect(quakeScaleForScope(areaOnly, NEAR_TOKYO, 20)).toBe(55)
    })

    // 安全弁: 観測点の点を持つ電文は震度1以上を全部載せるので、閾値が震度1でも出さなくてよい
    it('観測点を持つ電文なら閾値が震度1でも出さない', () => {
      const withStation = quake(55, [{ pref: '', addr: '大阪北区茶屋町', isArea: false, scale: 55 }])
      expect(quakeScaleForScope(withStation, NEAR_TOKYO, 10)).toBe(null)
    })
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
