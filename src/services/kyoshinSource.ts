// 強震モニタのフレーム供給元（ソース）。
//
// 「どこからデータを持ってくるか」だけを担い、いつ画面へ反映するかは持たない。取得したフレームは
// キュー（utils/kyoshinFrameQueue）へ渡し、データ時刻が来た時点で消費側（useKyoshinRealtime）が
// 取り出す。この分離があるので、1 秒ずつ取りに行く Yahoo と、まとめて手に入るアーカイブを
// 同じ下流に載せられる。
//
// 現在の実装は Yahoo リアルタイム震度の 2 モード（ライブ／過去日時のリプレイ）。将来、防災科研
// K-NET のアーカイブなど「フレーム列が一度に手に入る」供給元を足す場合は、KyoshinSource を
// 実装して start() の中でフレームをまとめて enqueue すればよい（下流は変更不要）。

import {
  fetchRealtimeIntensity,
  fetchSiteList,
  startClockSync,
  type SiteCoords,
  type YahooHypoInfoItem,
} from './kyoshin'
import { serverNow } from '../utils/clock'
import {
  WARMUP_BLOCK_SEC,
  WARMUP_MAX_BLOCKS,
  isQuietFrame,
  firstContinuousIndex,
} from '../utils/kyoshinWarmup'
import { createLogThrottle, log } from '../utils/logger'

/** 1 時点ぶんの観測データ。 */
export interface KyoshinFrame {
  /**
   * このフレームのデータ時刻。キューの並べ替えと放出判定に使う。
   *
   * 取得を要求した時刻を入れる（応答に載る `dataTime` 文字列のパースに依存させない）。
   */
  time: Date
  /** データ時刻の文字列表現。表示と検知エンジンへそのまま渡す。 */
  dataTime: string
  /**
   * このフレームがどの観測点集合に対応するかの識別子。`resolveSites()` に渡すと座標が引ける。
   * Yahoo では観測点リストの版を表す `siteConfigId`。取得できなかった場合は空文字。
   */
  sitesKey: string
  /** 観測点ごとの震度インデックス。`sitesKey` の観測点リストと同順。 */
  indices: number[]
  /** EEW 情報。Yahoo 固有のため、他の供給元では持たない。 */
  hypoInfo?: YahooHypoInfoItem[]
}

/** ソースがフレームと状態を渡す先。 */
export interface KyoshinSourceSink {
  /** フレームを 1 件渡す。 */
  enqueue(frame: KyoshinFrame): void
  /** 取得が続けて失敗し更新が止まっているか（true）／回復したか（false）を伝える。 */
  setStalled(stalled: boolean): void
  /**
   * 検知エンジンの助走（`utils/kyoshinWarmup`）に使うフレーム列を、**時刻の昇順で 1 度だけ**渡す。
   * 供給が始まる時刻より前のフレームで、画面の震度・データ時刻には出さない。
   *
   * **助走を用意しない供給元も、取得に失敗した供給元も、必ず 1 度は呼ぶこと**（空配列でよい）。
   * 受け取る側は助走が届くまで通常フレームの消化を待たせるので、呼ばずに済ませると
   * **検知が上限まで沈黙する**。
   */
  prefill(frames: KyoshinFrame[]): void
}

/** 強震モニタのフレーム供給元。 */
export interface KyoshinSource {
  /** 供給を開始する。二重に呼んでも 2 本目は起動しない。 */
  start(sink: KyoshinSourceSink): void
  /** 供給を停止する。停止後は sink を呼ばない。何度呼んでもよい。 */
  stop(): void
  /** `KyoshinFrame.sitesKey` に対応する観測点座標を解決する。 */
  resolveSites(sitesKey: string): Promise<SiteCoords>
}

// ---- Yahoo リアルタイム震度 ----
//
// 以下のしきい値を公開しているのは、単体テストがスケジューリングの境界（何回目の失敗で
// 諦めるか・いつ次を取りに行くか）をこれらから組み立てるため。テスト側に値を複製すると、
// しきい値を変えたときにテストは通り続けるのに境界を試さなくなる（黙って劣化する）。

/** 同一データ時刻の取得に失敗したときの再試行間隔 (ms)。 */
export const RETRY_MS = 200
/** 成功後、次のデータ時刻へ進むまでの待機時間 (ms)。 */
export const POLL_MS = 1000
/**
 * Yahoo がデータを公開するまでの遅延を見込んだオフセット (ms)。
 *
 * 秒ファイルは「その秒が終わってから約 0.5 秒後（＝秒頭から約 1.5 秒後）」に登録される実測結果に
 * 基づき、クロック同期後の `serverNow()` から登録済みの秒を確実に引ける値にしている。
 * （従来の 500ms は壁時計が遅れている環境での偶然の帳尻合わせに依存しており、クロックを
 *  正確に同期すると未登録の秒を叩いて 403 になるため引き上げた。）
 */
