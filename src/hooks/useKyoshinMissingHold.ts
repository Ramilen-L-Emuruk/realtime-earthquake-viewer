import { useEffect, useMemo, useRef } from 'react'
import {
  createMissingHoldState,
  stepMissingHold,
  type HeldIndices,
} from '../utils/kyoshinMissingHold'
import { createLogThrottle, log } from '../utils/logger'

/** この割合以上の観測点が同時に保持中なら記録する（上流データの欠測が広範囲に及んでいる兆候）。 */
const STALE_RATIO_WARN = 0.2

/** 同種の記録を出し直す最小間隔 (ms)。1Hz で再発する状況を間引きつつ、継続を見失わない幅。 */
const LOG_THROTTLE_MS = 60_000

/**
 * 強震モニタの表示用インデックスを作るフック（欠測の瞬断を短時間だけ保持する）。
 *
 * 判断は純粋関数 `stepMissingHold` が持ち、ここは持ち越し状態（ref）を与えるだけ。
 * **検知エンジンにはこの結果を渡さない**（判定に入る範囲は `utils/kyoshinMissingHold.ts` 冒頭）。
 *
 * @param indices 生のインデックス列（欠測を含む）
 * @param dataTime フレームのデータ時刻文字列（`KyoshinRealtime.dataTime`）
 * @param sitesKey `indices` が属する観測点集合の識別子（Yahoo では siteConfigId）
 */
export function useKyoshinMissingHold(
  indices: number[],
  dataTime: string,
  sitesKey: string | null,
): HeldIndices {
  const stateRef = useRef(createMissingHoldState())
  // `stepMissingHold` は ref の状態を書き換えるため useMemo の中では副作用に当たるが、次の 2 性質で
  // 安全に成立している: ①同じフレーム（同じデータ時刻）を二度渡しても結果が変わらない（冪等）ため、
  // StrictMode の二重レンダーやメモの破棄・再計算で崩れない。②状態はデータ時刻の進む向きにしか
  // 動かず、巻き戻ったフレームは保持を捨てる。useEffect + setState に寄せると 1 秒ごとに
  // 全観測点ぶんの state 更新でもう 1 回レンダーが増えるため、この経路では useMemo を採る。
  const held = useMemo(
    () => stepMissingHold(stateRef.current, indices, new Date(dataTime).getTime(), sitesKey),
    [indices, dataTime, sitesKey],
  )

  // 保持が広範囲に及んでいる場合だけ記録する。この機能は「瞬断は全体の数%」という上流の性質を前提に
  // しているため、その前提が崩れたことに気づける手掛かりを残す（表示は薄い点が増えるだけで無言になる）。
  // 遅延初期化する（`useRef(createLogThrottle(...))` と書くと毎レンダーで捨てるだけのクロージャを作る）。
  const throttledStaleWarn = useRef<((emit: () => void) => void) | null>(null)
  useEffect(() => {
    const total = held.stale.length
    if (total === 0) return
    let n = 0
    for (const s of held.stale) if (s) n++
    if (n / total < STALE_RATIO_WARN) return
    throttledStaleWarn.current ??= createLogThrottle(LOG_THROTTLE_MS)
    throttledStaleWarn.current(() =>
      log.warn(`[kyoshin] 欠測ホールド中の観測点が多い: ${n}/${total} 点（上流データの欠測が広範囲に及んでいる可能性）`),
    )
  }, [held])

  return held
}
