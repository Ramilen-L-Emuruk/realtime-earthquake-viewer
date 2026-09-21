// 強震モニタのフレーム供給元（ソース）。
//
// 「どこからデータを持ってくるか」だけを担い、いつ画面へ反映するかは持たない。取得したフレームは
// キュー（utils/kyoshinFrameQueue）へ渡し、データ時刻が来た時点で消費側（useKyoshinRealtime）が
// 取り出す。この分離があるので、1 秒ずつ取りに行く Yahoo と、まとめて手に入るアーカイブを
// 同じ下流に載せられる。
//
// このファイルの実装は Yahoo リアルタイム震度の 2 つで、**取りに行き方が根本的に違う**。
//
//   ライブ（createYahooPollingSource）   : まだ存在しない秒は取れないので、1 秒ずつ追いかける
//   リプレイ（createYahooPipelineSource）: 過去の秒は既にあるので、再生時刻より先を取って積む
//
// リプレイが先に積めるのは、キューの放出基準が再生時刻（`utils/clock` の `serverNow()`）だから。
// 取得のばらつきが放出のタイミングから切り離され、同じ範囲を再生し直したときの結果も一致する。
// ローカル履歴アーカイブ（services/kyoshinLocalArchiveSource）は同じ形で収録全件を一度に積む。

import {
  fetchRealtimeIntensity,
  fetchSiteList,
  startClockSync,
  type RealtimeIntensity,
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
/**
 * 「更新が止まっている」と扱うまでの、失敗が続いた経過時間 (ms)。
 *
 * **回数ではなく経過時間で測る。** 失敗が続くと再試行の間隔が伸びる作りになったので
 * （`stalledRetryDelayMs`）、回数で数えると**1 周が伸びたぶんだけ判定も遅れる**
 * （→ `rules/common/code-review.md`「指標・条件が本体からずれていないか」）。
 *
 * 従来は「フレームを 5 つ諦めたら」という数え方で、**101 リクエスト・約 20 秒**を要していた。
 * 経過時間なら間隔をどう変えても 5 秒で判定できる。
 */
export const STALLED_AFTER_MS = 5_000
/**
 * 更新停止と判定した後の再試行間隔の上限 (ms)。
 *
 * **失敗しても `RETRY_MS`（200ms）で撃ち続けない。** 1 フレームの取得はエッジ 2 つを順に試すので
 * 最大 2 リクエスト。それを 200ms 間隔で再試行すると、配信が止まっているあいだ**毎秒 10 件**を
 * 投げ続ける（実際に踏んだ: 2026-09-15 にリプレイの時刻を誤って範囲外にしたとき、18 秒ほどで
 * 177 件の 403 が出た）。**止まっていることは既に画面へ出している**ので、急いで確かめる意味がない。
 *
 * 連続失敗が `STALLED_BACKOFF_AFTER_FAILURES` を超えてから倍々にし、ここで頭打ちにする。
 * 復帰したら戻す（成功で連続失敗が 0 に戻るので、この間隔も自動的に `RETRY_MS` へ戻る）。
 */
export const STALLED_RETRY_MAX_MS = 10_000
/**
 * リプレイ時: この数だけ続けて「秒ファイルを諦めた」ら、先読みをやめて間隔を空けた探りへ移る。
 *
 * `REPLAY_MAX_ATTEMPTS_PER_TARGET` が抑えるのは 1 つの秒あたりの取得回数で、**秒をまたいだ
 * 総量は抑えられない**。データが 1 件も無い時間帯（収録範囲の外・存在しない日付）を指定すると、
 * 先読みの地平線に居る秒がそれぞれ再試行するので、諦めるまで投げ続けることになる。
 *
 * **止めるのではなく間隔を空ける。** ここは「収録の無い時代を指定した」と「収録期間内での
 * 長い欠測」を区別できない。止める作りにしていた頃は、後者でも**そのリプレイセッションが
 * 終わるまで二度と取りに行かなかった**（復旧しても、その後に本震が来ても）。
 */
export const REPLAY_MAX_CONSECUTIVE_GIVEUPS = 10

// ---- リプレイの先読み ----
//
// リプレイは未来（＝過去の秒ファイル）を先に取れる。先に取ってキューへ積むことで、放出の
// タイミングを取得のばらつきから切り離す（仕組みと経緯は `createYahooPipelineSource`）。

/**
 * 再生時刻より何秒先までの秒を取りに行くか (ms)。
 *
 * **長いほど取得のばらつきと一過性の失敗に強くなるが、全滅したときの瞬間のリクエスト量も
 * これに比例する**（地平線に居る秒がそれぞれ再試行するため）。通常の往復は 1 秒未満なので、
 * 10 秒あれば詰まりを吸収でき、失敗した秒には `REPLAY_MAX_ATTEMPTS_PER_TARGET` 回を
 * 使い切る余裕が残る。
 *
 * **先読みが無駄になるのは再生を止めたときだけ**で、その分も控えに残る
 * （`utils/kyoshinFrameCache`）。区間を続けて送る録画では次の区間が使う。
 */
export const REPLAY_LEAD_MS = 10_000
/**
 * 同時に取りに行く秒の数。
 *
 * 定常状態では 1 秒に 1 件しか消費しないので枠は 1 つで足りる。複数要るのは**地平線を
 * 埋めるとき**（再生の開始直後・詰まりからの復帰）だけ。助走の並列数（`WARMUP_CONCURRENCY`）
 * と桁を分けてあるのは、あちらが一度きりなのに対してこちらは再生のあいだ続くため。
 */
export const REPLAY_PREFETCH_CONCURRENCY = 3
/**
 * 1 つの秒を諦めるまでの取得回数。
 *
 * 先読みには地平線のぶんだけ猶予があるので、**間隔を空けて時間的に分散した再試行**ができる
 * （→ `replayRetryDelayMs`）。その場で取りに行っていた頃は 200ms 間隔で 5 回 ＝ 約 1 秒しか
 * 猶予が無く、CDN の一過性の失敗をそのまま欠落にしていた。
 */
export const REPLAY_MAX_ATTEMPTS_PER_TARGET = 4
/**
 * 先読みを回す間隔 (ms)。
 *
 * 取得の完了時にも回すので、これは「何も返ってこないとき」の保険にあたる（枠が埋まったまま
 * 応答が来ない間も、再生時刻が進んだことを見て諦めや計画の付け替えを進める）。
 */
export const REPLAY_PUMP_INTERVAL_MS = 250
/** 失敗した秒を試し直す最小間隔 (ms)。以後 2 倍ずつ伸ばす。 */
const REPLAY_RETRY_BASE_MS = RETRY_MS
/**
 * 同上の上限 (ms)。
 *
 * 地平線（`REPLAY_LEAD_MS`）の中で `REPLAY_MAX_ATTEMPTS_PER_TARGET` 回を使い切れる幅に
 * 収める。上限が地平線に近づくと、再生時刻に追い越されて試行回数を使わないまま諦める。
 */
const REPLAY_RETRY_MAX_MS = 3_000

/**
 * 先読みで失敗した秒を、次に試すまでの間隔。
 *
 * @param attempts その秒をすでに試した回数（1 以上）
 */
export function replayRetryDelayMs(attempts: number): number {
  return Math.min(REPLAY_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), REPLAY_RETRY_MAX_MS)
}

