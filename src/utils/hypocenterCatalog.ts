// 長期震源カタログ（public/data/hypocenter/）を読む。
//
// 気象庁「地震月報（カタログ編）」を加工した静的データで、統計解析（b 値・静穏化・余震域・
// 同一地点履歴・深さ断面）の土台。生成は `scripts/build-hypocenter-catalog.ts`。
//
// 【年別に分かれている】1 ファイルにまとめると 15MB 前後になるため年ごとに分けてある。
// 用途に応じて必要な年だけ読む（時計盤なら 1 年、b 値なら 10 年、というように）。
//
// 【直近 30 日とは別物】このカタログは 2023 年までの確定値。直近はヒートマップが使う
// `useQuakeHeatmap`（DMDATA / P2PQuake）の担当で、母集団も更新頻度も違う。混ぜて統計に使わない。
//
// 【列で持つ】1 件 1 オブジェクトに展開すると数十万件でメモリを大きく食う。列ごとの
// TypedArray で保持し、利用側は添字で読む。

import { fetchJsonWithTimeout } from './fetchJson'

const BASE_URL = `${import.meta.env.BASE_URL}data/hypocenter`

/** 索引。どの年が使えるかと、出典・件数を持つ。 */
export interface HypocenterIndex {
  source: string
  sourceUrl: string
  license: string
  /** 収録した M の下限。これより小さい地震は入っていない。 */
  minMagnitude: number
  /** 収録されている年（昇順）。 */
  years: number[]
  /** 年ごとの件数。 */
  counts: Record<string, number>
}

/** 1 年ぶんの震源。各配列は同じ長さで、同じ添字が同じ地震を指す。 */
export interface HypocenterYear {
  year: number
  count: number
  /** 発生時刻（UTC epoch ミリ秒）。 */
  timeMs: Float64Array
  /** 緯度（度）。 */
  lat: Float64Array
  /** 経度（度）。 */
  lng: Float64Array
  /** 深さ (km)。 */
  depth: Float32Array
  /** マグニチュード。 */
  magnitude: Float32Array
}

/** 生成スクリプトが書き出す形。読み込み直後だけ使う。 */
interface RawYear {
  year: number
  startMs: number
  coordScale: number
  depthScale: number
  magScale: number
  count: number
  t: number[]
  lat: number[]
  lng: number[]
  dep: number[]
  mag: number[]
}

let indexCache: HypocenterIndex | null = null
let indexInflight: Promise<HypocenterIndex> | null = null
const yearCache = new Map<number, HypocenterYear>()
const yearInflight = new Map<number, Promise<HypocenterYear>>()

/** 索引を取得する。初回のみ fetch し、以降はキャッシュを返す。 */
export function loadHypocenterIndex(): Promise<HypocenterIndex> {
  if (indexCache) return Promise.resolve(indexCache)
  if (!indexInflight) {
    indexInflight = fetchJsonWithTimeout<HypocenterIndex>(`${BASE_URL}/index.json`, 'hypocenter-index', {
      // 地図の表示には関わらないため、地図の「データの一部を取得できませんでした」には計上しない
      // （TTS 辞書・テストシナリオと同じ扱い）。
      trackStatus: false,
      validate: (data) => {
        if (!data || typeof data !== 'object' || !Array.isArray((data as HypocenterIndex).years)) {
          throw new Error('hypocenter index: 形が不正です')
        }
        if ((data as HypocenterIndex).years.length === 0) {
          throw new Error('hypocenter index: 収録年が 0 件です')
        }
      },
    })
      .then((data) => {
        indexCache = data
        return data
      })
      .catch((err) => {
        indexInflight = null
        throw err
      })
  }
  return indexInflight
}

/**
 * 1 年ぶんを取得する。初回のみ fetch し、以降はキャッシュを返す。
 *
 * 読み込んだ時点で TypedArray へ移し、格納単位（1/10000 度など）を実数へ戻す。
 * **単位は年ファイル自身が持っている値を使う** —— 索引側の値と食い違ったとき、読んだファイルの
 * 側を信じる方が桁がずれない。
 */
export function loadHypocenterYear(year: number): Promise<HypocenterYear> {
  const cached = yearCache.get(year)
  if (cached) return Promise.resolve(cached)
  const running = yearInflight.get(year)
  if (running) return running

  const p = fetchJsonWithTimeout<RawYear>(`${BASE_URL}/${year}.json`, `hypocenter-${year}`, {
    trackStatus: false,
    validate: (data) => {
      const raw = data as RawYear
      if (!raw || typeof raw !== 'object' || typeof raw.count !== 'number') {
        throw new Error(`hypocenter ${year}: 形が不正です`)
      }
      // **列の長さが揃っていることを必ず確かめる。** 1 本でも欠けると添字がずれ、別の地震の
      // 座標と M を組み合わせた値を黙って返すことになる。
      for (const key of ['t', 'lat', 'lng', 'dep', 'mag'] as const) {
        const col = raw[key]
        if (!Array.isArray(col) || col.length !== raw.count) {
          throw new Error(`hypocenter ${year}: ${key} の長さが count と一致しません`)
        }
      }
      if (typeof raw.startMs !== 'number' || !Number.isFinite(raw.startMs)) {
        throw new Error(`hypocenter ${year}: startMs がありません`)
      }
      // **格納単位も必ず確かめる。** 欠けていると `数値 / undefined` が NaN になり、その年の
      // 座標・深さ・M が**例外を投げずに全件 NaN で埋まる**。検分しなければ「取得成功」として
      // 通り、統計側でグラフが崩れるまで誰も気づけない。
      for (const key of ['coordScale', 'depthScale', 'magScale'] as const) {
        const scale = raw[key]
        if (typeof scale !== 'number' || !Number.isFinite(scale) || scale === 0) {
          throw new Error(`hypocenter ${year}: ${key} が不正です`)
        }
      }
    },
  })
    .then((raw) => {
      const n = raw.count
      const out: HypocenterYear = {
        year: raw.year,
        count: n,
        timeMs: new Float64Array(n),
        lat: new Float64Array(n),
        lng: new Float64Array(n),
        depth: new Float32Array(n),
        magnitude: new Float32Array(n),
      }
      for (let i = 0; i < n; i++) {
        // 時刻は「その年の頭からの経過秒」で入っている。起点は年ファイルが持っているので、
        // ここで日本時間を意識する必要はない。
        out.timeMs[i] = raw.startMs + raw.t[i] * 1000
        out.lat[i] = raw.lat[i] / raw.coordScale
        out.lng[i] = raw.lng[i] / raw.coordScale
        out.depth[i] = raw.dep[i] / raw.depthScale
        out.magnitude[i] = raw.mag[i] / raw.magScale
      }
      yearCache.set(year, out)
      yearInflight.delete(year)
      return out
    })
    .catch((err) => {
      yearInflight.delete(year)
      throw err
    })

  yearInflight.set(year, p)
  return p
}

/**
 * 複数年をまとめて取得する。並べ替えはせず、渡した順に返す。
 *
 * **1 年でも失敗したら全体を失敗させる。** 統計は期間が欠けると意味が変わるため、
 * 「取れた年だけで計算する」を既定にすると、欠けたことに気づかないまま誤った値を出す。
 */
export function loadHypocenterYears(years: readonly number[]): Promise<HypocenterYear[]> {
  return Promise.all(years.map(loadHypocenterYear))
}
