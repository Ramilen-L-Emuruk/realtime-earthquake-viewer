import { useEffect, useRef, useState } from 'react'
import {
  fetchSiteList,
  fetchRealtimeIntensity,
  startClockSync,
  type SiteCoords,
  type YahooHypoInfoItem,
} from '../services/kyoshin'
import type { EEWAlert } from '../types/earthquake'
import { diffHypoInfoEvents, type HypoInfoPendingMissing } from '../utils/eew'
import { serverNow } from '../utils/clock'
import { log } from '../utils/logger'

export interface KyoshinRealtime {
  sites: SiteCoords
  indices: number[]
  dataTime: string
  /** sites がどの `siteConfigId` に属するか（fetchSiteList 成功時にセット）。
   *  検知エンジン側で「sites と indices が同じ観測点集合か」を判定するのに使う。 */
  sitesSiteConfigId: string | null
  /** indices が属する `siteConfigId`（毎フレーム RealTimeData JSON に含まれる値）。
   *  `sitesSiteConfigId` と一致しないフレームは、`siteConfigId` 切替直後の一時的な
   *  「新 indices・旧 sites」状態のため、下流の検知エンジン等は処理をスキップする。 */
  indicesSiteConfigId: string | null
  /** 連続して取得に失敗し、更新が停止している場合 true */
  error: boolean
}

// この回数連続で取得に失敗したら「更新停止（エラー）」とみなす
const ERROR_THRESHOLD = 5
// 同一タイムスタンプの受信失敗時リトライ間隔 (ms)
const RETRY_MS = 200
// リプレイ時: 同一 target への最大リトライ回数（超過したら諦めて次 target へ進む）
const REPLAY_MAX_RETRY_COUNT = 5
// 成功後に次タイムスタンプへ進むまでの待機時間 (ms)
const POLL_MS = 1000
// Yahoo サーバーがデータを公開するまでの遅延を考慮したオフセット (ms)。
// 秒ファイルは「その秒が終わってから約0.5秒後（＝秒頭から約1.5秒後）」に登録される実測結果に基づき、
// クロック同期後の serverNow() から登録済み秒を確実に引けるよう登録遅延+マージンを見込む。
// （従来の 500ms は壁時計が遅れている環境での偶然の帳尻合わせに依存しており、
//  クロックを正確に同期すると未登録秒(403)を叩いてしまうため引き上げた。）
const FETCH_OFFSET_MS = 1800
// 同一 target の取得に失敗し続けたとき現在時刻ベースへリセットするまでの許容時間 (ms)。
// REALTIME_MAX_RETRY_COUNT の算出に用いる。
// （成功時の遅れは nextTarget をフロンティアへ再アンカーすることで抑えるため、
//  ここでの lag 判定は行わない。）
const MAX_LAG_MS = 5000
// リアルタイム時: 同一 target への最大リトライ回数（超過したら諦めて現在時刻ベースにリセットする）。
// CDN 側で特定タイムスタンプの公開が恒久的に遅延・失敗するケースで無限リトライに張り付くのを防ぐ。
const REALTIME_MAX_RETRY_COUNT = MAX_LAG_MS / RETRY_MS

interface UseKyoshinRealtimeOptions {
  /** EEW の新規発報・更新・解除を検知したときに呼ばれるコールバック。 */
  onEEWEvent?: (eew: EEWAlert) => void
  /** テスト用時刻オフセット (ms)。null/undefined で現在時刻を使用。 */
  timeOffset?: number | null
}

