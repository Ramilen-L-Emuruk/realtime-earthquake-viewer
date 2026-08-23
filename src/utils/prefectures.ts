// 都道府県の境界ポリゴン（public/data/prefectures.json）を読み込み、
// ダーク地図のベース（境界線＋陸地）を描画するためのユーティリティ。
//
// データは scripts/build-prefectures.mjs で生成・更新する。

import { fetchJsonWithTimeout } from './fetchJson'

export type LatLng = [number, number]

export interface PrefectureShape {
  /** 県名ラベルを置く代表点（最大リングの重心） */
  label: LatLng
  /** ラベルのオフセット方向（県内に余白が大きい側＝はみ出し防止） */
  dir: 'up' | 'down'
  /** 外周・離島などのリング（各リングは閉じた境界線） */
  rings: LatLng[][]
}

/** 都道府県名 -> 境界形状 */
export type Prefectures = Record<string, PrefectureShape>

const DATA_URL = `${import.meta.env.BASE_URL}data/prefectures.json`

let cache: Prefectures | null = null
let inflight: Promise<Prefectures> | null = null

export function getPrefecturesCache(): Prefectures | null {
  return cache
}

/**
 * 都道府県の境界データを取得する。初回のみ fetch し、以降はキャッシュを返す。
 * 取得に失敗した場合（タイムアウトを含む）は inflight を破棄して次回リトライ可能にする。
 */
export function loadPrefectures(): Promise<Prefectures> {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = fetchJsonWithTimeout<Prefectures>(DATA_URL, 'prefectures', {
      // 中身の形（オブジェクト・非空）まで見る。ビルドや配信の破損で `{}` や配列が 200 で返ると、
      // 呼び出し側は「取得成功・県 0 件」として扱ってしまい、**陸地塗りも県境も県名ラベルも出ない
      // 状態が失敗として検知されない**（BaseMapGL・LabelsGL は Promise が rejected のときだけ
      // 警告を出す）。通信失敗と同じ扱いにするため、取得側の `validate` に渡す——ここで投げれば
      // 地図の「データの一部を取得できませんでした」にも計上される（`.then()` では計上されない）。
      // 各県の中身（`rings` を持つか等）までは見ていない。subregions 側も同じ粒度。
      validate: (data) => {
        if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length === 0) {
          throw new Error('prefectures fetch returned no data (empty or malformed)')
        }
      },
    })
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
