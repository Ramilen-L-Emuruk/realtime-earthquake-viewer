import { useEffect, useRef, useState } from 'react'
import { useLazyRef } from './useLazyRef'
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
import { createLogThrottle, log } from '../utils/logger'

/** 学習資産（点別床・セル慢性活性）の localStorage キー。座標/セル基準なので siteConfigId 版差に非依存。 */
const LEARNED_KEY = 'kyoshin-v3-learned'
/** 学習資産の保存間隔(ms)。毎フレーム書くと無駄なのでスロットルする。 */
const SAVE_INTERVAL_MS = 60_000
/** 観測点数と震度の件数の食い違いを記録する最小間隔(ms)。毎フレーム出すと埋まる。 */
const PAIR_MISMATCH_LOG_MS = 300_000

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
   * 観測点ごとの表示用慢性ノイズ床（value）。**`sites` と同じ並びの配列**で、震度0ドット表示
   * （KyoshinSubThresholdGL）が慢性的にノイジーな観測点を鈍く見せるフィルタに使う。空配列は
   * フィルタ未適用の合図。
   *
   * 座標キーの辞書にしないのは、同一座標に複数の実観測点が載る点があるため（`computeSiteKeys` が
   * `#2`, `#3` と別実体に分ける）。受け取る側が座標からキーを作り直すと、その規則が 2 箇所に増えて
   * 静かに食い違う（実際にそうなっていた。`kyoshinSubThresholdFilter.ts` 参照）。並びで対応づければ
   * 規則そのものが要らない。
   *
   * まだ床を持たない点は 0 を入れる。0 に `SUSTAIN_MARGIN` を足した実効しきい値（0.4）が震度0ドットの
   * 上限（index 6 ＝ value 0.0）を上回るため、実質「表示しない」側へ倒れる。床を持たないのは、一度も
   * 観測できていない欠測点と、**大きな時刻の飛び（スリープ復帰・リプレイの巻き戻し等）の直後に
   * ちょうど欠測している点**——`kyoshinDetector` の不連続リセットは欠測点のキーを作り直さないため、
   * 学習済みの点でも一時的に落ちる。
   */
  floors: number[]
  /**
   * `floors` を計算した観測点配列の参照。**`floors` を位置で使う側は、自分が持っている観測点配列と
   * これが同一参照であることを確かめてから使うこと。**
   *
   * `floors` を作り直すのは**次にデータ時刻が進んだとき**（この effect の deps）なのに対し、呼び出し側の
   * 観測点配列はそのレンダーで即座に切り替わる。観測点リストが差し替わってからデータ時刻が進むまでの間
   * （途中に別のレンダーを挟むこともある）は「新しい観測点 × 古い床」が並び、点数がたまたま一致すると
   * 長さの検査をすり抜けて別地点の床で判定してしまう。
   * リストの差し替えは年数回の `siteConfigId` 更新に限らず、過去日のリプレイを始めるたびに起こる
   * （`services/kyoshinSource.ts` が再生対象日の `siteConfigId` を使うため）。
   */
  floorsSites: SiteCoords
  /**
   * この結果が「**結果を出せなくなったので空にした**」ものか（`RESULT_STALL_RESET_FRAMES` 参照）。
   *
   * 受け取る側が「揺れが収まって検知が消えた」のと区別するために持つ。後者からの復帰は同じ地震が
   * 続いていることが多く（`stateRef` は保持され、`MAX_DT_GAP_MS` 以内なら同じイベントが返る）、
   * 警報音や通知を鳴らし直すと「収まって、また始まった」という誤った印象を与える。
   */
  stalled: boolean
}

