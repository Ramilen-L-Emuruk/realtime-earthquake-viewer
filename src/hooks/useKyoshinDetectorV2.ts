import { useEffect, useRef, useState } from 'react'
import { MISSING_INDEX_THRESHOLD, type SiteCoords } from '../services/kyoshin'
import {
  step,
  initState,
  buildStationMeta,
  extractLearned,
  hydrateLearned,
  siteKey,
  chronicNoiseFloor,
  type DetectorState,
  type StationMeta,
  type LearnedState,
  type DetectionEvent,
  type TriggerResult,
} from '../utils/kyoshinDetector'
import { log } from '../utils/logger'

/** 学習資産（点別床・セル慢性活性）の localStorage キー。座標/セル基準なので siteConfigId 版差に非依存。 */
const LEARNED_KEY = 'kyoshin-v3-learned'
/** 学習資産の保存間隔(ms)。毎フレーム書くと無駄なのでスロットルする。 */
const SAVE_INTERVAL_MS = 60_000

// localStorage が壊れた/無効な環境（プライベートモード・dom.storage.enabled=false・
// 一部の iframe サンドボックス等）では、getItem/setItem が呼ばれるたびに例外を投げる。
// `useKyoshinDetectorV2` は ≈1Hz で再レンダーされ、`useRef` の引数式は毎レンダー評価される
// ため、単純に catch で log すると同じ warn が毎秒（保存側は 60 秒ごと）に無限に積み上がる。
// モジュールスコープの一度限りフラグでスパムを抑制する。
let loadWarned = false
let saveWarned = false

/** localStorage から学習資産を復元した初期状態を作る（無ければ空状態）。 */
function loadInitialState(): DetectorState {
  const base = initState(0)
  try {
    const raw = localStorage.getItem(LEARNED_KEY)
    if (!raw) return base
    const learned = JSON.parse(raw) as LearnedState
    if (!learned || typeof learned !== 'object' || !learned.floors) return base
    return hydrateLearned(base, learned)
  } catch (e) {
    // localStorage アクセス不可・JSON 破損等。復元できないだけで検知エンジンは動くため
    // warn で通知する（error にすると初回起動や localStorage 無効環境で常時エラー化する）。
    // 毎レンダー評価に対する再ログを避けるため、セッション中一度きりに絞る。
    if (!loadWarned) {
      loadWarned = true
      log.warn('[detector] 学習資産の復元失敗（新規セッションとして初期化）', e)
    }
    return base
  }
}

/** 学習資産を localStorage に保存する（容量超過・無効環境は握りつぶす）。 */
function saveLearned(state: DetectorState): void {
  try {
    localStorage.setItem(LEARNED_KEY, JSON.stringify(extractLearned(state)))
  } catch (e) {
    // 容量超過・プライベートモード等は学習を諦めるだけ。検知は継続。保存失敗を可視化する
    // ことで「なぜ次回起動時に学習資産が復元されないか」を追跡できるようにする。
    // 60 秒ごとの保存失敗が延々続くのを避けるため、セッション中一度きりに絞る。
    if (!saveWarned) {
      saveWarned = true
      log.warn('[detector] 学習資産の保存失敗（localStorage 容量超過・プライベートモード等）', e)
    }
  }
}

export interface KyoshinDetectorV2Result {
  /** アクティブな検知イベント（最大震度降順） */
  detections: DetectionEvent[]
  /** 今フレームのトリガー点 */
  triggers: TriggerResult[]
  /**
   * 直近に立ち上がった観測点キー（`step()` の `recentOnsetKeys`）。検知点マーカー・検知カードが
   * 「揺れが去った後に残る孤立した震度0点」を落とす判定に使う（kyoshinDetectionView.dropIsolatedZeroPoints）。
   */
  recentOnsetKeys: ReadonlySet<string>
  /** 対象データ時刻 */
  dataTime: string
  /**
   * 観測点ごとの表示用慢性ノイズ床（座標キー→value）。震度0ドット表示（KyoshinSubThresholdGL）が
   * 慢性的にノイジーな観測点を鈍く見せるフィルタに使う。未学習（空オブジェクト）はフィルタ未適用の合図。
   */
  floors: Record<string, number>
}

