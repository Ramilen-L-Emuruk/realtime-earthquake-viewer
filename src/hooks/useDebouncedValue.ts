import { useEffect, useState } from 'react'

/**
 * 値の変化を `delayMs` だけ遅らせて返す。落ち着くまで変化を伝えないので、
 * 「入力途中の中間状態」で重い副作用（通信・再接続）が走るのを防ぐ。
 *
 * DMDATA の APIキー入力欄は 1 文字ごとに設定を更新する（デバウンスを持たない）。
 * その値をそのまま接続・履歴取得の effect 依存に渡すと、キーを手入力・修正するたびに
 * 未完成のキーで接続と取得をやり直し、そのすべてが 401/403 で失敗する。
 * 保存自体は即座に行いたい（画面表示は追従させたい）ので、遅らせるのは通信を起こす側だけにする。
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    if (Object.is(value, debounced)) return
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
    // debounced を依存に入れると、反映のたびに effect が走り直して無駄なタイマーを張る。
    // 比較にだけ使い、依存からは外す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, delayMs])

  return debounced
}