const EMPTY: KyoshinDetectorV2Result = {
  detections: [],
  triggers: [],
  recentOnsetKeys: new Set<string>(),
  dataTime: '',
  floors: [],
  floorsSites: [],
  stalled: false,
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
 * 並べるのは**座標キーで足りる**（`computeSiteKeys` の `#2` 付きキーにしなくてよい）。`computeSiteKeys`
 * は座標列だけを入力とする決定的な関数なので、座標列が同じなら割り当ても必ず同じ・座標列が違えば
 * ここも必ず違う——両者の検出能力は等価で、`#2` を含めても余分に捕まるものは無い。裏返しとして、
 * 同一座標のグループ内で 2 点の実体が入れ替わった更新は**どちらの作り方でも検出できない**（座標しか
 * 持たない配列では区別がつかない）。
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
 * **結果を出せないフレーム**がこの回数だけ続いたら、検知結果を空にする。
 *
 * 出せない理由は 2 つある——`step()` が例外を投げる場合と、観測点数と震度の件数が食い違って step() へ
 * 入れない場合。**どちらも `setResult` を呼ばずに抜けるため帰結は同じ**で、結果（`detections` と
 * `recentOnsetKeys`）は前フレームの値で凍結する。一方で表示側が使う現在震度は生きたまま更新され続ける
 * ので、放置すると「古いメンバーを現在の震度で描き続ける」状態になり、孤立した震度0点の間引きも古い
 * `recentOnsetKeys` で判定される。数フレームの一過性なら保持した方が明滅しないが、恒常的に壊れて
 * いるなら表示を止める方が安全。
 *
 * 理由ごとにカウンタを分けないのは、**表示から見れば区別が無い**ため。分けると片方だけ閾値に届かない
 * まま交互に起きたときに、いつまでも凍結が解けない。
 *
 * export しているのはテストが閾値を参照するため（フック外から使う想定はない）。
 */
export const RESULT_STALL_RESET_FRAMES = 5

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
  // `useRef(loadInitialState())` と書いてはいけない——**引数式は毎レンダー評価される**ため、
  // 1Hz の再レンダーのたびに localStorage の読み取りと学習資産の復元が走り、結果は捨てられる
  // （理由と実測値は `useLazyRef`）。
  const stateRef = useLazyRef(loadInitialState)
  // sites の参照も保持する。参照が同じなら中身は同じ（fetchSiteList が同一 siteConfigId に対して
  // 同じ配列を返す）ため、全点シグネチャの計算まで省ける。
  const metaRef = useRef<{ sites: SiteCoords; sig: string; meta: StationMeta } | null>(null)
  const lastSaveRef = useRef(0)
  const stalledFramesRef = useRef(0)
  // 観測点数と震度の件数が食い違ったことの記録（間引き）。遅延初期化する
  // （`useRef(createLogThrottle(...))` と書くと毎レンダーで捨てるだけのクロージャを作る）。
  const pairMismatchLogRef = useRef<((emit: () => void) => void) | null>(null)
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
    if (sites.length !== indices.length) {
      // 同じ `siteConfigId` なのに件数が違う＝上流データの異常。ここで抜けると step() へ入らず
      // **揺れ検知が丸ごと止まる**が、例外ではないので下の catch も通らない。記録しないと
      // 平常時と見分けがつかない（検知が出ないのが正常な状態なので、止まっていることに気づけない）。
      // 毎フレーム出さないよう間引く。
      pairMismatchLogRef.current ??= createLogThrottle(PAIR_MISMATCH_LOG_MS)
      pairMismatchLogRef.current(() => log.error(
        `[kyoshinV2] 観測点数(${sites.length})と震度の件数(${indices.length})が食い違うため検知を停止しています`
        + `（siteConfigId=${sitesSiteConfigId}）`,
      ))
      // 例外のときと同じく、続くなら結果を空にする。ここで抜けるだけだと、異常が始まった瞬間に
      // 出ていた検知イベントが**異常が続く限り凍結**し、音・自動タブ切替・自動フィット・地図・
      // 検知カードへ流れ続ける（詳細は RESULT_STALL_RESET_FRAMES）。
      stalledFramesRef.current++
      if (stalledFramesRef.current === RESULT_STALL_RESET_FRAMES) {
        log.error('[kyoshinV2] 件数の食い違いが続くため検知結果を空にします')
        setResult({ ...EMPTY, stalled: true })
      }
      return
    }

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
    // 以降は step() へ渡す分と床を並べ直す分で同じメタを使う（`meta.keys` が sites と同じ並び）。
    const stationMeta = metaRef.current.meta

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
        stationMeta,
      )
    } catch (err) {
      // step 内部で予期せぬ例外（sites/indices の長さ不整合を潜り抜けたケース等）が
      // 発生した場合、stateRef を破損させずログして次フレームで再試行する。
      // 例外を握り潰さないと useEffect のクリーンアップが走らず検知エンジンが恒久停止する。
      stalledFramesRef.current++
      log.error(`[kyoshinV2] step() threw (${stalledFramesRef.current}フレーム連続):`, err)
      // 連続で壊れているなら結果を空にする。保持し続けると、凍結した memberKeys /
      // recentOnsetKeys を現在の震度に当てて描き続ける（詳細は RESULT_STALL_RESET_FRAMES）。
      // 学習資産（点別床・セル慢性活性）は stateRef に残すので、復帰時に学び直しにならない。
      if (stalledFramesRef.current === RESULT_STALL_RESET_FRAMES) {
        log.error('[kyoshinV2] step() の連続失敗が続くため検知結果を空にします')
        setResult({ ...EMPTY, stalled: true })
      }
      return
    }
    stalledFramesRef.current = 0
    const { state, detections, triggers, recentOnsetKeys, prunedMembers } = stepResult
    stateRef.current = state

    // 床は `sites` と同じ並びの配列で渡す（詳細は KyoshinDetectorV2Result.floors）。
    // `state.sites` を走査せず `meta.keys` を走査するのは、キーの網羅性をこちらが握るため。
    // `step()` / `ingest()` は返す `state.sites` を毎回ゼロから作り直し、その回の `meta.keys` の
    // 範囲だけを埋めるので、`state.sites` のキーは常に `meta.keys` の部分集合になる（欠ける点は
    // `floors` の説明を参照）。学習資産の更新を差分方式へ最適化するような変更が入るとこの前提が
    // 崩れるため、そのときはここも見直すこと。
    const floors = new Array<number>(stationMeta.keys.length)
    for (let i = 0; i < stationMeta.keys.length; i++) {
      const s = state.sites[stationMeta.keys[i]]
      floors[i] = s ? chronicNoiseFloor(s) : 0
    }

    setResult({
      detections,
      triggers,
      recentOnsetKeys: new Set(recentOnsetKeys),
      dataTime,
      floors,
      floorsSites: sites,
      stalled: false,
    })

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
      // 値が下がりきったメンバーの刈り取り（kyoshinDetector.pruneFadedMembers）も同じく静かに
      // 点を消す処理。今フレームで外した延べ点数を出す。
      prunedMembers,
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
