import { log } from './logger'

// React の呼び出しスタックの外で投げられた例外を、アプリの記録へ拾い上げる。
//
// **ErrorBoundary の代わりではなく、補い。** 境界が捕まえるのはレンダー・ライフサイクル中の例外だけで、
// イベントハンドラ・`setTimeout`・Promise・`requestAnimationFrame` の中は守備範囲の外にある
// （`components/ErrorBoundary.tsx` の冒頭）。そこで投げられたものはブラウザの既定の出力にしか残らず、
// **アプリ時計のタイムスタンプが付かない**——リプレイ中の再生時刻や、直前に届いた電文と突き合わせられない。
//
// **画面には出さない。** ブラウザ拡張・外部スクリプト・握り漏らした取得失敗でも発火するため、
// UI に出すと平常時から警告が居座る。利用者へ知らせるのは、境界が受け止めたとき
// （`ErrorBoundary`）と、地図の描画物が描けないとき（`utils/renderHealth.ts`）に限る。

/** 同じ内容を記録し直す最短の間隔 (ms)。毎フレーム投げ続ける経路があるため素通しにできない。 */
const INTERVAL_MS = 10_000

/**
 * 覚えておく内容の上限。
 *
 * **毎回違う文面で投げ続ける経路があると、際限なく溜まる。** 上限を超えたら最も古いものから捨てる
 * （`Map` は挿入順を保つので先頭が最も古い）。捨てられた内容は次に起きたとき改めて 1 行出るだけで、
 * 記録が失われるわけではない。
 */
const MAX_KEYS = 50

/** 鍵に使う文字列の長さ。長い例外メッセージで `Map` が膨らむのを防ぐ。 */
const MAX_KEY_LENGTH = 200

const lastAtMs = new Map<string, number>()

/** 同じ内容が間隔内に繰り返されていないか。記録してよければ true。 */
function shouldEmit(key: string): boolean {
  const now = Date.now()
  const prev = lastAtMs.get(key)
  if (prev !== undefined && now - prev < INTERVAL_MS) return false
  if (prev === undefined && lastAtMs.size >= MAX_KEYS) {
    const oldest = lastAtMs.keys().next().value
    if (oldest !== undefined) lastAtMs.delete(oldest)
  }
  // 挿入順＝古い順を保つため、既にある鍵はいったん外してから入れ直す。
  lastAtMs.delete(key)
  lastAtMs.set(key, now)
  return true
}

function keyOf(parts: readonly string[]): string {
  return parts.join('|').slice(0, MAX_KEY_LENGTH)
}

/** テスト用。間引きの記憶を空に戻す。 */
export function resetGlobalErrorLogForTest(): void {
  lastAtMs.clear()
}

/**
 * `window` の未捕捉例外・未処理の Promise 拒否を記録するようにする。
 *
 * `main.tsx` から 1 度だけ呼ぶ。**画面には何も出さない。**
 */
export function installGlobalErrorLog(): void {
  window.addEventListener('error', (e) => {
    // **リソースの読み込み失敗（`<img>` や `<script>` の失敗）はここへ来ない。** あの `error` は
    // バブリングしないため、`window` のバブリングフェーズでは受け取れない。第 3 引数に `true` を
    // 渡してキャプチャで拾うこともできるが、**地図のラスタタイルが 1 枚落ちるたびに流れる**ので採らない。
    // ここで扱うのは実行時例外だけ。
    //
    // **「受け止め手がいなかった」とは書かない。** 開発ビルドの React は、境界が捕まえる例外も
    // いったん DOM イベント経由で投げ直してから拾う（読みやすいスタックを得るため）ので、
    // **`ErrorBoundary` が正しく受け止めた分もここへ届く**（実測で 1 回のクラッシュにつき 2 回）。
    // 本番ビルドでは投げ直さないため届かない。どちらでも嘘にならない言い方にしてある。
    if (!shouldEmit(keyOf(['error', e.filename ?? '', String(e.lineno ?? ''), e.message ?? '']))) return
    log.error(
      `[global] window で拾った例外（${e.filename || '不明'}:${e.lineno ?? '?'}）`,
      e.error ?? e.message,
    )
  })

  window.addEventListener('unhandledrejection', (e) => {
    const reason: unknown = e.reason
    const text = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)
    if (!shouldEmit(keyOf(['rejection', text]))) return
    log.error('[global] 処理されなかった Promise の失敗', reason)
  })
}