export const FETCH_OFFSET_MS = 1800
/** ライブ時: 同一データ時刻の取得を諦めて現在時刻へ戻すまでの許容時間 (ms)。 */
const MAX_LAG_MS = 5000
/**
 * ライブ時: 同一データ時刻への最大再試行回数。超えたら諦めて現在時刻ベースへリセットする。
 * CDN 側で特定の秒の公開が恒久的に失敗するケースで、無限に再試行し続けるのを防ぐ。
 */
export const REALTIME_MAX_RETRY_COUNT = MAX_LAG_MS / RETRY_MS
/** リプレイ時: 同一データ時刻への最大再試行回数。超えたら次のデータ時刻へ進む。 */
export const REPLAY_MAX_RETRY_COUNT = 5
/** この回数続けて取得に失敗したら「更新が止まっている」と扱う。 */
export const ERROR_THRESHOLD = 5
/**
 * 助走フレームを取りに行くときの並列数。
 *
 * 1 ブロック（`WARMUP_BLOCK_SEC` 秒）ぶんをこの数ずつまとめて投げる。実測では 24 並列で
 * 60 件が 889ms・30 並列で 30 件が 220ms。通常の取得（1 秒に 1 件）とは桁が違うので、
 * 上げすぎて Yahoo 側に負荷を掛けない範囲に留める。
 */
const WARMUP_CONCURRENCY = 24
/** 同種の失敗を記録し直す最小間隔 (ms)。1Hz で再発する失敗を間引きつつ、継続を見失わない幅。 */
const LOG_THROTTLE_MS = 60_000

/**
 * Yahoo リアルタイム震度から現在のフレームを 1 秒ごとに取得するソース（ライブ）。
 *
 * 取得するデータ時刻は「サーバー同期した現在時刻 - FETCH_OFFSET_MS」から始め、成功のたびに
 * 1 秒進める。ただし描画負荷などで発火が遅れた場合は最新へ再アンカーして遅れを溜め込まない。
 */
export function createYahooLiveSource(): KyoshinSource {
  return createYahooSource(null)
}

/**
 * Yahoo リアルタイム震度から過去のフレームを等速で辿るソース（リプレイ）。
 *
 * Yahoo が秒ファイルを保持している期間しか遡れない。
 *
 * @param timeOffsetMs 壁時計に加算して再生時刻を得るオフセット (ms)。負の値で過去。
 */
export function createYahooArchiveSource(timeOffsetMs: number): KyoshinSource {
  return createYahooSource(timeOffsetMs)
}

/**
 * 秒ファイルをまとめて取りに行く。取れなかった秒は飛ばす（Yahoo 側に元から無い秒がある）。
 *
 * 助走の取得でしか使わない。通常の取得（`tick`）は失敗を再試行と「更新停止」の判定に使うが、
 * こちらは取れた分だけ使えばよいので、1 件ずつ握って先へ進む。
 */
async function fetchFramesConcurrently(targets: Date[], isActive: () => boolean): Promise<KyoshinFrame[]> {
  const out: KyoshinFrame[] = []
  for (let i = 0; i < targets.length; i += WARMUP_CONCURRENCY) {
    if (!isActive()) return out
    const chunk = targets.slice(i, i + WARMUP_CONCURRENCY)
    const got = await Promise.all(chunk.map(async (t): Promise<KyoshinFrame | null> => {
      // 停止したら未発行の分は投げない（発行済みのものは止められない。`fetchRealtimeIntensity`
      // は中断の手段を持たないため、そこまでは諦める）。
      if (!isActive()) return null
      try {
        const rt = await fetchRealtimeIntensity(t)
        // **hypoInfo は載せない。** 助走は検知エンジンだけのもので、EEW の差分検出へ流すと
        // 開始より前に終わっていた速報が新規発報として鳴り直す。
        return { time: t, dataTime: rt.dataTime, sitesKey: rt.siteConfigId, indices: rt.indices }
      } catch {
        return null
      }
    }))
    for (const f of got) if (f !== null) out.push(f)
  }
  return out
}

/**
 * 助走フレームを取得する。`startTarget` より前の秒をブロック単位で遡り、遡った先が静穏に
 * なったところで打ち切る（どこまで遡るかの規則と根拠は `utils/kyoshinWarmup`）。
 *
 * 返すのは時刻の昇順。`startTarget` そのものは含めない（そちらは通常の取得が拾う）。
 */
