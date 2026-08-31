// 自宅（ホーム地点）の周りにある観測点を集める。
//
// 【なぜ半径で切るか】「最寄りの 1 点」で自宅の揺れを代表させると、その点が停止した瞬間に判定が
// 死ぬ。かといって「近い順に K 点」で拾うと、観測点が疎な離島では数百 km 先の本土の点まで数に
// 入れてしまい、まったく別の場所の揺れを「自宅の揺れ」として扱う。半径で切れば、密な地域では
// 多くの点が入って欠測に強くなり、疎な地域では素直に「近くに点が無い」と分かる。
//
// 【欠測との関係】瞬断（1〜2 秒）は `kyoshinMissingHold` が直前値で吸収するため、ここでは何もしない。
// 数十秒に及ぶ恒久的な停止は保持期間を過ぎて値が消えるが、そのときは半径内の別の点が拾う。
//
// 【2 つの観測点集合】強震モニタ（Yahoo・約 1725 点・座標のみの配列）と気象庁の震度観測点
// （`station-coords.json`・約 4372 件・"県|観測点名" のキー）は**別物**。前者は観測点キーで
// 検知エンジンの出力と突き合わせ、後者は電文の観測点名と突き合わせる。用途ごとに関数を分けている
// のはこのため。
//
// 【全件版が要る理由】半径内の集合だけでは「近所が電文に載っていない」の意味が決まらない。
// 「載るほど揺れていない」のか「電文の粒度がこちらの索引と噛み合っていない」のかで、出すべきか
// どうかが正反対になる。全件版（`allStationNames` / `allRegionNames`）はその見分けに使う
// （`quakeScaleForScope`）。

import { haversineKm } from './geo'
import { computeSiteKeys } from './kyoshinDetector'
import type { SiteCoords } from '../services/kyoshin'
import type { StationCoordsData } from './stationCoords'

/**
 * 自宅の周りとみなす半径 (km)。
 *
 * 観測点は全国で約 1725 点（強震モニタ）、陸地面積 約 378,000km² に対して平均間隔はおよそ 15km。
 * 半径 30km なら平均 13 点前後が入るので、1〜2 点が停止していても判定が揺らがない。これより
 * 広げると震度が 1 階級近くずれうる（震度は距離で急に変わる）ため、精度と欠測耐性の折り合いとして
 * この値を採る。
 */
export const NEARBY_RADIUS_KM = 30

/** ホーム地点。`useSettings` の `homeLat` / `homeLon` から作る。 */
export interface HomePoint {
  lat: number
  lng: number
}

/**
 * 強震モニタの観測点のうち、半径内にあるものの**観測点キー**を返す。
 *
 * 添字ではなくキーを返すのは、突き合わせる相手が検知エンジンの出力だから。エンジンはメンバー
 * 観測点をキーで持ち（`DetectionEvent.memberKeys`）、それを解決した `DetectedPoint` もキーを
 * 持つ。**同一座標に複数の実体がある観測点が実在する**ため（`computeSiteKeys` の説明）、点の
 * 同一性は座標ではなくキーで判断する。
 *
 * **`sites` に穴（欠けた要素）があってはならない。** キーの生成を検知エンジンと共有した結果、
 * この関数も `computeSiteKeys` と同じ前提（密な配列）に従う。穴があれば例外になるが、同じ配列は
 * 検知エンジンの `step()` も同じ関数へ渡しているので、そこが先に壊れる。
 */
export function nearbyKyoshinKeys(
  sites: SiteCoords,
  home: HomePoint,
  radiusKm: number = NEARBY_RADIUS_KM,
): Set<string> {
  const keys = computeSiteKeys(sites)
  const found = new Set<string>()
  for (let i = 0; i < sites.length; i++) {
    const site = sites[i]
    const key = keys[i]
    if (!site || key == null) continue
    if (haversineKm(home.lat, home.lng, site[0], site[1]) <= radiusKm) found.add(key)
  }
  return found
}

/**
 * 気象庁の震度観測点のうち、半径内にあるものの**観測点名**を返す。
 *
 * **県名を含めない。** 座標テーブルのキーは "県|観測点名" だが、DMDATA（DMDSS 版）の電文は
 * 観測点も区域も `pref` を空で積む（[quake-spec.md](../../docs/spec/quake-spec.md) §4・
 * `dmdataParser.ts`）。"県|観測点名" で突き合わせると DMDSS 版では**構造的に 1 件も一致せず**、
 * 地点を登録した人ほど判定が死ぬ。観測点名だけで引けば両バリアントで成立する。
 *
 * 同名の観測点が別の県にある場合は取り違えうるが、半径 30km に限った集合なので実害は小さい
 * （同名の点が 30km 圏に同居することは考えにくい）。
 */
export function nearbyStationNames(
  data: StationCoordsData,
  home: HomePoint,
  radiusKm: number = NEARBY_RADIUS_KM,
): Set<string> {
  const names = new Set<string>()
  for (const [key, entry] of Object.entries(data.stations)) {
    if (!entry) continue
    if (haversineKm(home.lat, home.lng, entry[0], entry[1]) > radiusKm) continue
    const name = stationNameOf(key)
    if (name) names.add(name)
  }
  return names
}

/** 座標テーブルのキー（"県|観測点名"）から観測点名だけを取り出す。 */
function stationNameOf(key: string): string {
  return key.slice(key.indexOf('|') + 1)
}

/**
 * 座標テーブルが知っている**すべての**観測点名（半径で絞らない）。
 *
 * 電文に載っている観測点をこちらが引けるかどうかを見るために使う。1 件でも引ければ粒度は
 * 噛み合っているので、自宅の周りが載っていないのは「載るほど揺れていない」からだと言える。
 */
export function allStationNames(data: StationCoordsData): Set<string> {
  const names = new Set<string>()
  for (const key of Object.keys(data.stations)) {
    const name = stationNameOf(key)
    if (name) names.add(name)
  }
  return names
}

/** 座標テーブルが知っているすべての一次細分区域名（`allStationNames` と同じ用途）。 */
export function allRegionNames(data: StationCoordsData): Set<string> {
  return new Set(data.regionNames ?? [])
}

/**
 * 半径内の観測点が属する一次細分区域の名前を返す。
 *
 * EEW の予想震度は区域単位でしか表現されないため、自宅が対象区域に入っているかを
 * この集合と `EEWRegion.name` の照合で判定する。区域を持たない観測点（旧データ・
 * 区域の対応が取れていないもの）は黙って飛ばす。
 */
export function nearbyRegionNames(
  data: StationCoordsData,
  home: HomePoint,
  radiusKm: number = NEARBY_RADIUS_KM,
): Set<string> {
  const names = data.regionNames
  const found = new Set<string>()
  if (!names) return found
  for (const entry of Object.values(data.stations)) {
    if (!entry) continue
    const regionIdx = entry[2]
    if (regionIdx == null) continue
    const name = names[regionIdx]
    if (name == null) continue
    if (haversineKm(home.lat, home.lng, entry[0], entry[1]) <= radiusKm) found.add(name)
  }
  return found
}
