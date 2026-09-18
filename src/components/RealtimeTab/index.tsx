// リアルタイムタブの右パネル。地図エリアは JapanMap が強震モニタ（観測点）と
// 予報円を描画し、ここでは EEW 情報カード・強震モニタ検知(V2)カード・注記を表示する。
// 震度スケールの凡例は地図へ重ねる `MapLegend` が持つ（同じものを 2 箇所に出さない）。
import { memo, useEffect, useRef, useState } from 'react'
import type { EEWAlert } from '../../types/earthquake'
import type { DetectionEvent, Confidence } from '../../utils/kyoshinDetector'
import type { DetectedPoint } from '../../utils/kyoshinDetectionView'
import type { SWaveArrival } from '../../hooks/useSWaveCountdown'
import { usePageVisible } from '../../hooks/usePageVisible'
import { formatDateTime } from '../../utils/formatters'
import { getIntensityColor, getIntensityLabel, getIntensityLabelWithApproxAbove, getIntensityBgColor, getMagnitudeColor, getDepthColor } from '../../utils/intensity'
import { getLpgmClassLabelWithApproxAbove, getLpgmClassColor, getLpgmClassBgColor } from '../../utils/lpgm'
import { eewAreas, eewMaxScaleInfo, eewMaxLpgmClassInfo, eewSerial, computeSingleEEWLevel, eewNoForecastReason, canPresentLpgmClass, eewEpicenterRankLabel, eewMagnitudeRankLabel, eewMagnitudePointsLabel, eewForecastChangeText, isEewHypocenterSettled, isEewAreaArrived, sortEewWarningRegions } from '../../utils/eew'
import { kyoshinIndexToJma, kyoshinIndexToLabel, kyoshinIntensityColor, SHINDO0_COLOR } from '../../utils/kyoshinIntensity'
import { readableTextColor } from '../../utils/contrast'
import { gateNotes, gateRows, gateShortfall } from '../../utils/detectionGates'
import { DescriptionTip } from '../DescriptionTip'
import { SerialBadge } from '../SerialBadge'
import { isEewWarningKindCode, isEewPlumKindCode } from '../../utils/eewKind'
import { serverNow } from '../../utils/clock'
import { log } from '../../utils/logger'

interface Props {
  eews: EEWAlert[]
  swaveArrival: SWaveArrival | null
  /** V2 検知エンジンの検知イベント（音・自動タブ切替・自動フィット・カード表示を駆動）。 */
  kyoshinV2Detections: DetectionEvent[]
  /**
   * 検知カードが集計する観測点。**地図の検知点マーカーが描くのと同一の点列**を受け取る
   * （`deriveKyoshinView` が孤立した震度0点を除いて用意する。両者で別々に計算すると黙って食い違う）。
   */
  kyoshinDetectedPoints: DetectedPoint[]
  /**
   * このタブがユーザーの目に入っているか（リアルタイムタブが選ばれていて、かつパネルが
   * 畳まれていない）。タブは選ばれていなくてもマウントされたまま描画が走るため、可視性は
   * props で受け取るしかない。ブラウザのタブ・ウィンドウ側の可視性は App では判らないので、
   * `usePageVisible` で合成する。用途は検知カードのバー幅スケールの張り直し判定。
   */
  visible: boolean
  activeLpgmEventId?: string | null
  onToggleLpgm?: (eventId: string) => void
  onDeactivateLpgm?: () => void
}

/**
 * 予想震度が付いていない EEW のバナー。理由の判定は `eewNoForecastReason` に委ねる
 * （読み上げの「〜のため、予想震度なし。」と同じ判定を使う。ここで深さや `condition` を
 * 直接見ると、閾値を動かしたときに画面と音声が食い違う）。
 *
 * 理由が判らないとき（`unknown`）は何も添えない。値が遅れて付く可能性が残る状態で、
 * 気象庁が「発表しない」と決めたわけではないため。
 */
function NoForecastBanner({ eew }: { eew: EEWAlert }) {
  const reason = eewNoForecastReason(eew)
  return (
    <div
      className="w-full rounded-lg py-2 px-4 flex flex-col items-center justify-center gap-1 roomy:py-3.5"
      style={{ backgroundColor: 'rgba(42,42,42,0.8)', border: '2px solid #4b5563' }}
    >
      {reason !== 'unknown' && (
        <span className="text-xs font-medium" style={{ color: '#9ca3af' }}>
          {reason === 'assumed' ? '単独点処理のため' : '深発地震のため'}
        </span>
      )}
      <span className="text-xl font-extrabold" style={{ color: '#e5e7eb' }}>予想震度なし</span>
    </div>
  )
}

/**
 * 「予想が変わった」の帯を最低どれだけ出し続けるか。
 *
 * **決めているのは「変化が続いている間、帯が途切れないこと」。** 実電文（2026-06-01〜09-06・
 * 334 イベント）では、変化を立てた報から次の変化までが**別の文言へ差し替わる場合で最大 9 秒**・
 * **同じ文言の再発で最大 4 秒**だった。10 秒あればどちらも覆う。
 *
 * **次の報が来るまでの間隔（最大 10 秒）はこの値の根拠にならない。** 変化なしの報では帯を
 * 消さないので、報が何秒後に来るかは関係がない。
 *
 * 上限の側は、EEW のカード自体が最終報から 60 秒以上出ていることに対して十分短いこと
 * ―― 変化が止まったあと、帯だけが居座らない。
 *
 * **これは実時計で測る。** 画面に出ている時間は利用者が読むのに要る時間なので、リプレイの
 * 再生時計（`useEarthquakes` が電文の失効に使っているもの）には乗せていない。再生に倍速を
 * 入れるなら、ここを見直すかどうかを判断すること。
 */
export const EEW_FORECAST_CHANGE_HOLD_MS = 10_000

/**
 * 到達予測の一覧で、残り秒数を差し迫ったものとして色分けする境目。
 *
 * **実電文の分布から決めた。** 未到達の区域 4,004 件で、発表から到達までは中央値 17 秒・
 * p90 44 秒（2025-01-02〜2026-09-11 の VXSE45 9,871 通を走査）。20 秒で切ると、強調される
 * 区域は 1 報あたり中央値 6 件・最大 18 件に収まる。境目を広げるほど一覧の大半が赤くなり、
 * 「差し迫っている」の意味が薄れる。
 */
const ARRIVAL_SOON_SEC = 20

/**
 * 到達予測の一覧を折り返す、列の最小幅と列数の上限（CSS の `columns` へ渡す）。
 *
 * **列数を画面幅で分岐させず、ブラウザに決めさせる。** パネルの実寸は左右分割で約 359px・
 * 上下分割ではビューポート幅ぶん（実測 873px）と倍以上違ううえ、UI 倍率（`uiScale`）でも動く。
 * `columns: <最小幅> <上限>` なら入るだけ列が作られ、狭い端末では自然に 1 列へ落ちる。
 *
 * 最小幅は行の中身から決めた —— 震度バッジ（`ARRIVAL_BADGE_WIDTH`）＋区域名 7 文字＋残り秒数。
 * **rem で持つ**ので UI 倍率を上げれば列の幅も一緒に伸びる（px 固定だと、文字だけ大きくなって
 * 区域名が切れる）。上限を置くのは、広い画面で 5 列・6 列になると 1 行の対応を目で追えなくなるため。
 */
const ARRIVAL_COLUMN_MIN_WIDTH = '10.5rem'
const ARRIVAL_COLUMN_MAX_COUNT = 3
/**
 * 震度バッジの**最小**幅。「5弱」「5強」が入る値で、全行そろえて縦に並べるために置く。
 *
 * **固定幅にしない。** 上限が定まらない予想には「程度以上」が付き（→ `getIntensityLabelWithApproxAbove`）、
 * 「6強程度以上」は 6 文字になる。固定幅だと折り返して 2 行になり、その行だけ高さが崩れる
 * （テストボタンの EEW 初報がこの形を持つ）。**語は縮められない** —— 気象庁の表現をそのまま使う
 * 決まりなので（→ docs/spec/eew-spec.md §4）、伸びる側で受ける。
 */
const ARRIVAL_BADGE_MIN_WIDTH = '1.75rem'

/**
 * 気象庁が「予想が変わった」と書いてきた帯（電文の `Appendix`）を、最低
 * {@link EEW_FORECAST_CHANGE_HOLD_MS} は出し続ける。
 *
 * **電文はそれを 1 通しか言わない。** 実電文（2026-06-01〜09-06・334 イベント）では、変化を
 * 立てた 55 通の次の報までの間隔が中央 1 秒で、**次の報は値を 0 に戻す**（第 1 報を除く
 * ほぼ全通が `Appendix` を持ち、変化が無いときは 0 を載せてくる）。報の状態をそのまま描くと
 * 帯は 1 秒で消え、実質誰も読めない。
 *
 * **保持の判定は `Appendix` の有無ではなく「変化を伝える値か」で行う**
 * （`eewForecastChangeText` が非空を返すか）。オブジェクトの有無で見ると、変化なしの続報を
 * 「新しい値」として採ってしまい、保持が効かない。
 *
 * **新しい変化が来たら差し替えて計時し直す。** 保持は「変化なしの報で消さない」ためのもので、
 * 気象庁が言い直したものを抑えるためではない（実測では 55 通のうち 33 通が 10 秒以内に別の
 * 文言へ差し替わる）。
 *
 * **計時を張り直す契機は報番号。文言の変化では足りず、`eew` の参照でも見てはいけない。**
 * 同じ文言が離れた報で再び立つ形が実在する（55 通中 5 通）ので文言だけでは 2 度目を拾えない。
 * 一方で `eew` の参照は「新しい報が届いた」ことの**代理値にすぎない** ―― `useEarthquakes` は
 * 報の到着以外でも EEW を作り直す（standard 版の区域・震源要素の注ぎ足し、取消の適用）。
 */
