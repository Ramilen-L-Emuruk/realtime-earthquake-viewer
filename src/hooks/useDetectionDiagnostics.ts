import { useEffect, useRef } from 'react'
import type { SiteCoords } from '../services/kyoshin'
import { computeSiteKeys, PARAMS, type DetectionEvent, type LearnedState } from '../utils/kyoshinDetector'
import {
  DiagnosticCapture,
  describeEvent,
  encodeIntensity,
  type DiagnosticRecord,
} from '../utils/detectionDiagnostics'
import { saveRecord } from '../utils/detectionDiagnosticsDb'
import { isDmdss } from '../utils/env'
import { log } from '../utils/logger'

// 揺れ検知が走ったときの「アプリが実際に見た値」を記録するフック。
// 記録の中身と切り出しの規則は utils/detectionDiagnostics.ts、保存は detectionDiagnosticsDb.ts。
//
// 記録するのは 2 種類ある。画面に出た検知（likely・confirmed）と、**周囲の裏付けが取れずに
// 抑えたもの**（faint だが震度1 以上に達している＝設計書§32 のゲートが止めた分）。後者を残すのは、
// 抑えた判断が正しかったかを後から確かめる材料が他に無いため。

/** 学習資産の localStorage キー（`useKyoshinDetectorV2` と同じもの）。 */
const LEARNED_KEY = 'kyoshin-v3-learned'

/** 保存済みの学習資産を読む。読めなければ null（記録は残す。学習資産が無いだけ）。 */
function readLearned(): LearnedState | null {
  try {
    const raw = localStorage.getItem(LEARNED_KEY)
    return raw ? (JSON.parse(raw) as LearnedState) : null
  } catch {
    return null
  }
}

/**
 * 検知の前後を記録する。
 *
 * @param detections `useKyoshinDetectorV2` の検知イベント
 * @param sites 観測点座標（`indices` と同じ並び）
 * @param indices 計測震度インデックス（生値）
 * @param dataTime 対象データ時刻（ISO 文字列）
 * @param siteConfigId 観測点リストの版
 */
export function useDetectionDiagnostics(
  detections: DetectionEvent[],
  sites: SiteCoords,
  indices: number[],
  dataTime: string,
  siteConfigId: string | null,
): void {
  const captureRef = useRef(new DiagnosticCapture())
  // フレーム到来ごとの処理で最新値を参照する（deps は dataTime だけに絞りたいため ref で持ち回す）
  const latest = useRef({ detections, sites, indices, siteConfigId })
  latest.current = { detections, sites, indices, siteConfigId }

  // 観測点集合が入れ替わったら、座標と値の対応が変わるので溜めた分を捨てる
  useEffect(() => {
    captureRef.current.reset()
  }, [siteConfigId])

  useEffect(() => {
    const { detections: evs, sites: st, indices: idx, siteConfigId: cfg } = latest.current
    if (!dataTime || idx.length === 0 || st.length !== idx.length) return
    const ms = new Date(dataTime).getTime()
    if (!Number.isFinite(ms)) return

    const capture = captureRef.current
    capture.pushFrame(ms, encodeIntensity(idx))

    // 画面に出た検知と、周囲の裏付けが取れずに抑えた分（震度1 以上の faint）を記録する
    const surfaced = evs.filter(
      (e) =>
        e.confidence === 'likely' ||
        e.confidence === 'confirmed' ||
        (e.confidence === 'faint' && e.maxIntensity >= PARAMS.MIN_LIKELY_INTENSITY),
    )
    if (surfaced.length > 0) {
      const sites = st as [number, number][]
      const keyToIndex = new Map<string, number>()
      computeSiteKeys(sites).forEach((k, i) => keyToIndex.set(k, i))
      const learned = readLearned()
      for (const e of surfaced) {
        capture.open(
          {
            dataTimeMs: ms,
            siteConfigId: cfg ?? '',
            sites,
            event: describeEvent(e, keyToIndex, sites, idx),
            confirmedBy: e.confirmedBy,
            learned,
          },
          __APP_VERSION__,
          isDmdss ? 'dmdss' : 'standard',
        )
      }
    }
    persist(capture.takeFinished())
  }, [dataTime])

  // 画面が見えなくなったら、後ろ側が足りないままでも記録を残す。
  //
  // **アンマウントのクリーンアップだけでは足りない。** このフックはアプリ本体に付いていて、
  // タブを閉じてもリロードしても React のアンマウントは起きない（実行コンテキストごと消える）。
  // 誤検知に気づいてすぐ閉じる——この機能がいちばん使われる場面がそこなので、`visibilitychange` で
  // 拾う。`beforeunload` では非同期の保存が間に合わない。
  useEffect(() => {
    const capture = captureRef.current
    const onHidden = (): void => {
      if (document.visibilityState === 'hidden') persist(capture.flush())
    }
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      document.removeEventListener('visibilitychange', onHidden)
      persist(capture.flush())
    }
  }, [])
}

/**
 * 保存を 1 本の鎖に繋ぐ。
 *
 * フックはフレームごとに投げっぱなしで呼ぶため、保存が遅い・失敗が続くときに前の保存が
 * 終わらないまま次が始まりうる。並ぶ順は記録の順でなければ意味を成さない（後から読むのは時系列）。
 */
let chain: Promise<void> = Promise.resolve()

function persist(records: DiagnosticRecord[]): void {
  if (records.length === 0) return
  chain = chain.then(async () => {
    for (const r of records) {
      await saveRecord(r)
      log.info(
        `[diagnostics] 検知の前後を記録した（${new Date(r.dataTimeMs).toLocaleTimeString('ja-JP')} ${r.reachedConfidence}）`,
      )
    }
  })
}
