// 津波予報区の海岸線の点滅。
//
// **毎フレーム `setPaintProperty` を呼ばない。** MapLibre は値が同じでも `setPaintProperty` を
// 受けると地図全体を描き直す。不透明度が変わるのは 1 周期に 2 回（点く・消える）だけなのに、
// rAF で毎フレーム呼ぶと毎秒 60 回のフル再描画になる —— 津波の発表中は全モードで海岸線が
// 出るので、どの画面を開いていても続く（実測は docs/spec/map-rendering-spec.md §9「点滅の駆動」）。
//
// 震源の点滅（`depthPointLayer.ts` の `createBlinkScheduler`）と考え方は同じで、**次の切り替わりまで
// だけ待ち、予約は 1 本に保つ**。部品を分けたのは、あちらが点灯と消灯を半々にしてシェーダーの中で
// 描くのに対し、こちらは 8 割点灯で `setPaintProperty` を通すため。

import { createLogThrottle, log } from '../../../utils/logger'

const throttledApplyFailWarn = createLogThrottle(60_000)

/** 点滅周期（ms）。旧 Leaflet 版の `tsunami-blink`（2.5s step-end）に合わせた値。 */
export const TSUNAMI_BLINK_PERIOD_MS = 2500

/** 1 周期のうち点灯している割合。前の 8 割が点灯、残り 2 割が消灯のハード切替。 */
export const TSUNAMI_BLINK_ON_RATIO = 0.8

/** 点灯中の不透明度。消灯中は 0。 */
export const TSUNAMI_LINE_OPACITY_ON = 0.9

const ON_MS = TSUNAMI_BLINK_PERIOD_MS * TSUNAMI_BLINK_ON_RATIO

/** 位相の起点からの経過時間に対する不透明度。 */
export function tsunamiBlinkOpacity(elapsedMs: number): number {
  const pos = mod(elapsedMs, TSUNAMI_BLINK_PERIOD_MS)
  return pos < ON_MS ? TSUNAMI_LINE_OPACITY_ON : 0
}

/** 次の切り替わり（点く・消える）までの残り時間（ms）。 */
export function msUntilNextTsunamiBlinkEdge(elapsedMs: number): number {
  const pos = mod(elapsedMs, TSUNAMI_BLINK_PERIOD_MS)
  return pos < ON_MS ? ON_MS - pos : TSUNAMI_BLINK_PERIOD_MS - pos
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n
}

export interface TsunamiBlink {
  /**
   * 点滅させるか（海岸線が見えているか）を伝える。真になった時点の不透明度を当て、次の切り替わりへ
   * 予約する。偽にすると予約を落とす。**同じ値を続けて渡しても予約は増えない。**
   */
  setActive(active: boolean): void
  /**
   * いまの位相を当て直し、予約を張り直す（点滅していないときは何もしない）。
   *
   * **隠れていたタブが前面へ戻ったときに呼ぶ。** 隠れたタブのタイマーはブラウザが間引く
   * （長く隠れると 1 分に 1 回程度）ので、戻った時点で次の予約が数十秒先に残っていることがある。
   * 呼ばないと、その間は隠れる前の値（消灯かもしれない）のまま海岸線が止まって見える。
   */
  resync(): void
  /**
   * 予約を落とし、以後は何もしない。**レイヤーを外すときに必ず呼ぶ**（残すと外した後も
   * `apply` が呼ばれる）。破棄した後に `setActive(true)` を受けても動き出さない。
   */
  dispose(): void
}

/**
 * @param apply 不透明度を地図へ当て、**当てられたかを返す**（レイヤーが無くて当てられなければ
 *              false）。値が変わるときだけ呼ばれる。false や例外のときは「当てた」記憶を進めない ——
 *              進めると、次の切り替わりまで当て損ねた値のまま止まる。
 * @param now   位相を測る時計。生成した時刻が位相の起点になる。
 */
export function createTsunamiBlink(
  apply: (opacity: number) => boolean,
  now: () => number = () => performance.now(),
): TsunamiBlink {
  const origin = now()
  let active = false
  let disposed = false
  let applied: number | undefined
  // `setTimeout` の戻り値の型はブラウザ（number）と node（Timeout）で違う。中身を見ず
  // `clearTimeout` へ渡すだけなので、環境をまたいで通る形にしておく。
  let timer: ReturnType<typeof setTimeout> | undefined

  const applyCurrent = (): void => {
    const opacity = tsunamiBlinkOpacity(now() - origin)
    // タイマーは少し早く発火することがある。そのときは値が変わっていないので当てない ——
    // 当てると、変わらない値のために地図を描き直すことになる。
    if (opacity === applied) return
    try {
      applied = apply(opacity) ? opacity : undefined
    } catch (err) {
      // **当てた記憶を進めない**（理由は `apply` の説明）。例外はここで握るが黙らせはしない
      // （地図の状態が崩れている合図）。
      applied = undefined
      // 切り替わりのたびに失敗しうる（1 秒に 1 回弱）ので、記録は間引く。
      throttledApplyFailWarn(() => log.warn('[tsunamiBlink] 海岸線の不透明度を当てられなかった', err))
    }
  }

  const schedule = (): void => {
    // 最小 1ms。早く発火して境界のちょうど手前にいるとき、0ms で回り続けないようにする。
    const delay = Math.max(1, Math.ceil(msUntilNextTsunamiBlinkEdge(now() - origin)))
    // `globalThis` を通すのは、ブラウザ環境を立てずに単体テストできるようにするため。
    timer = globalThis.setTimeout(() => {
      timer = undefined
      if (!active) return
      // `applyCurrent` は例外を外へ出さない。**ここで投げると次の予約が張られず、点滅が
      // 当て損ねた値のまま止まる**（`setActive(true)` は同じ値を弾くので戻す手段も無い）。
      applyCurrent()
      schedule()
    }, delay)
  }

  const cancel = (): void => {
    globalThis.clearTimeout(timer)
    timer = undefined
  }

  return {
    setActive(value) {
      if (disposed || value === active) return
      active = value
      if (!active) {
        cancel()
        return
      }
      applyCurrent()
      schedule()
    },
    resync() {
      if (disposed || !active) return
      cancel()
      applyCurrent()
      schedule()
    },
    dispose() {
      disposed = true
      active = false
      cancel()
    },
  }
}
