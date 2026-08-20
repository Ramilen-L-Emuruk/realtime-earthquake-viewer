import { useCallback, useEffect, useRef, useState } from 'react'
import type * as maplibregl from 'maplibre-gl'
import { useMapGL } from './mapGLContext'
import type { LatLng } from '../../utils/stationCoords'
import type { DetectedPoint } from '../../utils/kyoshinDetectionView'
import type { EEWAlert } from '../../types/earthquake'
import type { PsWaveCircle } from '../../services/kyoshin'
import { computeEewCircle } from '../../hooks/usePsWaveCalc'
import { serverNow } from '../../utils/clock'
import {
  fitToPositions,
  fitJapan,
  flyToPoint,
  flyToBoundsSnapped,
  boundsFromCirclesForEewFollow,
  boundsForLiveFollow,
  boundsFromPositions,
  mapContainsBounds,
  refitDeltaForBounds,
  isProgrammaticFlight,
  subscribeUserInteraction,
  INTERACTION_HOLD_SEC,
  MAX_ZOOM,
} from './gl/camera'
import { decideTsunamiFit } from './gl/tsunamiFit'
import { log } from '../../utils/logger'

// MapLibre 版のカメラ自動追従群（Leaflet 版 JapanMap 内の Fit* コンポーネント相当）。
// Leaflet の flyToLite/flyToBoundsLite（ペイン非表示最適化）は MapLibre では不要のため
// gl/camera.ts の素の fit API を使う。座標は本アプリ共通の [lat,lng]。
// EEW 追従（idle 抑制つき・最も複雑）と津波追従は別ファイル（Camera-2）で扱う。

const dp2ll = (p: DetectedPoint): LatLng => [p.lat, p.lng]

// 観測行クリックの対象が地図に立っているか。座標未収録の観測点（tsunami-spec §8）は観測棒が無く、
// カメラを動かせない。FocusObsGL（寄せる側）と TsunamiFitGL（俯瞰へ帰る猶予を数え直す側）が
// 同じ判定を見る必要があるため、条件はここ 1 箇所に置く——別々に持つと、片方だけ変えたときに
// 「猶予は延びたのにカメラは動かない」という無言の食い違いが生まれる。
function findObsBar<T extends { name: string }>(bars: T[], name: string | undefined): T | undefined {
  return name === undefined ? undefined : bars.find((b) => b.name === name)
}

// アクティブな EEW から震源座標（有効なものだけ）を抽出する。円がまだ無い EEW（仮定震源要素・
// 震源未確定・タイミング上まだ psWave に反映されていない新規 EEW）でも、追従 bounds に震源だけは
// 必ず含めるために使う（円のある EEW も含む。震源座標は円の box に包含されるため合成しても無害）。
function eewHypocenters(eews: EEWAlert[]): LatLng[] {
  const positions: LatLng[] = []
  for (const eew of eews) {
    const { latitude, longitude } = eew.earthquake.hypocenter
    if (latitude <= -200 || longitude <= -200) continue
    positions.push([latitude, longitude])
  }
  return positions
}

// ── ユーザー操作中判定の共有フック ───────────────────────────────────────────────
// zoomstart/dragstart を起点に「ユーザーが手動操作した」とみなし、一定時間
// 操作が無ければ自動的に解除する。実体（リスナー登録・タイマー・アプリ起点イベントの除外）は
// gl/camera.ts の subscribeUserInteraction が map 単位で一元管理し、複数の Fit* コンポーネントが
// 同じ map を購読しても zoomstart/dragstart の登録は 1 組だけになる。保持時間は設定タブの
// 「自動復帰までの時間」とは切り離した固定値（理由は gl/camera.ts の INTERACTION_HOLD_SEC）。
// 戻り値は boolean の state（ref ではない）にしているのが要点: 保持時間の経過で
// interacting が false に戻った瞬間、これを deps に含む呼び出し側の useEffect が再実行される。
// ref 版だと「操作終了」を検知する再トリガーが無く、操作中に来た更新が再レンダリングの
// 機会を得られないまま永久にスキップされ続けてしまう（成長フォロー等のセルフヒール手段を
// 持たない QuakeFitGL/FitToCandidateGL で実際に問題になった）。
function useUserInteractionGuard(map: maplibregl.Map | null): [boolean, () => void] {
  const [isInteracting, setIsInteracting] = useState(false)
  const resetRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!map) return
    const sub = subscribeUserInteraction(map, setIsInteracting)
    resetRef.current = sub.reset
    setIsInteracting(sub.isInteracting)
    return () => {
      sub.unsubscribe()
      resetRef.current = () => {}
    }
  }, [map])

  const reset = useCallback(() => resetRef.current(), [])

  return [isInteracting, reset]
}