async function fetchWarmupFrames(startTarget: Date, isActive: () => boolean): Promise<KyoshinFrame[]> {
  const blocks: KyoshinFrame[][] = []
  let requested = 0
  /** 遡りを終えた理由。記録に出す（下記参照）。 */
  let stoppedBy: '静穏まで遡った' | '取得できない秒に当たった' | '上限まで遡った' = '上限まで遡った'
  for (let b = 1; b <= WARMUP_MAX_BLOCKS; b++) {
    if (!isActive()) return []
    const blockEndMs = startTarget.getTime() - (b - 1) * WARMUP_BLOCK_SEC * 1000
    const targets: Date[] = []
    for (let s = WARMUP_BLOCK_SEC; s >= 1; s--) targets.push(new Date(blockEndMs - s * 1000))
    requested += targets.length
    const block = await fetchFramesConcurrently(targets, isActive)
    // 1 件も取れなかったブロックは静穏かどうかを確かめようがない。ここで止めて、
    // それまでに取れた分を助走にする（遡り続けても確かめられないまま伸びるだけ）。
    if (block.length === 0) { stoppedBy = '取得できない秒に当たった'; break }
    blocks.unshift(block)
    if (isQuietFrame(block[0].indices)) { stoppedBy = '静穏まで遡った'; break }
  }
  const frames = blocks.flat()
  const usable = frames.slice(firstContinuousIndex(frames.map((f) => f.time.getTime())))

  // **結果を必ず記録する。** 取得が全滅したときの戻り値は「1 ブロックで静穏に行き当たった」
  // 正常な最短打ち切りと同じ空配列で、**画面からもログからも区別が付かない**。助走が効いて
  // いないこと自体が症状として現れない（立ち上がりの検知が遅れるだけ）ので、ここが唯一の
  // 手がかりになる。
  if (usable.length === 0) {
    log.warn(`[kyoshinSource] 助走フレームを 1 件も使えませんでした（要求 ${requested} 件・${stoppedBy}）`)
  } else {
    log.info(
      `[kyoshinSource] 助走 ${usable.length} フレーム（要求 ${requested} 件・取得 ${frames.length} 件・${stoppedBy}）`,
    )
  }
  return usable
}

