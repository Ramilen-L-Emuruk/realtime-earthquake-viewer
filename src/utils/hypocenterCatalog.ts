// 長期震源カタログ（public/data/hypocenter/）を読む。
//
// 気象庁の震源データを加工した静的データで、統計解析（b 値・静穏化・余震域・同一地点履歴・
// 深さ断面）の土台。生成は `scripts/build-hypocenter-catalog.ts`。
//
// 【年別に分かれている】1 ファイルにまとめると 30MB 前後になるため年ごとに分けてある。
// 用途に応じて必要な年だけ読む（時計盤なら 1 年、b 値なら 10 年、というように）。
//
// 【2 つの限界を必ず見ること】カタログは自分の限界を持っている。無視すると静かに嘘をつく。
//
//   1. `coveredThroughMs` —— データの終端。気象庁の「震源リスト」は 2 日前までしか載らない
//      ため、最近の数日は**必ず**欠ける。「まだ取っていない」と「地震が無かった」は、
//      格子の濃淡では区別できない。終端より先は「未取得」として描くこと。
//   2. `completeness` —— 期間ごとの完全性。収録は M2.0 以上だが、**M2.0 の取りこぼしが
//      無いのは 1997 年以降だけ。** 1919〜1950 年は年 505 件しか記録がない（現代は 2 万件超）。
//      統計に使うなら `completeMinMagnitude()` で閾値を上げること。
//
// 【直近 30 日とは母集団が違う】このカタログは M2.0 以上の全地震。ヒートマップが使う
// `useQuakeHeatmap`（DMDATA / P2PQuake）は**震度を観測した地震だけ**で、1 日あたり 6〜7 件
// （カタログは 88 件）。10 倍以上違うので、繋いで日別回数や統計に使わない。
//
// 【列で持つ】1 件 1 オブジェクトに展開すると数十万件でメモリを大きく食う。列ごとの
// TypedArray で保持し、利用側は添字で読む。

import { fetchJsonWithTimeout } from './fetchJson'

const BASE_URL = `${import.meta.env.BASE_URL}data/hypocenter`

/** 確定値（地震月報カタログ編）か速報値（震源リスト）か。 */
export type HypocenterQuality = 'final' | 'preliminary'

/** 「この年以降なら M いくつ以上が完全か」。`from` の昇順。 */
export interface HypocenterCompleteness {
  from: number
  minMagnitude: number
}

/** 索引。どの年が使えるかと、出典・件数・限界を持つ。 */
export interface HypocenterIndex {
  source: string
  sourceUrl: string
  license: string
  /** 収録した M の下限。これより小さい地震は入っていない。 */
  minMagnitude: number
  /**
   * データの終端（UTC epoch ミリ秒）。これより後は**未取得**であって、地震が無かったのではない。
   */
  coveredThroughMs: number
  /** 期間ごとの完全性。統計に使うときは `completeMinMagnitude()` を通すこと。 */
  completeness: HypocenterCompleteness[]
  /** 収録されている年（昇順）。 */
  years: number[]
  /** 年ごとの件数。 */
  counts: Record<string, number>
  /** 年ごとの確からしさ。 */
  quality: Record<string, HypocenterQuality>
  /** 最大震度を持つ年（確定値の年だけ。速報値には震度欄が無い）。 */
  intensityYears: number[]
}

