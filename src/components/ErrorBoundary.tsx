import { Component, type ErrorInfo, type ReactNode } from 'react'
import { log } from '../utils/logger'

/**
 * React のレンダー・ライフサイクル中の例外を受け止め、その範囲だけをフォールバック表示に
 * 差し替える。
 *
 * **守備範囲は React の呼び出しスタックの中だけ。** レンダー・`useMemo`・
 * `useEffect` / `useLayoutEffect` の同期本体・コンストラクタで投げられたものは捕まえるが、
 * **イベントハンドラ・`setTimeout`・Promise・`requestAnimationFrame` の中の例外は捕まえない**
 * （React の仕様）。このアプリで最も壊れやすい MapLibre のカスタムレイヤーの `render()` は
 * MapLibre 自身の rAF から呼ばれるため、**この境界をどこに置いても原理的に届かない**。
 * そちらは各レイヤーの `render()` を包んで `utils/renderHealth.ts` へ報告する側が担う。
 * 守備範囲の切り分けは docs/spec/architecture-spec.md に表で置いてある。
 *
 * **置く場所で残せるものが変わる。**
 *
 * - `variant="root"`（`main.tsx` で `<App>` を包む）: 最後の受け皿。`App` 自身のレンダー例外は
 *   ここでしか拾えない。ただし落ちると `App` の state は全滅し、`useEffect` のクリーンアップが
 *   走って WebSocket も切れる——**情報が届かなくなる**ので、そのことを画面に書く。
 * - `variant="region"`（地図・各タブ）: その領域だけを差し替える。`App` の state は生きたままなので、
 *   地図が落ちてもカード・ブラウザ通知・読み上げ・行動チェックリストは動き続ける。
 */

/**
 * 再表示を押した後、その落ち直しを「押しても直らなかった」と数える間隔 (ms)。
 *
 * **壁時計で測る。** アプリ時計（`serverNow`）はリプレイ中に再生位置へ飛ぶが、ここで知りたいのは
 * 「人が再表示を押してから実際に何秒もったか」なので、再生位置に引きずられては困る
 * （`utils/logger.ts` の記録の間引きと同じ考え方）。
 *
 * **これだけもった後に落ちたら数え直す。** ちょうどこの周期で落ち続けるものがあれば枠は永久に
 * 埋まらず、ボタンが出続けることになる。それは意図どおり——押すたびに実際に使えているなら、
 * そのボタンは効いている。
 */
const RETRY_WINDOW_MS = 30_000

/**
 * この回数まで再表示を許す。超えたらボタンを引っ込める。
 *
 * **無条件に再表示を出すと、原因が props や永続データの側にあるとき「押す→即落ちる」を
 * 延々繰り返させることになる。** 押しても直らないボタンは、直せる望みがあるように見せるぶん
 * 無いより悪い。
 */
const MAX_RETRIES = 2

type Props = { children: ReactNode } & (
  | { variant: 'root' }
  /** @param label 何が表示できないかを利用者へ伝える名前（「地図」「地震情報」など）。 */
  | { variant: 'region'; label: string }
)

interface State {
  failed: boolean
  /** 直近の窓の中で何回落ち直したか。窓を空けて落ちたら 0 へ戻す。 */
  retries: number
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, retries: 0 }

  /**
   * 再表示を押した時刻（壁時計）。押していない間は `null`。
   *
   * **起点を「押した時刻」に取ることで、`MAX_RETRIES` が「押しても直らなかった回数」を
   * そのまま表す。** 落ち直しの間隔で数えると、押した覚えのない落下まで枠へ入りうる。
   */
  private retriedAtMs: number | null = null

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 押した直後に落ち直したときだけ「押しても直らなかった」と数える。間隔が空いていれば
    // 別の原因とみなして数え直す（一日に一度ずつ落ちる端末で、ボタンが永久に出なくなるのを防ぐ）。
    const failedRightAfterRetry =
      this.retriedAtMs !== null && Date.now() - this.retriedAtMs < RETRY_WINDOW_MS
    this.retriedAtMs = null
    // **持ちこたえてから落ちたら数え直す。** 積みっぱなしにすると、何時間も離れた 2 回で枠を
    // 使い切り、以後そのセッションでは二度と押せなくなる（据え置きで長く動かす端末で効く）。
    this.setState((s) => ({ retries: failedRightAfterRetry ? s.retries + 1 : 0 }))
    // **`componentStack` を必ず添える。** 例外そのものだけでは、同じ関数が複数の場所から
    // 呼ばれるこのコードベースでどの経路で壊れたか絞れない。ここは毎フレーム来る経路ではないので
    // 間引かない。
    log.error(
      `[error-boundary] ${this.props.variant === 'root' ? '画面全体' : this.props.label} の表示が続けられなくなった`,
      error,
      info.componentStack,
    )
  }

  private handleRetry = (): void => {
    this.retriedAtMs = Date.now()
    // 例外で React はこの境界の下をアンマウント済みなので、`failed` を戻すと子は新しく
    // マウントし直される（子の state は引き継がれない）。
    this.setState({ failed: false })
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    // **`this.props` を一度ローカルへ取る。** プロパティアクセスのままでは `variant` による
    // 絞り込みが `label` に効かない。
    const props = this.props
    if (!this.state.failed) return props.children

    if (props.variant === 'root') {
      return (
        <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-app p-6 text-center text-white">
          <div className="text-lg roomy:text-2xl">画面を表示できなくなりました</div>
          {/* 根が落ちると副作用の後始末で接続も切れる。**「見えないだけ」と誤解させないこと。** */}
          <div className="text-sm opacity-80 roomy:text-lg">情報の受信も止まっています</div>
          <button
            type="button"
            onClick={this.handleReload}
            className="mt-1 rounded-md border border-border bg-slate-800/90 px-4 py-2 text-sm transition-colors hover:bg-slate-700/90 roomy:text-lg"
          >
            再読み込み
          </button>
        </div>
      )
    }

    // 地図・タブはどちらも `absolute inset-0` の器に収まるので、同じ形で覆える。
    // **z を持たせない。** 地図の左上の情報ブロック（更新時刻・取得状況・描画状況）と
    // 行動チェックリスト・特別情報バナーは `z-[99999]` で前に出るため、地図が落ちても隠れない。
    const canRetry = this.state.retries < MAX_RETRIES
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-app/95 p-4 text-center text-white">
        <div className="text-sm roomy:text-lg">{props.label}を表示できません</div>
        {canRetry ? (
          <button
            type="button"
            onClick={this.handleRetry}
            className="rounded-md border border-border bg-slate-800/90 px-3 py-1.5 text-xs transition-colors hover:bg-slate-700/90 roomy:text-base"
          >
            再表示
          </button>
        ) : (
          // 押しても直らないと分かった後は、`MapRenderStatus` と同じ案内へ落とす。
          <div className="text-xs opacity-80 roomy:text-base">再読み込みで直ることがあります</div>
        )}
      </div>
    )
  }
}