function createYahooSource(timeOffsetMs: number | null): KyoshinSource {
  const isReplay = timeOffsetMs != null
  let active = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopClockSync: (() => void) | null = null
  // 連続失敗回数。同一データ時刻への再試行は 1 回の失敗として数える。
  let failCount = 0
  // 壊れた消費側は毎フレーム同じ例外を投げるため、記録は間引く（一度きりにはしない。
  // 継続している不具合が「一度失敗して直った」ように見えるのを避ける）。
  let throttledHandoffError = createLogThrottle(LOG_THROTTLE_MS)

  const source: KyoshinSource = {
    start(sink) {
      if (active) return
      active = true
      failCount = 0
      throttledHandoffError = createLogThrottle(LOG_THROTTLE_MS)

      // ライブのみクロック同期を起動して serverNow() をサーバー時刻へ較正する
      // （リプレイ中はアーカイブの時刻を使うため不要）。
      stopClockSync = isReplay ? null : startClockSync()

      // 最初に取得するデータ時刻。ライブは FETCH_OFFSET_MS だけ過去から始めて、
      // 秒境界直後の未登録（403）を踏むのを抑える。
      const initialTarget = isReplay
        ? new Date(Date.now() + timeOffsetMs)
        : new Date(serverNow() - FETCH_OFFSET_MS)

      // 助走は通常の取得と並行して進める。待ってから始めると、画面に震度が出るまでの時間が
      // 助走の取得ぶんだけ伸びる（検知が追いつくのが遅れるだけなら、画面は先に動かしてよい）。
      //
      // **どの経路を通っても `prefill` を必ず 1 度呼ぶ。** 受け取る側は助走が届くまで通常
      // フレームの消化を待たせるため、呼び忘れると検知が上限まで沈黙する。
      void (async () => {
        let frames: KyoshinFrame[] = []
        try {
          frames = await fetchWarmupFrames(initialTarget, () => active)
        } catch (err) {
          // 取得は 1 件ずつ握ってあるのでここへは来ない想定。来たとしても助走を諦めるだけで、
          // 通常の取得は動き続ける。
          log.warn('[kyoshinSource] 助走フレームの取得に失敗（助走なしで続行）', err)
        }
        if (!active) return
        try {
          sink.prefill(frames)
        } catch (err) {
          throttledHandoffError(() => log.error(
            '[kyoshinSource] 助走フレームの受け渡し中の例外（取得の失敗とは別）', err,
          ))
        }
      })()

      // リプレイ時: (アンカーの実時刻, アンカーのデータ時刻) を基準に、各データ時刻の取得を
      // 始める実時刻を絶対値で計算する。setTimeout は指定時間ぴったりには発火しないため、
      // 待機時間を「前回からの経過分を引く」相対計算にすると遅延が毎回積み重なり、再生時刻が
      // 壁時計からどんどん遅れていく。絶対時刻を基準にすれば各回の遅延がリセットされ蓄積しない。
      const anchorRealMs = Date.now()
      const anchorTargetMs = initialTarget.getTime()
      const scheduledWaitMs = (nextTarget: Date): number =>
        Math.max(0, anchorRealMs + (nextTarget.getTime() - anchorTargetMs) - Date.now())

      // target: 今回取得するデータ時刻。retryCount: 同一データ時刻への再試行回数。
      const tick = (target: Date, retryCount = 0) => {
        const fetchStart = Date.now()
        fetchRealtimeIntensity(target)
          .then((rt) => {
            if (!active) return
            failCount = 0
            // sink への受け渡しで例外が漏れると、次の setTimeout が仕込まれないまま取得が
            // 恒久停止する（無音で全機能が死ぬ）。現在の消費側は画面への反映で起きた例外を
            // 自分の内側で処理するため、ここへ届くのは sink 自体（キューへの投入や消費側の
            // 外枠）が壊れた場合に限られる。到達頻度は低いが、境界は必ず守る。
            try {
              sink.setStalled(false)
              sink.enqueue({
                time: target,
                dataTime: rt.dataTime,
                sitesKey: rt.siteConfigId,
                indices: rt.indices,
                hypoInfo: rt.hypoInfo,
              })
            } catch (err) {
              throttledHandoffError(() => log.error(
                '[kyoshinSource] フレーム受け渡し中の例外（取得の失敗とは別）', err,
              ))
            }
            if (!isReplay) {
              // ライブ: 次は「前回 + POLL_MS」と「最新（serverNow - FETCH_OFFSET_MS）」の
              // 大きい方。通常は両者がほぼ一致してコマ飛びしないが、発火が遅れた場合は最新へ
              // ジャンプして遅れを溜めない。前回 + POLL_MS で這うだけだと発火遅延が毎回蓄積し、
              // 取得が速くても表示が数秒遅れていく。この再アンカーにより遅れは常に
              // FETCH_OFFSET_MS 以下に張り付く。
              const nextTarget = new Date(Math.max(target.getTime() + POLL_MS, serverNow() - FETCH_OFFSET_MS))
              // 取得にかかった時間を待機から引いて POLL_MS ごとの一定間隔を保つ
              const elapsed = Date.now() - fetchStart
              timer = setTimeout(() => tick(nextTarget), Math.max(0, POLL_MS - elapsed))
              return
            }
            // リプレイ: アーカイブを等速で辿るため 1 秒ずつ進める。
            const nextTarget = new Date(target.getTime() + POLL_MS)
            timer = setTimeout(() => tick(nextTarget), scheduledWaitMs(nextTarget))
          })
          .catch((err) => {
            if (!active) return
            if (!isReplay) {
              // ライブのみ: 連続失敗を数えて「更新停止」を通知する
              if (retryCount === 0) {
                failCount += 1
                if (failCount >= ERROR_THRESHOLD) {
                  log.warn(`[kyoshinSource] 連続取得失敗 (${failCount}回) → 更新停止として通知`, err)
                  sink.setStalled(true)
                }
              }
              // 同一データ時刻への失敗が続き上限を超えたら、その時刻を諦めて現在時刻ベースへ
              // 戻す（特定の秒が CDN 側で恒久的に取得できないケースで張り付くのを防ぐ）
              if (retryCount + 1 >= REALTIME_MAX_RETRY_COUNT) {
                log.warn(`[kyoshinSource] 同一データ時刻への取得が ${retryCount + 1} 回失敗 → 現在時刻ベースにリセット`, err)
                timer = setTimeout(() => tick(new Date(serverNow() - FETCH_OFFSET_MS)), RETRY_MS)
                return
              }
              timer = setTimeout(() => tick(target, retryCount + 1), RETRY_MS)
              return
            }
            // リプレイ: 上限を超えたら諦めて次のデータ時刻へ進める
            // （アーカイブ側の恒久的な欠損で無限に再試行するのを防ぐ）
            if (retryCount + 1 >= REPLAY_MAX_RETRY_COUNT) {
              const nextTarget = new Date(target.getTime() + POLL_MS)
              timer = setTimeout(() => tick(nextTarget), scheduledWaitMs(nextTarget))
              return
            }
            timer = setTimeout(() => tick(target, retryCount + 1), RETRY_MS)
          })
      }

      tick(initialTarget)
    },

    stop() {
      active = false
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (stopClockSync !== null) {
        stopClockSync()
        stopClockSync = null
      }
    },

    resolveSites(sitesKey) {
      return fetchSiteList(sitesKey)
    },
  }

  return source
}
