// DMDATA archive リプレイの制御。
//
// App.tsx から切り出している理由は 2 つある。
// 1. ここは「取得は中断できないが、ユーザーはいつでも停止・再開できる」という非同期の
//    状態機械で、完了順序に依存した判断（世代照合）が要る。App 本体に混ざっていると
//    どの state 更新が照合の後ろにあるべきか目視でしか確認できない。
// 2. 単体でテストできるようにするため。実際、以前は実機のブラウザ確認でしか
//    不具合を検出できなかった。
//
// 時計の制御（setReplayOffset）は呼び出し側（App）の責務として残している。リプレイ中の
// 「現在時刻」はアプリ全体の広範囲に効くため、この Hook の内側に隠すと影響範囲が見えにくくなる。

import { useCallback, useEffect, useRef, useState } from 'react'
import { filterPreWindowEvents } from '../services/dmdataReplay'
import { MAX_HISTORY_RETAINED } from './useEarthquakes'
import type { ReplayEntry, ReplayFetchResult, QuakeHistoryResult } from '../types/replay'
import type { JMAQuake } from '../types/earthquake'
import { serverNow, serverDate } from '../utils/clock'
import { log } from '../utils/logger'

// この 3 つを公開しているのは、結線テストが取得の日付範囲と「先読みが走る/走らない」境界を
// これらから組み立てるため。テスト側で値を複製すると、しきい値を広げたときにテストは
// 通り続けるのに境界を試さなくなる（黙って劣化する）。
/** 本編として先に読み込む長さ（リプレイ開始時刻から先）。 */
export const WINDOW_MS = 3600_000
/** 初期状態の再現に使う遡り幅。 */
export const PRE_WINDOW_MS = 24 * 3600_000
/** 読み込み済みの終端がこれを切ったら次のウィンドウを先読みする。 */
export const PREFETCH_MARGIN_MS = 10 * 60_000

/**
 * 地震カードの履歴として集めるイベント数。
 *
 * ライブ接続時の初回履歴と同じ枚数にする。初期状態の 24 時間だけでカードを作ると、地震の
 * 少ない日は一覧が数枚しか並ばず、ライブと見え方が大きく変わる（実測では 1 日あたり 4〜21 件）。
 *
 * 値を書かずライブ側から取るのは、同じ意図の数を 2 箇所に置かないため。コメントで結ぶだけだと、
 * 片方を動かしたときに型検査もテストも黙って通る。
 */
export const QUAKE_HISTORY_EVENTS = MAX_HISTORY_RETAINED
/**
 * 履歴のために遡ってよい日数の上限（DMDSS 版のアーカイブ経路のみ）。
 *
 * 上の件数に届かなくてもここで打ち切る。地震活動が極端に少ない期間で延々と過去を掘らないため。
 */
export const QUAKE_HISTORY_MAX_DAYS = 7

export interface ReplayControllerDeps {
  /**
   * 指定範囲の電文を取得する。バリアントごとの取得元をここで差し替える
   * （DMDSS 版は DMDATA アーカイブ、standard 版は P2PQuake の日付指定クエリ）。
   */
  fetchEvents: (fromTime: Date, toTime: Date) => Promise<ReplayFetchResult>
  /**
   * 地震カードの履歴を取得する（再生開始時刻より前に発表された電文）。
   *
   * 再生される電文の取得（`fetchEvents`）とは目的が別で、こちらはカードの一覧を
   * ライブ接続時と同じ厚みにするためだけに使う。取得元はバリアントで差し替える。
   */
  fetchQuakeHistory: (before: Date, targetEvents: number, maxDays: number) => Promise<QuakeHistoryResult>
  /** 取得した履歴をカード一覧へ反映する。 */
  restoreQuakeHistory: (quakes: JMAQuake[]) => void
  /** 取得キャッシュを破棄する（開始・停止のたびに呼ぶ）。 */
  clearCache: () => void
  /** リプレイ時刻のオフセットを適用する（null で解除）。App 側で時計と state に反映する。 */
  setTimeOffset: (offsetMs: number | null) => void
  /** 現在のオフセット。null ならリプレイしていない。 */
  timeOffset: number | null
  /** 表示中の地震・津波・EEW をすべて捨てる。 */
  resetState: () => void
  /** 音・通知の重複判定に使う追跡 ref を初期化する。 */
  resetTracking: () => void
  /** pre-window の電文から T 時点の追跡 ref を復元する。 */
  restorePreWindowTracking: (entries: ReplayEntry[]) => void
  /** 取得した電文を再生キューへ積む。 */
  loadReplayEvents: (entries: ReplayEntry[]) => void
}

