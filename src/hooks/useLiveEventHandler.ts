import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppEvent, EEWAlert, JMAQuake, JMATsunami, JMANankaiCommentary, TsunamiArea, TsunamiObservation } from '../types/earthquake'
import type { TabId } from '../components/IconNav'
import type { AppSettings } from './useSettings'
import type { AlertTitleApi } from './useAlertTitle'
import type { ReplayEntry } from '../types/replay'
import { getIntensityLabel, getIntensityLabelWithOrAbove } from '../utils/intensity'
import { formatMagnitude, hasMagnitude } from '../utils/formatters'
import {
  eewMaxScaleInfo, isForecastScaleHigher, eewMaxLpgmClass, eewNoForecastReason, computeSingleEEWLevel,
  selectEEWSoundType, eewKindLabel, eewPhase2ScaleStabilityMs,
  EEW_PHASE2_STABILITY_MAX_WAIT_MS, EEW_PHASE2_LPGM_STABILITY_MS, type EewMaxScaleInfo,
} from '../utils/eew'
import { haversineKm } from '../utils/geo'
import { showBrowserNotification } from '../utils/notifications'
import { tsunamiMaxGrade, isTsunamiNewFire, isTsunamiGradeUpgrade, isTsunamiObservationOnly, isCancelForCurrentTsunami, matchesArea, sortAreasForCardDisplay, sortObservationsForCardDisplay, mergeTsunamiObservations } from '../utils/tsunami'
import { playAlertSound, type AlertSoundType } from '../utils/alertSound'
import { speakWithVoicevox, prewarmVoicevox, getSpeechClock, stopSpeech, type PrewarmedSpeech, type ShouldStillPlay } from '../utils/voicevox'
import { eewAlertToText, eewIntensityText, eewLpgmOnlyText, eewCancelToText, earthquakeToSegments, earthquakeCancelToText, tsunamiToSegments, tsunamiDowngradeToSegments, tsunamiCancelToText, tsunamiObservationUpdateToSegments, selectObservationUpdatesToSpeak, tsunamiArrivalToSegments, selectArrivalsToSpeak, nankaiToText, nankaiCommentaryToText, kohatsuToText, lpgmToText, createQuakeSpokenState, applySpokenRefs, type TtsRegionOptions, type QuakeSpokenState } from '../utils/ttsText'
import { joinSegments, plain, hasFollowTarget, mapChunksToRefs, spokenChunkIndices, type SpeechFollowApi, type SpeechSegment, type SpeechRef } from '../utils/ttsFollow'
import { log, createLogThrottle } from '../utils/logger'
import { TAB_PRIORITY, type TabPriority } from '../utils/tabPriority'
import { extractQuakeEventIdFromId, quakeEventKey, sameQuakeEntry } from '../utils/quakeMerge'

// EEW 読み上げ第 2 フェーズ（予想値）のタイミング。
// 初報で予想震度が付いておらず、かつ**付かない理由がはっきりしない**場合に待つ上限。
// 仮定震源要素（単独点処理）・深発地震はその報に予想震度が載らないと判っているので待たない
// （判定は eewNoForecastReason）。ここで待つのは「値が遅れて付くかもしれない」場合だけなので、
// 上限は短く取る。長く取ると、結局は理由不明の「予想震度なし」を読むまで無言になる。
const EEW_PHASE2_MAX_WAIT_MS = 3000
// 直列化した EEW 読み上げで、発話の完了を待つ上限。VOICEVOX への合成リクエストには
// タイムアウトが無いため、応答が返らないまま待ち続けると後続の EEW が永久に読まれなくなる。
// 打ち切って次へ進む（止まっていた側は次の発話開始時に abort される）。
const EEW_SPEECH_CHAIN_MAX_WAIT_MS = 8000

/**
 * 非 EEW の読み上げの優先度。**割り込みを許すのは「自分の優先度が読み上げ中のものと同じか
 * 高いとき」だけ**。`speakWithVoicevox` は待ち行列ではなく割り込みなので、優先度を持たせないと
 * 緊急度の低い情報が重い情報を途中で消す（2024/1/1 能登の再生では、大津波警報の読み上げが
 * 30 秒後に始まった地震情報に消されていた）。
 *
 * **同格どうしは新しい方が勝つ。** 震度速報の更新が古い震度速報を置き換えるのは正しい挙動で、
 * ここを待ち行列にすると古い内容を読み終わるまで最新の震度が出てこない。
 * ただし**内容が重ならない同格どうしは互いに待つ**（`MUTUAL_YIELD_TOPICS`）。
 *
 * EEW はこの尺度の外にあり、常に最優先（`eewSpeechPendingRef` で別に管理する）。
 */
const SPEECH_PRIORITY = {
  /**
   * 南海トラフ関連解説情報。段階の発表ではなく状況の解説で、臨時情報の発表期間中は毎日届く。
   *
   * **最下位に置く。** 割り込みの判定は「自分より高い優先度が読み上げ中か」（厳密不等号）なので、
   * 同格どうしは待たずに割り込む。地震情報と同格にすると数千文字に達しうる地震情報の読み上げを
   * 毎日切り、長周期と同格にすると長周期の実測値を切る。どこかと同格にすれば必ず何かを切るため、
   * 単独の最下位に置いて「解説情報は何も切らない」ことを保証する。
   *
   * **待ちきれなかったときは割り込まず黙る**（`speakNonEEW`）。層で「何も切らない」と宣言して
   * いても、待ちの上限（`HIGHER_PRIORITY_SPEECH_MAX_WAIT_MS`）で割り込めばその宣言は破れる。
   * 各地の震度は読み切りに 2 分近く達するため、これは実際に起こりうる経路。
   * 定型文が大半の情報なので、諦めて一度読まないことの損失は小さい。
   */
  commentary: 0,
  /**
   * 地震情報（震度速報・震源情報・地震情報・遠地地震・取消）と長周期地震動情報、
   * および**津波の観測情報**（観測点の波高更新・到達確認）。
   *
   * **長周期を地震情報と同格にしているのは、長周期の方が新しい情報だから。** 同格どうしは
   * 新しい方が勝つ規則なので、地震情報を読んでいる最中に長周期が届けば割り込んで読める。
   * 軽い段に分けていた頃は、各地の震度（数千文字・読み切りに 2 分近く）の後ろに回されて
   * 大幅に遅れていた。
   *
   * **津波の観測情報をここに置くのは、地震情報を切らせないため。** 等級の発表と同じ `high` に
   * 置いていた頃は、観測点の波高が 1 つ更新されるたびに地震情報の読み上げを途中で消していた。
   * ただし単に格を下げるだけでは足りない（同格は待たずに割り込む規則なので、向きが変わるだけ
   * で切ることは変わらない）。あわせて `MUTUAL_YIELD_TOPICS` に載せ、双方が待つようにしている。
   */
  normal: 1,
  /**
   * 津波の等級の発表（新規・格上げ・引き下げ・解除）と南海トラフ臨時情報・後発地震注意情報。
   * 後者を津波と同格にしているのは、発表頻度が極端に低く聞き逃したときの損失が大きいため。
   *
   * **観測情報はここに含めない**（`normal` の注記）。等級が動いたかどうかで格が変わる。
   */
  high: 2,
} as const
type SpeechPriority = typeof SPEECH_PRIORITY[keyof typeof SPEECH_PRIORITY]

/**
 * 読み上げの主題。**同じ主題の後発だけが先発を取り下げられる**（`overtakenByLaterArrival`）。
 *
 * 主題で区切るのは、優先度が同格でも**内容が重なるとは限らない**ため。`high` には津波・南海トラフ
 * 臨時情報・後発地震注意情報が同居しているが、これは「発表頻度が極端に低く聞き逃したときの損失が
 * 大きい」から同格に置いているのであって（`SPEECH_PRIORITY.high` の注記）、互いに言い換えでは
 * ない。主題を見ずに取り下げると、**聞き逃しを防ぐために作った層でまるごと聞き逃す**ことになる。
 *
 * 同じ主題の中では優先度は常に等しいため、取り下げの判定に優先度は要らない（到来順だけで足りる）。
 *
 * **地震と長周期はイベントごとに分ける。** 別の地震は別のイベントで、内容が重ならない（同分に 2 つの地震が
 * 起きることは実際にある）。種別軸だけでまとめると、後から処理された地震だけが読まれ、その前に
 * 届いた別の地震の読み上げが一言も鳴らずに消える。津波・南海トラフ系は常に 1 件だけを追う作りなので
 * イベントで分ける必要がない。
 *
 * **津波は等級の発表と観測情報を分ける**（`tsunami` / `tsunamiObs`）。優先度が違うため、
 * まとめると「同じ主題の中では優先度が等しい」という上の前提が崩れる。取り下げの判定は優先度を
 * 見ずに到来順だけで裁くので、崩れたまま放つと**警報の予約が、後から届いた観測情報に
 * 「追い越された」と判定されて取り下がる**（聞き逃してはいけない側が消える）。
 *
 * なお P2PQuake（standard 版）は続報ごとにキーが変わりうるため、既存カードを引けなかった初報同士
 * では同じ地震でも別主題になる。そのとき取り下げは働かず、先に読み始めた側が後発に切られる従来の
 * 挙動に戻るだけで、情報が消える方向には倒れない。
 */
type SpeechTopic =
  | `quake:${string}`
  | `lpgm:${string}`
  | 'tsunami' | 'tsunamiObs' | 'nankai' | 'kohatsu' | 'nankaiCommentary'

/**
 * **互いの読み上げを切らない主題**（相互譲り）。同格の別主題が鳴っている間は待ち、自分が鳴って
 * いる間は同格の別主題を待たせる。
 *
 * 優先度は一次元の尺度なので、「上が下を切る」一方向の関係しか作れない。ところが同格の中には
 * 逆向きの要求が同居している——同じ地震の続報は**割り込むべき**（言い換えなので最新だけ読めば
 * よい）、長周期と地震情報も**割り込むべき**（新しい方が重い）、しかし津波の観測情報と地震情報は
 * **どちらも読みたい**（内容が重ならない）。主題でしか切り分けられないため、ここに列挙する。
 *
 * **同主題どうしは対象外**（言い換えなので割り込む）。判定は `speechBlocker` にある。
 *
 * **片方が載っていれば両方向で待つ。** 地震情報は相互譲りを持たないが、観測情報が載っていれば
 * 「観測情報は地震情報を切らない」と「地震情報は観測情報を切らない」の両方が成り立つ。
 * 両方に載っていることを求めると、載せていない側（地震情報・長周期）を切りたくないときに
 * それらまで列挙する必要が生じ、上の 3 つの要求を同時に満たせなくなる。
 *
 * **上位には切られる**（優先度差があるときはこの表を見ない）。津波の格上げが観測情報を切るのは
 * 正しい——待たせると、警報の引き上げが観測値の読み上げの後ろに回る。
 */
const MUTUAL_YIELD_TOPICS: ReadonlySet<SpeechTopic> = new Set<SpeechTopic>([
  'tsunami', 'tsunamiObs', 'nankai', 'kohatsu',
])

/**
 * いま読み上げを始められない理由（`speechBlocker`）。
 *
 * 待つ上限が理由によって変わるため、Promise だけでなく理由そのものを持ち回る
 * （`mutualYield` は `MUTUAL_YIELD_SPEECH_MAX_WAIT_MS`、それ以外は
 * `HIGHER_PRIORITY_SPEECH_MAX_WAIT_MS`）。
 */
type SpeechBlocker = 'eewChain' | 'eewPhase2' | 'higher' | 'mutualYield'

/**
 * EEW 第 1 フェーズ（震源の読み上げ）の進み具合。詳細は `eewPhase1ProgressRef` の宣言箇所。
 *
 * 入れる値は識別子（`{}`）で、中身は見ず**同一性だけを見る**。同じ eventId に複数の予約が
 * 並ぶため、「この記録を置いたのは自分か」を判別できないと他の予約の記録を消してしまう。
 */
type EEWPhase1Progress = {
  /** いま声になっている予約。null なら何も鳴っていない。 */
  speakingToken: object | null
  /** 予約済みでまだ声になっていない言い直し。null なら重ねてよい。 */
  restateToken: object | null
}

// 南海トラフ関連解説情報の通知音（specialInfoCommentary）は約 1.3 秒。鳴り終わってから読み上げる。
// 音を作り変えたらこの値も見直すこと（docs/spec/audio-tts-spec.md §6）。
const NANKAI_COMMENTARY_TTS_DELAY_MS = 1500

// 先に鳴っている読み上げ（EEW を含む）の完了を待つ上限。津波の本文は 60 秒近くに達することが
// あるため、EEW チェーンの刻み（EEW_SPEECH_CHAIN_MAX_WAIT_MS）を流用すると読み上げを途中で
// 切ってしまう。
//
// この上限が効くのは VOICEVOX が無応答のときだけで、その状況ではそもそも何も聞こえないため、
// 長めに取っても失うものは無い。
const HIGHER_PRIORITY_SPEECH_MAX_WAIT_MS = 90000

// 相互譲り（`MUTUAL_YIELD_TOPICS`）の相手を待つ上限。**上の値より長く取ること。**
// 地震情報の「各地の震度」は読み切りに 2 分近く達するため、90 秒では上限に達した側が割り込み、
// 「内容が重ならない同格どうしは互いに切らない」という宣言がそこで破れる（相互譲りを入れた
// 意味が無くなる）。上位を待つ場合の上限とは別に持つのは、あちらを延ばすと VOICEVOX 無応答の
// 保険が緩むため。
const MUTUAL_YIELD_SPEECH_MAX_WAIT_MS = 180000

// 予想震度が付くのを待っている EEW があるとき、非 EEW 側が状況を見直す間隔。
// この待機中は「これから話す」状態で、待つ相手の Promise がまだ存在しないため、
// 短く眠って作り直す（`EEW_PHASE2_MAX_WAIT_MS` の 3 秒に対して十分細かい刻み）。
const EEW_PHASE2_PENDING_POLL_MS = 500

/**
 * 震源も震度も伴う「確定情報」か。
 *
 * 震度速報（VXSE51）は区域だけの速報で、震源・規模を伴わない。これらの種別が届いて初めて、
 * その地震の観測が確定した形で揃う。**その地震で最初に届いた 1 通だけ**、地域を差分にせず
 * 通しで読む（`earthquakeToSegments` の `readAllRegions`）。
 */
function isAuthoritativeQuakeReport(q: JMAQuake): boolean {
  return q.issue.type === '震源・震度情報' || q.issue.type === '各地の震度情報'
}

// 「この報は既に見た」の記憶を保つ件数の上限（超えたらまとめて捨てる）。1 地震で覚えるのは
// 種別の数（震度速報・震源情報・各地の震度・遠地地震・震源要素更新）だけなので、この深さは
// 数十件の地震ぶんに相当する。長期セッションで無制限に増えるのを防ぐためだけの歯止め。
// 捨てた直後の続報は「初めて見た」扱いになり、読み上げの冒頭が「更新されました」ではなく初報の
// 言い方に戻る。**言い方だけの問題ではない。** 続報の差分は初報扱いの報には効かないため、その報は
// 全文で読まれる（`earthquakeToSegments`）。声の長さが変わるだけで情報は落ちないが、
// 「それだけで音には影響しない」ではない。到達しやすいのはリプレイの復元
// （`restorePreWindowTracking`）で、群発が続いた期間を遡ると 1 回の復元で多数を積む。
const SEEN_QUAKE_REPORT_KEYS_MAX = 200

// 主題ごとの「最後に予約された連番」を保つ件数の上限（超えたらまとめて捨てる）。主題は地震ごとに
// 増える（`quake:<キー>` / `lpgm:<キー>`）一方、読み上げが正常に終わった主題を消す自然な契機が
// 無いため、歯止めが無いと長期セッションで増え続ける。
// 同時に予約が進行するのは多くて数件なので、上限に達して捨てても取り下げの判定に実害は出ない
// （その回だけ従来どおり割り込みで裁かれる）。
const LATEST_SPEECH_TOPIC_MAX = 200

/** 指定時間だけ待つ（優先度の待ち合わせで、待つ相手の Promise がまだ無いときに使う）。 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

// 待ちきれずに割り込むことを選んだときの警告。VOICEVOX が無応答だと読み上げごとに起こりうるため
// 間引くが、優先度の高い読み上げを消す判断なので必ず残す（黙って消すと事後に追えない）。
const warnSpeechWaitGiveUp = createLogThrottle(30000)

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

// 「この報は見た」と記録する。ライブ受信とリプレイの復元で同じ歯止め（上限）を通すために
// 関数にしている（上限の意味は `SEEN_QUAKE_REPORT_KEYS_MAX` の注釈）。
function markQuakeReportSeen(seen: Set<string>, key: string): void {
  if (seen.size >= SEEN_QUAKE_REPORT_KEYS_MAX) {
    // 捨てた事実を残す。黙って消すと「続報なのに新規として読まれた」ときに、上限に当たったのか
    // キーの作り方がずれたのかを切り分けられない（`cancelPendingSpeech` と同じ流儀）。
    log.debug(`[quake] 既読の報の記憶が上限に達したため捨てた (${seen.size} 件)`)
    seen.clear()
  }
  seen.add(key)
}

/**
 * 「声になった内容」を覚えておく地震の数の上限。
 *
 * 上限の意味は `SEEN_QUAKE_REPORT_KEYS_MAX` と同じ（無制限に増やさないための歯止め）。
 * 溢れたら丸ごと捨てる ―― 捨てた地震の続報は全文で読まれるだけで、情報は落ちない。
 */
const SPOKEN_QUAKE_STATES_MAX = 100

