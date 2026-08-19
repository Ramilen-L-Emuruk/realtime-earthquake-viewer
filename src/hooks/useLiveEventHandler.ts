import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppEvent, EEWAlert, JMAQuake, JMATsunami } from '../types/earthquake'
import type { TabId } from '../components/IconNav'
import type { AppSettings } from './useSettings'
import type { AlertTitleApi } from './useAlertTitle'
import type { ReplayEntry } from '../types/replay'
import { getIntensityLabel } from '../utils/intensity'
import { formatMagnitude, hasMagnitude } from '../utils/formatters'
import { eewMaxScale, eewMaxLpgmClass, computeSingleEEWLevel, selectEEWSoundType } from '../utils/eew'
import { haversineKm } from '../utils/geo'
import { showBrowserNotification } from '../utils/notifications'
import { tsunamiMaxGrade, isTsunamiNewFire, isTsunamiGradeUpgrade } from '../utils/tsunami'
import { matchesArea, sortAreasForCardDisplay } from '../components/TsunamiTab'
import { playAlertSound, type AlertSoundType } from '../utils/alertSound'
import { speakWithVoicevox } from '../utils/voicevox'
import { eewAlertToText, eewIntensityToText, eewCancelToText, earthquakeToText, earthquakeCancelToText, tsunamiToText, tsunamiDowngradeToText, tsunamiCancelToText, tsunamiObservationUpdateToText, tsunamiArrivalToText, nankaiToText, kohatsuToText, lpgmToText, type TtsRegionOptions } from '../utils/ttsText'
import { log } from '../utils/logger'
import { extractQuakeEventIdFromId, quakeEventKey, sameQuakeEntry } from '../utils/quakeMerge'

// EEW 読み上げ第 2 フェーズ（予想値）のタイミング。
// 初報で予想震度が付いていない場合に待つ上限。仮定震源要素（単独点処理）や深発地震では
// 予想震度が最後まで付かないことがあるため、待ちきらずに「予想震度なし」を読んで打ち切る。
const EEW_PHASE2_MAX_WAIT_MS = 6000
// 直列化した EEW 読み上げで、発話の完了を待つ上限。VOICEVOX への合成リクエストには
// タイムアウトが無いため、応答が返らないまま待ち続けると後続の EEW が永久に読まれなくなる。
// 打ち切って次へ進む（止まっていた側は次の発話開始時に abort される）。
const EEW_SPEECH_CHAIN_MAX_WAIT_MS = 8000
// 非 EEW の読み上げ（地震情報・津波・長周期・南海トラフ）が、EEW の読み上げが途切れるのを
// 待つ上限。本震の続報は数十秒続くことがあり、無制限に待つとこれらが永久に読まれない。
// 上限に達したら諦めて読む（その場合は従来どおり EEW に切られうる）。
const NON_EEW_SPEECH_MAX_WAIT_MS = 20000

/**
 * 発話の完了を待つ（上限付き）。EEW の読み上げは 1 本のチェーンで直列化するため、
 * 1 件の遅延が全体を止めないようにする。
 *
 * **直前の発話を待つ側と、発話そのものを待つ側の両方に掛けること。** VOICEVOX への合成
 * リクエストにはタイムアウトが無く、応答が返らないまま止まると、待ち側だけに上限を置いても
 * 「発話が終わった」と数える処理（`eewSpeechPendingRef` の減算）が永久に走らない。
 */
function capSpeechWait(p: Promise<void>, capMs = EEW_SPEECH_CHAIN_MAX_WAIT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, capMs)) })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

/** 設定から読み上げの地域列挙オプションを組み立てる（震度・長周期地震動で共通）。 */
function ttsRegionOptions(settings: AppSettings): TtsRegionOptions {
  return {
    intensityLevels: settings.ttsIntensityLevels,
    maxRegions: settings.ttsMaxRegions,
    alwaysReadScale: settings.ttsAlwaysReadScale,
    regionTolerance: settings.ttsRegionTolerance,
  }
}

// 音・タブ切替の「新規地震か続報か」を判定するためのキー。
// 生電文だけから作り、earthquakesRef（統合済みカード）には依存させない。ref は App の
// レンダー本体でしか更新されず、非表示タブの復帰時（setInterval は最大 1 分まで throttle
// される。utils/clock.ts の Page Visibility 対応コメント参照）にキューが一括で捌けると
// 直前の統合結果を含まないため、同じ地震の続報を「新規」と誤判定して音が鳴り直す。
//
// DMDATA は全報が eventId を共有する。P2PQuake は eventId を持たないが、発生時刻と震源名は
// 続報間で変わらない（変わるのは訂正報・震源要素更新のときで、それは通知に値する変化）。
// issue.type まで含めるのは、震度速報／震源情報／各地の震度情報を別報として扱うため。
function newQuakeTrackingKey(q: JMAQuake): string {
  const base = extractQuakeEventIdFromId(q.id)
    ?? `${q.earthquake.time}|${q.earthquake.hypocenter.name}`
  return `${base}:${q.issue.type}`
}

// 観測点リストから、属する予報区（districtCode/districtName）を重複なく列挙する
function uniqueDistricts(observations: { districtCode?: string; districtName?: string }[]): { code?: string; name?: string }[] {
  const seen = new Set<string>()
  const result: { code?: string; name?: string }[] = []
  for (const o of observations) {
    const key = o.districtCode ?? o.districtName ?? ''
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push({ code: o.districtCode, name: o.districtName })
  }
  return result
}

// 波高未確定（観測中）の新規到達観測点しか無いとき、その中でどの区域をスクロール先の
// 先頭にするかを、津波情報カードの実際の表示順（TsunamiGradeCard と同じ並び替え）から決める。
// 電文内の記載順ではなく、画面上で一番上に表示される区域を優先する。
function pickTopFromCardOrder(
  newlyArrivedObs: { districtCode?: string; districtName?: string }[],
  areas: import('../types/earthquake').TsunamiArea[],
  allObservations: import('../types/earthquake').TsunamiObservation[],
): { code?: string; name?: string } {
  const ordered = sortAreasForCardDisplay(areas, allObservations)
  const matched = ordered.find(area => newlyArrivedObs.some(o => matchesArea(o as import('../types/earthquake').TsunamiObservation, area)))
  if (matched) return { code: matched.code, name: matched.name }
  return { code: newlyArrivedObs[0].districtCode, name: newlyArrivedObs[0].districtName }
}

// ライブイベント（地震・津波・EEW・長周期地震動・南海トラフ/後発地震）受信時の
// 通知音・ウィンドウタイトル・タブ切替・VOICEVOX 読み上げ・ブラウザ通知を担うフック。
// イベント種別ごとの続報判定・重複抑制に使う追跡 ref 群もこのフックが所有する。
//
// 注意: handleLiveEvent は毎レンダー再生成される（useCallback で包まない）。
// useEarthquakes 側が onLiveEventRef を毎レンダー更新して staleness を吸収するため、
// 依存配列を絞った useCallback で包むと settings の stale closure を作りリグレッションになる。

