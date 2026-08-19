import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppEvent, EEWAlert, JMAQuake, JMATsunami } from '../types/earthquake'
import type { TabId } from '../components/IconNav'
import type { AppSettings } from './useSettings'
import type { AlertTitleApi } from './useAlertTitle'
import type { ReplayEntry } from '../services/dmdataReplay'
import { getIntensityLabel } from '../utils/intensity'
import { formatMagnitude, hasMagnitude } from '../utils/formatters'
import { eewMaxScale, eewMaxLpgmClass, computeSingleEEWLevel, selectEEWSoundType } from '../utils/eew'
import { haversineKm } from '../utils/geo'
import { showBrowserNotification } from '../utils/notifications'
import { tsunamiMaxGrade, isTsunamiNewFire, isTsunamiGradeUpgrade } from '../utils/tsunami'
import { matchesArea, sortAreasForCardDisplay } from '../components/TsunamiTab'
import { playAlertSound, type AlertSoundType } from '../utils/alertSound'
import { speakWithVoicevox } from '../utils/voicevox'
import { eewAlertToText, eewIntensityToText, eewUpgradeToText, eewLevelUpgradeToText, eewCancelToText, earthquakeToText, earthquakeCancelToText, tsunamiToText, tsunamiDowngradeToText, tsunamiCancelToText, tsunamiObservationUpdateToText, tsunamiArrivalToText, nankaiToText, kohatsuToText, lpgmToText, type TtsRegionOptions } from '../utils/ttsText'
import { log } from '../utils/logger'
import { extractQuakeEventIdFromId, quakeEventKey, sameQuakeEntry } from '../utils/quakeMerge'

