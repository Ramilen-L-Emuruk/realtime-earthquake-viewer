import type { SeismoQuakeWave } from '../hooks/useSeismoQuakeWaves'

/**
 * 地震カードに出す波形を、自作地震計と公開観測点で 1 つの表にまとめる（地震の鍵 → 並べる順の波形）。
 * **自作地震計を先に、続けて公開観測点を番号順に**（`docs/public-waveform-design.md` §6.3。公開観測点の並びは渡す側で番号順にしてある）。
 *
 * **中身が前回と同じ地震は、前回の配列を使い回す。** 地震カードは `memo` で、配列の参照が変わると描き直す ——
 * 揺れている最中の地震の波形は 1 秒ごとに伸びるので、毎回作り直すと 7 日ぶんのカードが全部描き直される。
 */
export function mergeQuakeWaves(
  seismo: ReadonlyMap<string, readonly SeismoQuakeWave[]>,
  publicCards: ReadonlyMap<string, readonly SeismoQuakeWave[]>,
  prev: ReadonlyMap<string, readonly SeismoQuakeWave[]>,
): ReadonlyMap<string, readonly SeismoQuakeWave[]> {
  const out = new Map<string, readonly SeismoQuakeWave[]>()
  const keys = new Set([...seismo.keys(), ...publicCards.keys()])
  for (const key of keys) {
    const own = seismo.get(key) ?? []
    const pub = publicCards.get(key) ?? []
    if (pub.length === 0) {
      // 自作地震計だけなら、その配列をそのまま使う（今までと同じ参照）
      if (own.length > 0) out.set(key, own)
      continue
    }
    out.set(key, reuse(prev.get(key), [...own, ...pub]))
  }
  return out
}

function reuse(before: readonly SeismoQuakeWave[] | undefined, next: readonly SeismoQuakeWave[]): readonly SeismoQuakeWave[] {
  if (before === undefined || before.length !== next.length) return next
  for (let i = 0; i < next.length; i += 1) if (before[i] !== next[i]) return next
  return before
}
