import type { CustomLayerInterface } from 'maplibre-gl'
import { log } from '../../../utils/logger'
import { reportRenderFailure, clearRenderFailure } from '../../../utils/renderHealth'

// カスタムレイヤーの `render()` を包み、投げた例外をそのレイヤーの中に閉じ込める。
//
// **ここは React の ErrorBoundary が原理的に届かない場所。** `render()` を呼ぶのは MapLibre 自身の
// `requestAnimationFrame` で、React の呼び出しスタックを一度も通らない。境界をどこへ置いても
// 捕まえられない（`components/ErrorBoundary.tsx` の冒頭）。
//
// **包まないと、そのフレームの地図が丸ごと止まる。** MapLibre はカスタムレイヤーごとに例外を
// 捕まえないので、`MAP_LAYER_ORDER` で後ろにいるレイヤー——予報円の後なら EEW の震源・震度点・
// 強震モニタ・地名ラベル——まで描画が届かない。しかも画面には何も出ないため、利用者からは
// 「地図が固まった」としか見えない。包めば、落ちたレイヤー 1 枚だけが欠ける。
//
// 失敗は `utils/renderHealth.ts` へ流す。取得の失敗（`MapDataStatus`）と対になっている表示で、
// 「来たデータを描けなかった」側をここが埋める。

/**
 * 同じ内容を記録し直す最短の間隔 (ms)。
 *
 * `render()` は毎フレーム呼ばれるので、素通しにすると 60fps で同じ行が流れ、他の記録が読めなくなる。
 * 一度きりに絞らないのは、続いている障害を「一度失敗して直った」ように見せないため。
 */
const LOG_INTERVAL_MS = 10_000

/**
 * 覚えておく内容の上限。**毎回違う文面で投げる経路があると際限なく溜まる。**
 * 超えたら最も古いものから捨てる（`Map` は挿入順を保つので先頭が最も古い）。
 */
const MAX_KEYS = 20

/**
 * 内容が違っても、これより短い間隔では記録しない (ms)。
 *
 * **上の「内容ごと」だけでは頻度を抑えられない。** 例外の文面に毎フレーム変わる値（座標・添字など）が
 * 入っていると、どの内容も「初めて見るもの」になって間引きを素通りし、60fps で記録が流れる
 * （`MAX_KEYS` が抑えるのは覚える量であって、出す回数ではない）。
 */
const MIN_LOG_GAP_MS = 1_000

type RenderFn = CustomLayerInterface['render']
type GL = WebGLRenderingContext | WebGL2RenderingContext

/**
 * 例外で抜けたときに GL の状態を戻す。
 *
 * **いまの MapLibre では、これが無くても描き先と合成は元へ戻る。** `drawCustom` は `render()` が
 * 戻った直後に `context.setDirty()` と `bindFramebuffer.set(null)` を無条件で走らせ、次のレイヤーの
 * `setColorMode()` が合成を張り直す（6.10.0 で確認）。ここは例外を握って**再スローしない**ので、
 * MapLibre からは「正常に戻った」ように見え、その後処理が必ず動くため。実機でも、この復元を
 * 外した状態で `gl/subThresholdLayer.ts` のオフスクリーン切り替え直後に落とし、地図が壊れないことを
 * 確かめてある。**「戻さないと地図が固まる」とは書かないこと。**
 *
 * それでも置いているのは 2 つの理由による。
 *
 * - **矩形の切り抜き（`SCISSOR_TEST`）は MapLibre が追跡していない。** `setDirty()` の対象外なので、
 *   有効にしたまま抜けたレイヤーがあると、後続のレイヤーがその枠の外へ描けなくなる。いま包んでいる
 *   3 本は使っていないため、これは**将来のための備え**
 * - **上の後処理は MapLibre の実装詳細で、公開された約束ではない。** 依存指定は `^6.10.0` で
 *   マイナー更新が自動的に入る（同じ理由で `docs/spec/map-rendering-spec.md` §9 が、カメラ更新の
 *   空振り省略について「上げたら実装差分を目で確かめる」と定めている）
 *
 * @param restoreFbo `render()` を呼ぶ前に控えておいた描き先
 */
