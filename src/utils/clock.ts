// アプリ全体の時刻基準。壁時計(Date.now())の絶対値に依存せず、サーバー同期した現在時刻を返す。
//
// 背景: 端末の壁時計は NTP 補正・仮想環境のドリフトで秒単位でずれ得る。強震モニタの
//   「どの秒を取るか」や DMDSS 波円半径 (now - originTime) は秒未満のずれでも破綻するため、
//   壁時計の絶対値を信用せず、サーバー由来の時刻へ同期した現在時刻を一元的に供給する。
//
// モード:
//   live   : serverNow = performance.now() + K   (K = サーバーepoch時刻 - performance.now())
//            performance.now() は単調増加で NTP 補正の影響を受けないため、壁時計がジャンプしても
//            歪まない。K は feedServerSample() でサーバー由来の時刻から EMA 推定する。
//   replay : serverNow = Date.now() + replayOffset   (アーカイブ再生・手動時刻の絶対制御。既存挙動を維持)
//
// 未較正（K 未推定・非リプレイ）時は壁時計へフォールバックし、CLK-3 対応で一定間隔で log.warn を出す。

import { log } from './logger'

/** K 推定の EMA 係数。大きいほど新しいサンプルに追従。 */
const EMA_ALPHA = 0.2

/** live モードで performance.now() をサーバーepoch(ms)へ変換する定数。未較正時は null。 */
let kEpochMs: number | null = null

/**
 * 最後に K を更新した時点の performance.now()。未較正なら null。
 *
 * K は最後に成功したサンプルを保持し続けるため、値だけを見ても「30 秒前に較正した新しい K」と
 * 「較正が止まって何時間も前のまま残っている K」を区別できない。古い K を現在の推定器の性能と
 * みなすと診断を誤るため、鮮度を併せて持つ。
 */
let lastSampleAtPerfMs: number | null = null

/** リプレイ/手動時刻のオフセット(ms)。null のとき live モード。 */
let replayOffsetMs: number | null = null

/** CLK-3: 未較正フォールバック警告のスロットル用（最終警告時刻）。 */
let lastUncalibratedWarnAtMs = 0
const UNCALIBRATED_WARN_INTERVAL_MS = 60000

/**
 * 最良推定のサーバー現在時刻（epoch ms）。
 * アプリ内で「現在時刻」が必要な箇所は Date.now()/new Date() の代わりにこれを使う。
 */
export function serverNow(): number {
  if (replayOffsetMs !== null) return Date.now() + replayOffsetMs
  if (kEpochMs !== null) return performance.now() + kEpochMs
  // CLK-3: 未較正で壁時計にフォールバック中。到達不能環境で無音の恒久フォールバックに
  // ならないよう、60 秒間隔で警告を出す。フォールバック自体は続行（挙動は既存と同一）。
  const now = Date.now()
  if (now - lastUncalibratedWarnAtMs > UNCALIBRATED_WARN_INTERVAL_MS) {
    lastUncalibratedWarnAtMs = now
    log.warn('[clock] サーバー時刻未較正のため Date.now() にフォールバック中（Yahoo 到達不能等）')
  }
  return now
}

/** serverNow() の Date 版。 */
export function serverDate(): Date {
  return new Date(serverNow())
}

/**
 * リプレイ/手動時刻のオフセットを設定する。
 * @param offsetMs 壁時計に加算するオフセット(ms)。null で live モードへ戻す。
 */
export function setReplayOffset(offsetMs: number | null): void {
  replayOffsetMs = offsetMs
}

/**
 * サーバー由来の「現在時刻」サンプルで K を較正する（live モード用）。
 * リプレイ中は K を更新しない（アーカイブ時刻とサーバー現在時刻は無関係なため）。
 * @param trueServerEpochMs サーバーの現在時刻(epoch ms)の推定値
 */
export function feedServerSample(trueServerEpochMs: number): void {
  if (replayOffsetMs !== null) return
  if (!Number.isFinite(trueServerEpochMs)) return
  const sample = trueServerEpochMs - performance.now()
  kEpochMs = kEpochMs === null ? sample : kEpochMs * (1 - EMA_ALPHA) + sample * EMA_ALPHA
  lastSampleAtPerfMs = performance.now()
}

/**
 * 最後にサーバー時刻で較正してからの経過時間 (ms)。未較正なら null。
 *
 * 較正が止まっていないかの診断に使う。`getServerClockOffsetMs()` の値と併せて見ることで、
 * 「オフセットは出ているが更新は止まっている」状態を見分けられる。
 */
export function getServerClockSampleAgeMs(): number | null {
  if (lastSampleAtPerfMs === null) return null
  return Math.round(performance.now() - lastSampleAtPerfMs)
}

/**
 * 現在の推定クロックオフセット（サーバー - 壁時計, ms）。デバッグ・表示用。
 * @returns 較正済みならオフセット(ms)、未較正なら null。
 */
export function getServerClockOffsetMs(): number | null {
  if (kEpochMs === null) return null
  return Math.round(performance.now() + kEpochMs - Date.now())
}

// Page Visibility 対応: タブが hidden の間、performance.now() は継続するが、
// setInterval/setTimeout はブラウザによって 1s→1min まで throttle される。この間サーバー同期
// ポーリング（kyoshin.ts startClockSync）が事実上停止し、visible 復帰時の K は「throttle 前の
// サーバー時刻」を基準にしたまま。壁時計に対する performance.now() の相対関係は保たれるので
// 較正済み K は形式的には有効だが、ハイバネート・スリープ復帰など performance.now() 自体が
// 大きく飛ぶ環境（Chromium は wall clock 追従で復帰後 monotonic 保証が必ずしも成立しない）を
// 想定して安全側に振る: visible 復帰時に K を捨て、次のサンプルまで壁時計フォールバックへ戻す。
// フォールバック中は既存の未較正 warn 機構（60 秒スロットル）で診断可能。
// SSR / 非ブラウザ環境（Node のテスト等）では document 参照が失敗するためガードする。
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && replayOffsetMs === null && kEpochMs !== null) {
      log.info('[clock] タブ復帰: K を破棄して次のサーバーサンプルで再較正')
      kEpochMs = null
      // 鮮度も一緒に捨てる。残すと「未較正なのに直近で較正済み」と読める矛盾した診断になる。
      lastSampleAtPerfMs = null
    }
  })
}