export interface LiveEventHandlerDeps {
  settings: AppSettings
  /** useAlertTitle の戻り値（ウィンドウタイトル操作 API） */
  title: AlertTitleApi
  /** 地震情報リスト（App 所有・useEarthquakes の直後に毎レンダー更新） */
  earthquakesRef: React.MutableRefObject<JMAQuake[]>
  /** 津波リスト（App 所有・useEarthquakes の直後に毎レンダー更新）。
   *  津波続報の判定（同一 eventId の観測点更新でタブを毎回奪わない）に使う。 */
  tsunamisRef: React.MutableRefObject<JMATsunami[]>
  /** 強震モニタの揺れ検知フラグ（App 所有・毎レンダー更新） */
  kyoshinDetectedRef: React.MutableRefObject<boolean>
  /** アイドル復帰で戻すデフォルトタブ（App 所有・毎レンダー更新。デバッグログ用） */
  defaultTabRef: React.MutableRefObject<TabId>
  setActiveTab: (tab: TabId) => void
  setActiveTabNonRealtime: (tab: Exclude<TabId, 'realtime'>) => void
  setActiveTabRealtimeOnUpdate: () => void
  revertToDefaultTab: () => void
  selectQuake: (id: string | null) => void
  setActiveLpgmEventId: (id: string | null) => void
}