/** 全滅した後の探りの、最初の間隔 (ms)。以後 2 倍ずつ伸ばし `STALLED_RETRY_MAX_MS` で頭打ち。 */
export const REPLAY_PROBE_BASE_MS = 1_000

/**
 * 全滅した後の探りを、次に投げるまでの間隔。
 *
 * **ライブ経路の `stalledRetryDelayMs` を流用しない。** あちらは「1 本の逐次リクエストが
 * 順に失敗する」ことを前提に、手前の `STALLED_BACKOFF_AFTER_FAILURES`（25）回を 200ms の
 * まま通す設計。先読みの失敗を**並列 3 本ぶん合算した**値をそこへ渡すと、探りへ移る時点で
 * 既に 40 前後まで積まれていて**初回の探りから上限（10 秒）へ飽和する** —— 倍々に伸ばす
 * 意図が一度も効かない。数える対象が違うものを同じ尺度へ入れていた。
 *
 * @param attempts 探りが続けて失敗した回数（0 から）
 */
export function replayProbeDelayMs(attempts: number): number {
  return Math.min(REPLAY_PROBE_BASE_MS * 2 ** Math.max(0, attempts), STALLED_RETRY_MAX_MS)
}

/**
 * 間隔を空け始めるまでの連続失敗回数。**数えるのは「取得の回数」で、フレーム数ではない。**
 *
 * かつての更新停止の判定は「同じ秒への再試行をまとめて 1 回」と数えており、閾値に届くまでに
 * 25 回 × 4 サイクル ＝ **101 リクエスト**を要していた。**リクエストは 1 回ごとに発生するのに、
 * 数えているのはフレーム** —— 間隔を決める尺度としては代理値で、実際の量とずれる。
 *
 * ここは 1 フレームぶんの再試行（`REALTIME_MAX_RETRY_COUNT` ＝ 5 秒ぶん）を使い切った
 * ところに置く。**それより手前の挙動は変えない** —— 鈍らせると数百ミリ秒の瞬断で
 * 揺れの立ち上がりを取り落とす。
 */
export const STALLED_BACKOFF_AFTER_FAILURES = REALTIME_MAX_RETRY_COUNT

/**
 * 連続失敗が続いたときの再試行間隔。手前では従来どおり `RETRY_MS`。
 *
 * @param attemptFailures 連続して失敗した**取得の回数**（同じ秒への再試行も 1 回と数える）
 */
export function stalledRetryDelayMs(attemptFailures: number): number {
  if (attemptFailures < STALLED_BACKOFF_AFTER_FAILURES) return RETRY_MS
  const steps = attemptFailures - STALLED_BACKOFF_AFTER_FAILURES
  return Math.min(RETRY_MS * 2 ** steps, STALLED_RETRY_MAX_MS)
}
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
  return createYahooPollingSource()
}

/**
 * Yahoo リアルタイム震度から過去のフレームを等速で辿るソース（リプレイ）。
 *
 * Yahoo が秒ファイルを保持している期間しか遡れない。
 *
 * **取りに行くのは再生時刻より先の秒**で、放出はキューに委ねる（理由は
 * `createYahooPipelineSource`）。ライブとは前提が違うため実装を分けてある。
 *
 * @param timeOffsetMs 壁時計に加算して再生時刻を得るオフセット (ms)。負の値で過去。
 */
export function createYahooArchiveSource(timeOffsetMs: number): KyoshinSource {
  return createYahooPipelineSource(timeOffsetMs)
}

/**
 * 秒ファイルをまとめて取りに行く。取れなかった秒は飛ばす（Yahoo 側に元から無い秒がある）。
 *
 * 助走の取得でしか使わない。通常の取得（`tick`）は失敗を再試行と「更新停止」の判定に使うが、
 * こちらは取れた分だけ使えばよいので、1 件ずつ握って先へ進む。
 */