function useHeldForecastChange(eew: EEWAlert): string {
  const text = eewForecastChangeText(eew)
  const serial = eewSerial(eew)
  const [held, setHeld] = useState(text)
  const timerRef = useRef(0)
  useEffect(() => {
    // 変化を伝えていない報では何もしない ―― 消さずに据え置くのがこのフックの本体。
    if (!text) return
    setHeld(text)
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setHeld(''), EEW_FORECAST_CHANGE_HOLD_MS)
  }, [text, serial])
  useEffect(() => () => window.clearTimeout(timerRef.current), [])
  // 取消の報では出さない。取り下げた予想について「大きくなりました」と並べても意味がない。
  //
  // **隠しているのはこの判定そのもの。** 取消電文は `Appendix` を持たないが、状態更新は
  // 取消を `{ ...表示中の EEW, cancelledAt }` の形で当てるため（`useEarthquakes` の eew ケース）、
  // **直前の報の `forecastChange` がそのまま残る**。`text` が空になることを当てにして
  // この判定を外すと、取り下げた予想の帯が復活する。
  return eew.cancelledAt ? '' : held
}

/**
 * 1 秒ごとに現在時刻を進める。到達予測の一覧が出す残り秒数のために使う。
 *
 * **`active` が false の間はタイマーを持たない。** 条件は 2 つ。
 *
 * - 到達予測の欄が出るのは区域を持つ報だけ（実電文では VXSE45 の 85.2% が区域 0 件 ——
 *   9,871 通中 8,410 通）。常に回すと、その欄を出していない EEW カードまで毎秒再描画される
 * - **画面に出ていない間も止める。** タブは全部マウントしたままなので、別のタブを見ている間も
 *   回り続ける。同じファイルの検知カードが `visible && pageVisible` で同じ扱いをしている
 *
 * **止めている間に進んだぶんは、再開した瞬間に合わせる**（`setNow` を先に 1 回呼ぶ）。これが
 * 無いと、タブへ戻った直後の 1 秒だけ古い残り秒数が出る —— ブラウザは非可視タブの
 * `setInterval` を数十秒まで間引くので、ずれは 1 秒では済まない。
 *
 * **時刻は `serverNow()` から採る。** 壁時計を使うと、端末の時計がずれている場合と
 * リプレイ中（再生時計は `serverNow` にだけ反映される）に残り秒数が実際と食い違う。
 */
function useSecondTick(active: boolean): number {
  const [now, setNow] = useState(() => serverNow())
  useEffect(() => {
    if (!active) return
    setNow(serverNow())
    const id = window.setInterval(() => setNow(serverNow()), 1000)
    return () => window.clearInterval(id)
  }, [active])
  return now
}

/**
 * 区域の到達予測時刻から残り秒数を出す。**読めない時刻は `null` を返す。**
 *
 * `EEWRegion.arrivalTime` は XML 経路では読めることを確かめてある（`dmdataParser.ts` の
 * `readTelegramDateTime`）が、**そこを通らない経路がある**（テストデータ・履歴アーカイブ）。
 * 素朴に引き算すると `NaN` になり、
 * **`NaN > 0` が偽なので「まもなく」へ落ちる** —— 壊れた値が「もうすぐ来る」という
 * 確度の高い表示に化ける。旧実装（絶対時刻をそのまま出す）は `NaN:NaN:NaN` と出て
 * 異常だと判った。**読めないものは読めないと出す。**
 *
 * **記録はここでしない。** この関数はレンダーのたび（毎秒の再描画を含む）に区域の数だけ
 * 呼ばれるので、ここへログを置くと壊れた区域 1 つで 1 秒ごとに記録が出続ける。
 * 記録は `EEWCard` 側で**報ごとに 1 行へまとめる**（→ docs/spec/data-sources-spec.md §2）。
 */
function arrivalEtaSec(arrivalTime: string, nowMs: number): number | null {
  const ms = new Date(arrivalTime).getTime()
  return Number.isFinite(ms) ? Math.round((ms - nowMs) / 1000) : null
}

