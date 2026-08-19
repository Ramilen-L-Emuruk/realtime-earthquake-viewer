import { useEffect, useRef, useState } from 'react'
import type { SiteCoords, YahooHypoInfoItem } from '../services/kyoshin'
import {
  createYahooLiveSource,
  createYahooArchiveSource,
  type KyoshinFrame,
} from '../services/kyoshinSource'
import { createFrameQueue } from '../utils/kyoshinFrameQueue'
import type { EEWAlert } from '../types/earthquake'
import { diffHypoInfoEvents, type HypoInfoPendingMissing } from '../utils/eew'
import { serverDate } from '../utils/clock'
import { createLogThrottle, log } from '../utils/logger'

export interface KyoshinRealtime {
  sites: SiteCoords
  indices: number[]
  dataTime: string
  /** sites がどの観測点集合（`KyoshinFrame.sitesKey`。Yahoo では `siteConfigId`）に属するか。
   *  検知エンジン側で「sites と indices が同じ観測点集合か」を判定するのに使う。 */
  sitesSiteConfigId: string | null
  /** indices が属する観測点集合の識別子（フレームごとに付いてくる値）。
   *  `sitesSiteConfigId` と一致しないフレームは、観測点リスト切替直後の一時的な
   *  「新 indices・旧 sites」状態のため、下流の検知エンジン等は処理をスキップする。 */
  indicesSiteConfigId: string | null
  /** 連続して取得に失敗し、更新が停止している場合 true */
  error: boolean
}

/**
 * データ時刻が未来のフレームを放出するための巡回間隔 (ms)。
 *
 * Yahoo の 2 つのソースは常に「すでに過ぎた時刻」のフレームを渡すため、実際の放出は投入時の
 * 同期ドレインで済み、この巡回は使われない。フレーム列をまとめて投入する供給元
 * （アーカイブ再生）を足したときに、時刻の到来で 1 件ずつ流すのがこの巡回の役目。
 */
const DRAIN_INTERVAL_MS = 100

/** 同種の失敗を記録し直す最小間隔 (ms)。1Hz で再発する失敗を間引きつつ、継続を見失わない幅。 */
const LOG_THROTTLE_MS = 60_000

interface UseKyoshinRealtimeOptions {
  /** EEW の新規発報・更新・解除を検知したときに呼ばれるコールバック。 */
  onEEWEvent?: (eew: EEWAlert) => void
  /** テスト用時刻オフセット (ms)。null/undefined で現在時刻を使用。 */
  timeOffset?: number | null
}

/**
 * 強震モニタのリアルタイム震度を画面へ供給するフック。
 *
 * 取得そのものは行わない。供給元（`services/kyoshinSource`）が渡してきたフレームを時刻順の
 * キュー（`utils/kyoshinFrameQueue`）で受け、データ時刻が来たものを state へ反映する。
 * この分離により、1 秒ずつ取りに行く Yahoo と、まとめて手に入るアーカイブを同じ経路に載せられる。
 *
 * `timeOffset` を渡すと過去を再生するソースへ切り替わる（現状は Yahoo が秒ファイルを保持して
 * いる期間のみ遡れる）。
 *
 * hypoInfo の差分検出により EEW 発報・更新・解除を onEEWEvent で通知する（Yahoo 固有）。
 */