// EEW 読み上げ第 2 フェーズ（予想値）のタイミング。
// 初報で予想震度が付いていない場合に待つ上限。仮定震源要素（単独点処理）や深発地震では
// 予想震度が最後まで付かないことがあるため、待ちきらずに「予想震度なし」を読んで打ち切る。
const EEW_PHASE2_MAX_WAIT_MS = 6000
// 予想が引き上がったときの短句を読むまでのデバウンス。続報が立て続けに届く大地震では
// 値が動いている最中に読んでも次の報で古くなるため、静まってから最新値を 1 回だけ読む。
const EEW_UPGRADE_DEBOUNCE_MS = 2000

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
  // EEW の eventId ごとに予想最大震度スケールを追跡（同一レベル内の震度引き上げ検出用）
  const activeEEWScalesRef = useRef<Map<string, number>>(new Map())
  // 同じく予想最大長周期地震動階級を追跡する。階級だけが上がる続報（震度据え置きで 2→3 等）は
  // レベル判定（特別警報は階級 4 以上）にも震度にも現れないため、専用に持たないと検出できない。
  const activeEEWLpgmClassesRef = useRef<Map<string, number>>(new Map())
  // 直前に読み上げた津波グレード（引き下げ検出・重複読み上げ抑制に使用）
  const lastTsunamiGradeRef = useRef<'MajorWarning' | 'Warning' | 'Watch' | 'Forecast' | null>(null)
  // 観測点ごとの読み上げ済み最大波高（更新があった観測点のみ TTS 発話するための比較用）
  const lastMaxObsHeightRef = useRef<Map<string, { value: number; over?: boolean }>>(new Map())
  // これまでに一度でも登場した観測点名（波高未確定＝観測中のまま新規到達した観測点を検出するための比較用）
  const seenObsNamesRef = useRef<Set<string>>(new Set())
  // VOICEVOX EEW 読み上げのタイマー。
  //   eewTtsTimersRef     … 引き上げの短句のデバウンス（EEW_UPGRADE_DEBOUNCE_MS）。
  //                         初回の読み上げはこのタイマーを経由しない（値が確定した時点で即読む）
  //   eewTtsMaxTimersRef  … 初回に予想震度が付くのを待つ上限（EEW_PHASE2_MAX_WAIT_MS）
  // 複数 EEW が同時進行するケース（例: 2024/1/1 能登の同時多発）があるため、
  // 全て eventId 別の Map で管理する。単一 ref にすると、後から届いた別イベントの
  // 受信タイミングでタイマー・発話対象イベントが横取りされ、片方の続報が
  // 「読み上げ済み最大震度」を更新できずに無限リトリガーする不具合が起きる。
  const eewTtsTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const eewTtsMaxTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  // Phase 2（予想値）を一度でも発話した eventId。以降の格上げはフル文言ではなく差分の短句で追う
  const eewPhase2DoneRef = useRef<Set<string>>(new Set())
  // タイマー発火時にテキストを生成するため、eventId ごとに最新イベントを保持する（変化なし続報も含め常に最新で上書き）
  const eewTtsEventsRef = useRef<Map<string, EEWAlert>>(new Map())
  // Phase 1（「緊急地震速報、〇〇で地震。」）の再生完了 Promise。Phase 2 はこれを待ってから発話する（eventId 別）
  const eewPhase1PromisesRef = useRef<Map<string, Promise<void>>>(new Map())
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
          speakWithVoicevox(settings.voicevoxUrl, earthquakeCancelToText(original?.time ?? null), settings.voicevoxSpeakerId, settings.soundVolume).catch(() => {})
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
            speakWithVoicevox(settings.voicevoxUrl, tsunamiCancelToText(event.cancelReason), settings.voicevoxSpeakerId, settings.soundVolume).catch(() => {})
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
        activeEEWScalesRef.current.delete(key)
        activeEEWLpgmClassesRef.current.delete(key)
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
                speakWithVoicevox(settings.voicevoxUrl, eewCancelToText(event), settings.voicevoxSpeakerId, settings.soundVolume).catch(() => {})
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
        // EEW 解除時は当該 eventId の読み上げタイマーをキャンセルする
        const pendingTimer = eewTtsTimersRef.current.get(key)
        if (pendingTimer) { clearTimeout(pendingTimer); eewTtsTimersRef.current.delete(key) }
        const pendingMaxTimer = eewTtsMaxTimersRef.current.get(key)
        if (pendingMaxTimer) { clearTimeout(pendingMaxTimer); eewTtsMaxTimersRef.current.delete(key) }
        eewTtsEventsRef.current.delete(key)
        eewPhase1PromisesRef.current.delete(key)
        eewPhase2DoneRef.current.delete(key)
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

      // 新規発報か続報かを判定し、レベル・震度・長周期階級の引き上げを検出する
      const isNew = !activeEEWLevelsRef.current.has(key)
      const prevLevel = activeEEWLevelsRef.current.get(key) ?? 0
      const prevScale = activeEEWScalesRef.current.get(key) ?? 0
      const prevLpgmClass = activeEEWLpgmClassesRef.current.get(key) ?? 0
      const levelUpgraded = !isNew && currentLevel > prevLevel
      const scaleUpgraded = !isNew && scale > prevScale
      const lpgmUpgraded = !isNew && eewMaxLpgmClass(event) > prevLpgmClass

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
      // activeEEWScalesRef は「実際に読み上げた最大震度」を保持する。
      // 受信のたびに更新すると発話前の値で上書きされるため、speakPhase2 内で更新する。

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
      // 第1フェーズ（isNew即時、または続報での震源更新時）: 「緊急地震速報、〇〇で地震。」/「震源を更新、〇〇で地震。」
      // 第2フェーズ（デバウンス後、かつ第1フェーズ完了後）: 「予想最大震度〇〇。」（震源更新時は新しい震源に基づき読み直す）
      // 読み上げは soundEnabled と独立に voicevoxEnabled のみで判定する（AUD-7）。
      if (settings.voicevoxEnabled) {
        eewTtsEventsRef.current.set(key, event)

        const clearPhase2MaxTimer = () => {
          const maxTimer = eewTtsMaxTimersRef.current.get(key)
          if (maxTimer) { clearTimeout(maxTimer); eewTtsMaxTimersRef.current.delete(key) }
        }
        const clearUpgradeTimer = () => {
          const timer = eewTtsTimersRef.current.get(key)
          if (timer) { clearTimeout(timer); eewTtsTimersRef.current.delete(key) }
        }

        // 第2フェーズの発話。isUpgrade=false はフル文言（初報・震源更新）、true は差分の短句。
        // 発話した震度・階級を「読み上げ済み」として記録するのはここだけ。受信のたびに更新すると
        // 発話前の値で上書きされ、引き上げを検出できなくなる。
        const speakPhase2 = (isUpgrade: boolean, levelPrefix = '') => {
          const spokenEvent = eewTtsEventsRef.current.get(key)
          if (!spokenEvent) return
          const text = levelPrefix + (isUpgrade
            ? eewUpgradeToText(
                spokenEvent,
                activeEEWScalesRef.current.get(key) ?? 0,
                activeEEWLpgmClassesRef.current.get(key) ?? 0,
              )
            : eewIntensityToText(spokenEvent))
          activeEEWScalesRef.current.set(key, eewMaxScale(spokenEvent))
          activeEEWLpgmClassesRef.current.set(key, eewMaxLpgmClass(spokenEvent))
          eewPhase2DoneRef.current.add(key)
          if (!text) return   // 差分読みで実際には上がっていなかった場合
          // Phase 1 の再生が終わってから Phase 2 を発話する。
          // 待っている間に誤報取消・自動解除が届くことがある（Phase 1 の再生には数秒かかる）。
          // Promise は途中で止められないため、発話の直前に対象がまだ発表中かを見る。
          // これが無いと、取り消された地震の予想震度をキャンセル通知の直後に読み上げてしまう。
          const phase1Promise = eewPhase1PromisesRef.current.get(key) ?? Promise.resolve()
          phase1Promise.then(() => {
            if (!eewTtsEventsRef.current.has(key)) return
            speakWithVoicevox(settings.voicevoxUrl, text, settings.voicevoxSpeakerId, settings.soundVolume)
              .catch(err => log.warn('[eew] 予想値の読み上げに失敗', err))
          })
        }

        // 引き上げの短句をデバウンスして読む（連投が静まってから最新値だけを 1 回）
        const scheduleUpgrade = () => {
          clearUpgradeTimer()
          const timer = setTimeout(() => {
            eewTtsTimersRef.current.delete(key)
            speakPhase2(true)
          }, EEW_UPGRADE_DEBOUNCE_MS)
          eewTtsTimersRef.current.set(key, timer)
        }
        // 続報での震源地名変化+座標移動の検出（B-3: 名前変化かつ50km超移動で再発話）
        const hypo = event.earthquake.hypocenter
        const prevHypo = activeEEWAnnouncedHypocentersRef.current.get(key)
        const hypoNameChanged = !isNew && prevHypo !== undefined && hypo.name !== prevHypo.name
        const hypoFarMoved = hypoNameChanged && Number.isFinite(hypo.latitude) && Number.isFinite(hypo.longitude)
          && haversineKm(hypo.latitude, hypo.longitude, prevHypo.lat, prevHypo.lng) > 50
        const firePhase1 = isNew || hypoFarMoved

        // レベルの格上げは、どの経路でフル文言を読む場合でも必ず前置きする。震源の大幅更新と
        // 同時に起きることもあるため、分岐ごとに付け外しすると配り忘れが起きる（実際に一度作った）。
        // activeEEWLevelsRef は発話の有無に関わらず毎回更新されるので、ここで落とすと
        // 次の報では levelUpgraded が真にならず、その格上げは二度と声に出ない。
        const levelPrefix = levelUpgraded ? eewLevelUpgradeToText(currentLevel === 2 ? 2 : 1) : ''

        if (firePhase1) {
          // 第1フェーズ：即時（完了 Promise を eventId 別に保持）
          const phase1Promise = speakWithVoicevox(settings.voicevoxUrl, eewAlertToText(event, hypoFarMoved), settings.voicevoxSpeakerId, settings.soundVolume)
            .catch(err => log.warn('[eew] 震源の読み上げに失敗', err))
          eewPhase1PromisesRef.current.set(key, phase1Promise)
          // 発話した震源情報を記録する
          if (Number.isFinite(hypo.latitude) && Number.isFinite(hypo.longitude)) {
            activeEEWAnnouncedHypocentersRef.current.set(key, { name: hypo.name, lat: hypo.latitude, lng: hypo.longitude })
          }
          // 待機中の上限タイマー・引き上げの短句は、新しい震源に基づく読み直しで置き換える
          clearUpgradeTimer()
          clearPhase2MaxTimer()
          if (scale > 0) {
            // 予想震度が既に確定している。待たずに読む（続報の連投で沈黙しないための要）
            speakPhase2(false, levelPrefix)
          } else {
            // 予想震度がまだ無い（仮定震源要素の初期報など）。値が付いた続報で読むが、
            // 最後まで付かないこともあるため上限で打ち切り、理由付きの「予想震度なし」を読む。
            // 震源が大きく動いた場合は旧震源での値を基準に残さない。残すと新震源で確定した値が
            // 旧値を超えたときだけ短句で報じられ、震源が変わったことに触れないまま終わる
            eewPhase2DoneRef.current.delete(key)
            activeEEWScalesRef.current.delete(key)
            activeEEWLpgmClassesRef.current.delete(key)
            const maxTimer = setTimeout(() => {
              eewTtsMaxTimersRef.current.delete(key)
              speakPhase2(false, levelPrefix)
            }, EEW_PHASE2_MAX_WAIT_MS)
            eewTtsMaxTimersRef.current.set(key, maxTimer)
          }
        } else if (!eewPhase2DoneRef.current.has(key)) {
          // 予想震度が付くのを待っている最中の続報。値が確定した時点でフル文言を読む。
          // 値が付かないままでも、警報・特別警報への格上げは上限を待たずに知らせる
          // （仮定震源要素のまま警報が確定する地震では、待つと最大 6 秒無言になる）
          if (scale > 0 || levelUpgraded) {
            clearPhase2MaxTimer()
            speakPhase2(false, levelPrefix)
          }
        } else if (levelUpgraded) {
          // レベルの格上げ（予報→警報→特別警報）は最も重い変化なので、デバウンスを挟まず
          // 区分を告げてから予想値を読み直す。値の差分だけを追うと区分の変化が声に出ない。
          // 震度が伸びて特別警報の条件（震度6弱以上）を跨ぐ形の格上げが典型で、そこでは
          // 震度も同時に上がる。「震度が上がっているなら差分で足りる」と扱うと、
          // まさに一番重い場面で「特別警報に切り替わった」ことだけが抜け落ちる。
          // 格上げは高々 2 回（予報→警報→特別警報）なので、毎回フル文言でも連呼にならない
          clearUpgradeTimer()
          speakPhase2(false, levelPrefix)
        } else if (scaleUpgraded || lpgmUpgraded) {
          scheduleUpgrade()
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
          speakWithVoicevox(settings.voicevoxUrl, lpgmToText(lpgm, ttsRegionOptions(settings), isNewLpgm), settings.voicevoxSpeakerId, settings.soundVolume).catch(() => {})
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
            speakWithVoicevox(settings.voicevoxUrl, ttsText, settings.voicevoxSpeakerId, settings.soundVolume).catch(() => {})
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
          speakWithVoicevox(
            settings.voicevoxUrl,
            nankaiToText(specialEvent.data as Parameters<typeof nankaiToText>[0]),
            settings.voicevoxSpeakerId,
            settings.soundVolume,
          ).catch(() => {})
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
          speakWithVoicevox(settings.voicevoxUrl, ttsText!, settings.voicevoxSpeakerId, settings.soundVolume).catch(() => {})
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
      for (const timer of eewTtsTimersRef.current.values()) clearTimeout(timer)
      for (const timer of eewTtsMaxTimersRef.current.values()) clearTimeout(timer)
      window.clearTimeout(obsStatusClearTimerRef.current)
    }
  }, [])

  // リプレイ開始・終了時に追跡 ref を初期化する。
  // handleStartReplay の useCallback deps を壊さないよう安定参照（deps なし）にする。
  const resetTracking = useCallback(() => {
    lastNewQuakeKeyRef.current = null
    activeEEWLevelsRef.current.clear()
    activeEEWScalesRef.current.clear()
    activeEEWLpgmClassesRef.current.clear()
    activeEEWAnnouncedHypocentersRef.current.clear()
    for (const timer of eewTtsTimersRef.current.values()) clearTimeout(timer)
    eewTtsTimersRef.current.clear()
    for (const timer of eewTtsMaxTimersRef.current.values()) clearTimeout(timer)
    eewTtsMaxTimersRef.current.clear()
    eewTtsEventsRef.current.clear()
    eewPhase1PromisesRef.current.clear()
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
          activeEEWLevelsRef.current.set(key, computeSingleEEWLevel(eew))
          activeEEWScalesRef.current.set(key, eewMaxScale(eew))
          activeEEWLpgmClassesRef.current.set(key, eewMaxLpgmClass(eew))
          // T 時点までの報は既に発表済みとして扱う。第2フェーズも発話済みにしておかないと、
          // 注入後の続報がフル文言で読み直され、途中から再生を始めた地震が初報のように聞こえる
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
