// 波形のどの向き（東西・南北・上下）を描くか。
//
// **アプリ全体で 1 つの状態を共有し、リロードでは残さない**（2026-09-30 のユーザー判断）。
// 地図の下端の絵と地震カードの波形は同じものを別の窓から見ているので、片方で消したら
// もう片方でも消えるほうが自然。一方これは「いま見比べたいから一時的に消す」操作なので、
// 設定として残すと消したことを忘れたまま次の地震を迎える。
//
// **設定（`useSettings`）へ置かないのはそのため。** あちらは残す値の置き場所。
//
// **React の外に持つ。** 地図の下端の絵はカードの奥にある波形と親子関係を持たないので、
// props で配ると App から 2 経路のバケツリレーになる。

import { useSyncExternalStore } from 'react'

/** 向きの数（東西・南北・上下）。 */
const AXIS_COUNT = 3

const ALL_VISIBLE: readonly boolean[] = [true, true, true]

let axes: readonly boolean[] = ALL_VISIBLE
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** その向きの表示を反転する。**範囲の外は黙って捨てる**（配線の誤りで例外にしない）。 */
export function toggleWaveAxis(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= AXIS_COUNT) return
  axes = axes.map((visible, i) => (i === index ? !visible : visible))
  emit()
}

/** 全部表示へ戻す。**テストの後始末に要る**（モジュールの状態はテスト間で持ち越される）。 */
export function resetWaveAxes(): void {
  if (axes === ALL_VISIBLE) return
  axes = ALL_VISIBLE
  emit()
}

/** いまの状態（購読せずに読む。描画の中から使う）。 */
export function readWaveAxes(): readonly boolean[] {
  return axes
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * いまの表示状態。変わったら描き直す。
 *
 * **`getSnapshot` は同じ参照を返す**（`toggleWaveAxis` が呼ばれたときだけ差し替える）——
 * 毎回新しい配列を返すと `useSyncExternalStore` が無限に再描画する。
 */
export function useWaveAxes(): readonly boolean[] {
  return useSyncExternalStore(subscribe, readWaveAxes, readWaveAxes)
}
