// 公開観測点（気象庁の広帯域地震計・EarthScope の JP 網）の表（`public/data/public-stations.json`）。
//
// 表は `scripts/build-public-stations.ts` が EarthScope の観測点情報から作る。**エポック（観測点の運用の区切り）ごとに
// 1 行**で、場所・感度・成分・名前を持つ。使う側は時刻で有効なエポックを選ぶ —— 下部の波形は「いま」、
// 地震カードは地震の時刻、リプレイ中は再生している時刻（`docs/public-waveform-design.md` §0）。

import { fetchJsonWithTimeout } from './fetchJson'
import { log } from './logger'

/** 公開観測点で扱う成分（広帯域の 3 成分）。 */
export type PublicChannelCode = 'BHE' | 'BHN' | 'BHZ'

export interface PublicChannel {
  code: PublicChannelCode
  /** 上流が名乗る採取率（Hz）。照合用で、描くときはレコードの見出しの値を使う */
  sampleRate: number
  /** カウント/(m/s) */
  sensitivity: number
  /** 感度を定めた周波数（Hz） */
  sensitivityFreq: number
  azimuth: number
  dip: number
}

export interface PublicStationEpoch {
  code: string
  nameJa: string
  /** EarthScope の英字の地名 */
  siteName: string
  lat: number
  lon: number
  /** 標高（m） */
  elevation: number
  /** 運用の始め（UTC・秒までの ISO 8601・この時刻を含む） */
  start: string
  /**
   * 運用の終わり（UTC・秒までの ISO 8601・**この時刻を含まない**）。続いているなら null。
   * 上流は終わりを `23:59:59.9999` のように含む側で書くので、秒へ切り上げて半開区間にしている。
   * 上流が終わりを小数秒つき（`.9999`）で書く限り、同じ場所の次のエポックの始めと同じ時刻になる。
   * 重なりは止めるが、エポックの間の穴（宮古島の 2013-03-26〜27 のように実在する）は検査しない
   */
  end: string | null
  channels: PublicChannel[]
}

export interface PublicStationsFile {
  source: { station: string; channel: string }
  /** 上流から取った日（UTC・YYYY-MM-DD） */
  fetchedOn: string
  stations: PublicStationEpoch[]
  /** 波形の成分を持たないので外したエポック（コードと期間） */
  excluded: { code: string; start: string; end: string | null; reason: string }[]
}

/** 網のコード（気象庁）。 */
export const PUBLIC_NETWORK = 'JP'

/** その時刻に運用しているか（始めを含み、終わりを含まない）。 */
export function isEpochActiveAt(epoch: PublicStationEpoch, atMs: number): boolean {
  const start = Date.parse(epoch.start)
  if (!(start <= atMs)) return false
  if (epoch.end === null) return true
  return atMs < Date.parse(epoch.end)
}

/**
 * その時刻に運用しているエポックを観測点ごとに 1 つずつ返す（表の並び順のまま）。**同じ観測点に有効なエポックが
 * 2 つあるのは表の誤り**（生成の段で重なりを止めている）なので、そのときは先に現れたほうを使う。
 */
export function activeEpochsAt(file: PublicStationsFile, atMs: number): PublicStationEpoch[] {
  const seen = new Set<string>()
  const out: PublicStationEpoch[] = []
  for (const epoch of file.stations) {
    if (seen.has(epoch.code) || !isEpochActiveAt(epoch, atMs)) continue
    seen.add(epoch.code)
    out.push(epoch)
  }
  return out
}

const DATA_URL = `${import.meta.env.BASE_URL}data/public-stations.json`

let cache: PublicStationsFile | null = null
let inflight: Promise<PublicStationsFile> | null = null

/**
 * 公開観測点の表を取得する。初回のみ fetch し、以降はキャッシュを返す。
 * 取得に失敗した場合（タイムアウトを含む）は inflight を破棄して次回リトライ可能にする。
 */
export function loadPublicStations(): Promise<PublicStationsFile> {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = fetchJsonWithTimeout<PublicStationsFile>(DATA_URL, 'public-stations')
      .then((data) => {
        cache = data
        return data
      })
      .catch((err) => {
        inflight = null
        throw err
      })
  }
  return inflight
}

const listeners = new Set<(file: PublicStationsFile) => void>()
let checked: Promise<PublicStationsFile> | null = null

/** 照合で表が更新されたら、カードと下部の波形へ同じ表を渡す。 */
export function subscribePublicStations(listener: (file: PublicStationsFile) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 波形が必要になった最初の1回だけ照合する。失敗しても生成済みの表を保ち、再接続ごとに問い合わせない。 */
export function checkPublicStations(): Promise<PublicStationsFile> {
  if (checked === null) {
    checked = loadPublicStations().then(async baseline => {
      try {
        const { fetchPublicStationMetadata } = await import('../services/publicStationMetadata')
        const next = await fetchPublicStationMetadata(baseline)
        if (next !== baseline) {
          cache = next
          log.info('[public-wave] 観測点情報の更新を検出し、運用期間・場所・名前・感度を更新した')
          for (const listener of listeners) listener(next)
        }
        return next
      } catch (error) {
        log.warn('[public-wave] 観測点情報を照合できなかったため生成済みの表を使う', error)
        return baseline
      }
    })
  }
  return checked
}