async function fetchFramesConcurrently(
  targets: Date[], isActive: () => boolean, cache: boolean,
): Promise<KyoshinFrame[]> {
  const out: KyoshinFrame[] = []
  for (let i = 0; i < targets.length; i += WARMUP_CONCURRENCY) {
    if (!isActive()) return out
    const chunk = targets.slice(i, i + WARMUP_CONCURRENCY)
    const got = await Promise.all(chunk.map(async (t): Promise<KyoshinFrame | null> => {
      // 停止したら未発行の分は投げない（発行済みのものは止められない。`fetchRealtimeIntensity`
      // は中断の手段を持たないため、そこまでは諦める）。
      if (!isActive()) return null
      try {
        const rt = await fetchRealtimeIntensity(t, { cache })
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
async function fetchWarmupFrames(
  startTarget: Date, isActive: () => boolean, cache: boolean,
): Promise<KyoshinFrame[]> {
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
    const block = await fetchFramesConcurrently(targets, isActive, cache)
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

/** フレームの受け渡しで出た例外を、取得の失敗と混ぜずに記録する。 */
type HandoffErrorReporter = (message: string, err: unknown) => void

/**
 * 更新停止の通知を安全に渡す関数を作る。**渡せたときだけ true を返す。**
 *
 * **「通知済み」の印は戻り値を見てから立てること。** 先に立てていた頃は、消費側が投げた回に
 * **通知していないのに通知済みになり**、以後その障害では二度と伝えられなかった。
 *
 * **ライブ経路では、囲い忘れると被害がもっと重い。** あちらは取得の `.catch` の中で
 * `setStalled(true)` を呼ぶので、例外が漏れると**次の取得を仕込む前に処理が終わり、
 * ポーリングそのものが無音で永久停止する**（成功側だけ囲って true を渡す側が漏れていた）。
 * だから 2 つの経路で同じものを使う。
 */
function createStalledNotifier(
  sink: KyoshinSourceSink,
  reportHandoffError: HandoffErrorReporter,
): (stalled: boolean) => boolean {
  return (stalled) => {
    try {
      sink.setStalled(stalled)
      return true
    } catch (err) {
      reportHandoffError('[kyoshinSource] 更新停止の受け渡し中の例外（取得の失敗とは別）', err)
      return false
    }
  }
}

/**
 * 助走の取得と受け渡しを起動する。通常の取得と並行して進める（待ってから始めると、画面に
 * 震度が出るまでの時間が助走の取得ぶんだけ伸びる。検知が追いつくのが遅れるだけなら、画面は
 * 先に動かしてよい）。
 *
 * **どの経路も `prefill` を必ず 1 度呼ぶ。** 受け取る側は助走が届くまで通常フレームの消化を
 * 待たせるため、呼び忘れると検知が上限まで沈黙する。この契約をここ 1 箇所で満たしているのは、
 * 供給元ごとに書かせると経路を足したときに落とすため。
 */
function startWarmupHandoff(
  initialTarget: Date,
  sink: KyoshinSourceSink,
  isActive: () => boolean,
  cache: boolean,
  reportHandoffError: HandoffErrorReporter,
): void {
  void (async () => {
    let frames: KyoshinFrame[] = []
    try {
      frames = await fetchWarmupFrames(initialTarget, isActive, cache)
    } catch (err) {
      // 取得は 1 件ずつ握ってあるのでここへは来ない想定。来たとしても助走を諦めるだけで、
      // 通常の取得は動き続ける。
      log.warn('[kyoshinSource] 助走フレームの取得に失敗（助走なしで続行）', err)
    }
    if (!isActive()) return
    try {
      sink.prefill(frames)
    } catch (err) {
      reportHandoffError('[kyoshinSource] 助走フレームの受け渡し中の例外（取得の失敗とは別）', err)
    }
  })()
}

/**
 * ライブ: 現在のフレームを 1 秒ごとに追いかける供給元。
 *
 * **ライブは先読みできない** —— まだ存在しない秒は取れないので、取得のばらつきは「次にどの
 * データ時刻を取るか」の選び方（最新への再アンカー）で吸収する。リプレイ側とは前提が違うため
 * 別の関数にしてある（→ `createYahooPipelineSource`）。
 */
function createYahooPollingSource(): KyoshinSource {
  let active = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopClockSync: (() => void) | null = null
  /**
   * 失敗が続き始めた実時刻。成功したら `null` へ戻す。
   *
   * **更新停止の判定は経過時間で行う**（→ `STALLED_AFTER_MS`）。回数で数えると、
   * 再試行の間隔が伸びたぶんだけ判定が遅れる。
   */
  let failingSince: number | null = null
  /** 更新停止を通知済みか。同じ障害で何度も通知しないため。 */
  let stalledNotified = false
  /**
   * 連続して失敗した**取得の回数**（同じ秒への再試行も 1 回として数える）。再試行の間隔を
   * 決める尺度に使う（→ `stalledRetryDelayMs`）。
   *
   * **フレーム単位で数えた値は間隔の尺度にできない。** 1 フレームは最大
   * `REALTIME_MAX_RETRY_COUNT` 回の再試行を含むので、フレームで数えると実際の
   * リクエスト量と桁がずれる（→ `STALLED_BACKOFF_AFTER_FAILURES`）。
   */
  let attemptFailures = 0
  // 壊れた消費側は毎フレーム同じ例外を投げるため、記録は間引く（一度きりにはしない。
  // 継続している不具合が「一度失敗して直った」ように見えるのを避ける）。
  let throttledHandoffError = createLogThrottle(LOG_THROTTLE_MS)

  return {
    start(sink) {
      if (active) return
      active = true
      failingSince = null
      stalledNotified = false
      attemptFailures = 0
      throttledHandoffError = createLogThrottle(LOG_THROTTLE_MS)
      const reportHandoffError: HandoffErrorReporter = (message, err) => {
        throttledHandoffError(() => log.error(message, err))
      }
      const notifyStalled = createStalledNotifier(sink, reportHandoffError)

      // クロック同期を起動して serverNow() をサーバー時刻へ較正する。
      stopClockSync = startClockSync()

      // 最初に取得するデータ時刻。FETCH_OFFSET_MS だけ過去から始めて、秒境界直後の
      // 未登録（403）を踏むのを抑える。
      const initialTarget = new Date(serverNow() - FETCH_OFFSET_MS)

      // 助走は控えない（ライブは毎秒「新しい時刻」を取るので一度も当たらない）。
      startWarmupHandoff(initialTarget, sink, () => active, false, reportHandoffError)

      // target: 今回取得するデータ時刻。retryCount: 同一データ時刻への再試行回数。
      const tick = (target: Date, retryCount = 0) => {
        const fetchStart = Date.now()
        fetchRealtimeIntensity(target, { cache: false })
          .then((rt) => {
            if (!active) return
            failingSince = null
            attemptFailures = 0
            // sink への受け渡しで例外が漏れると、次の setTimeout が仕込まれないまま取得が
            // 恒久停止する（無音で全機能が死ぬ）。現在の消費側は画面への反映で起きた例外を
            // 自分の内側で処理するため、ここへ届くのは sink 自体（キューへの投入や消費側の
            // 外枠）が壊れた場合に限られる。到達頻度は低いが、境界は必ず守る。
            //
            // **2 つを別々に囲う。** 1 つの try に入れていた頃は、更新停止の解除が投げた回に
            // **取れていたフレームが丸ごと落ちた**（取り直す手段は無い）。
            if (notifyStalled(false)) stalledNotified = false
            try {
              sink.enqueue({
                time: target,
                dataTime: rt.dataTime,
                sitesKey: rt.siteConfigId,
                indices: rt.indices,
                hypoInfo: rt.hypoInfo,
              })
            } catch (err) {
              reportHandoffError('[kyoshinSource] フレーム受け渡し中の例外（取得の失敗とは別）', err)
            }
            // 次は「前回 + POLL_MS」と「最新（serverNow - FETCH_OFFSET_MS）」の大きい方。
            // 通常は両者がほぼ一致してコマ飛びしないが、発火が遅れた場合は最新へジャンプして
            // 遅れを溜めない。前回 + POLL_MS で這うだけだと発火遅延が毎回蓄積し、取得が速くても
            // 表示が数秒遅れていく。この再アンカーにより遅れは常に FETCH_OFFSET_MS 以下に張り付く。
            const nextTarget = new Date(Math.max(target.getTime() + POLL_MS, serverNow() - FETCH_OFFSET_MS))
            // 取得にかかった時間を待機から引いて POLL_MS ごとの一定間隔を保つ
            const elapsed = Date.now() - fetchStart
            timer = setTimeout(() => tick(nextTarget), Math.max(0, POLL_MS - elapsed))
          })
          .catch((err) => {
            if (!active) return
            attemptFailures += 1
            // 失敗が続いた**経過時間**で「更新停止」を通知する
            if (failingSince === null) failingSince = Date.now()
            // **ここも `notifyStalled` を通す。** 素で `sink.setStalled(true)` を呼んでいた頃は、
            // 消費側が投げると例外が `.catch` の外へ抜け、**この下の `setTimeout` を仕込む前に
            // 処理が終わってポーリングが無音で永久停止した**（成功側だけ囲ってあって、
            // いちばん被害の大きいこちらが漏れていた）。
            if (!stalledNotified && Date.now() - failingSince >= STALLED_AFTER_MS) {
              const seconds = Math.round((Date.now() - failingSince) / 1000)
              if (notifyStalled(true)) {
                stalledNotified = true
                log.warn(`[kyoshinSource] ${seconds} 秒続けて取得できず → 更新停止として通知`, err)
              }
            }
            // **失敗が続くほど間隔を空ける。** 200ms 間隔のまま撃ち続けると、配信が
            // 止まっているあいだ毎秒 10 件（エッジ 2 つ × 5 回）になる。止まっていることは
            // 画面へ出しているので、急いで確かめる意味がない（→ `STALLED_RETRY_MAX_MS`）。
            // **進み方（どの秒を次に取るか）は変えない** —— 変えると瞬断の挙動まで動く。
            const retryDelay = stalledRetryDelayMs(attemptFailures)
            // 同一データ時刻への失敗が続き上限を超えたら、その時刻を諦めて現在時刻ベースへ
            // 戻す（特定の秒が CDN 側で恒久的に取得できないケースで張り付くのを防ぐ）
            if (retryCount + 1 >= REALTIME_MAX_RETRY_COUNT) {
              log.warn(`[kyoshinSource] 同一データ時刻への取得が ${retryCount + 1} 回失敗 → 現在時刻ベースにリセット`, err)
              timer = setTimeout(() => tick(new Date(serverNow() - FETCH_OFFSET_MS)), retryDelay)
              return
            }
            timer = setTimeout(() => tick(target, retryCount + 1), retryDelay)
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
}

/**
 * リプレイ: 再生時刻より先の秒を**先に取ってキューへ積む**供給元。
 *
 * ## なぜ先読みするのか
 *
 * かつてここは「再生時刻のその秒を、その瞬間に取りに行く」形だった。リプレイのフレームは
 * データ時刻が必ず過去なので、キューの到来判定は常に真になる —— つまり**画面の更新間隔が
 * 取得の往復時間そのもの**になり、往復のばらつきが丸ごと表示に乗っていた。失敗した秒に
 * 与えられる猶予も 200ms × 5 回 ＝ 約 1 秒しかなく、CDN の一過性の失敗がそのまま欠落に
 * なっていた（取れるかどうかは回ごとに違うので、**同じ範囲を再生しても結果が変わる**）。
 *
 * リプレイは未来（＝過去の秒ファイル）を先に取れる。先に取って積んでおけば、放出は再生時刻の
 * 到来でキュー（`utils/kyoshinFrameQueue`）が決める。ローカル履歴アーカイブの供給元
 * （`services/kyoshinLocalArchiveSource`）が収録全件を一括で積んでいるのと同じ形で、
 * このファイル冒頭が宣言している「取得と再生の分離」がここでようやく成り立つ。
 *
 * ## 何が変わるか
 *
 * - 放出の間隔が取得のばらつきから独立する（キューの巡回の粒度で決まる）
 * - 失敗した秒を、地平線に居るあいだ間隔を空けて何度も試せる（→ `REPLAY_LEAD_MS`）
 * - それでも取れない秒は Yahoo に元から無い秒なので、2 回目の再生でも同じ結果になる
 * - 同じ範囲の 2 回目は控え（`utils/kyoshinFrameCache`）に当たって通信ゼロで完全に一致する
 *
 * リクエスト量は増えない（1 秒に 1 件は変わらない）。増えるのは再生を止めたときに先読みした
 * ぶんだけで、それも控えに残るので連続区間を送る録画では次の区間が使う。
 *
 * @param timeOffsetMs 壁時計に加算して再生時刻を得るオフセット (ms)。負の値で過去。
 */
function createYahooPipelineSource(timeOffsetMs: number): KyoshinSource {
  let active = false
  let pumpTimer: ReturnType<typeof setInterval> | null = null

  return {
    start(sink) {
      if (active) return
      active = true
      // 壊れた消費側は毎フレーム同じ例外を投げるため、記録は間引く（一度きりにはしない。
      // 継続している不具合が「一度失敗して直った」ように見えるのを避ける）。
      const throttledHandoffError = createLogThrottle(LOG_THROTTLE_MS)
      const throttledGiveUp = createLogThrottle(LOG_THROTTLE_MS)
      // 取り直しの打ち切りは諦めとは別のスロットルで持つ。1 つを共有すると、詰まっている
      // あいだ出続けるこちらが「取れなくなった」ほうの記録を黙らせる。
      const throttledStaleTarget = createLogThrottle(LOG_THROTTLE_MS)
      // 観測点リストの先読みの失敗も別に持つ（版が変わるたびしか起きないので、他の記録に
      // 押し出されると出る機会を失う）。
      const throttledSiteListWarm = createLogThrottle(LOG_THROTTLE_MS)
      // 探りの突入と復帰も間引く。**別々に持つ。** 1 本にまとめていた頃は、**先に鳴った方が
      // もう片方を間引きの窓のあいだ黙らせた** —— 「突入だけが出て復帰が出ない」形になり、
      // 読む側は止まったままだと誤解する。
      //
      // **対にはならないことを前提に読む。** どちらも間引かれうるので、片方だけが残る形は
      // 避けられない。**どちらの文にも累積の回数（`probingEpisodes`）を載せる**ので、
      // 番号の飛びから「あいだに何回往復したか」は読める。
      const throttledProbeEnter = createLogThrottle(LOG_THROTTLE_MS)
      const throttledProbeLeave = createLogThrottle(LOG_THROTTLE_MS)
      const reportHandoffError: HandoffErrorReporter = (message, err) => {
        throttledHandoffError(() => log.error(message, err))
      }

      /**
       * 再生時刻。**キューの放出基準（`utils/clock` の `serverNow()`）と同じ軸**になる
       * —— 呼び出し側が同じオフセットを時計へも渡しているため（`App.tsx`）。ここで
       * `serverNow()` を読まずに自分で計算するのは、供給元が自分の時間軸を持つ形を保つため。
       */
      const replayNowMs = () => Date.now() + timeOffsetMs
      /** 秒の格子の基点。取りに行く秒は必ずここから 1 秒刻みの位置にある。 */
      const anchorMs = replayNowMs()
      const initialTarget = new Date(anchorMs)
      /** `ms` を秒の格子（`anchorMs` から 1 秒刻み）へ切り下げる。 */
      const alignToGrid = (ms: number) => anchorMs + Math.floor((ms - anchorMs) / POLL_MS) * POLL_MS

      // 助走は控えを通す（再生では同じ秒を助走と本編で何度も欲しがる）。
      startWarmupHandoff(initialTarget, sink, () => active, true, reportHandoffError)

      /** まだ計画に入れていない最も古い秒。 */
      let nextPlanMs = anchorMs
      /** いま取りに行っている秒。 */
      const inflight = new Set<number>()
      /** 失敗して試し直しを待っている秒（`attempts` はその秒を試した回数）。 */
      const waiting = new Map<number, { attempts: number; readyAtMs: number }>()
      /** 観測点リストを引き終わった版の識別子。 */
      let lastSitesKey: string | null = null
      /** いま引いている版の識別子（引き終わるまでのあいだ投げ直さないため）。 */
      let warmingSitesKey: string | null = null
      /**
       * これまでに渡したいちばん新しい秒。
       *
       * 試し直しを打ち切る根拠の**片方**に使う（もう片方は「再生時刻がその秒を過ぎたか」。
       * 両方が要る理由は `pump()` の打ち切りループに書いてある）。これ以前の秒は、再生時刻が
       * 過ぎていれば取れても消費側が捨てる（`useKyoshinRealtime` がデータ時刻の巻き戻りを
       * 破棄する）。
       */
      let lastEnqueuedMs = -Infinity
      /** 続けて諦めた秒の数。1 件でも取れたら 0 へ戻す。 */
      let consecutiveGiveUps = 0
      /** 取得が全滅し、先読みをやめて間隔を空けて様子を見ている状態か。 */
      let probing = false
      /** 次に探りを投げてよい実時刻。 */
      let probeAtMs = 0
      /** 探りが続けて失敗した回数。間隔を決める尺度（→ `replayProbeDelayMs`）。 */
      let probeAttempts = 0
      /**
       * いま投げている探りの秒。`null` なら投げていない。
       *
       * **探りへ移った時点で残っていた取得と区別するために持つ。** 区別せずに数えていた頃は、
       * そちらの決着が「探りの結果」として扱われ、探りの間隔と復帰時の記録の両方がずれた。
       */
      let probeTargetMs: number | null = null
      /** 探りへ移った時点の再生秒。復帰したときに読み飛ばした秒数を出すため。 */
      let probingFromMs = 0
      /**
       * 探りへ移った回数（累積）。
       *
       * 突入・復帰の記録は間引くので、**繰り返しをそこから読めるように**添える。断続的な
       * 劣化では「10 件諦める → 1 件取れる」を往復するため、間引いた記録だけでは 1 回目と
       * 20 回目が見分けられない。
       */
      let probingEpisodes = 0
      /** 更新停止を通知済みか。同じ障害で何度も通知しないため。 */
      let stalledNotified = false

      const notifyStalled = createStalledNotifier(sink, reportHandoffError)

      /**
       * 観測点リストを先に引いておく。
       *
       * 消費側が引くのは**フレームを画面へ反映する時点**なので（`useKyoshinRealtime`）、
       * 版が変わった瞬間はその往復のあいだ `indices` と `sites` の識別子が揃わず、下流の
       * 検知が止まる。先読みならフレームが放出される前に引き終わる（`fetchSiteList` は
       * 同一 id を控えるので、消費側の呼び出しはそこへ当たる）。
       *
       * **引き終わってから「もう引いた」印を立てる。** 先に立てていた頃は、**その 1 回が
       * 失敗するとセッション中二度と引き直さなかった** —— 版はまれにしか変わらないので、
       * 事実上「先読みがこのセッションでは永久に効かない」に化ける。しかも
       * `.catch(() => {})` で握るため画面にも記録にも痕跡が残らなかった
       * （消費側が `currentSitesKeyRef` で同じ罠を名指しで警告している）。
       *
       * **「引き終わった版」と「いま引いている版」を分ける。** 印を成功後に立てる形にすると、
       * 引き終わるまでのあいだ毎フレーム投げ直すことになる（控えが同じ Promise を返すので
       * 実害は無いが、意図していない）。
       *
       * **失敗そのものは握ってよい。** 控えは失敗した Promise を残さないので消費側が引き直し、
       * 観測点座標の解決は最終的に成立する（失うのは先読みの効きだけ）。ただし黙らせない ——
       * 先読みが効かない理由はここにしか残らないので、間引いて記録する。
       *
       * **同期で投げる場合まで囲う。** ここは `launch` の成功経路から呼ばれるので、投げると
       * **フレームの受け渡しと `pump()` まで巻き添えで止まる**（先読みという脇の処理が本筋を
       * 殺す）。実際にそうなった —— `fetchSiteList` が Promise を返さない状況で、そのセッションの
       * 取得が丸ごと沈黙した。
       */
      const warmSiteList = (sitesKey: string) => {
        if (!sitesKey || sitesKey === lastSitesKey || sitesKey === warmingSitesKey) return
        warmingSitesKey = sitesKey
        // **「いま引いている版」を消すのは、それが自分の分のときだけ。** 版が A → B と続けて
        // 変わると、A の結果が返った時点で印は既に B になっている。無条件に消していた頃は
        // **B の警戒を A が解いてしまい**、次のフレームで B をもう一度引きに行けた。
        const clearWarming = () => { if (warmingSitesKey === sitesKey) warmingSitesKey = null }
        const onFailure = (err: unknown) => {
          clearWarming()
          if (!active) return
          throttledSiteListWarm(() => log.warn(
            `[kyoshinSource] 観測点リスト（${sitesKey}）の先読みに失敗（消費側が引き直す）`, err,
          ))
        }
        try {
          void fetchSiteList(sitesKey).then(
            () => { lastSitesKey = sitesKey; clearWarming() },
            onFailure,
          )
        } catch (err) {
          onFailure(err)
        }
      }

      /**
       * 取れたフレームを渡す。
       *
       * **復帰の通知とフレームの受け渡しを同じ try へ入れない。** 同じ try だった頃は、
       * 復帰の通知が投げた回に**取れていたフレームが丸ごと落ちた**（記録は残るが、
       * そのフレームを取り直す手段は無い）。
       */
      const handoff = (targetMs: number, rt: RealtimeIntensity) => {
        if (stalledNotified && notifyStalled(false)) stalledNotified = false
        try {
          sink.enqueue({
            time: new Date(targetMs),
            dataTime: rt.dataTime,
            sitesKey: rt.siteConfigId,
            indices: rt.indices,
            hypoInfo: rt.hypoInfo,
          })
          lastEnqueuedMs = Math.max(lastEnqueuedMs, targetMs)
        } catch (err) {
          reportHandoffError('[kyoshinSource] フレーム受け渡し中の例外（取得の失敗とは別）', err)
        }
      }

      /**
       * 更新停止を伝える。**まだ伝えていないときだけ試し、渡せたときだけ記録も出す。**
       *
       * **通知に成功した箇所を 1 つへ集める。** 伝える機会は 2 つある（探りへ移る瞬間と、
       * 探りが外れるたび）。別々に書いていた頃は、**突入の 1 回だけ失敗して次の探りで
       * 成功したとき、記録がどこにも出なかった**（画面には出るのにログに何も残らない）。
       *
       * @param droppedWaiting 探りへ移るときに捨てた試し直しの列の件数（探りの途中では 0）
       */
      const announceStalled = (targetMs: number, droppedWaiting: number) => {
        if (stalledNotified || !notifyStalled(true)) return
        stalledNotified = true
        throttledProbeEnter(() => log.warn(
          `[kyoshinSource] ${consecutiveGiveUps} 秒続けて取得できず → 更新停止として通知し、`
          + `間隔を空けて様子を見る（データ時刻 ${new Date(targetMs).toISOString()} 付近・`
          + `${probingEpisodes} 回目`
          + (droppedWaiting > 0 ? `・試し直し待ちだった ${droppedWaiting} 秒は捨てた）` : '）'),
        ))
      }

      /**
       * その秒を諦める。
       *
       * 続けて諦めた数が上限に達したら先読みをやめ、間隔を空けた探りへ移る
       * （→ `REPLAY_MAX_CONSECUTIVE_GIVEUPS`）。**止めはしない** —— ここは「収録の無い
       * 時代を指定した」と「収録期間内での長い欠測」を区別できないので、止める作りにすると
       * 後者でもそのリプレイセッションが終わるまで二度と取りに行かなくなる。
       */
      const giveUp = (targetMs: number, err: unknown) => {
        consecutiveGiveUps += 1
        throttledGiveUp(() => log.warn(
          `[kyoshinSource] 秒ファイルを取れずに諦めた（データ時刻 ${new Date(targetMs).toISOString()}`
          + ` 付近・続けて ${consecutiveGiveUps} 件）`, err,
        ))
        if (consecutiveGiveUps < REPLAY_MAX_CONSECUTIVE_GIVEUPS) return
        probing = true
        // **捨てる列の件数を残す。** ここで消えるのは「諦めた 1 秒」だけではなく、**まだ
        // 1〜3 回目の試し直しを待っていた秒**も含む。`nextPlanMs` は前へしか進まないので、
        // 消えた秒は**二度と計画されない** —— 件数を出さないと、その欠落がどこにも残らない
        // （復帰時に出す「読み飛ばした秒数」は探りのあいだの量なので、これは含まない）。
        const droppedWaiting = waiting.size
        waiting.clear()
        // 探りの回数は先読みの失敗と別に数え直す（理由は `replayProbeDelayMs`）。
        probeAttempts = 0
        probeTargetMs = null
        probeAtMs = Date.now() + replayProbeDelayMs(probeAttempts)
        probingEpisodes += 1
        // **起点は「探りへ移った時点の再生秒」。** 諦めた秒（`targetMs`）を起点にしていた頃は、
        // 並列で取っているせいで諦めの発生順が時刻順にならず、復帰時に出す「読み飛ばした秒数」が
        // 前後どちらへもぶれた。再生時刻なら、探りのあいだ取りに行かなかった量をそのまま表す。
        probingFromMs = alignToGrid(replayNowMs())
        announceStalled(targetMs, droppedWaiting)
      }

      const launch = (targetMs: number) => {
        inflight.add(targetMs)
        fetchRealtimeIntensity(new Date(targetMs), { cache: true })
          .then((rt) => {
            inflight.delete(targetMs)
            if (!active) return
            waiting.delete(targetMs)
            consecutiveGiveUps = 0
            if (probing) {
              // 取得が戻った。取れた秒の次から計画を組み直す（置いていかれた秒は追わない）。
              //
              // **読み飛ばした秒数を必ず出す。** 突入の 1 行しか残していなかった頃は、
              // 実際に何秒ぶんのフレームを永久に取らなかったかが記録から読めなかった
              // （障害の深刻さを後から追えない）。
              //
              // **ただし当たったのが探りとは限らない。** 探りへ移った時点で投げていた分
              // （最大 `REPLAY_PREFETCH_CONCURRENCY` 件）はそのまま残るので、そちらが後から
              // 成功して戻ることもある。その秒は探りの起点より**古い**ので、秒数の差は
              // 意味を持たない —— 0 へ丸めて「N 秒ぶん」と書くと**実際より少なく報告する**。
              const byProbe = targetMs === probeTargetMs
              probing = false
              probeAttempts = 0
              probeTargetMs = null
              const skipped = Math.round((targetMs - probingFromMs) / POLL_MS)
              const how = byProbe && skipped >= 0
                ? `この間の ${skipped} 秒ぶんは取りに行っていない`
                : '探りではなく残っていた取得が当たったので、読み飛ばした秒数は出せない'
              // 突入の記録と同じ理由で間引く（断続的な劣化で往復する）。
              throttledProbeLeave(() => log.warn(
                `[kyoshinSource] 取得が回復した（データ時刻 ${new Date(targetMs).toISOString()}・`
                + `${probingEpisodes} 回目のエピソード）。${how}`,
              ))
              nextPlanMs = Math.max(nextPlanMs, targetMs + POLL_MS)
            }
            // **本筋（フレームの受け渡しと次の計画）を先に通す。** 先読みは脇の処理なので、
            // 順番を逆にすると、そちらの不調が本筋を遅らせる余地を残す。
            handoff(targetMs, rt)
            warmSiteList(rt.siteConfigId)
            pump()
          })
          .catch((err) => {
            inflight.delete(targetMs)
            if (!active) return
            if (probing) {
              // **数えるのは探りの失敗だけ。** 探りへ移った時点で投げていた分（最大
              // `REPLAY_PREFETCH_CONCURRENCY` 件）も後から失敗して戻るが、それを混ぜると
              // **探り専用の尺度が探りでないものに汚される** —— 最初の探りが本来より遅く
              // 発火する（`replayProbeDelayMs` が分けている理由と同じ種類の混入）。
              if (targetMs === probeTargetMs) {
                probeAttempts += 1
                probeTargetMs = null
                probeAtMs = Date.now() + replayProbeDelayMs(probeAttempts)
              }
              // 突入時に通知を渡せていなかったら、探りが外れるたびに試し直す。**`giveUp` は
              // 探りのあいだ呼ばれない**ので、ここで拾わないとそのエピソードでは二度と
              // 伝えられない（画面が「更新が止まっている」を出さないまま沈黙する）。
              announceStalled(targetMs, 0)
              // **探りが外れたときも `pump()` を呼ぶ。** 「取得の完了時にも回す」という
              // この経路の約束を、探りの間だけ破って巡回任せにしない（間隔を延ばす変更が
              // 入ったときに、その依存に気づけない）。次の探りは `probeAtMs` が抑える。
              pump()
              return
            }
            const attempts = (waiting.get(targetMs)?.attempts ?? 0) + 1
            if (attempts >= REPLAY_MAX_ATTEMPTS_PER_TARGET) {
              waiting.delete(targetMs)
              giveUp(targetMs, err)
            } else {
              waiting.set(targetMs, { attempts, readyAtMs: Date.now() + replayRetryDelayMs(attempts) })
            }
            pump()
          })
      }

      /**
       * 試し直しの時刻が来た秒のうち、最も古いもの。
       *
       * **いま取りに行っている秒は返さない。** `waiting` のエントリは投げても残す
       * （`attempts` を数え続けるため）ので、除外しないと同じ秒を二重に投げる。
       */
      const pickReady = (realNowMs: number): number | null => {
        let best: number | null = null
        for (const [ms, st] of waiting) {
          if (st.readyAtMs > realNowMs || inflight.has(ms)) continue
          if (best === null || ms < best) best = ms
        }
        return best
      }

      /**
       * 先読みを 1 巡させる。取得の完了時にも呼ぶので、巡回（`REPLAY_PUMP_INTERVAL_MS`）は
       * 「何も返ってこないとき」の保険にあたる。
       */
      const pump = () => {
        if (!active) return
        const nowMs = replayNowMs()
        const realNowMs = Date.now()

        if (probing) {
          if (inflight.size === 0 && realNowMs >= probeAtMs) {
            // **探りで投げた秒を覚える。** 覚えないと、探りへ移った時点で残っていた取得の
            // 決着を「探りの結果」として数えてしまう（上の `launch` の両分岐で照合する）。
            probeTargetMs = alignToGrid(nowMs)
            launch(probeTargetMs)
          }
          return
        }

        // 取れても画面に出ない秒は、試し直しを打ち切る。
        //
        // **条件は 2 つの AND で、どちらか一方では足りない。**
        //
        //   `replayNowMs() > ms`     : 再生時刻がその秒を過ぎた（もう順番が来ている）
        //   `ms <= lastEnqueuedMs`   : より新しい秒を渡してある（消費側が巻き戻りとして捨てる）
        //
        // **「渡した最大の秒」だけで打ち切ってはいけない。** 先読みは常に再生時刻より先を
        // 取っているので、その値はほぼ常に前進している —— 片方だけで判定していた頃は、
        // 失敗した秒が 200ms の試し直し待ちのあいだに打ち切られ、**`REPLAY_MAX_ATTEMPTS_PER_TARGET`
        // 回の猶予を 1 度も使わずに捨てていた**（先読みで直したかった「一過性の失敗で秒が飛ぶ」が、
        // いちばん起きやすい単発の失敗にだけ効かない形で残っていた）。
        //
        // **「再生時刻が過ぎた」だけでも足りない。** 再生開始時の最初の秒（`anchorMs`）は
        // 常に再生時刻以下なので、それだけで判定すると開始直後に即座に捨てる。
        //
        // **これは「諦め」に数えない。** より新しい秒を渡せているなら取得は生きているので、
        // ここで `consecutiveGiveUps` を進めると**取得が成功しているのに探りへ移る**
        // （`REPLAY_MAX_CONSECUTIVE_GIVEUPS` が見ているのは「取れなくなったか」であって
        // 「フレームが欠けたか」ではない）。
        //
        // **いま取りに行っている秒は触らない。** `waiting` のエントリは投げても残す作りなので、
        // ここで消すと**結果が返ってきたときに試行回数が 1 から数え直される**（消えた直後に
        // 失敗した秒が、まだ猶予があるものとして列へ戻る）。返ってきた時点で `catch` 側が
        // 判定するので、待つだけでよい。
        for (const [ms] of waiting) {
          if (inflight.has(ms)) continue
          if (ms <= lastEnqueuedMs && nowMs > ms) {
            waiting.delete(ms)
            throttledStaleTarget(() => log.warn(
              `[kyoshinSource] 秒ファイルの取り直しを打ち切った（データ時刻`
              + ` ${new Date(ms).toISOString()} 付近・再生時刻が過ぎ、より新しい秒を先に渡してある）`,
            ))
          }
        }

        // 計画が再生時刻より後ろへ落ちたら、いまの秒へ飛ばす（置いていかれた秒は追わない）。
        const currentMs = alignToGrid(nowMs)
        if (nextPlanMs < currentMs) nextPlanMs = currentMs

        const horizonMs = nowMs + REPLAY_LEAD_MS
        while (inflight.size < REPLAY_PREFETCH_CONCURRENCY) {
          const retry = pickReady(realNowMs)
          if (retry !== null) {
            launch(retry)
            continue
          }
          if (nextPlanMs > horizonMs) break
          const planned = nextPlanMs
          nextPlanMs += POLL_MS
          // **同じ秒を二重に投げる余地は無い。** `nextPlanMs` は前へしか動かない（計画するたび
          // 1 秒進める・追いつきと探りの復帰も `Math.max` で前方のみ）ので、`waiting` や
          // `inflight` に居る秒は必ず**すでに通過した位置**にある。
          //
          // **この不変条件が崩れる変更を入れるなら、ここで衝突を弾くこと**（`inflight.has` /
          // `waiting.has` を見る）。`fetchRealtimeIntensity` は同時要求をまとめないので、
          // 二重に渡ったフレームはキューが「到来済みを飛ばした」件数として数え、実際には無い
          // 遅延が記録に出る。**一度その判定を足したが、発火する経路が無いので外した**
          // （死んだ守りを残すと、次に読む人が「守られている」と誤解する）。
          launch(planned)
        }
      }

      pumpTimer = setInterval(pump, REPLAY_PUMP_INTERVAL_MS)
      pump()
    },

    stop() {
      active = false
      if (pumpTimer !== null) {
        clearInterval(pumpTimer)
        pumpTimer = null
      }
    },

    resolveSites(sitesKey) {
      return fetchSiteList(sitesKey)
    },
  }
}