/**
 * Yahoo 強震モニタのリアルタイム震度を取得するフック。
 * enabled が true の間のみ観測点リストを取得し、1秒ごとに震度を更新する。
 * 受信失敗時は同一タイムスタンプで RETRY_MS 間隔でリトライし、受信できたらその遅延で結果を反映する。
 * リアルタイム時は REALTIME_MAX_RETRY_COUNT 回を超えたら諦めて現在時刻ベースの target にリセットする
 * （特定タイムスタンプが CDN 側で恒久的に取得できないケースで無限リトライに張り付くのを防ぐ）。
 * リプレイ時（timeOffset 指定時）はリトライで消費した実時間を累積して次の待機時間から差し引き、
 * かつ REPLAY_MAX_RETRY_COUNT 回を超えたら諦めて次 target へ進める（再生時刻からの遅れが蓄積しないようにする）。
 * hypoInfo の差分検出により EEW 発報・更新・解除を onEEWEvent で通知する。
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
  const currentSiteConfigIdRef = useRef<string | null>(null)
  const failCountRef = useRef(0)
  const prevHypoInfoRef = useRef<YahooHypoInfoItem[]>([])
  // hypoInfo 消滅の連続検出回数（reportId ごと）。瞬間的な欠測を確定解除にしないための猶予状態。
  const pendingMissingRef = useRef<Map<string, HypoInfoPendingMissing>>(new Map())
  // コールバックを ref で保持し tick クロージャから安定参照する
  const onEEWEventRef = useRef(options?.onEEWEvent)
  onEEWEventRef.current = options?.onEEWEvent
  // timeOffset は deps に含めてエフェクトを再起動させるため、ref ではなく直接使う
  const timeOffset = options?.timeOffset ?? null

  // リアルタイム震度をポーリング（enabled の間のみ）。
  // 各 tick は明示的な target タイムスタンプを取得する。
  // 成功後の次 target は、ライブ時は「target + POLL_MS」とフロンティア(serverNow - FETCH_OFFSET_MS)の
  // 大きい方（遅延蓄積を防ぐ再アンカー）、リプレイ時は「target + POLL_MS」で等速に辿る。
  // 失敗時は同一 target で RETRY_MS 後にリトライする（リプレイ時は REPLAY_MAX_RETRY_COUNT 回で打ち切り）。
  // siteConfigId が変化したとき（リプレイ日付切替など）に対応する sitelist を自動で取得する。
  useEffect(() => {
    if (!enabled) return
    let active = true
    failCountRef.current = 0
    setError(false)
    // ライブ/リプレイ切替（timeOffset 変化）でエフェクトが再起動したとき、旧セッションの
    // hypoInfo 追跡状態を持ち越さない。持ち越すと、切替直後に旧セッションのアイテムが
    // 「消滅」と誤判定され、猶予後に古い震源データの幽霊キャンセルイベントが発火してしまう。
    prevHypoInfoRef.current = []
    pendingMissingRef.current = new Map()
    let timer: ReturnType<typeof setTimeout> | null = null

    const processResult = (rt: Awaited<ReturnType<typeof fetchRealtimeIntensity>>) => {
      failCountRef.current = 0
      setError(false)
      setIndices(rt.indices)
      setDataTime(rt.dataTime)
      // indices が属する siteConfigId を記録（下流で sites 側の siteConfigId と突合する）。
      setIndicesSiteConfigId(rt.siteConfigId ?? null)

      // siteConfigId が変わった場合のみ対応する sitelist を取得して反映する。
      // currentSiteConfigIdRef の更新は fetch 成功後に行う（失敗時に ref を先行更新
      // していると、次 tick で「siteConfigId が同じ」と判定されて再試行しなくなり、
      // sites が旧 siteConfigId のまま更新されず indices と長さ不整合になる。
      // fetchSiteList 側も失敗 Promise をキャッシュから削除して再試行可能にしている）。
      if (rt.siteConfigId && rt.siteConfigId !== currentSiteConfigIdRef.current) {
        const nextId = rt.siteConfigId
        fetchSiteList(nextId)
          .then((s) => {
            if (active) {
              currentSiteConfigIdRef.current = nextId
              setSites(s)
              setSitesSiteConfigId(nextId)
            }
          })
          .catch((err) => {
            // 失敗は次 tick で再試行される（ref は据え置き）。恒久的に失敗し続けた場合に
            // 気付けるよう最低限の警告ログを残す。無音で握り潰さない。
            log.warn('[kyoshin] sitelist fetch failed, will retry next tick', err)
          })
      }

      const prev = prevHypoInfoRef.current
      const curr = rt.hypoInfo
      const onEEW = onEEWEventRef.current
      if (onEEW) {
        const { events, pendingMissing } = diffHypoInfoEvents(prev, curr, pendingMissingRef.current)
        pendingMissingRef.current = pendingMissing
        for (const ev of events) onEEW(ev)
      }
      prevHypoInfoRef.current = curr
    }

    const isReplay = timeOffset != null

    // live モードのみクロック同期を起動し serverNow() をサーバー時刻へ較正する
    // （リプレイ中はアーカイブ時刻を使うため不要）
    const stopClockSync = isReplay ? null : startClockSync()

    // 初回 target: リアルタイム時のみ FETCH_OFFSET_MS 分だけ過去から開始し秒境界直後の失敗を抑制する
    const initialTarget = isReplay
      ? new Date(Date.now() + timeOffset)
      : new Date(serverNow() - FETCH_OFFSET_MS)

    // リプレイ時: (アンカー実時刻, アンカー target 時刻) の組を基準に、各 target の発火予定
    // 実時刻を絶対値で計算する。setTimeout は指定時間ぴったりには発火しないため、待機時間を
    // 「前回からの経過分を引く」相対計算にすると発火遅延がtickごとに積み重なり、再生時刻が
    // 壁時計からどんどん遅れていく。絶対時刻を基準にすることで各tickの遅延がリセットされ、
    // 蓄積しない。
    const anchorRealMs = Date.now()
    const anchorTargetMs = initialTarget.getTime()
    const scheduledWaitMs = (nextTarget: Date): number =>
      Math.max(0, anchorRealMs + (nextTarget.getTime() - anchorTargetMs) - Date.now())

    // target: 今回 fetch するタイムスタンプ。retryCount: 同一 target への再試行回数。
    const tick = (target: Date, retryCount = 0) => {
      const fetchStart = Date.now()
      fetchRealtimeIntensity(target)
        .then((rt) => {
          if (!active) return
          // KYO-4: processResult 内の例外を fetch 失敗と誤集計しないよう独立の try/catch で
          // 隔離する。失敗しても次 tick のスケジュールは通常経路で継続する。
          try {
            processResult(rt)
          } catch (err) {
            log.error('[kyoshin] processResult 内例外（ローカルバグ・ネットワーク失敗とは別）', err)
          }
          if (!isReplay) {
            // ライブ: 次ターゲットは「前回 + POLL_MS」と「フロンティア(serverNow - FETCH_OFFSET_MS)」の
            // 大きい方。通常は両者がほぼ一致しコマ飛びしないが、描画負荷などで tick の発火が遅延した場合は
            // 最新へジャンプして遅れを溜め込まない。前回 + POLL_MS で這うだけだと発火遅延が毎 tick 蓄積し、
            // fetch が高速でも表示が数秒遅れていく（相対スケジュールの弱点）。この再アンカーにより lag は
            // 常に FETCH_OFFSET_MS 以下に張り付く。
            const nextTarget = new Date(Math.max(target.getTime() + POLL_MS, serverNow() - FETCH_OFFSET_MS))
            // fetch にかかった時間を待機時間から引いて POLL_MS ごとの一定間隔を維持する
            const elapsed = Date.now() - fetchStart
            timer = setTimeout(() => tick(nextTarget), Math.max(0, POLL_MS - elapsed))
            return
          }
          // リプレイ時: アーカイブを等速で辿るため crawl (+POLL_MS)。
          // アンカーからの絶対時刻で次 tick の発火時刻を計算し、発火遅延を蓄積させない。
          const nextTarget = new Date(target.getTime() + POLL_MS)
          timer = setTimeout(() => tick(nextTarget), scheduledWaitMs(nextTarget))
        })
        .catch((err) => {
          if (!active) return
          if (!isReplay) {
            // リアルタイム時のみ: 連続失敗カウントを更新しエラー状態を通知する
            if (retryCount === 0) {
              failCountRef.current += 1
              if (failCountRef.current >= ERROR_THRESHOLD) {
                log.warn(`[kyoshin] 連続取得失敗 (${failCountRef.current}回) → エラー表示`, err)
                setError(true)
              }
            }
            // 同一 target への失敗が続き上限回数を超えたら、その target を諦めて
            // 現在時刻ベースにリセットする（特定タイムスタンプが CDN 側で恒久的に
            // 取得できないケースで無限リトライに張り付き続けるのを防ぐ）
            if (retryCount + 1 >= REALTIME_MAX_RETRY_COUNT) {
              log.warn(`[kyoshin] target への取得が ${retryCount + 1} 回失敗 → 現在時刻ベースにリセット`, err)
              timer = setTimeout(() => tick(new Date(serverNow() - FETCH_OFFSET_MS)), RETRY_MS)
              return
            }
            // 同一 target で RETRY_MS 後にリトライ
            timer = setTimeout(() => tick(target, retryCount + 1), RETRY_MS)
            return
          }
          // リプレイ時: 上限回数を超えたら諦めて次 target へ進める
          // （アーカイブ側の恒久的な欠損による無限リトライを防ぐ）
          if (retryCount + 1 >= REPLAY_MAX_RETRY_COUNT) {
            const nextTarget = new Date(target.getTime() + POLL_MS)
            timer = setTimeout(() => tick(nextTarget), scheduledWaitMs(nextTarget))
            return
          }
          timer = setTimeout(() => tick(target, retryCount + 1), RETRY_MS)
        })
    }

    tick(initialTarget)
    return () => {
      active = false
      if (timer !== null) clearTimeout(timer)
      if (stopClockSync !== null) stopClockSync()
    }
  }, [enabled, timeOffset])

  return { sites, indices, dataTime, sitesSiteConfigId, indicesSiteConfigId, error }
}