// ── 地震モード: signature が変わったとき quakeFitPositions にフィットする ────────────
// selectionTick は「ユーザーが地震カード（または津波→地震リンク）を明示的にクリックした」
// 瞬間だけ App が +1 する単調増加カウンタ。電文受信ハンドラ（useLiveEventHandler）からも
// selectQuake は呼ばれるが、そちらは opts.explicit=false で呼ばれるため tick は進まない。
// selectionTick の変化で入ってきたフィットは isUserInteracting を無視して強制発火する
// （FitToEEWGL が新規 EEW 受信時に resetUserInteraction するのと同じ考え方）。
// signature だけが変わったフィット（電文更新で latest が変わった／取消フォールバック等）は
// 従来通り isUserInteracting を尊重し、ユーザーがズーム/パン中の勝手なジャンプを避ける。
//
// lastConsumedTickRef は「このコンポーネントが最後に処理した selectionTick の値」を保持する
// 状態。QuakeFitGL 自身の useRef ではなく親（JapanMapGL）が保有した ref を props で受け取る
// 設計にしている理由:
// QuakeFitGL は mode==='quake' の条件付きレンダー（JapanMapGL 内）で、タブ切替のたびに
// アンマウント/リマウントされる。もし ref を QuakeFitGL 自身に持たせると、リマウントのたびに
// 初期値へリセットされ、「App 側の selectionTick は既に非 0（過去に明示選択が起きていた）だが、
// このリマウントは単なるタブ復帰」というケースを区別できず、必ず explicit=true と誤判定して
// タブ復帰のたびに isUserInteracting を無視した強制フィットが走ってしまう。
// 親（JapanMapGL）は quake モード以外でも常時マウントされているため、その useRef はリマウントを
// またいで生存する。これにより「明示選択で tick が進んだ最初のフィットだけ explicit=true」
// という本来の意図が保たれる。
export function QuakeFitGL({
  signature,
  positions,
  selectionTick = 0,
  lastConsumedTickRef,
}: {
  signature: string
  positions: LatLng[]
  selectionTick?: number
  lastConsumedTickRef: React.MutableRefObject<number>
}) {
  const map = useMapGL()
  const lastFitRef = useRef<string>('')
  const [isUserInteracting, resetUserInteraction] = useUserInteractionGuard(map)
  useEffect(() => {
    if (!map || !signature || positions.length === 0) return
    // ユーザーが明示的にカードを選んだか（selectionTick が進んだか）。tick が同じなら
    // 電文更新起点のフィットとして扱う（isUserInteracting を尊重）。
    const explicit = lastConsumedTickRef.current !== selectionTick
    lastConsumedTickRef.current = selectionTick
    // 自動フィットは signature 一致で再発火を抑制する。明示選択は同じ地震を再度選ぶケースも
    // あり得るため signature 一致でも通す（zoom で拡大→同じカードで戻す等）。
    if (!explicit && lastFitRef.current === signature) return
    // マーク確定は isUserInteracting 判定の後で行う。自動フィットが操作中に来ても lastFitRef を
    // 進めずに見送ることで、isUserInteracting が false に戻った時点の再レンダリング
    // （useUserInteractionGuard 参照）でこの effect が再実行され、同じ signature のまま
    // 取り戻せるようにする。
    if (!explicit && isUserInteracting) {
      log.debug('[mapGL] quake fit スキップ (userInteracting)')
      return
    }
    if (explicit) resetUserInteraction()
    lastFitRef.current = signature
    log.debug(`[mapGL] quake fit (${positions.length}点${explicit ? ' 明示選択' : ''})`)
    fitToPositions(map, positions, { padding: 48, maxZoom: MAX_ZOOM, durationSec: 1.0 })
    // lastConsumedTickRef は ref なので依存配列に入れない（参照の同一性は保たれる）。
  }, [map, signature, positions, selectionTick, isUserInteracting, resetUserInteraction])
  return null
}