export function useKyoshinRealtime(
  enabled: boolean,
  options?: UseKyoshinRealtimeOptions,
): KyoshinRealtime {
  const [sites, setSites] = useState<SiteCoords>([])
  const [indices, setIndices] = useState<number[]>([])
  const [dataTime, setDataTime] = useState('')
  const [sitesSiteConfigId, setSitesSiteConfigId] = useState<string | null>(null)
  const [indicesSiteConfigId, setIndicesSiteConfigId] = useState<string | null>(null)
  const [error, setError] = useState(false)
  // 現在 sites に反映済みの観測点集合の識別子（Yahoo では siteConfigId）。
  const currentSitesKeyRef = useRef<string | null>(null)
  const prevHypoInfoRef = useRef<YahooHypoInfoItem[]>([])
  // hypoInfo 消滅の連続検出回数（reportId ごと）。瞬間的な欠測を確定解除にしないための猶予状態。
  const pendingMissingRef = useRef<Map<string, HypoInfoPendingMissing>>(new Map())
  // コールバックを ref で保持し、放出処理のクロージャから安定参照する
  const onEEWEventRef = useRef(options?.onEEWEvent)
  onEEWEventRef.current = options?.onEEWEvent
  // timeOffset は deps に含めてエフェクトを再起動させるため、ref ではなく直接使う
  const timeOffset = options?.timeOffset ?? null

  useEffect(() => {
    if (!enabled) return
    let active = true
    setError(false)
    // ライブ/リプレイ切替（timeOffset 変化）でエフェクトが再起動したとき、旧セッションの
    // hypoInfo 追跡状態を持ち越さない。持ち越すと、切替直後に旧セッションのアイテムが
    // 「消滅」と誤判定され、猶予後に古い震源データの幽霊キャンセルイベントが発火してしまう。
    prevHypoInfoRef.current = []
    pendingMissingRef.current = new Map()

    const queue = createFrameQueue<KyoshinFrame>()
    const source = timeOffset != null
      ? createYahooArchiveSource(timeOffset)
      : createYahooLiveSource()

    // 直前に画面へ反映したフレームのデータ時刻。これ以前のフレームは捨てる（下記参照）。
    let lastAppliedTimeMs = -Infinity
    // どの失敗も毎フレーム再発しうるため、記録は種類ごとに間引く。一度きりにしないのは、
    // 継続している障害が「一度失敗して直った」ように見えるのを避けるため。
    const throttledStaleFrame = createLogThrottle(LOG_THROTTLE_MS)
    const throttledApplyError = createLogThrottle(LOG_THROTTLE_MS)
    const throttledSitesError = createLogThrottle(LOG_THROTTLE_MS)
    const throttledEEWError = createLogThrottle(LOG_THROTTLE_MS)

    const applyFrame = (frame: KyoshinFrame) => {
      // 反映は必ずデータ時刻の順に進める。キューからの取り出しは時刻順だが、供給側が時計の
      // 後退をまたぐと「前より古いデータ時刻」のフレームを積みうる（ライブの再試行が上限に
      // 達して現在時刻へ戻す経路は、進行方向を保証していない）。そのまま反映すると表示が
      // 巻き戻り、検知エンジンにも後退したデータ時刻が渡る。
      // 取得したその場で反映していた頃は順序が入れ替わる余地が無かったため、キューを挟んだ
      // ことで新しく必要になったガード。
      const frameMs = frame.time.getTime()
      if (frameMs <= lastAppliedTimeMs) {
        throttledStaleFrame(() => log.warn('[kyoshin] データ時刻が巻き戻ったフレームを破棄した'))
        return
      }
      lastAppliedTimeMs = frameMs

      setIndices(frame.indices)
      setDataTime(frame.dataTime)
      // indices が属する観測点集合を記録（下流で sites 側と突合する）。
      setIndicesSiteConfigId(frame.sitesKey)

      // 観測点集合が変わった場合のみ対応するリストを取得して反映する。
      // currentSitesKeyRef の更新は取得成功後に行う（失敗時に ref を先行更新していると、
      // 次のフレームで「同じ観測点集合」と判定されて再試行しなくなり、sites が旧いまま
      // 更新されず indices と長さ不整合になる。取得側も失敗した Promise をキャッシュから
      // 削除して再試行可能にしている）。
      if (frame.sitesKey && frame.sitesKey !== currentSitesKeyRef.current) {
        const nextKey = frame.sitesKey
        source.resolveSites(nextKey)
          .then((s) => {
            if (active) {
              currentSitesKeyRef.current = nextKey
              setSites(s)
              setSitesSiteConfigId(nextKey)
            }
          })
          .catch((err) => {
            // 失敗は次のフレームで再試行される（ref は据え置き）。恒久的に失敗し続けた場合に
            // 気付けるよう警告を残し続ける。無音で握り潰さない。
            // この失敗は「更新停止」の表示には出ない（震度と時刻は更新され続けるため）ので、
            // ログが唯一の観測手段になる。だから一度きりにはせず、間引きつつ出し続ける。
            throttledSitesError(() => log.warn(
              `[kyoshin] 観測点リスト（${nextKey}）の取得に失敗（次のフレームで再試行）`, err,
            ))
          })
      }

      const hypoInfo = frame.hypoInfo ?? []
      const onEEW = onEEWEventRef.current
      if (onEEW) {
        const { events, pendingMissing } = diffHypoInfoEvents(
          prevHypoInfoRef.current,
          hypoInfo,
          pendingMissingRef.current,
        )
        pendingMissingRef.current = pendingMissing
        // 差分の基準は配信の前に進める。進めずに抜けると、通知側の一時的な失敗のたびに同じ
        // 発報が再送され、音と通知が二重に出る。
        prevHypoInfoRef.current = hypoInfo
        // 失敗はこのフレームぶんをまとめて 1 行に残す。1 件ずつ間引くと、同じフレーム内で
        // 起きた 2 件目以降の失敗が同一時刻ゆえに間引かれて消えてしまう。
        const failures: { eventId: string; err: unknown }[] = []
        for (const ev of events) {
          // 1 件の通知が例外を投げても残りの配信は続ける。ここで打ち切ると、上で基準を
          // 進めているぶん未配信のイベントが恒久的に失われる（1 つのフレームで新規発報と
          // 別の速報の解除が同時に起きるため、これは「警報が鳴らない」に直結する）。
          try {
            onEEW(ev)
          } catch (err) {
            failures.push({ eventId: ev.issue?.eventId ?? ev.id, err })
          }
        }
        if (failures.length > 0) {
          throttledEEWError(() => log.error(
            `[kyoshin] 緊急地震速報の通知中に例外（${failures.length} 件。残りの通知は継続した）`,
            failures,
          ))
        }
      } else {
        // onEEWEvent が無い場合も基準は進める。後から有効化されたときに、溜まった差分を
        // 一度に流さないため。
        prevHypoInfoRef.current = hypoInfo
      }
    }

    const drain = () => {
      if (!active) return
      const frame = queue.drainLatest(serverDate())
      if (frame === null) return
      try {
        applyFrame(frame)
      } catch (err) {
        // 反映処理の中のバグを取得失敗と混同しないよう隔離する。次のフレームで再試行される。
        throttledApplyError(() => log.error(
          '[kyoshin] フレーム反映中の例外（ローカルバグ・取得の失敗とは別）', err,
        ))
      }
    }

    source.start({
      enqueue: (frame) => {
        queue.enqueue(frame)
        // Yahoo のフレームは常にデータ時刻が過去なので、ここで即座に放出される。
        // 巡回（DRAIN_INTERVAL_MS）を待たせないことで、従来と同じ即時性を保つ。
        drain()
      },
      setStalled: (stalled) => {
        if (active) setError(stalled)
      },
    })

    // データ時刻がまだ来ていないフレームを、時刻の到来で放出するための巡回。
    const drainTimer = setInterval(drain, DRAIN_INTERVAL_MS)

    return () => {
      active = false
      clearInterval(drainTimer)
      source.stop()
      queue.clear()
    }
  }, [enabled, timeOffset])

  return { sites, indices, dataTime, sitesSiteConfigId, indicesSiteConfigId, error }
}
