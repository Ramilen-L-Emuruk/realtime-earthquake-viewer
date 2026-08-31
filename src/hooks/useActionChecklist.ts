// 行動チェックリストを出すかどうかを決める。
//
// 【何を見るか】EEW・強震モニタ・地震情報の 3 経路。揺れを知る手段は状況で変わる（発報が間に
// 合えば EEW、間に合わなければ観測、後から地震情報）ので、1 つに絞ると気づけない場面ができる。
// **3 つが同時に成立しうるため、緊急度の順に見て最初に成立したものを出す。**
//
// 【閉じたら消さずに畳む】大きな地震のあとは余震が続き、続報も次々届く。地震ごとに別物として
// 出し直すと、閉じても閉じても現れることになる。閉じたら小さなボタンへ畳み、その間に届いた
// 揺れではボタンのままにする。読みたくなったら押せば開く。
//
// 【畳んだままにしない 2 つの場合】
//   - 震度が上がったとき … 震度5弱で閉じたあとの震度6強は伝えるべきもの。開き直す
//   - 時間が経ったとき … 最後の揺れから SUPPRESS_MS を過ぎたらボタンも消える。次の地震は
//     改めてパネルで出る
//
// 【出しすぎと出さなすぎ】この機能は出しすぎても害が小さく、出ないことの方が問題。判定に迷う
// ところ（半径内に観測点が無い等）はすべて「出す」側へ倒している。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EEWAlert, JMAQuake } from '../types/earthquake'
import type { StationCoordsData } from '../utils/stationCoords'
import {
  NO_SCOPE,
  eewScaleForScope,
  hasNearby,
  kyoshinScaleForScope,
  quakeScaleForScope,
  type NearbyScope,
} from '../utils/actionChecklistTrigger'
import {
  allRegionNames,
  allStationNames,
  nearbyKyoshinKeys,
  nearbyRegionNames,
  nearbyStationNames,
  type HomePoint,
} from '../utils/nearbyStations'
import type { DetectedPoint } from '../utils/kyoshinDetectionView'
import type { SiteCoords } from '../services/kyoshin'
import { quakeEventKey } from '../utils/quakeMerge'
import { eewEventKey } from '../utils/eew'
import { isValidIntensityScale } from '../utils/intensity'
import { log } from '../utils/logger'
import type { ChecklistReason } from '../components/ActionChecklist'

/** 畳んだ状態を覚えるキー。 */
const SUPPRESS_KEY = 'action-checklist-suppress'

/**
 * 畳んでからボタンを出しておく時間。
 *
 * この間は自動で開き直さず、過ぎたらボタンも消える。揺れが届くたびに延びるので、余震が続いて
 * いる間はボタンが残る。1 時間としたのは、直後の行動（火の元・靴・出口）を読み終える猶予と、
 * 「まだ揺れている状況」が概ね収まる長さの折り合い。
 */
export const SUPPRESS_MS = 60 * 60 * 1000

/**
 * 寿命を延ばすのは残りがこれを切ったときだけ。
 *
 * 強震モニタは 1 秒ごとに判定するため、揺れが届くたびに書き換えると `localStorage` への書き込みと
 * タイマーの張り直しが毎秒走る。半分を残して延ばせば、延長は高々 30 分に 1 度で済む。
 */
const SUPPRESS_EXTEND_BELOW_MS = SUPPRESS_MS / 2

/**
 * 「もう出し終えた」と覚えておく識別子の数。
 *
 * 寿命が尽きてボタンを消したあと、**同じ揺れで帯が開き直さないようにする**ために要る。
 * 地震情報は最新の 1 件が長く居座るため（1 時間後も同じ地震が最新のままなのは普通）、
 * 覚えていないと消した次の再描画でそのまま出し直してしまう。
 */
const DONE_KEYS_MAX = 20

/** 畳んだ記録。リロードしても残す（開き直すと閉じた意味が無くなるため）。 */
interface SuppressRecord {
  /** この時刻まで自動で開き直さない。過ぎたらボタンも消す。 */
  until: number
  /** 畳んだときの震度。**これを超える揺れが来たら畳んだままにしない。** */
  scale: number
}

export interface ChecklistState {
  reason: ChecklistReason
  scale: number
  /** ホーム地点の周りで判定したか。見出しの言い回しを選ぶのに使う（false = 全国基準）。 */
  scoped: boolean
  /** 畳んだ対象を見分けるための識別子。 */
  key: string
}