// ── リアルタイム震度タブ入室時のリセット ────────────────────────────────────────
// マウント時（タブ入室時）に一度だけ実行する。検知中は FitToDetection に、EEW 中は FitToEEW に
// フレーミングを委ねてスキップ（FitToEEW はマウント時に必ず発火して波円/震源へ寄せる）。
// それ以外（他タブで寄った表示のリセット）は日本全体へ戻す。
export function FitJapanOnEnterGL({ hasEew, hasDetection }: { hasEew: boolean; hasDetection: boolean }) {
  const map = useMapGL()
  useEffect(() => {
    if (!map) return
    if (hasDetection) {
      log.debug('[mapGL] FitJapanOnEnter スキップ (揺れ検知中)')
      return
    }
    if (hasEew) {
      log.debug('[mapGL] FitJapanOnEnter スキップ (EEW発報中・FitToEEW に委譲)')
      return
    }
    log.debug('[mapGL] fitJapan (realtime 入室・EEWなし)')
    fitJapan(map, 1.0)
    // タブ入室時のみ（マウント時 1 回）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

// 収め直しフォロー（画に収まってはいるが目標に対して合っていないときに寄り直す）の条件。
// 揺れが収まって範囲が狭まった場合と、範囲が別の場所へ移った場合の両方を拾う。
//
// MIN_ZOOM_GAIN: 寄り直して何段ズームが深くなるなら動かす価値があるか（`refitDeltaForBounds`）。
//   1.0 段＝縮尺 2 倍。これ未満の寄り直しはカメラを動かすほどの見え方の差にならない。
// MIN_SHIFT_RATIO: 寄り直しで中心がどれだけ動くなら価値があるか（ペイン短辺に対する比）。
//   **ズームの利得だけでは測れないため必要。** 寄り上限（`MAX_ZOOM`）の近くでは現在ズームと
//   着地ズームの双方がクランプに当たるため、目標がどこへ移動しても利得は 1.0 段に届かず
//   （利得の上限は `MAX_ZOOM` − 現在ズーム。着地ズームは 0.5 刻みなので、ズーム 6.5 以上では
//   構造的に届かない）、揺れの位置が動いても画が固まる。実測: 2026-07-17 大隅半島東方沖 M5.2 の
//   再生で、ズーム 7 のままカメラが約 2 分動かず、目標中心のずれが 42px → 247px（短辺の 31%）
//   まで育った。0.2＝短辺の 2 割。同じ再生で発火は 2 分あたり 1〜3 回、能登（M7.6・全国規模で
//   ズーム 5 に留まる局面）では 0 回。
// HOLD: その状態が続くべき時間。揺れの減衰は数秒単位で上下する（余震・表面波の再来・
//   欠測の出入り）ため、一瞬変わっただけで寄せるとカメラが落ち着かない。
//   専用のタイマーは張らない——検知が生きている間は観測点の値が毎秒更新されて points の
//   識別子が変わり、この effect 自身が毎秒走るため、経過時間の比較だけで足りる。
//   **裏を返すと、強震モニタの取得が止まって観測値の更新が途絶えると、この待ちは進まない**
//   （`useKyoshinDetectorV2` は dataTime が進まない限り検知を再計算しないため）。その状況では
//   観測点も検知カードも同じく凍結しているので、カメラだけ動かす意味が無い。待ちに入ったことは
//   下でログに残し、「待っている」のか「更新が来ていない」のかを事後に切り分けられるようにする。
//
// どちらの量も「寄り直したあとは必ず 0 になる」ことが往復しない根拠（`refitDeltaForBounds`）。
const REFIT_MIN_ZOOM_GAIN = 1.0
const REFIT_MIN_SHIFT_RATIO = 0.2
const REFIT_HOLD_MS = 8000

// 成長フォローの「収まっているか」に持たせる余白。検知点はバッジで描くため、点が画面の縁に
// あると丸が半分切れる。フィットの padding と同じ値にしておくと、寄り直した直後は必ず
// この余白の内側に入るので往復しない（`mapContainsBounds` の marginPx 参照）。
const DETECTION_FIT_PADDING = 60

// ── 揺れ検知点にフィットし、検知終了時は日本全体に戻す（EEW 中は戻さない） ──────────
// MAP-4 対応: 初回フィットも hasEew 時は FitToEEWGL に委譲してスキップする（従来は初回のみ
// hasEew を無視して検知点へ寄せていたが、EEW と同じコミットで発生する二段ジャンプを回避）。
// 以降は検知点が画面からはみ出したとき（成長フォロー）と、収まってはいるが画が目標に合って
// いないとき（収め直しフォロー＝範囲が狭まった／別の場所へ移った）に追い直す。どちらも
// 1 点の増減でカメラが動かないよう、flyToBoundsSnapped のズーム段階と上記 REFIT_* を
// ヒステリシスに使う。
export function FitToDetectionGL({
  points,
  hasDetection,
  hasEew,
  hasCandidate = false,
}: {
  /**
   * カメラが追う検知点。**実際に地図へ描かれている点だけ**を渡すこと（`JapanMapGL` の
   * `detectedFitPoints`）。イベントのメンバーの和集合（`detectedPoints`）は揺れが収まっても
   * 縮まないため、それを追うと大地震のあと画が全国に張り付いたまま戻らない。
   */
  points: DetectedPoint[]
  /**
   * 確定検知が続いているか（メンバーの和集合が空でないか）。`points` が空になっただけでは
   * 検知終了とみなさないために分けている——描画側のフィルタ（震度0未満・欠測・孤立した震度0）で
   * 一時的に描ける点が無くなることは検知中にも起きる。ここを `points.length` で兼ねると、
   * そのたびに日本全体へ戻して寄り直す明滅になる。
   */
  hasDetection: boolean
  hasEew: boolean
  /**
   * 確定検知に育っていない候補クラスタが残っているか（`FitToCandidateGL` がフィットする対象があるか）。
   * 検知終了時に日本全体へ戻すかどうかの判断にのみ使う。
   */
  hasCandidate?: boolean
}) {
  const map = useMapGL()
  const fittedRef = useRef(false)
  // 画が目標に合っていない状態が続き始めた時刻（0 = 合っている）。収め直しフォローの HOLD 判定に使う。
  const refitSinceRef = useRef(0)
  // 「検知は続いているが描ける点が 0」の状態にいるか。ログを状態の変わり目だけに絞るために持つ。
  const noFitTargetRef = useRef(false)
  // 収め直しの判定自体ができない状態にいるか（同じくログを変わり目だけに絞るために持つ）。
  const refitBlindRef = useRef(false)
  const [isUserInteracting] = useUserInteractionGuard(map)
  useEffect(() => {
    if (!map) return
    if (!hasDetection) {
      refitSinceRef.current = 0
      // 次の検知サイクルへ持ち越さない。持ち越すと「寄り先なし」「判定不可」に入った初回のログが出ない。
      noFitTargetRef.current = false
      refitBlindRef.current = false
      if (fittedRef.current) {
        fittedRef.current = false
        // 候補クラスタが残っているなら日本全体へは戻さず、そちらへのフィットに任せる
        // （`FitToCandidateGL` の候補失効分岐が `hasDetection` で守られているのと対称）。
        // これが無いと、確定検知の終了と同じコミットで候補クラスタが立っている場合に、
        // 直前の候補へのフィットを日本全体で上書きして一瞬ちらつく。
        // 委譲先が動くことが前提なので、`FitToCandidateGL` は検知終了の瞬間にフィット済みの印を
        // 落として寄り直す（同コンポーネントの detectionJustEnded 参照）。片方だけ変えると
        // 「どちらもカメラを動かさず、終了した検知の位置に取り残される」状態になる。
        // なお検知終了と候補失効が同一コミットで重なると、あちらの失効分岐とここの下の fitJapan が
        // 両方走る。どちらも日本全体という同じ目標なので見た目は変わらない（排他制御はしていない）。
        if (hasCandidate) {
          log.debug('[mapGL] fitJapan スキップ (揺れ検知終了・候補クラスタ継続中)')
          return
        }
        if (!hasEew && !isUserInteracting) {
          log.debug('[mapGL] fitJapan (揺れ検知終了)')
          fitJapan(map, 1.0)
        }
      }
      return
    }
    // 検知は続いているが、いま描けている点が無い（全メンバーが震度0未満・欠測・孤立した震度0）。
    // 寄る先が無いだけなので画は動かさない。ここで日本全体へ戻すと、点が戻った瞬間に寄り直す
    // 往復になる（hasDetection を分けている理由そのもの）。
    //
    // 減衰の途中では普通に通る状態だが、上流の不具合（観測値の並びの崩れ等）で長く居座った場合も
    // 見た目・ログが「収まって待っているだけ」と区別できなくなる。入った瞬間だけ記録を残す
    // （毎周回では出さない。この分岐は揺れが引くたびに秒単位で通るため）。
    if (points.length === 0) {
      refitSinceRef.current = 0
      // 「判定不可」の記録もここで落とす（`noFitTargetRef` と同じ寿命で扱う。状態が入れ替わった
      // ときに、それぞれの初回ログが必ず出るようにするため）。
      refitBlindRef.current = false
      if (!noFitTargetRef.current) {
        noFitTargetRef.current = true
        log.debug('[mapGL] 揺れ検知 寄り先なし (検知は継続中・描ける点が0)')
      }
      return
    }
    noFitTargetRef.current = false
    if (!fittedRef.current) {
      // マーク確定は isUserInteracting 判定の後で行う（QuakeFitGL と同じ理由）。
      if (isUserInteracting) {
        log.debug('[mapGL] 揺れ検知フィット スキップ (userInteracting)')
        return
      }
      // MAP-4: EEW 発報中は FitToEEWGL に一任し、初回フィットも発火させない。
      // 従来は初回のみ hasEew を無視して検知点へ寄せていたため、EEW と検知が同一コミットで到着
      // した際にカメラが二段ジャンプしていた。fittedRef を立てるだけで実際の flyTo は EEW 終息後
      // に成長追従の分岐（下）に委ねる。
      if (hasEew) {
        log.debug('[mapGL] 揺れ検知フィット スキップ (EEW発報中・FitToEEW に委譲)')
        fittedRef.current = true
        return
      }
      fittedRef.current = true
      log.debug(`[mapGL] 揺れ検知フィット (${points.length}点)`)
      fitToPositions(map, points.map(dp2ll), { padding: 60, maxZoom: MAX_ZOOM, durationSec: 1.0 })
      return
    }
    // 検知範囲の成長追従。EEW 発報中は FitToEEWGL が「有感半径 ∪ 検知点」を追うため、ここでは追わない。
    // 両方が「自分の bounds がはみ出したら引く」を持つと目標が2つになり、互いに相手をはみ出させ合って
    // 振動する（ズーム段階のヒステリシスでは止まらない。目標同士が排他のため）。hasEew で持ち主を分ける。
    // 自分が追わない状況（EEW 側に委譲・飛行中・ユーザー操作中）では、収め直しフォローの待ちを
    // 積ませない。ここでリセットしないと、抑制が明けた瞬間に「ゆるい状態が続いた」と誤認して
    // 待ち時間ゼロで寄り直してしまう（ユーザーが操作をやめた直後にカメラがスナップする）。
    if (hasEew || isProgrammaticFlight(map) || isUserInteracting) {
      refitSinceRef.current = 0
      // 判定そのものをしていないので「判定不可」の記録も落とす（この状態を挟んで再び判定不可へ
      // 入ったときに、初回として記録されるようにするため。以降の分岐も同じ扱い）。
      refitBlindRef.current = false
      return
    }
    const bounds = boundsFromPositions(points.map(dp2ll))
    if (!bounds) return
    const fitOpts = { padding: DETECTION_FIT_PADDING, maxZoom: MAX_ZOOM }
    if (!mapContainsBounds(map, bounds, DETECTION_FIT_PADDING)) {
      refitSinceRef.current = 0
      refitBlindRef.current = false
      log.debug(`[mapGL] 揺れ検知 成長フォロー (${points.length}点)`)
      flyToBoundsSnapped(map, bounds, { ...fitOpts, durationSec: 0.8 })
      return
    }
    // 収め直しフォロー: 画に収まっていても、範囲が狭まったり別の場所へ移ったりすると、成長
    // フォローだけでは画がずれたまま固まる（収まっている限り何もしないため）。寄り直しの利得が
    // REFIT_MIN_ZOOM_GAIN 段以上か、中心の移動が REFIT_MIN_SHIFT_RATIO 以上ある状態が
    // REFIT_HOLD_MS 続いたら寄り直す。
    const delta = refitDeltaForBounds(map, bounds, fitOpts)
    if (delta === null) {
      // 寄り直し先を算出できない（地図のコンテナ寸法が取れない・座標が壊れている）。
      // 成長フォローはすでに「収まっている」と判断して通り過ぎているため、この状態が続くと
      // どちらのフォローも動かない。黙って止まると原因を追えないので、入った瞬間だけ記録する
      // （毎周回では出さない。「寄り先なし」と同じ方針）。
      refitSinceRef.current = 0
      if (!refitBlindRef.current) {
        refitBlindRef.current = true
        log.debug('[mapGL] 揺れ検知 収め直しフォロー 判定不可 (寄り直し先を算出できない)')
      }
      return
    }
    refitBlindRef.current = false
    if (delta.zoomGain < REFIT_MIN_ZOOM_GAIN && delta.centerShiftRatio < REFIT_MIN_SHIFT_RATIO) {
      refitSinceRef.current = 0
      return
    }
    const reason = `${delta.zoomGain.toFixed(1)}段・中心${(delta.centerShiftRatio * 100).toFixed(0)}%`
    const now = Date.now()
    if (refitSinceRef.current === 0) {
      refitSinceRef.current = now
      // 待ちに入ったことを残す。この待ちは観測値の更新で進むため、更新が途絶えると無言で止まる。
      // 記録が無いと「待機中」と「更新が来ていない」を事後に区別できない（上の HOLD の注記参照）。
      log.debug(`[mapGL] 揺れ検知 収め直しフォロー 待機開始 (${points.length}点・${reason})`)
      return
    }
    if (now - refitSinceRef.current < REFIT_HOLD_MS) return
    refitSinceRef.current = 0
    log.debug(`[mapGL] 揺れ検知 収め直しフォロー (${points.length}点・${reason})`)
    flyToBoundsSnapped(map, bounds, { ...fitOpts, durationSec: 0.8 })
    // hasCandidate を参照するのは上の検知終了分岐だけだが、古い値を掴まないよう deps には含める
    // （成長・収め直しフォローの分岐が余分に再評価されるが、収まっていてずれてもいなければ何もしない）。
  }, [map, points, hasDetection, hasEew, hasCandidate, isUserInteracting])
  return null
}

// ── 候補クラスタが立った時点で候補点群にフィット（確定検知中は FitToDetection に委譲） ──
export function FitToCandidateGL({
  points,
  candidateId,
  hasEew,
  hasDetection,
}: {
  points: DetectedPoint[]
  candidateId: number | null
  hasEew: boolean
  hasDetection: boolean
}) {
  const map = useMapGL()
  const fittedIdRef = useRef<number | null>(null)
  const prevHasDetectionRef = useRef(hasDetection)
  const [isUserInteracting] = useUserInteractionGuard(map)
  useEffect(() => {
    if (!map) return
    // 確定検知が出ている間、この効果は下の early return で何もしない。その間に候補クラスタが立っても
    // fittedIdRef は更新されないため、確定検知が終わった時点では「フィット済み」の古い印だけが残る。
    // その印が今の candidateId と一致していると再フィットが起きず、しかも FitToDetectionGL 側は
    // hasCandidate を見て fitJapan を見送るので、カメラが終了した検知の位置に取り残される。
    // 検知が終わった瞬間に印を落として、生き残っている候補へ寄り直せるようにする。
    // （candidateId が null のときは落とさない。落とすと下の失効分岐が「フィット済みだった」判定を
    //   失い、日本全体への帰還を FitToDetectionGL 側だけに依存させることになる）
    const detectionJustEnded = prevHasDetectionRef.current && !hasDetection
    prevHasDetectionRef.current = hasDetection
    if (hasDetection) return
    if (detectionJustEnded && candidateId !== null) fittedIdRef.current = null
    if (candidateId === null) {
      if (fittedIdRef.current !== null) {
        fittedIdRef.current = null
        if (!hasEew && !isUserInteracting) {
          log.debug('[mapGL] fitJapan (候補クラスタ失効)')
          fitJapan(map, 1.0)
        }
      }
      return
    }
    if (fittedIdRef.current === candidateId) return
    if (points.length === 0) return
    // マーク確定は isUserInteracting 判定の後で行う（QuakeFitGL と同じ理由。候補クラスタは
    // 確定検知に育つまで同じ candidateId を保つため、ここで先にマークすると成長フォロー相当の
    // セルフヒール手段が無く、操作中に来た候補が永久にフィットされなくなる）。
    if (isUserInteracting) {
      log.debug(`[mapGL] 候補クラスタフィット スキップ (userInteracting, id=${candidateId})`)
      return
    }
    // EEW 発報中は FitToEEWGL に一任する（FitToDetectionGL の MAP-4 対応と同形）。候補点群の狭い範囲へ
    // 寄せても、EEW 側の追従は予想の区域塗りまで含む広い目標を持つため、次の判定で即座に引き直されて
    // 二段のカメラ移動になる。fittedIdRef だけ立てて実際の flyTo は見送る。
    //
    // 見送った候補は、EEW 解除時に FitToEEWGL の帰還先（検知点が無ければ候補点）が引き受ける。
    // ここは fittedIdRef を立てるため、同じ candidateId のままでは二度と発火しない（上の早期 return）。
    // 委譲した先に帰還経路が無いと、その候補クラスタは一度も画面に入らないまま終わる。
    if (hasEew) {
      log.debug(`[mapGL] 候補クラスタフィット スキップ (EEW発報中・FitToEEW に委譲, id=${candidateId})`)
      fittedIdRef.current = candidateId
      return
    }
    fittedIdRef.current = candidateId
    log.debug(`[mapGL] 候補クラスタフィット (${points.length}点 id=${candidateId})`)
    if (points.length === 1) {
      flyToPoint(map, dp2ll(points[0]), MAX_ZOOM, 1.0)
      return
    }
    fitToPositions(map, points.map(dp2ll), { padding: 60, maxZoom: MAX_ZOOM, durationSec: 1.0 })
  }, [map, points, candidateId, hasEew, hasDetection, isUserInteracting])
  return null
}

// 新規 EEW 受信直後、成長フォロー（下の useEffect）を抑制する時間。すでに検知点が広範囲な状態で
// 新規 EEW を受けても、まず EEW 自身（震源/波円）へのフォーカスを見せてから成長フォローに委ねる。
// 無いと、フォーカス直後に検知点が更新された瞬間、成長フォローが検知点全体を含む範囲へ即座に
// 引き直してしまい「一瞬 EEW にフォーカス→即ズームアウト」というちらつきになる。
const GROWTH_FOLLOW_SUPPRESS_MS = 3000

// ── EEW 追従（idle 抑制つき・最も複雑） ──────────────────────────────────────────
// 新規 EEW: 震源中心→予報円へフィット（第一報は震源近傍の寄りを見せたいため、予想の区域塗りは
// ここでは含めない）。解除: 検知中なら検知点、無ければ日本全体へ。
// ユーザーが手動でズーム/パンしたら一定時間追従を停止する（新規 EEW の受信でも解除される）。
// 予報円の成長・予想の区域塗りの広がりで表示に収まらなくなったらズームアウト追従する。
export function FitToEEWGL({
  eews,
  psWave,
  detectedPoints = [],
  hasDetection = false,
  candidatePoints = [],
  forecastAreaPositions = [],
}: {
  eews: EEWAlert[]
  psWave: PsWaveCircle[]
  /**
   * 揺れ検知点。**実際に地図へ描かれている点だけ**を渡すこと（`FitToDetectionGL` の `points` と同じ集合）。
   * 発報中の追従に含める目標であり、EEW 解除時の帰還先でもある。
   */
  detectedPoints?: DetectedPoint[]
  /**
   * 確定検知が続いているか（`FitToDetectionGL` の同名 props と同じ生の判定）。
   * EEW 解除時に「描ける点が無いだけ」と「検知が終わっている」を区別するために使う。
   */
  hasDetection?: boolean
  /**
   * 確定検知に育っていない候補クラスタの点群。EEW 解除時の帰還先としてのみ使う（検知点が無い場合）。
   * 発報中の追従（成長フォロー）には含めない——未確定の候補まで追うと、ノイズで立った候補のたびに
   * 画が広がってしまうため。
   */
  candidatePoints?: DetectedPoint[]
  /**
   * 予想の区域塗りが占める範囲（区域 bbox の南西・北東 2 点の列・`useEewLayerData` の `eewFitPositions`）。
   * 予想長周期地震動を表示中はそちらの区域に切り替わっている（描画側の visible と同じ分岐）。
   */
  forecastAreaPositions?: LatLng[]
}) {
  const map = useMapGL()
  const lastEewIdRef = useRef<string | null>(null)
  const [isUserInteracting, resetUserInteraction] = useUserInteractionGuard(map)
  const prevEewsCountRef = useRef<number>(0)
  const prevPsWaveCountRef = useRef<number>(0)
  const suppressGrowthUntilRef = useRef<number>(0)

  // 最新 EEW（originTime 降順）を追従対象とする。
  const latest =
    eews.length > 0
      ? [...eews].sort((a, b) => b.earthquake.originTime.localeCompare(a.earthquake.originTime))[0]
      : null

  // 新規 EEW 受信 → 震源/波円へフィット。解除 → 検知点 or 日本全体へ。
  // 新規 EEW 受信時は resetUserInteraction() でユーザー操作フラグを強制的に解除する。
  // 新しい警報が来た瞬間は操作中でも問答無用でフォーカスを見せる意図的な仕様
  // （他の Fit* と異なり「常に発火させる」側を選んでいる）。
  useEffect(() => {
    if (!map) return
    if (!latest) {
      if (lastEewIdRef.current !== null) {
        lastEewIdRef.current = null
        if (isUserInteracting) {
          log.debug('[mapGL] EEW解除 フィットスキップ (userInteracted)')
        } else if (detectedPoints.length > 0) {
          log.debug(`[mapGL] EEW解除・揺れ検知中 ${detectedPoints.length}点へフィット`)
          fitToPositions(map, detectedPoints.map(dp2ll), { padding: 60, maxZoom: MAX_ZOOM, durationSec: 1.0 })
        } else if (hasDetection) {
          // 検知は続いているが、いま描ける点が無い（`FitToDetectionGL` の同名の分岐と同じ状態）。
          // 帰る先が無いだけなので EEW の画に留める。候補クラスタや日本全体へ落とすと、
          // 生きている確定検知を差し置いて画が飛ぶ（描ける点が戻った時点で成長／収め直しフォローが拾う）。
          log.debug('[mapGL] EEW解除 フィットスキップ (揺れ検知は継続中・描ける点が0)')
        } else if (candidatePoints.length > 0) {
          // 確定検知には育っていない候補クラスタが残っている場合はそこへ帰る。EEW 発報中は
          // FitToCandidateGL がフィットを見送って（hasEew ガード）こちらに委譲しているため、
          // ここで受けないと「EEW 中に立った候補クラスタが一度も画面に入らない」穴になる。
          // FitToCandidateGL 側は candidateId ごとに一度しか発火しないので、あちらでは取り戻せない。
          log.debug(`[mapGL] EEW解除・候補クラスタ ${candidatePoints.length}点へフィット`)
          fitToPositions(map, candidatePoints.map(dp2ll), { padding: 60, maxZoom: MAX_ZOOM, durationSec: 1.0 })
        } else {
          log.debug('[mapGL] fitJapan (EEW解除)')
          fitJapan(map, 1.0)
        }
      }
      return
    }
    const { latitude, longitude } = latest.earthquake.hypocenter
    if (latitude <= -200 || longitude <= -200) return
    const eewEventId = latest.issue?.eventId ?? latest.id
    if (lastEewIdRef.current === eewEventId) return
    lastEewIdRef.current = eewEventId
    resetUserInteraction()
    suppressGrowthUntilRef.current = Date.now() + GROWTH_FOLLOW_SUPPRESS_MS
    // 波円が既にあれば波円へ直接フィット（震源→波円のギクシャク防止）。他に発報中の EEW があっても
    // それらの円は含めない。psWave prop は usePsWaveCalc が別 Effect で非同期に更新するため、新規 EEW
    // 受信直後のこのレンダーではまだ反映されていない（psWave.find に頼ると常に外れて震源フォールバック
    // に落ちてしまう）。ここでは psWave を待たず、その場で自身の円だけを直接計算する。
    const ownCircle = computeEewCircle(latest, serverNow())
    const bounds = ownCircle ? boundsFromCirclesForEewFollow([ownCircle]) : null
    if (bounds) {
      log.debug('[mapGL] EEW新規 自身の波円へフィット')
      flyToBoundsSnapped(map, bounds, { padding: 60, maxZoom: MAX_ZOOM, durationSec: 0.8 })
      return
    }
    log.debug('[mapGL] EEW新規 震源へフィット')
    flyToPoint(map, [latitude, longitude], MAX_ZOOM, 0.8)
    // psWave/detectedPoints/candidatePoints/hasDetection は意図的に依存配列から外している。この effect は
    // 「新規 EEW を検知した瞬間」と「最後の EEW が消えた瞬間」だけに反応させたく、点群の変化では
    // 再実行させない（lastEewIdRef の実質的な等値チェックで弾かれるため deps に入れても害はないが、
    // 「latest（新規判定）に反応する effect」であることを deps だけで誤読させないための明示）。
    // 解除時の帰還先に使う点群は「latest が null になったレンダー時点の値」で十分。
  }, [latest, map, isUserInteracting, resetUserInteraction])

  // EEW 数 or 波円数が減少かつ残りがある場合: 残りへ強制再フィット。
  useEffect(() => {
    if (!map) return
    const prevCount = prevEewsCountRef.current
    const prevPsCount = prevPsWaveCountRef.current
    prevEewsCountRef.current = eews.length
    prevPsWaveCountRef.current = psWave.length
    const eewDecreased = eews.length < prevCount
    const psWaveDecreased = psWave.length < prevPsCount
    if (!eewDecreased && !psWaveDecreased) return
    if (eews.length === 0) return
    // 以下 2 つの見送りは、いずれも「その回の寄り直しを永久に失う」（件数の記録は上で更新済みなので
    // 同じ減少が後から再検出されることはない）。無言で失うと実地震のあとに「抑制が働いたのか
    // 不具合なのか」を切り分けられないため、他のスキップ分岐と同じくログに残す。
    if (isUserInteracting) {
      log.debug('[mapGL] EEW数減少の再フィット スキップ (userInteracting)')
      return
    }
    // 第一報のフォーカスを見せている間は寄り直さない（成長フォローと同じ抑制を効かせる）。
    // 抑制中にここが発火すると、抑制が防いでいる「一瞬寄って即ズームアウト」を別のトリガーで
    // 再現してしまう。
    // ただし残りが画面外にはみ出していれば、抑制が明けた直後に成長フォローの収まり判定が拾って
    // 引き直す（最大で抑制時間ぶん遅れる）。
    if (Date.now() < suppressGrowthUntilRef.current) {
      log.debug('[mapGL] EEW数減少の再フィット スキップ (第一報直後の抑制中)')
      return
    }

    // 円のある EEW は円の box、円が無い（仮定震源要素等の）EEW も震源座標一点は必ず含める
    // （円だけを見ると、その EEW が画面から取り残される）。
    // 目標は成長フォロー（下の useEffect）と同一にする。食い違わせると、ここで寄せた直後に成長フォローが
    // 引き直して二段のカメラ移動になる（予想の区域塗りは円より広いことが多く、差が常態化する）。
    const bounds = boundsForLiveFollow(
      psWave,
      eewHypocenters(eews),
      detectedPoints.map(dp2ll),
      forecastAreaPositions,
    )
    if (!bounds) {
      if (latest) {
        const { latitude, longitude } = latest.earthquake.hypocenter
        if (latitude > -200 && longitude > -200) {
          log.debug('[mapGL] EEW数減少・座標なし 震源へ再フィット')
          flyToPoint(map, [latitude, longitude], MAX_ZOOM, 0.8)
        }
      }
      return
    }
    log.debug(`[mapGL] EEW数減少・残り${eews.length}件へ再フィット`)
    flyToBoundsSnapped(map, bounds, { padding: 60, maxZoom: MAX_ZOOM, durationSec: 0.8 })
  }, [eews, psWave, latest, map, isUserInteracting, detectedPoints, forecastAreaPositions])

  // 予報円・震源座標・揺れ検知点・予想の区域塗りの広がりに追従（表示に収まらなくなった時のみズームアウト）。
  // 目標は「有感半径 bounds ∪ 震源座標 ∪ 検知点 ∪ 予想の区域塗り」の単一 bounds。EEW 発報中の追従はこの
  // 効果が一手に引き受け、FitToDetectionGL・FitToCandidateGL 側は hasEew で止まる（目標を2つにすると
  // 振動するため。boundsForLiveFollow 参照）。円が無い（仮定震源要素・M不明・自動解除直後等の）EEW も
  // 震源座標一点は必ず含める。円だけを見ると、その EEW の震源が画面から取り残される穴になるため。
  // isProgrammaticFlight(map) により、他コンポーネントの自動フィットが進行中の間もこの効果は
  // 再フィットを待つ（同時に複数のカメラアニメーションが競合するのを避ける）。
  // 新規 EEW 受信直後は GROWTH_FOLLOW_SUPPRESS_MS の間、この効果自体を止める（上の useEffect 参照）。
  useEffect(() => {
    if (!map) return
    if (eews.length === 0) return
    if (isUserInteracting || isProgrammaticFlight(map)) return
    if (Date.now() < suppressGrowthUntilRef.current) return
    const bounds = boundsForLiveFollow(
      psWave,
      eewHypocenters(eews),
      detectedPoints.map(dp2ll),
      forecastAreaPositions,
    )
    if (bounds && !mapContainsBounds(map, bounds)) {
      // 区域数は 2 で割って求める（forecastAreaPositions は区域あたり bbox の 2 点。useEewLayerData 参照）。
      log.debug(
        `[mapGL] EEW成長フォロー 波円${psWave.length}個+震源${eews.length}件+検知${detectedPoints.length}点` +
          `+予想区域${forecastAreaPositions.length / 2}件`,
      )
      flyToBoundsSnapped(map, bounds, { padding: 60, maxZoom: MAX_ZOOM, durationSec: 0.8 })
    }
  }, [eews, psWave, detectedPoints, forecastAreaPositions, map, isUserInteracting])

  return null
}

// ── 津波モードのフィット（観測点更新優先・アイドルで俯瞰へ復帰） ──────────────────
// 優先順位の取り決めは gl/tsunamiFit.ts の decideTsunamiFit（純関数・テストで固定）。
// ここは「持ち越しの管理」と「アイドル復帰タイマー」だけを担う。
//
// 観測点へ寄ったままにしないのが要点。観測情報は電文のたびに寄り直すため、寄った先に留まると
// 発表中の対象海域全体が二度と画面に入らない（海岸線 signature は寄った時点で消費するので、
// 区域・等級が変わらない限り海岸線フィットは再発火しない）。無操作・無更新が INTERACTION_HOLD_SEC 秒
// 続いたら俯瞰へ帰し、津波が消えたら日本全体へ帰す。
export function TsunamiFitGL({
  mode,
  tsunamiSignature,
  tsunamiFitPositions,
  observationBars,
  focusObsName = null,
}: {
  mode: string
  tsunamiSignature: string
  tsunamiFitPositions: LatLng[]
  observationBars: { name: string; lat: number; lng: number; height: { value: number } }[]
  /** 観測行クリックで FocusObsGL が寄せた観測点。猶予を数え直すためだけに見る（フィットはしない）。 */
  focusObsName?: { name: string; ts: number } | null
}) {
  const map = useMapGL()
  // 最後にカメラへ反映した海岸線 signature。津波が消えたとき（全解除・有効期間の満了・
  // リプレイのリセットなど）に津波モード以外にいた場合は、ここに古い値が残る。同じ内容の津波が再来したときに「変化なし」と
  // 判定されるが、そのぶんは入室時・アイドル復帰・消滅時の帰還が寄せ直すため実害は無い
  // （帰還経路を消すとこの前提も崩れるので、経路を減らすときは併せて見直すこと）。
  const lastTsunamiSigRef = useRef<string>('')
  const prevObsMapRef = useRef<Map<string, number>>(new Map())
  const pendingObsPositionsRef = useRef<LatLng[]>([])
  const prevModeRef = useRef<string>(mode)
  const prevInteractingRef = useRef(false)
  const idleReturnDueRef = useRef(false)
  const idleTimerRef = useRef<number | undefined>(undefined)
  // タイマー満了は React の外で起きるため、effect を再評価させる契機として state を 1 つ持つ。
  const [idleReturnTick, setIdleReturnTick] = useState(0)
  const [isUserInteracting] = useUserInteractionGuard(map)

  const clearIdleReturnTimer = useCallback(() => {
    window.clearTimeout(idleTimerRef.current)
    idleTimerRef.current = undefined
  }, [])

  // 観測点へ寄った状態から俯瞰へ帰るまでの猶予。操作ガードの保持時間と同じ固定値を使う
  // （設定「自動復帰までの時間」から切り離した理由は gl/camera.ts の INTERACTION_HOLD_SEC）。
  // 設定を「無効」にしても帰還は止めない。止めると、この関数が解除だけして終わり、
  // 観測点へ寄ったまま取り残される経路が復活する（それが帰還を足した動機そのもの）。
  const armIdleReturnTimer = useCallback(() => {
    clearIdleReturnTimer()
    idleTimerRef.current = window.setTimeout(() => {
      idleReturnDueRef.current = true
      setIdleReturnTick((t) => t + 1)
    }, INTERACTION_HOLD_SEC * 1000)
  }, [clearIdleReturnTimer])

  useEffect(() => clearIdleReturnTimer, [clearIdleReturnTimer])

  // 観測行クリックで特定の観測点へ寄せた直後は、猶予を最初から数え直す。
  // クリックは地図のイベントを経由しない（FocusObsGL の flyTo は自分のカメラ操作を操作ガードから
  // 除外する）ため、これが無いと「直前の観測点フィットで張った猶予」の残り時間だけで
  // ユーザーが選んだ表示が巻き戻される。俯瞰へ帰る動き自体は残す（手動のズーム・パンと同じ扱い）。
  const focusObsTs = focusObsName?.ts ?? 0
  const lastFocusObsTsRef = useRef(0)
  useEffect(() => {
    if (focusObsTs === 0 || focusObsTs === lastFocusObsTsRef.current) return
    // 実際に寄せられるクリックだけを数え直しの対象にする。カメラが動かないクリックで猶予を
    // 延ばすと、何も起きていないのに俯瞰への復帰が遅れる（判定は findObsBar に集約）。
    if (!findObsBar(observationBars, focusObsName?.name)) return
    lastFocusObsTsRef.current = focusObsTs
    idleReturnDueRef.current = false
    armIdleReturnTimer()
  }, [focusObsTs, focusObsName, observationBars, armIdleReturnTimer])

  useEffect(() => {
    if (!map) return
    const enteredTsunamiMode = mode === 'tsunami' && prevModeRef.current !== 'tsunami'
    prevModeRef.current = mode

    // 更新された観測バーを検出して持ち越しに積む。海岸線 sig はここで消費して競合を防ぐ
    // （寄り先が観測点と海岸線で二重に決まると、直後に引き直しが起きて二段のカメラ移動になる）。
    // モードを問わず記録するため、津波タブを離れている間の更新も入室時に反映される。
    const prevMap = prevObsMapRef.current
    const updatedBars = observationBars.filter((b) => prevMap.get(b.name) !== b.height.value)
    const newMap = new Map<string, number>()
    for (const b of observationBars) newMap.set(b.name, b.height.value)
    prevObsMapRef.current = newMap
    if (updatedBars.length > 0) {
      // 持ち越しは「最後に届いたぶん」で置き換える（溜めて合成しない）。フィットを見送っている間に
      // 複数の電文が届いた場合、全部を束ねると離れた観測点の和で引きの画になり、どこで新しく
      // 観測されたのかが読めなくなる。取りこぼすのは枠の選び方だけで、観測値はカードにも
      // 波高バーにも残る。
      pendingObsPositionsRef.current = updatedBars.map((b) => [b.lat, b.lng] as LatLng)
      lastTsunamiSigRef.current = tsunamiSignature
    }

    // 操作ガードが解けた瞬間は「INTERACTION_HOLD_SEC 秒の無操作が確定した」ことなので、そのまま
    // アイドル復帰の期限として扱う（手動で動かした後も俯瞰へ帰す）。true→false の遷移だけを見る。
    if (prevInteractingRef.current && !isUserInteracting) idleReturnDueRef.current = true
    prevInteractingRef.current = isUserInteracting

    // 津波モードを離れている間は猶予を持たない（入室時に改めて俯瞰へ寄せ直すため）。
    if (mode !== 'tsunami') clearIdleReturnTimer()

    const action = decideTsunamiFit({
      isTsunamiMode: mode === 'tsunami',
      isUserInteracting,
      hasPendingObs: pendingObsPositionsRef.current.length > 0,
      signature: tsunamiSignature,
      lastSignature: lastTsunamiSigRef.current,
      hasCoastPositions: tsunamiFitPositions.length > 0,
      enteredTsunamiMode,
      isIdleReturnDue: idleReturnDueRef.current,
    })
    if (action === 'none') return

    // 実行したら持ち越しは使い切る（未消費のまま残すと、次の評価で同じフィットが再発火する）。
    idleReturnDueRef.current = false
    lastTsunamiSigRef.current = tsunamiSignature

    if (action === 'obs') {
      const positions = pendingObsPositionsRef.current
      pendingObsPositionsRef.current = []
      log.debug(`[mapGL] 津波フィット 観測点 ${positions.length}点`)
      fitToPositions(map, positions, { padding: 48, maxZoom: MAX_ZOOM, durationSec: 1.0 })
      armIdleReturnTimer()
      return
    }
    // 俯瞰へ帰ったら猶予タイマーは不要。
    clearIdleReturnTimer()
    if (action === 'coast') {
      log.debug(`[mapGL] 津波フィット 海岸線 ${tsunamiFitPositions.length}点`)
      fitToPositions(map, tsunamiFitPositions, { padding: 48, maxZoom: MAX_ZOOM, durationSec: 1.0 })
      return
    }
    log.debug('[mapGL] fitJapan (津波の帰還: 海岸線なし or 発表終了)')
    fitJapan(map, 1.0)
  }, [
    map, mode, tsunamiSignature, tsunamiFitPositions, observationBars, isUserInteracting,
    idleReturnTick, armIdleReturnTimer, clearIdleReturnTimer,
  ])

  return null
}

// ── 津波観測行クリック時に該当観測点へ flyTo ──────────────────────────────────────
export function FocusObsGL({
  focusObsName,
  observationBars,
}: {
  focusObsName: { name: string; ts: number } | null
  observationBars: { name: string; lat: number; lng: number }[]
}) {
  const map = useMapGL()
  const handledTsRef = useRef(0)
  useEffect(() => {
    if (!map || !focusObsName) return
    // クリック 1 回につき 1 度だけ寄せる。観測棒の配列は電文のたびに作り直されるため、
    // 配列の変化で寄せ直すと、以後の電文が来るたびに古いクリック先へカメラが引き戻され、
    // 値が更新された観測点へのフィット（TsunamiFitGL）まで上書きしてしまう。
    if (focusObsName.ts === handledTsRef.current) return
    const bar = findObsBar(observationBars, focusObsName.name)
    // 観測棒がまだ無い（座標データの取得前など）ときは ts を消費しない。棒が現れた時点で寄せる。
    if (!bar) return
    handledTsRef.current = focusObsName.ts
    log.debug(`[mapGL] 観測点フォーカス flyTo ${bar.name}`)
    flyToPoint(map, [bar.lat, bar.lng], MAX_ZOOM, 1.0)
  }, [map, focusObsName, observationBars])
  return null
}