export interface ReplayController {
  isFetching: boolean
  /** UI に赤字で出すメッセージ（null = 異常なし）。 */
  error: string | null
  start: (targetDate: Date) => Promise<void>
  stop: () => void
}

/**
 * 「いま自分が現役のセッションか」を判定するための世代カウンタ。
 *
 * アーカイブ取得は中断できないため、停止・再開をまたいで古い取得が後から完了する。
 * その結果を受け取ってよいかを判定する責務だけをここに閉じ込め、単体で検証できるようにする。
 */
export interface SessionGuard {
  /** 新しいセッションを始め、その世代番号を返す。 */
  begin: () => number
  /** 現在の世代番号を読む（新しく始めない。先読みのように既存セッションに属する処理で使う）。 */
  current: () => number
  /** 世代番号が現役かどうか。false なら結果を捨てる。 */
  isCurrent: (session: number) => boolean
  /** 進行中のセッションをすべて無効化する（停止時に使う）。 */
  invalidate: () => void
}

export function createSessionGuard(): SessionGuard {
  let generation = 0
  return {
    begin: () => ++generation,
    current: () => generation,
    isCurrent: (session) => generation === session,
    invalidate: () => { generation++ },
  }
}

/**
 * このセッションで取りこぼした総量。再生を止めるまで積み上げる。
 *
 * 一度失われた電文は後続の取得が成功しても戻らない。回復しうる一過性のエラーと違い、
 * 確定した事実なので、成功で上書きして消してはいけない。
 */
export interface ReplayLoss {
  skippedTelegrams: number
  /** 読めなかったアーカイブの URL。同じアーカイブを複数回読むため集合で持つ。 */
  failedArchives: Set<string>
  /**
   * 先読みに失敗した区間の数。
   *
   * 先読みは取得を始める前に「ここまで読んだ」印（prefetchEnd）を先へ進めるため、失敗しても
   * その区間を読み直さない。読み直す作りにすると、恒久的な失敗（レート制限・認証切れ）のときに
   * 同じ区間へ延々と再要求を投げ続けることになるため、あえて進めたままにしている。
   * 代わりに欠けた事実をここへ確定として残す（後続の先読みが成功しても消さない）。
   */
  failedPrefetches: number
}

export function createEmptyLoss(): ReplayLoss {
  return { skippedTelegrams: 0, failedArchives: new Set(), failedPrefetches: 0 }
}

/** 取得結果を損失に足し込む（URL は集合なので二重計上されない）。 */
export function addLoss(loss: ReplayLoss, skipped: number, failedArchiveUrls: string[]): ReplayLoss {
  const failedArchives = new Set(loss.failedArchives)
  for (const url of failedArchiveUrls) failedArchives.add(url)
  return { ...loss, skippedTelegrams: loss.skippedTelegrams + skipped, failedArchives }
}

/** 先読み 1 区間ぶんの失敗を損失に足し込む。 */
export function addFailedPrefetch(loss: ReplayLoss): ReplayLoss {
  return { ...loss, failedPrefetches: loss.failedPrefetches + 1 }
}

/**
 * 損失から UI 用のメッセージを組み立てる。何も欠けていなければ null。
 *
 * アーカイブ単位の失敗（丸ごと読めなかった日）と電文単位の失敗（1 通ずつの破損）は
 * 粒度が違うので分けて数える。前者は「その日の電文が何通あったか」すら分からないため、
 * 電文数に合算できない。
 *
 * 「再生は継続中」を必ず添えるのは、これが失敗通知と同じ赤字で出るため。
 * 添えないと再生が止まったと誤読される。
 */