/** 地震ごとの「声になった内容」を引く。無ければ作る（上限に達していたら丸ごと捨ててから）。 */
function quakeSpokenStateFor(states: Map<string, QuakeSpokenState>, eventKey: string): QuakeSpokenState {
  const found = states.get(eventKey)
  if (found) return found
  if (states.size >= SPOKEN_QUAKE_STATES_MAX) {
    log.debug(`[quake] 読み上げ済みの記憶が上限に達したため捨てた (${states.size} 件)`)
    states.clear()
  }
  const created = createQuakeSpokenState()
  states.set(eventKey, created)
  return created
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

/**
 * 観測点の到達と最大波高を記録する。
 *
 * **記憶が 2 つあるので、どちらに書くかは呼び出し側が決める。** 画面（バッジ・スクロール）用は
 * 受信時に、読み上げ用は発話を始める瞬間に進める（理由は `spokenObsHeightRef` の宣言箇所）。
 * 同じ手順を 2 度書くと、片方だけ「同値でも over への昇格は記録する」といった条件を取り落とす。
 */
function rememberObservations(
  obs: readonly import('../types/earthquake').TsunamiObservation[],
  names: Set<string>,
  heights: Map<string, { value: number; over?: boolean }>,
): void {
  for (const o of obs) {
    names.add(o.name)
    if (!o.height) continue
    const prev = heights.get(o.name)
    if (prev === undefined || o.height.value > prev.value || (o.height.over && !prev.over)) {
      heights.set(o.name, { value: o.height.value, over: o.height.over })
    }
  }
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
  /**
   * EEW が全て解除されたあと、揺れ検知が続いているために realtime を維持する経路。
   * 揺れ検知の優先度で要求する（App 側で付与）。生の `setActiveTab` は渡さないこと
   * （保持が張られず、直後の地震情報に画面を奪われる）。
   */
  setActiveTabRealtimeForKyoshin: () => void
  setActiveTabNonRealtime: (tab: Exclude<TabId, 'realtime'>) => void
  setActiveTabRealtimeOnUpdate: () => void
  /** EEW の新規発報・レベルアップ・誤報取消による realtime 移動（手動選択より強い） */
  setActiveTabRealtimeUrgent: () => void
  /**
   * 読み上げの発話を投入する直前に呼んで、画面を声に合わせる。
   *
   * 受信時の要求（`setActiveTab*`）との違いは、**読み上げの順番待ちを経ている**こと。
   * 重い電文の読み上げ中に届いた軽い電文は、その読み上げが終わって自分の番が来たときに
   * 初めて画面を取る（従来は受信の瞬間に要求して保持に弾かれ、そのまま捨てられていた）。
   *
   * **受信時の先出しで既に画面を取れていたら `alreadyShown` を立てて渡す。** 渡した場合、
   * 揺れ検知に奪われていても取り返さない（往復を防ぐ。判断は `shouldRetakeAfterPreSpeech` で、
   * 読み上げを持つ相手に奪われた場合は取り返す）。
   */
  followSpeechTab: (tab: TabId, priority: TabPriority, opts?: { alreadyShown?: boolean }) => void
  /**
   * 通知音と同時に出す**先出し**の追従（待たされずに読めると判断したときだけ）。
   *
   * `followSpeechTab` と分けているのは、**先出しに最小滞留時間の床を掛けないため**。
   * 予定の段階で床を消費すると、後から実際に声が出る側の追従を弾く（理由は App 側の宣言箇所）。
   *
   * **戻り値は呼び出した瞬間に画面を取れたか。** そのあと奪われたかは含まない。
   * 呼び出し側はこれを `followSpeechTab` の `alreadyShown` へ渡すだけで、**追従の呼び出し
   * 自体は省かない** —— 取り返すかどうかは保持の中身を見て App 側が決める。
   */
  preSpeechTab: (tab: TabId, priority: TabPriority) => boolean
  /**
   * 読み上げの進行を画面へ伝える（津波カードの追従スクロール）。
   *
   * 渡すのは**津波の読み上げだけ**。地震情報の本文は数千文字（数百チャンク）になり、
   * 追従の対象を持たない通知が大量に流れる。渡さなければ追従しないだけで、読み上げ自体は
   * 変わらない。
   */
  speechFollow?: SpeechFollowApi
  /**
   * 特別情報（南海トラフ臨時情報・後発地震注意情報・関連解説情報）の受信でパネルを開く。
   *
   * これらは地図に重ねた帯で伝える情報で、パネル側に居場所がない（切り替えるタブが無い）。
   * パネルを畳んで地図だけを見ている状態でも気づけるように開く。元の状態へ戻す判断は App 側。
   */
  expandPanelForSpecialInfo: () => void
  revertToDefaultTab: () => void
  selectQuake: (id: string | null) => void
  setActiveLpgmEventId: (id: string | null) => void
}

export function useLiveEventHandler(deps: LiveEventHandlerDeps) {
  const {
    settings, title, earthquakesRef, tsunamisRef, kyoshinDetectedRef, defaultTabRef,
    setActiveTabRealtimeForKyoshin, setActiveTabNonRealtime, setActiveTabRealtimeOnUpdate,
    setActiveTabRealtimeUrgent, followSpeechTab, preSpeechTab, speechFollow, expandPanelForSpecialInfo,
    revertToDefaultTab, selectQuake, setActiveLpgmEventId,
  } = deps

  // 「新規地震」として注目を移した報のキー（`eventKey:issue.type`）。
  // 同一イベント・同一種別の続報では新規扱いにせず、読み上げの冒頭を「更新されました」にする。
  //
  // **直近 1 件ではなく見た報を全部覚えること。** キーには種別が入るため、直近 1 件だと
  // 種別の異なる報が交互に届いたときに互いの記憶を上書きし、2 度目の震度速報が「初めて見た」
  // 扱いに戻る（震度速報 → 震源情報 → 震度速報 で「震度速報。」を 2 回読んでいた）。
  const seenQuakeReportKeysRef = useRef<Set<string>>(new Set())
  // 地震ごとの「声になった内容」（`eventKey` → 記録）。続報で差分だけを読むために持つ。
  // **情報種別を跨いで共有する**（震度速報で読んだ区域を震源・震度情報で読み直さない）ので、
  // キーには種別を含めない（`seenQuakeReportKeysRef` のキーとは別物）。
  const spokenQuakeStatesRef = useRef<Map<string, QuakeSpokenState>>(new Map())
  /**
   * 確定情報を通しで読んだ地震（`eventKey`）。2 通目以降は差分に戻すために持つ。
   *
   * **記録するのは読み上げ文を組んだ時点**で、`spokenQuakeStatesRef`（声になった分だけ）とは
   * 基準が違う。通しで読んだ分が割り込みで鳴らなかった場合、その区域は既読にならないので
   * 次の報が差分として読み直す ―― 情報は落ちないため、ここは受信時の記録で足りる。
   * 上限と捨て方は `spokenQuakeStatesRef` に合わせる（同じ地震の記憶なので歩調を揃える）。
   */
  const authoritativeReadQuakesRef = useRef<Set<string>>(new Set())
  // EEW の eventId ごとにレベルを追跡（複数EEW対応）
  // key = issue.eventId ?? id、value = 0=低震度予報 / 1=警報（severity=Warning または予想震度5弱以上） / 2=特別警報
  const activeEEWLevelsRef = useRef<Map<string, 0 | 1 | 2>>(new Map())
  // ここから 3 つは「読み上げに送り出した値」を eventId 別に保持する。受信値ではなく発話した値を
  // 持つのが要点。受信のたびに更新すると、割り込みや取消で声に出なかった値まで既読になり、
  // 「一度も言っていない値からの引き上げ」を語ることになる。更新は発話の直前だけで行う。
  //
  // 厳密には「鳴った値」ではない。発話の途中でも上位の続報が届けばそこから先は鳴らさないため
  // （`shouldStillPlay`）、送り出したのに声にならなかった値が残りうる。それでも取りこぼしに
  // ならないのは、読み上げ文が毎回**最新値から作り直される**（差分を語らない）ため。取り下げた
  // 原因である「より高い値」は必ず別途予約され、そちらが読まれる。

  // 階級だけでなく「以上」も持つ。同じ階級のまま上限が定まらなくなる変化（「4」→「4以上」）は
  // 階級値では捉えられず、値だけを覚えていると一度も声に出さないまま終わる（比較は
  // `isForecastScaleHigher`）。
  const spokenEEWScalesRef = useRef<Map<string, EewMaxScaleInfo>>(new Map())
  // 階級だけが上がる続報（震度据え置きで 2→3 等）は震度にもレベルにも現れないため専用に持つ。
  const spokenEEWLpgmClassesRef = useRef<Map<string, number>>(new Map())
  /**
   * EEW 第 2 フェーズの安定待ち。震度・長周期階級を**独立に**追う（eventId 別）。
   *
   * 続報のたびに「暫定候補値」と直前の値を比較し、変わらなければ安定待ち時間の経過で確定、
   * 変わったら待ち直す（`eewPhase2ScaleStabilityMs`・`EEW_PHASE2_LPGM_STABILITY_MS`）。
   * 上限（`EEW_PHASE2_STABILITY_MAX_WAIT_MS`）に達したら、安定を待たずその時点の値で
   * 強制確定する。値が急に跳ね上がってすぐ訂正されるケース（2024/08/08 日向灘の瞬間的な
   * 震度7）で、一瞬しか存在しない値を読み上げてしまうのを防ぐための仕組み。
   *
   * 震度と階級を分けるのは、階級側の細かい変動（観測点が少なくノイジーになりやすい）に
   * 震度の確定を巻き込ませないため。日向灘の実データで、震度自体は安定していたのに階級の
   * 変動につられて確定が上限まで遅れる現象を確認している。
   */
  interface EEWScaleStabilityCycle {
    scaleInfo: EewMaxScaleInfo
    /** 跳躍幅計算の基準（サイクル開始時点で確定していた震度。無ければ暫定候補自身＝跳躍0扱い） */
    baseScale: number
    since: number
    timer: ReturnType<typeof setTimeout>
  }
  interface EEWLpgmStabilityCycle {
    lpgmClass: number
    since: number
    timer: ReturnType<typeof setTimeout>
  }
  const eewScaleStabilityRef = useRef<Map<string, EEWScaleStabilityCycle>>(new Map())
  const eewLpgmStabilityRef = useRef<Map<string, EEWLpgmStabilityCycle>>(new Map())
  /**
   * 安定待ちを経て確定した震度・長周期階級（eventId 別）。震度・階級を独立に確定させるため、
   * 片方だけ確定している状態がありうる。
   *
   * 読み上げの同期はここで非対称に扱う——**震度が先に確定したら階級を待たず即読む**
   * （階級は後で確定次第、追加で読む）。**階級が先に確定したら震度が確定するまで読み上げを
   * 保留し、確定した時点で一緒に読む**。震度は緊急性が高く最優先で伝えるべきだが、階級は
   * それ単体で急いで伝える理由が薄いため。
   */
  const eewConfirmedScaleRef = useRef<Map<string, EewMaxScaleInfo>>(new Map())
  const eewConfirmedLpgmRef = useRef<Map<string, number>>(new Map())
  // 読み上げた区分（0=予報 / 1 以上=警報）。予想震度・階級が据え置きのまま severity だけ
  // 確定する続報があり、値だけを見ていると区分の変化が声に出ない。
  const spokenEEWLevelsRef = useRef<Map<string, 0 | 1 | 2>>(new Map())
  // 直前に読み上げた津波グレード（引き下げ検出・重複読み上げ抑制に使用）
  const lastTsunamiGradeRef = useRef<'MajorWarning' | 'Warning' | 'Watch' | 'Forecast' | null>(null)
  // 直前に受信した津波（解除がこの津波に向けたものかの照合に使う。`isCancelForCurrentTsunami`）。
  //
  // **App が持つ表示中の津波（`tsunamisRef`）ではなく、自分が受信したものを見ること。**
  // あちらは App の render 本体で代入されるため、同一 tick に複数の電文が捌けると（アーカイブ
  // 再生の追いつき・長時間バックグラウンド後の復帰）tick 開始前の値に取り残される。その値と
  // 照合すると、届いたばかりの津波に対する解除を「別イベントの解除」と誤判定し、記憶を落とさない。
  //
  // ここで管理している記憶（波高・観測点名）は、いずれも自分が受信した電文で進めている。
  // 照合の基準も揃えるのが筋が通る（`useEarthquakes` 側は state の整合のために `prev.tsunamis[0]`
  // を見る。基準が違っても、判定そのものは同じ関数を共有している）。
  const lastTsunamiRef = useRef<JMATsunami | null>(null)
  // 観測点ごとに受信済みの最大波高。**画面（バッジ・スクロール）用**で、読み上げの有無に関わらず
  // 受信時に進める。
  const lastMaxObsHeightRef = useRef<Map<string, { value: number; over?: boolean }>>(new Map())
  // これまでに一度でも受信した観測点名（波高未確定＝観測中のまま新規到達した観測点の検出用）。上と同じく画面用。
  const seenObsNamesRef = useRef<Set<string>>(new Set())
  // 同じものを**読み上げ用**に別で持つ。こちらは受信時ではなく**発話を始める瞬間**に進める
  // （EEW の `spokenEEWScalesRef` と同じ流儀）。
  //
  // **画面用と共有してはいけない。** 画面用は受信時に進むため、読み上げが待たされている間に
  // 消えた（後発に置き換えられた・上位に切られた）観測値まで既読になり、その観測点は二度と
  // 読まれない。相互譲り（`MUTUAL_YIELD_TOPICS`）で待つようになったぶん、この取りこぼしは
  // 起きやすくなっている。分けておけば、鳴らなかった観測値は次の電文でもう一度読み上げ対象に
  // 入る（読み上げ文は「読み上げた値からの差分」で作るため）。
  const spokenObsHeightRef = useRef<Map<string, { value: number; over?: boolean }>>(new Map())
  const spokenObsNamesRef = useRef<Set<string>>(new Set())
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
  // 読み上げ中の非 EEW の優先度・主題とその完了。優先度の低い読み上げがこれを見て待つ。
  // **主題も持つこと。** 同格どうしが互いを切ってよいかは主題で決まる（`MUTUAL_YIELD_TOPICS`）。
  const activeNonEewSpeechRef = useRef<{ priority: SpeechPriority; topic: SpeechTopic; done: Promise<void> } | null>(null)
  // 間を置いてからの読み上げの予約（`scheduleSpeech`）。アンマウント・リプレイ切替で取り消す。
  const pendingSpeechRef = useRef<Set<{ id: number; onCancel?: () => void }>>(new Set())
  // 非 EEW の読み上げに振る到来順の連番と、主題ごとの「最後に予約された連番」。
  // **同格どうしの追い越し**を裁くために持つ（優先度だけでは同格を区別できず、`speechBlocker` は
  // 厳密不等号で見るため）。詳細は `overtakenByLaterArrival`。
  //
  // **主題ごとに分けて持つこと。** 単一の枠に「最後に予約されたもの」だけを置くと、主題違いの
  // 予約が枠を奪った隙に同じ主題の後先が比べられなくなり、古い報が新しい報を切れてしまう。
  //
  // 連番はリプレイ切替でも戻さない（意図的）。単調に増えていれば後先の比較は成り立ち、0 へ戻すと
  // 切替前の値と混ざる。取り消しは Map 側の clear で足りる。
  const nonEewSpeechSeqRef = useRef(0)
  const latestScheduledSeqByTopicRef = useRef<Map<SpeechTopic, number>>(new Map())
  const eewPhase2TokensRef = useRef<Map<string, object>>(new Map())
  const eewTtsMaxTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  // 第 2 フェーズ（予想値）を一度でも発話した eventId。まだ読んでいない間は、値が上がって
  // いなくても読む（初報・震源更新の読み直しがこれに当たる）。
  const eewPhase2DoneRef = useRef<Set<string>>(new Set())
  // 予約の解決時にテキストを生成するため、eventId ごとに最新イベントを保持する（変化なし続報も含め常に最新で上書き）
  const eewTtsEventsRef = useRef<Map<string, EEWAlert>>(new Map())
  // 誤報取消（訂正）を受けた eventId。**`shouldStillPlay` で鳴っているものを落としてよいのは
  // これだけ**（もう 1 つの打ち切りは予報から警報への言い直しだが、あちらは新しい発話を
  // 割り込ませる形で止める。`eewPhase1ProgressRef` を参照）。
  // 自動解除（expired）と区別するために別に持つ（どちらも eewTtsEventsRef からは消えるため、
  // 消えたことだけでは理由が分からない）。発表が終わった EEW の内容は誤りではないので、
  // 自動解除では鳴っているものを切らない（切ると代わりに読むものが無く、尻切れで終わる）。
  const eewRetractedKeysRef = useRef<Set<string>>(new Set())
  // 第 1 フェーズ（震源の読み上げ）の進み具合。eventId 別。
  // **予報から警報へ上がったときに、言い直すかどうか・何回言い直すかをこれ 1 つで決める。**
  //
  // 持つのは 2 つの識別子（`{}` で作る値。「どの予約か」を指すだけで中身は見ない）。
  //
  //   speakingToken … いま声になっている予約。null なら**何も鳴っていない**
  //   restateToken  … 予約済みでまだ声になっていない**言い直し**。null なら重ねてよい
  //
  // 判定はこの 2 つで足りる。鳴っていれば割り込んで頭から言い直し、鳴っていなければ放って
  // おく（区分は発話の直前に決めるので、そのまま警報として読まれる）。読み終えていれば
  // 第 2 フェーズが「緊急地震速報に切り替わりました。」と前置きする。
  // **どの経路でも「緊急地震速報」の語は必ず声になる。**
  //
  // 言い直しの側を別に持つのは、続報が密集する（2024/1/1 能登の本震では 0.3〜2 秒間隔）ため。
  // 区分の既読（`spokenEEWLevelsRef`）は発話の直前まで更新されないので、印が無いと 2 通目・
  // 3 通目も「まだ警報を伝えていない」と判定し、**完全に同一の文を重ねて積む**。既読の側を
  // 予約時点で更新する形では直せない——取消で声にならなかった区分まで「伝え済み」になり、
  // 以後その EEW では言い直しも前置きも発火しなくなる。
  //
  // **書き換えは `updatePhase1Progress` に集約し、自分の識別子が入っている欄だけを消すこと。**
  // 予約は積み直される（震源の大幅更新は古い音を止めずに積む）ため、同じ eventId に複数の予約が
  // 並ぶ。無条件に消す形にすると、他の予約が置いた記録まで落として二重読みや誤った割り込みを
  // 招く（実際にその穴を 2 度作った）。
  //
  // 「鳴っている」の追跡は完全ではない。発話の完了待ちには上限（`EEW_SPEECH_CHAIN_MAX_WAIT_MS`）
  // があり、VOICEVOX が極端に遅いと**まだ鳴っているのに記録が消える**。そのときは言い直しの
  // 代わりに第 2 フェーズの前置きが伝えるので、区分が声にならない方には倒れない。
  const eewPhase1ProgressRef = useRef<Map<string, EEWPhase1Progress>>(new Map())
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
   * `shouldStillPlay` を添えると、**音を出す直前**（チャンクごと）にもう一度確かめる。
   * テキストを作ってから音が出るまでには合成の往復があり、鳴らしている間も続報は届くため、
   * 生成時点の判定だけでは古い値を鳴らし切ってしまう（詳細は `voicevox.ts` の同名の型）。
   *
   * **チェーンに reject を残さないこと。** `eewSpeechChainRef` は次の発話が待つ対象なので、
   * ここで reject させると以降の EEW の読み上げが連鎖的に落ち、**その端末では二度と
   * 緊急地震速報が読まれなくなる**。テキスト生成の例外まで含めて必ず catch する。
   *
   * `speak` が返す `onSettled` は、発話が終わった（または黙る判断で降りた）ときに必ず呼ばれる。
   * 「いま鳴っているか」を呼び出し側が持つために使う。
   *
   * @param follow 発話を投入する直前に呼ばれる（画面を声に合わせる用途）。
   *   `speak` が null を返して黙るときは呼ばれない。
   * @param cutCurrent 鳴っている音を先に止める（`stopSpeech`）。**順番は崩さない**——自分は
   *   これまでどおり `prev` の完了を待って並ぶ。止めれば `prev` はすぐ完了するので、待ちは
   *   実質そのぶん短くなる。使うのは予報から警報への言い直しだけで、区分が上がったことは
   *   読み上げの途中を守るより重い（第 1 フェーズは実測 5.5 秒あり、鳴り終わるまで待てば
   *   そのぶん警報の告知が遅れる）。**予想震度の引き上げには使わない。** 数秒ごとに書き換わる
   *   ため、そのたびに切っていると読み終わらない。
   *
   *   **「待たずに投入する」形にしてはいけない。** `prev` を飛ばして先に鳴らすと、待ち行列に
   *   いた別 EEW の予約が `prev` の完了で解放され、始まったばかりのこちらを後ろから消す
   *   （止める行為そのものが解放のスイッチになる）。詳細は `stopSpeech` の JSDoc。
   */
  /**
   * 第 1 フェーズの進み具合を部分更新する（{@link EEWPhase1Progress}）。
   *
   * **書き換えはすべてここを通すこと。** 直接 `set` すると、指定しなかった欄を既定値で
   * 上書きしてしまう（同じ eventId に複数の予約が並ぶため、それは他の予約の記録を消すのと
   * 同じになる）。両方の欄が空になったらエントリごと落とす。
   */
  const updatePhase1Progress = (key: string, patch: Partial<EEWPhase1Progress>) => {
    const current = eewPhase1ProgressRef.current.get(key)
      ?? { speakingToken: null, restateToken: null }
    const next = { ...current, ...patch }
    if (next.speakingToken === null && next.restateToken === null) {
      eewPhase1ProgressRef.current.delete(key)
    } else {
      eewPhase1ProgressRef.current.set(key, next)
    }
  }

  const chainEEWSpeech = (
    speak: () => string | { text: string; shouldStillPlay?: ShouldStillPlay; onSettled?: () => void } | null,
    follow?: () => void,
    cutCurrent = false,
  ) => {
    eewSpeechPendingRef.current++
    const prev = eewSpeechChainRef.current
    if (cutCurrent) stopSpeech()
    let settled: (() => void) | undefined
    eewSpeechChainRef.current = capSpeechWait(prev).then(() => {
      const spoken = speak()
      if (spoken === null) return
      const { text, shouldStillPlay, onSettled } = typeof spoken === 'string'
        ? { text: spoken, shouldStillPlay: undefined, onSettled: undefined }
        : spoken
      settled = onSettled
      // 声に出すものが決まった瞬間に画面も合わせる。黙る予約（spoken === null）では動かさない。
      // **追従の失敗で読み上げを落とさない。** ここから例外が抜けると本文が鳴らないまま catch に
      // 落ち、警報が声にならない（`voicevox.ts` の `onChunkScheduled` と同じ方針）。
      try { follow?.() } catch (err) { log.warn('[eew] 読み上げ追従に失敗（読み上げは続行）', err) }
      return capSpeechWait(
        speakWithVoicevox(settings.voicevoxUrl, text, settings.voicevoxSpeakerId, settings.soundVolume, shouldStillPlay),
      )
    })
      .catch(err => log.warn('[eew] 読み上げに失敗', err))
      .finally(() => { eewSpeechPendingRef.current--; settled?.() })
  }

  /**
   * いま読み上げを始められない理由（待たされずに始められるなら null）。
   *
   * EEW は優先度の尺度の外にあり、**予約済みのぶんも含めて**常に最優先とする。予約を数えるのは、
   * EEW の続報が立て続けに届くとき、発話の切れ目に非 EEW が滑り込んで次の EEW に切られるのを
   * 防ぐため。
   *
   * **この関数を 3 箇所で共有すること**——待ち合わせ（`higherPrioritySpeechInProgress`）、
   * 先出しの判定、追い越しの判定（後の 2 つは `speakNonEEWDelayed`）。条件を書き分けると、
   * 片方だけ直したときに「待たされないと踏んで画面を先に動かしたのに、実際には待たされる」
   * 形の食い違いになる。
   *
   * @param topic 自分の主題。同格どうしで待つかを決めるのに使う（`MUTUAL_YIELD_TOPICS`）。
   */
  const speechBlocker = (
    priority: SpeechPriority,
    topic: SpeechTopic,
  ): SpeechBlocker | null => {
    if (eewSpeechPendingRef.current > 0) return 'eewChain'
    // 予想震度が付くのを待っている EEW がある間も、EEW は「これから話す」状態にある。
    // ここを空きと見なすと、震源を読み終えた直後の数秒に地震情報が滑り込み、待ち明け
    // （`EEW_PHASE2_MAX_WAIT_MS`）の第 2 フェーズに**必ず**切られる
    // （2024/1/1 能登 16:08 の震源情報が残り 5.7 秒で消えていた）。
    // **安定待ち中（`eewScaleStabilityRef`/`eewLpgmStabilityRef`）も同じ「これから話す」状態**
    // に含める。値が届いてから安定待ち・確定するまでの間（最大 `EEW_PHASE2_STABILITY_MAX_WAIT_MS`）
    // も EEW の phase2 が控えている点は変わらない。ここを見落とすと、値の確定を待つ数秒の間に
    // 地震情報（長いものは2分近い）が新規に始まり、確定時に必ず切られる形で同じ症状が再発する。
    if (eewTtsMaxTimersRef.current.size > 0
      || eewScaleStabilityRef.current.size > 0
      || eewLpgmStabilityRef.current.size > 0) return 'eewPhase2'
    const active = activeNonEewSpeechRef.current
    if (active === null) return null
    if (active.priority > priority) return 'higher'
    // 同格でも、内容が重ならない相手は切らずに待つ。**同主題は対象外**（言い換えなので、
    // 古い内容を読み切るより最新に置き換えるのが正しい）。片方が載っていれば両方向で待つ
    // （理由は `MUTUAL_YIELD_TOPICS`）。
    if (active.priority === priority && active.topic !== topic
      && (MUTUAL_YIELD_TOPICS.has(topic) || MUTUAL_YIELD_TOPICS.has(active.topic))) return 'mutualYield'
    return null
  }

  /**
   * 自分より**後に到来した**同格以上の読み上げに追い越されているか。
   *
   * `speechBlocker` では捉えられない逆転がこれ。あちらは「いま塞がっているか」を厳密不等号で
   * 見るため、**同格どうしの追い越しが素通りする**。通知音との間は種別ごとに 0.5〜2.8 秒と
   * 幅があるので、先に届いた電文の方が遅く喋り始めることがあり、そのとき古い側が新しい側の
   * 声を切っていた（震源情報の 1.2 秒以内に震度速報が届くと、震度速報が途中で切られる）。
   * 「同格どうしは新しい方が勝つ」という原則が逆向きに破れる形なので、到来順で裁く。
   *
   * **優先度だけでなく到来順も見ること。** 優先度だけで判断すると、自分より後に届いた
   * **軽い**読み上げでも取り下げてしまう。
   */
  const overtakenByLaterArrival = (seq: number, topic: SpeechTopic): boolean => {
    const latest = latestScheduledSeqByTopicRef.current.get(topic)
    return latest !== undefined && latest > seq
  }

  /**
   * 取り下げが決まった予約を「最後に予約されたもの」から降ろす。
   *
   * **降ろさないと取り下げが連鎖する。** 自分が一度も喋らずに消えたのに枠に残り続けると、自分より
   * 前に予約されていた読み上げが「後発に追い越された」と誤認して取り下がり、**どちらも読まれない**。
   *
   * 逆に、**読み終わった予約は降ろさない**（意図的）。後発を聞いたあとで先発を読めば、聞いている
   * 側には順序が入れ替わって聞こえる。到来順を守る規則はそれを避けるためのもの。
   */
  const releaseLatestSchedule = (seq: number, topic: SpeechTopic): void => {
    if (latestScheduledSeqByTopicRef.current.get(topic) === seq) {
      latestScheduledSeqByTopicRef.current.delete(topic)
    }
  }

  /**
   * ブロッカーから「待つ対象」の Promise を引く（待つものが無ければ null）。
   *
   * 待たせる相手は 2 種類ある——**自分より優先度が高いもの**と、**同格でも内容が重ならないもの**
   * （`MUTUAL_YIELD_TOPICS`）。上限が違うので、理由の判定（`speechBlocker`）とは分けている。
   */
  const speechBlockerPromise = (blocker: SpeechBlocker): Promise<void> | null => {
    switch (blocker) {
      case 'eewChain': return eewSpeechChainRef.current
      // 待つ相手の Promise はまだ無いので、短く眠って見直す。
      case 'eewPhase2': return sleep(EEW_PHASE2_PENDING_POLL_MS)
      case 'higher': case 'mutualYield': return activeNonEewSpeechRef.current?.done ?? null
    }
  }

  /**
   * 自分を待たせている読み上げが終わるのを待つ（上限付き。相手は `speechBlockerPromise`）。
   *
   * **毎周回で条件を作り直すこと。** 一度きりの判定にすると、待っている間に始まった読み上げを
   * 見落とす。とくに EEW は、待ち明けに読み始めた非 EEW が後ろから EEW を切るという、
   * 「EEW は常に最優先」の前提を崩す形の事故になる。
   *
   * **上限は待つ理由ごとに変わる**（相互譲りは長め。理由は `MUTUAL_YIELD_SPEECH_MAX_WAIT_MS`）。
   * 待っている間に相手が入れ替われば上限も切り替わるため、毎周回で引き直す。
   *
   * 打ち切りは**経過時間**で判定する。反復ごとに一定量を足す数え方にすると、待つ対象が即座に
   * resolve する状態（進行カウンタだけが残った場合など）でマイクロタスクを高速に回り切って
   * 「上限まで待った」ことになり、上限が実時間として意味を失う。あわせて反復回数にも歯止めを
   * 置き、時間が進まない環境（テストの fake timers）でも回り続けないようにしている。
   *
   * @returns `true` なら順番が来た。`false` なら待ちきれず、割り込むことを選んだ。
   *   **呼び出し側はこの 2 つを区別すること。** 区別せずに待ち直すと、諦める判定が無効になって
   *   上限が効かなくなる。
   */
  const waitForSpeechSlot = async (priority: SpeechPriority, topic: SpeechTopic): Promise<boolean> => {
    let waitingSince = Date.now()
    let waitingFor: SpeechBlocker | null = null
    for (let i = 0; i < 200; i++) {
      const blocker = speechBlocker(priority, topic)
      if (blocker === null) return true
      const busy = speechBlockerPromise(blocker)
      if (busy === null) return true
      // **待つ理由が変わったら計時をやり直す。** 上限は理由ごとに違うため、別の理由で消費した
      // 時間を持ち越すと、上限の短い相手を「もう十分待った」と誤認してその場で割り込む。
      // 相互譲りを 100 秒待った直後に EEW が始まると、EEW 側の上限（90 秒）を既に超えている
      // ことになり、**始まったばかりの EEW を切って読み始める**（「EEW は常に最優先」が破れる）。
      // 理由が入れ替わり続ける場合は反復上限（200 回）が歯止めになる。
      if (blocker !== waitingFor) {
        waitingFor = blocker
        waitingSince = Date.now()
      }
      // 上限は待つ理由で決まる。相互譲りの相手（同格・内容が重ならない）は長く待つ。
      const limit = blocker === 'mutualYield'
        ? MUTUAL_YIELD_SPEECH_MAX_WAIT_MS
        : HIGHER_PRIORITY_SPEECH_MAX_WAIT_MS
      const remaining = waitingSince + limit - Date.now()
      if (remaining <= 0) {
        // 待ちきれずに割り込むことを選んだ。優先度の高い読み上げを消すため必ず記録する
        // （VOICEVOX が無応答のときに繰り返し起こりうるので間引く）
        // **主題も残すこと。** 相互譲りで同時に待つ相手が増えたため、priority だけでは
        // どの読み上げが諦めたのかを切り分けられない（記録は 30 秒に間引かれる）。
        warnSpeechWaitGiveUp(() => log.warn(
          `[tts] 先に鳴っている読み上げを待ちきれず、割り込んで読み上げる priority=${priority} topic=${topic}`,
        ))
        return false
      }
      // 待つ対象が reject しても待ちを続ける（相手の失敗で自分を道連れにしない）。
      // 相手側の speakNonEEW / chainEEWSpeech が独立に記録するため、ここは debug に留める
      await capSpeechWait(busy, remaining).catch(err => log.debug('[tts] 待っていた読み上げが異常終了', err))
    }
    warnSpeechWaitGiveUp(() => log.warn(
      `[tts] 待ち合わせの反復上限に達したため割り込んで読み上げる priority=${priority} topic=${topic}`,
    ))
    return false
  }

  /**
   * 非 EEW の読み上げ。自分より優先度の高い読み上げが終わるのを待ってから話す。
   *
   * `speakWithVoicevox` は待ち行列ではなく割り込み（既存の再生を stop し進行中の合成を abort
   * する）なので、待たずに投げると緊急度の低い情報が重い情報を途中で消す。実例: 2024/1/1 能登の
   * 16:08 の EEW 第 1 報が、その 0.36 秒後に読み上げの始まった震源情報に潰されていた
   * （震源情報の電文自体は EEW より先に届いており、TTS_DELAY_MS を経て読み上げが始まる。
   * **割り込みは電文の到来順では決まらない**）。同じ再生では、大津波警報の読み上げが 30 秒後に
   * 始まった地震情報に消されていた。
   *
   * 逆向き（優先度の高い側が低い側を切る）は許す。緊急度どおりであり、また地震情報の本文は
   * 数千文字に達することがあって、その後ろに EEW や津波を並べると致命的に遅れるため。
   * **ただし同格で内容が重ならない相手は、逆向きでも切らない**（`MUTUAL_YIELD_TOPICS`）。
   * ここで「切らない」のは待ちの上限（`MUTUAL_YIELD_SPEECH_MAX_WAIT_MS`）までの話で、
   * 上限に達したら割り込む（相互譲りの相手も含む）。上限まで待って諦めるとき割り込まないのは
   * `SPEECH_PRIORITY.commentary` だけ。
   */
  const speakNonEEW = (
    text: string,
    priority: SpeechPriority,
    /** 読み上げの主題。同格どうしで待つかの判定に使う（`MUTUAL_YIELD_TOPICS`）。 */
    topic: SpeechTopic,
    /**
     * 待ちが明けて**これから声に出す**瞬間に呼ばれる（画面を合わせる・読み上げた値を既読へ移す）。
     * 待ちきれず見送った場合（`onSilentGiveUp`）は呼ばれない。
     */
    onSpeakStart?: () => void,
    /** 間を置いている最中に合成しておいた音声（`speakNonEEWDelayed` 経由のときだけ渡る）。 */
    prewarmed?: PrewarmedSpeech | null,
    /**
     * 読み上げ文の断片列。津波では画面の追従に使い、地震情報では「声になった内容」の記録に使う。
     * どちらに使うかは断片が持つ参照の種類で決まる（`hasFollowTarget`）。
     */
    segments?: SpeechSegment[],
    /**
     * 声になった断片の参照を渡す先（地震情報の続報の差分。読み上げの完了時に 1 回だけ呼ぶ）。
     *
     * `onSpeakStart` との違いは**渡す時点**。あちらは「これから声に出す」瞬間で、こちらは
     * 読み終えたあと（割り込みで切られた分を除いて数えるため。`spokenChunkIndices`）。
     */
    onSpokenRefs?: (refs: readonly SpeechRef[]) => void,
    /**
     * 待ちきれず「黙る」ことを選んだときの後始末（`speakNonEEWDelayed` 経由のときだけ渡る）。
     *
     * **予約の枠から降りるために要る。** ここは `seq` を持たないので `releaseLatestSchedule` を
     * 自分では呼べない。降りずに終わると、自分より前に予約されていた同じ主題の読み上げが
     * 「後発に追い越された」と誤認して取り下がり、**どちらも読まれない**
     * （`releaseLatestSchedule` の注記）。
     */
    onSilentGiveUp?: () => void,
  ) => {
    void (async () => {
      /**
       * 割り込まずに見送る。「何も切らない」ことを層で宣言している優先度だけがここへ来る
       * （宣言は `SPEECH_PRIORITY.commentary`）。待ちの上限で割り込むとその保証が破れる——
       * 各地の震度は読み切りに 2 分近く達し、上限（90 秒）を実際に超える。
       */
      const giveUpSilently = () => {
        log.info(`[tts] 待ちきれなかったため読み上げを見送る（何も切らない層） topic=${topic}`)
        prewarmed?.abort()
        onSilentGiveUp?.()
      }
      // `await` はマイクロタスクの境界を作るため、待ちが明けてからこの続きが走るまでの間に
      // 別の待機者の続きが走りうる。両者が「誰も読んでいない」を見て同時に解放されると、
      // 低い側が後から読み始めて高い側を切ることがある。読み始める直前に同期的に見直し、
      // 変わっていたら待ち直す（回数に歯止めを置き、取り合いで永久に読めなくなるのを防ぐ）。
      for (let attempt = 0; attempt < 10; attempt++) {
        // 待ちきれずに割り込むことを選んだ場合は待ち直さない（諦める判定が無効になる）
        if (!await waitForSpeechSlot(priority, topic)) {
          if (priority === SPEECH_PRIORITY.commentary) { giveUpSilently(); return }
          break
        }
        if (speechBlocker(priority, topic) === null) break
      }
      // **反復上限で抜けた場合もここへ来る。** 上の `return` は「上限まで待って諦めた」ときしか
      // 通らないので、取り合いが 10 回続いて抜けた経路では黙る層の保証が素通りする。
      // 相互譲りで同時に待つ相手が増えたぶん、この取り合いは起こりやすくなっている。
      if (priority === SPEECH_PRIORITY.commentary && speechBlocker(priority, topic) !== null) {
        giveUpSilently()
        return
      }
      // 自分の番が来た（これから声に出す）瞬間に画面を合わせ、読み上げた値を既読へ移す。
      // 待ち行列の後なので、重い電文の読み上げ中に届いた軽い電文は、その後になって初めてタブを取る。
      onSpeakStart?.()
      // 追従は「これから声に出す」ここで開始する。予約の段階で始めると、間を置いている
      // 最中に追い越されて鳴らなかった読み上げに画面が付いていく。
      //
      // **どこも指していない文面では始めない。** 区域名も観測点名も含まない文（等級を判定
      // できなかったときの全解除の文言など）で始めると、追従は空振りしたまま終わり、
      // 「一度も引き当てられなかった」の記録だけが毎回残って診断の役に立たなくなる。
      // **追従を始めるかは参照の種類で決める。** `refs` が空でないことで判定すると、
      // 地震情報の読み上げ（区域と震源要素の参照を持つ）が津波カードの追従を起こす。
      const followToken = hasFollowTarget(segments) ? speechFollow?.begin(segments!) : undefined
      // 予約の通知を溜めておき、読み上げが終わってから「実際に鳴った範囲」を割り出す
      // （`spokenChunkIndices`）。合成は再生より先へ進むため、予約が通っただけでは鳴った
      // ことにならない。
      const scheduledChunks: { index: number; startAt: number }[] = []
      let chunkRefs: SpeechRef[][] | null = null
      let chunkCount = 0
      const notifyChunk = (index: number, startAt: number, chunks: readonly string[]) => {
        if (followToken !== undefined) speechFollow?.schedule(followToken, index, startAt, chunks)
        if (onSpokenRefs && segments) {
          chunkRefs ??= mapChunksToRefs(segments, chunks)
          chunkCount = chunks.length
          scheduledChunks.push({ index, startAt })
        }
      }
      // 第 5 引数（鳴らす直前の見直し）は非 EEW では使わない。予想震度のように数秒で
      // 書き換わる値を持たないため、読み始めた文面を最後まで読んでよい。
      const done = speakWithVoicevox(
        settings.voicevoxUrl, text, settings.voicevoxSpeakerId, settings.soundVolume, undefined, prewarmed,
        followToken === undefined && !onSpokenRefs ? undefined : notifyChunk,
      )
      activeNonEewSpeechRef.current = { priority, topic, done }
      try {
        await done
      } finally {
        if (followToken !== undefined) speechFollow?.end(followToken)
        if (onSpokenRefs && chunkRefs) {
          const spoken = spokenChunkIndices(scheduledChunks, chunkCount, getSpeechClock())
          const refs = spoken.flatMap(i => chunkRefs?.[i] ?? [])
          // 1 チャンクも鳴らなかった（合成の全滅・鳴り出す前の割り込み）ときは記録しない。
          // 記録してしまうと、声になっていない内容が続報で省かれる。
          if (refs.length > 0) {
            onSpokenRefs(refs)
          } else if (spoken.length > 0) {
            // 音は鳴ったのに参照が 1 つも引けなかった。**症状は「うるさいまま」**（差分が
            // 効かず常に全文）で、黙って劣化する側の失敗なので、鳴らなかった場合と区別して残す。
            // 原因は断片列とチャンクの食い違い（`mapChunksToRefs` が警告を出しているはず）。
            log.warn(`[tts] 声にはなったが読み上げ済みの参照を引けなかった (${spoken.length} チャンク)`)
          } else {
            log.debug('[tts] 声になったチャンクが無いため読み上げ済みの記録を更新しない')
          }
        }
        // 自分より後に始まった読み上げに置き換わっている場合は触らない（消すと待ち側が
        // 「誰も読んでいない」と誤認し、進行中の読み上げに割り込む）
        if (activeNonEewSpeechRef.current?.done === done) activeNonEewSpeechRef.current = null
      }
    })()
      // ここに届くのは同期的な異常だけ。VOICEVOX 未起動・ネットワーク断のような日常的な失敗は
      // speakWithVoicevox が無音のまま正常終了させるため到達しない（記録は同関数側で行う）
      .catch(err => log.warn('[tts] 読み上げの進行に失敗', err))
  }

  /**
   * 間を置いてからの読み上げを予約する（追跡付き）。
   *
   * **予約は必ずここを通すこと。** 追跡していない `setTimeout` は、アンマウントやリプレイの
   * 開始で取り消せない。取り消せないと、状態をリセットした直後に古い予約が発火し、
   * 「リプレイを始めたのに本物の警報が読まれる」「その逆」といった食い違いを起こす。
   * しかも記録が残らないため、後から原因を追えない。
   *
   * @param onCancel 予約が取り消されたときの後始末（先行合成の打ち切りなど）
   */
  const scheduleSpeech = (delay: number, run: () => void, onCancel?: () => void) => {
    const entry: { id: number; onCancel?: () => void } = { id: 0, onCancel }
    entry.id = window.setTimeout(() => {
      pendingSpeechRef.current.delete(entry)
      run()
    }, delay)
    pendingSpeechRef.current.add(entry)
  }

  /** 予約済みの読み上げをすべて取り消す（アンマウント・リプレイの切り替え）。 */
  const cancelPendingSpeech = useCallback(() => {
    const count = pendingSpeechRef.current.size
    for (const entry of pendingSpeechRef.current) {
      window.clearTimeout(entry.id)
      entry.onCancel?.()
    }
    pendingSpeechRef.current.clear()
    // 取り消した事実を残す。黙って消すと「鳴るはずの読み上げが鳴らなかった」ときに
    // 取り消しが原因なのか合成の失敗なのか切り分けられない。
    if (count > 0) log.debug(`[tts] 予約していた読み上げを取り消した (${count} 件)`)
  }, [])

  /**
   * 通知音との重なりを避ける間（`delay`）を置いてから非 EEW の読み上げを始める。
   * あわせて、読み上げに同調したタブ移動を仕込む。
   *
   * **待たされずに読めそうなら、通知音と同じ瞬間に画面も合わせる。** 遅延は電文の種別ごとに
   * 0.5〜2.8 秒あり、その間ずっと前のタブに留まると「音が鳴ったのに画面が変わらない」ように
   * 見える。読み上げの直前にも同じ追従を呼ぶため、待っている間に別の情報が画面を取っていれば、
   * 自分の番が来た時点で取り戻せる。
   *
   * **ただし揺れ検知に奪われた場合だけは取り戻さない**（先出しで一度見せているため。判断は
   * `shouldRetakeAfterPreSpeech`）。取り戻すと、次のレベルアップでまた奪われて画面が数秒の
   * うちに往復する。先出しの成否を `followSpeechTab` の `alreadyShown` へ渡して判断させる。
   *
   * 先出しの判断が外れること（遅延の最中に EEW や津波が割り込む）はある。**巻き戻さない。**
   * 割り込んだ側が自分で画面を取るため、放っておけば正しい方へ落ち着く。
   */
  const speakNonEEWDelayed = (
    text: string,
    priority: SpeechPriority,
    delay: number,
    /** 読み上げの主題（取り下げは同じ主題どうしに限る。理由は `SpeechTopic`）。 */
    topic: SpeechTopic,
    /** 読み上げに同調して動かすタブ。**タブを持たない情報（南海トラフ系）では省略する。** */
    follow?: { readonly tab: Exclude<TabId, 'realtime'>; readonly priority: TabPriority },
    /**
     * 読み上げ文の断片列。津波ではカードの追従に使い、地震情報では「声になった内容」の記録に使う
     * （`speakNonEEW` と同じ扱い）。
     */
    segments?: SpeechSegment[],
    /** 声になった断片の参照を渡す先（地震情報の続報の差分。渡す時点の違いは `speakNonEEW` の注記）。 */
    onSpokenRefs?: (refs: readonly SpeechRef[]) => void,
    /**
     * **これから声に出す**瞬間に呼ばれる（津波の観測点を既読へ移すのに使う）。
     * 待たされて見送られた場合は呼ばれないので、「鳴らなかったものを既読にしない」が保てる。
     */
    onSpeakStart?: () => void,
  ) => {
    // 予約した時点で、自分より重い読み上げが走っていたか。**発話の番でもう一度取って比べる**
    // （下の「追い越し」の判定）。
    const blockedAtSchedule = speechBlocker(priority, topic)
    // 到来順の連番を振り、自分をその主題の「最後に予約されたもの」として登録する。同格どうしの
    // 追い越しは優先度では区別できないため、この連番で後先を比べる（`overtakenByLaterArrival`）。
    const seq = ++nonEewSpeechSeqRef.current
    if (latestScheduledSeqByTopicRef.current.size >= LATEST_SPEECH_TOPIC_MAX
      && !latestScheduledSeqByTopicRef.current.has(topic)) {
      // 捨てた事実を残す（`markQuakeReportSeen` と同じ流儀）。黙って消すと「取り下げが働かなかった」
      // ときに上限に当たったのか主題の付け方がずれたのかを切り分けられない。
      log.debug(`[tts] 主題ごとの予約の記憶が上限に達したため捨てた (${latestScheduledSeqByTopicRef.current.size} 件)`)
      latestScheduledSeqByTopicRef.current.clear()
    }
    latestScheduledSeqByTopicRef.current.set(topic, seq)
    // **先出しで画面を取れたか。** これは下の `onSpeakStart` で `alreadyShown` として渡すだけで、
    // 追従を呼ぶかどうかの判断には使わない（理由はそちらのコメント）。
    let tabTakenByPreSpeech = false
    if (follow) {
      if (blockedAtSchedule === null) {
        log.info(`[tab] ${follow.tab} を要求 (通知音と同時・読み上げの待ちなし)`)
        tabTakenByPreSpeech = preSpeechTab(follow.tab, follow.priority)
      } else {
        // 見送った理由を残す。「音は鳴ったのに画面がすぐ動かなかった」を後から追うのに必要
        // （動いたかどうかは `requestAutoTab` の記録で分かるが、なぜ待ったかは分からない）。
        log.debug(`[tab] ${follow.tab} の先出しを見送り (${blockedAtSchedule})`)
      }
    }
    // 間を置いている最中に合成を済ませておく。通知音が鳴り終わってから声が出るまでの空白は、
    // ほぼこの合成時間だった（実測: LAN 越しの VOICEVOX で 150〜350ms）。
    const prewarmed = prewarmVoicevox(settings.voicevoxUrl, text, settings.voicevoxSpeakerId)
    scheduleSpeech(
      delay,
      () => {
        // **後から届いたものに追い越されたら取り下げる。** 予約した時点では空いていたのに、
        // 間を置いているうちに重い読み上げが始まった場合がこれ。待って読むと、到来順とは逆に
        // 「後から来た方が先、先に来た方が後」と喋ることになる。
        //
        // 予約した時点で既に塞がっていたなら取り下げない（`speakNonEEW` の `waitForSpeechSlot`
        // が待つ）。そちらは「重いものが先に来て、後から軽いものが届いた」形で到来順どおりなので、
        // 待って読むのが正しい。
        // 同じ主題の読み上げが自分より後に予約されていたら取り下げる。**予約時に塞がっていたかを
        // 問わない**（相手はまだ喋り始めていないことも多く、`speechBlocker` には映らない）。
        if (overtakenByLaterArrival(seq, topic)) {
          log.info(`[tts] 同じ主題の新しい読み上げに追い越されたため取り下げる topic=${topic}`)
          releaseLatestSchedule(seq, topic)
          prewarmed?.abort()
          return
        }
        if (blockedAtSchedule === null) {
          const overtakenBy = speechBlocker(priority, topic)
          // **相互譲りで塞がっているだけなら取り下げない。** 取り下げる理由は「後から届いた
          // *重い* 読み上げに追い越され、待って読むと到来順が逆に聞こえる」ことなので、
          // 内容が重ならない同格（`MUTUAL_YIELD_TOPICS`）は当てはまらない——どちらも読みたい
          // 相手であり、順序が入れ替わって聞こえる不利より、片方が消える不利の方が重い。
          // ここで取り下げると「主題が違う同格は取り下げない」という原則そのものが破れる。
          if (overtakenBy !== null && overtakenBy !== 'mutualYield') {
            log.info(`[tts] 後から届いた読み上げに追い越されたため取り下げる (${overtakenBy}) priority=${priority}`)
            releaseLatestSchedule(seq, topic)
            prewarmed?.abort()
            return
          }
        }
        speakNonEEW(
          text,
          priority,
          topic,
          // 声に出す瞬間にまとめて行う（画面を合わせる・読み上げた値を既読へ移す）
          () => {
            onSpeakStart?.()
            // **先出しで既に画面を取れていたかを渡す。** 取れていた場合に取り返すかどうかは
            // 保持の中身を見て決める（`shouldRetakeAfterPreSpeech`）——揺れ検知に奪われたなら
            // 取り返さず、読み上げを持つ相手に奪われたなら取り返す。
            // **ここで呼び分けない**のは、`tabTakenByPreSpeech` が「取れた実績」でしかなく、
            // その後に奪われたかを知らないため。呼ばずに省くと、近接して届いた 2 つの電文が
            // 互いの先出しを上書きし合ったとき、後で声に出る側の画面が二度と戻らない。
            if (follow) followSpeechTab(follow.tab, follow.priority, { alreadyShown: tabTakenByPreSpeech })
          },
          prewarmed,
          segments,
          onSpokenRefs,
          // 黙って見送るときも枠から降りる（降りないと前の予約を巻き込む。理由は引数の注記）
          () => releaseLatestSchedule(seq, topic),
        )
      },
      () => {
        releaseLatestSchedule(seq, topic)
        prewarmed?.abort()
      },
    )
  }

  const handleLiveEvent = (event: AppEvent) => {
    // 受信時に該当タブを自動表示し、ウィンドウタイトルを更新する
    // （地震情報・津波情報・緊急地震速報）。
    // isNewQuake は UI ブロックと TTS ブロックの両方で参照するためここで宣言する
    let isNewQuake = true
    // 地震情報の読み上げの主題（イベント単位）。UI ブロックで決めて TTS ブロックで使う。
    // 取消は TTS ブロックを通らない（音の種別が決まらず早期 return する）ので、自分の分岐で組み立てる。
    let quakeSpeechTopic: SpeechTopic = 'quake:unknown'
    // 津波が新規発報か grade 格上げか（UI ブロックで立て、TTS ブロックで消費する）。
    // **観測点更新（grade 不変の続報）ではタブを動かさない**ための判定に使う。
    // 続報のたびに画面を持って行くと、EEW を見ている最中に何度も津波タブへ引っ張られる
    // （従来 CRIT-4 として抑制していた挙動を、追従の側でも踏襲する）。
    let tsunamiIsNewOrUpgraded = false
    // 津波の続報が「観測情報」か（等級が動いていない続報。区域が空の電文を含み、引き下げは含めない）。
    // **音の種別判定で立てて、読み上げの優先度と主題で消費する。** 同じ判定を書き分けると
    // 「更新音が鳴ったのに、読み上げは発報の重みで地震情報を切る」形の食い違いになる
    // （実際にそうなっていた。等級が動いていない続報まで `high` で読んでいた）。
    let tsunamiIsObservationUpdate = false
    if (event.kind === 'quake' && event.cancelled) {
      // 地震情報取消: カード削除は useEarthquakes reducer が担う。通知音・読み上げのみここで処理する。
      if (settings.soundEnabled) playAlertSound('eewCancel')
      // 読み上げがあるならタブ移動は読み上げに任せる（下の speakNonEEW に渡す follow）。
      // 取消の読み上げ文は常に非空なので、voicevoxEnabled だけで分岐できる。
      if (!settings.voicevoxEnabled) {
        log.info('[tab] earthquake を要求 (地震情報取消・読み上げ無効)')
        setActiveTabNonRealtime('earthquake')
      }
      title.clearTitleTimer('earthquake')
      title.applyPriority()
      if (settings.voicevoxEnabled) {
        // 取消電文の issue.time は取消電文自体の発表時刻であり、取り消された元の地震情報の発表時刻ではない。
        // 読み上げには同一 eventId で最後に受信した地震情報（既存カード）の time を使う。
        const cancelEventId = extractQuakeEventIdFromId(event.id)
        const original = cancelEventId
          ? earthquakesRef.current.find(e => extractQuakeEventIdFromId(e.id) === cancelEventId)
          : undefined
        speakNonEEWDelayed(
          earthquakeCancelToText(original?.time ?? null),
          SPEECH_PRIORITY.normal,
          1200,
          `quake:${quakeEventKey(event as import('../types/earthquake').JMAQuake)}`,
          { tab: 'earthquake', priority: TAB_PRIORITY.quake },
        )
      }
    } else if (event.kind === 'quake') {
      // 読み上げがあるならタブ移動は読み上げに任せる（共通の TTS ブロックが follow を渡す）。
      // 重い電文（EEW・津波）の読み上げ中に届いた地震情報は、その読み上げが終わって
      // 自分の番が来たときに画面を取る。地震情報の読み上げ文は常に非空。
      if (!settings.voicevoxEnabled) {
        log.info('[tab] earthquake を要求 (地震情報 VXSE51/52/53/61・読み上げ無効)')
        setActiveTabNonRealtime('earthquake')
      }
      const incomingQuake = event as import('../types/earthquake').JMAQuake
      const incomingKey = newQuakeTrackingKey(incomingQuake)
      isNewQuake = !seenQuakeReportKeysRef.current.has(incomingKey)
      if (isNewQuake) {
        markQuakeReportSeen(seenQuakeReportKeysRef.current, incomingKey)
      }
      // 新規・続報いずれも、受信した地震カードを選択状態にする。
      // 選択 ID はカードと照合するため eventKey で渡す。P2PQuake は続報ごとにレコード id が
      // 変わるので、既存カードがあればそのキーを引き継ぐ（このハンドラは useEarthquakes の
      // 統合より前に呼ばれるため、earthquakesRef はこの電文を取り込む前の状態）。
      // 同一 tick に複数電文が捌けて ref が追いつかない場合はキーが実カードと一致せず、
      // 選択は「取消でない最新カード」へフォールバックする（App.tsx の selectedQuake 導出）。
      const existingCard = earthquakesRef.current.find(q => sameQuakeEntry(q, incomingQuake))
      // 選択と読み上げの主題は同じキーで揃える（どちらも「どの地震か」を指すもの）。
      const incomingEventKey = quakeEventKey(existingCard ?? incomingQuake)
      quakeSpeechTopic = `quake:${incomingEventKey}`
      selectQuake(incomingEventKey)
      const { hypocenter, maxScale } = event.earthquake
      const isForeignQuake = event.issue.type === '遠地地震'
      // 震度を伝えない電文（VXSE52 等）では、同一イベントのカードが既に出している震度を消さない
      // （直前の VXSE51 表示を維持する）。
      //
      // **判定に isNewQuake を使ってはいけない。** キーには種別が入るため、震源情報は「その種別
      // としての初報」＝新規になる。以前はここが `isNewQuake` を含んでいたため歯止めが一度も効かず、
      // 震度速報のあとに震源情報が届くとタイトルが「最大震度不明」へ落ちていた。
      //
      // 既存カードが震度を持たない（震源情報が先に届いた・カードがまだ無い）ときは、出せる情報が
      // 他に無いので従来どおり「最大震度不明」で出す。遠地地震も maxScale は常に -1 だが、同一
      // イベントのカードは国内震度を持たないためこの歯止めに掛からず、規模が確定した続報はタイトルに
      // 反映される（`isForeignQuake` をここで除外する必要はない）。
      const keepsKnownScale = maxScale < 0 && (existingCard?.earthquake.maxScale ?? -1) >= 0
      if (keepsKnownScale) {
        // 残した事実を記録する。逆に「残すべきだったのに落ちた」ときも、この行が出ていないことで
        // 既存カードを引けなかった（同一 tick に複数電文が捌けて `earthquakesRef` が追いつかない）
        // と切り分けられる。
        log.debug(`[title] 震度なしの電文なのでタイトルを更新しない (既存の最大震度=${existingCard?.earthquake.maxScale})`)
      } else {
        // 遠地地震は国内で震度を観測しない（maxScale は常に -1）。「最大震度不明」と出すと
        // 震度が判明していないだけに読めてしまうため、規模を出す別書式にする。
        title.setTitle(isForeignQuake
          ? `遠地地震 ${hypocenter.name}${hasMagnitude(hypocenter.magnitude) ? ` ${formatMagnitude(hypocenter.magnitude)}` : ''}`
          : `地震情報 ${hypocenter.name} 最大震度${getIntensityLabel(maxScale)}`)
      }
      title.scheduleTitleRevert('earthquake')
    } else if (event.kind === 'tsunami' && !event.cancelled) {
      // タブ移動の規則:
      //   - 読み上げがあるなら**読み上げに任せる**（共通の TTS ブロックが follow を渡す）。
      //     観測点更新（grade 不変の続報）も、読み上げが発生するときだけ画面が動く。
      //     変化が無い続報は読み上げも無いので画面も動かない（フィルタは TTS ブロック側）
      //   - 読み上げが無い端末（voicevoxEnabled=false）は従来どおり、**新規発報と grade 格上げだけ**が
      //     tsunami タブを奪う。続報では奪わない
      //   - EEW の発表状況はここでは見ない（重み付けは `TAB_PRIORITY` に任せる）
      //
      // 従来は「続報でタブを奪わない」理由を「毎回 15 秒の抑制が再セットされて EEW 続報が
      // realtime へ戻れなくなる」としていた（CRIT-4）が、追従として出す保持は追従どうしでは
      // 見ないため（`shouldAcceptAutoTab`）、この閘は消えている。
      const current = tsunamisRef.current[0]
      const isNew = isTsunamiNewFire(event, current)
      const upgraded = isTsunamiGradeUpgrade(event, current)
      tsunamiIsNewOrUpgraded = isNew || upgraded
      // 解除の照合に使うので、受信した順で覚える（理由は宣言箇所）。タブ切替の判定が
      // `tsunamisRef` を見ているのは従来どおり（あちらは「画面がいま何を出しているか」の話）。
      lastTsunamiRef.current = event
      if (!settings.voicevoxEnabled) {
        if (tsunamiIsNewOrUpgraded) {
          log.info(`[tab] tsunami を要求 (${isNew ? '新規発報' : 'グレード格上げ'}・読み上げ無効)`)
          setActiveTabNonRealtime('tsunami')
        } else {
          log.debug('[tab] tsunami タブ切替スキップ (同一イベント扱い・grade 不変・読み上げ無効)')
        }
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
      // 読み上げがあるなら追従に任せる（下の speakNonEEW に渡す follow）。
      if (!alreadySpoken && !settings.voicevoxEnabled) {
        log.info('[tab] tsunami を要求 (津波情報取消・読み上げ無効)')
        setActiveTabNonRealtime('tsunami')
      }
      title.endTsunamiTitleWindow()
      title.applyPriority()
      // 津波解除・取消・失効の通知音（AUD-6）。cancelReason の 3 種を区別せず単一音で伝える。
      // TTS は eewCancel と同じく音の後ろへずらして音響重複を避ける。
      //
      // 見直しの基準と実測値は audio-tts-spec.md §6 の表に集約してある。
      // 2 音目を観測情報の更新に揃えて音が 1.33 → 0.82 秒に詰まったため、遅延も 1700ms から
      // 詰めた。1200ms の時点で音は完全に止まっている（地震情報の取消・EEW 誤報取消と同値）。
      if (!alreadySpoken) {
        spokenTsunamiCancelEventIdsRef.current.add(cancelId)
        if (settings.soundEnabled) playAlertSound('tsunamiCancel')
        if (settings.voicevoxEnabled) {
          speakNonEEWDelayed(
            tsunamiCancelToText(event.cancelReason),
            SPEECH_PRIORITY.high,
            1200,
            'tsunami',
            { tab: 'tsunami', priority: TAB_PRIORITY.tsunami },
          )
        }
      }
      // **表示中の津波に向けた解除でなければ、状態は何も落とさない。**
      //
      // 津波は 1 件スロットで持つため、別イベントの遅延到達した解除（複数経路の解除・再送・
      // 失効タイマー）が、進行中の別の津波の記憶を消してしまう。カードの状態更新
      // （`useEarthquakes`）は同じ判定で弾いているのに、こちら（音・読み上げ・画面の記憶）は
      // `handleEvent` が状態更新の成否に関わらず先に呼ぶため、照合を自分で行う必要がある。
      // 判定は `isCancelForCurrentTsunami` に集約して両側で共有する。
      //
      // 音と読み上げは従来どおり照合せずに鳴らす（この分岐の上）。「カードは残っているのに
      // 解除を読み上げる」食い違いは既知の性質で、解除を落とす方が害が大きいという判断
      // （理由は `isCancelForCurrentTsunami`）。ここで揃えているのは**記憶と画面の状態**だけ。
      //
      // 照合の相手は自分が受信した直前の津波（`lastTsunamiRef`）。`tsunamisRef` を見ると、
      // 同一 tick に複数の電文が捌けたときに取り残された値と比べてしまう（宣言箇所に理由）。
      if (isCancelForCurrentTsunami(event, lastTsunamiRef.current ?? undefined)) {
        lastTsunamiGradeRef.current = null
        lastTsunamiRef.current = null
        // 観測点の記憶は**波高と名前の両方**を、**画面用と読み上げ用の両方**で落とす。
        //
        // 波高だけ落として名前を残すと、前の津波で「観測中」（波高未確定）のまま終わった観測点は、
        // 次の津波で再び到達が確認されても「新規到達」と見なされず、到達を一度も伝えられない
        // （名前は波高の有無に関わらず記録されるため。`rememberObservations`）。常時起動する
        // 使い方では 1 セッションで複数の津波をまたぐので、実際に起こりうる。
        //
        // 画面用と読み上げ用のどちらか片方だけ落とすと、「声は到達を伝えるのにバッジが付かない」
        // （またはその逆）になる。判定は同じ観測点集合を見るので、揃えて落とすこと。
        lastMaxObsHeightRef.current.clear()
        seenObsNamesRef.current.clear()
        spokenObsHeightRef.current.clear()
        spokenObsNamesRef.current.clear()
        window.clearTimeout(obsStatusClearTimerRef.current)
        setObsUpdateStatus(new Map())
        setFocusedDistrict({ districts: [], top: null, ts: Date.now() })
      } else {
        // 捨てた事実を残す。黙って通すと「解除を受けたのにバッジが消えない」を追えない。
        log.info('[tsunami] 表示中の津波と一致しない解除のため、観測点の記憶は落とさない')
      }
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
              // 誤報取消は「手動選択より強い」側の通知なので、追従も eewUrgent で出す
              // （eewUpdate だと、取消を読み上げる直前に手動で別タブへ移られた場合に弾かれる）。
              scheduleSpeech(1200, () => chainEEWSpeech(
                () => eewCancelToText(event),
                () => followSpeechTab('realtime', TAB_PRIORITY.eewUrgent),
              ))
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
        // 誤報取消（訂正）だけは、鳴っている途中の読み上げも打ち切る対象として覚えておく。
        // 自動解除（expired）は「発表が終わった」だけで内容が誤りだったわけではなく、
        // 途中で切っても代わりに読むものが無い（取消の読み上げは誤報取消のみ）。
        if (!event.expired) eewRetractedKeysRef.current.add(key)
        // EEW 解除時は当該 eventId の読み上げ待ちを取り下げる。
        // eewTtsEventsRef を消すことで、既にチェーンに繋がっている予約も解決時に自ら黙る
        // （取り消された地震の予想震度を読み上げないための最終ガード）。
        const pendingMaxTimer = eewTtsMaxTimersRef.current.get(key)
        if (pendingMaxTimer) { clearTimeout(pendingMaxTimer); eewTtsMaxTimersRef.current.delete(key) }
        eewTtsEventsRef.current.delete(key)
        eewPhase2TokensRef.current.delete(key)
        eewPhase2DoneRef.current.delete(key)
        spokenEEWLevelsRef.current.delete(key)
        // 安定待ちの進行中サイクル・確定値も落とす（取り消された地震の値を残さない）
        const pendingScaleStability = eewScaleStabilityRef.current.get(key)
        if (pendingScaleStability) { clearTimeout(pendingScaleStability.timer); eewScaleStabilityRef.current.delete(key) }
        const pendingLpgmStability = eewLpgmStabilityRef.current.get(key)
        if (pendingLpgmStability) { clearTimeout(pendingLpgmStability.timer); eewLpgmStabilityRef.current.delete(key) }
        eewConfirmedScaleRef.current.delete(key)
        eewConfirmedLpgmRef.current.delete(key)
        // 発表が終わった EEW を「鳴っている最中」と見なさないため（言い直しの判定に使う）。
        // 予約が黙って降りるときにも消えるが、そちらは発話の順番が来てからになる。
        eewPhase1ProgressRef.current.delete(key)
        if (!event.expired && hadKey) {
          // 誤報取消（10秒キャンセル表示中）: 他に発表中のEEWがあってもリアルタイムタブでオーバーレイを見せる
          log.info('[tab] realtime を要求 (EEW誤報取消・キャンセル表示)')
          setActiveTabRealtimeUrgent()
        }
        if (activeEEWLevelsRef.current.size === 0) {
          title.clearTitleTimer('eew')
          title.applyPriority({ eews: new Map<string, EEWAlert>() })
          // 自動解除（expired）はタブを動かさない。誤報取消の遅延到達（!hadKey かつ !expired）のみ対象。
          // 最終報を複数受信すると expired キャンセルも複数キューに入るため、
          // 2発目（hadKey=false・expired=true）でタブが動かないよう expired を明示的に除外する。
          if (!hadKey && !event.expired) {
            if (kyoshinDetectedRef.current) {
              log.info('[tab] realtime を要求 (EEW全解除・揺れ検知中)')
              setActiveTabRealtimeForKyoshin()
            } else {
              log.info(`[tab] → ${defaultTabRef.current} (EEW全解除)`)
              revertToDefaultTab()
            }
          }
        }
        return
      }

      const currentLevel = computeSingleEEWLevel(event)
      // 上限が定まらない報は通知・タイトルでも「以上」を添える（値だけでは下限の断定になる）。
      const { scale, orAbove: scaleOrAbove } = eewMaxScaleInfo(event)

      // 新規発報か続報かを判定し、レベルの格上げを検出する。
      // 震度・長周期階級の引き上げはここでは見ない。読み上げ側は「実際に発話した値」と
      // 「発話する直前の最新値」を比べるため（enqueuePhase2）、受信時点の比較は使わない。
      const isNew = !activeEEWLevelsRef.current.has(key)
      const prevLevel = activeEEWLevelsRef.current.get(key) ?? 0
      const levelUpgraded = !isNew && currentLevel > prevLevel
      // 区分（予報→警報）の格上げだけを見る特別扱い。`levelUpgraded` は警報→特別警報の
      // 格上げも含んでしまうが、特別警報は「緊急地震速報」という同じ区分の中の話で、
      // 音声では「警報」に統一する方針（docs/spec/eew-spec.md §4）。震度の安定待ちを
      // スキップしてよいのは、区分そのものが変わる予報→警報のときだけ
      // （警報→特別警報は震度の値の変化に過ぎず、安定待ちを通すべき）。
      const severityUpgraded = !isNew && currentLevel >= 1 && prevLevel < 1

      // 新規発報・レベルアップは抑制なしで即時移動。続報は抑制タイマーを確認する。
      if (isNew || levelUpgraded) {
        log.info(`[tab] realtime を要求 (EEW${isNew ? '新規発報' : 'レベルアップ'} key=${key})`)
        setActiveTabRealtimeUrgent()
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
        // 予報級の電文は VXSE45「緊急地震速報（地震動予報）」。通知の見出しも実態に合わせる
        const eewNotifyTitle = currentLevel === 2 ? '緊急地震速報 特別警報'
          : currentLevel === 1 ? '緊急地震速報 警報' : eewKindLabel(0)
        showBrowserNotification(
          eewNotifyTitle,
          `${event.earthquake.hypocenter.name}${scale > 0 ? ` 最大震度${getIntensityLabelWithOrAbove(scale, scaleOrAbove)}予想` : ''}`,
          `eew-${key}`,
          true,
        )
      }
      // EEW タイトルをイベントデータから構築（state は未更新のため event 直接参照）
      const newCount = activeEEWLevelsRef.current.size
      // 区分の名前は「発表中の EEW すべての最大レベル」から決める（受信したこの報の区分では
      // 決めない）。予報級の報を受けた瞬間に、別に発表中の警報級が隠れてしまうため。
      // useAlertTitle の computeEEWTitle と同じ `eewKindLabel` を使い、文言がずれないようにする。
      const titleLevel = Array.from(activeEEWLevelsRef.current.values())
        .reduce<0 | 1 | 2>((m, l) => Math.max(m, l) as 0 | 1 | 2, 0)
      const eewTitle = `${eewKindLabel(titleLevel)} ${event.earthquake.hypocenter.name}` +
        (scale > 0 ? ` 最大震度${getIntensityLabelWithOrAbove(scale, scaleOrAbove)}予想` : '') +
        (newCount > 1 ? ` 他${newCount - 1}件` : '')
      title.setTitle(eewTitle)
      title.scheduleTitleRevert('eew')

      // VOICEVOX: 2フェーズ読み上げ
      // 第1フェーズ（isNew 即時／続報での震源の大幅更新／予報から警報への言い直し）:
      //   「地震動予報、〇〇で地震。」/「緊急地震速報、〇〇で地震。」/「震源を更新、〇〇で地震。」
      // 第2フェーズ（第1フェーズの完了後。以降の続報も直前の発話の完了後）:
      //   「（緊急地震速報に切り替わりました。）予想最大震度〇〇。（予想最大階級〇。）」
      // 続報で予想が上がったときも同じ形で言い直す（引き上げ専用の短句は持たない。
      // 理由は eewIntensityText の JSDoc）。
      // 読み上げは soundEnabled と独立に voicevoxEnabled のみで判定する（AUD-7）。
      if (settings.voicevoxEnabled) {
        eewTtsEventsRef.current.set(key, event)
        // 同じ eventId で発表が再開することはないが、取消の記録を持ち越すと以後の読み上げが
        // 鳴らせなくなるため、報を受けた時点で必ず落とす
        eewRetractedKeysRef.current.delete(key)

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
            // **安定待ちを経て確定した値を使う**（生イベントの eewMaxScaleInfo/eewMaxLpgmClass
            // ではない）。震度が未確定のままこのトリガーが呼ばれることは無い想定
            // （呼び出し側の非対称ルール。confirmScale/confirmLpgm の宣言箇所参照）だが、
            // 念のため防御する。階級は未確定なら 0（省略）として扱う。
            const confirmedScale = eewConfirmedScaleRef.current.get(key)
            if (!confirmedScale) {
              // 想定外。震度が確定する前にこのトリガーが呼ばれるはずが無い
              // （呼び出し側の非対称ルール）。無言のまま握り潰さず記録に残す。
              log.warn('[eew] 想定外: 震度未確定のまま phase2 が呼ばれた', key)
              return null
            }
            const confirmedLpgm = eewConfirmedLpgmRef.current.get(key) ?? 0
            // 区分は引き下げない。一度「警報」と伝えた EEW は、以後 severity が落ちても
            // 「伝え済み」として扱う（前置きを言い直さない。activeEEWLevelsRef の Math.max と同じ方針）。
            const spokenLevel = spokenEEWLevelsRef.current.get(key) ?? 0
            const level = Math.max(computeSingleEEWLevel(latest), spokenLevel) as 0 | 1 | 2
            // まだ一度も予想値を読んでいなければ無条件に読む（初報・震源更新の読み直し）。
            // 読んだ後は、実際に発話した値より上がったものが一つも無ければ黙る（引き下げは追わない）。
            if (eewPhase2DoneRef.current.has(key)
              && !isForecastScaleHigher(confirmedScale, spokenEEWScalesRef.current.get(key))
              && confirmedLpgm <= (spokenEEWLpgmClassesRef.current.get(key) ?? 0)
              && level <= spokenLevel) return null
            // 「緊急地震速報に切り替わりました。」は、予報として発報されたものが警報へ
            // 上がったときだけ。初報から警報なら第 1 フェーズが「緊急地震速報、〇〇で地震。」と
            // 伝えており（そのとき spokenEEWLevelsRef を埋めている）、重ねて言う意味がない。
            const announceUpgrade = level >= 1 && spokenLevel < 1
            // 震度が実際に声に出た値（spokenEEWScalesRef）とちょうど一致していて、区分格上げの
            // 前置きも無いなら、震度は繰り返さず階級部分だけを読む。震度自体が上がった・下がった
            // 場合や、区分格上げに伴う場合はこれまでどおり震度も含めて全文を読み直す
            // （区分格上げは「何の震度で警報になったか」を再確認させる意味があるため省略しない）。
            const spokenScale = spokenEEWScalesRef.current.get(key)
            const scaleUnchanged = !announceUpgrade && eewPhase2DoneRef.current.has(key)
              && spokenScale !== undefined
              && spokenScale.scale === confirmedScale.scale
              && spokenScale.orAbove === confirmedScale.orAbove
            // 震度据え置きで、階級もまだ何も確定していなければ（confirmedLpgm=0）、実際に
            // 読むべき差分が無い。`level` は安定待ちを経ない生イベントから即座に計算されるため
            // （1536行目）、階級の安定待ちが完了する前に一時的に level だけが上がって上の
            // 早期returnゲートをすり抜けることがある。ここで空文字のまま `eewLpgmOnlyText` を
            // 呼ぶと「想定外」警告が誤って出たうえ、既読（spokenEEWLevelsRef 等）も更新されない
            // まま終わってしまう（1567行目以降に到達しないため）。階級が正式に確定すれば
            // `confirmLpgm` 経由で改めてここへ呼ばれるので、ここで黙っても取りこぼしにはならない。
            if (scaleUnchanged && confirmedLpgm === 0) return null
            const text = scaleUnchanged
              ? eewLpgmOnlyText(confirmedLpgm)
              : eewIntensityText(confirmedScale, confirmedLpgm, latest, announceUpgrade)
            if (!text) {
              // 想定外。eewIntensityText 経由なら eewScaleOnlyText が常に非空を返す
              // （noForecastText が全ケースをカバーするため）。scaleUnchanged 経由の
              // eewLpgmOnlyText 単体も、confirmedLpgm===0 のケースは上の早期return で
              // 弾いているため常に非空のはず。無言のまま握り潰さず記録に残す。
              log.warn('[eew] 想定外: phase2 のテキストが空になった', key)
              return null
            }
            // 既読の更新は発話の直前だけで行う。予約した時点で更新すると、取消で捨てられた発話や
            // 割り込みで消えた発話まで既読になり、一度も声に出していない値が基準になってしまう。
            spokenEEWScalesRef.current.set(key, confirmedScale)
            spokenEEWLpgmClassesRef.current.set(key, confirmedLpgm)
            spokenEEWLevelsRef.current.set(key, level)
            eewPhase2DoneRef.current.add(key)
            return {
              text,
              /**
               * この文面を作ったときの値より新しいものが確定していたら、そこから先は鳴らさない。
               *
               * 安定待ちを経てもなお、確定から発話までの合成の往復（実測 238〜697ms）の間に
               * 次の確定が挟まることはある。取り下げても取りこぼしにはならない: 上がった確定を
               * 受けた時点で次の第 2 フェーズが予約済みで、そちらが最新値を読む。
               *
               * ここで「上がったときだけ」に限るのは、引き下げを追わない方針（黙る）と揃えるため。
               * 下がったことを理由に取り下げると、代わりに読むものが無く無音で終わる。
               *
               * 見るのは**確定値**（`eewConfirmedScaleRef`）であって生イベントの最新値ではない。
               * 安定待ちの途中（まだ確定していない暫定候補）で発話を止めてしまうと、安定待ちを
               * 導入した意味が無くなる。
               */
              shouldStillPlay: () => {
                if (eewRetractedKeysRef.current.has(key)) return false  // 誤報取消（訂正）
                const now = eewTtsEventsRef.current.get(key)
                // 自動解除で消えた場合は鳴らし続ける。発表は終わったが、読んでいる値は誤りではない
                if (!now) return true
                const nowScale = eewConfirmedScaleRef.current.get(key)
                if (!nowScale) return true
                const nowLpgm = eewConfirmedLpgmRef.current.get(key) ?? 0
                return !isForecastScaleHigher(nowScale, confirmedScale)
                  && nowLpgm <= confirmedLpgm
                  && computeSingleEEWLevel(now) <= level
              },
            }
          }, () => followSpeechTab('realtime', TAB_PRIORITY.eewUpdate))
        }

        /** 震度の安定待ちサイクル・タイマーを終了する（後始末専用。確定処理は行わない）。 */
        const clearScaleStability = () => {
          const cycle = eewScaleStabilityRef.current.get(key)
          if (cycle) { clearTimeout(cycle.timer); eewScaleStabilityRef.current.delete(key) }
        }
        /** 長周期階級の安定待ちサイクル・タイマーを終了する（後始末専用）。 */
        const clearLpgmStability = () => {
          const cycle = eewLpgmStabilityRef.current.get(key)
          if (cycle) { clearTimeout(cycle.timer); eewLpgmStabilityRef.current.delete(key) }
        }

        /**
         * 震度が確定した（安定 or 上限到達）。震度は緊急性が高いため、階級の確定を待たず
         * 常にここで読み上げをトリガーする（階級が既に確定済みなら一緒に読まれる。
         * `enqueuePhase2` が `eewConfirmedLpgmRef` を見て組み立てる）。
         */
        const confirmScale = (scaleInfo: EewMaxScaleInfo) => {
          // 区分の格上げ等で安定待ちの途中から強制確定させることがあるため、進行中の
          // タイマーが残っていれば止める。止めずに delete だけすると、元のタイマーが後で
          // 発火した際に古い値へ巻き戻ってしまう
          const cycle = eewScaleStabilityRef.current.get(key)
          if (cycle) clearTimeout(cycle.timer)
          eewScaleStabilityRef.current.delete(key)
          eewConfirmedScaleRef.current.set(key, scaleInfo)
          enqueuePhase2()
        }

        /**
         * 長周期階級が確定した（安定 or 上限到達）。**震度がまだ確定していなければ何もしない**
         * ——震度が確定するまで保留し、震度確定時に一緒に読む（非対称ルール。宣言箇所は
         * `eewConfirmedScaleRef` の JSDoc）。震度が既に確定済みなら、ここでトリガーする
         * （震度は既読の値のまま再利用され、実質「階級だけの追加読み上げ」になる）。
         *
         * ただし**震度側で新しい安定待ちサイクルが進行中なら、ここではトリガーしない**。
         * 震度・階級が同一続報で同時に変化すると、階級の安定待ち（300ms固定）の方が震度側
         * （跳躍幅次第で300〜2000ms）より先に完了することがある。ここで待たずにトリガーすると、
         * 震度がまだ「変化中」なのに `enqueuePhase2` 側が「据え置き」と誤判定して階級だけの
         * 短句を読み、直後に震度の確定で全文をもう一度読む——という二重発話になる。
         */
        const confirmLpgm = (lpgmClass: number) => {
          eewLpgmStabilityRef.current.delete(key)
          eewConfirmedLpgmRef.current.set(key, lpgmClass)
          if (eewConfirmedScaleRef.current.has(key) && !eewScaleStabilityRef.current.has(key)) enqueuePhase2()
        }

        /**
         * 震度の安定待ちサイクルを更新する。値が変わっていなければ何もしない
         * （タイマーは張ったまま）。変わっていれば待ち直す。跳躍幅（`eewPhase2ScaleStabilityMs`）
         * が baseScale（サイクル開始時点の直前の確定値）から 1 段階以上あれば長く待つ。
         *
         * baseScale はサイクル中は据え置きなので、瞬間的に跳ね上がった値が同じサイクル内で
         * 直前の確定値へちょうど戻ると、跳躍幅が 0 段階に戻って短い猶予（SMALL=300ms）で
         * 即確定する。2024/01/01 能登本震の第13報（6強→7→608ms後に6強へ訂正）では、この
         * 復帰が震度7の長い猶予（LARGE=2000ms）タイマーより先に発火し、訂正後の6強で
         * 確定する（既読の6強と同値なので実際には黙る）。
         *
         * 上限（`EEW_PHASE2_STABILITY_MAX_WAIT_MS`）はサイクル開始時刻から固定でカウントし、
         * 値が変わるたびにリセットしない。リセットすると、続報が連投される大地震ほど
         * いつまでも確定しなくなる（2026-08-19 に一度潰した問題の再発）。
         */
        const updateScaleStability = (scaleInfo: EewMaxScaleInfo) => {
          const cycle = eewScaleStabilityRef.current.get(key)
          if (cycle) {
            if (cycle.scaleInfo.scale === scaleInfo.scale && cycle.scaleInfo.orAbove === scaleInfo.orAbove) return
          } else {
            // サイクルが無い（＝既に確定済み）場合も、確定値と同じなら安定待ちをやり直さない。
            // ここを見ずに常に新規サイクルを作ると、変化していない続報のたびに待ち直しが
            // 発生してしまう
            const confirmed = eewConfirmedScaleRef.current.get(key)
            if (confirmed && confirmed.scale === scaleInfo.scale && confirmed.orAbove === scaleInfo.orAbove) return
          }
          if (cycle) clearTimeout(cycle.timer)
          const since = cycle ? cycle.since : Date.now()
          const baseScale = cycle ? cycle.baseScale : (eewConfirmedScaleRef.current.get(key)?.scale ?? scaleInfo.scale)
          const stabilityMs = eewPhase2ScaleStabilityMs(scaleInfo.scale, baseScale)
          const remainingMaxWaitMs = since + EEW_PHASE2_STABILITY_MAX_WAIT_MS - Date.now()
          const waitMs = Math.max(0, Math.min(stabilityMs, remainingMaxWaitMs))
          const timer = setTimeout(() => confirmScale(scaleInfo), waitMs)
          eewScaleStabilityRef.current.set(key, { scaleInfo, baseScale, since, timer })
        }

        /**
         * 長周期階級版の `updateScaleStability`。跳躍幅は使わず、固定時間の変化なし確定のみ。
         * 震度と同じく上限（`EEW_PHASE2_STABILITY_MAX_WAIT_MS`）を持つ——無いと、階級が
         * 固定待ち時間より短い間隔で変化し続けた場合に永久に確定しなくなる（震度は必ず読まれるが、
         * 階級だけがその EEW で一度も読み上げられないまま終わる）。
         */
        const updateLpgmStability = (lpgmClass: number) => {
          const cycle = eewLpgmStabilityRef.current.get(key)
          if (cycle) {
            if (cycle.lpgmClass === lpgmClass) return
          } else if (eewConfirmedLpgmRef.current.get(key) === lpgmClass) {
            return
          }
          if (cycle) clearTimeout(cycle.timer)
          const since = cycle ? cycle.since : Date.now()
          const remainingMaxWaitMs = since + EEW_PHASE2_STABILITY_MAX_WAIT_MS - Date.now()
          const waitMs = Math.max(0, Math.min(EEW_PHASE2_LPGM_STABILITY_MS, remainingMaxWaitMs))
          const timer = setTimeout(() => confirmLpgm(lpgmClass), waitMs)
          eewLpgmStabilityRef.current.set(key, { lpgmClass, since, timer })
        }

        // 続報での震源地名変化+座標移動の検出（B-3: 名前変化かつ50km超移動で再発話）
        const hypo = event.earthquake.hypocenter
        const prevHypo = activeEEWAnnouncedHypocentersRef.current.get(key)
        const hypoNameChanged = !isNew && prevHypo !== undefined && hypo.name !== prevHypo.name
        const hypoFarMoved = hypoNameChanged && Number.isFinite(hypo.latitude) && Number.isFinite(hypo.longitude)
          && haversineKm(hypo.latitude, hypo.longitude, prevHypo.lat, prevHypo.lng) > 50
        // 予報として**読み上げている最中に**警報へ上がった。読み切るのを待たず、警報として
        // 頭から言い直す（待つと区分の告知が実測 5.5 秒遅れる）。語の途中で切れても文の頭から
        // やり直すため、地名を聞き違えたまま残ることはない。
        //
        // まだ声になっていないときと、読み終えているときは何もしない。前者は発話の直前に区分を
        // 決め直すので、そのまま**発話直前の最新値**で読まれる（下限は伝え済みの区分で維持
        // されるが、上がることは保証されない。声になる前に severity が戻る続報が届けば予報として
        // 読む）。後者は第 2 フェーズが「緊急地震速報に切り替わりました。」と前置きして伝える。
        //
        // 見るのは**読み上げた区分**（spokenEEWLevelsRef）で、受信レベルの上昇（levelUpgraded）
        // ではない。後者だと警報 → 特別警報の格上げでも言い直すが、区分は既に伝えてあり、
        // 「特別警報」は音声では読まない方針（docs/spec/eew-spec.md §4）なので言い直す中身が無い。
        //
        // 震源の大幅更新と重なったときは**そちらに譲る**（`!hypoFarMoved`）。読む文面は
        // 「震源を更新、〇〇で地震。」で区分に触れないため、割り込んでも警報は伝わらない
        // （区分は続く第 2 フェーズの前置きが伝える）。鳴っているものを止める価値がない。
        //
        // 予約済みでまだ声になっていない言い直しがあれば重ねない（`restateToken`）。続報は
        // 密集するため、これが無いと同じ文言を何度も積む。
        const phase1Progress = eewPhase1ProgressRef.current.get(key)
        const restateAsWarning = !isNew && !hypoFarMoved && currentLevel >= 1
          && (spokenEEWLevelsRef.current.get(key) ?? 0) < 1
          && phase1Progress?.restateToken == null
          && phase1Progress?.speakingToken != null
        const firePhase1 = isNew || hypoFarMoved || restateAsWarning

        if (firePhase1) {
          // 第1フェーズ。震源が大きく動いた場合は旧震源での値を基準に残さない。残すと新震源で
          // 確定した値が旧値を超えたときだけ報じられ、震源が変わったことに触れないまま終わる。
          clearPhase2MaxTimer()
          eewPhase2TokensRef.current.delete(key)
          eewPhase2DoneRef.current.delete(key)
          spokenEEWScalesRef.current.delete(key)
          spokenEEWLpgmClassesRef.current.delete(key)
          // 安定待ちの進行中サイクルと確定値も、旧震源のものを引きずらないよう落とす
          clearScaleStability()
          clearLpgmStability()
          eewConfirmedScaleRef.current.delete(key)
          eewConfirmedLpgmRef.current.delete(key)
          // spokenEEWLevelsRef は**消さない**。同じ EEW である以上、区分は伝え済みで、
          // 震源が動くたびに「警報。」を言い直す必要はない（消すと言い直しになる）。
          const phase1Token = {}
          // **`speakingToken` には触らない。** 鳴っているかどうかは予約を積み直しても変わらない
          // （震源の大幅更新は古い音を止めずに積む）。ここで消すと「鳴っていない」と誤認し、
          // 直後に警報へ上がっても言い直しが発火せず、告知が第 2 フェーズの前置きまで遅れる。
          if (restateAsWarning) updatePhase1Progress(key, { restateToken: phase1Token })
          // 後始末は**自分が置いた分だけ**。予約は積み直されるので、無条件に消すと他の予約の
          // 記録まで落ちる（言い直しの予約が消えれば二重読み、鳴っている記録が消えれば
          // 鳴っていない相手への割り込みになる）。
          const forgetSpeaking = () => {
            if (eewPhase1ProgressRef.current.get(key)?.speakingToken === phase1Token) {
              updatePhase1Progress(key, { speakingToken: null })
            }
          }
          const forgetOwnRestate = () => {
            if (eewPhase1ProgressRef.current.get(key)?.restateToken === phase1Token) {
              updatePhase1Progress(key, { restateToken: null })
            }
          }
          // 新規発報は「手動選択より強い」側なので追従も eewUrgent。震源の大幅更新・警報への
          // 言い直しは既に発表中の EEW の言い直しなので eewUpdate（受信時要求の使い分けと揃える）。
          chainEEWSpeech(
            () => {
              // 自分が言い直しとして積まれていたなら、その予約はここで消化される。以後の格上げは
              // 改めて言い直せる（警報を読めば下で既読の区分が入るので既読側で弾かれ、取消で
              // 降りたなら言い直せる状態に戻るのが正しい）。**自分の分だけ降ろすこと**——
              // 無条件に消すと、他の予約が置いた言い直しの印まで落として二重読みに戻る。
              forgetOwnRestate()
              // 待っている間に取消・自動解除が届いていたら震源も読まない。鳴らし始めてから届いた
              // 場合に残りを落とすのは**誤報取消のときだけ**（理由は eewRetractedKeysRef の宣言箇所）。
              // ここでは `speakingToken` に触らない（鳴っているのは自分ではない別の予約）。
              const latest = eewTtsEventsRef.current.get(key)
              if (!latest) return null
              // **区分は発話の直前に決める。** 予約から声になるまでには前の発話の完了待ちと
              // 合成の往復（実測 238〜697ms）があり、その間にも続報は届く。受信時点で決めると、
              // 待っている間に警報へ上がっていても予報として読み、直後に「切り替わりました」を
              // 言う羽目になる。区分は引き下げない（spokenEEWLevelsRef の Math.max と同じ方針）。
              const level = Math.max(
                computeSingleEEWLevel(latest),
                spokenEEWLevelsRef.current.get(key) ?? 0,
              ) as 0 | 1 | 2
              // 切り出しの語で区分を伝える（予報＝地震動予報／警報＝緊急地震速報）。
              // 震源更新では区分に触れない（既に伝えてあり、変わったのは震源だから）。
              const kind = hypoFarMoved ? 'hypocenterUpdate' : level >= 1 ? 'warning' : 'forecast'
              // 震源名は**受信した報のもの**を使う（最新へ取り直さない）。下で記録する
              // 「発話した震源」と食い違うと、次の続報での移動量の判定が狂う。
              //
              // **読み上げ文を先に作り、成功してから状態を書き換えること**（第 2 フェーズと同じ
              // 順序）。先に書き換えると、生成で例外が出たときに `onSettled` へ到達しないまま
              // catch へ落ち、「警報を伝えた」記録と「鳴っている」記録が残る。以後この EEW では
              // 言い直しも前置きも二度と成立せず、警報が永久に声にならない。
              const text = eewAlertToText(event, kind)
              // 「緊急地震速報」と切り出した時点で警報だと伝えている。第 2 フェーズで格上げを
              // 読み直さないよう、既読の区分として記録する。記録しないと初報から警報だった
              // EEW でも「切り替わりました」と言ってしまう。**記録は発話の直前だけで行う**——
              // 予約の時点で記録すると、取消で声にならなかった区分まで伝え済みになり、以後
              // 格上げが一度も声にならない（第 2 フェーズが既読値の更新を発話直前に限るのと同じ理由）。
              if (!hypoFarMoved && level >= 1) spokenEEWLevelsRef.current.set(key, level)
              updatePhase1Progress(key, { speakingToken: phase1Token })
              return {
                text,
                shouldStillPlay: () => !eewRetractedKeysRef.current.has(key),
                onSettled: forgetSpeaking,
              }
            },
            () => followSpeechTab('realtime', isNew ? TAB_PRIORITY.eewUrgent : TAB_PRIORITY.eewUpdate),
            restateAsWarning,
          )
          // 発話した震源情報を記録する
          if (Number.isFinite(hypo.latitude) && Number.isFinite(hypo.longitude)) {
            activeEEWAnnouncedHypocentersRef.current.set(key, { name: hypo.name, lat: hypo.latitude, lng: hypo.longitude })
          }
        }

        /**
         * 震度・長周期階級の安定待ちを更新する。`firePhase1` かどうかに関わらず統一的に行う
         * ——新規発報・震源更新・言い直しの直後も、通常の続報も、扱いは同じでよい
         * （実際に読み上げるかどうかは `enqueuePhase2` 側の isForecastScaleHigher 等の
         * 比較に任せているため、ここでは「震度・階級それぞれ独立に安定を待つ」ことだけを担う）。
         *
         * 待つのは「予想震度が遅れて付くかもしれない」ときだけ。値があるときだけ安定待ちに回す。
         * 付かない理由がはっきりしている（仮定震源要素・深発地震）、または区分の格上げ
         * （`severityUpgraded`＝予報→警報。震度の値の変化より重い）は、**安定待ちを経由せず**
         * 即座に確定する——理由も区分も「値の変化」ではなく、待っても結論が変わらないか・
         * 待つ意味が無いため（待つと理由付きの「予想震度なし」を読むまで、または格上げの告知が
         * 無言になるだけ）。`severityUpgraded` は値があっても優先する——震度は据え置きでも
         * 区分の格上げは伝える必要があり、`updateScaleStability` の「変化なしなら何もしない」
         * 判定に埋もれてしまうため。**`levelUpgraded` は使わない**——警報→特別警報の格上げも
         * 含んでしまい、震度の値が変わっただけなのに安定待ちを飛ばしてしまう
         * （特別警報は音声では「警報」に統一する方針で、区分としては別物ではない）。
         */
        // 階級のタイマーは**震度より先に**セットする。同じ電文で震度・階級とも初出値
        // （どちらも安定待ち時間が同じ 300ms）の場合、先にセットしたタイマーが先に発火する
        // 実行順の性質を利用して、階級を必ず先に確定させる。こうしておけば、階級確定時点では
        // 震度がまだ未確定のため `confirmLpgm` が保留し、直後に震度が確定した瞬間に一緒に
        // 読まれる。逆（震度を先にセットする）だと、震度だけが単独で先に確定・発話され、
        // 数 ms 後に階級だけの再読み上げが続くという不自然な二重発話になる
        updateLpgmStability(eewMaxLpgmClass(event))
        if (severityUpgraded) {
          clearPhase2MaxTimer()
          confirmScale({ scale, orAbove: scaleOrAbove })
        } else if (scale > 0) {
          clearPhase2MaxTimer()
          updateScaleStability({ scale, orAbove: scaleOrAbove })
        } else if (eewNoForecastReason(event) !== 'unknown') {
          clearPhase2MaxTimer()
          confirmScale({ scale: 0, orAbove: false })
        } else if (!eewTtsMaxTimersRef.current.has(key)) {
          // 予想震度がまだ無く、付かない理由も判らない。値が付いた続報で安定待ちへ回すが、
          // 最後まで付かないこともあるため上限で打ち切り、「予想震度なし」で確定する。
          // 続報のたびに二重に張らないよう、既に動いていなければ新規に張る。
          //
          // **直前の続報までは scale>0 だった場合の後始末。** 一度 areas が付いた後の続報で
          // 再び scale=0（かつ理由不明）に戻ると、この分岐に初めて落ちる。ここで
          // 進行中の震度の安定待ちサイクルを明示的に破棄しないと、そちらのタイマーが
          // 生き残ったまま先に発火し、もう存在しないはずの古い震度で確定してしまう
          // （enqueuePhase2 は「上がった時だけ読む」判定のため、後から来る正しい
          // 「予想震度なし」への訂正が黙って弾かれ、誤った値が確定したまま残る）。
          clearScaleStability()
          const maxTimer = setTimeout(() => {
            eewTtsMaxTimersRef.current.delete(key)
            confirmScale({ scale: 0, orAbove: false })
          }, EEW_PHASE2_MAX_WAIT_MS)
          eewTtsMaxTimersRef.current.set(key, maxTimer)
        }
      }

      return
    }

    // 長周期地震動情報（DMDSS版のみ）
    if ((event as unknown as { kind?: string }).kind === 'lpgm') {
      const lpgmEvent = (event as unknown as { kind: string; data: import('../types/earthquake').JMALpgm }).data
      // 読み上げ文を先に作る。長周期は読み上げの範囲設定によって空になり（= 声が出ない）、
      // その場合は追従でタブが動かない。受信時に要求してフォールバックする。
      const isNewLpgm = !seenLpgmEventIdsRef.current.has(lpgmEvent.eventId)
      const lpgmSpeech = settings.voicevoxEnabled
        ? lpgmToText(lpgmEvent, ttsRegionOptions(settings), isNewLpgm)
        : ''
      if (!lpgmSpeech) {
        log.info('[tab] earthquake を要求 (長周期地震動・読み上げ無し)')
        setActiveTabNonRealtime('earthquake')
      }
      if (!lpgmEvent.cancelled) {
        // 紐づく地震カードを選択し、自動的に LPGM 表示をオンにする
        const matchedQuake = earthquakesRef.current.find(q => extractQuakeEventIdFromId(q.id) === lpgmEvent.eventId)
        if (matchedQuake) selectQuake(quakeEventKey(matchedQuake))
        setActiveLpgmEventId(lpgmEvent.eventId)
      }
      if (settings.soundEnabled) {
        playAlertSound('earthquake')
      }
      if (lpgmSpeech) {
        // 主題は地震情報と分ける。内容が別軸（震度と長周期地震動階級）なので、片方が
        // もう片方の言い換えにはならない（割り込みは従来どおり許す）。
        speakNonEEWDelayed(
          lpgmSpeech, SPEECH_PRIORITY.normal, 1000, `lpgm:${lpgmEvent.eventId}`,
          { tab: 'earthquake', priority: TAB_PRIORITY.quake },
        )
      }
      // voicevox 有効/無効に関わらず追跡する（次回の isNewLpgm 判定に使用）
      seenLpgmEventIdsRef.current.add(lpgmEvent.eventId)
      return
    }

    // 南海トラフ関連解説情報（DMDSS版のみ）。臨時情報とは別の帯に出るため、ここでも別扱いにする。
    //
    // **ウィンドウタイトルは書き換えない。** 臨時情報の発表期間中は解説情報が毎日届くため、
    // 書き換えると「南海トラフ臨時情報（巨大地震注意）」のタイトル表示を毎日上書きしてしまう。
    if ((event as unknown as { kind?: string }).kind === 'nankaiCommentary') {
      if (!settings.nankaiCommentaryAlerts) return
      const commentary = (event as unknown as { data: JMANankaiCommentary }).data
      // 帯は地図に重なって出るため、パネルを畳んでいると気づきにくい。いったん開く（戻す判断は App 側）。
      expandPanelForSpecialInfo()
      if (settings.soundEnabled) {
        playAlertSound('specialInfoCommentary')
      }
      // 読み上げは soundEnabled と独立に voicevoxEnabled のみで判定する（AUD-7）。
      if (settings.voicevoxEnabled) {
        // 最下位の専用層を使う（理由は SPEECH_PRIORITY の commentary の注記）。
        // 帯で伝える情報なのでタブは動かさない（パネルの展開は expandPanelForSpecialInfo が担う）。
        speakNonEEWDelayed(
          nankaiCommentaryToText(commentary), SPEECH_PRIORITY.commentary, NANKAI_COMMENTARY_TTS_DELAY_MS,
          'nankaiCommentary',
        )
      }
      return
    }

    // 南海トラフ臨時情報・後発地震注意情報（DMDSS版のみ）
    if ((event as unknown as { kind?: string }).kind === 'nankai' || (event as unknown as { kind?: string }).kind === 'kohatsu') {
      const specialEvent = event as unknown as { kind: string; data: { cancelled?: boolean; kindName?: string } }
      if (!specialEvent.data.cancelled) {
        // 帯は地図に重なって出るため、パネルを畳んでいると気づきにくい。いったん開く（戻す判断は App 側）。
        // 取消・終了では呼ばない（帯が消えるので、開いて見せるものが無い）。
        expandPanelForSpecialInfo()
        if (settings.soundEnabled) {
          playAlertSound('specialInfo')
        }
        // 読み上げは soundEnabled と独立に voicevoxEnabled のみで判定する（AUD-7）。
        if (settings.voicevoxEnabled) {
          const ttsText = specialEvent.kind === 'nankai'
            ? nankaiToText(specialEvent.data as Parameters<typeof nankaiToText>[0])
            : kohatsuToText(specialEvent.data as Parameters<typeof kohatsuToText>[0])
          // 帯で伝える情報なのでタブは動かさない（理由は関連解説情報と同じ）
          // 臨時情報と後発地震注意情報は主題を分ける。どちらも `high` だが互いに言い換えでは
          // ないため、まとめると一方の発表がもう一方を無音のまま消す。
          speakNonEEWDelayed(ttsText, SPEECH_PRIORITY.high, 1500, specialEvent.kind === 'nankai' ? 'nankai' : 'kohatsu')
        }
        // タイトル更新
        const specialTitle = specialEvent.kind === 'nankai'
          ? `南海トラフ臨時情報（${specialEvent.data.kindName ?? '発表中'}）`
          : '後発地震注意情報 発表中'
        title.setTitle(specialTitle)
        title.scheduleTitleRevert('specialInfo')
      } else {
        // 取消・終了時はタイマーをクリアして即時リセット
        title.clearTitleTimer('specialInfo')
        title.applyPriority()
        if (specialEvent.kind === 'nankai' && settings.voicevoxEnabled) {
          // 取消・終了も発表と同じ主題で予約する（間は置かない）。**主題を渡さないと到来順の枠に
          // 載らず**、発表の予約が待っている最中に取消が届いても取り下げられない
          // （取り消されたはずの臨時情報を、そのあと読み上げてしまう）。
          speakNonEEWDelayed(
            nankaiToText(specialEvent.data as Parameters<typeof nankaiToText>[0]),
            SPEECH_PRIORITY.high, 0, 'nankai',
          )
        }
      }
      return
    }

    // ブラウザ通知（津波）— 音が無効でも送る。
    // 等級を伝えていない電文（区域が空）は通知しない。見出しは等級から決め、本文は区域名を並べる
    // ため、この形の電文では「本文が空の津波注意報」という実態と違う通知になる
    // （`isTsunamiObservationOnly`。観測値の更新そのものは津波タブのカードで伝わる）。
    if (event.kind === 'tsunami' && !event.cancelled && !isTsunamiObservationOnly(event)
      && settings.notifyMinScale >= 0 && settings.notifyTsunami) {
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
        // 等級を伝えていない電文は比較から外す（理由は `isTsunamiObservationOnly`）。
        // 観測値だけが載っているので「更新」の扱いにする。
        const obsOnly = isTsunamiObservationOnly(event)
        const gradeUnchanged = obsOnly
          || (prevGradeForSound !== null && GRADE_RANK_SOUND[grade as GradeSoundKey] === GRADE_RANK_SOUND[prevGradeForSound as GradeSoundKey])
        const isDowngradeSound = !obsOnly && prevGradeForSound !== null && GRADE_RANK_SOUND[grade as GradeSoundKey] < GRADE_RANK_SOUND[prevGradeForSound as GradeSoundKey]
        // 読み上げの優先度・主題もこの判定に従う（宣言箇所に理由）。**引き下げは入らない**——
        // `isDowngradeSound` は `gradeUnchanged` と排他なので（等級が動いていない報と、下がった報）、
        // ここで除く必要はない。引き下げは等級が動いた報として新規・格上げと同じ重さで扱う
        // （音だけは同じ更新音を鳴らす）。
        tsunamiIsObservationUpdate = gradeUnchanged
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
    if (!type) {
      // 音の種別が決まらない電文。津波では「区域はあるのに等級がすべて Unknown」という
      // 異常な形だけが残る（区域が空の観測情報のみ電文は上で更新扱いにしている）。
      // 読み上げもここでは起きないため、新規発報・格上げなら受信時要求へ落とす。
      // 落とさないと tsunami タブへ一度も移らない。
      if (settings.voicevoxEnabled && tsunamiIsNewOrUpgraded) {
        log.info('[tab] tsunami を要求 (新規発報・読み上げなし)')
        setActiveTabNonRealtime('tsunami')
      }
      return
    }
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
        // 大津波警報を上昇サイレンへ作り変えて音が 3.73 → 1.94 秒に詰まったため、他の津波と
        // 同じ基準（音の終わり ＋ 0.3〜0.4 秒）へ揃えた。音の終わりは 1.94 秒。
        // **最も急を要する警報なので、余った待ち時間はそのまま読み上げの遅れになる。**
        tsunamiMajor:     2300,
        tsunamiUpdate:     800,
      }
      let ttsText: string | null = null
      // 読み上げ文は断片列でも作る。**用途は種別で違う。**
      //   津波 … カードを読み上げに追従させる（どの語がどの区域・観測点を指すか。`ttsFollow`）
      //   地震 … 続報の差分の基準になる「声になった内容」を記録する
      // 地震は追従の対象を持たないため、画面が動くことはない（`hasFollowTarget` が false）。
      let ttsSegments: SpeechSegment[] | null = null
      // 声になった内容を書き戻す先（地震情報のときだけ立つ）。
      let quakeSpokenState: QuakeSpokenState | null = null
      // 読み上げ文に含めた観測点。**発話を始める瞬間に既読へ移す**（`spokenObsHeightRef`）。
      // 受信時に移すと、待たされて鳴らなかった観測値まで既読になり二度と読まれない。
      let spokenObs: import('../types/earthquake').TsunamiObservation[] | null = null
      if (event.kind === 'quake' && !event.cancelled) {
        // **続報は変化したところだけを読む。** 基準は受信内容ではなく「声になった内容」で、
        // その更新は読み上げの完了時（下の `onSpokenRefs`）に行う。受信時に更新すると、
        // 割り込みで鳴らなかった地域が既読になり、二度と読まれない。
        quakeSpokenState = quakeSpokenStateFor(spokenQuakeStatesRef.current, quakeSpeechTopic)
        // **その地震で最初の確定情報だけは地域を通しで読む。** 速報を細切れに聞いた耳へ、
        // 確定した観測を 1 度だけまとめて示すため（理由は `earthquakeToSegments` の引数）。
        const readAllRegions = isAuthoritativeQuakeReport(event)
          && !authoritativeReadQuakesRef.current.has(quakeSpeechTopic)
        if (readAllRegions) {
          if (authoritativeReadQuakesRef.current.size >= SPOKEN_QUAKE_STATES_MAX) {
            log.debug(`[quake] 確定情報の通し読みの記憶が上限に達したため捨てた (${authoritativeReadQuakesRef.current.size} 件)`)
            authoritativeReadQuakesRef.current.clear()
          }
          authoritativeReadQuakesRef.current.add(quakeSpeechTopic)
        }
        ttsSegments = earthquakeToSegments(event, ttsRegionOptions(settings), isNewQuake, quakeSpokenState, readAllRegions)
        ttsText = joinSegments(ttsSegments)
      } else if (event.kind === 'tsunami') {
        /**
         * 観測点の読み上げ順を引くための「カードが描いている区域」。
         *
         * **電文の `areas` だけでは足りない。** 観測情報の続報は区域を持たずに届くため
         * （`isTsunamiObservationOnly`）、それを渡すと並べ替えが何もしない。カードは前の発表の
         * 区域を出したまま観測点をその下に足していくので、画面が出している津波の区域を使う。
         */
        const areasForCardOrder = (e: JMATsunami): TsunamiArea[] =>
          e.areas.length > 0 ? e.areas : (tsunamisRef.current[0]?.areas ?? [])
        /**
         * 今回の電文が運んできた観測点を、**カードの並び**で返す。
         *
         * 並べ替えにはカードが持つ観測点の全体（マージ済み）を渡す。今回の分だけで並べると、
         * 既報の観測点を載せない続報で「観測を持たない区域」として後ろへ回り、カードの並びと
         * 逆転する（`sortObservationsForCardDisplay` の宣言箇所）。並びを得たあと、今回の分だけを
         * オブジェクトの同一性で絞り込む（マージは今回の要素をそのまま持つ）。
         *
         * **既知の限界**: `tsunamisRef` は App のレンダーで代入されるため、キューのディスパッチャが
         * 1 tick で津波電文を 2 件以上さばいたときは 2 件目がバッチ前の値を見る。並びがカードと
         * 1 件分ずれるだけで、読み上げる観測点も新旧の言い分けも変わらない（言い分けの基準は
         * `spokenObsHeightRef`）。ここを埋めるにはマージ済み観測点をこのフックでも持つことになり、
         * 解除・リプレイ復元での落とし忘れという別種の穴を増やすので採らない。
         */
        const observationsInCardOrder = (e: JMATsunami): TsunamiObservation[] => {
          const own = e.observations ?? []
          if (own.length === 0) return []
          const areas = areasForCardOrder(e)
          // 基準が引けないと電文順のまま読む。**黙って落ちないよう記録する** ―― カードの並びと
          // 食い違えば追従スクロールが往復するので、往復を見たときに原因を辿れるようにする。
          if (areas.length === 0) log.info('[tsunami] 観測点の並びの基準となる区域が無い（電文順で読み上げる）')
          const merged = mergeTsunamiObservations(tsunamisRef.current[0]?.observations, own) ?? own
          const ownSet = new Set(own)
          return sortObservationsForCardDisplay(merged, areas).filter(o => ownSet.has(o))
        }
        const GRADE_RANK = { MajorWarning: 4, Warning: 3, Watch: 2, Forecast: 1, Unknown: 0 } as const
        type GradeKey = keyof typeof GRADE_RANK
        const currentGrade = tsunamiMaxGrade(event)
        const prevGrade = lastTsunamiGradeRef.current

        // 等級が動いていない続報（区域が空の電文を含む）は観測点更新として扱う。降格の側へ流すと、
        // 警報の発表中に全解除の文言を読み上げる（理由は `isTsunamiObservationOnly`）。
        // 判定は音の種別と共有する（`tsunamiIsObservationUpdate` の宣言箇所）。
        if (tsunamiIsObservationUpdate) {
          // グレード不変: 観測点ごとに最大波高を追跡し、更新があった観測点のみ読み上げ。
          // 比較の基準は**読み上げた値**（`spokenObsHeightRef`）で、受信値ではない（宣言箇所に理由）。
          const prevMap = spokenObsHeightRef.current
          // **カードの並びに揃えてから渡す。** 読み上げの順は渡した並びがそのまま使われる。
          // 電文順のままだとカード上を飛び回り、追従スクロールが上下に往復する
          // （→ docs/spec/tsunami-spec.md §9）。
          const obsInCardOrder = observationsInCardOrder(event)
          const updatedObs = obsInCardOrder.filter(o => {
            if (!o.height) return false
            const prev = prevMap.get(o.name)
            if (prev === undefined) return true
            if (o.height.value > prev.value) return true
            // 同値でも over フラグへの昇格（センサー上限超過）は読み上げ対象
            if (o.height.over && !prev.over && o.height.value >= prev.value) return true
            return false
          })
          // 波高未確定（観測中）のまま新規に到達が確認された観測点は「到達確認」として読み上げる
          const newlyArrivedObs = obsInCardOrder
            .filter(o => !o.height && !spokenObsNamesRef.current.has(o.name))
          // 第 4 引数の `prevMap` が「新たに」と「更新」の言い分けを決める（読み上げ用の記憶を
          // 渡すこと。理由は `SpokenHeightLookup` の宣言箇所）。件数上限は既定のままなので
          // 第 3 引数は省略の意で undefined を渡す。
          const updateSegments = updatedObs.length > 0
            ? tsunamiObservationUpdateToSegments(updatedObs, event.headline, undefined, prevMap)
            : []
          const arrivalSegments = tsunamiArrivalToSegments(newlyArrivedObs)
          if (updateSegments.length > 0) {
            ttsSegments = [...updateSegments, ...arrivalSegments]
          } else if (arrivalSegments.length > 0) {
            ttsSegments = [plain('津波観測情報。'), ...arrivalSegments]
          }
          // **既読にするのは実際に読み上げた分だけ。** 更新点は件数上限で絞られるため、
          // `updatedObs` を丸ごと既読にすると、読まれなかった観測点の値が二度と読まれない
          // （絞り込みは読み上げ文の生成と同じ関数を使う）。
          if (ttsSegments) {
            // 到達確認も件数上限で落ちる。**落ちた分を既読にしてはいけない**（絞り込みは
            // 読み上げ文の生成と同じ関数を使う。理由は `selectArrivalsToSpeak` の宣言箇所）。
            spokenObs = [...selectObservationUpdatesToSpeak(updatedObs), ...selectArrivalsToSpeak(newlyArrivedObs)]
          }
        } else {
          const isDowngrade = prevGrade !== null && GRADE_RANK[currentGrade as GradeKey] < GRADE_RANK[prevGrade as GradeKey]
          ttsSegments = isDowngrade ? tsunamiDowngradeToSegments(event) : tsunamiToSegments(event)
          // グレード変化と同時に観測中（波高未確定）で新規到達した観測点も読み上げに含める
          // （こちらもカードの並びに揃える。理由は観測点更新側と同じ）
          const newlyArrivedObsOnGradeChange = observationsInCardOrder(event)
            .filter(o => !o.height && !spokenObsNamesRef.current.has(o.name))
          ttsSegments = [...ttsSegments, ...tsunamiArrivalToSegments(newlyArrivedObsOnGradeChange)]
          // **等級の発表では観測点の実測値を読まない。** 読むのは区域の予想波高
          // （`tsunamiToSegments` → `areaHeightSentence`）で、観測点は区域の並べ替えにしか
          // 使わない。ここで観測点を既読にすると、一度も声に出していない実測値が既読になり、
          // 直後の観測情報で読まれなくなる。既読にするのは到達確認だけ。
          spokenObs = selectArrivalsToSpeak(newlyArrivedObsOnGradeChange)
        }
        if (ttsSegments) ttsText = joinSegments(ttsSegments)
      }
      if (ttsText && type) {
        // 読み上げに同調して画面を合わせる。津波は観測点更新（grade 不変）でもここを通るため、
        // 読み上げが発生する続報だけが tsunami タブを持ち出す（変化のない続報は ttsText が空）。
        const followTab: Exclude<TabId, 'realtime'> = event.kind === 'tsunami' ? 'tsunami' : 'earthquake'
        // 津波は**等級が動いた報と観測情報で格と主題が変わる**。観測情報を `high` で読むと、
        // 観測点の波高が 1 つ更新されるたびに地震情報の読み上げを途中で消す。格を下げるだけでは
        // 向きが変わるだけなので（同格は待たずに割り込む）、主題を分けて相互譲りに載せている
        // （`MUTUAL_YIELD_TOPICS`・`tsunamiIsObservationUpdate`）。
        const speechPriority = event.kind === 'tsunami' && !tsunamiIsObservationUpdate
          ? SPEECH_PRIORITY.high
          : SPEECH_PRIORITY.normal
        const speechTopic: SpeechTopic = event.kind !== 'tsunami'
          ? quakeSpeechTopic
          : tsunamiIsObservationUpdate ? 'tsunamiObs' : 'tsunami'
        // クロージャで掴むため const に写す（`let` のままでは絞り込みが効かない）
        const obsToMark = spokenObs
        const spokenState = quakeSpokenState
        speakNonEEWDelayed(
          ttsText,
          speechPriority,
          TTS_DELAY_MS[type] ?? 0,
          speechTopic,
          { tab: followTab, priority: event.kind === 'tsunami' ? TAB_PRIORITY.tsunami : TAB_PRIORITY.quake },
          ttsSegments ?? undefined,
          // 地震情報は**読み終えたあと**に、実際に声になった分だけを記録する。
          spokenState ? refs => applySpokenRefs(spokenState, refs) : undefined,
          // 読み上げた観測点を既読へ移すのは**声に出す瞬間**（宣言は `spokenObsHeightRef`）。
          // 待たされた末に見送られた分は既読にならず、次の電文でもう一度読み上げ対象に入る。
          obsToMark
            ? () => rememberObservations(obsToMark, spokenObsNamesRef.current, spokenObsHeightRef.current)
            : undefined,
        )
      } else if (event.kind === 'tsunami' && tsunamiIsNewOrUpgraded) {
        // 読み上げ文が組めなかった津波の新規発報・格上げ（保険。理由は宣言箇所）
        log.info('[tab] tsunami を要求 (新規発報・読み上げ文なし)')
        setActiveTabNonRealtime('tsunami')
      } else if (event.kind === 'quake' && !event.cancelled) {
        // **現状は到達しない。** 地震情報は変化が無い続報でも名乗りだけは読むため、読み上げ文が
        // 空にならない（`earthquakeToSegments`）。タブ移動は読み上げ追従が担う。
        // 残してあるのは、将来 `earthquakeToSegments` が空を返すようになったときの受け皿として。
        // 落とすと earthquake タブへ永久に移らない（カードと地図だけが更新される）。
        log.info('[tab] earthquake を要求 (読み上げ文なし)')
        setActiveTabNonRealtime('earthquake')
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

      // 等級を伝えていない電文（区域が空）も観測点更新として扱う。読み上げ側と同じ判定に
      // 揃えること。片方だけずらすと「読み上げはするのに画面が動かない」が生まれる。
      if (isTsunamiObservationOnly(event)
        || (prevGrade552 !== null && GRADE_RANK_552[grade as GradeKey552] === GRADE_RANK_552[prevGrade552 as GradeKey552])) {
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
          // **読み上げが無い端末のタブ移動もここで出す。** 観測が動いたかどうかを知る判定は
          // ここにしかないため（読み上げが有効なら、同じ契機で TTS ブロックの追従が動くので
          // ここでは呼ばない）。変化のない再送では下の else 節へ行くので画面も動かない。
          // 新規発報・格上げは UI ブロックが既に要求しているので、ここでは出さない
          // （同じタブ・同じ優先度で無害だが、ログが二重になって経路を追いにくくなる）。
          if (!settings.voicevoxEnabled && !tsunamiIsNewOrUpgraded) {
            log.info('[tab] tsunami を要求 (観測点更新・読み上げ無効)')
            setActiveTabNonRealtime('tsunami')
          }
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

      // 画面用の記憶だけをここで進める。読み上げ用（`spokenObsHeightRef`）は発話を始める瞬間まで
      // 待つ（受信時に進めると、鳴らなかった観測値まで既読になり二度と読まれない）。
      rememberObservations(event.observations ?? [], seenObsNamesRef.current, lastMaxObsHeightRef.current)
    }
  }

  // EEW 読み上げタイマーと観測点ステータス自動消去タイマーをアンマウント時にクリーンアップする
  useEffect(() => {
    return () => {
      for (const timer of eewTtsMaxTimersRef.current.values()) clearTimeout(timer)
      for (const cycle of eewScaleStabilityRef.current.values()) clearTimeout(cycle.timer)
      for (const cycle of eewLpgmStabilityRef.current.values()) clearTimeout(cycle.timer)
      eewSpeechPendingRef.current = 0
      activeNonEewSpeechRef.current = null
      latestScheduledSeqByTopicRef.current.clear()
      window.clearTimeout(obsStatusClearTimerRef.current)
      // 間を置いている最中の読み上げも捨てる（`resetTracking` と対称）
      cancelPendingSpeech()
    }
  }, [cancelPendingSpeech])

  // リプレイ開始・終了時に追跡 ref を初期化する。
  // handleStartReplay の useCallback deps を壊さないよう参照を安定させる
  // （deps に取るのは呼び出し側で安定させてあるものだけ）。
  const resetTracking = useCallback(() => {
    seenQuakeReportKeysRef.current.clear()
    spokenQuakeStatesRef.current.clear()
    authoritativeReadQuakesRef.current.clear()
    activeEEWLevelsRef.current.clear()
    spokenEEWScalesRef.current.clear()
    spokenEEWLpgmClassesRef.current.clear()
    spokenEEWLevelsRef.current.clear()
    activeEEWAnnouncedHypocentersRef.current.clear()
    for (const timer of eewTtsMaxTimersRef.current.values()) clearTimeout(timer)
    eewTtsMaxTimersRef.current.clear()
    eewTtsEventsRef.current.clear()
    eewPhase2TokensRef.current.clear()
    for (const cycle of eewScaleStabilityRef.current.values()) clearTimeout(cycle.timer)
    eewScaleStabilityRef.current.clear()
    for (const cycle of eewLpgmStabilityRef.current.values()) clearTimeout(cycle.timer)
    eewLpgmStabilityRef.current.clear()
    eewConfirmedScaleRef.current.clear()
    eewConfirmedLpgmRef.current.clear()
    eewSpeechChainRef.current = Promise.resolve()
    // カウンタも戻す。残したままだとリプレイを切り替えても非 EEW の読み上げが待たされ続ける
    eewSpeechPendingRef.current = 0
    activeNonEewSpeechRef.current = null
    latestScheduledSeqByTopicRef.current.clear()
    eewPhase2DoneRef.current.clear()
    eewRetractedKeysRef.current.clear()
    eewPhase1ProgressRef.current.clear()
    lastTsunamiGradeRef.current = null
    // 解除の照合に使う直前の津波も落とす（残すと、リプレイ後の解除を切替前の津波と照合する）
    lastTsunamiRef.current = null
    lastMaxObsHeightRef.current.clear()
    seenObsNamesRef.current.clear()
    // 読み上げ用の既読も落とす（画面用と対称。残すとリプレイ後の観測情報が「更新なし」になる）
    spokenObsHeightRef.current.clear()
    spokenObsNamesRef.current.clear()
    seenLpgmEventIdsRef.current.clear()
    // 60秒 obs バッジ自動消去タイマーもリプレイ切替時に持ち越さない（アンマウント経路と対称）
    window.clearTimeout(obsStatusClearTimerRef.current)
    obsStatusClearTimerRef.current = 0
    // 間を置いてからの読み上げの予約も捨てる。残すと、リプレイを始めた直後に切り替え前の
    // 電文が読まれる（状態はリセット済みなので待ち合わせにも掛からず、そのまま割り込む）。
    cancelPendingSpeech()
    // カードの追従も打ち切る。**鳴っている読み上げはここでは止まらない**ので、追従だけを
    // 残すと、切り替え前の読み上げの進行に合わせて新しく表示されたカードを動かし続ける
    // （区域名や観測点名が新旧で重なれば、実在する別の行を掴む）。
    speechFollow?.reset()
  }, [cancelPendingSpeech, speechFollow])

  // pre-window イベントから T 時点の追跡 ref を復元する（サイレント注入後の正確な音判定に必要）
  const restorePreWindowTracking = useCallback((preFiltered: ReplayEntry[]) => {
    for (const { payload } of preFiltered) {
      if (payload.kind === 'event') {
        const ev = payload.event
        if (ev.kind === 'quake') {
          // ライブ経路（上の handleLiveEvent）と同じキーの組み立て方にそろえる。
          // なおこの復元は DMDATA archive の再生専用で、standard 版からは呼ばれない
          // （`App.tsx` が onStartReplay を isDmdss のときだけ配線している）。
          //
          // **「声にした内容」（`spokenQuakeStatesRef`）は復元しない。意図的。** 窓の手前の報は
          // 再生されておらず、聞き手は一度も聞いていない。既読として積むと、再生開始直後の
          // 続報が「聞いたことのない地域」を省いて読む。復元しない結果その報は全文で読まれるが、
          // それが窓から聞き始めた人にとって正しい（冒頭は「更新されました」になる）。
          markQuakeReportSeen(seenQuakeReportKeysRef.current, newQuakeTrackingKey(ev as JMAQuake))
        } else if (ev.kind === 'eew') {
          const eew = ev as EEWAlert
          const key = eew.issue?.eventId ?? eew.id
          const restoredLevel = computeSingleEEWLevel(eew)
          activeEEWLevelsRef.current.set(key, restoredLevel)
          spokenEEWScalesRef.current.set(key, eewMaxScaleInfo(eew))
          spokenEEWLpgmClassesRef.current.set(key, eewMaxLpgmClass(eew))
          // 区分も復元する。落とすと注入後の最初の続報で「警報。」が付き直し、
          // 途中から再生を始めた地震がその場で警報化したように聞こえる。
          spokenEEWLevelsRef.current.set(key, restoredLevel)
          // T 時点までの報は既に発表済みとして扱う。第2フェーズも発話済みにしておかないと、
          // 注入後の続報が読み直され、途中から再生を始めた地震が初報のように聞こえる
          eewPhase2DoneRef.current.add(key)
          // 安定待ちの確定値も復元する。復元しないと注入後最初の続報の跳躍幅計算が
          // 「自分自身」を基準にしてしまい（跳躍0扱い）、実際より短い安定待ちになる。
          eewConfirmedScaleRef.current.set(key, eewMaxScaleInfo(eew))
          eewConfirmedLpgmRef.current.set(key, eewMaxLpgmClass(eew))
        } else if (ev.kind === 'tsunami') {
          const tsunami = ev as JMATsunami
          // **ライブ経路と同じ形で進めること**（電文は時系列順に渡ってくる）。片方だけずらすと、
          // リプレイを途中から始めたときだけ「解除で終わった津波の観測点が既読のまま残る」
          // （＝次の津波で到達を伝えられない）という、ライブでは起きない食い違いになる。
          if (tsunami.cancelled) {
            lastTsunamiGradeRef.current = null
            lastTsunamiRef.current = null
            lastMaxObsHeightRef.current.clear()
            seenObsNamesRef.current.clear()
            spokenObsHeightRef.current.clear()
            spokenObsNamesRef.current.clear()
          } else {
            const grade = tsunamiMaxGrade(tsunami)
            if (grade !== 'Unknown') lastTsunamiGradeRef.current = grade
            lastTsunamiRef.current = tsunami
            // T 時点までの観測点は「もう伝えた」ものとして扱う。**読み上げ用も埋めること。**
            // 埋め忘れると、注入後の最初の観測情報でそれまでの全観測点が読み直され、途中から
            // 再生を始めたのに津波の到達をいまさら読み上げることになる。
            rememberObservations(tsunami.observations ?? [], seenObsNamesRef.current, lastMaxObsHeightRef.current)
            rememberObservations(tsunami.observations ?? [], spokenObsNamesRef.current, spokenObsHeightRef.current)
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
