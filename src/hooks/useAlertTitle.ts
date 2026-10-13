import { useEffect, useRef, useState } from 'react'
import type { EEWAlert, JMATsunami } from '../types/earthquake'
import { eewMaxScale, eewMaxScaleInfo, eewKindLabel, computeDisplayEEWLevel } from '../utils/eew'
import { getIntensityLabelWithApproxAbove } from '../utils/intensity'
import { CANCEL_REASON_LABEL } from '../utils/tsunamiCancelLabel'
import { log } from '../utils/logger'

// ウィンドウタイトル（情報タイトル）管理フック。
//
// 設計不変条件: この API の全関数は、最大30秒後の setTimeout コールバックや
// 古いレンダーのクロージャから呼ばれても正しく動くよう、可変入力
// （EEW 状態・津波発表状態・優先設定・揺れ検知状態）を必ず「呼び出し時点の ref」
// から読む。スケジュール時に値をキャプチャする実装に変えると、タイマー発火まで
// の間に EEW が解除された場合などに古いタイトルへ戻るリグレッションになる。

/**
 * 「津波が発表中」を指す印。**文字列にせず印で持ち、名乗りは描くときに決める**（`resolveAlertTitle`）。
 *
 * 予報だけのときは「津波予報 発表中」、警報・注意報が 1 区域でもあれば「津波警報・注意報 発表中」と
 * 名乗る（2026-10-12 ユーザー承認）。報を受けた瞬間に文字列へ焼くと、受信処理はまだ新しい報を
 * 反映していない津波の記憶を見るので、警報から予報へ下がった報でも 1 度「津波警報・注意報 発表中」と
 * 名乗ってしまう。描く時点の津波から決めれば、その食い違いが起きない。
 */
export const TSUNAMI_ACTIVE_TITLE = Object.freeze({ kind: 'tsunamiActive' as const })

/** フックが持つ情報タイトル（null = 平常時タイトル） */
export type AlertTitle = string | typeof TSUNAMI_ACTIVE_TITLE | null

/** 情報タイトルを画面に出す文字列にする。`tsunamiForecastOnly` は `isTsunamiForecastOnly` の結果を渡す */
export function resolveAlertTitle(title: AlertTitle, tsunamiForecastOnly: boolean): string | null {
  if (title === null || typeof title === 'string') return title
  return tsunamiForecastOnly ? '津波予報 発表中' : '津波警報・注意報 発表中'
}

/**
 * EEW 発表中のウィンドウタイトルを組み立てる（純粋関数）。
 * 区分の名前をどの軸で決めるかを取り違えやすいため、テストできるように公開している。
 */
export function computeEEWTitle(eews: ReadonlyMap<string, EEWAlert>): string {
  const primary = Array.from(eews.values()).sort((a, b) => eewMaxScale(b) - eewMaxScale(a))[0]
  // 上限が定まらない報は「震度4以上予想」と出す（値だけにすると下限を断定してしまう）。
  const { scale, orAbove } = eewMaxScaleInfo(primary)
  // **区分の名前は「発表中の EEW すべての最大レベル」から決める。** primary（最大震度）の区分で
  // 決めてはいけない。`eewMaxScale` は**予想震度を持たない報**で 0 を返すため、震度未確定の警報級が
  // 震度の付いた予報級に primary を奪われ、タイトルが「地震動予報」になって警報級が「他N件」に
  // 埋もれる。地名と震度は primary から、区分の名前は最大レベルから取り、軸を分ける。
  // （0 になる条件は `condition` ではなく「電文に値があるか」。気象庁が最大予測震度を発表しないのは
  // 「観測点 1 点による震度予測」と「深さ 150km 超」で、該当すれば電文に値が入らない）
  const maxLevel = Array.from(eews.values())
    .reduce<0 | 1 | 2>((m, e) => Math.max(m, computeDisplayEEWLevel(e)) as 0 | 1 | 2, 0)
  return `${eewKindLabel(maxLevel)} ${primary.earthquake.hypocenter.name}` +
    (scale > 0 ? ` 最大震度${getIntensityLabelWithApproxAbove(scale, orAbove)}予想` : '') +
    (eews.size > 1 ? ` 他${eews.size - 1}件` : '')
}