function restoreGlState(gl: GL, restoreFbo: WebGLFramebuffer | null): void {
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, restoreFbo)
    // 矩形の切り抜きが残ると、後続のレイヤーがその枠の外へ描けなくなる。
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.BLEND)
    gl.bindBuffer(gl.ARRAY_BUFFER, null)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null)
    gl.bindTexture(gl.TEXTURE_2D, null)
    if ('bindVertexArray' in gl) gl.bindVertexArray(null)
  } catch {
    // **復元そのものが投げるのは、コンテキストを失っているとき。** その場合の作り直しは
    // MapLibre と各レイヤーの `webglcontextrestored` が担当する
    //（docs/spec/map-rendering-spec.md §12）。ここで記録を足しても手当てにはならず、
    //  例外が起きたこと自体は呼び出し元がこの後に記録する。
  }
}

/**
 * `render()` を包んで、例外を記録と画面表示へ振り替える。
 *
 * @param id レイヤー ID。`renderHealth` の記録の鍵になる
 * @param label 利用者に見せる名前。**呼ぶ側が持つ**（`renderHealth` の規約に合わせる）
 * @param render 元の描画処理
 */
export function guardRender(id: string, label: string, render: RenderFn): RenderFn {
  /**
   * 内容ごとの最終記録時刻。
   *
   * **1 本の間引きで済ませない。** 原因の違う例外が交互に起きると、間隔の内側に落ちた側が
   * 一度も記録されないまま終わる（`utils/globalErrorLog.ts` と同じ理由で内容を鍵にする）。
   */
  const lastLoggedAtMs = new Map<string, number>()
  /** 内容を問わず、最後に記録した時刻。立て続けに出さないための歯止め。 */
  const lastGap = { atMs: -Infinity }
  /**
   * `renderHealth` へ報告するときの鍵。**レイヤー自身が使う ID とは分ける。**
   *
   * 分けないと、**レイヤーが自分の判断で出した報告をここが取り下げてしまう。**
   * `gl/depthPointLayer.ts` はシェーダーのリンク失敗を自分で報告するが、例外は投げずに `return`
   * するので、ここからは「成功」に見える。「自分が報告したか」をこちらのフラグだけで覚える作りだと、
   * 「先に例外で報告 → 別のフレームでレイヤーが自己申告 → こちらが成功と見て取り下げる」という
   * 順序で他人の報告を消せてしまう（フラグの値はレイヤー側の事情を知らないため）。
   *
   * 鍵を分ければ、どちらが何を報告していても互いに干渉しない。**同じ名前が 2 度並ぶことは
   * `utils/renderHealth.ts` 側で畳む。**
   */
  const healthId = `${id}:uncaught`
  /** 自分が報告した状態にいるか（同じ内容を毎フレーム報告し直さないための覚え）。 */
  let failing = false

  return (gl, args) => {
    // 例外で末尾の復元へ届かなかったときの戻り先（`restoreGlState` の位置づけはそちらの説明を見ること）。
    const restoreFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
    try {
      render(gl, args)
    } catch (e) {
      restoreGlState(gl, restoreFbo)
      if (!failing) {
        failing = true
        reportRenderFailure(healthId, label, 'draw')
      }
      logThrottled(lastLoggedAtMs, lastGap, e, () =>
        log.error(`[guardRender:${id}] 描画で例外。このレイヤーだけ飛ばして地図の残りは描いています`, e),
      )
      return
    }
    if (failing) {
      // 投影の切り替えなどで作り直されて通ることがある。**直ったら画面から消す。**
      failing = false
      clearRenderFailure(healthId, 'draw')
    }
  }
}

/** 例外の内容ごとに間隔を空けて記録する（内容を問わない下限も重ねる）。 */
function logThrottled(
  lastAtMs: Map<string, number>,
  lastGap: { atMs: number },
  e: unknown,
  emit: () => void,
): void {
  const now = Date.now()
  if (now - lastGap.atMs < MIN_LOG_GAP_MS) return
  const key = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 200)
  const prev = lastAtMs.get(key)
  if (prev !== undefined && now - prev < LOG_INTERVAL_MS) return
  lastGap.atMs = now
  if (prev === undefined && lastAtMs.size >= MAX_KEYS) {
    const oldest = lastAtMs.keys().next().value
    if (oldest !== undefined) lastAtMs.delete(oldest)
  }
  // 挿入順＝古い順を保つため、既にある鍵はいったん外してから入れ直す。
  lastAtMs.delete(key)
  lastAtMs.set(key, now)
  emit()
}