const EMPTY: KyoshinDetectorV2Result = {
  detections: [],
  triggers: [],
  recentOnsetKeys: new Set<string>(),
  dataTime: '',
  floors: {},
}

/**
 * 観測点集合のシグネチャ。これが変わったら近傍メタ（`buildStationMeta`）を組み直す。
 *
 * **全点を見る**。以前は「点数＋先頭・末尾座標」だけで判定していたが、それでは配列の中間だけが
 * 差し替わった更新を検知できず、古い近傍メタ（＝`StationMeta.keys`）を使い続ける。`keys` は
 * `computeSiteKeys` が座標の重複点に出現順で `#2`, `#3` を割り当てた結果で、Yahoo の観測点リストでは
 * 全1725点中431点が座標重複に該当する。一方で表示側の `buildSiteIndex` は毎回キーを作り直すため、
 * 両者のキーがずれ、`recentOnsetKeys` を使う判定（孤立した震度0点の間引きの救済）が静かに効かなくなる。
 *
 * 全点の走査は O(点数) だが、呼ぶのは `sites` の**参照が変わったとき**だけに絞っている（呼び出し側参照）。
 * 同一 `siteConfigId` の観測点リストは `fetchSiteList` がキャッシュした同じ配列を返すため、
 * 通常運用では毎秒走らない。
 *
 * export しているのはテストから直接呼ぶため（フック外から使う想定はない）。
 */
export function siteSignature(sites: SiteCoords): string {
  if (sites.length === 0) return ''
  const parts: string[] = [String(sites.length)]
  for (const s of sites) parts.push(siteKey(s[0], s[1]))
  return parts.join('|')
}

/**
 * `step()` の連続失敗をこの回数だけ許し、超えたら検知結果を空にする。
 *
 * 例外時は `setResult` を呼ばずに抜けるため、結果（`detections` と `recentOnsetKeys`）は前フレームの値で
 * 凍結する。一方で表示側が使う現在震度は生きたまま更新され続けるので、放置すると「古いメンバーを
 * 現在の震度で描き続ける」状態になり、孤立した震度0点の間引きも古い `recentOnsetKeys` で判定される。
 * 数フレームの一過性なら保持した方が明滅しないが、恒常的に壊れているなら表示を止める方が安全。
 *
 * export しているのはテストが閾値を参照するため（フック外から使う想定はない）。
 */
export const STEP_FAIL_RESET_FRAMES = 5

/**
 * 強震モニタ検知エンジン（純粋コア step・V3 近傍一致型）の React ラッパー。
 *
 * 強震モニタ検知の唯一のエンジン。検知結果は音・自動タブ切替・自動フィット・地図オーバーレイ・
 * リアルタイムタブのカード表示を駆動する。デバッグ用に最新結果を window.__kyoshinV2 へ公開する。
 *
 * 近傍グラフ・格子割当（StationMeta）は観測点集合が変わったときだけ再計算してキャッシュする
 * （実行時座標から純粋な幾何計算・追加リクエスト 0）。
 *
 * @param sites 観測点座標（useKyoshinRealtime.sites）
 * @param indices 計測震度インデックス（useKyoshinRealtime.indices）
 * @param dataTime データ時刻文字列（useKyoshinRealtime.dataTime）
 * @param sitesSiteConfigId sites がどの `siteConfigId` で fetch されたか
 * @param indicesSiteConfigId indices が属する `siteConfigId`（毎フレーム RealTimeData 由来）
 * @param enabled 有効フラグ（false の間は何もしない）
 * @param hasActiveNonAssumedEEW 震源要素が確定した（単独点処理=仮定震源要素でない）EEW が発表中か
 *   （cancelled 除く）。true の間は confirmed の確定条件を緩和する（§19）。単独点処理由来の速報は
 *   震源・推定震度の誤差が大きいため緩和しない。
 */