function EEWCard({ eew, visible, activeLpgmEventId, onToggleLpgm, onDeactivateLpgm }: {
  eew: EEWAlert
  /**
   * このカードが利用者の目に入っているか（リアルタイムタブが選ばれていて、パネルが畳まれておらず、
   * ブラウザのタブも表に出ている）。**用途は到達予測の残り秒数を進めるタイマーの開閉だけ。**
   * 検知カードが受け取るものと同じ合成（→ `KyoshinDetectionSummary`）。
   */
  visible: boolean
  activeLpgmEventId?: string | null
  onToggleLpgm?: (eventId: string) => void
  onDeactivateLpgm?: () => void
}) {
  const { scale: maxScale, orAbove: maxScaleOrAbove } = eewMaxScaleInfo(eew)
  const { cls: lpgmClass, over: lpgmClassOver } = eewMaxLpgmClassInfo(eew)
  const level = computeSingleEEWLevel(eew)
  const isWarning = level >= 1
  const isSpecial = level === 2
  const areas = eewAreas(eew)
  const serial = eewSerial(eew)
  const { hypocenter } = eew.earthquake
  // **値が無いときは整形を呼ばない。** 呼ぶと「読めない値が来た」として記録され、
  // 「電文が時刻を持たない」ことと区別が付かなくなる（他の呼び出しと表記も揃う）。
  const originTimeText = eew.earthquake.originTime ? formatDateTime(eew.earthquake.originTime) : null
  // 震源要素が推定できず、PLUM 法による震度予測だけが有効な状態。震源・規模・深さは固定の仮定値
  // （観測点直下 10km・M1.0）なので、数値は伏せ、地名には未確定である旨を添える。
  const isAssumed = eew.earthquake.condition === '仮定震源要素'
  const prefAreas = areas.filter(a => a.pref)

  // 気象庁が別の電文として発表する区分なので、その名称に合わせて名前も分ける（予報級＝VXSE45
  // 「緊急地震速報（地震動予報）」／警報級＝VXSE43「緊急地震速報（警報）」）。アプリが受信するのは
  // VXSE45 だけで、区分を決めるのは `severity`（→ utils/eew.ts の `eewKindLabel`）。
  // 予報級を「緊急地震速報（〜）」の器に入れると「緊急地震速報（地震動予報）」と二重になるため、
  // 器ごと分ける。
  const headerLabel = isSpecial ? '緊急地震速報（特別警報）'
    : isWarning ? '緊急地震速報（警報）'
    : '地震動予報'
  const headerBg = isSpecial ? '#4c0519' : isWarning ? '#450a0a' : '#451a03'
  const headerColor = isSpecial ? '#fca5a5' : isWarning ? '#f87171' : '#fcd34d'
  const headerBorder = isSpecial ? '#dc2626' : isWarning ? '#ef4444' : '#d97706'
  const cardBorder = isSpecial ? '#fca5a5' : isWarning ? '#ef4444' : '#eab308'

  const magColor = getMagnitudeColor(hypocenter.magnitude)
  const depthColor = getDepthColor(hypocenter.depth)

  // 予想が変わったこと（電文の `Appendix`）と震源要素の精度（`Accuracy`）。
  // どちらも DMDATA の XML 経路でだけ入る（standard 版では常に空）。
  // 前者は**その報にしか入らない**ので、表示の寿命はフックが持つ（理由はその宣言箇所）。
  const forecastChangeText = useHeldForecastChange(eew)
  const epicenterRankText = eewEpicenterRankLabel(eew.accuracy?.epicenterRank)
  // 深さの精度は震央と同じ表を引く（解説資料 Ⅱ.21 1-4-2-2）。**震央と同じ値のことが多い**ので、
  // 同じなら 1 行にまとめる —— 同じ文字列を 2 行並べても情報は増えない。
  //
  // **まとめるかどうかは生のランク値で比べる。** 表示文字列で比べると、深さのランクが 0（不明）や
  // 対応表に無い値のとき文字列が空になり、「同じ」と判定されてしまう。すると震央の精度が
  // 「震源」（震央＋深さ）としてまとめて出て、**深さの精度が不明であることが消える**。
  const depthRankText = eewEpicenterRankLabel(eew.accuracy?.depthRank)
  const depthRankDiffers = eew.accuracy?.depthRank !== eew.accuracy?.epicenterRank
  const magnitudeRankText = eewMagnitudeRankLabel(eew.accuracy?.magnitudeRank)
  const magnitudePointsText = eewMagnitudePointsLabel(eew.accuracy?.magnitudePoints)
  const hypocenterSettled = isEewHypocenterSettled(eew)
  const hasAccuracyText = !!(epicenterRankText || depthRankText || magnitudeRankText || magnitudePointsText || hypocenterSettled)

  // 主要動の到達について何か言える地域。**同じ要素に 3 通りの意味が入る**ので、並べる前に
  // 見分ける（電文解説資料 Ⅱ.21 2-1-5-3-6・2-1-5-3-7、気象庁コード表 12）。
  //
  // | 区域の状態 | 電文 | この欄の出し方 |
  // |---|---|---|
  // | まだ到達していない | `ArrivalTime`（到達予測時刻） | 残り秒数（「42秒」。0 以下は「まもなく」） |
  // | 既に到達したと推測 | `Condition`（→ `EEWRegion.arrived`）。時刻は出ない | 「到達済み」 |
  // | PLUM 法で予測 | `ArrivalTime`（**震度を初めて予測した時刻**＝過去） | 「時刻不明」 |
  //
  // **到達済みの地域を落とさない。** 時刻の有無だけで絞ると一覧から黙って消え、「到達した」のか
  // 「予想から外れた」のかが利用者に判らない。
  //
  // **PLUM 法の時刻を「到達予想」として出さない。** 走時を計算しない手法なので、値は到達の予測
  // ではなく予測を行った時刻。並べると、既に過ぎた時刻をこれから来るものとして読ませる。
  // **到達済みかどうかは `isEewAreaArrived` で判定する。** 電文の `Condition` は DMDATA でしか
  // 配信されないので、`arrived` だけを見ると standard 版（P2PQuake）で到達済みの地域が消える。
  // 種別コードは両経路が持つ（→ `utils/eew.ts`）。
  //
  // **このファイルには `arrived` が 2 つある。** ここで扱う区域の `arrived` は電文が伝える
  // 「既に主要動到達と推測」。下の S 波カウントダウンが持つ `SWaveArrival.arrived` は別物で、
  // 利用者が登録した地点への走時計算から出す到達済みフラグ（`nearbyStations.ts`）。
  const arrivalKindOf = (a: typeof areas[number]): 'arrived' | 'plum' | 'forecast' => {
    if (isEewAreaArrived(a)) return 'arrived'
    if (isEewPlumKindCode(a.kindCode)) return 'plum'
    return 'forecast'
  }
  // 並びは時間の順 ―― 到達済み → 未到達（到達の早い順）→ 到達時刻が判らないもの。
  //
  // **PLUM 法を末尾へ置く。** 以前は到達済みの次に置いていたが、この区域が持つ時刻は到達の
  // 予測ではない（→ `isEewPlumKindCode`）ので時間の軸に乗らない。乗らないものを途中へ挟むと、
  // 前後の行だけが時間順という読めない並びになる。実電文では 1 報あたり中央値 0 件・最大 15 件。
  const ARRIVAL_KIND_ORDER = { arrived: 0, forecast: 1, plum: 2 } as const
  const areasWithArrival = areas
    .filter(a => a.arrivalTime || isEewAreaArrived(a))
    .sort((a, b) => {
      const d = ARRIVAL_KIND_ORDER[arrivalKindOf(a)] - ARRIVAL_KIND_ORDER[arrivalKindOf(b)]
      if (d !== 0) return d
      // 同じ種類どうし。時刻を持たない組み合わせでは電文の順のまま並べる。
      if (!a.arrivalTime || !b.arrivalTime) return 0
      return a.arrivalTime.localeCompare(b.arrivalTime)
    })
  // 見出しの右肩に出す内訳。**PLUM 法の区域は「未到達」に数える** —— 気象庁は到達したと推測した
  // 区域に `Condition` を出すので、それが無い区域は到達済みとして扱えない（→ `isEewAreaArrived`）。
  // 行の右端には別途「時刻不明」と出るので、内訳と行のあいだで食い違いは起きない。
  const arrivedCount = areasWithArrival.filter(a => arrivalKindOf(a) === 'arrived').length
  // 残り秒数を 1 秒ごとに数え直す。欄を出していないカードと、画面に出ていない間はタイマーを持たない。
  const nowMs = useSecondTick(areasWithArrival.length > 0 && visible)
  // 日時として読めなかった到達予測時刻。**報ごとに 1 行へまとめて記録する** ——
  // 区域は数十個あり、しかも毎秒描き直すので、1 件ずつ出すと他の記録が埋もれる。
  // 鍵に値そのものを使うのは、同じ内容で描き直しただけのときに二重で記録しないため。
  const brokenArrivals = areasWithArrival
    .filter(a => arrivalKindOf(a) === 'forecast' && a.arrivalTime && !Number.isFinite(new Date(a.arrivalTime).getTime()))
    .map(a => `${a.name}="${a.arrivalTime}"`)
  const brokenArrivalsKey = brokenArrivals.join('|')
  useEffect(() => {
    if (!brokenArrivalsKey) return
    const sample = brokenArrivals.slice(0, 3).join(' / ')
    log.warn(`[eew] 区域の到達予測時刻を日時として読めません（${brokenArrivals.length} 件・残り秒数の代わりに「不明」と出します）: ${sample}`)
    // `brokenArrivals` は毎レンダー作り直される配列なので依存に入れない（鍵の文字列で足りる）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brokenArrivalsKey])

  return (
    <div
      className="bg-card rounded-lg overflow-hidden relative"
      style={{
        border: `2px solid ${cardBorder}`,
        boxShadow: `0 0 0 1px ${cardBorder}40`,
      }}
      onClick={onDeactivateLpgm}
    >
      {eew.cancelledAt && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 z-10 rounded-lg px-4">
          <span className="font-black text-white" style={{ fontSize: '3rem', lineHeight: 1.1 }}>キャンセル</span>
          <span className="text-sm font-bold text-white/90 mt-1">この緊急地震速報は取り消されました</span>
          {/* 気象庁が書いた取消しの概要（電文の `Body/Text`）。アプリが組み立てた文言ではないので
              そのまま出す。地震情報のカードと同じ扱い（quake-spec.md §8）。 */}
          {eew.cancelText && (
            // カードは `overflow-hidden` で、オーバーレイは `absolute inset-0`。**本文が下地の
            // 高さを超えると下が切れる**（読み上げは長文を画面へ委ねる設計なので、そこで切れると
            // 理由がどこにも残らない）。この要素の中でスクロールできるようにしておく。
            <span
              className="mt-2 text-center text-white/80 overflow-y-auto"
              style={{ fontSize: '0.75rem', lineHeight: 1.5, whiteSpace: 'pre-line', maxHeight: '40%' }}
            >
              {eew.cancelText}
            </span>
          )}
        </div>
      )}
      {/* 種別ヘッダー */}
      <div
        className="w-full py-1.5 px-4 text-center text-xs font-bold tracking-widest"
        style={{
          backgroundColor: headerBg,
          color: headerColor,
          borderBottom: `1px solid ${headerBorder}`,
        }}
      >
        {headerLabel}
        {/* 電文が自分で名乗っている運用種別（`Control/Status`）。**本物と見分けられるようにする** ——
            設定「試験報・訓練報を受信する」を有効にすると、検証用にこれらもカード・音・地図へ
            流している（`services/dmdata.ts`）ので、印が無いと画面では区別がつかない。 */}
        {eew.operationStatus && (
          <span
            className="ml-2 px-1.5 py-0.5 rounded font-bold"
            style={{ backgroundColor: '#1f2937', color: '#fcd34d', border: '1px solid #d97706' }}
          >
            {eew.operationStatus}報
          </span>
        )}
        {serial != null && <SerialBadge serial={serial} suffix={eew.isFinal ? ' 最終報' : ''} />}
      </div>

      {/* 画面が狭い・低い環境（roomy 未満＝スマホ縦/横）では余白と文字を詰め、
          対象地域や到達予想時刻がスクロールせずに見えるようにする。roomy 以上は従来の寸法。 */}
      <div className="flex flex-col gap-1.5 p-2 roomy:gap-2 roomy:p-3">
        {/* 最大震度バナー */}
        {maxScale > 0 ? (
          <div
            className="w-full rounded-lg py-1.5 px-3 flex items-center justify-center gap-2 roomy:py-3 roomy:px-4 roomy:gap-4"
            style={{
              backgroundColor: getIntensityBgColor(maxScale),
              border: `2px solid ${getIntensityColor(maxScale)}`,
            }}
          >
            <span className="text-sm font-medium" style={{ color: getIntensityColor(maxScale) }}>
              予想最大震度
            </span>
            {/* 上限が定まらない報（「震度4程度以上」等）は語を落とさず出す。値だけにすると
                下限を断定した表示になる。語は本体より小さく添えて桁数の膨らみを抑える。
                **語は「程度以上」**（気象庁の表現。→ `getIntensityLabelWithApproxAbove`）。
                ここだけ自前で組んでいるため、語を変えたときに取り残されやすい —— 実際に
                タイトル・読み上げ・共有カードだけ直り、このバナーが「以上」のまま残った。 */}
            <span className="font-black leading-none text-[3rem] roomy:text-[4.5rem]" style={{ color: '#ffffff' }}>
              {getIntensityLabel(maxScale)}
              {maxScaleOrAbove && <span className="font-bold text-[1.25rem] roomy:text-[1.75rem]">程度以上</span>}
            </span>
          </div>
        ) : (
          <NoForecastBanner eew={eew} />
        )}

        {/* 推定最大長周期地震動階級（クリックで地図表示トグル）。地域別 lgIntTo 優先のため
            電文全体の forecastMaxLpgmClass が無くても地域別データがあれば表示する（eewMaxLpgmClass参照）。
            **震度を出せない報では階級も出さない**（判定は `canPresentLpgmClass`・読み上げと同じ述語）。
            出すと「予想震度なし」バナーの真下に階級の断言が並ぶ。 */}
        {canPresentLpgmClass(maxScale, lpgmClass) && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleLpgm?.(eew.issue?.eventId ?? eew.id) }}
            className="w-full rounded-lg py-1 px-3 flex items-center justify-center gap-2 hover:opacity-80 transition-opacity roomy:py-2 roomy:px-4 roomy:gap-4"
            style={{
              backgroundColor: getLpgmClassBgColor(lpgmClass),
              // 枠線・アウトラインは装飾のヘアラインのため px 据え置き（UI 倍率に連動させない）。
              // 文字・余白側は rem で書いてあり倍率に追従する。
              border: `2px solid ${getLpgmClassColor(lpgmClass)}`,
              outline: activeLpgmEventId === (eew.issue?.eventId ?? eew.id)
                ? `2px solid ${getLpgmClassColor(lpgmClass)}`
                : undefined,
              outlineOffset: '2px',
            }}
          >
            <span className="text-xs font-medium roomy:text-sm" style={{ color: getLpgmClassColor(lpgmClass) }}>
              推定長周期地震動
            </span>
            <span className="text-xl font-black roomy:text-2xl" style={{ color: '#ffffff' }}>
              {getLpgmClassLabelWithApproxAbove(lpgmClass, lpgmClassOver)}
            </span>
          </button>
        )}

        {/* 気象庁の固定付加文（避難行動の呼びかけ）。**予想値のバナー群の直後に置く** ——
            電文が言う唯一の行動指示なので、カードの末尾では区域一覧の下に埋もれる。
            震度バナーと長周期バナーは対になっているので、その間には割り込ませない。

            **実電文では警報級の報にしか入らない。** 購読分類 `eew.forecast` のアーカイブ
            全 7,995 通（2026-05-01〜09-11）で、付加文があったのは警報級の 380 通だけ。
            予報級 7,615 通には 1 件も無い（文言もコード `0201`「強い揺れに警戒してください。」
            1 種類）。警告色で出しても予報級のカードが騒がしくならないのはこのため。
            色は区分に追随させる（予報級に別の付加文が入ったときに赤で断定しない）。

            **読み上げには載せない** —— EEW の読み上げは秒を争うため、定型文を挟むと
            震度・地域が遅れる。取消電文では出さない（そのときの本文は付加文ではなく取消の理由）。

            **取消かどうかは `cancelledAt` で見る。** `cancelled` は受け取った電文そのものが
            取消報かを表すフラグで、**画面が持つ EEW には伝わらない** —— 状態更新は取消を
            `{ ...表示中の EEW, cancelledAt }` の形で当てるため（`useEarthquakes` の eew ケース）、
            `cancelled` は取消前の値（`false`）のまま残る。`!eew.cancelled` と書いていた版が
            あったが、あれは常に真で、実際に隠していたのは取消オーバーレイだった
            （`useHeldForecastChange` が同じ理由で `cancelledAt` を見ている）。 */}
        {/* 対象地方と行動指示を同じ枠に入れ、対象を先に・一段大きく置く（理由と実測は
            → `docs/spec/eew-spec.md` §3「固定付加文」）。
            **どちらか片方しか無くても枠は出す** —— 片方を条件にすると、欠けたときにもう片方ごと消える。
            下の「対象地域」は府県予報区で粒度が違うため別に出す。 */}
        {(eew.warningComment || (eew.warningRegions?.length ?? 0) > 0) && !eew.cancelledAt && (
          <div
            className="w-full rounded-lg py-1.5 px-3"
            style={{
              backgroundColor: `${headerBorder}26`,
              border: `2px solid ${headerBorder}`,
              color: '#ffffff',
              lineHeight: 1.5,
            }}
          >
            {(eew.warningRegions?.length ?? 0) > 0 && (
              <div className="font-bold text-[1.125rem] roomy:text-[1.3125rem]">
                {/* **並びは読み上げと同じ標準順へ揃える**（`sortEewWarningRegions`）。
                    電文の文書順は続報で入れ替わるので、そのまま出すと聞いた順と食い違う。
                    区切りが下の「対象地域」欄（` / `）と違うのは、こちらを見出しの大きさで
                    並べているため —— 日本語で地名を続ける書き方に寄せてある。 */}
                {sortEewWarningRegions(eew.warningRegions!).join('・')}
              </div>
            )}
            {eew.warningComment && (
              <div
                className="font-bold text-[0.9375rem] roomy:text-[1.0625rem]"
                style={{ whiteSpace: 'pre-line' }}
              >
                {eew.warningComment}
              </div>
            )}
          </div>
        )}

        {/* 地震発生時刻（`Earthquake/OriginTime`）。**緊急地震速報はここだけ発現時刻へ揃えていない。**
            地震情報・津波・長周期は発現時刻（`ArrivalTime`）を出すようにしてあるが、緊急地震速報は
            両方の時刻が秒値まで有効で他の種別と性質が違い、**ずれの実態を測っていない**。
            意図的に据え置いているのであって、ずれないと確かめたわけではない
            （→ `docs/spec/eew-spec.md` §3「地震の時刻は発生時刻を出す」）。

            日時として読めなければ欄ごと出さない（「ごろ」だけが残ると、時刻を
            読み落としたのか電文が出していないのか分からない）。 */}
        {originTimeText && (
          <div className="text-secondary text-[0.9375rem] roomy:text-[1.125rem]">
            {originTimeText}ごろ
          </div>
        )}

        {/* 震源名。仮定震源要素のときの地名は「最初に揺れを捉えた観測点の所在地」であって
            震源の推定位置ではないため、断定して見えないよう注記を添える（M・深さを伏せるのと同じ理由）。 */}
        <div className="font-bold text-white leading-tight text-[1.25rem] roomy:text-[1.625rem]">
          {hypocenter.name || '震源調査中'}
          {isAssumed && hypocenter.name && (
            <span className="ml-1.5 font-medium text-[0.8125rem] roomy:text-[1rem]" style={{ color: '#9ca3af' }}>
              （震源未確定）
            </span>
          )}
          {/* 内陸か海域か（電文の `LandOrSea`）。海域なら津波を思い浮かべる手がかりになる。
              仮定震源要素のときは地名自体が震源の推定位置ではないので添えない。 */}
          {eew.landOrSea && !isAssumed && (
            <span className="ml-1.5 font-medium text-[0.8125rem] roomy:text-[1rem]" style={{ color: '#9ca3af' }}>
              （{eew.landOrSea}）
            </span>
          )}
        </div>

        {/* 予想が変わったこと（電文の `Appendix`）。**気象庁が「変わった」と書いてきた事実だけを出す**
            —— アプリが続報どうしを比べて推定した結果ではない。理由まで電文に入っている。
            **出し続ける長さは報の状態と切り離してある**（→ `useHeldForecastChange`）。 */}
        {forecastChangeText && (
          <div
            className="w-full rounded-lg py-1 px-3 text-[0.8125rem] font-medium roomy:text-sm"
            style={{ backgroundColor: 'rgba(42,42,42,0.8)', border: '1px solid #4b5563', color: '#d1d5db' }}
          >
            {forecastChangeText}
          </div>
        )}

        {/* マグニチュード・深さ（2カラムグリッド）：仮定震源要素のときは固定の仮定値のため非表示 */}
        {hypocenter.name && !isAssumed && (
          <div className="grid grid-cols-2 gap-2">
            <div
              className="flex flex-col gap-0.5 rounded-lg p-2 roomy:gap-1 roomy:p-2.5"
              style={{
                backgroundColor: `${magColor}26`,
                border: `2px solid ${magColor}`,
              }}
            >
              <span className="text-xs font-medium tracking-wide" style={{ color: magColor }}>
                マグニチュード
              </span>
              <span className="font-black leading-none text-[1.25rem] roomy:text-[1.5rem]" style={{ color: '#ffffff' }}>
                {hypocenter.magnitude.toFixed(1)}
              </span>
            </div>
            <div
              className="flex flex-col gap-0.5 rounded-lg p-2 roomy:gap-1 roomy:p-2.5"
              style={{
                backgroundColor: `${depthColor}26`,
                border: `2px solid ${depthColor}`,
              }}
            >
              <span className="text-xs font-medium tracking-wide" style={{ color: depthColor }}>
                深さ
              </span>
              <span className="font-black leading-none text-[1.25rem] roomy:text-[1.5rem]" style={{ color: '#ffffff' }}>
                {hypocenter.depth}km
              </span>
            </div>
          </div>
        )}

        {/* 対象地域（警報域と予報域を区別して表示）。

            **電文が載せた府県予報区を全部出す。** 以前は先頭 6 件で切って残りを「...」へ落として
            いたが、対象が広がる報ほど溢れる —— 能登本震（VXSE45・全 46 報）の最終報は警報 21・
            予報 14 の府県予報区を載せており、6 件で切ると警報側は 7 割、予報側は 6 割が
            「...」の中だった。**いちばん対象が広いときにいちばん見えない**という、すぐ下の
            「主要動の到達（予測）」で直したのと同じ形。長い並びは名前の span の中でテキストとして
            折り返り、行の高さが伸びて収まる（下の `flex-wrap` はラベルと名前の 2 つが 1 行に
            入らないときの縦積み用で、折り返しの主体ではない）。 */}
        {prefAreas.length > 0 && (() => {
          // 種別は府県予報区より細かい一次細分区域ごとに付くため、1 つの県に警報の区域と
          // 予報の区域が混ざる（能登本震では石川・新潟・長野などが該当）。**両方へ出さず
          // 警報の側だけに残す** —— 並べると、警報が出ている県が予報の列にも現れて一段軽く見える。
          const warningPrefSet = new Set(prefAreas.filter(a => isEewWarningKindCode(a.kindCode)).map(a => a.pref))
          const warningPrefs = [...warningPrefSet]
          const forecastPrefs = [...new Set(prefAreas.filter(a => !isEewWarningKindCode(a.kindCode)).map(a => a.pref))]
            .filter(pref => !warningPrefSet.has(pref))
          const hasKindCode = prefAreas.some(a => a.kindCode !== '')
          if (!hasKindCode) {
            // 種別を持たない経路（P2PQuake）。同じ県の細分区域が複数並ぶので重複を畳む。
            return (
              <div className="text-xs text-secondary leading-relaxed">
                対象: {[...new Set(prefAreas.map(a => a.pref))].join(' / ')}
              </div>
            )
          }
          return (
            <div className="flex flex-col gap-0.5 text-xs">
              {warningPrefs.length > 0 && (
                <div className="flex items-start gap-1 flex-wrap">
                  <span className="text-red-300 font-bold flex-shrink-0">警報:</span>
                  <span className="text-secondary">{warningPrefs.join(' / ')}</span>
                </div>
              )}
              {forecastPrefs.length > 0 && (
                <div className="flex items-start gap-1 flex-wrap">
                  <span className="text-yellow-300 flex-shrink-0">予報:</span>
                  <span className="text-secondary">{forecastPrefs.join(' / ')}</span>
                </div>
              )}
            </div>
          )
        })()}

        {/* 主要動の到達。**電文が載せた区域を全部出す。**
            以前は先頭 6 件だけを出して残りを「他 N 地域」の数字へ落としていたが、実電文を
            走査すると（2025-01-02〜2026-09-11・VXSE45 9,871 通）、区域を持つ報 1,461 通のうち
            27.7% が 6 件を超え、最大 56 件。**最大予想震度が 6 弱以上の報では 97% が溢れていた**。
            しかも並びが種別順（到達済みが先頭）だったため、**未到達の区域を持つ報の 24.9% で
            それが 1 件も見えていなかった**（6 弱以上に限れば 65%）。件数で切るのをやめ、
            並びを時間順に直した。

            **見出しに「予測」を残す。** 3 通りとも気象庁の予測・推測で、確定した事実ではない。
            中立な見出しにすると、秒数の行だけが断り書きを持たないまま確定値の顔をする
            （他の 2 通りは「推測」「不明」と語の中に断りがある）。
            意味の違いは `DescriptionTip` でホバーへ逃がす —— 同じカードの「精度情報」と同じ流儀。 */}
        {areasWithArrival.length > 0 && (
          <div className="flex flex-col gap-0.5">
            <div className="flex items-baseline justify-between gap-2 text-xs text-secondary">
              <DescriptionTip
                label="主要動の到達（予測）"
                description={[
                  '気象庁が区域ごとに出す予測です。強い揺れが予想される区域だけが載ります。',
                  '左の数字＝その区域の予想最大震度。',
                  '秒数＝主要動が届くまでの残り時間。気象庁の到達予測時刻から計算しています。',
                  '到達済み＝気象庁が「既に主要動到達と推測」と伝えてきた区域。実際に揺れを観測したという意味ではありません。',
                  '未到達＝主要動がまだ届いていないと推測される区域。到達時刻を出せない区域（下記）も含みます。',
                  '時刻不明＝周辺の観測点で実際に観測された揺れから震度を予測している区域（気象庁のPLUM法）。震源からの伝わり方を計算しないため、到達時刻は出ません。',
                ].join('\n')}
              />
              {/* 内訳。**「未到達」は気象庁コード表 12 の語幹**（→ docs/spec/eew-spec.md §4）。
                  後ろに語を足さないのは、コード表の写しが手元で「未到達と予測／予想／推測」に
                  割れていて一次資料で確定できていないため。 */}
              <span className="flex-shrink-0 tabular-nums">
                到達済み {arrivedCount} ／ 未到達 {areasWithArrival.length - arrivedCount}
              </span>
            </div>
            {/* 列で折り返す。**行を縦に揃えたまま高さを縮める唯一の手** —— 1 列のままだと
                56 件で 1,000px を超え、パネルの可視高（上下分割で実測 434px）に到底入らない。
                読み順は段組みの既定どおり「左列を上から下、次に右列」。時間順に読むならこれが素直。 */}
            <div
              style={{
                columns: `${ARRIVAL_COLUMN_MIN_WIDTH} ${ARRIVAL_COLUMN_MAX_COUNT}`,
                columnGap: '0.75rem',
              }}
            >
              {areasWithArrival.map((a, i) => {
                const kind = arrivalKindOf(a)
                // 残り秒数。**到達予測時刻を持つ区域だけ**が対象で、PLUM 法の時刻は使わない
                // （値は到達の予測ではなく、その震度を初めて予測した時刻 ＝ 過去）。
                // 読めない時刻は `null` が返り、下で「不明」と出す（→ `arrivalEtaSec`）。
                const etaSec = kind === 'forecast' && a.arrivalTime
                  ? arrivalEtaSec(a.arrivalTime, nowMs)
                  : null
                // **震度スケール外の値でも区域を落とさない。** `eewMaxScaleInfo` は最大値を
                // 求める関数なので `isValidIntensityScale` で弾くが、この欄は「電文が載せた区域を
                // 全部出す」のが役目で、弾くと区域そのものが画面から消える（到達の情報まで失う）。
                // 両関数がフォールバック（色 `#666666`・語「不明」）を持つので、
                // 壊れた値はバッジが「不明」になる形で画面に出る。
                const scaleColor = getIntensityColor(a.scaleTo)
                return (
                  // **行を分断させない。** 段組みは既定で要素を列の境目で割るので、
                  // 震度バッジと区域名が別の列へ離れる。
                  <div key={i} className="flex items-center gap-1.5 text-xs" style={{ breakInside: 'avoid' }}>
                    {/* 震度バッジ。色は地図・震度一覧と同じ気象庁配色（`getIntensityColor`）で、
                        文字色は背景から選ぶ（`readableTextColor`）。上限が定まらない予想は
                        「程度以上」の語を補う（→ `getIntensityLabelWithApproxAbove`）。 */}
                    <span
                      className="flex-shrink-0 rounded text-center leading-4 whitespace-nowrap"
                      style={{
                        minWidth: ARRIVAL_BADGE_MIN_WIDTH,
                        padding: '0 0.125rem',
                        fontSize: '0.625rem',
                        background: scaleColor,
                        color: readableTextColor(scaleColor),
                      }}
                    >
                      {getIntensityLabelWithApproxAbove(a.scaleTo, a.scaleToOrAbove === true)}
                    </span>
                    <span className={`flex-1 truncate ${kind === 'arrived' ? 'text-secondary' : 'text-white'}`}>
                      {a.name}
                    </span>
                    {kind === 'arrived' ? (
                      // 気象庁の語は「既に主要動到達と推測」。**断定しない** —— 到達したかどうかは
                      // 気象庁の推測であって、観測した事実ではない。
                      <span className="text-secondary flex-shrink-0">到達済み</span>
                    ) : kind === 'plum' ? (
                      // PLUM 法は周辺の観測点で実際に観測された揺れから震度を出す手法で、走時を
                      // 計算しない。**電文の時刻は到達の予測ではない**ので出さない。
                      // **語は状態そのものを書く。** ここへ手法の名前を置くと、他の 2 通りが
                      // 時間軸上の位置を伝えているのにここだけ伝えないことになる。
                      // 手法（PLUM 法）の説明は見出しのホバーへ逃がしてある。
                      //
                      // **4 文字に収める。** 右端の語は「到達済み」「まもなく」「NN秒」と 4 文字以内で、
                      // ここだけ「到達時刻は不明」（7 文字）にすると 2 列では区域名の幅を食って名前が
                      // 切れる（実測: パネル幅 359px の左右分割で「秋田県沿岸北部」が「秋田県…」になった）。
                      // 列の最小幅を広げる手もあるが、2 列を保てなくなり 56 件で 896px へ伸びる。
                      // 何の時刻かは見出し（「主要動の到達（予測）」）が与えている。
                      <span className="text-secondary flex-shrink-0">時刻不明</span>
                    ) : (
                      // **残り秒数で出す。** 以前は電文の時刻をそのまま（16:53:47）出していたが、
                      // 揺れが来るまで何秒かを読み手に引き算させることになる。同じカードの
                      // S 波カウントダウンが「あと N 秒」で出しているので、尺度もそちらへ揃う。
                      //
                      // **0 以下は「まもなく」。** 予測時刻を過ぎても気象庁が `Condition` を
                      // 出すまでは到達済みにならないので、負の秒数が数秒続く。
                      //
                      // **時刻を読めなかった区域を「まもなく」に混ぜない**（`etaSec` が `null`）。
                      // 差し迫っていることと、値が壊れていることは別の事実。
                      <span
                        className="font-mono flex-shrink-0 tabular-nums"
                        style={{ color: etaSec !== null && etaSec <= ARRIVAL_SOON_SEC ? '#fca5a5' : '#ffffff' }}
                      >
                        {etaSec === null ? '不明' : etaSec > 0 ? `${etaSec}秒` : 'まもなく'}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* 震源要素の精度（電文の `Accuracy`）。**数字ではなく資料の語で出す** —— 「ランク4」と
            書いても伝わらない。言い換えもしない（気象庁が「IPF法（5点以上）」と書いているものを
            「精度が高い」と要約すると、こちらが評価を足したことになる）。
            取消電文は `Earthquake` を持たないので自然に出ない。 */}
        {hasAccuracyText && (
          <div className="flex flex-col gap-0.5 text-xs text-secondary">
            {/* **語は資料のまま出すが、説明は添える。** 「言い換えない」と「説明しない」は別。
                IPF 法・P 相・EPOS は電文解説資料を読んだ人にしか通じないので、設定タブと同じ
                `DescriptionTip` で事実の解説をホバーに逃がす（評価は足さない）。 */}
            {/* **見出しも資料の語をそのまま使う。** 電文解説資料 Ⅱ.21 1-4-2 はこの要素群を
                「精度情報」と呼んでいる（下位も「震央位置の精度値」「深さの精度値」
                「マグニチュードの精度値」）。単独では何の精度か読み取りにくいので、
                説明はホバーで補う。 */}
            <DescriptionTip
              label="精度情報"
              description={[
                '気象庁が震源とマグニチュードをどう決めたかを、電文に書かれている語のまま出しています。',
                'IPF法＝観測点に届いたP波から震源を絞り込む手法（かっこ内は使った観測点の数）。',
                'P相・全相＝マグニチュードの計算にP波だけを使ったか、後続の波も使ったか。',
                'EPOS・防災科研システム＝震源を決めた計算機システムの名前。',
                // 資料の語をそのまま出すと決めた以上、その語に含まれる専門用語も説明する側で引き受ける。
                // 〔観測網外〕〔観測網内〕は「EPOS（海域〔観測網外〕）」の形でしか出ないが、
                // 語だけでは何と対比しているのか分からない。
                '〔観測網外〕〔観測網内〕＝地震が陸上の観測網の外（主に海域）で起きたか、内（陸域）で起きたか。',
              ].join('\n')}
            />
            {epicenterRankText && (
              <div className="flex items-start gap-2">
                <span className="flex-shrink-0">{depthRankDiffers ? '震央' : '震源'}</span>
                <span className="text-white break-words">{epicenterRankText}</span>
              </div>
            )}
            {depthRankText && depthRankDiffers && (
              <div className="flex items-start gap-2">
                <span className="flex-shrink-0">深さ</span>
                <span className="text-white break-words">{depthRankText}</span>
              </div>
            )}
            {(magnitudeRankText || magnitudePointsText) && (
              <div className="flex items-start gap-2">
                <span className="flex-shrink-0">Ｍ</span>
                <span className="text-white break-words">
                  {[magnitudeRankText, magnitudePointsText].filter(Boolean).join('・')}
                </span>
              </div>
            )}
            {/* **「最終報」とは書かない。** 資料は同じ注で「PLUM 法により予測震度が今後変化する
                可能性はある」と断っている —— 震源が決まっても予想震度は動きうる。 */}
            {hypocenterSettled && (
              <span className="text-white">震源とＭはこれ以降変わりません</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// 震度ラベルの降順（表示ソート用）
const LABEL_ORDER = ['7', '6強', '6弱', '5強', '5弱', '4', '3', '2', '1', '0']

function SWaveArrivalCard({ arrival }: { arrival: SWaveArrival }) {
  const borderColor = arrival.arrived ? '#ef4444' : '#f97316'
  // 余白のみ圧縮する。カウントダウンの数字は緊急度が高く、一目で読めることが要るため縮めない。
  return (
    <div className="bg-card rounded-lg p-2 border-2 roomy:p-3" style={{ borderColor }}>
      <div className="flex items-center gap-2 mb-1">
        <span
          className="inline-block w-2 h-2 rounded-full flex-shrink-0"
          style={{ backgroundColor: borderColor }}
        />
        <span className="text-xs font-bold" style={{ color: borderColor }}>
          {arrival.arrived ? 'S波 到達済み' : 'S波 到達カウントダウン'}
        </span>
        <span className="text-xs text-secondary ml-auto">震源から {arrival.distanceKm.toFixed(0)} km</span>
      </div>
      {arrival.arrived ? (
        <p className="text-red-400 font-bold text-sm">ご自宅付近にS波が到達しています</p>
      ) : arrival.etaSec !== null ? (
        <div className="flex items-baseline gap-2">
          <span className="text-4xl font-black text-white">{arrival.etaSec}</span>
          <span className="text-sm text-secondary">秒後に到達予想</span>
        </div>
      ) : (
        <p className="text-sm text-secondary">到達時間を推定中…</p>
      )}
      <p className="text-xs text-secondary mt-1">※推定値。実際の到達時間は異なる場合があります</p>
    </div>
  )
}

// 検知エンジンの確信度別スタイル。confirmed=赤・likely=橙・faint=淡青(震度0級・無音)・weak=灰。
// 反応が収まっている間の確信度チップの背景。主張を持たない灰で、白文字とのコントラストは約 7.6:1。
// 確信度の色を消しつつラベルは読める濃さを保つ（経緯は KyoshinDetectionSummary 内のコメント）。
// V2_TIER.weak.border と同値だが別概念のため独立に持つ（weak の配色を変えてもここは追従しない）。
const SETTLED_CHIP_BG = '#4b5563'

// `border` はチップの背景色として使う。白文字（12px 太字＝WCAG の Large Text 緩和に該当しない）を
// 載せるため 4.5:1 が要る。confirmed の #ef4444 は 3.76:1・likely の #d97706 は 3.19:1 で足りず、
// 一段暗い赤・橙へ落として白文字のまま 4.83:1 / 5.02:1 を確保している（気象庁配色ではないため
// 色自体を変えてよい）。カード背景（#0a0c10 相当）に対しても 4.05:1 / 3.90:1 あり沈まない。
const V2_TIER: Record<Confidence, { label: string; color: string; bg: string; border: string }> = {
  confirmed: { label: '検知', color: '#f87171', bg: '#450a0a', border: '#dc2626' },
  likely: { label: '可能性', color: '#fcd34d', bg: '#451a03', border: '#b45309' },
  faint: { label: '微弱', color: '#93c5fd', bg: 'rgba(30,41,59,0.55)', border: '#3b5b80' },
  weak: { label: '検出', color: '#9ca3af', bg: 'rgba(42,42,42,0.6)', border: '#4b5563' },
}

/**
 * faint の見出しを「微弱な揺れの兆候」から「揺れの兆候」へ切り替える計測震度。0.5 = 震度1。
 * 検知エンジンの `MIN_LIKELY_INTENSITY` と同じ境界（likely へ上げるかの震度の下限）。
 */
const KYOSHIN_FAINT_HEADING_INTENSITY = 0.5


/**
 * 検知の根拠（判定の内訳）。既定は畳んでおき、開いたときだけ表を出す。
 *
 * 一般利用者に読ませたいのは 1 行の要約（`gateShortfall`）までで、表のほうは検知エンジンの
 * 挙動を追う人向け。カードの主情報（推定最大震度・震度分布）を押しのけないよう、既定は閉じる。
 *
 * **地域ごとに 1 ブロック出す。** カード自体は複数の連結成分を「1 つの揺れ」として集約するが、
 * 判定は地域ごとに独立して走っているため、まとめると「どの地域の話か」が消える。
 */
function KyoshinGateDetail({ events }: { events: DetectionEvent[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="text-xs text-secondary hover:text-white underline decoration-dotted underline-offset-2"
      >
        {open ? '判定の内訳を閉じる' : '判定の内訳'}
      </button>
      {open && (
        <div className="flex flex-col gap-2 mt-1.5">
          {/* 番号は**イベント ID の順**で振る。`step()` が返す並びは最大震度の降順で毎フレーム
              並べ替わるため、渡された順に番号を振ると、震度が近い 2 地域が競り合っている間
              「地域1」「地域2」のラベルだけが別の地域へ移る。ID は生成順の連番で動かない */}
          {[...events].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true })).map((e, i) => {
            const notes = gateNotes(e)
            return (
              <div key={e.id} className="rounded p-2" style={{ background: 'rgba(255,255,255,0.05)' }}>
                {events.length >= 2 && (
                  <div className="text-xs text-secondary mb-1">{`地域 ${i + 1}（${V2_TIER[e.confidence].label}）`}</div>
                )}
                {/* 幅は中身に合わせる（`w-full` にすると見出しと数値が横いっぱいに離れて対応が読めない） */}
                <table className="text-xs">
                  <tbody>
                    {gateRows(e).map(r => (
                      <tr key={r.label}>
                        <td className="text-secondary py-0.5 pr-2">{r.label}</td>
                        <td className="py-0.5 pr-1 text-right font-mono text-white whitespace-nowrap">{r.value}</td>
                        <td className="py-0.5 text-secondary font-mono whitespace-nowrap">
                          {r.req != null ? `/ ${r.req}` : ''}
                        </td>
                        <td className="py-0.5 pl-2 w-4 text-right" aria-hidden={r.met == null}>
                          {r.met == null ? '' : r.met ? '✓' : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {notes.length > 0 && (
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {notes.map(n => (
                      <li key={n} className="text-xs text-secondary">{n}</li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
          {/* カード本文の「N観測点で反応」と数え方が違う。あちらは現在震度0以上の点を数え、
              こちらは判定が使う「床を明確に超えて継続中 or 直近に立ち上がった」点を数える。
              同じ画面に 2 つの点数が並ぶので、違うことは言っておく */}
          <p className="text-xs text-secondary">
            ※判定は 1 秒ごとに行います。「揺れ継続中の点」は判定に使う数え方で、上の観測点数とは基準が異なります
          </p>
        </div>
      )}
    </div>
  )
}

// 強震モニタ検知の集約カード。
// 近傍一致型の検知は震度5+ の大地震で有感域が複数の地域（連結成分）に分かれるため、コアは
// 複数の confirmed/likely イベントを同時に返す。これを「1 つの揺れ」として 1 枚に集約表示する
// （震源を推定しないため、揺れている地域数と全体の震度分布・推定最大震度を主情報とする）。
// 複数地域にまたがる場合は「広域」を示し、N 件の別地震のように見えるのを防ぐ。
function KyoshinDetectionSummary({ events, points, visible }: {
  events: DetectionEvent[]
  /** 地図の検知点マーカーが描くのと同一の点列（`deriveKyoshinView` が用意する）。 */
  points: DetectedPoint[]
  /** カードがユーザーの目に入っているか。バー幅スケールの張り直しの可否に使う。 */
  visible: boolean
}) {
  const scalePeakRef = useRef(0)
  // 最上位ティア（confirmed > likely > faint）。faint は無音・控えめ表示。
  const topTier: Confidence = events.some(e => e.confidence === 'confirmed')
    ? 'confirmed'
    : events.some(e => e.confidence === 'likely')
      ? 'likely'
      : 'faint'
  const tier = V2_TIER[topTier]
  // 一行の根拠を出す代表イベント。最上位ティアのうち最大震度が最大のもの（`deriveKyoshinView` が
  // 主 likely を選ぶのと同じ基準）。複数地域あるときは代表 1 件だけを 1 行に出し、地域ごとの
  // 内訳は折りたたみ（`KyoshinGateDetail`）へ回す
  const primary = events
    .filter(e => e.confidence === topTier)
    .reduce<DetectionEvent | null>((best, e) => (!best || e.maxIntensity > best.maxIntensity ? e : best), null)
  const shortfall = primary ? gateShortfall(primary) : null
  const isFaint = topTier === 'faint'
  // 見出しは**ティアではなく観測された震度**で選ぶ。faint には 2 種類あり、震度0 級のコヒーレント
  // 揺れと、震度1 以上に達しているが周囲の裏付けが取れなかったもの（設計書§32）が混ざる。
  // 後者に「微弱」と冠すると、実際に観測されている震度を過小に伝えることになる。
  const faintMax = events.reduce((m, e) => Math.max(m, e.maxIntensity), -Infinity)
  const heading = !isFaint
    ? '強震モニタ検知'
    : faintMax >= KYOSHIN_FAINT_HEADING_INTENSITY
      ? '揺れの兆候'
      : '微弱な揺れの兆候'
  const regionCount = events.length
  const earliestMs = events.reduce((m, e) => Math.min(m, e.originTimeMs), Infinity)
  const time = new Date(earliestMs).toLocaleTimeString('ja-JP', { hour12: false })

  // 点列は地図の検知点マーカーと**同一のもの**を props で受け取る（`deriveKyoshinView` が
  // 孤立した震度0点を除いて用意する）。以前はここでも同じ計算を組み立てていたが、同じ入力から
  // 同じ結果になることに頼ると、片方の実装を変えたときに黙って食い違う。
  // 数える対象は「現在震度0以上（計測震度 0.0 以上）の点」だけで、判定は kyoshinIndexToLabel が
  // 震度階級を返すかどうかに委ねる（震度0未満・欠測は null）。地図の検知点マーカー
  // （gl/kyoshinDetectedFeatures.ts の buildFeatures）も同じ判定で描くかどうかを決めており、
  // ここと基準を分けると表示点数が食い違う。
  const counts = new Map<string, { color: string; count: number }>()
  let maxIndex = 0
  let activeCount = 0
  for (const p of points) {
    const label = kyoshinIndexToLabel(p.index)
    if (!label) continue
    if (!counts.has(label)) counts.set(label, { color: kyoshinIntensityColor(p.index) ?? '#9ca3af', count: 0 })
    counts.get(label)!.count++
    activeCount++
    if (p.index > maxIndex) maxIndex = p.index
  }
  const maxLabel = kyoshinIndexToLabel(maxIndex)
  const maxColor = kyoshinIntensityColor(maxIndex) ?? '#9ca3af'
  const groups = LABEL_ORDER.filter(l => counts.has(l)).map(l => ({ label: l, ...counts.get(l)! }))
  const rawMaxCount = groups.reduce((m, g) => Math.max(m, g.count), 1)
  // バー幅のスケール（分母）は、カードが見えている間は**下げない**。瞬間値を分母にすると、
  // 最大だった震度の点数が減っただけで他のバーが伸び、揺れが収まっている最中に「増えた」と
  // 見えてしまう（分母が動いただけで点数は減っている）。上げるのは点数が増えたときだけなので、
  // 見ている間のバーの伸びは必ず実際の点数の増加を意味する。
  //
  // 代わりに、見えていない間は毎回いまの点数へ張り直す。跳ねても誰の目にも入らないうえ、
  // 次に見えた瞬間は必ず「いまの点数」基準になるので、前の揺れのピークを引きずらない。
  // 張り直しの契機は 3 つ（タブ移動・アプリのバックグラウンド・パネル折りたたみ）で、
  // 判定は `visible` に集約して App とカード側のフックで組み立てている。
  //
  // 副作用として、大地震の長い減衰期にこのタブを見続けるとバーは細いまま張り直らない。
  // 点数は各行の右端に数値で出ているので情報は失われず、タブを一度離れて戻れば張り直る。
  // 検知イベントが全て消えればこのカード自体がアンマウントされるため、地震と地震の間で
  // ピークが持ち越されることもない。
  //
  // 更新を描画中に行うのは、分母を**同じ描画で**使うため。effect へ移すと 1 描画分（＝1 秒）
  // 遅れた分母でバーを描くことになる。この書き込みは同じ入力に対して冪等なので StrictMode の
  // 二重描画では結果が変わらない。並行描画（`startTransition` / `Suspense`）を導入すると
  // 「破棄された描画の書き込みだけが残る」形になり得るため、その時はここを見直すこと
  // （現時点でこのプロジェクトはどちらも使っていない）。
  if (!visible || rawMaxCount > scalePeakRef.current) scalePeakRef.current = rawMaxCount
  const maxCount = Math.max(scalePeakRef.current, 1)
  // 反応点数は activeCount（現在震度0以上の点）をそのまま出す。以前は 0 のとき検知エンジンの
  // lastSize（点ごとのノイズ床を超えて継続中の数。絶対震度の下限とは別基準）へフォールバック
  // していたが、それだと「地図には検知点が 1 つも無いのにカードだけ N 観測点で反応と出る」
  // 局面が生まれる（イベント自体は HOLD_MS / LIKELY_HOLD_MS の間ラッチで生き続けるため）。
  // 揺れが収まったことは点数ではなく文言で伝える。

  // カードの枠・背景は最大震度の気象庁配色に合わせる（地図マーカー・EEW カードと一貫）。
  // 確信度（検知/可能性/微弱）は枠色ではなく左上のチップで示す。枠色にティア（確信度）を
  // 混ぜると、everConfirmed のラッチ（明滅防止）で confirmed が震度1未満まで減衰した後も
  // 保持され続ける間、震度0なのに赤枠のままになる不整合が起きるため、震度1未満は常に
  // 震度0の色（SHINDO0_COLOR）へフォールバックする（ティアには依存しない）。
  const maxJma = kyoshinIndexToJma(maxIndex)
  const hasIntensity = maxJma != null && maxJma.label !== '0'
  const frameBorder = hasIntensity ? getIntensityColor(maxJma.scale) : SHINDO0_COLOR
  const frameBg = hasIntensity ? getIntensityBgColor(maxJma.scale) : 'rgba(42,42,42,0.6)'

  // 反応中の観測点が無くなった状態（イベントは HOLD_MS / LIKELY_HOLD_MS のラッチで生き残るが、
  // 現在震度0以上の点は 1 つも無い）。ここでヘッダーを通常の強さで出したままにすると、
  // 「検知」の赤チップと本文の「観測点の反応は収まりました」が同じカードに並んで矛盾して見える。
  // ティアのラベルは確信度の判定結果なので変えず、色だけ主張の弱いものへ差し替えて現在の
  // 活動度を示す（枠色を最大震度に追従させているのと同じ考え方）。
  //
  // 弱め方は opacity ではなく**色の置き換え**で行う。CSS の opacity は要素を背景と合成するため、
  // 文字と背景の関係まで一緒に薄まって読みにくくなる。実測（カード背景 rgba(42,42,42,0.6) の上）:
  //   見出し   confirmed #f87171: 5.5:1 → α0.55 で 2.6:1
  //   チップ   confirmed #ef4444 上の白文字: 3.8:1 → α0.55 で 2.7:1
  // 置き換え後は見出し（text-secondary #94a3b8）が約 6.5:1、チップ（SETTLED_CHIP_BG 上の白文字）が
  // 約 7:1 で、いずれも読める濃さを保ったまま赤の主張だけが消える。
  //
  // なお activeCount は毎秒の生インデックスから算出するため、終息期に 0 と非 0 を往復すれば
  // 表示も往復する。猶予（ヒステリシス）は入れていない。猶予中の本文をどうするかで
  // 「activeCount が 0 なのに 0観測点で反応と出す」「本文とヘッダーで別条件を使い、今回揃えた
  // 『両者が同じ基準を見る』性質を壊す」「中間状態の文言を新設する」のいずれかになり、
  // 前 2 つは不整合、3 つ目は状態が 3 つに増える割に、往復自体が実地震のリプレイ検証
  // （2026-08-18・50 サンプル超）では観測されていないため見合わないと判断した。
  const settled = activeCount === 0

  return (
    <div className="rounded-lg overflow-hidden" style={{ border: `1px solid ${frameBorder}`, backgroundColor: frameBg }}>
      {/* ヘッダー: 確信度チップ・広域バッジ・時刻。枠色は最大震度、チップ色は確信度で 2 軸を分離。
          反応が収まっている間（settled）はチップ・見出しの色を灰へ置き換えて本文と印象を揃える。 */}
      <div className="flex items-center gap-2 px-3 py-1.5" style={{ borderBottom: `1px solid ${frameBorder}55` }}>
        <span
          className="text-xs font-bold px-1.5 py-0.5 rounded flex-shrink-0"
          style={{ backgroundColor: settled ? SETTLED_CHIP_BG : tier.border, color: '#fff' }}
        >
          {tier.label}
        </span>
        <span
          className={settled ? 'text-xs text-secondary' : 'text-xs'}
          style={settled ? undefined : { color: tier.color }}
        >
          {regionCount >= 2 ? `${heading}（広域・${regionCount}地域）` : heading}
        </span>
        <span className="text-xs text-secondary ml-auto font-mono">{time}</span>
      </div>
      <div className="flex gap-2 p-2 roomy:gap-3 roomy:p-3">
        {/* 推定最大震度 */}
        <div className="flex flex-col items-center justify-center flex-shrink-0" style={{ minWidth: '4.25rem' }}>
          <span className="text-xs text-secondary">推定最大震度</span>
          <span className="font-black leading-none text-white text-[2.25rem] roomy:text-[3rem]" style={{ textShadow: `0 0 12px ${maxColor}` }}>
            {maxLabel ?? '—'}
          </span>
        </div>
        <div className="flex flex-col gap-1.5 flex-1 min-w-0">
          {/* 震度分布（全メンバー観測点の集約） */}
          {groups.length > 0 && (
            <div className="flex flex-col gap-1">
              {groups.map(g => (
                <div key={g.label} className="flex items-center gap-2">
                  <span className="w-6 text-center text-xs font-bold rounded flex-shrink-0" style={{ backgroundColor: g.color, color: readableTextColor(g.color) }}>
                    {g.label}
                  </span>
                  <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
                    <div style={{ width: `${(g.count / maxCount) * 100}%`, height: '100%', background: g.color }} />
                  </div>
                  {/* バーの右端を揃えるため固定幅にするが、幅は 3 桁ではなく 4 桁に合わせる。強震モニタの
                      観測点は約 1700 点（Yahoo の SiteList 由来・年により変動）あり、震度0・1 の階級は
                      4 桁に届く。2rem では「1520点」が収まらず、CJK の「点」は直前で改行できてしまうため
                      「1520」と「点」に割れて行の高さが倍になる。`whitespace-nowrap` だけでは箱幅は
                      指定値のままで文字が溢れる（伸びる方向に min-content は効かない）ため、幅も一段
                      広げる。`flex-shrink-0` は縮まないことを明示する保険。 */}
                  <span className="text-xs text-white w-10 text-right whitespace-nowrap flex-shrink-0">{g.count}点</span>
                </div>
              ))}
            </div>
          )}
          <span className="text-xs text-secondary">
            {activeCount > 0
              ? `${activeCount}観測点で反応${regionCount >= 2 ? ` ・ ${regionCount}地域` : ''} ・ 推定値`
              : `観測点の反応は収まりました${regionCount >= 2 ? ` ・ ${regionCount}地域` : ''}`}
          </span>
          {/* 確信度チップが「どの段か」を示すのに対し、この行は「なぜその段なのか」を示す。
              言うことが無ければ行ごと出さない（`gateShortfall` が null を返す） */}
          {shortfall && <span className="text-xs text-secondary">{shortfall}</span>}
          <KyoshinGateDetail events={events} />
        </div>
      </div>
    </div>
  )
}

// React.memo 化の理由と props 参照安定性の要件は docs/spec/architecture-spec.md 参照。
export const RealtimeTab = memo(function RealtimeTab({ eews, kyoshinV2Detections, kyoshinDetectedPoints, swaveArrival, visible, activeLpgmEventId, onToggleLpgm, onDeactivateLpgm }: Props) {
  // ブラウザのタブ・ウィンドウ側の可視性は App では判らないため、ここで合成する。
  const pageVisible = usePageVisible()
  return (
    <div className="flex flex-col min-h-full p-2 gap-2 roomy:p-3 roomy:gap-3">
      {/* データカード */}
      {[...eews]
        .sort((a, b) => b.earthquake.originTime.localeCompare(a.earthquake.originTime))
        .map(eew => (
          <EEWCard
            key={eew.issue?.eventId ?? eew.id}
            eew={eew}
            visible={visible && pageVisible}
            activeLpgmEventId={activeLpgmEventId}
            onToggleLpgm={onToggleLpgm}
            onDeactivateLpgm={onDeactivateLpgm}
          />
        ))
      }
      {swaveArrival !== null && <SWaveArrivalCard arrival={swaveArrival} />}

      {/* 強震モニタ検知: weak を除外した confirmed/likely を 1 つの揺れとして集約表示する。
          大地震では有感域が複数の地域（連結成分）に分かれてコアが複数イベントを返すため、
          N 件の別地震に見せず「広域・N地域」として 1 枚にまとめる。 */}
      {(() => {
        const events = [...kyoshinV2Detections].filter(d => d.confidence !== 'weak')
        if (events.length === 0) return null
        return (
          <div className="flex flex-col gap-2">
            <KyoshinDetectionSummary events={events} points={kyoshinDetectedPoints} visible={visible && pageVisible} />
            <p className="text-xs text-secondary">※強震モニタによる推定値。気象庁発表とは異なる場合があります。</p>
          </div>
        )
      })()}

      {/* スペーサー：データが少ないときに情報セクションを下部へ押し出す */}
      <div className="flex-1" />

      {/* 情報セクション（説明・凡例・出典）*/}
      <div className="flex flex-col gap-3">
        <div>
          <h2 className="text-white font-bold text-sm mb-1">リアルタイム震度モニタ</h2>
          <p className="text-secondary text-xs leading-relaxed">
            各観測点のリアルタイム震度を地図に表示します。1秒ごとに更新されます。
            緊急地震速報の発報時は予報円（青=P波 / 赤=S波）も表示します。
          </p>
        </div>

        {/* 震度スケールの凡例は地図側（`MapLegend`）へ一本化した。同じものを画面に 2 つ置かない。 */}

        {/* 注記 */}
        <div className="bg-card rounded-lg p-3 border border-border">
          <p className="text-secondary text-xs leading-relaxed">
            ※ データ出典: Yahoo!天気・災害 リアルタイム震度（防災科学技術研究所 強震モニタ）。
            表示される震度はリアルタイムの推定値であり、気象庁が発表する震度とは異なる場合があります。
          </p>
        </div>
      </div>
    </div>
  )
})
