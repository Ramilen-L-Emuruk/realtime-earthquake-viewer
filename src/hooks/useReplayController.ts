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
import { fetchDmdataReplayEvents, filterPreWindowEvents, clearReplayCache } from '../services/dmdataReplay'
import type { ReplayEntry } from '../services/dmdataReplay'
import { serverNow, serverDate } from '../utils/clock'
import { log } from '../utils/logger'

/** 本編として先に読み込む長さ（リプレイ開始時刻から先）。 */
const WINDOW_MS = 3600_000
/** 初期状態の再現に使う遡り幅。 */
const PRE_WINDOW_MS = 24 * 3600_000
/** 読み込み済みの終端がこれを切ったら次のウィンドウを先読みする。 */
const PREFETCH_MARGIN_MS = 10 * 60_000

export interface ReplayControllerDeps {
  apiKey: string
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
}

export function createEmptyLoss(): ReplayLoss {
  return { skippedTelegrams: 0, failedArchives: new Set() }
}

/** 取得結果を損失に足し込む（URL は集合なので二重計上されない）。 */
export function addLoss(loss: ReplayLoss, skipped: number, failedArchiveUrls: string[]): ReplayLoss {
  const failedArchives = new Set(loss.failedArchives)
  for (const url of failedArchiveUrls) failedArchives.add(url)
  return { skippedTelegrams: loss.skippedTelegrams + skipped, failedArchives }
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
  if (parts.length === 0) return null
  return `${parts.join('・')}を取り込めませんでした（再生は継続中。詳細はコンソール）`
}

export function useReplayController(deps: ReplayControllerDeps): ReplayController {
  // start/stop の内側は depsRef 経由で最新の deps を読む（下記参照）。
  // ここで取り出すのは、effect の依存として直接必要なものだけ。
  const { apiKey, timeOffset } = deps

  const [isFetching, setIsFetching] = useState(false)
  // 回復しうる失敗（取得エラー）。次の取得が成功したら消してよい。
  const [fetchError, setFetchError] = useState<string | null>(null)
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
  // apiKey だけは start 内（depsRef 経由）と先読み effect（上の分割代入を直接参照し依存配列にも記載）で
  // 参照経路が違うが、これは意図的。コールバックは「呼ばれた時点の最新」でよいのに対し、
  // effect は値が変わったら再評価される必要がある（依存配列に入れないと古いキーで先読みし続ける）。
  // 片方に揃えると、start が古いキーを掴むか、effect がキー変更に反応しなくなる。
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
    clearReplayCache()
    d.setTimeOffset(offset)
    prefetchEndRef.current = toTime
    setIsFetching(true)
    setFetchError(null)
    // 新しいセッションなので損失も数え直す
    setLoss(createEmptyLoss())

    try {
      // 本編と初期状態を同時に取る。どちらかが失敗したらリプレイ全体を中止する
      // （初期状態が欠けたまま再生すると、地震が起きていない状態から始まって
      //   実際の状況と食い違うため）。どちらで失敗したかはメッセージに含める。
      const [normal, pre] = await Promise.all([
        fetchDmdataReplayEvents(d.apiKey, targetDate, toTime).catch((e) => {
          throw new Error(`本編（${fmt(targetDate)} 以降）の取得に失敗: ${msgOf(e)}`)
        }),
        fetchDmdataReplayEvents(d.apiKey, preFrom, targetDate).catch((e) => {
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
      setFetchError(msgOf(e))
      // 「再生中」表示が残ると赤字と矛盾するため、オフセットと先読み位置も巻き戻す。
      d.setTimeOffset(null)
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
    clearReplayCache()
    setFetchError(null)
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
    fetchDmdataReplayEvents(apiKey, nextFrom, nextTo)
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
        // 先読み失敗は再生を止めないが、以後電文が来なくなるため理由を出す。
        // 「再生中」のまま出るので、止まったと誤読されないよう状況も添える。
        setFetchError(`先読みに失敗したため、以後の電文が届きません: ${msgOf(e)}`)
      })
      .finally(() => {
        if (guard.isCurrent(session)) setIsFetching(false)
      })
  }, [replayCurrentTime, timeOffset, isFetching, apiKey])

  // 取得エラーと確定した損失は別の事実なので、両方あるなら両方出す。
  // 片方を優先して隠すと「先読みが失敗した」表示の裏で、既に確定していた
  // 取りこぼしがいったん画面から消え、後で復活するという分かりにくい挙動になる。
  // エラーを先に置くのは、再生が止まっているか以後の電文が届かない状態を示すため。
  const error = [fetchError, formatLossNotice(loss)].filter(Boolean).join(' / ') || null

  return { isFetching, error, start, stop }
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function fmt(d: Date): string {
  return d.toLocaleString('ja-JP')
}