/** 1 年ぶんの震源。各配列は同じ長さで、同じ添字が同じ地震を指す。時刻の昇順。 */
export interface HypocenterYear {
  year: number
  count: number
  /** この年のデータが覆っている終端（UTC epoch ミリ秒）。通年なら翌年の頭。 */
  coveredThroughMs: number
  quality: HypocenterQuality
  /**
   * 発生時刻（UTC epoch ミリ秒）。
   *
   * **日ごとに数えるなら日本時間の暦日へ寄せること。** `new Date(timeMs).getDate()` は実行環境の
   * タイムゾーンで答えが変わる（CI は UTC で回る）。カタログの時刻はもともと日本時間なので、
   * 日付境界は `timeMs + 9 * 3600 * 1000` を UTC として読むのが正しい。
   */
  timeMs: Float64Array
  /** 緯度（度）。 */
  lat: Float64Array
  /** 経度（度）。 */
  lng: Float64Array
  /** 深さ (km)。 */
  depth: Float32Array
  /** マグニチュード。 */
  magnitude: Float32Array
  /**
   * 最大震度を持つ地震の添字（昇順）。**疎に持つ** —— 有感は M2.0 以上の 11.9% しかない。
   * 速報値の年（`quality === 'preliminary'`）は震度欄が無いので空。
   */
  intensityIdx: Int32Array
  /**
   * `intensityIdx` と同じ長さ。最大震度の生コード。**震度の値と、震度でない分類が混在する。**
   *
   * | コード | 意味 |
   * |---|---|
   * | `1` `2` `3` `4` `7` | 震度 1・2・3・4・7 |
   * | `5` `6` | 震度 5・6（弱強の区分が無い時代。1996 年 9 月まで） |
   * | `A` `B` `C` `D` | 震度 5 弱・5 強・6 弱・6 強（1996 年 10 月以降） |
   * | `F` `X` | 有感地震・付近有感（**震度の値ではない**） |
   * | `L` `S` `M` `R` | 最大有感距離による顕著度（**震度ではない**。1977 年まで） |
   *
   * **「震度 5 以上」を文字比較で絞ってはいけない。** ASCII では数字より英大文字の方が大きいので、
   * `code >= '5'` は `F` `X` `L` `S` `M` `R` まで拾う（1919〜2023 年で 7,190 件）。
   * 震度として扱えるのは上の表の前半 3 行だけで、実測 110,273 件のうち 103,083 件。
   *
   * **`5` `6` は `IntensityScale` に対応する値が無い。** アプリの階級値は 45（5 弱）と 50（5 強）に
   * 分かれているが、1996 年 9 月までの「震度 5」はその区分より前のもので、どちらでもない（同様に
   * 「震度 6」は 55／60 のどちらでもない）。実測 199 件。**写すなら、どちらへ寄せるか・別扱いに
   * するかを決めてから**。ここで既定を置くと、その判断を隠したまま集計が進む。
   *
   * 「有感かどうか」だけなら添字に含まれるかどうかを見ればよい（どのコードも有感を意味する）。
   */
  intensityCode: string[]
}

/** 生成スクリプトが書き出す形。読み込み直後だけ使う。 */
interface RawYear {
  year: number
  startMs: number
  coveredThroughMs: number
  quality: HypocenterQuality
  coordScale: number
  depthScale: number
  magScale: number
  timeScale: number
  count: number
  t: number[]
  lat: number[]
  lng: number[]
  dep: number[]
  mag: number[]
  intIdx?: number[]
  intCode?: string[]
}

let indexCache: HypocenterIndex | null = null
let indexInflight: Promise<HypocenterIndex> | null = null
const yearCache = new Map<number, HypocenterYear>()
const yearInflight = new Map<number, Promise<HypocenterYear>>()

/**
 * その年以降を描くときに使うべき M の下限を返す。
 *
 * 収録は M2.0 以上だが、**M2.0 の取りこぼしが無いのは 1997 年以降だけ。** 観測網が疎だった
 * 時代を同じ濃淡で描くと「昔は地震が少なかった」という嘘になる。日別回数・b 値・静穏化の
 * ように件数を数える機能は、描く期間の**最も古い年**をここに渡して閾値を上げること。
 *
 * **使わなくてよいのは「その期間の完全性下限より上の M だけを扱う」場合。** M5 以上なら 1919 年から
 * 横ばいで取りこぼしが無いので、たとえば「この地点で起きた M5 以上」を並べるだけなら不要。
 * 逆に**同じ一覧に M2.0 以上を丸ごと入れるなら、古い期間は必ず薄くなる** —— 件数を数えていなくても、
 * 「近い順に 5 件」のような選び方は新しい期間へ偏る。期間を跨いで多寡を読ませる見せ方は避けること。
 */
