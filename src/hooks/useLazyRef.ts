import { useRef, type MutableRefObject } from 'react'

/**
 * 初回のレンダーでだけ初期値を組み立てる ref。
 *
 * **`useRef(重い式)` と書いてはいけない。** 初期値として使われるのは初回だけだが、**引数の式は
 * 毎レンダー評価される**（React の仕様）。組み立てたものは 2 回目以降そのまま捨てられるため、
 * 高頻度で再レンダーされるフックでは、捨てるためだけの処理が延々と走り続ける。
 *
 * 実例: 強震モニタの検知フックは 1 秒ごとに再レンダーされる。学習資産の復元
 * （localStorage の読み取り ＋ JSON のパース ＋ 復元）を `useRef` の引数に置いていたため、
 * 毎秒それが走っていた（CPU を 4 倍遅くした端末で、地図の自動移動 1 回あたり 50ms）。
 *
 * **`null` を正当な値として持つ型には使えない**（初期化済みかどうかを `null` で見分けるため。
 * 使えてしまうと「初期化済みなのに毎回作り直す」＝このフックが消したはずの無駄がそのまま戻り、
 * しかも記録は何も残らない）。型引数の `T extends object` がその誤用を型検査で止める。
 */
export function useLazyRef<T extends object>(init: () => T): MutableRefObject<T> {
  const ref = useRef<T | null>(null)
  if (ref.current === null) ref.current = init()
  return ref as MutableRefObject<T>
}
