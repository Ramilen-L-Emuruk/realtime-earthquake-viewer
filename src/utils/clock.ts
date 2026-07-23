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
// 未較正（K 未推定・非リプレイ）時は壁時計へフォールバックする。

/** K 推定の EMA 係数。大きいほど新しいサンプルに追従。 */
const EMA_ALPHA = 0.2

/** live モードで performance.now() をサーバーepoch(ms)へ変換する定数。未較正時は null。 */
let kEpochMs: number | null = null

/** リプレイ/手動時刻のオフセット(ms)。null のとき live モード。 */
let replayOffsetMs: number | null = null

/**
 * 最良推定のサーバー現在時刻（epoch ms）。
 * アプリ内で「現在時刻」が必要な箇所は Date.now()/new Date() の代わりにこれを使う。
 */
export function serverNow(): number {
  if (replayOffsetMs !== null) return Date.now() + replayOffsetMs
  if (kEpochMs !== null) return performance.now() + kEpochMs
  return Date.now()
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

/** リプレイ/手動時刻モードかどうか。 */
export function isReplayClock(): boolean {
  return replayOffsetMs !== null
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
}

/**
 * 現在の推定クロックオフセット（サーバー - 壁時計, ms）。デバッグ・表示用。
 * @returns 較正済みならオフセット(ms)、未較正なら null。
 */
export function getServerClockOffsetMs(): number | null {
  if (kEpochMs === null) return null
  return Math.round(performance.now() + kEpochMs - Date.now())
}