function applyPriorityTitle(
  eews: ReadonlyMap<string, EEWAlert>,
  tsunami: boolean,
  priority: boolean,
  kyoshinDetected: boolean,
  tsunamiEndLabel: string | null,
  setState: (v: AlertTitle) => void,
) {
  // 終わった津波の語（`showTsunamiEndTitle`）は、進行中のもの（緊急地震速報・発表中の津波・揺れ検知）の
  // 下に置く。出している間に再評価が走っても消さず、上が無くなれば残り時間だけ戻ってくる。
  if (eews.size === 0 && !tsunami) { setState(kyoshinDetected ? '揺れ検知' : tsunamiEndLabel) }
  else if (eews.size > 0 && tsunami) { setState(priority ? TSUNAMI_ACTIVE_TITLE : computeEEWTitle(eews)) }
  else if (eews.size > 0) { setState(computeEEWTitle(eews)) }
  else { setState(TSUNAMI_ACTIVE_TITLE) }
}

// 情報タイトルが平常タイトルへ戻るまでの表示時間 [ms]。
// 自動復帰秒数が15秒設定のときのみ15秒、それ以外は30秒に揃える。
function titleResetMs(idleRevertSec: number): number {
  return idleRevertSec === 15 ? 15000 : 30000
}

/** タイトル復帰タイマーの種別（情報種別ごとに独立して管理する） */
export type TitleTimerKind = 'earthquake' | 'eew' | 'tsunami' | 'specialInfo'

export interface AlertTitleApi {
  /** 現在の情報タイトル（null = 平常時タイトル）。画面へ出すときは `resolveAlertTitle` を通す */
  alertTitle: AlertTitle
  /**
   * 新しい情報のタイトルを直接設定する（地震情報・特別情報・アイドル復帰）。出していた津波の終わりの語は
   * 下ろす（新しい事実を伝えている以上、終わった津波の語を後から出し直さない）。
   */
  setTitle: (v: string | null) => void
  /**
   * 進行中のもの（緊急地震速報・揺れ検知・揺れの可能性）のタイトルを直接設定する。**津波の終わりの語は
   * 下ろさない** —— 層の上に乗るだけなので、これが下りて再評価が走れば残り時間だけ終わりの語が戻る。
   * 終わりの語より先に出ていたか後から出たかで結果を変えないため、`setTitle` と分けている。
   */
  setOngoingTitle: (v: string) => void
  /**
   * 優先度ロジックでタイトルを再評価する。
   * デフォルトは呼び出し時点の ref 値（EEW 状態・津波タイトルフラグ・優先設定・揺れ検知状態）。
   * 特定の値を確定済みとして扱う場合のみ overrides で上書きする。
   */
  applyPriority: (overrides?: {
    eews?: ReadonlyMap<string, EEWAlert>
    tsunami?: boolean
    priority?: boolean
    kyoshinDetected?: boolean
  }) => void
  /**
   * 津波タイトルを「発表中」として扱うか。
   * 一定時間表示モード OFF: 実際の発表中フラグ（sticky）。ON: 直近受信からの表示ウィンドウ内かどうか。
   */
  tsunamiTitleFlag: () => boolean
  /**
   * 津波タイトルを表示する。一定時間表示モードかどうかに関わらず自動復帰時間後に
   * 優先度ロジックを再評価するタイマーを仕込む（モード OFF 時は津波が発表中である限り
   * 再度同じタイトルになる）。出していた終わりのタイトル（`showTsunamiEndTitle`）は取り下げる。
   */
  showTsunamiTitle: () => void
  /**
   * 津波が終わったこと（解除・取消・失効）をタイトルで伝える。津波タブの見出しと同じ語
   * （`CANCEL_REASON_LABEL` の `title`）を、他の報と同じ長さだけ出す。「一定時間に制限」の
   * オン・オフどちらでも同じ（2026-10-12 ユーザー承認）。津波の表示ウィンドウはここで閉じる。
   *
   * **終わりの語は優先度ロジックのいちばん下の層に置く**（`applyPriorityTitle`）。緊急地震速報・
   * 発表中の津波・揺れ検知があればそちらを出し、それらが無くなれば残り時間だけ戻ってくる。
   * 他の種別の待ちが切れて再評価が走っても消えない。消えるのは自分の待ちが切れたとき・次の津波の報・
   * 新しい情報の直接の設定（`setTitle`。地震情報・特別情報の受信やアイドル復帰）のとき。進行中のものが
   * 後から始まっても（`setOngoingTitle`）消えない。
   *
   * 理由の値が表に無いとき（型を迂回した値）は「解除」の語へ倒し、記録に残す。
   */
  showTsunamiEndTitle: (reason: JMATsunami['cancelReason']) => void
  /** タイトル復帰タイマーを登録する（既存タイマーはクリアして張り直す） */
  scheduleTitleRevert: (kind: TitleTimerKind) => void
  /** タイトル復帰タイマーをクリアのみ行う（即時に優先度を再評価するケースで使用） */
  clearTitleTimer: (kind: TitleTimerKind) => void
  /** 津波タイトルの表示ウィンドウを閉じ、津波タイマーをクリアする（解除・取消時） */
  endTsunamiTitleWindow: () => void
  /**
   * タイマーコールバックが参照する設定値・津波発表状態を最新化する。
   * App のレンダー本文中（値の確定直後）に毎レンダー呼ぶこと。
   */
  syncInputs: (v: {
    tsunamiActive: boolean
    tsunamiPriority: boolean
    tsunamiTitleTemporary: boolean
    idleRevertSec: number
  }) => void
}