export function useKyoshinDetectorV2(
  sites: SiteCoords,
  indices: number[],
  dataTime: string,
  sitesSiteConfigId: string | null,
  indicesSiteConfigId: string | null,
  enabled: boolean,
  hasActiveNonAssumedEEW: boolean,
): KyoshinDetectorV2Result {
  const stateRef = useRef<DetectorState>(loadInitialState())
  // sites の参照も保持する。参照が同じなら中身は同じ（fetchSiteList が同一 siteConfigId に対して
  // 同じ配列を返す）ため、全点シグネチャの計算まで省ける。
  const metaRef = useRef<{ sites: SiteCoords; sig: string; meta: StationMeta } | null>(null)
  const lastSaveRef = useRef(0)
  const stepFailRef = useRef(0)
  // dataTime 更新時のみ step() を進める設計（下記 useEffect の deps 参照）に合わせ、EEW 状態は
  // ref で最新値を持ち回す（deps に含めると EEW 変化のたびに同一フレームへ再度 step() してしまう）。
  const hasActiveNonAssumedEEWRef = useRef(hasActiveNonAssumedEEW)
  hasActiveNonAssumedEEWRef.current = hasActiveNonAssumedEEW
  const [result, setResult] = useState<KyoshinDetectorV2Result>(EMPTY)

  useEffect(() => {
    if (!enabled) return
    if (!dataTime || indices.length === 0 || sites.length === 0) return
    const dataTimeMs = new Date(dataTime).getTime()
    if (!Number.isFinite(dataTimeMs)) return

    // sites と indices の siteConfigId が一致するフレームだけを処理する。
    // siteConfigId 切替直後は「新しい indices・旧い sites」の状態が発生し、単なる長さ
    // 判定では見逃す（旧新で観測点数がたまたま一致した年切替）と、位置ベースの対応付け
    // （kyoshinDetector.step 内 `frame.sites[i]`）で座標と震度が誤ペアリングされ、TypeError も
    // 出ずに検知点マーカー・震度0ドットが誤った位置に表示される。両者の siteConfigId が
    // 揃うまで step() をスキップする（長さ不整合の TypeError 対策も兼ねる）。
    if (sitesSiteConfigId == null || indicesSiteConfigId == null) return
    if (sitesSiteConfigId !== indicesSiteConfigId) return
    if (sites.length !== indices.length) return

    // 観測点集合が変わったときだけ近傍メタを構築（フレーム毎の O(点数²) を避ける）。
    // 二段構え: まず参照で弾き（毎秒はここで終わる）、参照が変わったときだけ全点シグネチャを比べる。
    // 内容が同じなら近傍メタを再利用し、参照だけ差し替える（同内容の別配列で O(点数²) を走らせない）。
    if (!metaRef.current || metaRef.current.sites !== sites) {
      const sig = siteSignature(sites)
      if (!metaRef.current || metaRef.current.sig !== sig) {
        metaRef.current = { sites, sig, meta: buildStationMeta(sites as [number, number][]) }
      } else {
        metaRef.current.sites = sites
      }
    }

    let stepResult: ReturnType<typeof step>
    try {
      stepResult = step(
        stateRef.current,
        {
          dataTimeMs,
          sites: sites as [number, number][],
          values: indices,
          // 欠測点（Yahoo が index<0 で返す観測点データなし）を除外する。渡さないと欠測復旧時の
          // 急上昇がオンセットと誤認識されうる（missing の実際の判定根拠は services/kyoshin.ts 参照）。
          missing: indices.map((idx) => idx < MISSING_INDEX_THRESHOLD),
          eewActive: hasActiveNonAssumedEEWRef.current,
        },
        metaRef.current.meta,
      )
    } catch (err) {
      // step 内部で予期せぬ例外（sites/indices の長さ不整合を潜り抜けたケース等）が
      // 発生した場合、stateRef を破損させずログして次フレームで再試行する。
      // 例外を握り潰さないと useEffect のクリーンアップが走らず検知エンジンが恒久停止する。
      stepFailRef.current++
      log.error(`[kyoshinV2] step() threw (${stepFailRef.current}フレーム連続):`, err)
      // 連続で壊れているなら結果を空にする。保持し続けると、凍結した memberKeys /
      // recentOnsetKeys を現在の震度に当てて描き続ける（詳細は STEP_FAIL_RESET_FRAMES）。
      // 学習資産（点別床・セル慢性活性）は stateRef に残すので、復帰時に学び直しにならない。
      if (stepFailRef.current === STEP_FAIL_RESET_FRAMES) {
        log.error('[kyoshinV2] step() の連続失敗が続くため検知結果を空にします')
        setResult(EMPTY)
      }
      return
    }
    stepFailRef.current = 0
    const { state, detections, triggers, recentOnsetKeys } = stepResult
    stateRef.current = state

    const floors: Record<string, number> = {}
    for (const [key, s] of Object.entries(state.sites)) floors[key] = chronicNoiseFloor(s)

    setResult({ detections, triggers, recentOnsetKeys: new Set(recentOnsetKeys), dataTime, floors })

    // 学習資産（点別床・セル慢性活性）を定期的に永続化する（再読込・5時リロード後も学習を保つ）
    if (dataTimeMs - lastSaveRef.current >= SAVE_INTERVAL_MS) {
      lastSaveRef.current = dataTimeMs
      saveLearned(state)
    }

    // 検証用にグローバル公開（Playwright から window.__kyoshinV2 を参照する）
    ;(window as unknown as Record<string, unknown>).__kyoshinV2 = {
      detections,
      triggers: triggers.length,
      // 孤立した震度0点の間引き（kyoshinDetectionView.dropIsolatedZeroPoints）が効いているかを
      // 実運用で追えるようにする。間引きは静かに点を消す処理で、失敗しても例外が出ない。
      recentOnsetKeys: recentOnsetKeys.length,
      dataTime,
      eewActive: hasActiveNonAssumedEEWRef.current,
    }
    const confirmed = detections.filter((d) => d.confidence === 'confirmed')
    if (confirmed.length > 0) {
      log.debug(
        `[kyoshinV2] confirmed=${confirmed.length} triggers=${triggers.length} @${dataTime}`,
        confirmed.map((d) => ({
          id: d.id,
          maxIntensity: d.maxIntensity.toFixed(1),
          size: d.lastSize,
          epi: d.epicenter,
        })),
      )
    }
    // indices/sites は dataTime と同時に更新されるため deps は dataTime/enabled のみでよい。
    // 例外として siteConfigId 切替時は sites が非同期に遅れて更新されるが、その期間は上の
    // sitesSiteConfigId/indicesSiteConfigId ガードで step() をスキップするため deps に加える
    // 必要はない（次の dataTime tick で両者が揃った時点で再評価される）。
    // この最適化は React 18 の自動バッチングによって useKyoshinRealtime の applyFrame 内で
    // setIndices/setDataTime/setIndicesSiteConfigId が単一レンダーにまとまることを前提にしている。
    // applyFrame の呼び出し元は 2 つ（フレーム投入時の同期ドレインと、時刻到来を待つ巡回
    // ドレイン）あり、**どちらも applyFrame を同期で呼ぶ**ことがこの前提を支えている。
    // 呼び出し経路に await や queueMicrotask を挟む・applyFrame 内で setState を分割する等で
    // 前提が崩れると、dataTime だけ先に更新されて古い siteConfigId でガードを誤って通過し、
    // 座標と震度が誤ペアリングされる。リファクタ時はここも要見直し
    // （この前提は useKyoshinRealtime.wiring.test.ts が回帰テストで固定している）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataTime, enabled])

  return result
}