export function useLiveEventHandler(deps: LiveEventHandlerDeps) {
  const {
    settings, title, earthquakesRef, tsunamisRef, kyoshinDetectedRef, defaultTabRef,
    setActiveTab, setActiveTabNonRealtime, setActiveTabRealtimeOnUpdate,
    revertToDefaultTab, selectQuake, setActiveLpgmEventId,
  } = deps

  // 直近に「新規地震」として注目を移したキー（`eventKey:issue.type`）。
  // 同一イベント・同一種別の続報では新規扱いにせず、音・タブ切替を再発火させない。
  const lastNewQuakeKeyRef = useRef<string | null>(null)
  // EEW の eventId ごとにレベルを追跡（複数EEW対応）
  // key = issue.eventId ?? id、value = 0=低震度予報 / 1=警報（severity=Warning または予想震度5弱以上） / 2=特別警報
  const activeEEWLevelsRef = useRef<Map<string, 0 | 1 | 2>>(new Map())
  // ここから 3 つは「実際に読み上げた値」を eventId 別に保持する。受信値ではなく発話した値を
  // 持つのが要点。受信のたびに更新すると、割り込みや取消で声に出なかった値まで既読になり、
  // 「一度も言っていない値からの引き上げ」を語ることになる。更新は発話の直前だけで行う。
  const spokenEEWScalesRef = useRef<Map<string, number>>(new Map())
  // 階級だけが上がる続報（震度据え置きで 2→3 等）は震度にもレベルにも現れないため専用に持つ。
  const spokenEEWLpgmClassesRef = useRef<Map<string, number>>(new Map())
  // 読み上げた区分（0=予報 / 1 以上=警報）。予想震度・階級が据え置きのまま severity だけ
  // 確定する続報があり、値だけを見ていると区分の変化が声に出ない。
  const spokenEEWLevelsRef = useRef<Map<string, 0 | 1 | 2>>(new Map())
  // 直前に読み上げた津波グレード（引き下げ検出・重複読み上げ抑制に使用）
  const lastTsunamiGradeRef = useRef<'MajorWarning' | 'Warning' | 'Watch' | 'Forecast' | null>(null)
  // 観測点ごとの読み上げ済み最大波高（更新があった観測点のみ TTS 発話するための比較用）
  const lastMaxObsHeightRef = useRef<Map<string, { value: number; over?: boolean }>>(new Map())
  // これまでに一度でも登場した観測点名（波高未確定＝観測中のまま新規到達した観測点を検出するための比較用）
  const seenObsNamesRef = useRef<Set<string>>(new Set())
  // VOICEVOX EEW 読み上げの進行管理。
  //
  //   eewSpeechChainRef   … EEW の読み上げを直列化するチェーン（**全 EEW で 1 本**）。
  //                         speakWithVoicevox は待ち行列ではなく割り込みで、既存の再生を stop し
  //                         進行中の合成を abort する。eventId ごとにチェーンを分けると、同時多発
  //                         （例: 2024/1/1 能登）で互いの発話を途中で消し合い、どちらも尻切れになる。
  //   eewPhase2TokensRef  … チェーン末尾に予約済みの第 2 フェーズを表す識別子（eventId 別）。
  //                         予約は eventId ごとに高々 1 件に畳む（解決時に必ず最新値を読み直すため、
  //                         続報のたびに積む必要が無い）。震源の大幅更新で予約を破棄したことも、
  //                         この識別子の入れ替えで判別する。
  //   eewTtsMaxTimersRef  … 初報に予想震度が付くのを待つ上限（EEW_PHASE2_MAX_WAIT_MS）。eventId 別。
  //
  // 予約・タイマーを eventId 別に持つのは、単一 ref にすると後から届いた別イベントの受信で
  // 発話対象が横取りされ、片方の続報が「読み上げ済み最大震度」を更新できずに無限リトリガーする
  // 不具合が起きるため。
  const eewSpeechChainRef = useRef<Promise<void>>(Promise.resolve())
  // チェーンに積まれている EEW 発話の数（0 なら EEW は静か）。非 EEW の読み上げがこれを見て待つ。
  const eewSpeechPendingRef = useRef(0)
  const eewPhase2TokensRef = useRef<Map<string, object>>(new Map())
  const eewTtsMaxTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  // 第 2 フェーズ（予想値）を一度でも発話した eventId。まだ読んでいない間は、値が上がって
  // いなくても読む（初報・震源更新の読み直しがこれに当たる）。
  const eewPhase2DoneRef = useRef<Set<string>>(new Set())
  // 予約の解決時にテキストを生成するため、eventId ごとに最新イベントを保持する（変化なし続報も含め常に最新で上書き）
  const eewTtsEventsRef = useRef<Map<string, EEWAlert>>(new Map())
  // EEW の eventId ごとに最後に Phase 1 を発話したときの震源情報を保持する（震源地名変化+座標移動の再発話判定用）
  const activeEEWAnnouncedHypocentersRef = useRef<Map<string, { name: string; lat: number; lng: number }>>(new Map())
  // 長周期地震動情報の更新検出: 受信済み eventId を追跡する
  const seenLpgmEventIdsRef = useRef<Set<string>>(new Set())
  // 津波解除/取消/失効: 音・TTS を発火済みの eventId を追跡する（AUD-6 の重複鳴り防止）。
  // TSU-3 で同一スロットに別 eventId を上書きするケースもあるため eventId 単位で管理する。
  // 直前状態（lastTsunamiGradeRef===null）で判定するとリロード後の初回解除を握り潰す。
  const spokenTsunamiCancelEventIdsRef = useRef<Set<string>>(new Set())
  // 津波観測点の新規/更新バッジ表示状態と自動クリアタイマー
  const [obsUpdateStatus, setObsUpdateStatus] = useState<Map<string, 'new' | 'updated'>>(() => new Map())
  const obsStatusClearTimerRef = useRef<number>(0)
  // 津波イベント受信時にスクロールでフォーカスする予報区（今回の受信で変更があった区域全部＋その中の最高波高区域）。
  // 対象区域が特定できない受信（区域のみの発表・実質変化なしの続報・解除）は top: null（一番上へ戻す）で表す。
  const [focusedDistrict, setFocusedDistrict] = useState<{ districts: { code?: string; name?: string }[]; top: { code?: string; name?: string } | null; ts: number } | null>(null)

  /**
   * EEW の読み上げをチェーンの末尾に繋ぐ。`speak` が null を返した場合は何も発話しない
   * （発話の直前に対象がまだ発表中かを判定させるため、テキストは遅延生成にしている）。
   *
   * **チェーンに reject を残さないこと。** `eewSpeechChainRef` は次の発話が待つ対象なので、
   * ここで reject させると以降の EEW の読み上げが連鎖的に落ち、**その端末では二度と
   * 緊急地震速報が読まれなくなる**。テキスト生成の例外まで含めて必ず catch する。
   */
  const chainEEWSpeech = (speak: () => string | null) => {
    eewSpeechPendingRef.current++
    const prev = eewSpeechChainRef.current
    eewSpeechChainRef.current = capSpeechWait(prev).then(() => {
      const text = speak()
      if (text === null) return
      return capSpeechWait(
        speakWithVoicevox(settings.voicevoxUrl, text, settings.voicevoxSpeakerId, settings.soundVolume),
      )
    })
      .catch(err => log.warn('[eew] 読み上げに失敗', err))
      .finally(() => { eewSpeechPendingRef.current-- })
  }

  /**
   * EEW の読み上げが途切れるのを待つ（上限付き）。EEW が無ければ待たない。
   *
   * 待っている間に次の EEW が積まれることがあるため、静かになるまで繰り返し待つ。
   *
   * 打ち切りは**経過時間**で判定する。反復ごとに一定量を足す数え方にすると、チェーンが即座に
   * resolve する状態で `eewSpeechPendingRef` だけが残っていた場合に、マイクロタスクを高速に
   * 回り切って「上限まで待った」ことになり、上限が実時間として意味を失う。あわせて反復回数にも
   * 歯止めを置き、時間が進まない環境（テストの fake timers）でも回り続けないようにしている。
   *
   * **1 回の待ちには「残り時間」を渡すこと。** 既定の 8 秒刻みのままにすると、20 秒の上限を
   * 跨ぐ判定が 3 周目（24 秒経過時点）まで行われず、上限として書いた数値が実態とずれる。
   */
  const waitForEEWSpeechQuiet = async () => {
    const deadline = Date.now() + NON_EEW_SPEECH_MAX_WAIT_MS
    for (let i = 0; eewSpeechPendingRef.current > 0 && i < 100; i++) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      // チェーンが reject しても待ちを続ける（EEW 側の失敗で非 EEW の読み上げを道連れにしない）
      await capSpeechWait(
        eewSpeechChainRef.current,
        Math.min(EEW_SPEECH_CHAIN_MAX_WAIT_MS, remaining),
      ).catch(() => {})
    }
  }

  /**
   * 非 EEW の読み上げ。EEW の読み上げが途切れるのを待ってから話す。
   *
   * speakWithVoicevox は待ち行列ではなく割り込み（既存の再生を stop し進行中の合成を abort する）
   * なので、待たずに投げると緊急度の低い情報が EEW の発話を途中で消す。実例: 2024/1/1 能登の
   * 16:08 の EEW 第 1 報が、その 0.36 秒後に読み上げの始まった震源情報に潰されていた
   * （震源情報の電文自体は EEW より先に届いており、TTS_DELAY_MS を経て読み上げが始まる。
   * 割り込みは電文の到来順では決まらない）。
   *
   * 逆向き（EEW が地震情報の読み上げを切る）は許す。緊急度どおりであり、また地震情報の本文は
   * 数千文字に達することがあって、その後ろに EEW を並べると致命的に遅れるため。
   */
  const speakNonEEW = (text: string) => {
    void waitForEEWSpeechQuiet()
      .then(() => speakWithVoicevox(settings.voicevoxUrl, text, settings.voicevoxSpeakerId, settings.soundVolume))
      // 発話できなかったことは必ず記録する。黙って落ちると「読み上げられなかった」という
      // 報告から原因を切り分けられない
      .catch(err => log.warn('[tts] 読み上げに失敗', err))
  }

  const handleLiveEvent = (event: AppEvent) => {
    // 受信時に該当タブを自動表示し、ウィンドウタイトルを更新する
    // （地震情報・津波情報・緊急地震速報）。
    // isNewQuake は UI ブロックと TTS ブロックの両方で参照するためここで宣言する
    let isNewQuake = true
    if (event.kind === 'quake' && event.cancelled) {
      // 地震情報取消: カード削除は useEarthquakes reducer が担う。通知音・読み上げのみここで処理する。
      if (settings.soundEnabled) playAlertSound('eewCancel')
      log.info('[tab] → earthquake (地震情報取消)')
      setActiveTabNonRealtime('earthquake')
      title.clearTitleTimer('earthquake')
      title.applyPriority()
      if (settings.voicevoxEnabled) {
        // 取消電文の issue.time は取消電文自体の発表時刻であり、取り消された元の地震情報の発表時刻ではない。
        // 読み上げには同一 eventId で最後に受信した地震情報（既存カード）の time を使う。
        const cancelEventId = extractQuakeEventIdFromId(event.id)
        const original = cancelEventId
          ? earthquakesRef.current.find(e => extractQuakeEventIdFromId(e.id) === cancelEventId)
          : undefined
        setTimeout(() => {
          speakNonEEW(earthquakeCancelToText(original?.time ?? null))
        }, 1200)
      }
    } else if (event.kind === 'quake') {
      log.info('[tab] → earthquake (地震情報 VXSE51/52/53/61)')
      setActiveTabNonRealtime('earthquake')
      const incomingQuake = event as import('../types/earthquake').JMAQuake
      const incomingKey = newQuakeTrackingKey(incomingQuake)
      isNewQuake = incomingKey !== lastNewQuakeKeyRef.current
      if (isNewQuake) {
        lastNewQuakeKeyRef.current = incomingKey
      }
      // 新規・続報いずれも、受信した地震カードを選択状態にする。
      // 選択 ID はカードと照合するため eventKey で渡す。P2PQuake は続報ごとにレコード id が
      // 変わるので、既存カードがあればそのキーを引き継ぐ（このハンドラは useEarthquakes の
      // 統合より前に呼ばれるため、earthquakesRef はこの電文を取り込む前の状態）。
      // 同一 tick に複数電文が捌けて ref が追いつかない場合はキーが実カードと一致せず、
      // 選択は「取消でない最新カード」へフォールバックする（App.tsx の selectedQuake 導出）。
      const existingCard = earthquakesRef.current.find(q => sameQuakeEntry(q, incomingQuake))
      selectQuake(quakeEventKey(existingCard ?? incomingQuake))
      const { hypocenter, maxScale } = event.earthquake
      const isForeignQuake = event.issue.type === '遠地地震'
      // 震度なし続報（VXSE52 等）ではタイトルを更新しない（直前の VXSE51 表示を維持する）。
      // ただし遠地地震は maxScale が常に -1 で、続報も同じ eventId・種別のため isNewQuake も
      // false になる。この条件のままだと規模が確定した続報がタイトルに一切反映されないため除外する。
      if (maxScale >= 0 || isNewQuake || isForeignQuake) {
        // 遠地地震は国内で震度を観測しない（maxScale は常に -1）。「最大震度不明」と出すと
        // 震度が判明していないだけに読めてしまうため、規模を出す別書式にする。
        title.setTitle(isForeignQuake
          ? `🔴 遠地地震 ${hypocenter.name}${hasMagnitude(hypocenter.magnitude) ? ` ${formatMagnitude(hypocenter.magnitude)}` : ''}`
          : `🔴 地震情報 ${hypocenter.name} 最大震度${getIntensityLabel(maxScale)}`)
      }
      title.scheduleTitleRevert('earthquake')
    } else if (event.kind === 'tsunami' && !event.cancelled) {
      // タブ強制切替の優先度ルール（CRIT-4 対応）:
      //   - 新規発報（別 eventId or 前回取消済み）と grade 格上げのみが tsunami タブを奪える
      //   - 続報（同一 eventId の観測点更新等）は setActiveTabNonRealtime を呼ばず抑制タイマー
      //     をリセットしない（毎回 15 秒抑制が再セットされて EEW 続報が realtime へ戻れなく
      //     なる事象を回避）
      //   - EEW の発表状況はここでは見ない。津波は EEW のレベルに関わらずタブを奪う
      const current = tsunamisRef.current[0]
      const isNew = isTsunamiNewFire(event, current)
      const upgraded = isTsunamiGradeUpgrade(event, current)
      if (isNew || upgraded) {
        log.info(`[tab] → tsunami (${isNew ? '新規発報' : 'グレード格上げ'})`)
        setActiveTabNonRealtime('tsunami')
      } else {
        log.debug('[tab] tsunami タブ強制切替スキップ (同一イベント扱い・grade 不変)')
      }
      title.showTsunamiTitle()
    } else if (event.kind === 'tsunami' && event.cancelled) {
      // 「津波解除検出」effect はレンダー後の非同期発火のため、受信直後の即時反映用にここでもタイマーをリセットする。
      // EEW の発表状況はここでは見ない（新規発報側と対称）。
      // 音・TTS・タブ切替は eventId 単位で 1 回だけ発火する（TSU-1/3/4 経路で同一 eventId の
      // expired が複数キューに積まれても 2 回目以降を握り潰す）。
      // ページリロード後の初回解除は Set に無いため正常に発火する（HIGH-1 対応: 「未追跡」と
      // 「解除済み」を lastTsunamiGradeRef===null で混同していたのを eventId 単位に置き換え）。
      // eventId 単位で追跡（serial が変わっても同一 event の重複 cancel を捕捉できる）。
      // eventId が空文字 or 未設定の電文は event.id にフォールバック（XML 経路の parseTsunamiFromXml
      // は EventID 欠落時に空文字を返すため `??` ではなく `||` を使う）。長期セッションでの無制限
      // 増加を防ぐため 200 件を超えたらクリア（DMDSS 続報・合成 expired タイマー・P2PQuake 経路の
      // 重複を捕捉できる深さ。実運用でこの件数の cancel を 1 セッションで扱うことは非現実的）。
      const cancelId = (event.eventId || event.id)
      if (spokenTsunamiCancelEventIdsRef.current.size > 200) {
        spokenTsunamiCancelEventIdsRef.current.clear()
      }
      const alreadySpoken = spokenTsunamiCancelEventIdsRef.current.has(cancelId)
      if (!alreadySpoken) {
        log.info('[tab] → tsunami (津波情報取消)')
        setActiveTabNonRealtime('tsunami')
      }
      title.endTsunamiTitleWindow()
      title.applyPriority()
      // 津波解除・取消・失効の通知音（AUD-6）。cancelReason の 3 種を区別せず単一音で伝える。
      // TTS は eewCancel と同じく音の後ろへずらして音響重複を避ける。遅延は音長に合わせること
      // （tsunamiCancel は終止形 2 音で乾音が約 2.0 秒。eewCancel の約 1.25 秒より長い）。
      // tsunamiCancel はリバーブ（wet）を効かせているため、乾音が止まったあとも残響が尾を引く。
      // 乾音の長さちょうどでは足りないので 0.4 秒ぶん余白を足している（eewCancel は wet=0 で
      // 残響が無いため、同じ 1200ms でも重ならない）。
      if (!alreadySpoken) {
        spokenTsunamiCancelEventIdsRef.current.add(cancelId)
        if (settings.soundEnabled) playAlertSound('tsunamiCancel')
        if (settings.voicevoxEnabled) {
          setTimeout(() => {
            speakNonEEW(tsunamiCancelToText(event.cancelReason))
          }, 2400)
        }
      }
      lastTsunamiGradeRef.current = null
      lastMaxObsHeightRef.current.clear()
      window.clearTimeout(obsStatusClearTimerRef.current)
      setObsUpdateStatus(new Map())
      setFocusedDistrict({ districts: [], top: null, ts: Date.now() })
    } else if (event.kind === 'eew') {
      if (event.test) return

      const key = event.issue?.eventId ?? event.id

      if (event.cancelled) {
        // EEW キャンセル（誤報取消）または解除（最終報満了）: レベル追跡から除去
        // expired: true は最終報タイマー満了による自動解除 → 音は鳴らさない
        // hadKey: P2PQuake WS と Yahoo の両方から cancel が来た場合の二重鳴り防止（AUD-2）
        const hadKey = activeEEWLevelsRef.current.has(key)
        log.info(`[eew] キャンセル受信 key=${key} expired=${event.expired ?? false} hadKey=${hadKey} 種別=${event.expired ? '自動解除(タイマー満了)' : '誤報取消'}`)
        activeEEWLevelsRef.current.delete(key)
        spokenEEWScalesRef.current.delete(key)
        spokenEEWLpgmClassesRef.current.delete(key)
        activeEEWAnnouncedHypocentersRef.current.delete(key)
        // 音・読み上げは hadKey=true（このセッションで表示中の EEW を取り消す場合）のみ発火する。
        // hadKey=false のケースは 2 種類ある:
        //   1. 既に自動解除済みの後に遅れて届いた本物の誤報取消電文（訂正情報として重要）
        //   2. P2PQuake WS と Yahoo の両方から cancel が届いた場合の 2 回目（同一情報の重複）
        // 音・読み上げは 2 の二重鳴りを避けるため hadKey ガードするが、
        // ブラウザ通知は tag=`eew-cancel-${key}` で自動上書きされるため hadKey ガード不要。
        // 1 のケースでも通知だけは伝えることで訂正情報の握り潰しを防ぐ（AUD-2）。
        if (!event.expired) {
          if (hadKey) {
            if (settings.soundEnabled) playAlertSound('eewCancel')
            if (settings.voicevoxEnabled) {
              setTimeout(() => {
                chainEEWSpeech(() => eewCancelToText(event))
              }, 1200)
            }
          }
          if (settings.notifyMinScale >= 0 && settings.notifyEEW) {
            showBrowserNotification(
              '緊急地震速報 誤報取消',
              `${event.earthquake.hypocenter.name} の緊急地震速報は誤報でした`,
              `eew-cancel-${key}`,
            )
          }
        }
        // EEW 解除時は当該 eventId の読み上げ待ちを取り下げる。
        // eewTtsEventsRef を消すことで、既にチェーンに繋がっている予約も解決時に自ら黙る
        // （取り消された地震の予想震度を読み上げないための最終ガード）。
        const pendingMaxTimer = eewTtsMaxTimersRef.current.get(key)
        if (pendingMaxTimer) { clearTimeout(pendingMaxTimer); eewTtsMaxTimersRef.current.delete(key) }
        eewTtsEventsRef.current.delete(key)
        eewPhase2TokensRef.current.delete(key)
        eewPhase2DoneRef.current.delete(key)
        spokenEEWLevelsRef.current.delete(key)
        if (!event.expired && hadKey) {
          // 誤報取消（10秒キャンセル表示中）: 他に発表中のEEWがあってもリアルタイムタブでオーバーレイを見せる
          log.info('[tab] → realtime (EEW誤報取消・キャンセル表示)')
          setActiveTab('realtime')
        }
        if (activeEEWLevelsRef.current.size === 0) {
          title.clearTitleTimer('eew')
          title.applyPriority({ eews: new Map<string, EEWAlert>() })
          // 自動解除（expired）はタブを動かさない。誤報取消の遅延到達（!hadKey かつ !expired）のみ対象。
          // 最終報を複数受信すると expired キャンセルも複数キューに入るため、
          // 2発目（hadKey=false・expired=true）でタブが動かないよう expired を明示的に除外する。
          if (!hadKey && !event.expired) {
            if (kyoshinDetectedRef.current) {
              log.info('[tab] → realtime (EEW全解除・揺れ検知中)')
              setActiveTab('realtime')
            } else {
              log.info(`[tab] → ${defaultTabRef.current} (EEW全解除)`)
              revertToDefaultTab()
            }
          }
        }
        return
      }

      const currentLevel = computeSingleEEWLevel(event)
      const scale = eewMaxScale(event)

      // 新規発報か続報かを判定し、レベルの格上げを検出する。
      // 震度・長周期階級の引き上げはここでは見ない。読み上げ側は「実際に発話した値」と
      // 「発話する直前の最新値」を比べるため（enqueuePhase2）、受信時点の比較は使わない。
      const isNew = !activeEEWLevelsRef.current.has(key)
      const prevLevel = activeEEWLevelsRef.current.get(key) ?? 0
      const levelUpgraded = !isNew && currentLevel > prevLevel

      // 新規発報・レベルアップは抑制なしで即時移動。続報は抑制タイマーを確認する。
      if (isNew || levelUpgraded) {
        log.info(`[tab] → realtime (EEW${isNew ? '新規発報' : 'レベルアップ'} key=${key})`)
        setActiveTab('realtime')
      } else {
        setActiveTabRealtimeOnUpdate()
      }
      activeEEWLevelsRef.current.set(
        key,
        (isNew ? currentLevel : Math.max(prevLevel, currentLevel)) as 0 | 1 | 2,
      )
      // spokenEEW*Ref（読み上げた震度・階級・区分）は受信時点では更新しない。
      // 発話の直前だけで更新する（理由は宣言箇所のコメント）。

      if (settings.soundEnabled) {
        const eewSoundType = selectEEWSoundType(isNew, levelUpgraded, currentLevel, event.isFinal ?? false)
        playAlertSound(eewSoundType)
      }
      if (settings.notifyMinScale >= 0 && settings.notifyEEW && (isNew || levelUpgraded)) {
        const eewNotifyTitle = currentLevel === 2 ? '緊急地震速報 特別警報'
          : currentLevel === 1 ? '緊急地震速報 警報' : '緊急地震速報 予報'
        showBrowserNotification(
          eewNotifyTitle,
          `${event.earthquake.hypocenter.name}${scale > 0 ? ` 最大震度${getIntensityLabel(scale)}予想` : ''}`,
          `eew-${key}`,
          true,
        )
      }
      // EEW タイトルをイベントデータから構築（state は未更新のため event 直接参照）
      const newCount = activeEEWLevelsRef.current.size
      const eewTitle = `🚨 緊急地震速報 ${event.earthquake.hypocenter.name}` +
        (scale > 0 ? ` 最大震度${getIntensityLabel(scale)}予想` : '') +
        (newCount > 1 ? ` 他${newCount - 1}件` : '')
      title.setTitle(eewTitle)
      title.scheduleTitleRevert('eew')

      // VOICEVOX: 2フェーズ読み上げ
      // 第1フェーズ（isNew 即時、または続報での震源の大幅更新時）:
      //   「緊急地震速報、〇〇で地震。」/「震源を更新、〇〇で地震。」
      // 第2フェーズ（第1フェーズの完了後。以降の続報も直前の発話の完了後）:
      //   「（警報。）予想最大震度〇〇。（予想最大階級〇。）」
      // 続報で予想が上がったときも同じ形で言い直す（引き上げ専用の短句は持たない。
      // 理由は eewIntensityToText の JSDoc）。
      // 読み上げは soundEnabled と独立に voicevoxEnabled のみで判定する（AUD-7）。
      if (settings.voicevoxEnabled) {
        eewTtsEventsRef.current.set(key, event)

        const clearPhase2MaxTimer = () => {
          const maxTimer = eewTtsMaxTimersRef.current.get(key)
          if (maxTimer) { clearTimeout(maxTimer); eewTtsMaxTimersRef.current.delete(key) }
        }

        /**
         * 第 2 フェーズ（予想値）をチェーンの末尾に予約する。
         *
         * 予約は eventId ごとに高々 1 件。解決した時点で「その時点の最新イベント」を読み直すため、
         * 続報が連投されても積む必要が無い。直前の発話の完了を待ってから話すので、デバウンスを
         * 置かなくても連呼にならず、かつ連投中に沈黙もしない。
         */
        const enqueuePhase2 = () => {
          if (eewPhase2TokensRef.current.has(key)) return
          const token = {}
          eewPhase2TokensRef.current.set(key, token)
          chainEEWSpeech(() => {
            // 震源の大幅更新で予約を破棄した場合、この予約はここで降りる
            // （Promise は途中で止められないため、識別子の一致で判別する）。
            if (eewPhase2TokensRef.current.get(key) !== token) return null
            eewPhase2TokensRef.current.delete(key)
            // 待っている間に誤報取消・自動解除が届くことがある。これが無いと、取り消された
            // 地震の予想震度をキャンセル通知の直後に読み上げてしまう。
            const latest = eewTtsEventsRef.current.get(key)
            if (!latest) return null
            const latestScale = eewMaxScale(latest)
            const latestLpgmClass = eewMaxLpgmClass(latest)
            // 区分は引き下げない。一度「警報」と読んだ EEW は、以後の続報で severity が落ちても
            // 警報として読み続ける（activeEEWLevelsRef の Math.max と同じ方針）。
            const spokenLevel = spokenEEWLevelsRef.current.get(key) ?? 0
            const level = Math.max(computeSingleEEWLevel(latest), spokenLevel) as 0 | 1 | 2
            // まだ一度も予想値を読んでいなければ無条件に読む（初報・震源更新の読み直し）。
            // 読んだ後は、実際に発話した値より上がったものが一つも無ければ黙る（引き下げは追わない）。
            if (eewPhase2DoneRef.current.has(key)
              && latestScale <= (spokenEEWScalesRef.current.get(key) ?? 0)
              && latestLpgmClass <= (spokenEEWLpgmClassesRef.current.get(key) ?? 0)
              && level <= spokenLevel) return null
            const text = eewIntensityToText(latest, level)
            if (!text) return null
            // 既読の更新は発話の直前だけで行う。予約した時点で更新すると、取消で捨てられた発話や
            // 割り込みで消えた発話まで既読になり、一度も声に出していない値が基準になってしまう。
            spokenEEWScalesRef.current.set(key, latestScale)
            spokenEEWLpgmClassesRef.current.set(key, latestLpgmClass)
            spokenEEWLevelsRef.current.set(key, level)
            eewPhase2DoneRef.current.add(key)
            return text
          })
        }

        // 続報での震源地名変化+座標移動の検出（B-3: 名前変化かつ50km超移動で再発話）
        const hypo = event.earthquake.hypocenter
        const prevHypo = activeEEWAnnouncedHypocentersRef.current.get(key)
        const hypoNameChanged = !isNew && prevHypo !== undefined && hypo.name !== prevHypo.name
        const hypoFarMoved = hypoNameChanged && Number.isFinite(hypo.latitude) && Number.isFinite(hypo.longitude)
          && haversineKm(hypo.latitude, hypo.longitude, prevHypo.lat, prevHypo.lng) > 50
        const firePhase1 = isNew || hypoFarMoved

        if (firePhase1) {
          // 第1フェーズ。震源が大きく動いた場合は旧震源での値を基準に残さない。残すと新震源で
          // 確定した値が旧値を超えたときだけ報じられ、震源が変わったことに触れないまま終わる。
          clearPhase2MaxTimer()
          eewPhase2TokensRef.current.delete(key)
          eewPhase2DoneRef.current.delete(key)
          spokenEEWScalesRef.current.delete(key)
          spokenEEWLpgmClassesRef.current.delete(key)
          const phase1Text = eewAlertToText(event, hypoFarMoved)
          // 待っている間に取消・自動解除が届いていたら震源も読まない
          chainEEWSpeech(() => eewTtsEventsRef.current.has(key) ? phase1Text : null)
          // 発話した震源情報を記録する
          if (Number.isFinite(hypo.latitude) && Number.isFinite(hypo.longitude)) {
            activeEEWAnnouncedHypocentersRef.current.set(key, { name: hypo.name, lat: hypo.latitude, lng: hypo.longitude })
          }
          if (scale > 0) {
            // 予想震度が既に確定している。待たずに予約する（続報の連投で沈黙しないための要）
            enqueuePhase2()
          } else {
            // 予想震度がまだ無い（仮定震源要素の初期報など）。値が付いた続報で読むが、
            // 最後まで付かないこともあるため上限で打ち切り、理由付きの「予想震度なし」を読む。
            const maxTimer = setTimeout(() => {
              eewTtsMaxTimersRef.current.delete(key)
              enqueuePhase2()
            }, EEW_PHASE2_MAX_WAIT_MS)
            eewTtsMaxTimersRef.current.set(key, maxTimer)
          }
        } else if (!eewPhase2DoneRef.current.has(key)) {
          // 予想震度が付くのを待っている最中の続報。値が確定した時点で読む。
          // 値が付かないままでも、警報への格上げは上限を待たずに知らせる
          // （仮定震源要素のまま警報が確定する地震では、待つと最大 6 秒無言になる）
          if (scale > 0 || levelUpgraded) {
            clearPhase2MaxTimer()
            enqueuePhase2()
          }
        } else {
          // 予想値を読んだ後の続報。上がっているかは予約の解決時に最新値で判定するため、
          // ここでは条件を持たずに予約する。受信時点で絞ると、発話までに届いた続報の伸びを
          // 取りこぼす（連投中は 1 回の発話の間に何報も届く）。
          enqueuePhase2()
        }
      }

      return
    }

    // 長周期地震動情報（DMDSS版のみ）
    if ((event as unknown as { kind?: string }).kind === 'lpgm') {
      log.info('[tab] → earthquake (長周期地震動)')
      setActiveTabNonRealtime('earthquake')
      const lpgmEvent = (event as unknown as { kind: string; data: import('../types/earthquake').JMALpgm }).data
      if (!lpgmEvent.cancelled) {
        // 紐づく地震カードを選択し、自動的に LPGM 表示をオンにする
        const matchedQuake = earthquakesRef.current.find(q => extractQuakeEventIdFromId(q.id) === lpgmEvent.eventId)
        if (matchedQuake) selectQuake(quakeEventKey(matchedQuake))
        setActiveLpgmEventId(lpgmEvent.eventId)
      }
      if (settings.soundEnabled) {
        playAlertSound('earthquake')
      }
      if (settings.voicevoxEnabled) {
        const lpgm = lpgmEvent
        const isNewLpgm = !seenLpgmEventIdsRef.current.has(lpgm.eventId)
        setTimeout(() => {
          speakNonEEW(lpgmToText(lpgm, ttsRegionOptions(settings), isNewLpgm))
        }, 1000)
      }
      // voicevox 有効/無効に関わらず追跡する（次回の isNewLpgm 判定に使用）
      seenLpgmEventIdsRef.current.add(lpgmEvent.eventId)
      return
    }

    // 南海トラフ臨時情報・後発地震注意情報（DMDSS版のみ）
    if ((event as unknown as { kind?: string }).kind === 'nankai' || (event as unknown as { kind?: string }).kind === 'kohatsu') {
      const specialEvent = event as unknown as { kind: string; data: { cancelled?: boolean; kindName?: string } }
      if (!specialEvent.data.cancelled) {
        if (settings.soundEnabled) {
          playAlertSound('specialInfo')
        }
        // 読み上げは soundEnabled と独立に voicevoxEnabled のみで判定する（AUD-7）。
        if (settings.voicevoxEnabled) {
          const ttsText = specialEvent.kind === 'nankai'
            ? nankaiToText(specialEvent.data as Parameters<typeof nankaiToText>[0])
            : kohatsuToText(specialEvent.data as Parameters<typeof kohatsuToText>[0])
          setTimeout(() => {
            speakNonEEW(ttsText)
          }, 1500)
        }
        // タイトル更新
        const specialTitle = specialEvent.kind === 'nankai'
          ? `⚠️ 南海トラフ臨時情報（${specialEvent.data.kindName ?? '発表中'}）`
          : '⚠️ 後発地震注意情報 発表中'
        title.setTitle(specialTitle)
        title.scheduleTitleRevert('specialInfo')
      } else {
        // 取消・終了時はタイマーをクリアして即時リセット
        title.clearTitleTimer('specialInfo')
        title.applyPriority()
        if (specialEvent.kind === 'nankai' && settings.voicevoxEnabled) {
          speakNonEEW(nankaiToText(specialEvent.data as Parameters<typeof nankaiToText>[0]))
        }
      }
      return
    }

    // ブラウザ通知（津波）— 音が無効でも送る
    if (event.kind === 'tsunami' && !event.cancelled && settings.notifyMinScale >= 0 && settings.notifyTsunami) {
      const grade = tsunamiMaxGrade(event)
      const tsunamiNotifyTitle = grade === 'MajorWarning' ? '大津波警報'
        : grade === 'Warning' ? '津波警報'
        : grade === 'Forecast' ? '津波予報（若干の海面変動）'
        : '津波注意報'
      showBrowserNotification(
        tsunamiNotifyTitle,
        event.areas.slice(0, 5).map(a => a.name).join('、'),
        'tsunami',
        true,
      )
    }
    // 通知音（地震情報・津波情報）の種別判定。voicevox の delay 決定にも使うため
    // soundEnabled と独立に計算する（AUD-7: 読み上げは voicevoxEnabled 単独判定）。
    let type: AlertSoundType | null = null
    if (event.kind === 'tsunami') {
      if (!event.cancelled) {
        const grade = tsunamiMaxGrade(event)
        const GRADE_RANK_SOUND = { MajorWarning: 4, Warning: 3, Watch: 2, Forecast: 1, Unknown: 0 } as const
        type GradeSoundKey = keyof typeof GRADE_RANK_SOUND
        const prevGradeForSound = lastTsunamiGradeRef.current
        const gradeUnchanged = prevGradeForSound !== null && GRADE_RANK_SOUND[grade as GradeSoundKey] === GRADE_RANK_SOUND[prevGradeForSound as GradeSoundKey]
        const isDowngradeSound = prevGradeForSound !== null && GRADE_RANK_SOUND[grade as GradeSoundKey] < GRADE_RANK_SOUND[prevGradeForSound as GradeSoundKey]
        if (gradeUnchanged || isDowngradeSound) {
          type = 'tsunamiUpdate'
        } else if (grade === 'MajorWarning') type = 'tsunamiMajor'
        else if (grade === 'Warning')        type = 'tsunami'
        else if (grade === 'Watch')          type = 'tsunamiWatch'
        else if (grade === 'Forecast')       type = 'tsunamiForecast'
      }
    } else if (event.kind === 'quake' && !event.cancelled) {
      const it = event.issue.type
      type = it === '震度速報'                                                          ? 'earthquakePrompt'
           : (it === '震源情報' || it === '遠地地震' || it === 'その他') ? 'earthquakeInfo'
           : 'earthquake'  // 震源・震度情報 / 各地の震度情報
    }
    if (!type) return
    if (settings.soundEnabled) playAlertSound(type)

    // VOICEVOX 読み上げ（新しい情報が来たら再生中を割り込み停止して読み直す）
    if (settings.voicevoxEnabled) {
      const TTS_DELAY_MS: Partial<Record<AlertSoundType, number>> = {
        earthquake:       1000,
        earthquakePrompt:  500,
        earthquakeInfo:   1700,
        tsunamiForecast:  1900,
        tsunamiWatch:     1700,
        tsunami:          2800,
        tsunamiMajor:     4200,
        tsunamiUpdate:     800,
      }
      let ttsText: string | null = null
      if (event.kind === 'quake' && !event.cancelled) {
        ttsText = earthquakeToText(event, ttsRegionOptions(settings), isNewQuake)
      } else if (event.kind === 'tsunami') {
        const GRADE_RANK = { MajorWarning: 4, Warning: 3, Watch: 2, Forecast: 1, Unknown: 0 } as const
        type GradeKey = keyof typeof GRADE_RANK
        const currentGrade = tsunamiMaxGrade(event)
        const prevGrade = lastTsunamiGradeRef.current

        if (prevGrade !== null && GRADE_RANK[currentGrade as GradeKey] === GRADE_RANK[prevGrade as GradeKey]) {
          // グレード不変: 観測点ごとに最大波高を追跡し、更新があった観測点のみ読み上げ
          const prevMap = lastMaxObsHeightRef.current
          const updatedObs = (event.observations ?? []).filter(o => {
            if (!o.height) return false
            const prev = prevMap.get(o.name)
            if (prev === undefined) return true
            if (o.height.value > prev.value) return true
            // 同値でも over フラグへの昇格（センサー上限超過）は読み上げ対象
            if (o.height.over && !prev.over && o.height.value >= prev.value) return true
            return false
          })
          // 波高未確定（観測中）のまま新規に到達が確認された観測点は「到達確認」として読み上げる
          const newlyArrivedObs = (event.observations ?? [])
            .filter(o => !o.height && !seenObsNamesRef.current.has(o.name))
          const updateText = updatedObs.length > 0 ? tsunamiObservationUpdateToText(updatedObs, event.headline) : ''
          const arrivalText = tsunamiArrivalToText(newlyArrivedObs)
          if (updateText) {
            ttsText = arrivalText ? `${updateText}${arrivalText}` : updateText
          } else if (arrivalText) {
            ttsText = `津波観測情報。${arrivalText}`
          }
        } else {
          const isDowngrade = prevGrade !== null && GRADE_RANK[currentGrade as GradeKey] < GRADE_RANK[prevGrade as GradeKey]
          ttsText = isDowngrade ? tsunamiDowngradeToText(event) : tsunamiToText(event)
          // グレード変化と同時に観測中（波高未確定）で新規到達した観測点も読み上げに含める
          const newlyArrivedObsOnGradeChange = (event.observations ?? [])
            .filter(o => !o.height && !seenObsNamesRef.current.has(o.name))
          const arrivalTextOnGradeChange = tsunamiArrivalToText(newlyArrivedObsOnGradeChange)
          if (arrivalTextOnGradeChange) ttsText += arrivalTextOnGradeChange
        }
      }
      if (ttsText && type) {
        const delay = TTS_DELAY_MS[type] ?? 0
        setTimeout(() => {
          speakNonEEW(ttsText!)
        }, delay)
      }
    }
    // grade・観測波高トラッキング・UI更新: voicevox 有効/無効に関わらず実行する。
    // Unknown（観測のみ電文など areas=[] のケース）はグレード追跡を維持する。
    if (event.kind === 'tsunami' && !event.cancelled) {
      const grade = tsunamiMaxGrade(event)
      const prevGrade552 = lastTsunamiGradeRef.current
      if (grade !== 'Unknown') lastTsunamiGradeRef.current = grade

      // obsUpdateStatus・focusedDistrict の更新（lastMaxObsHeightRef 更新前に判定する）
      const GRADE_RANK_552 = { MajorWarning: 4, Warning: 3, Watch: 2, Forecast: 1, Unknown: 0 } as const
      type GradeKey552 = keyof typeof GRADE_RANK_552
      const prevMap552 = lastMaxObsHeightRef.current
      const newStatusEntries: [string, 'new' | 'updated'][] = []

      if (prevGrade552 !== null && GRADE_RANK_552[grade as GradeKey552] === GRADE_RANK_552[prevGrade552 as GradeKey552]) {
        const updatedObs552 = (event.observations ?? []).filter(o => {
          if (!o.height) return false
          const prev = prevMap552.get(o.name)
          if (prev === undefined) return true
          if (o.height.value > prev.value) return true
          if (o.height.over && !prev.over && o.height.value >= prev.value) return true
          return false
        })
        // 波高未確定（観測中）のまま新規到達した観測点もスクロール・バッジ表示の対象にする
        const newlyArrivedObs552 = (event.observations ?? []).filter(o => !o.height && !seenObsNamesRef.current.has(o.name))
        if (updatedObs552.length > 0 || newlyArrivedObs552.length > 0) {
          const topObs = updatedObs552.length > 0 ? updatedObs552.reduce((a, b) => (b.height!.value > a.height!.value ? b : a)) : null
          setFocusedDistrict({
            districts: uniqueDistricts([...updatedObs552, ...newlyArrivedObs552]),
            top: topObs
              ? { code: topObs.districtCode, name: topObs.districtName }
              : pickTopFromCardOrder(newlyArrivedObs552, event.areas, event.observations ?? []),
            ts: Date.now(),
          })
        } else {
          // スクロール先となる変化が無い電文（再送・実質変化なし）は一番上へ戻す
          setFocusedDistrict({ districts: [], top: null, ts: Date.now() })
        }
        for (const o of updatedObs552) newStatusEntries.push([o.name, prevMap552.has(o.name) ? 'updated' : 'new'])
        for (const o of newlyArrivedObs552) newStatusEntries.push([o.name, 'new'])
      } else {
        const obsWithHeight552 = (event.observations ?? []).filter(o => !!o.height)
        // 波高未確定（観測中）のまま新規到達した観測点もスクロール・バッジ表示の対象にする
        const newlyArrivedObs552b = (event.observations ?? []).filter(o => !o.height && !seenObsNamesRef.current.has(o.name))
        if (obsWithHeight552.length > 0 || newlyArrivedObs552b.length > 0) {
          const topObs = obsWithHeight552.length > 0 ? obsWithHeight552.reduce((a, b) => (b.height!.value > a.height!.value ? b : a)) : null
          setFocusedDistrict({
            districts: uniqueDistricts([...obsWithHeight552, ...newlyArrivedObs552b]),
            top: topObs
              ? { code: topObs.districtCode, name: topObs.districtName }
              : pickTopFromCardOrder(newlyArrivedObs552b, event.areas, event.observations ?? []),
            ts: Date.now(),
          })
        } else {
          // 観測データが無い発表（区域・グレードのみの電文）は一番上へ戻す
          setFocusedDistrict({ districts: [], top: null, ts: Date.now() })
        }
        for (const o of obsWithHeight552) newStatusEntries.push([o.name, 'new'])
        for (const o of newlyArrivedObs552b) newStatusEntries.push([o.name, 'new'])
      }

      // 津波情報を受信するたびに obsUpdateStatus を今回分だけの Map に置き換える（前回分は破棄）。
      // 60秒以内に次の情報が来なければ obsStatusClearTimerRef が空 Map にする。
      setObsUpdateStatus(new Map(newStatusEntries))
      window.clearTimeout(obsStatusClearTimerRef.current)
      obsStatusClearTimerRef.current = window.setTimeout(() => setObsUpdateStatus(new Map()), 60000)

      for (const o of event.observations ?? []) {
        seenObsNamesRef.current.add(o.name)
        if (!o.height) continue
        const prev = lastMaxObsHeightRef.current.get(o.name)
        if (prev === undefined || o.height.value > prev.value || (o.height.over && !prev.over)) {
          lastMaxObsHeightRef.current.set(o.name, { value: o.height.value, over: o.height.over })
        }
      }
    }
  }

  // EEW 読み上げタイマーと観測点ステータス自動消去タイマーをアンマウント時にクリーンアップする
  useEffect(() => {
    return () => {
      for (const timer of eewTtsMaxTimersRef.current.values()) clearTimeout(timer)
      eewSpeechPendingRef.current = 0
      window.clearTimeout(obsStatusClearTimerRef.current)
    }
  }, [])

  // リプレイ開始・終了時に追跡 ref を初期化する。
  // handleStartReplay の useCallback deps を壊さないよう安定参照（deps なし）にする。
  const resetTracking = useCallback(() => {
    lastNewQuakeKeyRef.current = null
    activeEEWLevelsRef.current.clear()
    spokenEEWScalesRef.current.clear()
    spokenEEWLpgmClassesRef.current.clear()
    spokenEEWLevelsRef.current.clear()
    activeEEWAnnouncedHypocentersRef.current.clear()
    for (const timer of eewTtsMaxTimersRef.current.values()) clearTimeout(timer)
    eewTtsMaxTimersRef.current.clear()
    eewTtsEventsRef.current.clear()
    eewPhase2TokensRef.current.clear()
    eewSpeechChainRef.current = Promise.resolve()
    // カウンタも戻す。残したままだとリプレイを切り替えても非 EEW の読み上げが待たされ続ける
    eewSpeechPendingRef.current = 0
    eewPhase2DoneRef.current.clear()
    lastTsunamiGradeRef.current = null
    lastMaxObsHeightRef.current.clear()
    seenObsNamesRef.current.clear()
    seenLpgmEventIdsRef.current.clear()
    // 60秒 obs バッジ自動消去タイマーもリプレイ切替時に持ち越さない（アンマウント経路と対称）
    window.clearTimeout(obsStatusClearTimerRef.current)
    obsStatusClearTimerRef.current = 0
  }, [])

  // pre-window イベントから T 時点の追跡 ref を復元する（サイレント注入後の正確な音判定に必要）
  const restorePreWindowTracking = useCallback((preFiltered: ReplayEntry[]) => {
    for (const { payload } of preFiltered) {
      if (payload.kind === 'event') {
        const ev = payload.event
        if (ev.kind === 'quake') {
          // ライブ経路（上の handleLiveEvent）と同じキーの組み立て方にそろえる。
          // なおこの復元は DMDATA archive の再生専用で、standard 版からは呼ばれない
          // （`App.tsx` が onStartReplay を isDmdss のときだけ配線している）。
          lastNewQuakeKeyRef.current = newQuakeTrackingKey(ev as JMAQuake)
        } else if (ev.kind === 'eew') {
          const eew = ev as EEWAlert
          const key = eew.issue?.eventId ?? eew.id
          const restoredLevel = computeSingleEEWLevel(eew)
          activeEEWLevelsRef.current.set(key, restoredLevel)
          spokenEEWScalesRef.current.set(key, eewMaxScale(eew))
          spokenEEWLpgmClassesRef.current.set(key, eewMaxLpgmClass(eew))
          // 区分も復元する。落とすと注入後の最初の続報で「警報。」が付き直し、
          // 途中から再生を始めた地震がその場で警報化したように聞こえる。
          spokenEEWLevelsRef.current.set(key, restoredLevel)
          // T 時点までの報は既に発表済みとして扱う。第2フェーズも発話済みにしておかないと、
          // 注入後の続報が読み直され、途中から再生を始めた地震が初報のように聞こえる
          eewPhase2DoneRef.current.add(key)
        } else if (ev.kind === 'tsunami') {
          const tsunami = ev as JMATsunami
          const grade = tsunamiMaxGrade(tsunami)
          if (grade !== 'Unknown') lastTsunamiGradeRef.current = grade
          for (const o of tsunami.observations ?? []) {
            seenObsNamesRef.current.add(o.name)
            if (o.height?.value != null) lastMaxObsHeightRef.current.set(o.name, { value: o.height.value, over: o.height.over })
          }
        }
      } else if (payload.kind === 'lpgm' && !payload.data.cancelled) {
        seenLpgmEventIdsRef.current.add(payload.data.eventId)
      }
    }
  }, [])

  // 津波イベントを経由しないタブ復帰（アイドル復帰・EEW全解除・揺れ検知終了）で
  // 津波タブに切り替わったときに、スクロール位置を一番上へ戻すために公開する。
  const resetTsunamiScrollToTop = useCallback(() => {
    setFocusedDistrict({ districts: [], top: null, ts: Date.now() })
  }, [])

  return { handleLiveEvent, resetTracking, restorePreWindowTracking, obsUpdateStatus, focusedDistrict, resetTsunamiScrollToTop }
}
