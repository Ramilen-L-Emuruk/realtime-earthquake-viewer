// 地震カードの波形を強調して描くか（平常時のノイズを潰すか）。
//
// **向きの表示（`useSeismoWaveAxes`）と同じ扱いにする** —— アプリ全体で 1 つの状態を共有し、
// リロードでは残さない。地震カードと詳細の窓は同じ波形を別の窓から見ているので、片方で
// 切り替えたらもう片方も揃うほうが自然。**既定は強調する**（2026-10-03 のユーザー判断）。
//
// **地図の下端の絵には掛けない。** あちらには「発生前」という物差しが無い。

import { useSyncExternalStore } from 'react'

let emphasized = true
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** 強調の有無を反転する。 */
export function toggleWaveEmphasis(): void {
  emphasized = !emphasized
  emit()
}

/** 既定（強調する）へ戻す。**テストの後始末に要る**（モジュールの状態はテスト間で持ち越される）。 */
export function resetWaveEmphasis(): void {
  if (emphasized) return
  emphasized = true
  emit()
}

/** いまの状態（購読せずに読む）。 */
export function readWaveEmphasis(): boolean {
  return emphasized
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** いまの状態。変わったら描き直す。 */
export function useWaveEmphasis(): boolean {
  return useSyncExternalStore(subscribe, readWaveEmphasis, readWaveEmphasis)
}
