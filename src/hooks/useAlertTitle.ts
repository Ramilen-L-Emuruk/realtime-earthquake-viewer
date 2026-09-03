import { useEffect, useRef, useState } from 'react'
import type { EEWAlert } from '../types/earthquake'
import { eewMaxScale, eewMaxScaleInfo, eewKindLabel, computeSingleEEWLevel } from '../utils/eew'
import { getIntensityLabelWithOrAbove } from '../utils/intensity'

// ウィンドウタイトル（情報タイトル）管理フック。
//
// 設計不変条件: この API の全関数は、最大30秒後の setTimeout コールバックや
// 古いレンダーのクロージャから呼ばれても正しく動くよう、可変入力
// （EEW 状態・津波発表状態・優先設定・揺れ検知状態）を必ず「呼び出し時点の ref」
// から読む。スケジュール時に値をキャプチャする実装に変えると、タイマー発火まで
// の間に EEW が解除された場合などに古いタイトルへ戻るリグレッションになる。

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
    .reduce<0 | 1 | 2>((m, e) => Math.max(m, computeSingleEEWLevel(e)) as 0 | 1 | 2, 0)
  return `${eewKindLabel(maxLevel)} ${primary.earthquake.hypocenter.name}` +
    (scale > 0 ? ` 最大震度${getIntensityLabelWithOrAbove(scale, orAbove)}予想` : '') +
    (eews.size > 1 ? ` 他${eews.size - 1}件` : '')
}

function applyPriorityTitle(
  eews: ReadonlyMap<string, EEWAlert>,
  tsunami: boolean,
  priority: boolean,
  kyoshinDetected: boolean,
  setState: (v: string | null) => void,
) {
  if (eews.size === 0 && !tsunami) { setState(kyoshinDetected ? '揺れ検知' : null) }
  else if (eews.size > 0 && tsunami) { setState(priority ? '津波情報 発表中' : computeEEWTitle(eews)) }
  else if (eews.size > 0) { setState(computeEEWTitle(eews)) }
  else { setState('津波情報 発表中') }
}

// 情報タイトルが平常タイトルへ戻るまでの表示時間 [ms]。
// 自動復帰秒数が15秒設定のときのみ15秒、それ以外は30秒に揃える。
function titleResetMs(idleRevertSec: number): number {
  return idleRevertSec === 15 ? 15000 : 30000
}

/** タイトル復帰タイマーの種別（情報種別ごとに独立して管理する） */
export type TitleTimerKind = 'earthquake' | 'eew' | 'tsunami' | 'specialInfo'

export interface AlertTitleApi {
  /** 現在の情報タイトル（null = 平常時タイトル） */
  alertTitle: string | null
  /** タイトルを直接設定する（地震情報 / 緊急地震速報 / 特別情報 / 揺れ検知 等） */
  setTitle: (v: string | null) => void
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
   * 再度同じタイトルになる）。
   */
  showTsunamiTitle: () => void
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
  const [alertTitle, setAlertTitle] = useState<string | null>(null)

  // 各情報タイトルのリセットタイマー（自動復帰秒数が15秒の場合は15秒、それ以外は30秒）
  const timersRef = useRef<Record<TitleTimerKind, number>>({
    earthquake: 0, eew: 0, tsunami: 0, specialInfo: 0,
  })

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

  const showTsunamiTitle = () => {
    setAlertTitle('津波情報 発表中')
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

  // アンマウント時に 4 種のタイマーを掃除する。HMR や React StrictMode の dev 二重実行で
  // フックが再マウントされる場合、残存タイマーが古いクロージャの applyPriority を呼んで
  // ゾンビ状態遷移を起こすのを防ぐ（RCT-2）。
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      window.clearTimeout(timers.earthquake)
      window.clearTimeout(timers.eew)
      window.clearTimeout(timers.tsunami)
      window.clearTimeout(timers.specialInfo)
    }
  }, [])

  return {
    alertTitle,
    setTitle: setAlertTitle,
    applyPriority,
    tsunamiTitleFlag,
    showTsunamiTitle,
    scheduleTitleRevert,
    clearTitleTimer,
    endTsunamiTitleWindow,
    syncInputs,
  }
}