// 時刻は壁時計（`Date.now()`）で測る。ここで要るのは「畳んでから 1 時間」という**経過時間**だけで、
// 他の時刻系と値を突き合わせない。サーバー同期時計（`serverNow`）を使わないのは、この記録が
// 起動直後（同期が済む前）にも読まれること、再生（テスト時刻設定）中に再生時計へ追従させると
// 数十分を数秒で飛ばす再生で畳んだ記録が即座に失効することによる。

function loadSuppress(): SuppressRecord | null {
  try {
    const raw = localStorage.getItem(SUPPRESS_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { until, scale } = parsed as Record<string, unknown>
    if (typeof until !== 'number' || !Number.isFinite(until)) return null
    // **震度は階級表にある値だけを採る。** 階級外の値（例: 99）が入ると「これを超えたら開き直す」
    // が永久に成立せず、以後どんな揺れでもボタンが自動で開かなくなる。記録は永続化されるため、
    // 一度混入するとリロードでも直らない。
    if (typeof scale !== 'number' || !isValidIntensityScale(scale)) return null
    // 期限切れは無かったことにする。次の揺れは改めてパネルで出す。
    return until > Date.now() ? { until, scale } : null
  } catch (e) {
    // null へ倒すのは安全側（「畳んでいない」＝出す方向）。ただし黙ると「閉じてもリロードで
    // 開き直す」の原因が読み取り側か書き込み側か切り分けられなくなるため記録する。
    log.warn('[checklist] 畳んだ記録を読み込めなかった', e)
    return null
  }
}

function saveSuppress(record: SuppressRecord | null): void {
  try {
    if (record) localStorage.setItem(SUPPRESS_KEY, JSON.stringify(record))
    else localStorage.removeItem(SUPPRESS_KEY)
  } catch (e) {
    // 永続化できない環境（プライベートモード・容量超過）でも畳む動作そのものは止めない。
    log.warn('[checklist] 畳んだ記録を保存できなかった', e)
  }
}

export function useActionChecklist(params: {
  minScale: number
  home: HomePoint | null
  stationCoords: StationCoordsData | null
  /** 強震モニタの観測点座標（半径内の観測点キーを引くのに使う）。 */
  kyoshinSites: SiteCoords
  /**
   * 検知エンジンが確定した揺れのメンバー観測点（`deriveKyoshinView` の `detectedPoints`）。
   *
   * 生の観測値ではなくこちらを渡す。理由は `kyoshinScaleForScope`。
   */
  detectedPoints: readonly DetectedPoint[]
  /**
   * 検知エンジンが結果を出せなくなっているか（`useKyoshinDetectorV2` の `stalled`）。
   *
   * **これを見ないと「揺れが収まった」と「エンジンが詰まっている」を区別できない。** エンジンは
   * 連続して壊れると検知結果を空にするので、`detectedPoints` だけを見ていると揺れの最中でも
   * 「近所は揺れていない」と読んでしまう。強震モニタ経路の入力をエンジンへ移した以上、その異常も
   * 併せて受け取る必要がある（`useKyoshinAlerts` が同じ理由でこれを見ている）。
   */
  kyoshinStalled: boolean
  eews: readonly EEWAlert[]
  latestQuake: JMAQuake | undefined
}): { state: ChecklistState | null; collapsed: boolean; dismiss: () => void; restore: () => void } {
  const { minScale, home, stationCoords, kyoshinSites, detectedPoints, kyoshinStalled, eews, latestQuake } = params

  const [state, setState] = useState<ChecklistState | null>(null)
  const [suppress, setSuppress] = useState<SuppressRecord | null>(loadSuppress)
  // **記録が残っていれば畳んだ状態から始める。** false から始めると、閉じたあとにリロードした
  // 端末で次の余震が帯として開き直し、閉じた意味が無くなる（記録の永続化だけでは足りない）。
  const [collapsed, setCollapsed] = useState(() => suppress !== null)

  // 半径内の観測点。ホーム地点か観測点データが変わったときだけ引き直す（全点の距離計算になるため）。
  const scope = useMemo<NearbyScope>(() => {
    if (!home || !stationCoords) return NO_SCOPE
    return {
      kyoshinKeys: nearbyKyoshinKeys(kyoshinSites, home),
      stationNames: nearbyStationNames(stationCoords, home),
      regionNames: nearbyRegionNames(stationCoords, home),
      // 全件版は地域を絞れるときにしか使わないので、ここで一緒に作る。
      knownStationNames: allStationNames(stationCoords),
      knownRegionNames: allRegionNames(stationCoords),
    }
  }, [home, stationCoords, kyoshinSites])

  // ホーム地点の周りで判定できているか。**判定側と同じ述語を使う** —— 別に書くと、区域だけが
  // 引けている端末で「自宅の区域で判定したのに全国基準の言い回しを出す」ずれが生まれる。
  const scoped = hasNearby(scope)

  const stateRef = useRef(state)
  stateRef.current = state
  const collapsedRef = useRef(collapsed)
  collapsedRef.current = collapsed
  const suppressRef = useRef(suppress)
  suppressRef.current = suppress
  // 寿命が尽きて消した識別子。**永続化はしない** —— リロードは「もう一度見たい」ことも
  // 意味しうるので、その場合は改めて出してよい。
  const doneKeysRef = useRef<string[]>([])

  const applySuppress = useCallback((record: SuppressRecord | null) => {
    suppressRef.current = record
    setSuppress(record)
    saveSuppress(record)
  }, [])

  const show = useCallback((next: ChecklistState) => {
    // 寿命が尽きて消したものは出し直さない。
    if (doneKeysRef.current.includes(next.key)) return
    const record = suppressRef.current
    const now = Date.now()
    const wasCollapsed = collapsedRef.current
    // 畳んだままにするのは「いま畳んでいて」「期限内で」「震度が上がっていない」ときだけ。
    const keepCollapsed =
      wasCollapsed && record != null && now < record.until && next.scale <= record.scale

    // **寿命の延長は表示の更新より先に決める。** 下の「中身が変わらないなら触らない」で先に
    // 抜けてしまうと、同じ震度が続く揺れ（強震モニタは毎秒判定する）で延長が一度も走らず、
    // まだ揺れている最中にボタンが消えうる。
    if (keepCollapsed && record.until - now < SUPPRESS_EXTEND_BELOW_MS) {
      // **基準の震度は上書きしない** —— 余震で下がっていく値に追随させると、そのうち小さな
      // 揺れでも「上がった」と見なして開いてしまう。
      applySuppress({ until: now + SUPPRESS_MS, scale: record.scale })
    }

    // 中身が変わらないなら触らない（開いた項目の状態を保つため）。**震度は比較に含める** ——
    // 同じ EEW の続報で予想が上がることがあり、キーだけで弾くとその引き上げを取りこぼす。
    const cur = stateRef.current
    if (
      cur && cur.key === next.key && cur.scale === next.scale && cur.scoped === next.scoped
      && wasCollapsed === keepCollapsed
    ) return

    setState(next)
    setCollapsed(keepCollapsed)
    // 畳んでいたものを開き直したなら、記録は役目を終えた。開いたまま受けた揺れでは消さない
    // （`restore` で開いた人の「もう一度閉じたときの基準」として残す）。
    if (wasCollapsed && !keepCollapsed && record) applySuppress(null)
  }, [applySuppress])

  // 強震モニタの観測値。**判定は検知フレームが進むたび（高々 1 秒に 1 度）に限る。** App は EEW の
  // 予報円で 100ms ごとに再描画されるため、素で書くとレンダーのたびに走査が走る。
  //
  // 検知エンジンが詰まっている間は判定しない。空の検知結果を「揺れていない」と読むと、揺れの
  // 最中に帯を引っ込めることになる（下の `kyoshinStalled` の扱いと対になっている）。
  const hitScale = useMemo(
    () => (kyoshinStalled ? null : kyoshinScaleForScope(detectedPoints, scope, minScale)),
    [detectedPoints, scope, minScale, kyoshinStalled],
  )

  // 強震モニタの識別子は「その揺れの区切り」を表す必要があるが、強震モニタ自体は地震を区別
  // しない。直近の EEW か地震があればそれに紐づけ、無ければ**閾値を超えた時刻**を使う。
  // **閾値を割るまでは作り直さない** —— 揺れている最中に作り直すと、その間に EEW や地震情報が
  // 届いたときキーが入れ替わり、畳んだものが開き直す。閾値を割ったら捨て、次に超えたときは
  // 別の揺れとして扱う。
  //
  // 時刻を丸めない理由: EEW も地震情報もまだ無い数十秒の窓に別々の地震が 2 つ入ることがある
  // （群発・離れた 2 地域の同時発生）。時単位に丸めると両者が同じ識別子を共有し、1 件目を
  // 閉じたあと 2 件目が「同じ揺れの続き」として扱われて開き直さない。
  const kyoshinAnchorRef = useRef<string | null>(null)

  useEffect(() => {
    // **識別子を捨てるのは「揺れが収まった」ときだけ。** 検知エンジンが詰まって結果を出せない
    // 数秒でも `hitScale` は null になるが、そこで捨てると復帰したとき同じ揺れが別物として扱われ、
    // 畳んだ帯が開き直す。
    if (hitScale == null && !kyoshinStalled) kyoshinAnchorRef.current = null
    if (minScale < 0) return

    // **緊急度の順に見て、最初に成立したものを出す。** 3 つは同時に成立しうる（発報中の EEW・
    // 揺れている観測値・直前の地震の確定情報）。順序を決めずに書くと最後に評価したものが勝ち、
    // EEW が出ている最中に「強い揺れがありました」（過去形）へ落ちる。
    // **最も深刻な EEW を選ぶ。** `eews` の並びは発報を受けた順（内部の Map の挿入順）で、
    // 深刻さとは無関係。最初に閾値を超えたところで打ち切ると、後から発生したより強い地震の
    // 予想を見落とす（連続する余震や、離れた 2 地域でほぼ同時に起きたときに実際に起きる）。
    let eewHit: { scale: number; key: string } | null = null
    for (const eew of eews) {
      if (eew.cancelled) continue
      const scale = eewScaleForScope(eew, scope, minScale)
      if (scale == null) continue
      // **報番号を含む `eew.id` は使わない。** 続報のたびにキーが変わり、畳んだものが開き直す。
      if (eewHit == null || scale > eewHit.scale) eewHit = { scale, key: `eew:${eewEventKey(eew)}` }
    }
    if (eewHit) {
      show({ reason: 'eew', scale: eewHit.scale, scoped, key: eewHit.key })
      return
    }

    if (hitScale != null) {
      if (kyoshinAnchorRef.current == null) {
        const eewAnchor = eews.find(e => !e.cancelled)
        kyoshinAnchorRef.current = (eewAnchor ? eewEventKey(eewAnchor) : null)
          ?? (latestQuake ? quakeEventKey(latestQuake) : null)
          ?? new Date().toISOString()
      }
      show({ reason: 'kyoshin', scale: hitScale, scoped, key: `kyoshin:${kyoshinAnchorRef.current}` })
      return
    }

    // **詰まっている間に地震情報へ落とさない。** 揺れが続いているのに「強い揺れがありました」
    // （過去形）へ差し替わり、震度も別の値になる。留めるのは**表示中が強震モニタ由来のときだけ**
    // —— 何も出ていない状態まで止めると、エンジンが壊れ続けている端末で地震情報の経路まで死ぬ。
    if (kyoshinStalled && stateRef.current?.reason === 'kyoshin') return

    if (latestQuake) {
      const scale = quakeScaleForScope(latestQuake, scope, minScale)
      if (scale != null) {
        show({ reason: 'quake', scale, scoped, key: `quake:${quakeEventKey(latestQuake)}` })
      }
    }
  }, [eews, hitScale, kyoshinStalled, latestQuake, scope, minScale, scoped, show])

  // 設定で「出さない」に切り替えたら、いま出ているものも引っ込める。判定側で早期に抜けるだけ
  // では、開いたままの帯が手動で閉じるまで残り続ける（開いている間は寿命でも消さない設計のため）。
  // 畳んだ記録は残す —— 再び有効にしたとき、閉じた状態から始めるのが自然。
  useEffect(() => {
    if (minScale >= 0) return
    setState(null)
    setCollapsed(false)
  }, [minScale])

  // 畳んだままのボタンは期限が来たら消す。**開いている間は消さない** —— 読んでいる最中に
  // 消えることになる。
  useEffect(() => {
    if (!collapsed || !suppress) return
    const clear = () => {
      const key = stateRef.current?.key
      if (key) {
        doneKeysRef.current = [...doneKeysRef.current.filter(k => k !== key), key].slice(-DONE_KEYS_MAX)
      }
      setState(null)
      setCollapsed(false)
      applySuppress(null)
    }
    const remain = suppress.until - Date.now()
    if (remain <= 0) {
      clear()
      return
    }
    const timer = setTimeout(clear, remain)
    return () => clearTimeout(timer)
  }, [collapsed, suppress, applySuppress])

  const dismiss = useCallback(() => {
    const cur = stateRef.current
    setCollapsed(true)
    if (!cur) return
    applySuppress({ until: Date.now() + SUPPRESS_MS, scale: cur.scale })
  }, [applySuppress])

  // 畳んだボタンを押して開く。**抑止の記録は消さない** —— 開いている間は `keepCollapsed` が
  // 成立しないので畳まれることはなく、記録は「もう一度閉じたときの震度の基準」として残る。
  const restore = useCallback(() => setCollapsed(false), [])

  return { state, collapsed, dismiss, restore }
}
