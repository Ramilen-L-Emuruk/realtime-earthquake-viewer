import { useEffect, useState } from 'react'
import { loadSubRegions, onSubRegionsLoaded, type SubRegion } from '../utils/subregions'
import { log } from '../utils/logger'

export interface SubRegionsState {
  /** 区域データ。読み込み完了までと取得失敗時は null。 */
  data: SubRegion[] | null
  /**
   * 取得失敗が確定したか（＝区域を使う描画を諦めてよいか）。読み込み中は false。
   * 「まだ来ていない」と「来ない」を区別するためのフラグ。区域集約をやめて観測点ドットへ
   * フォールバックする判断（useQuakeLayerData.aggregateByRegion）に使う。読み込み中に
   * フォールバックすると、データ到着の瞬間にドット→区域塗りへ切り替わるちらつきになるため、
   * 失敗確定時だけ true にする。
   *
   * 一度 true になっても、他の呼び出し元（ベースマップ・ラベル）の再取得が成功すれば
   * onSubRegionsLoaded 経由で data が入り false に戻る（＝区域塗りへ復帰する）。
   */
  failed: boolean
}

// 失敗ログを最後に出した時刻（モジュール単位・performance.now() 基準）。本フックは地図の
// 派生データ計算（震度・EEW）から複数インスタンスが同時に使われ、React StrictMode では
// 各々が二重に走るため、素直に catch で出すと同一の失敗が 4 本並ぶ。原因は 1 つなのでまとめる。
//
// ただし「一度出したら成功するまで二度と出さない」にはしない。取得は失敗するたびに再試行可能に
// なるので、通信障害が長引くと再取得も失敗し続けるが、その 2 回目以降が完全に無音になってしまう。
// 一定間隔を空けて出し直し、無音区間に上限を設ける。取得に成功したら次の失敗で即座に 1 本出す。
const FAILURE_LOG_INTERVAL_MS = 60_000
let lastFailureLogAt = -Infinity

/**
 * 一次細分区域の境界データを読み込むフック。
 * 読み込み完了までは `{ data: null, failed: false }`、取得失敗時は `{ data: null, failed: true }`。
 */
export function useSubRegions(): SubRegionsState {
  const [state, setState] = useState<SubRegionsState>({ data: null, failed: false })

  useEffect(() => {
    let active = true
    // 成功は購読で受ける。自分の loadSubRegions が失敗しても、他の呼び出し元の再取得が
    // 成功すればここに届く（失敗したまま固定されない）。
    const unsubscribe = onSubRegionsLoaded((d) => {
      lastFailureLogAt = -Infinity
      if (active) setState({ data: d, failed: false })
    })
    loadSubRegions().catch((err) => {
      // 区域データが取得できなくても地図自体は表示する。地震モードの震度は区域塗りをやめて
      // 観測点ドットで描く（useQuakeLayerData.aggregateByRegion のフォールバック）。
      // ただし観測点を持たない電文（震度速報等）と EEW 予想震度は区域単位でしか描けないため、
      // このケースでは地図上に震度が出ない。
      const now = performance.now()
      if (now - lastFailureLogAt >= FAILURE_LOG_INTERVAL_MS) {
        lastFailureLogAt = now
        log.error(
          '[data] subregions 取得失敗（震度は観測点ドットで代替。観測点を持たない電文＝震度速報・EEW 予想震度は地図に出ない）',
          err,
        )
      }
      if (active) setState({ data: null, failed: true })
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return state
}