export function useAlertTitle(opts: {
  /** cancelledAt 除外済みのアクティブ EEW（App 所有・毎レンダー更新） */
  activeEEWsRef: React.MutableRefObject<ReadonlyMap<string, EEWAlert>>
  /** 強震モニタの揺れ検知フラグ（App 所有・毎レンダー更新） */
  kyoshinDetectedRef: React.MutableRefObject<boolean>
}): AlertTitleApi {
  const { activeEEWsRef, kyoshinDetectedRef } = opts

  // 情報更新時にウィンドウタイトルへ表示する文言（null = 平常時タイトル）。
  // デフォルトタブへ戻るタイミングで null に戻す。
  const [alertTitle, setAlertTitle] = useState<AlertTitle>(null)

  // 各情報タイトルのリセットタイマー（自動復帰秒数が15秒の場合は15秒、それ以外は30秒）
  const timersRef = useRef<Record<TitleTimerKind, number>>({
    earthquake: 0, eew: 0, tsunami: 0, specialInfo: 0,
  })
  // 終わりのタイトルの待ちと、出している語（null = 出していない）。**津波の待ち（`timersRef.tsunami`）
  // とは分ける** —— あちらは解除の検出で `endTsunamiTitleWindow` が落とすので、相乗りすると
  // 出したばかりの終わりの語が戻らなくなる。
  const endTimerRef = useRef(0)
  const endLabelRef = useRef<string | null>(null)

  // タイマーコールバック内で最新値を参照するための ref（syncInputs で毎レンダー更新）
  const tsunamiActiveRef = useRef(false)
  const tsunamiPriorityRef = useRef(false)
  const tsunamiTitleTemporaryRef = useRef(false)
  const idleRevertSecRef = useRef(30)
  // 一定時間表示モード時に「直近受信からの表示ウィンドウ内」かどうか（sticky モードでは未使用）
  const tsunamiTitleWindowActiveRef = useRef(false)

  const syncInputs: AlertTitleApi['syncInputs'] = (v) => {
    tsunamiActiveRef.current = v.tsunamiActive
    tsunamiPriorityRef.current = v.tsunamiPriority
    tsunamiTitleTemporaryRef.current = v.tsunamiTitleTemporary
    idleRevertSecRef.current = v.idleRevertSec
  }

  const tsunamiTitleFlag = () =>
    tsunamiTitleTemporaryRef.current ? tsunamiTitleWindowActiveRef.current : tsunamiActiveRef.current

  const applyPriority: AlertTitleApi['applyPriority'] = (overrides) => {
    applyPriorityTitle(
      overrides?.eews ?? activeEEWsRef.current,
      overrides?.tsunami ?? tsunamiTitleFlag(),
      overrides?.priority ?? tsunamiPriorityRef.current,
      overrides?.kyoshinDetected ?? kyoshinDetectedRef.current,
      endLabelRef.current,
      setAlertTitle,
    )
  }

  const clearTitleTimer = (kind: TitleTimerKind) => {
    window.clearTimeout(timersRef.current[kind])
  }

  const scheduleTitleRevert = (kind: TitleTimerKind) => {
    window.clearTimeout(timersRef.current[kind])
    timersRef.current[kind] = window.setTimeout(() => {
      applyPriority()
    }, titleResetMs(idleRevertSecRef.current))
  }

  const dropEndTitle = () => {
    window.clearTimeout(endTimerRef.current)
    endLabelRef.current = null
  }

  const showTsunamiTitle = () => {
    dropEndTitle()
    setAlertTitle(TSUNAMI_ACTIVE_TITLE)
    tsunamiTitleWindowActiveRef.current = true
    window.clearTimeout(timersRef.current.tsunami)
    timersRef.current.tsunami = window.setTimeout(() => {
      if (tsunamiTitleTemporaryRef.current) tsunamiTitleWindowActiveRef.current = false
      applyPriority()
    }, titleResetMs(idleRevertSecRef.current))
  }

  const endTsunamiTitleWindow = () => {
    window.clearTimeout(timersRef.current.tsunami)
    tsunamiTitleWindowActiveRef.current = false
  }

  const showTsunamiEndTitle: AlertTitleApi['showTsunamiEndTitle'] = (reason) => {
    // **語は先に引く。** 表に無い値で `.title` を読むと例外になり、受信処理の残り（音・読み上げ・
    // 記憶の掃除）がまとめて飛ぶ。`??` は null と undefined しか拾わないので、表で確かめる。
    const known = reason !== undefined && Object.prototype.hasOwnProperty.call(CANCEL_REASON_LABEL, reason)
    if (reason !== undefined && !known) {
      log.warn(`[title] 津波の終わりの理由が読めないため「解除」の語で出す (cancelReason=${String(reason)})`)
    }
    const label = CANCEL_REASON_LABEL[known ? reason : 'lifted'].title
    endTsunamiTitleWindow()
    window.clearTimeout(endTimerRef.current)
    endTimerRef.current = window.setTimeout(() => {
      endLabelRef.current = null
      applyPriority()
    }, titleResetMs(idleRevertSecRef.current))
    endLabelRef.current = label
    applyPriority({ tsunami: false })
  }

  // 新しい情報（地震情報など）がタイトルを取ったら、終わりの語は下ろす。戻すのはそちらの待ちに任せる
  // （そちらが新しい事実を伝えている以上、終わった津波の語を後から出し直さない）。
  const setTitle: AlertTitleApi['setTitle'] = (v) => {
    dropEndTitle()
    setAlertTitle(v)
  }

  // 進行中のものは層の上に乗るだけ。終わりの語は残し、再評価で戻ってこられるようにする。
  const setOngoingTitle: AlertTitleApi['setOngoingTitle'] = (v) => {
    setAlertTitle(v)
  }

  // アンマウント時に全タイマーを掃除する。HMR や React StrictMode の dev 二重実行で
  // フックが再マウントされる場合、残存タイマーが古いクロージャの applyPriority を呼んで
  // ゾンビ状態遷移を起こすのを防ぐ（RCT-2）。
  useEffect(() => {
    const timers = timersRef.current
    const endTimer = endTimerRef
    return () => {
      window.clearTimeout(timers.earthquake)
      window.clearTimeout(timers.eew)
      window.clearTimeout(timers.tsunami)
      window.clearTimeout(timers.specialInfo)
      window.clearTimeout(endTimer.current)
    }
  }, [])

  return {
    alertTitle,
    setTitle,
    setOngoingTitle,
    applyPriority,
    tsunamiTitleFlag,
    showTsunamiTitle,
    showTsunamiEndTitle,
    scheduleTitleRevert,
    clearTitleTimer,
    endTsunamiTitleWindow,
    syncInputs,
  }
}