export function completeMinMagnitude(index: HypocenterIndex, fromYear: number): number {
  // **黙って誤った閾値を返さない。** この関数の戻り値は統計の母集団を決めるので、
  // 呼び出し側の取り違えを例外にしないと、歪んだグラフが出るまで誰も気づけない。
  if (!Number.isFinite(fromYear)) {
    throw new Error(`completeMinMagnitude: fromYear が数値ではありません（${String(fromYear)}）`)
  }
  // **並び順に依存しない。** `from` が渡された年以前で最大のものを選ぶ。
  // 昇順を前提に「最後に一致したものが勝つ」書き方にすると、生成側の定数が並べ替えられた日に
  // 逆の閾値を返す —— 例外にならないので、観測網の歴史が地震活動の急減として表示される。
  let threshold = index.minMagnitude
  let bestFrom = -Infinity
  for (const entry of index.completeness) {
    if (entry.from <= fromYear && entry.from > bestFrom) {
      bestFrom = entry.from
      threshold = entry.minMagnitude
    }
  }
  // **収録の下限より下は返さない。** 入っていない地震を数えようとしても意味がない。
  return Math.max(threshold, index.minMagnitude)
}

/** 索引を取得する。初回のみ fetch し、以降はキャッシュを返す。 */
export function loadHypocenterIndex(): Promise<HypocenterIndex> {
  if (indexCache) return Promise.resolve(indexCache)
  if (!indexInflight) {
    indexInflight = fetchJsonWithTimeout<HypocenterIndex>(`${BASE_URL}/index.json`, 'hypocenter-index', {
      // 地図の表示には関わらないため、地図の「データの一部を取得できませんでした」には計上しない
      // （TTS 辞書・テストシナリオと同じ扱い）。
      trackStatus: false,
      validate: (data) => {
        const idx = data as HypocenterIndex
        if (!idx || typeof idx !== 'object' || !Array.isArray(idx.years)) {
          throw new Error('hypocenter index: 形が不正です')
        }
        if (idx.years.length === 0) {
          throw new Error('hypocenter index: 収録年が 0 件です')
        }
        // **年の中身まで見る。** 数値でない年が 1 つでも混ざると、そこから作った時刻が NaN になり、
        // 日付ピッカーへ渡すところで例外になる（`toDateInputValue`）。震源カタログタブは常時
        // マウントされているので、その例外は**アプリ全体を落とす**。下の `coveredThroughMs` と
        // 同じ厳しさで見ておく。
        for (const year of idx.years) {
          if (typeof year !== 'number' || !Number.isInteger(year)) {
            throw new Error(`hypocenter index: years に年として読めない値があります（${String(year)}）`)
          }
        }
        // **終端が無ければ失敗させる。** 無いまま通すと、消費側は「未取得」と「地震が無かった」を
        // 区別できないまま格子を描く。欠けていることに気づけるのはここだけ。
        if (typeof idx.coveredThroughMs !== 'number' || !Number.isFinite(idx.coveredThroughMs)) {
          throw new Error('hypocenter index: coveredThroughMs がありません')
        }
        // **完全性の表が無ければ失敗させる。** 無いと `completeMinMagnitude()` が収録の下限を
        // そのまま返し、1919 年からの日別回数を M2.0 で数えてしまう（観測網の歴史が地震活動に化ける）。
        if (!Array.isArray(idx.completeness) || idx.completeness.length === 0) {
          throw new Error('hypocenter index: completeness がありません')
        }
        for (const entry of idx.completeness) {
          if (typeof entry?.from !== 'number' || typeof entry?.minMagnitude !== 'number') {
            throw new Error('hypocenter index: completeness の形が不正です')
          }
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
 * 読み込んだ時点で TypedArray へ移し、格納単位（1/6000 度など）を実数へ戻す。
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
        // **要素の型まで見る。** `null` が混ざると `null / coordScale` は例外にも NaN にもならず
        // **0 になる** —— 北緯 0 度・東経 0 度という「もっともらしい嘘」が静かに紛れ込み、
        // 地図にアフリカ沖の地震として現れる。NaN なら下流で崩れて気づけるが、0 は気づけない。
        for (let i = 0; i < col.length; i++) {
          const v = col[i]
          if (typeof v !== 'number' || !Number.isFinite(v)) {
            throw new Error(`hypocenter ${year}: ${key}[${i}] が数値ではありません`)
          }
        }
      }
      if (typeof raw.startMs !== 'number' || !Number.isFinite(raw.startMs)) {
        throw new Error(`hypocenter ${year}: startMs がありません`)
      }
      // 索引と同じ理由で年ファイル側にも要る（索引を読み損ねても桁を取り違えないため）。
      if (typeof raw.coveredThroughMs !== 'number' || !Number.isFinite(raw.coveredThroughMs)) {
        throw new Error(`hypocenter ${year}: coveredThroughMs がありません`)
      }
      // **既定値を置かない。** 欠けたときに 'final' へ倒すと、速報値を確定値として扱う。
      if (raw.quality !== 'final' && raw.quality !== 'preliminary') {
        throw new Error(`hypocenter ${year}: quality が不正です`)
      }
      // **格納単位も必ず確かめる。** 欠けていると `数値 / undefined` が NaN になり、その年の
      // 時刻・座標・深さ・M が**例外を投げずに全件 NaN で埋まる**。検分しなければ「取得成功」として
      // 通り、統計側でグラフが崩れるまで誰も気づけない。
      //
      // **正の整数まで見る。** 0 だけを弾いても穴は残る —— 負の値なら符号が反転した座標を、
      // 小数なら桁がずれた時刻を、どちらも例外も NaN も出さずに「成功」として返す。
      for (const key of ['coordScale', 'depthScale', 'magScale', 'timeScale'] as const) {
        const scale = raw[key]
        if (typeof scale !== 'number' || !Number.isInteger(scale) || scale <= 0) {
          throw new Error(`hypocenter ${year}: ${key} が不正です`)
        }
      }
      // 震度は疎な 2 列。**片方だけ欠けたら失敗させる** —— 長さが違うと、別の地震の震度を
      // 返すことになる（座標の列ずれと同じ性質の事故）。
      const hasIdx = raw.intIdx != null
      const hasCode = raw.intCode != null
      if (hasIdx !== hasCode) {
        throw new Error(`hypocenter ${year}: intIdx と intCode は両方揃っている必要があります`)
      }
      if (hasIdx) {
        if (raw.intIdx!.length !== raw.intCode!.length) {
          throw new Error(`hypocenter ${year}: intIdx と intCode の長さが一致しません`)
        }
        // **値域も見る。** 範囲外の添字は例外にならず、消費側が別の地震の震度を引く
        // （列の長さずれと同じ性質の事故）。
        for (const i of raw.intIdx!) {
          if (!Number.isInteger(i) || i < 0 || i >= raw.count) {
            throw new Error(`hypocenter ${year}: intIdx に範囲外の添字があります（${String(i)}）`)
          }
        }
      }
    },
  })
    .then((raw) => {
      const n = raw.count
      const intIdx = raw.intIdx ?? []
      const out: HypocenterYear = {
        year: raw.year,
        count: n,
        coveredThroughMs: raw.coveredThroughMs,
        quality: raw.quality,
        timeMs: new Float64Array(n),
        lat: new Float64Array(n),
        lng: new Float64Array(n),
        depth: new Float32Array(n),
        magnitude: new Float32Array(n),
        intensityIdx: Int32Array.from(intIdx),
        intensityCode: raw.intCode ?? [],
      }
      for (let i = 0; i < n; i++) {
        // 時刻は「その年の頭からの経過時間 × timeScale」で入っている。起点も刻みも年ファイルが
        // 持っているので、ここで日本時間を意識する必要はない。
        out.timeMs[i] = raw.startMs + (raw.t[i] * 1000) / raw.timeScale
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
