import { useEffect, useState } from 'react'
import { loadStationCoords, onStationCoordsLoaded, type StationCoordsData } from '../utils/stationCoords'
import { log } from '../utils/logger'

// 失敗ログを出したか（モジュール単位）。本フックは地図の震度点と地震カードから同時に使われ、
// React StrictMode では各々が二重に走るため、素直に catch で出すと同一の失敗が何本も並ぶ。
// 原因は 1 つなのでログも 1 本に抑える。取得に成功したら解除し、次に失敗したときは改めて出す。
let failureLogged = false

/**
 * 震度観測点・細分区域の座標テーブルを読み込むフック。
 * 読み込み完了までは null を返す。取得失敗時も null のまま。
 *
 * 失敗しても、他の呼び出し元（地震カード・EEW の都道府県補完）の再取得が成功すれば
 * onStationCoordsLoaded 経由で値が入る（失敗したまま固定されない）。
 */
export function useStationCoords(): StationCoordsData | null {
  const [data, setData] = useState<StationCoordsData | null>(null)

  useEffect(() => {
    let active = true
    const unsubscribe = onStationCoordsLoaded((d) => {
      failureLogged = false
      if (active) setData(d)
    })
    loadStationCoords().catch((err) => {
      // 座標テーブルが無いと、電文の地点（都道府県・観測点名）から緯度経度を引けないため
      // 観測点ドットが 1 つも描けない。区域塗りは電文が持つ区域（isArea:true）の点から
      // 区域名で直接引くので座標テーブルに依存せず、DMDSS の詳細報・震度速報では残る。
      // 一方で標準版（P2PQuake）の詳細報は観測点のみで区域を持たないため、地図から震度が消える
      // （docs/spec/quake-spec.md §4・§7.3）。
      if (!failureLogged) {
        failureLogged = true
        log.error(
          '[data] station-coords 取得失敗（観測点ドットは描けない。区域を持たない電文＝標準版の詳細報は地図に震度が出ない）',
          err,
        )
      }
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return data
}