export function formatLossNotice(loss: ReplayLoss): string | null {
  const parts: string[] = []
  if (loss.failedArchives.size > 0) parts.push(`${loss.failedArchives.size} 件のアーカイブ`)
  if (loss.skippedTelegrams > 0) parts.push(`${loss.skippedTelegrams} 件の電文`)
  if (loss.failedPrefetches > 0) parts.push(`${loss.failedPrefetches} 区間ぶんの先読み`)
  if (parts.length === 0) return null
  return `${parts.join('・')}を取り込めませんでした（再生は継続中。詳細はコンソール）`
}

export function useReplayController(deps: ReplayControllerDeps): ReplayController {
  // start/stop の内側は depsRef 経由で最新の deps を読む（下記参照）。
  // ここで取り出すのは、effect の依存として直接必要なものだけ。
  const { fetchEvents, timeOffset } = deps

  const [isFetching, setIsFetching] = useState(false)
  // 回復しうる失敗（取得エラー）。次の取得が成功したら消してよい。
  const [fetchError, setFetchError] = useState<string | null>(null)
  // 履歴の復元だけが失敗した場合の理由。再生は続くので取得エラーとは分けて持つ
  // （片方の成功でもう片方の表示を消さないようにする）。
  const [historyError, setHistoryError] = useState<string | null>(null)
  // 確定した損失。取り込めなかった電文は後続の取得が成功しても戻らないので、
  // 停止するまで積み上げたまま表示し続ける。
  const [loss, setLoss] = useState<ReplayLoss>(createEmptyLoss)
  /** 先読み済みの終端時刻。 */
  const prefetchEndRef = useRef<Date | null>(null)
  // 世代照合。開始・停止のたびに世代を進め、非同期の完了時に現役かどうかを照合する。
  // これが無いと「停止 → 別の日で再開」した直後に、前の日の電文が後から注入されたり、
  // 古い側の finally が新しい取得中の表示を消したりする。
  const guardRef = useRef<SessionGuard | null>(null)
  guardRef.current ??= createSessionGuard()
  const guard = guardRef.current

  // deps は毎レンダー変わり得るため ref 経由で最新を参照する。これをしないと
  // start/stop の参照が毎レンダー変わり、これらを props で受け取る側の memo が効かなくなる。
  //
  // fetchEvents だけは start 内（depsRef 経由）と先読み effect（上の分割代入を直接参照し依存配列にも記載）で
  // 参照経路が違うが、これは意図的。コールバックは「呼ばれた時点の最新」でよいのに対し、
  // effect は値が変わったら再評価される必要がある（依存配列に入れないと、API キーを直した後も
  // 古い取得関数で先読みし続ける）。片方に揃えると、start が古い関数を掴むか、
  // effect が差し替えに反応しなくなる。
  const depsRef = useRef(deps)
  depsRef.current = deps

  const start = useCallback(async (targetDate: Date) => {
    log.info(`[replay] リプレイ開始 targetDate=${targetDate.toISOString()}`)
    const session = guard.begin()
    const d = depsRef.current
    const offset = targetDate.getTime() - Date.now()
    const toTime = new Date(targetDate.getTime() + WINDOW_MS)
    const preFrom = new Date(targetDate.getTime() - PRE_WINDOW_MS)

    d.resetState()
    d.resetTracking()
    d.clearCache()
    d.setTimeOffset(offset)
    prefetchEndRef.current = toTime
    setIsFetching(true)
    setFetchError(null)
    setHistoryError(null)
    // 新しいセッションなので損失も数え直す
    setLoss(createEmptyLoss())

    // 地震カードの履歴。本編・初期状態とは切り離して走らせる。
    // - 失敗しても再生は成立する（一覧が薄くなるだけ）ので、Promise.all に混ぜて
    //   リプレイ全体を中止させない
    // - await しないのは、履歴が揃うまで再生開始を待たせないため。復元は後から届いても
    //   既存カードへ統合される（`restoreQuakeHistory` 参照）
    void d.fetchQuakeHistory(targetDate, QUAKE_HISTORY_EVENTS, QUAKE_HISTORY_MAX_DAYS)
      .then((result) => {
        if (!guard.isCurrent(session)) {
          log.info('[replay] 履歴の取得完了時に別セッションへ切り替わっていたため結果を破棄')
          return
        }
        depsRef.current.restoreQuakeHistory(result.quakes)
        // 取りこぼしは本編・初期状態と同じ枠で申告する。履歴は初期状態と日付範囲が重なるため、
        // 同じ電文の破損を二重に数えることがある（アーカイブ単位は URL の集合で重複が除かれる）。
        // 少なく見せて「静かな時間帯だった」と誤読されるより、多めに申告する側へ倒す。
        setLoss(prev => addLoss(prev, result.skipped, result.failedArchiveUrls))
      })
      .catch((e) => {
        log.error('[replay] 地震カードの履歴取得に失敗', e)
        if (!guard.isCurrent(session)) {
          log.info('[replay] 履歴の取得失敗時に別セッションへ切り替わっていたためエラー表示を抑制')
          return
        }
        setHistoryError(`地震カードの履歴を復元できませんでした（再生開始より前の地震が一覧に出ません。再生は継続中）: ${msgOf(e)}`)
      })

    try {
      // 本編と初期状態を同時に取る。どちらかが失敗したらリプレイ全体を中止する
      // （初期状態が欠けたまま再生すると、地震が起きていない状態から始まって
      //   実際の状況と食い違うため）。どちらで失敗したかはメッセージに含める。
      const [normal, pre] = await Promise.all([
        d.fetchEvents(targetDate, toTime).catch((e) => {
          throw new Error(`本編（${fmt(targetDate)} 以降）の取得に失敗: ${msgOf(e)}`)
        }),
        d.fetchEvents(preFrom, targetDate).catch((e) => {
          throw new Error(`初期状態（過去 24 時間）の取得に失敗: ${msgOf(e)}`)
        }),
      ])

      // 取得中に停止・別日での再開が行われていたら、この結果は捨てる（以降の
      // resetTracking や loadReplayEvents が新しいセッションの状態を壊すため、
      // state には一切触れない）。
      if (!guard.isCurrent(session)) {
        log.info('[replay] 取得完了時に別セッションへ切り替わっていたため結果を破棄')
        return
      }

      // pre-window: T 時点で有効な電文を即時発火（replayTime = T-1ms）させて初期状態を再現する
      const preFiltered = filterPreWindowEvents(pre.entries, targetDate)
        .map(e => ({ ...e, replayTime: new Date(targetDate.getTime() - 1), silent: true }))
      // フェッチ中に WS 切断タイミングで ref が再セットされる競合を排除するため直前に再リセット
      d.resetTracking()
      // pre-window イベントから T 時点の追跡 ref を復元する（サイレント注入後の正確な音判定に必要）
      d.restorePreWindowTracking(preFiltered)

      d.loadReplayEvents([...preFiltered, ...normal.entries])

      // 取りこぼしがあれば、再生は始まっていても必ず知らせる。黙って減った電文は
      // 「そういう時間帯だった」と見分けが付かず、テスト結果の誤読につながる。
      // 本編と初期状態は日付範囲が重なり同じアーカイブを読むため、URL の集合で重複を除く。
      setLoss(prev => addLoss(
        addLoss(prev, normal.skipped, normal.failedArchiveUrls),
        pre.skipped, pre.failedArchiveUrls,
      ))
    } catch (e) {
      log.error('[replay] リプレイデータ取得失敗', e)
      // 既に別セッションへ移っていれば、そちらのエラー表示や再生を上書きしない。
      if (!guard.isCurrent(session)) {
        log.info('[replay] 取得失敗時に別セッションへ切り替わっていたためエラー表示を抑制')
        return
      }
      // 地震電文が取れなくても**強震モニタのリプレイは成立する**ため、時刻オフセットは戻さない。
      // 強震モニタの供給元は `timeOffset != null` だけで過去フレームへ切り替わる別経路
      // （`useKyoshinRealtime` → `createYahooArchiveSource`）で、DMDATA のアーカイブには依存しない。
      // 以前はここで巻き戻していたため、DMDATA の API キーが無い環境では**強震モニタの検証すら
      // できなかった**（実例: `Archive list failed: 401` で再生が始まらない）。
      // 「再生中」と赤字が並ぶ矛盾は、設定タブが `replayStartLabel` の有無で見出しを
      // 「再生中の警告」と「取得失敗」に出し分けることで既に解消されている。
      // 先読み位置だけは畳む（アーカイブが読めない以上、続きを取りに行っても同じ失敗を繰り返す）。
      setFetchError(`${msgOf(e)}（地震・津波の電文は再生されません。強震モニタの再生は継続します）`)
      prefetchEndRef.current = null
    } finally {
      // 新しいセッションが進行中なら、その「取得中...」表示を古い側が消してはいけない。
      if (guard.isCurrent(session)) setIsFetching(false)
    }
  }, [])

  const stop = useCallback(() => {
    // 世代を進めて、進行中の取得（本編・先読みとも）の結果を無効化する。
    guard.invalidate()
    const d = depsRef.current
    d.setTimeOffset(null)
    prefetchEndRef.current = null
    d.resetState()
    d.resetTracking()
    d.clearCache()
    setFetchError(null)
    setHistoryError(null)
    // 損失は「このセッションで失われた量」なので、停止と同時に数え直す。
    setLoss(createEmptyLoss())
    // 取得中に停止された場合、上で世代を進めたことで取得側の finally は false にしない。
    // ここで戻さないと「取得中...」のまま確定ボタンが押せなくなる。
    setIsFetching(false)
  }, [])

  // 再生時刻が prefetchEnd - 10 分に近づいたら次の 1 時間を先読みする。
  // replayCurrentTime は毎レンダー新しい Date になるため、この effect は毎レンダー走る。
  const replayCurrentTime = timeOffset !== null ? serverDate() : null
  useEffect(() => {
    if (timeOffset === null || isFetching || !prefetchEndRef.current) return
    if (prefetchEndRef.current.getTime() - serverNow() > PREFETCH_MARGIN_MS) return

    const nextFrom = prefetchEndRef.current
    const nextTo = new Date(nextFrom.getTime() + WINDOW_MS)
    prefetchEndRef.current = nextTo
    setIsFetching(true)
    // 先読みも本編と同じく中断できないため、完了時に世代を照合する。
    const session = guard.current()
    fetchEvents(nextFrom, nextTo)
      .then((result) => {
        if (!guard.isCurrent(session)) {
          log.info('[replay] 先読み完了時に別セッションへ切り替わっていたため結果を破棄')
          return
        }
        depsRef.current.loadReplayEvents(result.entries)
        // 取得自体は通ったので、一過性のエラー表示は消してよい（残ったままだと
        // 「まだ失敗中」と誤認される）。ただし確定した損失はここでは消さない。
        setFetchError(null)
        setLoss(prev => addLoss(prev, result.skipped, result.failedArchiveUrls))
      })
      .catch((e) => {
        log.error('[replay] 先読み取得失敗', e)
        if (!guard.isCurrent(session)) {
          log.info('[replay] 先読み失敗時に別セッションへ切り替わっていたためエラー表示を抑制')
          return
        }
        // 失敗した区間は読み直さない（理由は ReplayLoss.failedPrefetches の注記）。欠けた事実は
        // 損失として確定させ、次の先読みが成功しても消えないようにする。原因の文言は回復しうる
        // 情報なので fetchError 側に出す（次の成功で消えてよい）。
        setLoss(addFailedPrefetch)
        setFetchError(`先読みに失敗しました。${fmt(nextFrom)} からの 1 時間ぶんは再生されません: ${msgOf(e)}`)
      })
      .finally(() => {
        if (guard.isCurrent(session)) setIsFetching(false)
      })
  }, [replayCurrentTime, timeOffset, isFetching, fetchEvents])

  // 取得エラー・履歴の失敗・確定した損失はそれぞれ別の事実なので、あるものは全部出す。
  // 片方を優先して隠すと「先読みが失敗した」表示の裏で、既に確定していた
  // 取りこぼしがいったん画面から消え、後で復活するという分かりにくい挙動になる。
  // 取得エラーを先に置くのは、再生が止まっているか以後の電文が届かない状態を示すため
  //（履歴の失敗はカードの一覧が薄くなるだけで、再生そのものには影響しない）。
  const error = [fetchError, historyError, formatLossNotice(loss)].filter(Boolean).join(' / ') || null

  return { isFetching, error, start, stop }
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function fmt(d: Date): string {
  return d.toLocaleString('ja-JP')
}
