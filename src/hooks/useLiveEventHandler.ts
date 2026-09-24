import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppEvent, ExtraLiveEvent, LiveEvent, LiveEventMeta, EEWAlert, Hypocenter, JMAQuake, JMATsunami, TsunamiArea, TsunamiObservation, TsunamiGrade } from '../types/earthquake'
import type { TabId } from '../components/IconNav'
import type { AppSettings } from './useSettings'
import type { AlertTitleApi } from './useAlertTitle'
import type { ReplayEntry, ReplayPayload } from '../types/replay'
import { getIntensityLabelWithOrAbove, getIntensityLabelWithApproxAbove } from '../utils/intensity'
import { isMaxScaleUnreceived } from '../utils/quakePoints'
import { formatMagnitudeWithCondition } from '../utils/formatters'
import {
  eewMaxScaleInfo, isForecastScaleHigher, isForecastLpgmHigher, eewNoForecastReason, computeSingleEEWLevel, canPresentLpgmClass,
  selectEEWSoundType, eewKindLabel, eewPhase2ScaleStabilityMs, sortEewWarningRegions,
  EEW_PHASE2_STABILITY_MAX_WAIT_MS, EEW_PHASE2_LPGM_STABILITY_MS, eewMaxLpgmClassInfo,
  isUnannouncedHypocenter, eewEventKey,
  type EewMaxScaleInfo, type EewMaxLpgmClassInfo, type AnnouncedHypocenter,
} from '../utils/eew'
import { hasKnownEpicenter } from '../utils/geo'
import { showBrowserNotification } from '../utils/notifications'
import { GRADE_PRIORITY, TSUNAMI_GRADE_LIFTED, isWarningLevelWhileObserving, tsunamiMaxGrade, tsunamiAreaGradeChanges, selectUnspokenAreaGradeChanges, rememberAreaGrades, tsunamiAreaKey, isTsunamiNewFire, isTsunamiGradeUpgrade, isTsunamiObservationOnly, isCancelForCurrentTsunami, isTsunamiContinuation, matchesArea, sortAreasAcrossGradesForCardDisplay, sortObservationsForCardDisplay, mergeTsunamiObservations, isObservationMissing, hasMaxHeightTimeAdvanced, hasObservedHeightRisen, firstWaveSpokenKey, changedObservationFields, type ObsUpdateMark, isTideReport, tideReportChange, rememberTideEntries, type SpokenTideEntry } from '../utils/tsunami'
import { playAlertSound, ttsDelayFor, maxTtsDelay, type AlertSoundType } from '../utils/alertSound'
import { speakWithVoicevox, prewarmVoicevox, getSpeechClock, stopSpeech, isAudioPlaying, type PrewarmedSpeech, type ShouldStillPlay, type SpeechOutcome } from '../utils/voicevox'
import { rollbackSpokenEntry } from '../utils/rollbackSpoken'
import { eewAlertToText, eewIntensityText, eewLpgmOnlyText, eewWarningRegionsText, eewCancelToText, earthquakeToSegments, earthquakeCancelToText, tsunamiToSegments, tsunamiDowngradeToSegments, tsunamiAreaGradeChangeToSegments, tsunamiCancelToText, tsunamiObservationUpdateToSegments, selectObservationUpdatesToSpeak, tsunamiArrivalToSegments, selectArrivalsToSpeak, tsunamiMissingToSegments, selectMissingToSpeak, tsunamiWarningLevelToSegments, selectWarningLevelToSpeak, joinWithAlso, nankaiToText, nankaiCommentaryToText, kohatsuToText, earthquakeCountToText, estimatedIntensityToText, lpgmToText, telegramTextToSpeak, createQuakeSpokenState, applySpokenRefs, tsunamiTideToSegments, tsunamiMaxHeightTimeToSegments, selectMaxHeightTimeUpdatesToSpeak, tsunamiFirstWaveToSegments, selectFirstWaveUpdatesToSpeak, tsunamiObservationNoChangeSegments, type TtsSpeechOptions, type QuakeSpokenState } from '../utils/ttsText'
import { type EewSpeakingCardFollow } from './useEewSpeakingCard'
import { joinSegments, plain, hasFollowTarget, hasUnreceivedFollowTarget, hasTelegramTextFollowTarget, hasBorrowedHypocenterFollowTarget, TELEGRAM_TEXT_OPEN_TARGET_KINDS, telegramTextSubject, mapChunksToRefs, spokenChunkIndices, type SpeechFollowApi, type SpeechSegment, type SpeechRef } from '../utils/ttsFollow'
import { log, createLogThrottle } from '../utils/logger'
import { TAB_PRIORITY, type TabPriority } from '../utils/tabPriority'
import { extractQuakeEventIdFromId, mergeQuakeInto, quakeEventKey, quakeKeyForLpgmEventId, sameQuakeEntry } from '../utils/quakeMerge'

import { getAreaPrefIndexCache } from '../utils/stationCoords'

// EEW 読み上げ第 2 フェーズ（予想値）のタイミング。
// 初報で予想震度が付いておらず、かつ**付かない理由がはっきりしない**場合に待つ上限。
// 仮定震源要素・深発地震はその報に予想震度が載らないと判っているので待たない
// （判定は eewNoForecastReason）。ここで待つのは「値が遅れて付くかもしれない」場合だけなので、
// 上限は短く取る。長く取ると、結局は理由不明の「予想震度なし」を読むまで無言になる。
const EEW_PHASE2_MAX_WAIT_MS = 3000
// 直列化した EEW 読み上げで、発話の完了を待つ上限。VOICEVOX への合成リクエストには
// タイムアウトが無いため、応答が返らないまま待ち続けると後続の EEW が永久に読まれなくなる。
// 打ち切って次へ進む（止まっていた側は次の発話開始時に abort される）。
export const EEW_SPEECH_CHAIN_MAX_WAIT_MS = 8000

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
   * **何も切らないものを置く層。** 待ちきれなければ割り込まずに黙る（`speakNonEEW`）。
   *
   * ここにいるのは 3 つ。
   *
   * - **南海トラフ関連解説情報** ―― 段階の発表ではなく状況の解説で、臨時情報の発表期間中は
   *   毎日届く。地震情報と同格にすると数千文字に達しうる地震情報の読み上げを毎日切り、
   *   長周期と同格にすると長周期の実測値を切る。**どこかと同格にすれば必ず何かを切る**
   *   （割り込みの判定は「自分より高い優先度が読み上げ中か」の厳密不等号なので、同格どうしは
   *   待たずに割り込む）ため、切らない側へ降ろした
   * - **気象庁が書いた文**（本文・付加文） ―― 南海トラフ臨時情報の本文は読み上げ 3 分に達する
   *   （→ `speakTelegramText`）
   * - **変化を伝えない津波の続報** ―― 満潮時刻の報と、観測波高が動かない観測情報
   *   （→ `tsunamiSpeechIsQuiet`）。満潮時刻の報は必ず等級の発表の直後に届くので、上の層に
   *   置くと大津波警報の読み上げを割り込んで切る
   *
   * **「待ちきれなければ黙る」は損失として受け入れている。** 層で「何も切らない」と宣言して
   * いても、待ちの上限（`HIGHER_PRIORITY_SPEECH_MAX_WAIT_MS`）で割り込めばその宣言は破れる。
   * 各地の震度は読み切りに 2 分近く達するため、これは実際に起こりうる経路。どれも定型文か
   * 「変わりはありません」なので、諦めて一度読まないことの損失は小さい。
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
  /**
   * 気象庁が書いた文（本文・付加文）の読み上げ。→ `telegramTextToSpeak`
   *
   * **電文本体と別の主題にしてある。** 同じ主題にすると、到来順の裁き
   * （`overtakenByLaterArrival`）が本体の予約を「後発に追い越された」として取り下げ、
   * 本文を読むために肝心の震度・等級を落とすことになる。
   */
  | `telegramText:${string}`
  | 'tsunami' | 'tsunamiObs' | 'nankai' | 'kohatsu' | 'nankaiCommentary' | 'earthquakeCount'
  | 'estimatedIntensity'
  /**
   * 各地の満潮時刻・津波到達予想時刻に関する情報。
   *
   * **観測情報（`tsunamiObs`）と分ける。** 同じ主題にすると、到来順の裁き
   * （`overtakenByLaterArrival`）が同じ枠を取り合い、満潮時刻の報が観測波高の予約を
   * 取り下げることになる。中身が別の話なのだから、枠も分ける。
   */
  | 'tsunamiTide'
  /**
   * 観測情報のうち、**変化を伝えない続報**（波高・最大波の時刻・到達確認・欠測・第1波の
   * どれも動いていない報）。
   *
   * **最大波の観測時刻だけが動いた報はここに入らない。** かつては入れていたが、あれは新しい
   * 観測時刻という中身を読む報で、いまは `tsunamiObs` として他の観測情報と同じ層で読む
   * （読み上げるものを持つ報を「何も切らない」層に置く理由が無い）。
   *
   * **`tsunamiObs` と分ける。** こちらは最下位の層（`commentary`）で読むが、あちらは `normal`。
   * 同じ主題に置くと「**同じ主題の中では優先度は常に等しい**」という前提（上の注記）が崩れ、
   * 到来順の裁き（`overtakenByLaterArrival`）が優先度を見ずに先発を取り下げる —— 上位に
   * 待たされている実測の波高更新を、あとから届いた「変わりはありません」が**声にならないまま
   * 握りつぶす**。等級の発表と観測情報を分けたのと同じ理由で、ここも分ける。
   */
  | 'tsunamiObsQuiet'

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
  // 地震回数は地震情報と同格（`normal`）だが、伝える内容が重ならない —— あちらは震度1以上の
  // 1 つの地震、こちらは震度2以下を含む群発の総数。載せないと、群発の最中に届いた回数の情報が
  // 「各地の震度」（読み切りに 2 分近く）の読み上げを毎報切ることになる。
  // 推計震度分布図も同じ理由。地震発生から数分後に届くので「各地の震度」の続報と
  // かち合いやすく、載せないとそちらを切る。伝える内容も重ならない —— あちらは観測した震度、
  // こちらは**その描き方が公式のものへ替わった**という別の事実。
  'tsunami', 'tsunamiObs', 'nankai', 'kohatsu', 'earthquakeCount', 'estimatedIntensity',
])

/**
 * 相互譲りの対象か。
 *
 * **気象庁が書いた文（`telegramText:*`）は種別によらず対象。** 本体が伝えた事実の補足なので、
 * どの主題とも内容が重ならない —— 切ると補足だけが失われる。とくに南海トラフ関連解説情報は
 * 同じ最下位の層にいて読み切りに数分かかるため、待たずに割り込むと両方が中途半端になる。
 *
 * 主題を種別ごとに分けている（`telegramText:${kind}`）ので、集合ではなく接頭辞で判定する。
 * **同主題どうしは呼び出し側で除外済み**（言い換えなので最新に置き換えるのが正しい）。
 */
function isMutualYieldTopic(topic: SpeechTopic): boolean {
  return MUTUAL_YIELD_TOPICS.has(topic) || topic.startsWith('telegramText:')
}

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
export const MUTUAL_YIELD_SPEECH_MAX_WAIT_MS = 180000

/**
 * 気象庁が書いた文を**予約する**までの間（→ `handleLiveEvent`）。
 *
 * **読み上げの発火を遅らせる値ではなく、予約を遅らせる値。** 近接して届く電文（地震情報と
 * 長周期地震動観測情報など）の予約が出そろってから予約することで、到来順の裁きで
 * 取り下げられるのを避ける。本体の間の最大（`maxTtsDelay()`）に余白を足してある。
 */
const TELEGRAM_TEXT_SPEECH_RESERVE_DELAY_MS = maxTtsDelay() + 500

/**
 * 気象庁が書いた文の既読（`spokenTelegramTextRef`）を保つ件数の上限。超えたらまとめて捨てる。
 *
 * **数えるのは本文ではなく「事象 × 文」**（鍵の作り方は `telegramTextSpokenSubject`）。
 * 1 通で最大 29 文（実電文の津波の避難行動の固定付加文）。能登半島地震の 1 日ぶん（付加文を
 * 運ぶ電文 138 通）を通して 158 件で、この深さは十数日ぶんに相当する。
 * 長期セッションで無制限に増えるのを防ぐためだけの歯止めで、捨てた直後は既読の文が読み直される。
 */
const TELEGRAM_TEXT_SPOKEN_MAX = 2000

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

// 津波カードの「今回の受信で何が変わったか」を示す印（観測点の新規/更新バッジと、区域の
// 「〇〇から切り替え」）が消えるまでの時間。
//
// **2 つの印は起点が違うが、長さは揃える。** 観測点の印は津波情報を受けるたびに置き換わるので
// 起点は「最後の受信」、区域の印は等級が動いた報でだけ置き換わるので起点は「その報」。
// 利用者から見ればどちらも「さっき変わったところ」の印で、長さを違える理由が説明できない。
const TSUNAMI_BADGE_TTL_MS = 60000

/**
 * 新規発報で「前値なし」として渡す空の記憶（→ `fieldsOf552`）。
 *
 * 毎回 `new Map()` を作らずに使い回す。**中身を書き換えないこと** —— 読む側
 * （`changedObservationFields`）は `get` しかしないので、共有して差し支えない。
 */
const NO_PREV_HEIGHTS: ReadonlyMap<string, { value: number; over?: boolean }> = new Map()

/** 指定時間だけ待つ（優先度の待ち合わせで、待つ相手の Promise がまだ無いときに使う）。 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * 遠地地震のウィンドウタイトルに付ける規模の句（先頭の空白込み。出せなければ空文字）。
 *
 * 数値が無くても「Ｍ８を超える巨大地震」は出す。**遠地地震はタイトルが規模だけを伝える経路**で、
 * ここで落とすと最大級の地震ほどタイトルが震央地名だけになる。
 */
function magnitudeTitlePart(hypocenter: Hypocenter): string {
  const text = formatMagnitudeWithCondition(hypocenter.magnitude, hypocenter.magnitudeCondition)
  // 「不明」はタイトルに出さない（震央地名だけのほうが短く読める）
  return text === '不明' ? '' : ` ${text}`
}

// 待ちきれずに割り込むことを選んだときの警告。VOICEVOX が無応答だと読み上げごとに起こりうるため
// 間引くが、優先度の高い読み上げを消す判断なので必ず残す（黙って消すと事後に追えない）。
const warnSpeechWaitGiveUp = createLogThrottle(30000)

// 上限に達したあと、音が止むのを待つあいだの見直し間隔。**上限そのものとは別の値**——
// あちらは「無応答をどこで見切るか」で、こちらは「鳴り止んだことにどれだけ早く気づくか」。
// 短くしても待ちは伸びない（鳴っていれば待つだけ）ので、気づきの遅れだけを決める。
const SPEECH_WAIT_RECHECK_MS = 250

// **延長そのものの上限。** 鳴り続けていてもここで打ち切る。
//
// 実在する最長の読み上げ（南海トラフ地震臨時情報の本文・約 3 分）を切らない値を選ぶ。
// **`isSpeaking` の 5 分（`SPEECH_STALE_MS`）には委ねられない** —— あちらの起点は読み上げが
// 始まるたび引き直されるので、群発で読み上げが途切れない間は永久に発火しない。ここは待ち始めを
// 起点に測るので、鳴り続けていても必ず明ける。
export const SPEECH_WAIT_HARD_CAP_MS = 240000

// 鳴っているのに延長の上限で打ち切った記録。**正常系では出ない** —— 実在する最長の読み上げより
// 長く音が続いたということなので、出ていたら読み上げの組み立てか合成の側を疑う。
const warnSpeechWaitHardCap = createLogThrottle(30000)

/**
 * 発話の完了を待つ（上限付き）。EEW の読み上げは 1 本のチェーンで直列化するため、
 * 1 件の遅延が全体を止めないようにする。
 *
 * **直前の発話を待つ側と、発話そのものを待つ側の両方に掛けること。** VOICEVOX への合成
 * リクエストにはタイムアウトが無く、応答が返らないまま止まると、待ち側だけに上限を置いても
 * 「発話が終わった」と数える処理（`eewSpeechPendingRef` の減算）が永久に走らない。
 *
 * **音が出ている間は計時しない。** この上限は「合成が返ってこない」ための保険で、鳴っている
 * 読み上げを切るためのものではない。上限に達しても音が出ていれば、止むまで待つ。
 *
 * 待たずに打ち切っていた頃は、**上限より長い読み上げが必ず途中で切られていた** —— 待ちが
 * 明けた側が発話を始めると、`speakWithVoicevox` は冒頭で鳴っている音を止めるため。
 * 2024-06-03 06:31 の石川県能登では、警報の対象地方 6 つを列挙する文が読み終わる前に
 * 予想値の読み上げが始まっていた。**リプレイで VOICEVOX へ渡る文とその時刻を記録して確かめた**
 * —— 地方の文の最後のチャンクから 6.9 秒で予想値が始まっており、直す前は上限（8 秒）で
 * 叩き切られていた。同じことが非 EEW 側の待ち（`HIGHER_PRIORITY_SPEECH_MAX_WAIT_MS`・
 * 2 分近い「各地の震度」）でも起きる。
 *
 * **見るのは `isAudioPlaying`（音が出ているか）で、`isSpeaking`（読み上げの処理中か）では
 * ない。** あちらは合成待ちでも真を返すので、**合成が無応答でハングしたときにこそ延長が
 * 掛かり、保険が要る場面で保険が効かなくなる**（`isSpeaking` は `speakOnce` を呼ぶ前に
 * 数を増やす）。
 *
 * **延長にも終わりを置く**（`SPEECH_WAIT_HARD_CAP_MS`）。音が鳴り続ける限り待つ形にすると、
 * 待ち始めからの絶対的な上限がどこにも無くなる —— `isSpeaking` の 5 分は起点が引き直される
 * ので群発では発火しない。
 *
 * **ループで呼び直す側は `hardCapFrom` に「待ち始め」を渡すこと。** 既定はこの呼び出しの
 * 開始時刻なので、呼び直すたびに起点も取り直され、絶対上限の意味が消える
 * （`waitForSpeechSlot` は待つ相手が入れ替わるたびに呼び直す）。
 */
export function capSpeechWait<T>(
  p: Promise<T>,
  capMs = EEW_SPEECH_CHAIN_MAX_WAIT_MS,
  hardCapFrom = Date.now(),
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>(resolve => {
    const giveUp = () => {
      const waited = Date.now() - hardCapFrom
      if (isAudioPlaying() && waited < SPEECH_WAIT_HARD_CAP_MS) {
        timer = setTimeout(giveUp, SPEECH_WAIT_RECHECK_MS)
        return
      }
      // 鳴っているのに打ち切るのは異常。黙って切ると事後に追えない
      if (isAudioPlaying()) {
        warnSpeechWaitHardCap(() => log.warn(
          `[tts] 音が鳴り続けたまま ${Math.round(waited / 1000)} 秒に達したため、発話の完了待ちを打ち切りました`,
        ))
      }
      resolve(undefined)
    }
    timer = setTimeout(giveUp, Math.max(0, capMs))
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}


/**
 * 設定から読み上げのオプションを組み立てる。
 *
 * **設定を足したらここへも足すこと。** 読み上げ文を作る関数はこのオブジェクトしか見ないので、
 * ここで拾い漏らすと設定タブの項目が何も効かない（型検査には掛からない ―― `TtsSpeechOptions`
 * の詳細度の項目はすべて省略可で、省略時は従来の挙動になるため）。
 */
export function ttsRegionOptions(settings: AppSettings): TtsSpeechOptions {
  return {
    intensityLevels: settings.ttsIntensityLevels,
    maxRegions: settings.ttsMaxRegions,
    alwaysReadScale: settings.ttsAlwaysReadScale,
    regionTolerance: settings.ttsRegionTolerance,
    unreceivedDetail: settings.ttsUnreceivedDetail,
    readHypocenterDetail: settings.ttsReadHypocenterDetail,
    readEewLpgmClass: settings.ttsReadEewLpgmClass,
    readTelegramText: settings.ttsReadTelegramText,
    telegramTextBlocks: settings.ttsTelegramTextBlocks,
    telegramBoilerplate: settings.ttsTelegramBoilerplate,
    maxObservationPoints: settings.ttsMaxObservationPoints,
  }
}

// 音・タブ切替の「新規地震か続報か」を判定するためのキー。
// 生電文だけから作り、earthquakesRef（統合済みカード）には依存させない。ref は App の
// レンダー本体でしか更新されず、非表示タブの復帰時（setInterval は最大 1 分まで throttle
// される。utils/clock.ts の Page Visibility 対応コメント参照）にキューが一括で捌けると
// 直前の統合結果を含まないため、同じ地震の続報を「新規」と誤判定して音が鳴り直す。
//
// DMDATA は全報が eventId を共有する。P2PQuake は eventId を持たないが、earthquake.time と震源名は
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

/**
 * 窓の手前の電文が運ぶ「気象庁が書いた文」を既読へ入れる（録画モードの復元専用）。
 *
 * **読み上げるときと同じ関数で本文を組むこと。** 別に組むと、設定でブロックを切っている端末で
 * 鍵が食い違い、既読が効かない。
 */
function rememberTelegramTextAsSpoken(payload: ReplayPayload, spoken: Set<string>, opts: TtsSpeechOptions): void {
  // 読み上げの経路（`LiveEvent`）に乗らない 2 種別はここでも対象外。「地震・津波に関するお知らせ」は
  // 流さないと決めた種別で、推計震度分布図は気象庁が書いた文を運ばない（二進電文）。
  if (payload.kind === 'quakeNotice' || payload.kind === 'estimatedIntensity') return
  const event: LiveEvent = payload.kind === 'event' ? payload.event : payload
  const speech = telegramTextToSpeak(event, opts)
  if (!speech) return
  for (const u of speech.units) spoken.add(u.key)
}

/**
 * 窓の手前の地震に、読み上げの主題とマージ後のカードを割り当てる関数を作る（録画モードの復元専用）。
 *
 * **ライブ経路と同じカードを組み立てて、その鍵を使う。** 主題は地震カードの `eventKey` から作られ、
 * その値は最初に処理された報で固定される（`mergeQuakeInto`）。生の電文へ `quakeEventKey` を直に
 * 当てると、識別子を持たない経路（P2PQuake）では `p2p:<地震の時刻>#<その報の id>` になり、
 * **続報のたびに別の鍵**になる。窓の手前に同じ地震の報が 2 通以上あると、2 通目以降の記憶が
 * ライブ経路から参照されない鍵の下へ入り、その報で初めて現れた地域が区間の最初の続報で
 * 読み直される —— この復元が消したかった症状そのものが、standard 版でだけ残る。
 *
 * **突き合わせる相手を自前で最新化しないこと。** 初出の報を握り続けると、`sameQuakeEntry` の
 * 震源名の照合が「片方が空なら矛盾なし」へ倒れて**同じ分の別の地震を吸い込み**、かといって
 * 「空 → 判明」のときだけ差し替える形では訂正報・震源要素更新による**名前の再変更に追随できない**。
 * どちらも「カードがどう育つか」を部分的に真似たことが原因なので、真似ずに `mergeQuakeInto` を
 * そのまま通す。育て方の規律はあちらが単一情報源で、ライブ経路と食い違いようがなくなる。
 *
 * **地震の時刻で束ねる。** `sameQuakeEntry` は時刻の一致を必ず要求するので、束ねても判定は
 * 変わらず、突き合わせる相手が同じ時刻のものだけになる。群発の 24 時間を遡る復元では窓の手前の
 * 地震が数百件になりうるため、総当たりだと二乗で効く。
 *
 * 同じ分に起きた別の地震を分離しきれない限界は残るが、それはライブ経路と同じもの
 * （→ docs/spec/quake-spec.md §6.1）。
 *
 * **ここで組むカードは画面の状態には入らない。** 同じ電文はこのあと `loadReplayEvents` からも
 * 流れてカードになる（そちらが画面に出るもの）。そのため `mergeQuakeInto` が出す診断ログが
 * 同じ報について 2 度出ることがあるが、実害は無い。
 *
 * **返すのはトピック文字列だけでなくマージ後のカードも。** 呼び出し側が既読を積むとき、
 * 生の入電をそのまま使うと据え置き（`quakeHoldBack`）で退けられた報の内容まで「もう声にした」
 * として記録してしまう（このバケットは `mergeQuakeInto` を通しているので据え置き判定を内包して
 * いるが、外へ渡すのがトピック文字列だけだと呼び出し側から見えない）。マージ後のカードを渡せば、
 * 据え置かれた報では変わらない前の内容がそのまま既読になり、退けられた内容は記録されない。
 *
 * **反映しているのは `quakeHoldBack` だけで、取消より前に発表された報（`isRetractedQuakeReport`。
 * ライブ経路の `quakeHeldBack` はこちらも含めた2階建て）は見ていない。** このバケットは
 * 取消の台帳（`quakeRetractionsRef`）を持たないため。窓の手前で「取消 → その取消より前の
 * 時刻の報が遅れて到着」という順序が起きると、この限界の範囲でだけ据え置き判定が甘くなる。
 */
export function createPreWindowQuakeTopics(): (quake: JMAQuake) => { topic: string; card: JMAQuake } {
  const buckets = new Map<string, JMAQuake[]>()
  return (quake: JMAQuake): { topic: string; card: JMAQuake } => {
    const bucket = buckets.get(quake.earthquake.time) ?? []
    const index = bucket.findIndex(card => sameQuakeEntry(card, quake, getAreaPrefIndexCache()))
    if (index >= 0) {
      bucket[index] = mergeQuakeInto(bucket[index], quake)
      return { topic: `quake:${quakeEventKey(bucket[index])}`, card: bucket[index] }
    }
    const card = mergeQuakeInto(undefined, quake)
    bucket.push(card)
    buckets.set(quake.earthquake.time, bucket)
    return { topic: `quake:${quakeEventKey(card)}`, card }
  }
}

/**
 * 窓の手前の地震情報が伝えた地域・震源要素を既読へ入れる（録画モードの復元専用）。
 *
 * **通しで読んだのと同じ形（`readAllRegions`）で断片を組む。** 意図（この報が伝えた全部を
 * 既読にする）がコードから読み取れるようにするため。
 *
 * **同じ地震について何度も呼ばれる**（窓の手前の報を 1 通ずつ舐めるため）。`applySpokenRefs` は
 * 震度が上がったときだけ書き換える単調なマージなので、繰り返し呼んでも最終状態は変わらない。
 *
 * **主題は呼び出し側が決める。** 報ごとに `quakeEventKey` を呼ぶと、識別子を持たない経路
 * （P2PQuake）では報ごとに別の鍵になる（理由は呼び出し側の注記）。
 */
function rememberQuakeSpeechAsSpoken(
  quake: JMAQuake,
  topic: string,
  states: Map<string, QuakeSpokenState>,
  authoritative: Set<string>,
  opts: TtsSpeechOptions,
): void {
  const state = quakeSpokenStateFor(states, topic)
  applySpokenRefs(state, earthquakeToSegments(quake, opts, true, state, true).flatMap(seg => seg.refs))
  if (!isAuthoritativeQuakeReport(quake)) return
  // **既に積んである主題では容量を見ない。** 同じ地震の確定情報は窓の手前に何通もあり、
  // そのたびに判定すると、上限へ届いた後は「積み直すだけ」で記憶が丸ごと消える。
  // ライブ経路も `quakeSpokenStateFor` も「無ければ作る」ときだけ容量を見る。
  if (authoritative.has(topic)) return
  // 上限と捨て方はライブ経路に合わせる（同じ地震の記憶なので歩調を揃える）。**記録も含めて揃える**
  // —— 捨てた事実が残らないと、あとから「なぜあの地震だけ全文で読み直したのか」を追えない。
  // 群発が続いた期間を遡る復元では 1 回で多数を積むので、ここは実際に上限へ届きうる。
  if (authoritative.size >= SPOKEN_QUAKE_STATES_MAX) {
    log.debug(`[quake] 確定情報の通し読みの記憶が上限に達したため捨てた (${authoritative.size} 件)`)
    authoritative.clear()
  }
  authoritative.add(topic)
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

/** カードの並びを引くための材料（→ `tsunamiCardOrderBasis`）。仕様書での呼び方も「材料」で揃えている。 */
interface TsunamiCardOrderBasis {
  /** カードが描いている区域。 */
  areas: TsunamiArea[]
  /** カードが持っている観測点の全体（マージ済み）。 */
  observations: TsunamiObservation[]
}

/**
 * カードの並びを引くための材料を作る ―― カードが描いている区域と、カードが持っている観測点の全体。
 *
 * **受信した電文の値をそのまま使ってはいけない。** 区域は観測情報の続報が持たず
 * （`isTsunamiObservationOnly`）、観測点はどの報も「その報が載せた分」しか持たない。一方カードは
 * 前の発表の区域を出したまま観測点を足していくので、画面が出している津波（`tsunamisRef.current[0]`）と
 * 混ぜて初めてカードと同じ材料になる。
 *
 * 区域の並びは「その区域で最も深刻な実測波高」で決まるため（`sortAreasForCardDisplay`）、
 * 電文の観測点だけで並べると**観測を持たない区域として後ろへ回り、カードと逆転する**。等級を
 * 切り替える報（警報 → 注意報など）は観測点をほとんど載せないので、そこが最も大きくずれる。
 *
 * この材料を渡す先は 4 つあり、どれもカードと並びが食い違うと実害が出る（**増減したら、この数を
 * 書いている他の 2 箇所も直す。** 場所は `tsunami-spec.md` §9 が挙げている）:
 * 読み上げ（追従スクロールがカード上を往復する）・ブラウザ通知の区域（カードの上位と違う区域を
 * 代表として挙げる）・受信時スクロールの送り先（カードの先頭でない区域へ寄る）・区域単位で等級が
 * 動いた報（`tsunamiAreaGradeChanges` が遷移ごとに区域を並べる。**この並びは読み上げと寄せ先の
 * 両方がそのまま使う**ので、前の 3 つとは別に材料を渡す先が 1 つある）。
 * カードのハイライト（`setAreaGradeChangedKeys`）も同じ組から作るが、Set にするため並びに依らない。
 *
 * **引き継ぐ条件はカードと同じ述語（`isTsunamiContinuation`）で判定する。** カードは別の地震の
 * 津波・解除表示中のカードからは値を引き継がず、`eventId` を持たない経路（P2PQuake）では
 * そもそも蓄積しない。ここだけ無条件に混ぜると、**カードに無い観測点で並べ替えた結果**を
 * 上の 4 つが使うことになる。
 *
 * **既知の限界**: `tsunamisRef` は App のレンダーで代入されるため、キューのディスパッチャが
 * 1 tick で津波電文を 2 件以上さばいたときは 2 件目がバッチ前の値を見る。並びがカードと 1 件分
 * ずれるだけで、読み上げる内容も新旧の言い分けも変わらない（言い分けの基準は `spokenObsHeightRef`）。
 */
function tsunamiCardOrderBasis(event: JMATsunami, displayed: JMATsunami | undefined): TsunamiCardOrderBasis {
  const inherited = isTsunamiContinuation(displayed, event) ? displayed : undefined
  return {
    areas: event.areas.length > 0 ? event.areas : (inherited?.areas ?? []),
    observations: mergeTsunamiObservations(inherited?.observations, event.observations ?? []) ?? [],
  }
}

// 波高未確定（観測中）の新規到達観測点しか無いとき、その中でどの区域をスクロール先の
// 先頭にするかを、津波情報カードの実際の表示順（TsunamiGradeCard と同じ並び替え）から決める。
// 電文内の記載順ではなく、画面上で一番上に表示される区域を優先する。
// 引数の区域・観測点は `tsunamiCardOrderBasis` が作ったものを渡すこと（電文の値を直接渡すと
// 並べ替えが空回りし、電文順の先頭へ寄る）。
function pickTopFromCardOrder(
  newlyArrivedObs: { districtCode?: string; districtName?: string }[],
  areas: import('../types/earthquake').TsunamiArea[],
  allObservations: import('../types/earthquake').TsunamiObservation[],
): { code?: string; name?: string } {
  const ordered = sortAreasAcrossGradesForCardDisplay(areas, allObservations)
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
  for (const o of obs) names.add(o.name)
  rememberObservationHeights(obs, heights)
}

/**
 * 画面（バッジ・カードのスクロール・地図のカメラ）用の記憶をまとめて進める。
 *
 * **読み上げ用には使わない。** 最大波の観測時刻の進め方が両者で違う ―― 画面は受信した全観測点を
 * 常に最新へ進めるが、読み上げは**声にした分だけ**進める（待たされた末に見送られた観測点まで
 * 既読にすると、その更新は二度と読まれない）。読み上げ側は `rememberObservations` を呼んだうえで、
 * 時刻を進める観測点を発話の直前に選び直している。
 *
 * 時刻を波高と別の `Map` に持つのは、進め方が違うため。波高は「上がったときだけ」更新する
 * （→ {@link rememberObservationHeights}）ので、混ぜると波高が据え置きの報で時刻だけが取り残される。
 */
function rememberObservationsForDisplay(
  obs: readonly import('../types/earthquake').TsunamiObservation[],
  names: Set<string>,
  heights: Map<string, { value: number; over?: boolean }>,
  maxHeightTimes: Map<string, string>,
  firstWaves: Map<string, string>,
): void {
  rememberObservations(obs, names, heights)
  for (const o of obs) {
    if (o.maxHeightDateTime) maxHeightTimes.set(o.name, o.maxHeightDateTime)
    // 第1波も別の `Map` に持つ（項目ごとの印に使う。→ `ObsUpdateMark`）。
    const firstWave = firstWaveSpokenKey(o)
    if (firstWave) firstWaves.set(o.name, firstWave)
  }
}

/**
 * その報が伝える観測状態の変わり目を、読み上げ用の記憶へ反映する。
 *
 * **ライブ経路（`handleLiveEvent`）とリプレイ復元（`restorePreWindowTracking`）の両方から呼ぶこと。**
 * 記憶は 3 つある（到達確認＝`spokenObsNamesRef` / 波高＝`spokenObsHeightRef` /
 * 欠測＝`spokenObsMissingRef`）が、**遷移の規則を書く場所が 2 つに分かれていたため、
 * 片方だけ更新を足す取りこぼしが繰り返し起きた**。規則はここだけに置く。
 *
 * 落とすのは 2 方向。
 *
 * - **欠測になったら到達確認の記憶を落とす** ―― 観測が復帰して到達が確認できたとき、それは
 *   新しい事実として読む必要がある（落とさないと「もう読んだ」と見なされて黙る）
 * - **復帰したら欠測の記憶を落とす** ―― 同じ観測点が再び欠測になれば、それも新しい事実
 *
 * **遷移を検出しているわけではない。** その報に載っている観測点すべてへ上の 2 つを当てるだけで、
 * 前回からの変化は見ていない（不在のキーを消すのは何もしないのと同じなので、それで足りる）。
 * 電文に載っていない観測点は触らない（その報が何も語っていない状態を勝手に決めない）。
 * **積む側（既読へ入れる）はここに置かない** ―― ライブ経路は発話を始める瞬間に、復元は
 * 窓の手前を読み終えた時点に積むので、契機が違う。
 */
function forgetSpokenOnObservationStateChange(
  obs: readonly import('../types/earthquake').TsunamiObservation[],
  spokenNames: Set<string>,
  spokenMissing: Set<string>,
  spokenWarningLevel: Set<string>,
): void {
  for (const o of obs) {
    if (isObservationMissing(o)) spokenNames.delete(o.name)
    else spokenMissing.delete(o.name)
    // 「観測中のまま津波警報相当」から抜けたら忘れる。数値が出た観測点が後の報でまた
    // その状態へ戻ることは起こりうるので、片道にしない（欠測と同じ考え方）。
    if (!isWarningLevelWhileObserving(o)) spokenWarningLevel.delete(o.name)
  }
}

/**
 * 波高は据え置きのまま、最大波の観測時刻だけが更新されたか。
 *
 * **気象庁が「更新した」と言っているのに、アプリだけが黙っていた形。** 波高の既読判定
 * （{@link hasObservedHeightRisen}）は値が上がったときだけ通すので、同じ高さの波がもう一度
 * 来た報は差分が空になる。判定は電文が直接言っているもの（`MaxHeight/Revise` = 更新）を見る
 * —— 時刻の比較だけで決めると、気象庁が更新と認めていない揺れまで拾う。
 *
 * **波高が上がった観測点は対象外。** そちらは波高の文が読むので、二重に言わない。
 *
 * **欠測の観測点も対象外。** 観測できていない地点に「最大波の観測時刻が更新されました」と
 * 言うと、いま観測できているように聞こえる（欠測の文と同じ切り分け）。
 */
function hasMaxHeightTimeChanged(
  obs: import('../types/earthquake').TsunamiObservation,
  spokenHeights: ReadonlyMap<string, { value: number; over?: boolean }>,
  spokenTimes: ReadonlyMap<string, string>,
): boolean {
  if (!obs.height) return false
  if (isObservationMissing(obs)) return false
  if (hasObservedHeightRisen(obs, spokenHeights)) return false
  // 「電文が更新と言っていて、その時刻がまだ見ていないものか」は画面側と共有する述語で見る
  // （`utils/tsunami.ts`）。ここで重ねている 3 つの条件は読み上げだけの都合。
  return hasMaxHeightTimeAdvanced(obs, spokenTimes.get(obs.name))
}

/**
 * 波高の記憶だけを進める（名前は覚えない）。
 *
 * **欠測の観測点に使う。** 欠測の読み上げは「これまでに◯◯で3.2メートル以上を観測したのち、
 * 欠測となっています」の形で波高を声にするため、波高は既読へ進めるのが正しい（声になった分だけ
 * 記録する規約）。一方**名前を到達確認の記憶（`spokenObsNamesRef`）へ入れてはいけない**——
 * 入れると、観測が復帰して到達が確認できたときに「もう読んだ」と見なされて黙る。
 *
 * **記憶は高水位マーク式**（値が上がったとき・`over` が新しく付いたときだけ進める）。電文の
 * `MaxHeight` は「これまでの最大波」なので下がらないのが常で、下がる報は訂正にあたる。深刻さが
 * 後退したことを「更新」として扱わないための形。
 *
 * **`over` が外れる向きも記録しない。** 地図のカメラ（`utils/tsunami.ts` の
 * `hasObservedHeightChanged`）が向きを問わず拾うのとは**意図的に非対称**で、あちらは「動いたか」、
 * こちらは「深刻になったか」を問う。そのぶん「`over` が外れ、また付く」続報では 2 度目の昇格を
 * 取りこぼすが、その形は実配信で観測していない（→ docs/spec/tsunami-spec.md §6）。
 */
function rememberObservationHeights(
  obs: readonly import('../types/earthquake').TsunamiObservation[],
  heights: Map<string, { value: number; over?: boolean }>,
): void {
  for (const o of obs) {
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
   * 読み上げの進行を画面へ伝える（未入電モードの自動開閉）。
   *
   * **津波の `speechFollow` とは別の枠**にする。あちらの門（`hasFollowTarget`）は津波カードの
   * 行を引ける参照だけを通す作りで、地震情報の参照を混ぜると津波カードが動く。仕組み自体は
   * 同じもの（`createSpeechFollowController`）を 2 本立てて使い分ける。
   *
   * 渡すのは**地震情報の読み上げだけ**。
   */
  unreceivedFollow?: SpeechFollowApi
  /**
   * 気象庁が書いた文を読み上げているあいだ、その表示を開いておくための受け口。
   *
   * **上の 2 つとは別の枠**にする。津波カードの追従は区域・観測点の参照を、未入電モードは
   * 未入電の参照を見ており、どちらも対象が違う（→ `ttsFollow.ts` の門）。
   */
  telegramTextFollow?: SpeechFollowApi
  /**
   * 津波の読み上げが**借りた震源**を語っているあいだ、その原因地震のカードを見せるための受け口。
   *
   * **上の 3 つとは別の枠**にする。ほかは津波カードの行・未入電の一覧・気象庁の文を見ており、
   * どれも対象が違う（→ `ttsFollow.ts` の門）。
   *
   * 渡すのは**津波の読み上げだけ**。震源を借りるのは震源が未確定の地震で、その震源を語るのは
   * 津波を受け取った時点だけだから（→ `utils/borrowFromTsunami.ts`）。
   */
  borrowedHypocenterFollow?: SpeechFollowApi
  /**
   * 緊急地震速報の読み上げが、いまどの地震を語っているかを画面へ伝える受け口。
   *
   * **上の 4 つとは別の仕組み**にする。あちらは読み上げ文の断片（`SpeechSegment`）が持つ参照を
   * 見て範囲を判定するもので、緊急地震速報の読み上げは断片列を通らない（`chainEEWSpeech` は
   * 文字列を 1 本渡すだけ）。ここが必要とするのは対象の eventId だけなので、範囲の判定も
   * rAF も要らない。
   */
  eewSpeakingCard?: EewSpeakingCardFollow
  /**
   * 特別情報（南海トラフ臨時情報・後発地震注意情報・関連解説情報）の受信でパネルを開く。
   *
   * これらは地図に重ねた帯で伝える情報で、パネル側に居場所がない（切り替えるタブが無い）。
   * パネルを畳んで地図だけを見ている状態でも気づけるように開く。元の状態へ戻す判断は App 側。
   */
  expandPanelForSpecialInfo: () => void
  /**
   * 気象庁の推計震度分布図が届いたことを知らせる（地図の分布モードを開く）。
   *
   * **`onLiveEvent` の経路から呼ぶ。** 状態を見る `useEffect` にすると、リプレイの初期状態の
   * 復元（`silent`）でも開いてしまう ―― あれは「いま届いた」ではなく「その時刻に出ていた」の
   * 再現なので、画面を切り替える理由が無い。
   *
   * 戻り値は**分布モードを開けたか**（引き当てる地震カードが無ければ `false`）。記録を残すかは
   * 呼び出し側が決める（理由は実装側の注記）。
   */
  openEstimatedIntensity: (arrivalTime: string, lat: number, lon: number) => boolean
  /**
   * その地震の電文を受けたことを知らせる（開いている震度分布モードを閉じる）。
   *
   * **分布モードは発表値（区域塗り・観測点ドット）を引っ込めるモード**なので、開いたままだと
   * 続報で震度がどこまで変わったのかが地図に現れない。判定と理由は
   * `utils/quakeOverlay.ts` の `closeDistributionOverlayOnQuakeReport`。
   */
  closeDistributionOnQuakeReport: (eventKey: string) => void
  /** 既定タブへ戻す。引数はどの経路から戻そうとしたか（見送りの記録に出る） */
  revertToDefaultTab: (reason: string) => void
  selectQuake: (id: string | null) => void
  /**
   * 長周期地震動観測情報が届いたことを知らせる（地図とカードの階級表示を開く）。
   *
   * **開く／閉じるを両方兼ねさせない。** 追加表示は震度分布モードと排他で、長周期を閉じる
   * 判断は選択中の地震が別の地震へ移ったかどうかに紐づく（→ App 側の `quakeOverlay`）。
   * ここから閉じられるようにすると、その規則が 2 か所に分かれる（震度分布だけは別の理由でも
   * 閉じる。上の `closeDistributionOnQuakeReport`）。
   */
  openLpgmFromQuake: (eventId: string) => void
}

export function useLiveEventHandler(deps: LiveEventHandlerDeps) {
  const {
    settings, title, earthquakesRef, tsunamisRef, kyoshinDetectedRef, defaultTabRef,
    setActiveTabRealtimeForKyoshin, setActiveTabNonRealtime, setActiveTabRealtimeOnUpdate,
    setActiveTabRealtimeUrgent, followSpeechTab, preSpeechTab, speechFollow, unreceivedFollow, telegramTextFollow,
    borrowedHypocenterFollow, eewSpeakingCard,
    expandPanelForSpecialInfo,
    revertToDefaultTab, selectQuake, openLpgmFromQuake, openEstimatedIntensity,
    closeDistributionOnQuakeReport,
  } = deps

  /**
   * 最新の設定。**`useCallback([])` で包んだ関数から読むためだけに持つ**
   * （`restorePreWindowTracking`。あちらは参照を安定させる必要があり、`settings` を直に掴むと
   * 古い値で固まる）。フック本体は毎レンダー走るので、この代入で常に最新へ更新される。
   */
  const settingsRef = useRef(settings)
  settingsRef.current = settings

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
  const spokenEEWLpgmClassesRef = useRef<Map<string, EewMaxLpgmClassInfo>>(new Map())
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
    /**
     * 待っている値。**「程度以上」も一緒に持つ**（`EewMaxLpgmClassInfo`）。
     * 階級の数値だけで比べると、数値が同じで `over` だけ変わる続報を「据え置き」と誤判定し、
     * **その変化が読み上げから無音で消える**（震度側は `orAbove` を比較に含めている）。
     * 「階級3」→「階級3程度以上」は上限が定まらなくなった＝安全側の変化なので落とせない。
     */
    info: EewMaxLpgmClassInfo
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
  const eewConfirmedLpgmRef = useRef<Map<string, EewMaxLpgmClassInfo>>(new Map())
  // 読み上げた区分（0=予報 / 1 以上=警報）。予想震度・階級が据え置きのまま severity だけ
  // 確定する続報があり、値だけを見ていると区分の変化が声に出ない。
  const spokenEEWLevelsRef = useRef<Map<string, 0 | 1 | 2>>(new Map())
  // 直前に読み上げた津波グレード（引き下げ検出・重複読み上げ抑制に使用）
  const lastTsunamiGradeRef = useRef<Exclude<TsunamiGrade, 'Unknown'> | null>(null)
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
  // 震源要素を載せていた直近の津波。震源を持たない地震電文（震度速報）へ貸す
  // （→ `utils/borrowFromTsunami.ts`）。
  //
  // **`lastTsunamiRef` とは別に持つ。** あちらは「直前に受信した津波」で、満潮時刻や観測情報の
  // ように震源を載せない報でも上書きされる。貸せる相手が要るのは震源だけなので、載せていた報を
  // 覚えておく。
  // 観測点ごとに受信済みの最大波高。**画面（バッジ・スクロール）用**で、読み上げの有無に関わらず
  // 受信時に進める。
  const lastMaxObsHeightRef = useRef<Map<string, { value: number; over?: boolean }>>(new Map())
  // 観測点ごとに受信済みの「最大波の観測時刻」。上と同じく画面用で、受信時に進める。
  //
  // **波高の記憶と分けて持つ。** 波高が据え置きのまま気象庁が最大波の時刻だけを進める報が
  // あり（→ `utils/tsunami.ts` の `hasMaxHeightTimeAdvanced`）、その報で画面を動かすには
  // 時刻そのものを覚えておくしかない。読み上げ側が `spokenObsMaxHeightTimeRef` を別に持つのと同じ形。
  const lastMaxObsTimeRef = useRef<Map<string, string>>(new Map())
  /**
   * 観測点ごとに、**画面へ出した第1波の内容**（観測点名 → `firstWaveSpokenKey` の鍵）。
   *
   * カードの項目ごとの印（→ `ObsUpdateMark`）で「第1波が動いた」を判定するために要る。
   * 読み上げ用（`spokenObsFirstWaveRef`）と分けるのは、進め方が違うため —— 画面は受信した
   * 全観測点を常に最新へ進め、読み上げは声にした分だけ進める。
   */
  const lastMaxObsFirstWaveRef = useRef<Map<string, string>>(new Map())
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
  // 欠測を**声にした**観測点名。到達確認（`spokenObsNamesRef`）とは別に持つ。
  //
  // **混ぜてはいけない。** 混ぜると、欠測を読んだ観測点はその後に本当に到達が確認されても
  // 「一度読んだ」と見なされて黙る（逆向きも同じ）。欠測と到達確認は同じ観測点について
  // 別々に起きうる事実なので、記憶も別にする。
  //
  // 欠測から復帰した観測点はここから落とす（同じ観測点が再び欠測になったとき、それは新しい
  // 事実として読む必要がある）。落とす場所は下の津波の分岐。
  const spokenObsMissingRef = useRef<Set<string>>(new Set())
  /**
   * 「観測中のまま津波警報に相当する津波を観測している」と読み上げ済みの観測点。
   *
   * 欠測（`spokenObsMissingRef`）と分ける。**同じ観測点が到達確認としては既読でも、この信号は
   * 後の報で初めて立つ**ため、名前の既読を共有すると一度も声にならない。
   */
  const spokenObsWarningLevelRef = useRef<Set<string>>(new Set())
  /**
   * 観測点ごとに、**最後に声にした最大波の観測時刻**（観測点名 → `MaxHeight/DateTime`）。
   *
   * 波高の記憶（`spokenObsHeightRef`）とは別の軸。波高が据え置きのまま最大波の時刻だけが
   * 動く報があり（気象庁は `MaxHeight/Revise` に「更新」と書いて知らせる）、波高の記憶では
   * それを捉えられない。**同じ観測点について別々に起きうる事実なので、記憶も別にする**
   * （欠測と到達確認を分けているのと同じ理由）。
   */
  const spokenObsMaxHeightTimeRef = useRef<Map<string, string>>(new Map())
  /**
   * 観測点ごとに、**最後に声にした第1波の内容**（観測点名 → 到達時刻と押し引きを繋いだ鍵）。
   *
   * 第1波は点ごとに一度きりの事実なので既読で足りそうに見えるが、**気象庁は訂正する**
   * （`FirstHeight/Revise` = 更新）。2024 年能登半島地震では佐渡市鷲崎の到達時刻が
   * 16時10分 → 16時32分 へ動いた。名前の集合で覚えると、誤った時刻を言ったまま訂正が
   * 届かないので、**内容そのものを鍵にして変化を捉える**（波高の記憶と同じ形）。
   *
   * 鍵に押し引きも含めるのは、時刻が据え置きで押し引きだけが直る形を取りこぼさないため。
   */
  const spokenObsFirstWaveRef = useRef<Map<string, string>>(new Map())
  /**
   * 潮位観測点ごとに、**最後に声にした満潮時刻と到達状況**（→ `tideReportChange`）。
   *
   * 各地の満潮時刻・津波到達予想時刻に関する情報は、等級も観測波高も動かさないまま届く。
   * この記憶が無いと、その報が何を新しく伝えているのかを判定できない。
   */
  const spokenTideRef = useRef<Map<string, SpokenTideEntry>>(new Map())
  // 区域ごとに、等級の変化として**最後に声にした等級**（区域キー → 等級）。
  //
  // 気象庁の `LastKind` は等級が動いた瞬間だけでなく、その後の続報にも同じ値が載り続ける。
  // 記録を持たないと、2 区域の解除を伝える文を続報のたびに読み直す（→ `selectUnspokenAreaGradeChanges`）。
  // 観測点の記憶と同じく**発話を始める瞬間**に進める。読み上げが無効な端末だけは声が出ないため、
  // タブを見せた時点で進める（進めないと続報ごとに画面を奪う）。
  const spokenAreaGradeRef = useRef<Map<string, TsunamiGrade>>(new Map())
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
  const activeNonEewSpeechRef = useRef<{
    priority: SpeechPriority
    topic: SpeechTopic
    done: Promise<SpeechOutcome>
    /**
     * **そこまでに声になった分**を記録へ移す（実体は `speakNonEEW` の `flushSpokenRefs`）。
     * 次の電文の差分を組む前に呼ぶ ―― 呼ばないと、前の報を読み切る前に届いた続報が
     * 「まだ何も声になっていない」状態を基準に差分を組み、先頭から読み直す。
     */
    flushSpoken: () => void
  } | null>(null)
  // 間を置いてからの読み上げの予約（`scheduleSpeech`）。アンマウント・リプレイ切替で取り消す。
  const pendingSpeechRef = useRef<Set<{ id: number; onCancel?: () => void }>>(new Set())
  // 読み上げに振る到来順の連番と、「最後に予約された連番」を主題別・優先度別に持つ枠。
  // **追い越し**を裁くために持つ（`overtakenByLaterArrival` / `overtakenByHeavierArrival`）。
  //
  // **EEW もこの軸に載せる。** EEW は優先度の尺度の外にあるが、「自分の予約より後に届いたか」は
  // 同じ軸でしか比べられない。載せないと、待っている間に届いた EEW を追い越しとして裁けず、
  // 待ち行列の非 EEW が EEW を読み終えた後ろで鳴って到来順が逆に聞こえる。
  //
  // **主題ごとに分けて持つこと。** 単一の枠に「最後に予約されたもの」だけを置くと、主題違いの
  // 予約が枠を奪った隙に同じ主題の後先が比べられなくなり、古い報が新しい報を切れてしまう。
  //
  // 連番はリプレイ切替でも戻さない（意図的）。単調に増えていれば後先の比較は成り立ち、0 へ戻すと
  // 切替前の値と混ざる。取り消しは Map 側の clear で足りる。
  const speechArrivalSeqRef = useRef(0)
  const latestScheduledSeqByTopicRef = useRef<Map<SpeechTopic, number>>(new Map())
  /**
   * 優先度ごとの「最後に予約された連番」。**自分より重い相手に追い越されたか**を見るのに使う
   * （`overtakenByHeavierArrival`）。主題別の枠と分けているのは問いが違うため —— あちらは
   * 「同じ話題の新しい報が来たか」、こちらは「もっと重い話が後から割り込んだか」。
   *
   * 鍵は優先度なので要素数は `SPEECH_PRIORITY` の段数で頭打ちになる（主題別のような上限は要らない）。
   */
  const latestScheduledSeqByPriorityRef = useRef<Map<SpeechPriority, number>>(new Map())
  /**
   * EEW が最後に**新規発報**した到来連番。EEW は優先度の尺度の外なので別に持つ。
   *
   * **進めるのは新規発報のときだけ**（続報・第 2 フェーズ・言い直し・取消では進めない）。
   * その EEW が到来したのは初報の時点であって、あとから続く発話はどれも同じ到来の続きだから。
   * 発話のたびに進めると、**先に届いていた EEW の第 2 フェーズ**（安定待ちの後に鳴る）が
   * 「後から来た重い読み上げ」に見え、順番どおり待っていた地震情報を取り下げてしまう。
   *
   * **リプレイ切替・アンマウントでは戻さない**（意図的。隣の Map 2 つは `clear()` しているので
   * 並びから外れて見えるが、こちらは連番そのもので、単調に増えていれば比較は成り立つ。0 へ
   * 戻すと切替前の値と混ざる）。
   */
  const latestEewSpeechSeqRef = useRef(0)
  const eewPhase2TokensRef = useRef<Map<string, object>>(new Map())
  // 第 1.5 フェーズ（警報の対象地方）で**声にした**地方（eventId 別）。
  //
  // **記録するのは読み切った分だけ。** 途中で降りた発話は入れない —— 降りるのは「地方が増えた
  // から読み直す」ときで、その分を既読にすると読み直しから抜け落ちる。
  //
  // **ただし「読み切った」は「実際に音が出た」ことまでは保証しない。** 合成が 1 チャンクも
  // 成功しなかった場合（VOICEVOX 未起動・瞬断）、`speakWithVoicevox` は例外を投げずに正常
  // 終了するため、ここも通常どおり記録する。第 1・第 2 フェーズが発話の直前に記録するのと
  // 同じ限界で、この経路だけの問題ではない（合成の失敗自体は `[VoiceVox] 音声を 1 つも
  // 合成できなかった` として記録に残る）。
  const spokenEEWRegionsRef = useRef<Map<string, Set<string>>>(new Map())
  // 第 1.5 フェーズの予約を表す識別子（eventId 別）。第 2 フェーズと同じく、解決した時点で
  // 消して次の予約を受け付ける。
  const eewRegionTokensRef = useRef<Map<string, object>>(new Map())
  // 「緊急地震速報に切り替わりました。」を**声にした** eventId。
  //
  // **`spokenEEWLevelsRef` とは別に持つ。** あちらは「予想値を読み直す契機としての区分」で、
  // 第 2 フェーズの発火ゲート（`level <= spokenLevel` なら黙る）を兼ねている。第 1.5 フェーズが
  // 前置きを言ったときにあちらを進めると、格上げを伝えたのと引き換えに**予想値の読み直しごと
  // 止まる** —— 気象庁が警報へ上げた報で「何の震度で警報になったか」が声にならなくなる。
  // 言葉を重ねないことだけをこちらで担い、読み直しの契機はあちらに残す。
  const spokenEEWUpgradePhraseRef = useRef<Set<string>>(new Set())
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
  // 第 1 フェーズの予約は key ごとに 1 件だが、**鳴っている予約と、それへ割り込む言い直しの
  // 予約は一時的に共存する**（予報から警報への言い直しは鳴っている最中にだけ積まれる）。
  // 無条件に消す形にすると、他方が置いた記録まで落として二重読みや誤った割り込みを招く
  // （実際にその穴を 2 度作った）。
  //
  // 「鳴っている」の追跡は完全ではない。発話の完了待ちには上限（`EEW_SPEECH_CHAIN_MAX_WAIT_MS`）
  // があり、VOICEVOX が極端に遅いと**まだ鳴っているのに記録が消える**。そのときは言い直しの
  // 代わりに第 2 フェーズの前置きが伝えるので、区分が声にならない方には倒れない。
  const eewPhase1ProgressRef = useRef<Map<string, EEWPhase1Progress>>(new Map())
  // 第 1 フェーズ（震源の読み上げ）の予約を表す識別子（eventId 別）。第 2 フェーズ・
  // 第 1.5 フェーズと同じく、**key ごとに高々 1 件**。解決した時点で消して次の予約を受け付ける。
  const eewPhase1TokensRef = useRef<Map<string, object>>(new Map())
  // EEW の eventId ごとに、第 1 フェーズで**声にした**震源をすべて保持する（震源の言い直しの判定用。
  // 判定は `isUnannouncedHypocenter`）。直前の 1 つではなく全部を持つのは、速報の初期に震源が
  // 区域の境目を往復するため —— 既に名乗った場所へ戻っただけの続報で言い直さない。
  const activeEEWAnnouncedHypocentersRef = useRef<Map<string, AnnouncedHypocenter[]>>(new Map())
  // 長周期地震動情報の更新検出: 受信済み eventId を追跡する
  const seenLpgmEventIdsRef = useRef<Set<string>>(new Set())
  // 津波解除/取消/失効: 音・TTS を発火済みの eventId を追跡する（AUD-6 の重複鳴り防止）。
  // TSU-3 で同一スロットに別 eventId を上書きするケースもあるため eventId 単位で管理する。
  // 直前状態（lastTsunamiGradeRef===null）で判定するとリロード後の初回解除を握り潰す。
  /**
   * 気象庁が書いた文のうち、**既に声にした文**（→ `speakTelegramText`）。鍵は「事象 × 1 文」
   * （`TelegramTextUnit.key`。組み立ては `telegramTextSpokenSubject`）。
   *
   * **電文の `id` を鍵にしない。** 生の電文は統合前で `eventKey` を持たず、P2PQuake 経路の
   * 鍵（`initialQuakeKey`）は電文の `id` を含むため、**続報のたびに別の鍵になって既読が効かない**
   * （同じ「＊印は…」を報のたびに読むことになる）。事象の識別子（`eventId`）なら続報で共有される。
   *
   * **本文まるごとではなく文で持つ。** 津波の避難行動の固定付加文は等級が動くたびに節が増減し、
   * まるごとを鍵にすると 1 文増えただけで既に読んだ 800 字を読み直す（→ `TelegramTextSpeech.units`）。
   *
   * **同じ文でも事象が変われば読み直す。** 文字列だけを鍵にしていた頃は、別々の地震に付いた
   * 同じ但し書きが最初の 1 回しか声にならなかった（→ `telegramTextSpokenSubject`）。
   * 事象をまたいで繰り返される定型文（`＊` の説明など）は、
   * 定型文の設定（`TELEGRAM_BOILERPLATE_KEYS`）が既定で落とす。
   */
  const spokenTelegramTextRef = useRef(new Set<string>())

  /**
   * この電文では気象庁が書いた文を読まない、という印（→ `handleLiveEvent`）。
   *
   * **本体が「この電文は処理しない」と決めた経路で立てる。** 本文の予約は本体の外
   * （ラッパー）で行うので、そのままだと本体が抑制した電文でも本文だけが声になる。
   * 電文そのものの性質（取消・試験報）は `telegramTextToSpeak` が弾くので、ここで扱うのは
   * **設定と電文の中身から本体が判断したもの**だけ。
   *
   * **本体に抑制を足したらここも見ること。** 立て忘れても型検査には掛からず、症状は
   * 「止めたはずの種別の本文だけが読まれる」という無音の食い違いになる。
   */
  const skipTelegramTextRef = useRef(false)
  const spokenTsunamiCancelEventIdsRef = useRef<Set<string>>(new Set())
  // 津波観測点の新規/更新バッジ表示状態と自動クリアタイマー
  const [obsUpdateStatus, setObsUpdateStatus] = useState<Map<string, ObsUpdateMark>>(() => new Map())
  const obsStatusClearTimerRef = useRef<number>(0)
  // 直近の受信で等級が動いた区域（`tsunamiAreaKey`）。カードが「〇〇から切り替え」を出す条件。
  //
  // **`lastGrade` だけで出してはいけない。** `LastKind` は変化した後の続報にも載り続けるため、
  // 区域の値だけを見ると何通も後まで「たった今切り替わった」ように見え続ける（読み上げは既読で
  // 1 回に絞っているのに、画面だけ持続する非対称になる）。観測点のバッジ（`obsUpdateStatus`）と
  // 同じく「今回分だけ」に置き換え、`TSUNAMI_BADGE_TTL_MS` で消す。
  //
  // **置き換えるのは、まだ声にしていない等級変化を持つ報のときだけ。** 津波の続報には等級に
  // ついて何も言っていないものがある —— 各地の満潮時刻・津波到達予想時刻に関する情報と津波観測に
  // 関する情報は、区域一覧も `LastKind` も前報のまま載せて届く（2024 年能登半島地震では、
  // 16:22 の引き上げの 30 秒後に満潮時刻の報が来ている）。それらは `selectUnspokenAreaGradeChanges`
  // が既読として全部落とすので、無条件に置き換えていたころは**等級が動いたことを伝える印が
  // 寿命を待たずに消えていた**。
  //
  // **タイマーも観測点と分ける。** 共有したままだと、等級を語らない続報が届くたびに張り直されて
  // 寿命が伸び続ける（津波が続いている間は数分おきに届くので、事実上消えなくなる）。
  const [areaGradeChangedKeys, setAreaGradeChangedKeys] = useState<Set<string>>(() => new Set())
  const areaGradeClearTimerRef = useRef<number>(0)
  // 津波イベント受信時にスクロールでフォーカスする予報区（今回の受信で変更があった区域全部＋その中の最高波高区域）。
  // 対象区域が特定できない受信（区域のみの発表・実質変化なしの続報・解除）は top: null（一番上へ戻す）で表す。
  // 形の意味は受け取る側（`FocusedDistrict`）に書いてある。`resetToTop` に既定値を置かないのは、
  // 「寄せ先が無い」と「先頭へ戻せ」を受信の種類ごとに決めるため（足し忘れを型検査で捕まえる）。
  const [focusedDistrict, setFocusedDistrict] = useState<{ districts: { code?: string; name?: string }[]; top: { code?: string; name?: string } | null; resetToTop: boolean; ts: number } | null>(null)

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
    /**
     * 語る対象の eventId（{@link eewEventKey}）。**画面側で「いま声が語っているカード」を
     * 示すために使う** —— 同時多発すると読み上げは eventId をまたいで交錯し、震源名を声に
     * するのは第 1 フェーズだけなので、予想値の発話だけでは何の地震か判らない（理由の詳細は
     * `useEewSpeakingCard`）。
     *
     * **省略可能にしないこと。** 渡し忘れても画面が動かないだけで例外もログも出ないため、
     * 経路を足したときの抜けを型検査で捕まえる。
     */
    key: string,
    speak: () => string | {
      text: string
      shouldStillPlay?: ShouldStillPlay
      /**
       * 発話が終わった（または黙る判断で降りた）ときに必ず呼ぶ。
       *
       * @param spoke **1 チャンクでも実際に鳴ったか**（{@link SpeechOutcome}）。合成が
       *   1 つも成功しなければ偽になる —— `speakWithVoicevox` は VOICEVOX 未起動・
       *   ネットワーク断でも例外を投げずに正常終了するため、これを見ないと
       *   **1 音も出ていないのに既読が進む**。上限（`capSpeechWait`）で待ち切ったときも
       *   偽へ倒す（応答が返っていない以上、鳴った証拠が無い）
       */
      onSettled?: (spoke: boolean) => void
    } | null,
    follow?: () => void,
    cutCurrent = false,
  ) => {
    eewSpeechPendingRef.current++
    const prev = eewSpeechChainRef.current
    if (cutCurrent) stopSpeech()
    let settled: ((spoke: boolean) => void) | undefined
    let spoke = false
    /**
     * 「語っているカード」の印を持つ世代（{@link EewSpeakingCardFollow}）。黙る予約では null のまま。
     *
     * **eventId ではなく世代で後始末する。** 文字列で照合すると、リプレイの開始・停止をまたいで
     * 同じ eventId が復帰したときに、取り残されたこの発話の後始末が新しい発話の印を落とす
     * （理由は `useEewSpeakingCard`）。
     */
    let speakingCardToken: number | null = null
    eewSpeechChainRef.current = capSpeechWait(prev).then(() => {
      const spoken = speak()
      if (spoken === null) return
      const { text, shouldStillPlay, onSettled } = typeof spoken === 'string'
        ? { text: spoken, shouldStillPlay: undefined, onSettled: undefined }
        : spoken
      settled = onSettled
      // 声に出すものが決まった瞬間に画面も合わせる。黙る予約（spoken === null）では動かさない。
      //
      // **画面を合わせる処理の失敗で読み上げを落とさない。** ここから例外が抜けると本文が
      // 鳴らないまま catch に落ち、警報が声にならない（`voicevox.ts` の `onChunkScheduled` と
      // 同じ方針）。カードの印もタブ追従も、どちらも「声に出すものが決まった」この位置で
      // 画面を動かすものなので、両方を守る。
      //
      // **ただし 1 つの try へまとめないこと。** まとめると先に置いた方（印）が投げただけで
      // タブ追従が一度も呼ばれず、**おまけの表示の失敗が既存の機能を巻き込む**。記録も 1 本に
      // なってどちらが落ちたか読めない。引用元の `onChunkScheduled` も、囲っているのは
      // 単一の副作用だけ。
      try {
        speakingCardToken = eewSpeakingCard?.begin(key) ?? null
      } catch (err) { log.warn('[eew] 語っているカードの印を立てられず（読み上げは続行）', err) }
      try { follow?.() } catch (err) { log.warn('[eew] 読み上げ追従に失敗（読み上げは続行）', err) }
      return capSpeechWait(
        speakWithVoicevox(settings.voicevoxUrl, text, settings.voicevoxSpeakerId, settings.soundVolume, shouldStillPlay),
      ).then(outcome => {
        // **上限（`capSpeechWait`）で待ち切ったときは「鳴った」へ倒す。**
        //
        // ここへ来る（`outcome` が undefined になる）のは 2 通りしかない。`capSpeechWait` は
        // 音が出ている間は計時しないので、**「長い読み上げだから打ち切られた」は起こらない**。
        //   ① 音が出ていないまま上限に達した（合成が返ってこない）
        //   ② 音が鳴り続けたまま延長の上限（`SPEECH_WAIT_HARD_CAP_MS`）に達した
        //
        // ②は鳴っているので「鳴った」で正しい。①は 1 音も出ていないので本来は偽だが、
        // **ここは偽へ倒さない** —— 合成が詰まっている状況で既読を巻き戻しても、読み直した
        // 発話がまた鳴らないだけ。逆に巻き戻しを常時効かせると、その端末では同じ内容を
        // 報のたびに読み直し続けることになる。
        //
        // なお、1 音も鳴らなかったことが**戻り値で分かる**場合（`outcome.spoke === false`）は
        // 別で、そちらは呼び出し側が既読を巻き戻す（`rollbackSpokenEntry`）。
        spoke = outcome?.spoke ?? true
      })
    })
      .catch(err => log.warn('[eew] 読み上げに失敗', err))
      .finally(() => {
        eewSpeechPendingRef.current--
        settled?.(spoke)
        // 印を立てた発話だけが後始末する。**立てていない発話（黙る予約・`begin` が投げた回）から
        // 呼ばないこと** —— 受け口は世代で照合するので害は無いが、渡すトークンが無い。
        if (speakingCardToken !== null) eewSpeakingCard?.end(speakingCardToken)
      })
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
      && (isMutualYieldTopic(topic) || isMutualYieldTopic(active.topic))) return 'mutualYield'
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
   * 自分より**後に到来した、自分より重い**読み上げに追い越されているか（主題は問わない）。
   *
   * 上の `overtakenByLaterArrival` が同格の追い越しを裁くのに対し、こちらは優先度差のある
   * 追い越しを裁く。**「いま塞がっているか」（`speechBlocker`）では代用できない** ——
   * あちらは先に届いた重い相手でも真を返すので、到来順どおりに待っている側まで取り下げてしまう。
   *
   * **見るのは予約してから声に出す直前までのあいだ全部。** 予約と間が明けるまでの数百ミリ秒
   * だけを見ていた頃は、待ち行列に入った後に届いた EEW を捕まえられなかった（実配信では
   * 推計震度分布図の 5.5 秒後に EEW が届き、EEW を読み終えた後ろで分布図が鳴って画面を奪った）。
   *
   * **同格は見ない**（`p > priority` の厳密不等号）。同格どうしの裁きは主題で決まるので、
   * ここで拾うと相互譲りの相手まで取り下げる。
   */
  const overtakenByHeavierArrival = (seq: number, priority: SpeechPriority): boolean => {
    // EEW は優先度の尺度の外にいて、常に最も重い。
    if (latestEewSpeechSeqRef.current > seq) return true
    for (const [p, s] of latestScheduledSeqByPriorityRef.current) {
      if (p > priority && s > seq) return true
    }
    return false
  }

  /**
   * 取り下げが決まった予約を「最後に予約されたもの」から降ろす。
   *
   * **降ろさないと取り下げが連鎖する。** 自分が一度も喋らずに消えたのに枠に残り続けると、自分より
   * 前に予約されていた読み上げが「後発に追い越された」と誤認して取り下がり、**どちらも読まれない**。
   *
   * 逆に、**読み終わった予約は降ろさない**（意図的）。後発を聞いたあとで先発を読めば、聞いている
   * 側には順序が入れ替わって聞こえる。到来順を守る規則はそれを避けるためのもの。
   *
   * **優先度の枠からも降ろすこと。** 主題の枠と同じ理屈で、取り下げられた重い予約が枠に残ると、
   * それより前に予約されていた軽い読み上げが「後から重いものが来た」と誤認して取り下がる。
   */
  const releaseLatestSchedule = (seq: number, topic: SpeechTopic, priority: SpeechPriority): void => {
    if (latestScheduledSeqByTopicRef.current.get(topic) === seq) {
      latestScheduledSeqByTopicRef.current.delete(topic)
    }
    releaseScheduledPriority(seq, priority)
  }

  /**
   * 優先度の枠だけを降ろす。**主題の枠とは降ろす時機が違う。**
   *
   * 優先度の枠が表すのは「**まだ鳴っていない、予約済みの重い読み上げ**」。自分が鳴り始めた
   * 時点でその役目は終わる —— 以降は `speechBlocker` の `higher` が待たせるので、枠に残す
   * 必要がない。
   *
   * **残したままにすると、鳴り終わった読み上げが永久に「追い越した側」であり続ける。**
   * 実際にそれで壊れたのが解説情報（`SPEECH_PRIORITY.commentary`）で、あれは本体より後に
   * 予約される設計のため、本体を待っているあいだに別の地震情報が 1 件でも届けば、その地震情報を
   * 読み終えた後でも取り下げられていた（群発の最中はほぼ常に沈黙する）。
   *
   * 主題の枠を同じ時機で降ろさないのは、問いが違うから —— あちらは「同じ話題の新しい報が
   * 来たか」で、**読み終わった報でも新しければ古い報を取り下げてよい**（最新だけ読めばよい）。
   */
  const releaseScheduledPriority = (seq: number, priority: SpeechPriority): void => {
    if (latestScheduledSeqByPriorityRef.current.get(priority) === seq) {
      latestScheduledSeqByPriorityRef.current.delete(priority)
    }
  }

  /**
   * ブロッカーから「待つ対象」の Promise を引く（待つものが無ければ null）。
   *
   * 待たせる相手は 2 種類ある——**自分より優先度が高いもの**と、**同格でも内容が重ならないもの**
   * （`MUTUAL_YIELD_TOPICS`）。上限が違うので、理由の判定（`speechBlocker`）とは分けている。
   */
  const speechBlockerPromise = (blocker: SpeechBlocker): Promise<unknown> | null => {
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
      // **延長の上限には `waitingSince` を渡す。** ここは待つ相手が入れ替わるたびに呼び直すので、
      // 既定（この呼び出しの開始）のままだと起点も取り直され、「待ち始めから 4 分」が
      // 「入れ替わるたびに 4 分」に化ける。
      await capSpeechWait(busy, remaining, waitingSince).catch(err => log.debug('[tts] 待っていた読み上げが異常終了', err))
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
   * （震源情報の電文自体は EEW より先に届いており、通知音との間（`ttsDelayFor`）を経て
   * 読み上げが始まる。**割り込みは電文の到来順では決まらない**）。同じ再生では、大津波警報の
   * 読み上げが 30 秒後に
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
    /**
     * この読み上げが何について語っているか（地震なら `quakeEventKey`）。未入電モードの
     * 自動開閉が対象の取り違えを避けるのに使う（→ `SpeechFollowSession.subject`）。
     */
    subject?: string,
    /**
     * **順番を待っているあいだに、より重い読み上げに追い越されたか**を問う
     * （`speakNonEEWDelayed` 経由のときだけ渡る。実体は `overtakenByHeavierArrival` の判定）。
     *
     * ここで問い直すのが要るのは、**待ちに入った後の到来を見る場所が他に無い**ため。予約から
     * 間が明けるまでの数百ミリ秒しか見ていなかった頃は、待ち行列に入った非 EEW が、あとから
     * 届いた EEW を読み終えた後ろで鳴っていた（到来順が逆に聞こえ、画面も奪う）。
     *
     * 真を返したときの後始末（記録・枠から降りる・先行合成の破棄）は**渡す側で済ませる**ので、
     * ここでは降りるだけでよい。
     */
    shouldWithdraw?: () => boolean,
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
      // **順番を待っているあいだに、より重い読み上げに追い越されていたら取り下げる。**
      // 待ちに入った後の到来を見る場所はここしかない（→ 引数 `shouldWithdraw` の注記）。
      // **`onSpeakStart` より前に置くこと** —— あちらは画面を動かし既読を進めるので、
      // 後ろに置くと取り下げたのにタブだけ移り、読まなかった内容が既読になる。
      //
      // **例外は握って読み上げを続ける**（直後の `onSpeakStart` と同じ方針）。ここから例外が
      // 抜けると本文が一言も鳴らないまま catch へ落ちる。判定に失敗したときは「取り下げない」
      // ——声が余分に出るほうが、聞こえないより軽い。
      try {
        if (shouldWithdraw?.()) return
      } catch (err) {
        log.warn(`[tts] 追い越しの判定に失敗（読み上げは続行）topic=${topic}`, err)
      }
      // 自分の番が来た（これから声に出す）瞬間に画面を合わせ、読み上げた値を既読へ移す。
      // 待ち行列の後なので、重い電文の読み上げ中に届いた軽い電文は、その後になって初めてタブを取る。
      //
      // **ここの失敗で読み上げを落とさない。** 例外が抜けると下の `speakWithVoicevox` へ到達せず、
      // **本文が一言も鳴らないまま** catch へ落ちる（記録は「読み上げの進行に失敗」という汎用の
      // 一行だけで、どの電文のどこで落ちたか残らない）。EEW 側の追従（`chainEEWSpeech` の
      // `follow?.()`）と同じ方針。画面を合わせられないことより、声が出ないことのほうが重い。
      //
      // **通るのは 1 つの経路ではない。** `speakNonEEWDelayed` が渡す関数はタブ移動
      // （`followSpeechTab`）を含み、呼び出し側の `onSpeakStart` は津波の観測点・地震情報の
      // 既読更新と、推計震度分布図の分布モードを開く操作を担う。
      try { onSpeakStart?.() } catch (err) { log.warn(`[tts] 発話直前の処理に失敗（読み上げは続行）topic=${topic}`, err) }
      // 追従は「これから声に出す」ここで開始する。予約の段階で始めると、間を置いている
      // 最中に追い越されて鳴らなかった読み上げに画面が付いていく。
      //
      // **どこも指していない文面では始めない。** 区域名も観測点名も含まない文（等級を判定
      // できなかったときの全解除の文言など）で始めると、追従は空振りしたまま終わり、
      // 「一度も引き当てられなかった」の記録だけが毎回残って診断の役に立たなくなる。
      // **追従を始めるかは参照の種類で決める。** `refs` が空でないことで判定すると、
      // 地震情報の読み上げ（区域と震源要素の参照を持つ）が津波カードの追従を起こす。
      const followToken = hasFollowTarget(segments) ? speechFollow?.begin(segments!) : undefined
      // 未入電の自動開閉も同じ位置で始める（「これから声に出す」瞬間）。**門が別**なのは、
      // 津波カードを動かす参照と、未入電トグルを開く参照が別物のため（→ `ttsFollow.ts`）。
      const unreceivedToken = hasUnreceivedFollowTarget(segments)
        ? unreceivedFollow?.begin(segments!, subject)
        : undefined
      // 気象庁が書いた文の自動展開も同じ位置で始める。**どの電文の文かは `subject` が持つ**
      // （参照には種別を持たせない。既読の記録へ混ざる形を増やさないため）。
      const telegramTextToken = hasTelegramTextFollowTarget(segments)
        ? telegramTextFollow?.begin(segments!, subject)
        : undefined
      // 借りた震源のカード表示も同じ位置で始める。**どの地震のカードかは `subject` が持つ**
      // （津波の読み上げなので、主題には原因地震の鍵が入っている）。
      const borrowedHypocenterToken = hasBorrowedHypocenterFollowTarget(segments)
        ? borrowedHypocenterFollow?.begin(segments!, subject)
        : undefined
      // 予約の通知を溜めておき、読み上げが終わってから「実際に鳴った範囲」を割り出す
      // （`spokenChunkIndices`）。合成は再生より先へ進むため、予約が通っただけでは鳴った
      // ことにならない。
      const scheduledChunks: { index: number; startAt: number }[] = []
      let chunkRefs: SpeechRef[][] | null = null
      let chunkCount = 0
      const notifyChunk = (index: number, startAt: number, chunks: readonly string[]) => {
        if (followToken !== undefined) speechFollow?.schedule(followToken, index, startAt, chunks)
        if (unreceivedToken !== undefined) unreceivedFollow?.schedule(unreceivedToken, index, startAt, chunks)
        if (telegramTextToken !== undefined) telegramTextFollow?.schedule(telegramTextToken, index, startAt, chunks)
        if (borrowedHypocenterToken !== undefined) borrowedHypocenterFollow?.schedule(borrowedHypocenterToken, index, startAt, chunks)
        if (onSpokenRefs && segments) {
          chunkRefs ??= mapChunksToRefs(segments, chunks)
          chunkCount = chunks.length
          scheduledChunks.push({ index, startAt })
        }
      }
      /**
       * **その時点までに声になった分**を記録へ移す。
       *
       * 呼ばれるのは 2 か所。読み上げの完了時（`finally`）と、**次の電文を受け取った瞬間**
       * （`flushSpoken` 経由）。後者があるのは、続報の差分が受信時に同期で組まれるため ――
       * 前の報を読み切る前に次が届くと既読がまだ進んでおらず、声にした内容を先頭から
       * 読み直すことになる（→ docs/spec/audio-tts-spec.md §4「既読になるのは「声になった分」だけ」）。
       *
       * **二度呼んでも害は無い。** `applySpokenRefs` は区域を前進のときだけ書き換え、事実は
       * 最後の値で上書きする。
       */
      const flushSpokenRefs = (finished: boolean) => {
        if (!onSpokenRefs || !chunkRefs) return
        const spoken = spokenChunkIndices(scheduledChunks, chunkCount, getSpeechClock(), finished)
        const refs = spoken.flatMap(i => chunkRefs?.[i] ?? [])
        // 1 チャンクも鳴らなかった（合成の全滅・鳴り出す前の割り込み）ときは記録しない。
        // 記録してしまうと、声になっていない内容が続報で省かれる。
        if (refs.length > 0) {
          onSpokenRefs(refs)
          return
        }
        if (spoken.length > 0) {
          // 音は鳴ったのに参照が 1 つも引けなかった。**症状は「うるさいまま」**（差分が
          // 効かず常に全文）で、黙って劣化する側の失敗なので、鳴らなかった場合と区別して残す。
          // 原因は断片列とチャンクの食い違い（`mapChunksToRefs` が警告を出しているはず）。
          //
          // **途中の見直しでも出す。** 完了時にも同じ判定を通るので同じ読み上げで重複しうるが、
          // 黙らせると、続報が連打される状況（群発）で検出の機会がまとめて失われる ――
          // 本来 5 回出るはずの警告が 1 回になり、ログの間引きに紛れて「起きていた」ことに
          // 気づけなくなる。**沈黙させてよいのは下の正常系だけ。**
          log.warn(`[tts] 声にはなったが読み上げ済みの参照を引けなかった (${spoken.length} チャンク)`)
          return
        }
        // **こちらは完了時だけ。** 途中の見直しでの「まだ鳴っていない」は正常で、電文が届く
        // たびに出すと診断の役に立たない。
        if (finished) log.debug('[tts] 声になったチャンクが無いため読み上げ済みの記録を更新しない')
      }
      // 第 5 引数（鳴らす直前の見直し）は非 EEW では使わない。予想震度のように数秒で
      // 書き換わる値を持たないため、読み始めた文面を最後まで読んでよい。
      const done = speakWithVoicevox(
        settings.voicevoxUrl, text, settings.voicevoxSpeakerId, settings.soundVolume, undefined, prewarmed,
        followToken === undefined && unreceivedToken === undefined
          && telegramTextToken === undefined && !onSpokenRefs
          ? undefined : notifyChunk,
      )
      activeNonEewSpeechRef.current = { priority, topic, done, flushSpoken: () => flushSpokenRefs(false) }
      try {
        await done
      } finally {
        if (followToken !== undefined) speechFollow?.end(followToken)
        // 読み上げが終わった（割り込まれて途中で終わった場合も含む）。未入電モードを開いて
        // いれば、ここで閉じる側が元へ戻す。
        if (unreceivedToken !== undefined) unreceivedFollow?.end(unreceivedToken)
        // 気象庁の文を読み終えた（割り込まれた場合も含む）。開いた表示はここで閉じる側が戻す。
        if (telegramTextToken !== undefined) telegramTextFollow?.end(telegramTextToken)
        // 借りた震源の追従もここで終える。**セッションを畳むだけで、見せたカードは戻さない**
        // —— 震源の句は津波の読み上げの末尾にあり、戻すと画面が一瞬で往復するだけになる。
        if (borrowedHypocenterToken !== undefined) borrowedHypocenterFollow?.end(borrowedHypocenterToken)
        flushSpokenRefs(true)
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
   * **待たされずに読めそうなら、通知音と同じ瞬間に画面も合わせる。** 間は音の種別ごとに
   * 0.5〜2.7 秒あり、その間ずっと前のタブに留まると「音が鳴ったのに画面が変わらない」ように
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
    /** この読み上げが何について語っているか（`speakNonEEW` へそのまま渡す）。 */
    subject?: string,
    /**
     * **追い越されて取り下げたときに呼ばれる。**「声にならなくても失ってはいけない一回性の処理」
     * だけを渡すこと（いまの利用者は推計震度分布図の「分布モードを開く最後の機会」だけ）。
     *
     * **`onSpeakStart` の代わりではない。** あちらに相乗りしている処理のうち、既読の記録は
     * 取り下げ時に進めてはいけない（「声になった分だけ既読にする」が崩れる）。タブ追従も渡さない
     * ——画面は追い越した側に留めるのが到来順の規則（→ audio-tts-spec.md §6）。
     *
     * 分布モードを開くのがこちらへ来るのは、**タブを動かさず地図の中身と地震カードの選択だけを
     * 変える**操作だから。逃すとその地震の分布は次の報が届くまで一度も出せず、しかも
     * 開けなかった記録すら残らない。
     */
    onWithdrawn?: () => void,
  ) => {
    // 予約した時点で、自分より重い読み上げが走っていたか。**先出しでタブを取るかの判断だけに使う**
    // （取り下げの判定は下の連番で行う。あちらは到来順そのものを見るので、予約時に塞がっていたか
    // を問う必要がない）。
    const blockedAtSchedule = speechBlocker(priority, topic)
    // 到来順の連番を振り、自分を「その主題の最後に予約されたもの」「その優先度の最後に予約された
    // もの」として登録する。追い越しは優先度だけでも到来順だけでも裁けないため、両方を持つ
    // （`overtakenByLaterArrival` / `overtakenByHeavierArrival`）。
    const seq = ++speechArrivalSeqRef.current
    if (latestScheduledSeqByTopicRef.current.size >= LATEST_SPEECH_TOPIC_MAX
      && !latestScheduledSeqByTopicRef.current.has(topic)) {
      // 捨てた事実を残す（`markQuakeReportSeen` と同じ流儀）。黙って消すと「取り下げが働かなかった」
      // ときに上限に当たったのか主題の付け方がずれたのかを切り分けられない。
      log.debug(`[tts] 主題ごとの予約の記憶が上限に達したため捨てた (${latestScheduledSeqByTopicRef.current.size} 件)`)
      latestScheduledSeqByTopicRef.current.clear()
    }
    latestScheduledSeqByTopicRef.current.set(topic, seq)
    latestScheduledSeqByPriorityRef.current.set(priority, seq)
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
    /**
     * 自分より後に到来した重い読み上げに追い越されていたら、取り下げて真を返す。
     *
     * **間が明けた時点と、順番を待ち終えた時点の 2 回問う。** 前者だけでは間（0.5〜2.8 秒）の
     * あいだの到来しか見られず、待ち行列に入った後に届いたものを取りこぼす。後者は
     * `speakNonEEW` へ渡して、声に出す直前に呼んでもらう。
     */
    const withdrawIfOvertaken = (where: string): boolean => {
      if (!overtakenByHeavierArrival(seq, priority)) return false
      log.info(`[tts] 後から届いた重い読み上げに追い越されたため取り下げる (${where}) topic=${topic} priority=${priority}`)
      releaseLatestSchedule(seq, topic, priority)
      prewarmed?.abort()
      // **声にならなくても失ってはいけない処理だけをここで拾う**（→ 引数 `onWithdrawn` の注記）。
      // 例外で取り下げそのものを壊さない（`onSpeakStart` と同じ方針）。
      try { onWithdrawn?.() } catch (err) { log.warn(`[tts] 取り下げ時の後始末に失敗 topic=${topic}`, err) }
      return true
    }
    scheduleSpeech(
      delay,
      () => {
        // **後から届いたものに追い越されたら取り下げる。** 待って読むと、到来順とは逆に
        // 「後から来た方が先、先に来た方が後」と喋ることになる。逆に、自分より**前**に届いた
        // 重い読み上げは待って読むのが正しい（到来順どおり）——どちらも連番で見分ける。
        //
        // 同じ主題の読み上げが自分より後に予約されていたら取り下げる。**予約時に塞がっていたかを
        // 問わない**（相手はまだ喋り始めていないことも多く、`speechBlocker` には映らない）。
        if (overtakenByLaterArrival(seq, topic)) {
          log.info(`[tts] 同じ主題の新しい読み上げに追い越されたため取り下げる topic=${topic}`)
          releaseLatestSchedule(seq, topic, priority)
          prewarmed?.abort()
          // **ここでは `onWithdrawn` を呼ばない。** 追い越した後発は同じ主題＝同じ話題の新しい報で、
          // 一回性の後始末はそちらが持つ。古い報の分だけ呼ぶと、別の地震へ入れ替わった推計震度
          // 分布図で**古い地震のカードを開き直す**。
          return
        }
        // 主題をまたぐ追い越し（自分より重い相手）。**相互譲りの相手では取り下げない** ——
        // `overtakenByHeavierArrival` が厳密不等号で見るので同格はここへ来ない。どちらも
        // 読みたい相手であり、順序が入れ替わって聞こえる不利より片方が消える不利の方が重い。
        if (withdrawIfOvertaken('間が明けた時点')) return
        speakNonEEW(
          text,
          priority,
          topic,
          // 声に出す瞬間にまとめて行う（画面を合わせる・読み上げた値を既読へ移す）
          () => {
            // **鳴り始めたら優先度の枠から降りる。** 残すと、自分より軽い読み上げが
            // 「後から重いものが来た」と誤認して取り下がり続ける（→ `releaseScheduledPriority`）。
            releaseScheduledPriority(seq, priority)
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
          () => releaseLatestSchedule(seq, topic, priority),
          subject,
          // 順番を待っているあいだの追い越しを、声に出す直前にもう一度見る
          () => withdrawIfOvertaken('順番を待っているあいだ'),
        )
      },
      () => {
        releaseLatestSchedule(seq, topic, priority)
        prewarmed?.abort()
      },
    )
  }

  /**
   * {@link AppEvent} に含まれない種別（{@link ExtraLiveEvent}）の受け口。
   *
   * **`handleLiveEvent` の本体から分けてある。** あちらは地震・津波・EEW の状態を突き合わせる
   * 処理で、ここで扱う電文はそのどの分岐にも当てはまらない。入口で振り分けて降ろすことで、
   * `handleLiveEvent` の中の `event` は `AppEvent` に絞られる —— 分岐の `kind` ガードを
   * 書き落とせば型検査が止める。
   *
   * ここに並ぶ電文は**どれも帯か地図で伝えるもの**で、地震カード・津波カード・EEW 表示の
   * 状態には載らない。担うのは通知音・読み上げ・（一部は）自動タブ切替だけ。
   */
  const handleExtraLiveEvent = (event: ExtraLiveEvent) => {
    // 長周期地震動情報（DMDSS版のみ）
    if (event.kind === 'lpgm') {
      const lpgmEvent = event.data
      // 読み上げ文を先に作る。**空になるのは読み上げそのものが無効な端末だけ** ――
      // `lpgmToText` は区域名を 1 つも作れなくても階級だけを伝える文へ落ちるので、
      // 読み上げが有効なら必ず非空になる（`ttsText.test.ts` が固定している）。
      // 声が出ない端末では追従でタブが動かないため、受信時に要求してフォールバックする。
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
        // （引き当ての述語はカードのバッジと共有する。→ `quakeKeyForLpgmEventId`）
        const matchedKey = quakeKeyForLpgmEventId(earthquakesRef.current, lpgmEvent.eventId)
        if (matchedKey) selectQuake(matchedKey)
        openLpgmFromQuake(lpgmEvent.eventId)
      }
      if (settings.soundEnabled) {
        playAlertSound('earthquake')
      }
      if (lpgmSpeech) {
        // 主題は地震情報と分ける。内容が別軸（震度と長周期地震動階級）なので、片方が
        // もう片方の言い換えにはならない（割り込みは従来どおり許す）。
        speakNonEEWDelayed(
          lpgmSpeech, SPEECH_PRIORITY.normal, ttsDelayFor('earthquake'), `lpgm:${lpgmEvent.eventId}`,
          { tab: 'earthquake', priority: TAB_PRIORITY.quake },
        )
      }
      // voicevox 有効/無効に関わらず追跡する（次回の isNewLpgm 判定に使用）
      seenLpgmEventIdsRef.current.add(lpgmEvent.eventId)
      return
    }

    // 推計震度分布図（DMDSS版のみ）。
    //
    // 地震から数分後に届く。**地震そのものの事実は既に地震情報で伝え終えている**ので、
    // ここが足すのは「震度の広がりが、気象庁の推計として出そろった」ことだけ。
    // 下の地震回数と違い**タブは動かす** —— 見せる先が地図の面で、そこへ行かないと何も見えない。
    // **動かし方は他のタブを持つ情報と同じで、読み上げに同調させる**（地震情報・長周期・津波と
    // 同じく `speakNonEEWDelayed` へ追従先を渡す）。受信の瞬間に要求を出すだけの形だと、
    // EEW が画面を保持している間はその要求が弾かれ、読み上げの番が来ても画面が合わないまま
    // 声だけが出る（→ audio-tts-spec.md §6「推計震度分布図は地震情報の音を借りる」）。
    if (event.kind === 'estimatedIntensity') {
      // **初報か続報かは `useEarthquakes` が決めて渡してくる**（`isNewEstimatedIntensity`）。
      // ここで見た `arrivalTime` を覚えて数え直すと、「同じ地震の続報」と「別の地震へ入れ替え」の
      // 区別を 2 か所で持つことになる。
      const { data: ei, isNew } = event
      // **印は型で必須にしてある**（`ExtraLiveEvent.isNew`）。流し込み口が付け忘れれば型検査が
      // 止めるので、欠落を実行時に確かめて記録する処理は置かない。
      //
      // **それでも下で `!== false` として受けるのは、倒す向きを初報側に固定しておくため。**
      // 型を潰して渡す経路が紛れ込むと `undefined` のまま届きうるが、素の真偽値として読むと
      // falsy なので「更新されました」側へ落ちる —— 初報を「更新されました」と読むと、聞き手は
      // 前に同じ分布を聞き逃したと思う（実際には届いていない）。逆向きの誤りは「同じ報が二度
      // 読まれた」と聞こえるだけで、事実としては嘘になっていない。
      // **地図の分布モードを開く。** 地震発生から数分後に届くもので、そのころ利用者は
      // 別のものを見ている。合図なしに画面だけ替わるのがいちばん困るので、音と声も添える。
      //
      // **読み上げの番が来た瞬間にもう一度開く**（下の `onSpeakStart`）。待っている間に別の
      // 地震情報が届けば選択はそちらへ移るので、受信時の 1 回きりだと「更新されました」と
      // 読み上げながら分布が出ていない形になる。開く操作は冪等（→ `openEstimatedIntensity`）。
      // **記録を残すのは「最後の機会」でだけ。** 受信の時点で開けないのは珍しくない（分布図が
      // 地震情報より先に届けば、まだどのカードにも結び付かない）ので、両方で残すと同じ文面が
      // 並び、本当に開けなかった回が埋もれる。
      const openDistribution = (lastChance: boolean) => {
        if (openEstimatedIntensity(ei.arrivalTime, ei.hypocenter.lat, ei.hypocenter.lon)) return
        if (!lastChance) return
        // 画面には何も現れないのに声は「受信しました」と言う。**記録が唯一の手掛かり**なので、
        // 同じ形の食い違いを扱う未入電側（`useUnreceivedSpeechFollow`）と同じく warn で残す。
        log.warn(`[quake] 推計震度分布図を受信したのに、対応する地震カードが無く分布モードを開けませんでした（地震発現時刻 ${ei.arrivalTime}）`)
      }
      // 受信の瞬間。読み上げが無い端末では、ここが開ける最後の機会になる。
      openDistribution(!settings.voicevoxEnabled)
      // **受信時要求へ落とすのは読み上げが無効な端末だけ。** そこでは画面が唯一の伝え手に
      // なるので `receipt` 駆動で出し、EEW 続報の保持を越えさせる（振り分けは
      // `setActiveTabNonRealtime`）。読み上げがある端末でここを通すと、最弱の優先度で出した
      // 要求が EEW の保持に弾かれたきりになる。
      if (!settings.voicevoxEnabled) {
        log.info('[tab] earthquake を要求 (推計震度分布図・読み上げ無し)')
        setActiveTabNonRealtime('earthquake')
      }
      if (settings.soundEnabled) {
        // **新しい音を作らない。** これは新しい危険ではなく、既に読み上げた地震の
        // **震度の描き方が公式のものへ替わった**という報せ。地震情報と同じ音で足りる。
        playAlertSound('earthquakeInfo')
      }
      if (settings.voicevoxEnabled) {
        // **読み上げ文は常に非空**（`estimatedIntensityToText` は時刻が読めなくても末尾の句を
        // 返す）。長周期のような「文が空なら受信時要求へ落とす」分岐が要らないのはそのため。
        speakNonEEWDelayed(
          estimatedIntensityToText(ei.arrivalTime, isNew !== false), SPEECH_PRIORITY.normal,
          ttsDelayFor('earthquakeInfo'), 'estimatedIntensity',
          { tab: 'earthquake', priority: TAB_PRIORITY.quake },
          undefined, undefined, () => openDistribution(true),
          // **取り下げられても分布モードを開く機会は残す。** 声が出ないことと地図に出ないことは
          // 別の損失で、こちらは逃すとその地震の分布を一度も出せない（しかも記録も残らない）。
          // タブは動かさないので、追い越した側が見せている画面は奪わない。
          undefined, () => openDistribution(true),
        )
      }
      return
    }
    // 地震回数に関する情報（DMDSS版のみ）。
    //
    // **帯で出す**（特別情報バナー。並びは後発地震の下）。伝えるのは群発という続いている「状況」で、
    // 地震カードのように 1 件ずつ増える「出来事」ではない。しかも群発の最中は小さな地震で
    // 揺れ検知が繰り返し発火してリアルタイムタブへ画面を持っていくため、タブの中へ置くと
    // いちばん見たいときに見えない。**そのためタブは動かさない**（帯はどのタブからも見える）。
    //
    // **ウィンドウタイトルは書き換えない。** 震度を伝える情報ではないので、震度を出している
    // タイトルを上書きすると、いま何が起きているかの表示が後退する。
    if (event.kind === 'earthquakeCount') {
      const count = event.data
      if (count.cancelled) {
        // **取消は音を鳴らさず、取り消された事実だけを読む**（南海トラフの取消と同じ扱い）。
        // 直前に「1704 回発生しています」と読んだ耳へ訂正を届けるため、黙って消さない。
        // **主題は発表と共有する** —— 分けると到来順の枠に載らず、発表の予約が待っている
        // 最中に取消が届いても取り下げられない（取り消された回数をそのあと読み上げる）。
        // 帯が消えるので、パネルの展開も要らない。
        if (settings.voicevoxEnabled) {
          speakNonEEWDelayed(earthquakeCountToText(count), SPEECH_PRIORITY.normal, 0, 'earthquakeCount')
        }
        return
      }
      // 帯は地図に重なって出るため、パネルを畳んでいると気づきにくい。いったん開く
      // （戻す判断は App 側。南海トラフ・後発地震と同じ扱い）。
      expandPanelForSpecialInfo()
      if (settings.soundEnabled) {
        playAlertSound('earthquakeCount')
      }
      if (settings.voicevoxEnabled) {
        // 帯で伝える情報なのでタブは動かさない（理由は上）。累積の区間が読めなければ
        // `earthquakeCountToText` は空を返し、そのときは音と帯だけで伝える。
        const countSpeech = earthquakeCountToText(count)
        if (countSpeech) {
          speakNonEEWDelayed(
            countSpeech, SPEECH_PRIORITY.normal, ttsDelayFor('earthquakeCount'), 'earthquakeCount',
          )
        }
      }
      return
    }

    // 南海トラフ関連解説情報（DMDSS版のみ）。臨時情報とは別の帯に出るため、ここでも別扱いにする。
    //
    // **ウィンドウタイトルは書き換えない。** 臨時情報の発表期間中は解説情報が毎日届くため、
    // 書き換えると「南海トラフ臨時情報（巨大地震注意）」のタイトル表示を毎日上書きしてしまう。
    if (event.kind === 'nankaiCommentary') {
      // 通知を切っている種別は本文も読まない（この設定は音・帯・読み上げをまとめて止めるもの）。
      if (!settings.nankaiCommentaryAlerts) { skipTelegramTextRef.current = true; return }
      const commentary = event.data
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
          nankaiCommentaryToText(commentary), SPEECH_PRIORITY.commentary, ttsDelayFor('specialInfoCommentary'),
          'nankaiCommentary',
        )
      }
      return
    }

    // 南海トラフ臨時情報・後発地震注意情報（DMDSS版のみ）
    if (event.kind === 'nankai' || event.kind === 'kohatsu') {
      if (!event.data.cancelled) {
        // 帯は地図に重なって出るため、パネルを畳んでいると気づきにくい。いったん開く（戻す判断は App 側）。
        // 取消・終了では呼ばない（帯が消えるので、開いて見せるものが無い）。
        expandPanelForSpecialInfo()
        if (settings.soundEnabled) {
          playAlertSound('specialInfo')
        }
        // 読み上げは soundEnabled と独立に voicevoxEnabled のみで判定する（AUD-7）。
        if (settings.voicevoxEnabled) {
          const ttsText = event.kind === 'nankai'
            ? nankaiToText(event.data)
            : kohatsuToText(event.data)
          // 帯で伝える情報なのでタブは動かさない（理由は関連解説情報と同じ）
          // 臨時情報と後発地震注意情報は主題を分ける。どちらも `high` だが互いに言い換えでは
          // ないため、まとめると一方の発表がもう一方を無音のまま消す。
          speakNonEEWDelayed(ttsText, SPEECH_PRIORITY.high, ttsDelayFor('specialInfo'),
            event.kind === 'nankai' ? 'nankai' : 'kohatsu')
        }
        // タイトル更新
        const specialTitle = event.kind === 'nankai'
          ? `南海トラフ臨時情報（${event.data.kindName}）`
          : '後発地震注意情報 発表中'
        title.setTitle(specialTitle)
        title.scheduleTitleRevert('specialInfo')
      } else {
        // 取消・終了時はタイマーをクリアして即時リセット
        title.clearTitleTimer('specialInfo')
        title.applyPriority()
        if (event.kind === 'nankai' && settings.voicevoxEnabled) {
          // 取消・終了も発表と同じ主題で予約する（間は置かない）。**主題を渡さないと到来順の枠に
          // 載らず**、発表の予約が待っている最中に取消が届いても取り下げられない
          // （取り消されたはずの臨時情報を、そのあと読み上げてしまう）。
          speakNonEEWDelayed(
            nankaiToText(event.data),
            SPEECH_PRIORITY.high, 0, 'nankai',
          )
        }
      }
      return
    }

    // **ここへ落ちたら、種別を足して上の分岐を書き忘れている。** `never` で受けるので、
    // `ExtraLiveEvent` へ足した時点で型検査が止まる —— 入口の振り分け（`handleLiveEvent`）が
    // 守るのは「`AppEvent` に絞られること」だけで、こちらの網羅性はそこでは見ていない。
    //
    // 実行時の記録も残す。型を潰して渡された電文は分岐へ当たらず、音も声もタブ移動も
    // 起こさないまま黙って抜けるため。
    const unhandled: never = event
    log.warn('[live-event] 扱いの決まっていない電文が届きました', unhandled)
  }

  /**
   * 津波の観測点を読み上げる件数の上限。
   *
   * **選抜（`select*ToSpeak`）と文の生成（`tsunami*ToSegments`）の両方へ同じ値を渡すこと。**
   * 片方を既定のままにすると、読み上げた件数と既読にする件数がずれる ―― 読まれていない
   * 観測点が既読になると、その値は二度と声にならない（→ tsunami-spec.md §10）。
   */
  const maxObsPoints = settings.ttsMaxObservationPoints

  /**
   * 気象庁が書いた文（本文・付加文）を読み上げる。設定で有効にしたときだけ鳴る。
   *
   * **最下位の層（`commentary`）で読む。** あの層は「何も切らない」ことを保証していて、
   * 待ちきれなければ黙る（`speakNonEEW`）。南海トラフ臨時情報の本文は読み上げ 3 分に達するため、
   * 電文本体の読み上げへ足すと地震情報を待たせることになる（→ `telegramTextToSpeak`）。
   *
   * **同じ本文は繰り返し読まない。** 固定付加文は区分が変わらない限り続報でも同じ値が載るので
   * （→ quake-spec.md §3「津波の付加文」）、鍵を電文ごとにすると「＊印は気象庁以外の…」を
   * 報のたびに読む。鍵はイベント単位にし、本文が変わったときだけ読み直す。
   */
  const speakTelegramText = (event: LiveEvent) => {
    // 読み上げは soundEnabled と独立に voicevoxEnabled のみで判定する（AUD-7）。
    // **このガードを省かない。** 設定タブの「読み上げ設定」は voicevoxEnabled が真のときしか
    // 出ないが、`ttsReadTelegramText` はそれとは独立に永続化される。読み上げを切った端末で
    // 有効な値が残っていると、マスタートグルを切ったのに声が出る。
    if (!settings.voicevoxEnabled) return
    const speech = telegramTextToSpeak(event, ttsRegionOptions(settings))
    if (!speech) return
    // **まだ声にしていない文だけを読む。** 既読の更新は**声に出す瞬間**（`onSpeakStart`）で、
    // 予約した時点で更新すると待ちきれず黙った分まで既読になり二度と読まれない（他の既読と同じ規約）。
    const fresh = speech.units.filter(u => !spokenTelegramTextRef.current.has(u.key))
    if (fresh.length === 0) {
      // **全文が既読で黙ったことを残す。** ここで返ると読み上げの予約自体が立たないので、
      // 以降のどの記録（取り下げ・待ちきれずの見送り）にも現れない —— 「本文が鳴らなかった」
      // 理由を後から切り分ける手掛かりがこの 1 行しかない。
      // **音の有無では観測できない**（合成した音はチャンク単位で控えるので、2 度目は
      // `/audio_query` すら飛ばない）。
      //
      // **主題まで出す。** 種別と件数だけでは、群発のさなかにどの地震で黙ったのかを特定できない。
      // 主題が `<種別>:` で終わっていれば、事象の識別子を取れずに旧来の挙動（文字列だけの既読）へ
      // 落ちた合図でもある（→ `telegramTextSpokenSubject`）。
      log.debug(`[tts] 気象庁が書いた文は全文が既読のため読まない subject=${speech.subject} 文数=${speech.units.length}`)
      return
    }
    // **全文が未読なら元の文をそのまま使う。** 繋ぎ直すと文のあいだの空白の扱いが変わりうるので、
    // 変える必要が無いときは触らない（合成エンジンが置く間は空白の有無で変わる）。
    const text = fresh.length === speech.units.length
      ? speech.text
      : `${speech.prefix}${fresh.map(u => u.text).join('')}`
    // 際限なく溜めない（津波の取消の既読と同じ方式）。**鍵は「事象 × 文」なので本文まるごとより
    // 速く増える** ——実電文で 1 通あたり最大 29 文、能登半島地震の 1 日ぶんで 158 件。
    if (spokenTelegramTextRef.current.size > TELEGRAM_TEXT_SPOKEN_MAX) {
      // **捨てた事実を残す**（同種の記憶と同じ流儀）。捨てた直後は既読の文が読み直されるので、
      // 記録が無いと「なぜ同じ文をもう一度読んだのか」を追えない。
      log.debug(`[tts] 気象庁が書いた文の既読が上限に達したため捨てた (${spokenTelegramTextRef.current.size} 件)`)
      spokenTelegramTextRef.current.clear()
    }
    // **`speakNonEEWDelayed` を経由する。`speakNonEEW` を直接呼ばない。**
    // 到来順の裁き（`overtakenByLaterArrival`）と予約の枠の管理を持っているのはこちらだけで、
    // 直接呼ぶと**先発がまだ鳴り出す前に後発が届いたとき、両方がキューに入って重なる**
    // （既読は声に出す瞬間にしか進まないので、予約の時点では弾けない）。
    //
    // **主題は電文の種別。** 同じ種別の本文どうしは後発が勝つ（最新の本文を読む）。
    // 本体の読み上げとは別の主題にしてあるので、到来順の裁きが本体の予約を取り下げることはない。
    //
    // **参照つきの断片で渡す。** 読み上げているあいだ、画面のその表示を開いておくため
    // （→ `ttsFollow.ts` の `telegramText`）。文の中身では分けず 1 つにまとめている ——
    // 求められているのは「読み始めたら開く」ことで、どの段落を読んでいるかの追従ではない。
    //
    // **開く先がある種別にだけ参照を付ける。** 地震情報の付加文は元から畳んでいないので
    // 開く相手がいない。無条件に付けると、誰も反応しない追従セッションが立ち上がっては終わる
    // （症状が出ないぶん、後から読んで意図を確かめられない）。
    const segments: SpeechSegment[] = [{
      text,
      refs: TELEGRAM_TEXT_OPEN_TARGET_KINDS.has(event.kind) ? [{ kind: 'telegramText' }] : [],
    }]
    // **長周期地震動観測情報だけ、どの地震の補足かまで主題に載せる。** 地震カードは複数
    // 並ぶので、種別だけではどのカードを開くか決まらない（バナーと津波の面は画面に 1 つ）。
    // 鍵は `eventId` —— カードが長周期を引き当てるのに使っているものと同じ（`lpgmByEventId`）。
    const subject = event.kind === 'lpgm'
      ? telegramTextSubject(event.kind, event.data.eventId)
      : telegramTextSubject(event.kind)
    speakNonEEWDelayed(
      text,
      SPEECH_PRIORITY.commentary,
      0,
      `telegramText:${event.kind}`,
      undefined,
      segments,
      undefined,
      // **読んだ分だけ既読にする。** 声にしなかった文（上限で落ちた分は無いが、
      // 未読でなかった文）まで入れると、次の報でそれらが読まれなくなる。
      () => { for (const u of fresh) spokenTelegramTextRef.current.add(u.key) },
      // 追従する側が「どの電文の文か」を知るための主題。**topic とは役割が違う** ——
      // topic は到来順の裁き（同じ種別は後発が勝つ）に、subject は画面のどこを開くかに使う。
      // 長周期だけ地震の識別子まで含むのはそのため。
      subject,
    )
  }

  const handleLiveEventInner = (event: LiveEvent, meta?: LiveEventMeta) => {
    // **カードが内容を採らない地震情報か**（→ `LiveEventMeta.quakeHeldBack`）。真なら音・読み上げ・
    // ウィンドウタイトル・自動タブ切替を起こさない（判定は受信側が済ませていて、ここは印を読むだけ）。
    //
    // **導出はこの 1 か所だけ。** 止める先は離れた場所に 4 つあるので、それぞれが `meta` を
    // 読み直す形にすると、片方だけ条件を足したときにどれかが抑制から外れる —— 仕様書自身が
    // 「片方だけ直されると画面と声が食い違う」と書いている形を、修正の中に持ち込むことになる。
    const quakeHeldBack = event.kind === 'quake' && meta?.quakeHeldBack === true
    // **地震・津波・EEW 以外はここで降ろす。** 以降の分岐はこの 3 種別の状態を突き合わせる
    // 処理で、ほかの電文はどれにも当てはまらない（→ `handleExtraLiveEvent`）。先に降ろすので、
    // この行から下の `event` は `AppEvent` に絞られている。
    if (event.kind !== 'quake' && event.kind !== 'tsunami' && event.kind !== 'eew') {
      handleExtraLiveEvent(event)
      return
    }
    // 受信時に該当タブを自動表示し、ウィンドウタイトルを更新する
    // （地震情報・津波情報・緊急地震速報）。
    // isNewQuake は UI ブロックと TTS ブロックの両方で参照するためここで宣言する
    let isNewQuake = true
    // 地震情報の読み上げの主題（イベント単位）。UI ブロックで決めて TTS ブロックで使う。
    // 取消は TTS ブロックを通らない（音の種別が決まらず早期 return する）ので、自分の分岐で組み立てる。
    let quakeSpeechTopic: SpeechTopic = 'quake:unknown'
    // 読み上げの主題そのもの（`quakeSpeechTopic` から `quake:` を剥がしたもの）。未入電モードの
    // 自動開閉が「読んでいる地震」と「画面が出している地震」を突き合わせるのに使う（→ `SpeechFollowSession.subject`）。
    // **主題の文字列を分解して取り出さない** —— 組み立てと取り出しが別々に育つと、片方だけ書式が変わったときに黙って一致しなくなる。
    let quakeSubjectKey: string | null = null
    // 津波が新規発報か grade 格上げか（UI ブロックで立て、TTS ブロックで消費する）。
    // **観測点更新（grade 不変の続報）ではタブを動かさない**ための判定に使う。
    // 続報のたびに画面を持って行くと、EEW を見ている最中に何度も津波タブへ引っ張られる
    // （従来 CRIT-4 として抑制していた挙動を、追従の側でも踏襲する）。
    let tsunamiIsNewOrUpgraded = false
    // 別の津波（別イベント）への切り替わりか。**区域の印を落とす契機として使う。**
    // 格上げ（同じ津波の等級が上がった報）は含めない —— あちらは同じカードの続きなので、
    // 印はその報自身が持つ等級変化で置き換わればよい。
    //
    // **判定の相手は `tsunamisRef` ではなく `lastTsunamiRef`。** あちらは App の render 本体で
    // 代入されるため、同一 tick に複数の電文が捌けると（アーカイブ再生の追いつき・長時間
    // バックグラウンド後の復帰）tick 開始前の値に取り残される。そちらと比べると、**新しい津波の
    // 2 通目以降まで「新規発報」に見えて、1 通目が立てた印を消す** —— 直そうとしている症状
    // （等級を語らない報で印が消える）を別の経路から再現することになる。
    // 罠の詳細は `lastTsunamiRef` の宣言箇所。
    let tsunamiIsNewFire = false
    // 津波の続報が「観測情報」か（等級が動いていない続報。区域が空の電文を含み、引き下げは含めない）。
    // **音の種別判定で立てて、読み上げの優先度と主題で消費する。** 同じ判定を書き分けると
    // 「更新音が鳴ったのに、読み上げは発報の重みで地震情報を切る」形の食い違いになる
    // （実際にそうなっていた。等級が動いていない続報まで `high` で読んでいた）。
    let tsunamiIsObservationUpdate = false
    // 津波のカードと並びを揃えるための材料（→ `tsunamiCardOrderBasis`）。**電文の `areas` /
    // `observations` を直接使わず、必ずここから引くこと。** 別々に組み立てると、片方だけが
    // カードと食い違う形で残る。渡す先の一覧は宣言箇所にある（ここでは数え上げない ――
    // 同じ列挙を 2 箇所に置くと、片方だけが古くなる）。
    // 津波以外では空（参照するのは津波の分岐だけなので、null を配って各所で確かめるより素直）。
    const tsunamiCardBasis: TsunamiCardOrderBasis = event.kind === 'tsunami'
      ? tsunamiCardOrderBasis(event, tsunamisRef.current[0])
      : { areas: [], observations: [] }
    // 津波の続報が「区域単位で等級が動いた報」か（全体の最上位等級は変わらないが、一部の区域で
    // 解除・切替・引き上げが起きている）。**観測情報と同じ枠に入れないための判定。**
    // 気象庁は一部解除でも区域を電文から消さず等級の降格として載せるため、他の区域に注意報が
    // 残っている限り最上位は動かない。これを観測情報として扱うと、観測波高の更新が無ければ
    // 読み上げ文が空になり、受信音だけが鳴って何も伝わらない
    // （→ docs/spec/tsunami-spec.md §10「区域単位で等級が動いた報」）。音の種別判定で立てて読み上げの枝で消費する。
    let tsunamiIsAreaGradeChange = false
    // 区域単位で等級が動いた組のうち、**まだ声にしていない分だけ**。読み上げが無効な端末の
    // タブ移動（UI ブロック）と、読み上げの枝分け（音の種別判定）の双方が見るため、ここで
    // 1 度だけ求める。既読を除くのは、`LastKind` が変化後の続報にも載り続けるため
    // （→ `selectUnspokenAreaGradeChanges`）。
    const tsunamiAreaChanges = event.kind === 'tsunami' && !event.cancelled
      ? selectUnspokenAreaGradeChanges(
        // **渡すのはカードの材料の観測点**（`tsunamiCardBasis`）。区域の並びはカードと揃える規約で、
        // 一部解除の電文は観測点を持たないことが多い。今回の電文の分だけで並べると、画面が既存の
        // 観測値で並べた順と食い違い、読み上げに追従するスクロールが往復する。材料を経由するのは、
        // 引き継ぎの可否をカードと同じ述語（`isTsunamiContinuation`）で判定させるため——無条件に
        // マージすると、別の地震の津波・解除表示中のカードの観測点まで混ざる。
        tsunamiAreaGradeChanges(event, tsunamiCardBasis.observations),
        spokenAreaGradeRef.current,
      )
      : []
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
        // **この経路は `flushSpoken()` を呼ばない。** 続報の差分と違い、取消の読み上げは
        // 区域の既読を参照しないため（`earthquakeCancelToText` は断片も `onSpokenRefs` も持たない）。
        // 進行中の読み上げを取消が実際に切ったなら、切られた側の `finally` が完了時のフラッシュで
        // 正しく記録する。「差分を組む直前に確定させる」という決まりの対象外
        // （→ docs/spec/audio-tts-spec.md §4「既読になるのは「声になった分」だけ」）。
        //
        // 取消電文の issue.time は取消電文自体の発表時刻であり、取り消された元の地震情報の発表時刻ではない。
        // 読み上げには同一 eventId で最後に受信した地震情報（既存カード）の time を使う。
        const cancelEventId = extractQuakeEventIdFromId(event.id)
        const original = cancelEventId
          ? earthquakesRef.current.find(e => extractQuakeEventIdFromId(e.id) === cancelEventId)
          : undefined
        speakNonEEWDelayed(
          earthquakeCancelToText(original?.time ?? null, event.cancelText),
          SPEECH_PRIORITY.normal,
          ttsDelayFor('eewCancel'),
          `quake:${quakeEventKey(event as import('../types/earthquake').JMAQuake)}`,
          { tab: 'earthquake', priority: TAB_PRIORITY.quake },
        )
      }
    } else if (event.kind === 'quake') {
      // **止めるのは音・読み上げ・ウィンドウタイトル・自動タブ切替・カードの選択・
      // 分布モードのクローズの 6 つ**（印は入口で導出済み＝`quakeHeldBack`）。「この報は見た」
      // の記録（`markQuakeReportSeen`）だけは通す —— これはカードが内容を採ったかどうかと
      // 無関係に要る（続報判定の台帳で、据え置いた報も「見た」ことに変わりはない）。
      //
      // **選択・分布クローズは元々「通す」側だったが、覆した。** 分布モードのクローズ理由
      // （「その地震の電文を受けたら閉じる」docs/spec/quake-spec.md §9）は「発表値が更新された
      // のに分布モードが隠している」ことを根拠にしており、**据え置きは発表値を更新しないので
      // この根拠が成立しない**。選択も同様で、独立した根拠が無いまま「カードの選択・分布・
      // 見た記録はカードが内容を採ったかどうかと無関係」という一文に相乗りしていた。
      // 2024-11-26 22:47 の大阪府北部で、完全版のあとに届いた震度速報が据え置かれたにも
      // かかわらず、別のカードを選択していた場合はそちらの選択が奪われ、開いていた追加表示
      // （長周期・未入電・分布）も閉じていた。取消より前に発表された報（§6.2）ではさらに悪く、
      // 対象カードが取消済み・消滅しているため `App.tsx` の `selectedQuake` 導出が
      // `latestNonCancelled` へ落ち、**無関係な最新の地震が選択される**。
      // 読み上げがあるならタブ移動は読み上げに任せる（共通の TTS ブロックが follow を渡す）。
      // 重い電文（EEW・津波）の読み上げ中に届いた地震情報は、その読み上げが終わって
      // 自分の番が来たときに画面を取る。地震情報の読み上げ文は常に非空。
      if (quakeHeldBack) {
        // **止めたことを残す。** 読み上げが無効な端末では、この 1 行が自動タブ切替の唯一の
        // 経路 —— 音・読み上げ側の記録（下）は読み上げブロックの中なので、そちらでは出ない。
        log.debug('[tab] カードが採らない電文なのでタブ移動を起こさない')
      } else if (!settings.voicevoxEnabled) {
        log.info('[tab] earthquake を要求 (地震情報 VXSE51/52/53/61・読み上げ無効)')
        setActiveTabNonRealtime('earthquake')
      }
      const incomingQuake = event as import('../types/earthquake').JMAQuake
      const incomingKey = newQuakeTrackingKey(incomingQuake)
      isNewQuake = !seenQuakeReportKeysRef.current.has(incomingKey)
      if (isNewQuake) {
        markQuakeReportSeen(seenQuakeReportKeysRef.current, incomingKey)
      }
      // 選択 ID はカードと照合するため eventKey で渡す。P2PQuake は続報ごとにレコード id が
      // 変わるので、既存カードがあればそのキーを引き継ぐ（このハンドラは useEarthquakes の
      // 統合より前に呼ばれるため、earthquakesRef はこの電文を取り込む前の状態）。
      // 同一 tick に複数電文が捌けて ref が追いつかない場合はキーが実カードと一致せず、
      // 選択は「取消でない最新カード」へフォールバックする（App.tsx の selectedQuake 導出）。
      const existingCard = earthquakesRef.current.find(q => sameQuakeEntry(q, incomingQuake, getAreaPrefIndexCache()))
      // 選択と読み上げの主題は同じキーで揃える（どちらも「どの地震か」を指すもの）。
      // **quakeHeldBack でも決める。** quakeSpeechTopic・quakeSubjectKey の消費は読み上げ
      // ブロックの中（`!quakeHeldBack` を通った後）に限られるため、ここで決めるだけなら無害。
      const incomingEventKey = quakeEventKey(existingCard ?? incomingQuake)
      quakeSpeechTopic = `quake:${incomingEventKey}`
      quakeSubjectKey = incomingEventKey
      if (quakeHeldBack) {
        // **止めたことを残す。** カードが採らない電文で選択を動かすと、見ていた別のカードの
        // 選択が奪われ、開いていた追加表示（長周期・未入電・分布）も閉じてしまう。
        log.debug('[quake] カードが採らない電文なので選択も分布モードのクローズも起こさない')
      } else {
        // 新規・続報いずれも、受信した地震カードを選択状態にする。
        selectQuake(incomingEventKey)
        // 震度分布モードを開いていたら閉じて、発表値の地図へ戻す。**同じ地震の続報でも閉じる**
        // ——分布モードは区域塗りも観測点ドットも出さないので、開いたままだとこの電文が伝えて
        // きた震度が地図に一切現れない（→ `closeDistributionOverlayOnQuakeReport`）。
        closeDistributionOnQuakeReport(incomingEventKey)
      }
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
      if (quakeHeldBack) {
        // カードが内容を採らない電文（宣言箇所に理由）。タイトルはカードと同じものを出す欄なので、
        // ここで更新すると**カードが据え置いた震度・震央地名がタイトルにだけ出る**。
        // 2024-11-26 22:48 の震度速報では「地震情報  最大震度3」（震央地名は空・カードは震度1）に
        // なっていた。**復帰の予約も張らない** —— 変えていないものを戻す必要は無い。
        log.debug('[title] カードが採らない電文なのでタイトルを更新しない')
      } else if (keepsKnownScale) {
        // 残した事実を記録する。逆に「残すべきだったのに落ちた」ときも、この行が出ていないことで
        // 既存カードを引けなかった（同一 tick に複数電文が捌けて `earthquakesRef` が追いつかない）
        // と切り分けられる。
        log.debug(`[title] 震度なしの電文なのでタイトルを更新しない (既存の最大震度=${existingCard?.earthquake.maxScale})`)
      } else {
        // 遠地地震は国内で震度を観測しない（maxScale は常に -1）。「最大震度不明」と出すと
        // 震度が判明していないだけに読めてしまうため、規模を出す別書式にする。
        title.setTitle(isForeignQuake
          ? `遠地地震 ${hypocenter.name}${magnitudeTitlePart(hypocenter)}`
          // ウィンドウタイトルも断定形にしない（理由は App.tsx の通知と同じ）。
          : `地震情報 ${hypocenter.name} 最大震度${getIntensityLabelWithOrAbove(maxScale, isMaxScaleUnreceived(maxScale, event.points))}`)
      }
      if (!quakeHeldBack) title.scheduleTitleRevert('earthquake')
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
      // **読み取りを先に済ませてから更新する。** この 2 つを直接並べると、行を入れ替えただけで
      // `isTsunamiNewFire(event, event)` になり（`eventId` が一致するので常に偽）、以後どんな別の
      // 津波が来ても印を落とせなくなる —— 例外もログも出ない。退避しておけば入れ替えは型で落ちる。
      const previousTsunami = lastTsunamiRef.current ?? undefined
      // 解除の照合に使うので、受信した順で覚える（理由は宣言箇所）。タブ切替の判定が
      // `tsunamisRef` を見ているのは従来どおり（あちらは「画面がいま何を出しているか」の話）。
      lastTsunamiRef.current = event
      // **タブ切替の `isNew` を流用しないこと**（宣言箇所に理由）。あちらは `tsunamisRef` 由来で、
      // 同一 tick に取り残された値を見る。タブが余分に動くだけなら実害は小さいが、印を消す判定に
      // 使うと消えてはいけない印が消える。
      tsunamiIsNewFire = isTsunamiNewFire(event, previousTsunami)
      if (!settings.voicevoxEnabled) {
        if (tsunamiIsNewOrUpgraded) {
          log.info(`[tab] tsunami を要求 (${isNew ? '新規発報' : 'グレード格上げ'}・読み上げ無効)`)
          setActiveTabNonRealtime('tsunami')
        } else if (tsunamiAreaChanges.length > 0) {
          // 一部の区域だけ等級が動いた報。最上位が変わらないので上の判定には掛からないが、
          // 読み上げが無い端末では画面が唯一の伝達手段になる。
          log.info('[tab] tsunami を要求 (区域単位の等級変化・読み上げ無効)')
          setActiveTabNonRealtime('tsunami')
          // **声が出ない端末はここで既読にする。** 進めないと、同じ変化を載せ続ける続報
          // （`LastKind` は変化後も残る）のたびに画面を奪う。読み上げが有効な端末では、
          // 発話を始める瞬間に進める側に任せる。
          rememberAreaGrades(tsunamiAreaChanges, spokenAreaGradeRef.current)
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
      // 間の長さは音の種別で決まる（`ttsDelayFor`）。実測値と測り方は audio-tts-spec.md §6。
      if (!alreadySpoken) {
        spokenTsunamiCancelEventIdsRef.current.add(cancelId)
        if (settings.soundEnabled) playAlertSound('tsunamiCancel')
        if (settings.voicevoxEnabled) {
          speakNonEEWDelayed(
            tsunamiCancelToText(event.cancelReason, event.cancelText),
            SPEECH_PRIORITY.high,
            ttsDelayFor('tsunamiCancel'),
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
        lastMaxObsTimeRef.current.clear()
        lastMaxObsFirstWaveRef.current.clear()
        seenObsNamesRef.current.clear()
        spokenObsHeightRef.current.clear()
        spokenObsNamesRef.current.clear()
        spokenObsMissingRef.current.clear()
        spokenObsWarningLevelRef.current.clear()
        spokenObsMaxHeightTimeRef.current.clear()
        spokenObsFirstWaveRef.current.clear()
        spokenTideRef.current.clear()
        spokenAreaGradeRef.current.clear()
        window.clearTimeout(obsStatusClearTimerRef.current)
        window.clearTimeout(areaGradeClearTimerRef.current)
        setObsUpdateStatus(new Map())
        setAreaGradeChangedKeys(new Set())
        // 解除はカードの中身が消えるので前の位置に意味が無い。先頭へ戻す。
        setFocusedDistrict({ districts: [], top: null, resetToTop: true, ts: Date.now() })
      } else {
        // 捨てた事実を残す。黙って通すと「解除を受けたのにバッジが消えない」を追えない。
        log.info('[tsunami] 表示中の津波と一致しない解除のため、観測点の記憶は落とさない')
      }
    } else if (event.kind === 'eew') {
      if (event.test) return

      // **述語を共有する。** この鍵は読み上げ側の記憶に加えて、画面が「いま声が語っている
      // カード」を引き当てる鍵も兼ねる（`RealtimeTab` 側も `eewEventKey` で引く）。
      // 導出を書き写すと、片方だけ変えたときの症状が「カードが光らない」だけで
      // 例外もログも出ない。
      const key = eewEventKey(event)

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
              scheduleSpeech(ttsDelayFor('eewCancel'), () => chainEEWSpeech(
                key,
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
        eewPhase1TokensRef.current.delete(key)
        eewPhase2TokensRef.current.delete(key)
        eewPhase2DoneRef.current.delete(key)
        eewRegionTokensRef.current.delete(key)
        spokenEEWRegionsRef.current.delete(key)
        spokenEEWUpgradePhraseRef.current.delete(key)
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
              log.info(`[tab] ${defaultTabRef.current} を要求 (EEW全解除)`)
              revertToDefaultTab('EEW全解除')
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
      // **新規発報を到来順の軸へ刻む。** 予約済みの非 EEW は、これより後の連番なら「先に届いて
      // いた」ので待って読み、これより前なら「後から重いものに追い越された」ので取り下げる
      // （`overtakenByHeavierArrival`）。続報では進めない —— 理由は同 ref の注記。
      if (isNew) latestEewSpeechSeqRef.current = ++speechArrivalSeqRef.current
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
          `${event.earthquake.hypocenter.name}${scale > 0 ? ` 最大震度${getIntensityLabelWithApproxAbove(scale, scaleOrAbove)}予想` : ''}`,
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
        (scale > 0 ? ` 最大震度${getIntensityLabelWithApproxAbove(scale, scaleOrAbove)}予想` : '') +
        (newCount > 1 ? ` 他${newCount - 1}件` : '')
      title.setTitle(eewTitle)
      title.scheduleTitleRevert('eew')

      // VOICEVOX: 2フェーズ読み上げ
      // 第1フェーズ（isNew 即時／続報での震源の言い直し／予報から警報への言い直し）:
      //   「地震動予報、〇〇で地震。」/「緊急地震速報、〇〇で地震。」/「震源を更新、〇〇で地震。」
      //   震源の言い直しと区分の格上げが重なるときは「緊急地震速報、〇〇で地震。」に統合する
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
         * 声にした区分と、この報で**格上げが起きたか**。
         *
         * **第 1.5 フェーズと第 2 フェーズが同じ判定を使う。** 前者は前置き（「緊急地震速報に
         * 切り替わりました。」）を付けるか、後者は予想値を読み直すかを決める。式を別々に持つと、
         * 片方だけ変えたときに「格上げ」の意味が静かにずれ、前置きの有無と読み直しが食い違う。
         *
         * 区分は引き下げない（`Math.max`）—— 一度「警報」と伝えた EEW は、以後 severity が
         * 落ちても伝え済みとして扱う（`activeEEWLevelsRef` の方針と同じ）。
         *
         * **発話の直前に呼ぶこと。** 予約から声になるまでのあいだにも続報は届く。
         */
        const levelUpgradeOf = (latest: EEWAlert) => {
          const spoken = spokenEEWLevelsRef.current.get(key) ?? 0
          const level = Math.max(computeSingleEEWLevel(latest), spoken) as 0 | 1 | 2
          return { level, spoken, upgraded: level >= 1 && spoken < 1 }
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
          chainEEWSpeech(key, () => {
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
            // **発話の順番が来た時点で、確定値より高い震度が既に届いて安定待ち中なら降りる。**
            // 確定値は安定待ちを通った値なので、待っている間に上がったぶんはまだ入っていない。
            // そのまま読むと、画面が上位の予想を出しているのに声だけ一段低い値を言う
            // （2024/01/01 能登の前震: 第 4 報 +2.1 秒で 5 強・第 7 報 +4.1 秒で 6 弱。震源を
            // 読み終える頃には 6 弱が届いているのに「予想最大震度5強。」を読み、読み終えてから
            // 6 弱を言い直していた）。
            //
            // **降りても取りこぼしにはならない**が、それは「サイクルは必ず確定へ至る」という
            // 単一の理由ではなく、次の 4 通りで担保されている。**`clearScaleStability` を新しく
            // 呼ぶ場所を足すときは、そこがどれに当たるかを確かめること。**
            //   1. サイクル自身のタイマーが `confirmScale` を呼ぶ（通常）
            //   2. サイクルを捨てる側が、同じイベント処理の中で確定経路を張り直す
            //      （第 1 フェーズの予約を積むときの後始末と、予想震度が有→無に戻ったときの
            //      直後に `confirmScale` / `updateScaleStability` / 理由不明タイマーのいずれかへ
            //      必ず落ちる。**ただし理由不明タイマーが既に動いている場合は張り直さず、
            //      そのタイマーが確定を担う**——「冗長」と見て消さないこと）
            //   3. 読まないことが正しい場合（誤報取消・自動解除・リプレイのリセット・アンマウント）
            //   4. `clearScaleStability` を呼んだ時点で（**捨てるサイクルが無い場合を含めて**）
            //      **確定値が最新の電文と既に一致している**場合。予想震度が無く理由も
            //      判らない報が続き、かつ確定値が既に「予想震度なし」（`scale === 0`）のとき、
            //      理由不明タイマーを張らずに済ませる経路がこれにあたる。張り直しても同じ値で
            //      確定し直すだけで何も読まないのに、待っている 3 秒のあいだ非 EEW の読み上げを
            //      止めてしまう（止められた側は「追い越された」と判定して取り下げる）。
            //      **判定は「確定したか」ではなく「確定値が 0 か」で行うこと**——前者にすると
            //      2 の後始末（有→無に戻ったとき）まで巻き込み、取り下げられた予想震度が
            //      確定値として残る
            // **沈黙の間も `speechBlocker` が `eewPhase2` を返すので、非 EEW が滑り込むことはない。**
            //
            // **待つのは震度だけ。** 階級側の安定待ちを理由に震度を止めてはならない（「震度は
            // 階級の確定を待たない」非対称ルール。§6「震度と階級の確定タイミングの同期」）。
            //
            // 引き上げ方向だけを見る。引き下げの安定待ちで止めると、下がった値は読まない方針
            // （黙る）と噛み合って、確定済みの値がいつまでも声にならない。
            const pendingScaleCycle = eewScaleStabilityRef.current.get(key)
            if (pendingScaleCycle && isForecastScaleHigher(pendingScaleCycle.scaleInfo, confirmedScale)) {
              log.debug('[eew] より高い予想震度の確定を待つため phase2 を降りる', key)
              return null
            }
            // 確定した階級と「程度以上」。既読の比較・表示に使う値は階級の数値だけで、
            // 「程度以上」は語を添えるためだけに持つ。
            const confirmedLpgmInfo = eewConfirmedLpgmRef.current.get(key)
            const confirmedLpgm = confirmedLpgmInfo?.cls ?? 0
            // 区分は引き下げない。一度「警報」と伝えた EEW は、以後 severity が落ちても
            // 「伝え済み」として扱う（前置きを言い直さない。activeEEWLevelsRef の Math.max と同じ方針）。
            const { level, spoken: spokenLevel, upgraded: levelUpgraded } = levelUpgradeOf(latest)
            // まだ一度も予想値を読んでいなければ無条件に読む（初報・震源更新の読み直し）。
            // 読んだ後は、実際に発話した値より上がったものが一つも無ければ黙る（引き下げは追わない）。
            if (eewPhase2DoneRef.current.has(key)
              && !isForecastScaleHigher(confirmedScale, spokenEEWScalesRef.current.get(key))
              && !isForecastLpgmHigher(
                { cls: confirmedLpgm, over: confirmedLpgmInfo?.over === true },
                spokenEEWLpgmClassesRef.current.get(key),
              )
              && level <= spokenLevel) return null
            // 「緊急地震速報に切り替わりました。」は、予報として発報されたものが警報へ
            // 上がったときだけ。初報から警報なら第 1 フェーズが「緊急地震速報、〇〇で地震。」と
            // 伝えており（そのとき spokenEEWLevelsRef を埋めている）、重ねて言う意味がない。
            // **「格上げが起きたか」と「格上げを言葉にするか」を分ける。**
            //
            // 前者（`levelUpgraded`）は何を読むかを決める —— 下の `scaleUnchanged` が偽になり、
            // 震度を含めて全文を読み直す。後者は前置きの語を付けるかだけ。第 1.5 フェーズが
            // 先に前置きを声にしていれば語は譲るが、**値の読み直しまで譲ってはいけない**
            // （「何の震度で警報になったか」の再確認が消える）。
            const announceUpgrade = levelUpgraded && !spokenEEWUpgradePhraseRef.current.has(key)
            // 震度が実際に声に出た値（spokenEEWScalesRef）とちょうど一致していて、区分格上げの
            // 前置きも無いなら、震度は繰り返さず階級部分だけを読む。震度自体が上がった・下がった
            // 場合や、区分格上げに伴う場合はこれまでどおり震度も含めて全文を読み直す
            // （区分格上げは「何の震度で警報になったか」を再確認させる意味があるため省略しない）。
            const spokenScale = spokenEEWScalesRef.current.get(key)
            const scaleUnchanged = !levelUpgraded && eewPhase2DoneRef.current.has(key)
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
            // **震度を伝えられない報で階級だけ確定するのは電文の異常**（最大予測震度は必須要素・
            // 長周期地震動階級は任意なので、この組み合わせは作れない。判定は `canPresentLpgmClass`）。
            // 黙って落とさず記録に残す。この後の扱いは経路で分かれる——`eewLpgmOnlyText` 単体の
            // 経路は読むものが無くなるので降り、`eewIntensityText` の経路は震度の文
            // （「予想震度なし」）が残るので続行し、同じ述語で階級句だけが落ちる。
            if (confirmedLpgm > 0 && !canPresentLpgmClass(confirmedScale.scale, confirmedLpgm)) {
              log.warn('[eew] 想定外: 震度を伝えられない報で階級だけ確定した', key, confirmedLpgm)
              if (scaleUnchanged) return null
            }
            // 階級を読まない設定では、階級だけを読む経路に読むものが残らない（`eewLpgmOnlyText`
            // が空文字を返し、下の「想定外」警告へ落ちる）。上の `confirmedLpgm === 0` と
            // 同じ扱いで降りる。震度が動いた報は `eewIntensityText` の経路なので影響しない。
            //
            // **このガードは上の異常検知より後ろに置くこと。** 前へ出すと、設定を切った端末では
            // 「震度を伝えられないのに階級だけ確定した」という電文の異常が一度も記録されない
            // （発話の結果は同じなので画面にも出ず、後から原因を追えなくなる）。
            if (scaleUnchanged && !settings.ttsReadEewLpgmClass) return null
            const text = scaleUnchanged
              ? eewLpgmOnlyText(confirmedLpgm, confirmedLpgmInfo?.over === true)
              : eewIntensityText(confirmedScale, confirmedLpgm, latest, announceUpgrade, confirmedLpgmInfo?.over === true, ttsRegionOptions(settings))
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
            //
            // **階級は「実際に声に含めた分」だけ記録する。** 上のガードに掛かった報（震度を
            // 伝えられないのに階級だけ確定した＝電文の異常）では `eewIntensityText` が階級句を
            // 落とすため、`confirmedLpgm` をそのまま入れると言っていない値が既読になる。
            //
            // **階級を読まない設定のときも同じ。** 震度が動いた報は `eewIntensityText` の経路を
            // 通って階級句だけが落ちるので、`confirmedLpgm` をそのまま記録すると「言っていない値」
            // が既読に入る。判定は `eewIntensityText` が使うものと同値に保つこと。
            //
            // **これは不変条件を守るための修正で、到達できる実害は見つかっていない。**
            // 既読の階級は早期 return の判定（`isForecastLpgmHigher`）にしか使わず、そこで差が
            // 出るのは「震度も階級も据え置きの続報」だけ。その報では値が変わらないので
            // `confirmLpgm` が呼ばれず第 2 フェーズの予約自体が作られない。**そのため回帰テストを
            // 書けていない**（落ちないテストは、守っているように見えるぶん無いより悪い）。
            const spokenLpgm: EewMaxLpgmClassInfo = settings.ttsReadEewLpgmClass
              && canPresentLpgmClass(confirmedScale.scale, confirmedLpgm)
              ? { cls: confirmedLpgm, over: confirmedLpgmInfo?.over === true }
              : { cls: 0, over: false }
            // 1 音も鳴らなかったときに戻せるよう、書き換える前の値を控える（下の `onSettled`）。
            const prevSpokenScale = spokenEEWScalesRef.current.get(key)
            const prevSpokenLpgm = spokenEEWLpgmClassesRef.current.get(key)
            const prevSpokenLevel = spokenEEWLevelsRef.current.get(key)
            const wasPhase2Done = eewPhase2DoneRef.current.has(key)
            /**
             * より高い震度の確定を待つため、**鳴っている途中で**残りのチャンクを降りたか
             * （下の `shouldStillPlay`）。既読を戻すかの判断に使う（下の `onSettled`）。
             */
            let yieldedToPendingScale = false
            spokenEEWScalesRef.current.set(key, confirmedScale)
            spokenEEWLpgmClassesRef.current.set(key, spokenLpgm)
            spokenEEWLevelsRef.current.set(key, level)
            eewPhase2DoneRef.current.add(key)
            return {
              text,
              /**
               * 1 音も鳴らなかったなら、上で進めた既読をすべて戻す。
               *
               * 合成が 1 つも成功しない場合（VOICEVOX 未起動・瞬断）でも発話は正常終了するため、
               * 戻さないと**声になっていない予想値が基準になり**、次の続報で同じ値が「据え置き」と
               * 判定されて黙る。`eewPhase2DoneRef` も戻す —— 立ったままだと「一度は読んだ」扱いで
               * 上がった分しか読まなくなる。
               *
               * **発話の差になるのは、震度が据え置きのまま階級だけ確定する続報。** 戻さないと
               * 声になっていない予想震度が「伝え済み」になって下の `scaleUnchanged` が真になり、
               * 続報が「予想最大階級3。」という短句へ落ちる —— その EEW では予想震度が一度も
               * 声にならない。震度そのものが動いた続報では、戻っていてもいなくても全文を読み直す
               * ので差が出ない。回帰テストは `useLiveEventHandler.eewTts.test.ts` の「合成が
               * 1 音も鳴らなかったとき」の describe（巻き戻しの不変条件そのものは
               * `rollbackSpoken.test.ts`）。
               *
               * `eewPhase2DoneRef` だけは Set なので「自分が立てたか」を値で照合できず、
               * 直前の状態（`wasPhase2Done`）で判断している。予約はトークンで 1 件に限られ、
               * チェーンは直列なので、同じ鍵へ別の第 2 フェーズが割り込む余地は無い。
               *
               * **より高い震度の確定を待って途中で降りた場合も戻す**（`yieldedToPendingScale`）。
               * 1 音は鳴っているが**文の残りは声になっていない**ので、そのまま既読にすると
               * 言っていない値を基準にしてしまう。多くの場合は待っていた高い震度が確定して
               * 全文を読み直すが、**その値が確定せず別の値へ変わる続報**（2024/01/01 能登本震の
               * 第 13 報のような 6強 → 7 → 6強。安定待ちのサイクルは値が変わるたび張り替わるので、
               * 譲った先の値が確定するとは限らない）では震度も階級も据え置き・引き下げの判定に
               * なって黙るため、戻さないとその EEW で階級が一度も声にならない。
               *
               * **どのチャンクまで鳴ったかは発話側から分からない**ので、値（震度・階級）は進めた分を
               * まとめて戻し、読む側へ倒している（同じ値を読み直すことはあっても、声にならないより軽い）。
               *
               * **ただし区分（`spokenEEWLevelsRef`）は、途中で降りた場合は戻さない。** 値の再読みと
               * 違い、前置き「緊急地震速報に切り替わりました。」は**その EEW で一度だけ**の遷移の
               * 告知で、文の**先頭**チャンクにある —— 1 音でも鳴っていれば声になっている。戻すと
               * `levelUpgraded` が再び真になり、続く読み直しで前置きをもう一度言う（予報から警報へ
               * 上がった報の発話中に、さらに高い震度が安定待ちへ入ると起きる。第 1.5 フェーズが
               * 前置きを引き受けている場合は `spokenEEWUpgradePhraseRef` が抑えるが、警報の対象地方を
               * 読まない設定ではその歯止めが無い）。**1 音も鳴らなかった場合は従来どおり戻す** ——
               * そのときは前置きも声になっていない。
               *
               * **`spoke` は「1 チャンクでも鳴ったか」で、「前置きのチャンクが鳴ったか」ではない。**
               * 前置きは先頭チャンクなので通常は一致するが、そのチャンクだけ合成に失敗すると
               * （`utils/voicevox.ts` は失敗したチャンクを飛ばして次へ進む）声になっていないのに
               * 伝えた扱いになる。**第 1.5 フェーズの前置きの記録も同じ粒度**（あちらも `spoke` で
               * 判定する）なので、ここだけ細かくしても全体は揃わない。厳密にするならチャンク単位の
               * 通知（`ChunkScheduledListener`）を EEW の発話へ配線することになる。**見たうえで
               * 既存の粒度に合わせている。**
               */
              onSettled: (spoke) => {
                if (spoke && !yieldedToPendingScale) return
                rollbackSpokenEntry(spokenEEWScalesRef.current, key, confirmedScale, prevSpokenScale)
                rollbackSpokenEntry(spokenEEWLpgmClassesRef.current, key, spokenLpgm, prevSpokenLpgm)
                if (!spoke) rollbackSpokenEntry(spokenEEWLevelsRef.current, key, level, prevSpokenLevel)
                if (!wasPhase2Done) eewPhase2DoneRef.current.delete(key)
              },
              /**
               * チャンクを鳴らす直前に、この文面がまだ最新かを確かめる。降りる理由は 3 つ。
               *
               *   1. 誤報取消（訂正）が届いた
               *   2. この文面を作ったときより**高い値が確定した**
               *   3. この文面を作ったときより**高い震度が安定待ちに入った**（確定はまだ）
               *
               * 安定待ちを経てもなお、確定から発話までの合成の往復（実測 238〜697ms）と
               * チャンクの再生時間のあいだに次の報は届く。取り下げても取りこぼしにはならない ——
               * 上がった確定を受けた時点で次の第 2 フェーズが予約され、そちらが最新値を読む
               * （3 の担保は `enqueuePhase2` のガードに挙げた 4 通りと同じ）。
               *
               * **3 は `enqueuePhase2` が発話の順番が来た時点で見るものと同じ判定。** 鳴っている
               * 途中も同じ基準で見続けるためにここへも置く。無いと、震度の句を鳴らし終えた後に
               * 続く階級の句だけが古い震度の文脈で声になる（2024/11/26 22:47 石川県西方沖:
               * 震度4 で確定して読み始めた 1 秒後に 5弱 の報が届き、その安定待ち中に
               * 「予想最大震度4。予想最大階級1。」を読み切っていた）。**鳴り始めたチャンクは
               * 切らない**ので、既に声になった句はそのまま鳴り終わる。
               *
               * ここで「上がったときだけ」に限るのは、引き下げを追わない方針（黙る）と揃えるため。
               * 下がったことを理由に取り下げると、代わりに読むものが無く無音で終わる。
               * **待つのは震度だけ** —— 階級の安定待ちで震度の発話を止めてはならない
               * （「震度は階級の確定を待たない」非対称ルール）。
               *
               * 2 で見るのは**確定値**（`eewConfirmedScaleRef`）であって生イベントの最新値ではない。
               * 生の値で比べると、瞬間的に跳ねただけの報で取り下げてしまう。
               */
              shouldStillPlay: () => {
                if (eewRetractedKeysRef.current.has(key)) return false  // 誤報取消（訂正）
                const now = eewTtsEventsRef.current.get(key)
                // 自動解除で消えた場合は鳴らし続ける。発表は終わったが、読んでいる値は誤りではない
                if (!now) return true
                // 3: より高い震度が安定待ちに入った。**進めた既読は `onSettled` で戻す** ——
                // 文の残りは声になっていないので、そのままだと言っていない値が基準になる。
                const pendingScaleCycle = eewScaleStabilityRef.current.get(key)
                if (pendingScaleCycle && isForecastScaleHigher(pendingScaleCycle.scaleInfo, confirmedScale)) {
                  // 判定は 1 発話で何度も呼ばれるので、記録は降りた最初の 1 回だけ
                  if (!yieldedToPendingScale) {
                    log.debug('[eew] より高い予想震度の確定を待つため、残りのチャンクを降りる', key)
                  }
                  yieldedToPendingScale = true
                  return false
                }
                const nowScale = eewConfirmedScaleRef.current.get(key)
                if (!nowScale) return true
                const nowLpgm = eewConfirmedLpgmRef.current.get(key)?.cls ?? 0
                // 数値だけの比較で足りる（ここは「後から確定した値の方が低ければ取り下げる」判定）
                return !isForecastScaleHigher(nowScale, confirmedScale)
                  && nowLpgm <= confirmedLpgm
                  && computeSingleEEWLevel(now) <= level
              },
            }
          }, () => followSpeechTab('realtime', TAB_PRIORITY.eewUpdate))
        }

        /**
         * 震度の安定待ちサイクル・タイマーを終了する（後始末専用。確定処理は行わない）。
         *
         * **単体で呼ばないこと。** 捨てたサイクルは `confirmScale` に至らないため、同じイベント
         * 処理の中で確定経路（`confirmScale` / `updateScaleStability` / 理由不明タイマー）を
         * 張り直すか、「読まないことが正しい」場面であることが要る。第 2 フェーズは確定値より
         * 高い値が安定待ち中なら発話を降りるので（`enqueuePhase2` のガード）、張り直しを欠くと
         * その EEW の予想震度が無言のまま終わる。
         */
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
        const confirmLpgm = (info: EewMaxLpgmClassInfo) => {
          eewLpgmStabilityRef.current.delete(key)
          eewConfirmedLpgmRef.current.set(key, info)
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
        const updateLpgmStability = (info: EewMaxLpgmClassInfo) => {
          const same = (a: EewMaxLpgmClassInfo | undefined) => a != null && a.cls === info.cls && a.over === info.over
          const cycle = eewLpgmStabilityRef.current.get(key)
          if (cycle) {
            if (same(cycle.info)) return
          } else if (same(eewConfirmedLpgmRef.current.get(key))) {
            return
          }
          if (cycle) clearTimeout(cycle.timer)
          const since = cycle ? cycle.since : Date.now()
          const remainingMaxWaitMs = since + EEW_PHASE2_STABILITY_MAX_WAIT_MS - Date.now()
          const waitMs = Math.max(0, Math.min(EEW_PHASE2_LPGM_STABILITY_MS, remainingMaxWaitMs))
          const timer = setTimeout(() => confirmLpgm(info), waitMs)
          eewLpgmStabilityRef.current.set(key, { info, since, timer })
        }

        // 続報で震源が「まだ一度も声にしていない場所」へ動いたか（判定は `isUnannouncedHypocenter`。
        // 比較の相手は**その EEW で声にした震源の全部**で、直前の 1 つではない）。
        const hypoFarMoved = !isNew && isUnannouncedHypocenter(
          activeEEWAnnouncedHypocentersRef.current.get(key) ?? [],
          event.earthquake.hypocenter,
        )
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
        // 震源の言い直しと重なったときは**そちらに譲る**（`!hypoFarMoved`）。譲っても区分は
        // 遅れない —— 言い直しの予約は発話の直前に区分を決め直し、そこで警報だと分かれば
        // 「緊急地震速報、〇〇で地震。」として震源の言い直しを兼ねる（下記 `needsLead`）。
        // 鳴っているものを止めてまで別の発話を積む理由がない。
        //
        // 予約済みでまだ声になっていない言い直しがあれば重ねない（`restateToken`）。続報は
        // 密集するため、これが無いと同じ文言を何度も積む。
        const phase1Progress = eewPhase1ProgressRef.current.get(key)
        const restateAsWarning = !isNew && !hypoFarMoved && currentLevel >= 1
          && (spokenEEWLevelsRef.current.get(key) ?? 0) < 1
          && phase1Progress?.restateToken == null
          && phase1Progress?.speakingToken != null
        const needsPhase1 = isNew || hypoFarMoved || restateAsWarning

        // **第 1 フェーズの予約は key ごとに高々 1 件**（第 2 フェーズ・第 1.5 フェーズと同じ形）。
        //
        // 積み直しを許していたころは、震源が動くたびにチェーンへ 1 本ずつ積み上がっていた。
        // 速報の初期は震源推定が定まらないため、**電文が数秒で終えた推移を声が何十秒もかけて
        // 追いかけ、途中で捨てられた推定まで読み上げる**（2024-01-03 18:48 の実電文では
        // 「地震動予報、石川県能登地方」→「震源を更新、日本海中部」→「震源を更新、能登半島沖」→
        // 「震源を更新、石川県能登地方」の 4 連呼。2 番目は 0.3 秒で差し替わった推定で、
        // 4 番目は初報と同じ地名）。予想値の告知もそのぶん後ろへ押し出される。
        //
        // **積まない代わりに、待っている 1 件が発話の直前に最新の電文で読み直す。** 震源も
        // 区分もそこで決めるので、待っているあいだに届いた続報を取りこぼさない。
        if (needsPhase1 && !eewPhase1TokensRef.current.has(key)) {
          // 第 1 フェーズ。震源が大きく動いた場合は旧震源での値を基準に残さない。残すと新震源で
          // 確定した値が旧値を超えたときだけ報じられ、震源が変わったことに触れないまま終わる。
          //
          // **落とすのは予約を積むときだけ**（受信のたびではない）。予約が待っているあいだの
          // 続報でも落としていると、そのあと発話が黙る判断（下記）をしたときに落とした分が
          // 戻らず、**震源に触れないまま予想値だけが読み直される**。
          //
          // **消す前に控える。** この予約は発話の直前に「やはり言い直す必要が無い」と判断して
          // 黙ることがあり、そのときは第 2 フェーズの既読を元へ戻さないと、同じ「予想最大震度
          // 〇〇。」が理由の説明も無く二度読まれる（震源が未名乗りの場所へ一度動いてすぐ既知の
          // 場所へ戻る並びで起きる）。
          const phase2ReadBefore = {
            done: eewPhase2DoneRef.current.has(key),
            scale: spokenEEWScalesRef.current.get(key),
            lpgm: spokenEEWLpgmClassesRef.current.get(key),
          }
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
          /**
           * 上で落とした第 2 フェーズの既読を戻す。**黙ると決めたときだけ呼ぶ。**
           *
           * **戻すのは自分が落としたままのものだけ**（`rollbackSpokenEntry` と同じ方針）。
           * 待っているあいだに第 2 フェーズが新しい値を声にしていれば、そちらが正しい。
           *
           * **この「他が書いていたら触らない」側は、いまは到達しない。** 発話は 1 本のチェーンへ
           * 積んだ順に解決するので、この予約より後に積まれる第 2 フェーズが先に走ることはない
           * （取消・リセットは予約ごと降ろすので、そちらは下のトークン照合で弾かれる）。
           * **順序の前提が崩れたときの防御として残してある** —— 外すと、そのとき上書きの向きが
           * 静かに逆転する。
           */
          const restorePhase2Read = () => {
            if (phase2ReadBefore.done && !eewPhase2DoneRef.current.has(key)) {
              eewPhase2DoneRef.current.add(key)
            }
            if (phase2ReadBefore.scale && !spokenEEWScalesRef.current.has(key)) {
              spokenEEWScalesRef.current.set(key, phase2ReadBefore.scale)
            }
            if (phase2ReadBefore.lpgm && !spokenEEWLpgmClassesRef.current.has(key)) {
              spokenEEWLpgmClassesRef.current.set(key, phase2ReadBefore.lpgm)
            }
          }
          const phase1Token = {}
          eewPhase1TokensRef.current.set(key, phase1Token)
          // **`speakingToken` には触らない。** 鳴っているかどうかは予約の有無とは別の話で、
          // ここで消すと「鳴っていない」と誤認し、直後に警報へ上がっても言い直しが発火せず、
          // 告知が第 2 フェーズの前置きまで遅れる。
          if (restateAsWarning) updatePhase1Progress(key, { restateToken: phase1Token })
          // 後始末は**自分が置いた分だけ**。取消の後始末も同じ欄を触るので、無条件に消すと
          // 他が置いた記録まで落ちる（鳴っている記録が消えれば、鳴っていない相手への割り込みになる）。
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
            key,
            () => {
              // 自分が言い直しとして積まれていたなら、その予約はここで消化される。以後の格上げは
              // 改めて言い直せる（警報を読めば下で既読の区分が入るので既読側で弾かれ、取消で
              // 降りたなら言い直せる状態に戻るのが正しい）。**自分の分だけ降ろすこと**——
              // 無条件に消すと、他の予約が置いた言い直しの印まで落として二重読みに戻る。
              forgetOwnRestate()
              // 取消で予約ごと降ろされていたらここで黙る（Promise は途中で止められないため、
              // 識別子の一致で判別する。第 2 フェーズと同じ形）。
              if (eewPhase1TokensRef.current.get(key) !== phase1Token) return null
              eewPhase1TokensRef.current.delete(key)
              // 待っている間に取消・自動解除が届いていたら震源も読まない。鳴らし始めてから届いた
              // 場合に残りを落とすのは**誤報取消のときだけ**（理由は eewRetractedKeysRef の宣言箇所）。
              // ここでは `speakingToken` に触らない（鳴っているのは自分ではない別の予約）。
              const latest = eewTtsEventsRef.current.get(key)
              if (!latest) {
                // 想定外。取消・リセットはこの予約と電文を対で落とすので、上のトークン照合で
                // 先に弾かれているはず。無言で握り潰すと、震源も区分も声にならない理由が
                // どこにも残らない（第 2 フェーズの「想定外」と同じ扱い）。
                log.warn('[eew] 想定外: 第 1 フェーズの予約が残っているのに電文が無い', key)
                restorePhase2Read()
                return null
              }
              // **区分は発話の直前に決める。** 予約から声になるまでには前の発話の完了待ちと
              // 合成の往復（実測 238〜697ms）があり、その間にも続報は届く。受信時点で決めると、
              // 待っている間に警報へ上がっていても予報として読み、直後に「切り替わりました」を
              // 言う羽目になる。区分は引き下げない（spokenEEWLevelsRef の Math.max と同じ方針）。
              const level = Math.max(
                computeSingleEEWLevel(latest),
                spokenEEWLevelsRef.current.get(key) ?? 0,
              ) as 0 | 1 | 2
              // **震源も発話の直前に最新の電文から取る。** 受信した報の値で固定すると、待って
              // いる間に差し替わった推定（2024-01-03 18:48 の「日本海中部」は 0.3 秒で消えた）を
              // そのまま声にする。
              const latestHypo = latest.earthquake.hypocenter
              const prevAnnounced = activeEEWAnnouncedHypocentersRef.current.get(key)
              const announced = prevAnnounced ?? []
              // 区分を名乗るのは、その EEW で第 1 フェーズをまだ一度も声にしていないときと、
              // 警報へ上がったことをまだ伝えていないとき。後者では「緊急地震速報、〇〇で地震。」が
              // 震源の言い直しも兼ねる（同じ地名について「震源を更新」と重ねて読まない）。
              const spokenLevel = spokenEEWLevelsRef.current.get(key) ?? 0
              const needsLead = announced.length === 0 || (level >= 1 && spokenLevel < 1)
              // 名乗る必要が無いなら、**いま読もうとしている震源が本当にまだ声にしていない場所か**を
              // ここで確かめ直す。予約した時点では動いていても、順番が来るまでに既に名乗った場所へ
              // 戻っていることがある（速報の初期は区域の境目を往復する）。
              if (!needsLead && !isUnannouncedHypocenter(announced, latestHypo)) {
                restorePhase2Read()
                return null
              }
              // 切り出しの語で区分を伝える（予報＝地震動予報／警報＝緊急地震速報）。
              // 震源更新では区分に触れない（既に伝えてあり、変わったのは震源だから）。
              const kind = needsLead ? (level >= 1 ? 'warning' : 'forecast') : 'hypocenterUpdate'
              // **読み上げ文を先に作り、成功してから状態を書き換えること**（第 2 フェーズと同じ
              // 順序）。先に書き換えると、生成で例外が出たときに `onSettled` へ到達しないまま
              // catch へ落ち、「警報を伝えた」記録と「鳴っている」記録が残る。以後この EEW では
              // 言い直しも前置きも二度と成立せず、警報が永久に声にならない。
              const text = eewAlertToText(latest, kind)
              // 「緊急地震速報」と切り出した時点で警報だと伝えている。第 2 フェーズで格上げを
              // 読み直さないよう、既読の区分として記録する。記録しないと初報から警報だった
              // EEW でも「切り替わりました」と言ってしまう。**記録は発話の直前だけで行う**——
              // 予約の時点で記録すると、取消で声にならなかった区分まで伝え済みになり、以後
              // 格上げが一度も声にならない（第 2 フェーズが既読値の更新を発話直前に限るのと同じ理由）。
              const recordsLevel = needsLead && level >= 1
              const prevSpokenLevel = spokenEEWLevelsRef.current.get(key)
              if (recordsLevel) spokenEEWLevelsRef.current.set(key, level)
              // 声にする震源を記録へ積む。**位置が読めない報でも名前は積む** —— 名乗った事実は
              // 残り、その要素は距離の比較に参加しないだけ（`AnnouncedHypocenter`）。
              const known = hasKnownEpicenter(latestHypo.latitude, latestHypo.longitude)
              const nextAnnounced: AnnouncedHypocenter[] = [...announced, {
                name: latestHypo.name,
                lat: known ? latestHypo.latitude : null,
                lng: known ? latestHypo.longitude : null,
              }]
              activeEEWAnnouncedHypocentersRef.current.set(key, nextAnnounced)
              updatePhase1Progress(key, { speakingToken: phase1Token })
              return {
                text,
                shouldStillPlay: () => !eewRetractedKeysRef.current.has(key),
                onSettled: (spoke) => {
                  forgetSpeaking()
                  // 1 音も鳴らなかったなら「伝えた」ことにしない。残すと、その EEW では以後の
                  // 格上げが一度も声にならず、震源の言い直しも黙る（`rollbackSpokenEntry`）。
                  if (!spoke) {
                    if (recordsLevel) {
                      rollbackSpokenEntry(spokenEEWLevelsRef.current, key, level, prevSpokenLevel)
                    }
                    rollbackSpokenEntry(
                      activeEEWAnnouncedHypocentersRef.current, key, nextAnnounced, prevAnnounced,
                    )
                  }
                },
              }
            },
            () => followSpeechTab('realtime', isNew ? TAB_PRIORITY.eewUrgent : TAB_PRIORITY.eewUpdate),
            restateAsWarning,
          )
        }

        /**
         * 第 1.5 フェーズ（警報の対象地方）をチェーンの末尾へ予約する。
         *
         * **第 1 フェーズを積んだ直後に呼ぶ。** チェーンは積んだ順に解決するので、安定待ちが
         * 最短（300ms）で確定して `enqueuePhase2` が走っても、順序は 第1 → 第1.5 → 第2 になる。
         * 続報で地方が増えたときは第 1 フェーズを伴わないが、そのときは第 2 フェーズより後ろへ
         * 積まれる——実配信で地方が増えるのは 35 秒・59 秒後（能登本震）で、予想値の告知を
         * 待たせる関係にはならない。
         *
         * **読む中身は「電文の全地方 − 声にした地方」。** 電文が `LastKind` で示す「新規」は
         * 前報からの差分で、こちらが前報を取りこぼしていれば一緒に落ちる。
         */
        const enqueueWarningRegions = () => {
          if (!settings.ttsReadEewWarningRegions) return
          if (eewRegionTokensRef.current.has(key)) return
          const token = {}
          eewRegionTokensRef.current.set(key, token)
          chainEEWSpeech(key, () => {
            if (eewRegionTokensRef.current.get(key) !== token) return null
            eewRegionTokensRef.current.delete(key)
            // 取消・自動解除で消えていたら読まない（第 1・第 2 フェーズと同じ）。
            const latest = eewTtsEventsRef.current.get(key)
            if (!latest) return null
            const spoken = spokenEEWRegionsRef.current.get(key) ?? new Set<string>()
            // **発話の直前に最新の電文から取り直す。** 予約から声になるまでには前の発話の完了待ちと
            // 合成の往復があり、そのあいだにも続報は届く。
            //
            // **並びは標準順へ揃える**（`sortEewWarningRegions`）。電文の文書順は続報で入れ替わる
            // ため、そのまま読むと画面の並びと食い違う。
            const speaking = sortEewWarningRegions((latest.warningRegions ?? []).filter(r => !spoken.has(r)))
            if (speaking.length === 0) return null
            // **区分をまだ声にしていなければ、ここで前置きする。**
            //
            // 地方のブロックは警報級の報にしか入らないので、予報から警報へ上がった報では
            // この発話がその EEW で最初の「警報になった」告知になる。区分を第 2 フェーズの
            // 前置きだけに任せると、そちらは予想値の安定待ち（300ms〜5 秒）を経てから鳴るため、
            // 「〇〇では強い揺れに警戒してください。」が先に出て順序が入れ替わる。
            const announceUpgrade = levelUpgradeOf(latest).upgraded
              && !spokenEEWUpgradePhraseRef.current.has(key)
            const text = eewWarningRegionsText(speaking, spoken.size > 0, announceUpgrade)
            // **前置きは発話の直前に記録する**（第 1・第 2 フェーズと同じ規律）。
            //
            // 読み切ってから（`onSettled`）記録する形では**間に合わない**。チェーンの待ちには
            // 上限（`EEW_SPEECH_CHAIN_MAX_WAIT_MS`・8 秒）があり、この発話は地方を多く列挙する
            // ほど長くなる —— 上限を超えると第 2 フェーズが `onSettled` を待たずに走り出し、
            // 記録が空のまま「まだ区分を言っていない」と判定して前置きを重ねる。
            // 2024-06-03 06:31 の石川県能登（6 地方）が実際にそうなった。
            //
            // 記録してよいのは、この発話がこれから前置きを声にするときだけ（`announceUpgrade`
            // が既に「まだ記録されていない」ことを含んでいる）。鳴らなかった分は下の
            // `onSettled` で自分が書いたぶんだけ戻す。
            //
            // **読み上げ文を先に作り、書き換えはその後に置くこと**（第 1 フェーズと同じ順序）。
            // 間に例外を投げうる処理を挟むと、`return` に到達しないまま記録だけが残り、
            // `onSettled` も登録されないので二度と戻せない —— その EEW では以後、格上げが
            // 一度も声にならない。
            //
            // **第 2 フェーズはこの記録を書かない。** あちらは前置きを言うときに
            // `spokenEEWLevelsRef` を進めるので、そちらが「もう区分を伝えた」の歯止めになる
            // （`levelUpgradeOf` が偽を返す）。旗を 2 つとも書く形にはしていない。
            const recordsUpgrade = announceUpgrade
            if (recordsUpgrade) spokenEEWUpgradePhraseRef.current.add(key)
            // 鳴り始めてから地方が増えたら降りる（増えた分を含めて読み直すため）。降りた回を
            // 既読にしないよう、地方名の記録は `onSettled` で「降りていないとき」だけ行う。
            let abandoned = false
            // 降りた理由が誤報取消か（下の `onSettled`）。
            //
            // **この変数は現状のテストで守れていない。** 効くのは「取消を検知して降りた後、
            // `onSettled` が走る前に同じ eventId の報が届いて `eewRetractedKeysRef` が
            // 消される」という順序だけで、そこは偽タイマーの粒度では作れなかった（外しても
            // 全件通る）。**落ちないテストを書くより、守れていないことを書き残す方を採った。**
            // 残しているのは、取消の記録は次の報を受けた時点で必ず落ちる作りなので
            // （`eewRetractedKeysRef` の宣言箇所）、ref だけを見ると取り消された発話の
            // 記録が蘇る余地が残るため。
            let retracted = false
            return {
              text,
              shouldStillPlay: () => {
                // 取消でも「降りた」ことに変わりはないので `abandoned` も立てる（下の
                // `onSettled` は取消を先に見て降りるので読まれないが、降りたのに偽のまま
                // 残す方が後から読み違える）。
                if (eewRetractedKeysRef.current.has(key)) { abandoned = true; retracted = true; return false }
                const now = eewTtsEventsRef.current.get(key)
                // 自動解除で消えた場合は鳴らし続ける（第 2 フェーズと同じ。発表は終わったが、
                // 読んでいる地方が誤りだったわけではない）。
                if (!now) return true
                const grown = (now.warningRegions ?? []).some(r => !spoken.has(r) && !speaking.includes(r))
                if (grown) { abandoned = true; return false }
                return true
              },
              onSettled: (spoke) => {
                // **誤報取消を受けていたら何も記録しない**（前置きも地方名も）。取消は
                // その発話ごと無かったことにする側で、受信した時点で**同期に**既読を消して
                // いる（`eewRetractedKeysRef` の宣言箇所の少し下）。ここで書き戻すと消した
                // 記録が蘇り、同じ eventId で再発報したときに格上げも地方名も声にならない。
                //
                // **`retracted` だけでは足りない。** あれは `shouldStillPlay` の中でしか
                // 立たず、チャンクの切れ目でしか呼ばれない —— **最後のチャンクを鳴らして
                // いる最中に届いた取消は判定の機会が無い**まま `onSettled` へ来る。だから
                // 書き込む直前に最新の状態を見る。逆に `retracted` を落とせないのは、再発報が
                // `eewRetractedKeysRef` を消してから `onSettled` が走る順序がありうるため
                // （そのときは「この発話は取り消された」という事実がこちらにしか残らない）。
                // **前置きは、書いたぶんを戻すときだけここで触る。** 記録そのものは発話の
                // 直前に済ませてある（上の `recordsUpgrade`）。戻すのは**1 音も鳴らなかった
                // ときだけ** —— 声になっていないものを「伝えた」と扱うと、その EEW では
                // 格上げが一度も声にならない。
                //
                // **誤報取消ではここで消さない。** 取消は受信した時点で記録ごと消していて
                // （`eewRetractedKeysRef` の宣言箇所の少し下）、こちらの記録はその前に
                // 書かれているので既に消えている。重ねて消すと、**取消の直後に再発報した
                // 新しい発話が書いた記録まで巻き込む**（チェーンが追い越されると、古い発話の
                // `onSettled` が新しい発話の記録より後に走りうる）。
                //
                // **地方が増えて降りた回も戻さない。** 前置きは文の先頭チャンクなので、降りた
                // 時点では既に声になっている（第 2 フェーズが「区分の告知は戻さない」と
                // 判断しているのと同じ理由。`enqueuePhase2` の `onSettled` のコメント）。
                //
                // **`spoke` は「1 チャンクでも鳴ったか」で、「前置きのチャンクが鳴ったか」
                // ではない。** 前置きは先頭チャンクなので通常は一致するが、そのチャンクだけ
                // 合成に失敗すると（`utils/voicevox.ts` は失敗したチャンクを飛ばして次へ
                // 進む）声になっていないのに伝えた扱いになる。**第 2 フェーズの前置きの記録も
                // 同じ粒度**なので、ここだけ細かくしても全体は揃わない。厳密にするならチャンク
                // 単位の通知（`ChunkScheduledListener`）を EEW の発話へ配線することになる。
                // **見たうえで既存の粒度に合わせている。**
                if (recordsUpgrade && !spoke) spokenEEWUpgradePhraseRef.current.delete(key)
                const cancelled = retracted || eewRetractedKeysRef.current.has(key)
                // **誤報取消を受けていたら地方名も記録しない。** 取消はその発話ごと無かった
                // ことにする側で、書き戻すと再発報で地方名が声にならない（`enqueueWarningRegions`
                // の起動条件が「未読の地方があるか」なので、既読が残ると発話ごと立たない）。
                // **判定は発話中に立てたフラグと書き込む直前の状態の両方で行う** ——
                // `shouldStillPlay` はチャンクの切れ目でしか呼ばれないので、最後のチャンクを
                // 鳴らしている最中に届いた取消は捉えられない。
                if (cancelled) return
                // 地方の既読は、降りた回も 1 音も鳴らなかった回も進めない。前者は増えた分を
                // 含めて読み直すため、後者は声になっていないため。**前置きと条件が違うのは、
                // 地方名が文の後半にあって降りた時点では声になっていないから。**
                if (abandoned || !spoke) return
                const set = spokenEEWRegionsRef.current.get(key) ?? new Set<string>()
                speaking.forEach(r => set.add(r))
                spokenEEWRegionsRef.current.set(key, set)
              },
            }
          }, () => followSpeechTab('realtime', isNew ? TAB_PRIORITY.eewUrgent : TAB_PRIORITY.eewUpdate))
        }

        // 声にしていない地方が残っていれば積む。**第 1 フェーズの発火とは独立**——続報で地方が
        // 増えたときは第 1 フェーズを伴わない（震源が動いていないため）。
        if ((event.warningRegions ?? []).some(r => !(spokenEEWRegionsRef.current.get(key)?.has(r)))) {
          enqueueWarningRegions()
        }

        /**
         * 震度・長周期階級の安定待ちを更新する。第 1 フェーズを発火するかに関わらず統一的に行う
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
        updateLpgmStability(eewMaxLpgmClassInfo(event))
        if (severityUpgraded) {
          clearPhase2MaxTimer()
          confirmScale({ scale, orAbove: scaleOrAbove })
        } else if (scale > 0) {
          clearPhase2MaxTimer()
          updateScaleStability({ scale, orAbove: scaleOrAbove })
        } else if (eewNoForecastReason(event) !== 'unknown') {
          clearPhase2MaxTimer()
          confirmScale({ scale: 0, orAbove: false })
        } else {
          // 予想震度がまだ無く、付かない理由も判らない。
          //
          // **直前の続報までは scale>0 だった場合の後始末。** 一度 areas が付いた後の続報で
          // 再び scale=0（かつ理由不明）に戻ると、この分岐に初めて落ちる。ここで
          // 進行中の震度の安定待ちサイクルを明示的に破棄しないと、そちらのタイマーが
          // 生き残ったまま先に発火し、もう存在しないはずの古い震度で確定してしまう
          // （enqueuePhase2 は「上がった時だけ読む」判定のため、後から来る正しい
          // 「予想震度なし」への訂正が黙って弾かれ、誤った値が確定したまま残る）。
          // **破棄は確定済みかどうかに関わらず行う**——下の待ちを張らない場合も、古い
          // サイクルを残すと同じ誤確定が起きる。
          clearScaleStability()
          // 値が付いた続報で安定待ちへ回すが、最後まで付かないこともあるため上限で
          // 打ち切り、「予想震度なし」で確定する。
          //
          // **見るのは「確定したか」ではなく「確定値が既に『予想震度なし』か」。** 前者で
          // 判定すると、上の後始末（予想震度が有→無に戻った続報）で確定経路が一つも
          // 張られなくなり、`eewConfirmedScaleRef` に古い値が残ったままになる。気象庁が
          // 取り下げた予想震度を、以後の区分格上げで読み上げうる。
          //
          // 既に「予想震度なし」で確定しているなら、この待ちは何も読み上げない——同じ値で
          // 確定し直すだけで、`enqueuePhase2` の「上がった時だけ読む」判定に弾かれる。
          // それでも `speechBlocker` は待っている間ずっと `eewPhase2` を返すため、
          // **喋る予定が無いまま非 EEW の読み上げを 3 秒止める**ことになる。実害は
          // 「止める」だけでは済まない: 止められた側は「後から重い読み上げに追い越された」
          // と判定して取り下げる（`speakNonEEWDelayed`）ので、その電文は一言も鳴らない。
          // 2024/01/01 能登の再生では、予想震度が付かない別 EEW の第 4 報がこの待ちを
          // 張り直し、同時刻に届いた震度速報（最大震度6強）を丸ごと消していた。
          //
          // 確定後に予想震度が付いた続報が来た場合は上の `scale > 0` の枝が拾うので、
          // ここで待たなくても取りこぼさない。
          //
          // **`scale` だけ見れば足りるのは、`scale === 0` が常に `orAbove === false` を
          // 伴うから**（`eewMaxScaleInfo` は `orAbove` を `scale > 0` との論理積で作る。
          // 「震度なし以上」という値は作れない）。`eewConfirmedScaleRef` へ直接書き込む
          // 経路を足すときは、この前提が保たれることを確かめること——崩れると、訂正されない
          // `orAbove` を抱えたまま「最新の電文と一致している」と誤認する。
          if (!eewTtsMaxTimersRef.current.has(key)
            && eewConfirmedScaleRef.current.get(key)?.scale !== 0) {
            const maxTimer = setTimeout(() => {
              eewTtsMaxTimersRef.current.delete(key)
              confirmScale({ scale: 0, orAbove: false })
            }, EEW_PHASE2_MAX_WAIT_MS)
            eewTtsMaxTimersRef.current.set(key, maxTimer)
          }
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
      // **区域はカードの並びで挙げる**（`tsunamiCardBasis`）。上位 5 件しか出さないので、
      // 電文順（気象庁の地理順）で切ると、カードの先頭に並ぶ深刻な区域が通知から落ちる。
      //
      // **解除された区域（`cancelledAreas`）はここへ入れない。** 見出しはいま発表中の等級
      // （「津波注意報」等）なので、その下に解除された区域を並べると**まだ出ている**と読める。
      // 通知は「いま何が出ているか」を伝えるもので、区域ごとの移り変わりはカードと読み上げが担う。
      // **決めていないのではなく、入れないと決めている。**
      showBrowserNotification(
        tsunamiNotifyTitle,
        sortAreasAcrossGradesForCardDisplay(tsunamiCardBasis.areas, tsunamiCardBasis.observations)
          .slice(0, 5).map(a => a.name).join('、'),
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
        const prevGradeForSound = lastTsunamiGradeRef.current
        // 等級を伝えていない電文は比較から外す（理由は `isTsunamiObservationOnly`）。
        // 観測値だけが載っているので「更新」の扱いにする。
        const obsOnly = isTsunamiObservationOnly(event)
        const gradeUnchanged = obsOnly
          || (prevGradeForSound !== null && GRADE_PRIORITY[grade] === GRADE_PRIORITY[prevGradeForSound])
        const isDowngradeSound = !obsOnly && prevGradeForSound !== null && GRADE_PRIORITY[grade] < GRADE_PRIORITY[prevGradeForSound]
        // 読み上げの優先度・主題もこの判定に従う（宣言箇所に理由）。**引き下げは入らない**——
        // `isDowngradeSound` は `gradeUnchanged` と排他なので（等級が動いていない報と、下がった報）、
        // ここで除く必要はない。引き下げは等級が動いた報として新規・格上げと同じ重さで扱う
        // （音だけは同じ更新音を鳴らす）。
        // 区域単位の等級変化は**この報だけで判定できる**（`lastGrade` は電文が持つ事実で、
        // 前報の記憶に依存しない）。最上位が動いた報は従来の発表文・降格文が担当するので、
        // 新しい枝へ回すのは最上位が動いていない報だけに絞る。
        const hasAreaGradeChange = tsunamiAreaChanges.length > 0
        tsunamiIsObservationUpdate = gradeUnchanged && !hasAreaGradeChange
        tsunamiIsAreaGradeChange = gradeUnchanged && hasAreaGradeChange
        // **音は従来のまま更新音を鳴らす。** 一部解除は「まだ他の区域で続いている」状態なので、
        // 全解除の音（`tsunamiCancel`）を鳴らすと終わったと誤解させる。伝える役目は読み上げと
        // 表示に持たせている。
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
      // 本体が処理を打ち切った電文なので、本文だけを声にしない。
      skipTelegramTextRef.current = true
      return
    }
    // **カードが内容を採らない地震情報では、音も読み上げも起こさない**（印は入口で導出済み）。
    // 気象庁が書いた本文も声にしない —— 本体を伝えていないのに補足だけ読むことになる。
    //
    // **上の `if (!type)` へ相乗りさせない。** あちらは「音の種別が決まらない電文」の経路で、
    // 津波向けの分岐（新規発報のタブ要求）を通るうえ `return` するので、この下に増える処理が
    // あったときに黙って飛ぶ。
    if (quakeHeldBack) skipTelegramTextRef.current = true
    // **止めたことを残す。** タイトル側（上の quake 分岐）には記録があるのに、音と読み上げには
    // 無かった —— 「鳴らなかった」はいちばん体感される症状なのに、痕跡がどこにも出ない。
    // 受信側の記録は頻度の高い据え置き（発表時刻が古いだけ等）で黙るので、そちらと合わせても
    // 「この報で止めた」ことは追えない（→ `QuakeHoldBack.notable`）。
    if (quakeHeldBack) log.debug('[quake] カードが採らない電文なので音と読み上げを起こさない')
    if (settings.soundEnabled && !quakeHeldBack) playAlertSound(type)

    // VOICEVOX 読み上げ（新しい情報が来たら再生中を割り込み停止して読み直す）
    if (settings.voicevoxEnabled && !quakeHeldBack) {
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
      // 欠測として読み上げ文に含めた観測点。同じく発話を始める瞬間に既読へ移す。
      let spokenMissingObs: import('../types/earthquake').TsunamiObservation[] | null = null
      let spokenWarningLevelObs: import('../types/earthquake').TsunamiObservation[] | null = null
      // 最大波の観測時刻の更新として読み上げ文に含めた観測点。同じく発話を始める瞬間に既読へ移す。
      let spokenMaxHeightTimeObs: import('../types/earthquake').TsunamiObservation[] | null = null
      // 第1波（到達時刻・押し引き）を読み上げ文に含めた観測点。同じく発話を始める瞬間に既読へ移す。
      let spokenFirstWaveObs: import('../types/earthquake').TsunamiObservation[] | null = null
      // 満潮時刻・到達状況を声にする報か。立っていれば、発話を始める瞬間にその報の全地点を既読へ移す。
      let spokenTideAreas: readonly import('../types/earthquake').TsunamiArea[] | null = null
      /**
       * その読み上げが「**何も切らない**」ものか（伝える変化が無い、または軽い報）。
       *
       * 立つのは、観測波高・最大波の時刻・到達確認・欠測・第1波・等級のどれも動いていない報
       * だけ（満潮時刻の報と「変わりはありません」）。最大波の時刻だけが動いた報は**読む中身を
       * 持つ**のでここに入らない。最下位の層
       * （`SPEECH_PRIORITY.commentary`）で読むので、上位が鳴っている間は待ち、待ちきれなければ
       * 黙る。**満潮時刻の報は必ず等級の発表の 0〜60 秒後に届く**（実電文で 6 通すべて）ので、
       * ここを `normal` のままにすると、大津波警報の区域を読み上げている最中に
       * 「内容に変わりはありません」が割り込んで切ることになる。
       */
      let tsunamiSpeechIsQuiet = false
      // 既読へ移してよい等級変化。既定は今回の組すべて（下の `areasToMark` の説明を参照）。
      // **解除された区域だけは、読まなかった報では外す** —— 全体の等級も動いた報では発表文・降格文が
      // 区域を等級ごとに読み上げるが、解除された区域は `areas` に居ないのでそこに現れない。
      // 既読にすると、続報が同じ解除コードを載せ続けても二度と伝わらない。
      let speakableAreaChanges = tsunamiAreaChanges
      if (event.kind === 'quake' && !event.cancelled) {
        // **続報は変化したところだけを読む。** 基準は受信内容ではなく「声になった内容」で、
        // その更新は読み上げの完了時（下の `onSpokenRefs`）に行う。受信時に更新すると、
        // 割り込みで鳴らなかった地域が既読になり、二度と読まれない。
        //
        // **ただし差分を組む前に、進行中の読み上げの「ここまで鳴った分」を確定させる。**
        // 記録は完了時にしか進まないのに差分はここで同期に組まれるため、前の報を読み切る前に
        // 次が届くと「まだ何も声になっていない」古い状態を基準にしてしまい、**声にした内容を
        // 先頭から読み直す**。鳴っている最中のチャンクは
        // `spokenChunkIndices` が落とすので、途中で確定させても声にならなかった分は残らない。
        //
        // 主題では絞らない。別の地震・別の種別の読み上げでも、その記録を進めるのは正しい
        // （記録は主題ごとに分かれている）。津波など `onSpokenRefs` を渡さない経路では何もしない。
        activeNonEewSpeechRef.current?.flushSpoken()
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
        // **借りた震源はここへ持ち込まない。** 借りた値を声にするのは、それを運んできた津波電文の
        // 読み上げの側（`tsunamiToSegments`）で、地震情報の側では語らない（理由は
        // `buildEarthquakeSegments` の震度速報分岐）。
        //
        // **持ち込むと、語らないのに副作用だけが残る。** `earthquakeToSegments` は震源を
        // 区域の選抜へも渡していて（`selectRegionNames`）、座標が入ると並びが気象庁の標準順から
        // **震源距離順**へ反転する。読む区域と「ほか○地域」へ丸める区域の集合まで変わるので、
        // 「震源を持たない電文は距離で選ばない」という決まり（docs/spec/audio-tts-spec.md §4）に
        // 反する ―― 震度速報が津波から震源を借りた瞬間だけ、区域の選び方が静かに変わっていた。
        ttsSegments = earthquakeToSegments(event, ttsRegionOptions(settings), isNewQuake, quakeSpokenState, readAllRegions)
        ttsText = joinSegments(ttsSegments)
      } else if (event.kind === 'tsunami') {
        // 津波の読み上げは**原因地震の震源**を語りうる（→ `ttsText.ts` の
        // `sourceHypocenterSegments`）。語ってよいか・語ったことをどこへ記録するかは
        // **その地震の既読**が決めるので、津波の主題ではなく地震の主題で引く。
        //
        // **記録は地震ごとに種別を跨いで共有する。** これを引いておくと、津波で震源を伝えた
        // あとに届く地震情報が震源を言い直さない（`applySpokenRefs` が走るのは下の投入箇所で、
        // `quakeSpokenState` が非 null のときだけ）。
        //
        // **カードがあればその `eventKey` を使う。** DMDATA ではどちらも `eventId` だが、
        // 暫定 EventID の採り直しがあった地震ではカード側が統合で安定した鍵を持っている。
        // カードがまだ無いのは津波が先に届いた順序で、そのときは電文の `eventId` で足りる。
        if (!event.cancelled && event.eventId) {
          const card = earthquakesRef.current.find(q => extractQuakeEventIdFromId(q.id) === event.eventId)
          quakeSpokenState = quakeSpokenStateFor(
            spokenQuakeStatesRef.current,
            `quake:${card ? quakeEventKey(card) : event.eventId}`,
          )
          // **震源を語っているあいだ、その地震のカードを見せる**ための主題（→ `ttsFollow.ts` の
          // `hasBorrowedHypocenterFollowTarget`）。**カードがあるときだけ立てる** —— 津波が先に
          // 届いた順序ではまだ画面にカードが無く、見せる相手がいない（そのときは震源を語る前に
          // 地震電文が届き、次の報から追従できる）。
          if (card) quakeSubjectKey = quakeEventKey(card)
        }
        /**
         * 今回の電文が運んできた観測点を、**カードの並び**で返す。
         *
         * 並べ替えの材料はカードと同じもの（`tsunamiCardBasis`）を使う。並びを得たあと、今回の
         * 分だけをオブジェクトの同一性で絞り込む（マージは今回の要素をそのまま持つ）。
         */
        const observationsInCardOrder = (e: JMATsunami): TsunamiObservation[] => {
          const own = e.observations ?? []
          if (own.length === 0) return []
          // 基準が引けないと電文順のまま読む。**黙って落ちないよう記録する** ―― カードの並びと
          // 食い違えば追従スクロールが往復するので、往復を見たときに原因を辿れるようにする。
          if (tsunamiCardBasis.areas.length === 0) log.info('[tsunami] 観測点の並びの基準となる区域が無い（電文順で読み上げる）')
          const ownSet = new Set(own)
          return sortObservationsForCardDisplay(tsunamiCardBasis.observations, tsunamiCardBasis.areas)
            .filter(o => ownSet.has(o))
        }
        const currentGrade = tsunamiMaxGrade(event)
        const prevGrade = lastTsunamiGradeRef.current

        // 等級が動いていない続報（区域が空の電文を含む）は観測点更新として扱う。降格の側へ流すと、
        // 警報の発表中に全解除の文言を読み上げる（理由は `isTsunamiObservationOnly`）。
        // 判定は音の種別と共有する（`tsunamiIsObservationUpdate` の宣言箇所）。
        /**
         * その欠測を声にする価値があるか。
         *
         * 「一度も声にしていない欠測」だけでは足りない。**欠測のまま「これまでの最大波」の値が
         * 上がる続報がある**（断続的な欠測。気象庁は `MaxHeight` を `Revise`「更新」で送り直す）。
         * 名前だけで既読を判定すると、最初の欠測報のあとに届いたより深刻な値が一度も伝わらない。
         * 波高更新の側は欠測を除外しているので、拾うのはここだけ。
         */
        const isMissingWorthSpeaking = (o: import('../types/earthquake').TsunamiObservation): boolean => {
          if (!isObservationMissing(o)) return false
          if (!spokenObsMissingRef.current.has(o.name)) return true
          return hasObservedHeightRisen(o, spokenObsHeightRef.current)
        }
        /**
         * 「観測中のまま津波警報に相当する津波を観測している」と読む対象か。
         *
         * 名前で 1 度きり。**波高で読み直す仕組みは持たない**（この状態の観測点は定義上
         * 数値を持たないため、比べるものが無い）。欠測のように「より深刻な値が後から来る」
         * ことは起きない。
         */
        const isWarningLevelWorthSpeaking = (o: import('../types/earthquake').TsunamiObservation): boolean =>
          isWarningLevelWhileObserving(o) && !spokenObsWarningLevelRef.current.has(o.name)
        /**
         * 「到達確認」として読む対象か。**3 つの経路（観測情報の続報・区域単位の等級変化・
         * 全体の等級変化）で同じ述語を通すこと。** 同じ条件を書き写すと、条件が増えたときに
         * 片方だけ直して黙って食い違う。
         *
         * 除くもの:
         * - 波高がある … 波高更新の文が読む
         * - 欠測 … 「到達を確認しました」は到達の断定なので当てられない
         * - 観測中のまま津波警報相当 … 専用の文が「観測しています」と言うので二重になる
         * - 既読
         */
        const isArrivalWorthSpeaking = (o: import('../types/earthquake').TsunamiObservation): boolean =>
          !o.height && !isObservationMissing(o) && !isWarningLevelWhileObserving(o)
          && !spokenObsNamesRef.current.has(o.name)
        // 観測状態の変わり目を記憶へ反映する（規則は `forgetSpokenOnObservationStateChange`）。
        // 障害の復旧と再発は同じ津波の最中にも起きうるので、両方向を落とす。
        forgetSpokenOnObservationStateChange(
          event.observations ?? [],
          spokenObsNamesRef.current,
          spokenObsMissingRef.current,
          spokenObsWarningLevelRef.current,
        )
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
            // **欠測は除く。** 値を持つ欠測（電文が載せる「これまでの最大波の高さ」）は下の
            // 欠測の文が担当する。除かないと同じ観測点・同じ値が「新たに◯◯で1.2メートルを
            // 観測しました」と「これまでに◯◯で1.2メートルを観測したのち、欠測となっています」の
            // 両方で読まれ、いま観測できているのかどうかが伝わらない。件数上限の枠も二重に消費する。
            if (isObservationMissing(o)) return false
            return hasObservedHeightRisen(o, prevMap)
          })
          // 波高未確定（観測中）のまま新規に到達が確認された観測点は「到達確認」として読み上げる。
          // **欠測は外す**（`isObservationMissing`）――「到達を確認しました」は到達の断定なので、
          // 観測データが届いていない観測点に当ててはいけない。
          const newlyArrivedObs = obsInCardOrder
            .filter(o => isArrivalWorthSpeaking(o))
          // 読み上げる欠測。**波高の有無で絞らない**（電文は欠測と同時に「これまでの最大波の
          // 高さ」を載せることがあり、その値も読み上げに乗せる）。
          const newlyMissingObs = obsInCardOrder.filter(o => isMissingWorthSpeaking(o))
          /**
           * 波高は据え置きのまま最大波の観測時刻だけが動いた観測点（→ `hasMaxHeightTimeChanged`）。
           *
           * **同じ報で波高が上がった観測点がいても譲らない。** かつては波高の文があるときだけ
           * この群を落としていたが、譲られた側は**丸めの中で育っている**という事実を運んでいる
           * ―― 電文の波高は 0.1m 刻みなので、実測が上がっても表示が動かない間は時刻だけが進む。
           * 2024 年能登半島地震の 1 日で、この形は 34 回あり、そのうち 28 回（82%）はその後に
           * 波高が階級をまたいで上がった。**収束の印ではなく継続の印**なので落とさない。
           *
           * **対象はその報自身が載せた観測点だけ。** `obsInCardOrder` が既にそう絞っている ——
           * カードの並び（前報からマージ済み）へ差し替えたあと、`event.observations` の要素と
           * **参照で**照合しているため（`observationsInCardOrder`）。持ち越された観測点は古い
           * `Revise` と時刻を持ったままなので、混ざれば「この報は何も言っていないのに時刻が
           * 更新された」と読むことになる。**あの照合を名前や複製へ変えるなら、ここで絞り直すこと。**
           */
          const timeUpdatedObs = obsInCardOrder.filter(o => hasMaxHeightTimeChanged(o, prevMap, spokenObsMaxHeightTimeRef.current))
          /**
           * 第1波の内容が声にした分から変わった観測点（気象庁の訂正。`FirstHeight/Revise` = 更新）。
           *
           * **織り込める初出はここへ入れない。** 初出の第1波は波高の文
           * （`tsunamiObservationUpdateToSegments`）か到達確認の文へ織り込まれる —— 別の文に
           * すると、観測点が初めて現れる報で同じ地点名を 2 回読むことになる。
           *
           * **ただし「どちらにも織り込めない初出」がある。** `FirstHeight` が `Condition`
           * 「第１波識別不能」だけだった観測点が、続報で到達時刻を得る形（テストボタンの
           * 久慈港がこれ）。波高が上がらなければ `updatedObs` に入らず、`height` を持つので
           * `newlyArrivedObs` にも入らない。**これを拾わないと、その地点の第1波は一度も声に
           * ならないうえ記録も空のままなので、以後の本物の訂正まで永久に読めなくなる**
           * （`prev` が `undefined` から動かないため）。初出と訂正で文型が違うので群を分ける。
           */
          const firstWaveFoldedIn = new Set([...updatedObs, ...newlyArrivedObs])
          const firstWaveChanged = obsInCardOrder.filter(o => {
            const key = firstWaveSpokenKey(o)
            if (!key) return false
            // その報で波高の文・到達確認の文へ織り込まれる地点は、そちらが読むので外す。
            //
            // **ただし外すのは初出だけ。** 織り込みの句は「〜に◯◯波が到達し」という初出の
            // 言い回しなので、訂正（前に別の内容を声にした地点）をそこへ任せると訂正だと
            // 聞き分けられない。加えて、織り込む側は既読の地点を落とすため、**訂正がどの文からも
            // 落ちたまま既読になる**（記録は選抜した分をまとめて進める）。訂正はここで拾う。
            if (firstWaveFoldedIn.has(o) && !spokenObsFirstWaveRef.current.has(o.name)) return false
            return spokenObsFirstWaveRef.current.get(o.name) !== key
          })
          const firstWaveNewObs = firstWaveChanged.filter(o => !spokenObsFirstWaveRef.current.has(o.name))
          const firstWaveUpdatedObs = firstWaveChanged.filter(o => spokenObsFirstWaveRef.current.has(o.name))
          // 第 4 引数の `prevMap` が「新たに」と「更新」の言い分けを決める（読み上げ用の記憶を
          // 渡すこと。理由は `SpokenHeightLookup` の宣言箇所）。件数上限は既定のままなので
          // 第 3 引数は省略の意で undefined を渡す。第 5 引数は第1波を織り込むかの判定で、
          // **第 6 引数は最大波の観測時刻を添えるかの判定**（前に声にしたものと同じなら添えない）。
          const updateSegments = updatedObs.length > 0
            ? tsunamiObservationUpdateToSegments(
                updatedObs, event.headline, maxObsPoints, prevMap,
                spokenObsFirstWaveRef.current, spokenObsMaxHeightTimeRef.current,
              )
            : []
          const timeSegments = tsunamiMaxHeightTimeToSegments(timeUpdatedObs, maxObsPoints)
          // **初出と訂正は文型が違うので別の文にする**（初出＝「〜に押し波を観測しました」／
          // 訂正＝「〜の押し波へ更新されました」。助詞は述語で決まる）。
          const firstWaveSegments = joinWithAlso(
            tsunamiFirstWaveToSegments(firstWaveNewObs, 'new', maxObsPoints),
            tsunamiFirstWaveToSegments(firstWaveUpdatedObs, 'updated', maxObsPoints),
          )
          const arrivalSegments = tsunamiArrivalToSegments(newlyArrivedObs, maxObsPoints, spokenObsFirstWaveRef.current)
          const missingSegments = tsunamiMissingToSegments(newlyMissingObs, maxObsPoints)
          // 数値が無いので他のどの文にも乗らない（→ `tsunamiWarningLevelToSegments`）。
          const newlyWarningLevelObs = obsInCardOrder.filter(o => isWarningLevelWorthSpeaking(o))
          const warningLevelSegments = tsunamiWarningLevelToSegments(newlyWarningLevelObs, maxObsPoints)
          // 波高の文・到達確認の文・欠測の文はそれぞれ別の話題。接続語なしで並べると切れ目が
          // 耳で分からない（どれも「地名で〜しています」の形になる。理由は `joinWithAlso`）。
          // **確定した事実を先に、観測できていないものを後に**置く。
          // **群の並びは「確定した事実 → 観測できていないもの」。** 波高の更新 → 最大波の時刻
          // だけの更新 → 警報相当 → 到達確認 → 第1波の訂正 → 欠測。
          const rest = [timeSegments, warningLevelSegments, arrivalSegments, firstWaveSegments, missingSegments]
            .reduce((acc, seg) => joinWithAlso(acc, seg), [] as typeof timeSegments)
          if (updateSegments.length > 0) {
            // 名乗り（「津波観測情報。」）は波高の文が自前で持つ（`tsunamiObservationUpdateToSegments`）。
            ttsSegments = joinWithAlso(updateSegments, rest)
          } else if (rest.length > 0) {
            // 波高の文が無い電文では名乗りが誰も付けないので、ここで足す。
            ttsSegments = [plain('津波観測情報。'), ...rest]
          }
          // **最大波の時刻だけが動いた報も、他の観測情報と同じ層で読む。** かつて最下位に
          // 置いていたのは「伝える変化が無い報」だったからで、いまは新しい観測時刻という
          // 中身を読む —— 読み上げるものを持つ報を「何も切らない」層に置く理由は無い。
          // **既読にするのは実際に読み上げた分だけ。** 更新点は件数上限で絞られるため、
          // `updatedObs` を丸ごと既読にすると、読まれなかった観測点の値が二度と読まれない
          // （絞り込みは読み上げ文の生成と同じ関数を使う）。
          if (ttsSegments) {
            // 到達確認も件数上限で落ちる。**落ちた分を既読にしてはいけない**（絞り込みは
            // 読み上げ文の生成と同じ関数を使う。理由は `selectArrivalsToSpeak` の宣言箇所）。
            spokenObs = [...selectObservationUpdatesToSpeak(updatedObs, maxObsPoints), ...selectArrivalsToSpeak(newlyArrivedObs, maxObsPoints)]
            // 欠測も件数上限で落ちる。**落ちた分を既読にしない**（絞り込みは読み上げ文の生成と
            // 同じ関数を使う。理由は `selectMissingToSpeak` の宣言箇所）。
            spokenMissingObs = selectMissingToSpeak(newlyMissingObs, maxObsPoints)
            // 件数上限で落ちた分は既読にしない（欠測・到達確認と同じ規則）。
            spokenWarningLevelObs = selectWarningLevelToSpeak(newlyWarningLevelObs, maxObsPoints)
            // 最大波の時刻だけの更新も同じ規則（この報で読んだ分だけ）。
            spokenMaxHeightTimeObs = selectMaxHeightTimeUpdatesToSpeak(timeUpdatedObs, maxObsPoints)
            /**
             * 第1波を声にした観測点。**初出（波高の文・到達確認の文へ織り込んだ分）と
             * 訂正（第1波の文）の両方**を覚える —— 記憶は「その点の第1波を声にしたか」を
             * 問うもので、どの文で読んだかは関係ない。
             *
             * 織り込みは件数上限で落ちた地点には掛からないので、**上限で絞ったあとの集合**から
             * 数えること（`spokenObs` と同じ絞り込みを通す）。
             */
            spokenFirstWaveObs = [
              ...selectObservationUpdatesToSpeak(updatedObs, maxObsPoints),
              ...selectArrivalsToSpeak(newlyArrivedObs, maxObsPoints),
              ...selectFirstWaveUpdatesToSpeak(firstWaveNewObs, maxObsPoints),
              ...selectFirstWaveUpdatesToSpeak(firstWaveUpdatedObs, maxObsPoints),
            ]
          }
          if (!ttsSegments) {
            // ここまでで読む文が 1 つも無かった報。**従来はここで黙り、通知音だけが鳴っていた。**
            // 2024 年能登半島地震の 26 時間では、取消を除く津波電文 56 通のうち 7 通がこれ
            // （満潮時刻の報 6 通と、最大波の時刻だけが動いた観測報 1 通）。
            //
            // **伝えることが無いのか、伝える経路が無かっただけなのかを分ける。**
            if (isTideReport(event)) {
              // 各地の満潮時刻・津波到達予想時刻に関する情報。等級も観測波高も動かさないまま
              // 届くので、何が新しいかは `stations` を突き合わせないと判らない。
              //
              // **この種別も観測点を運ぶ**（2024 年能登半島地震の 6 通はいずれも 30〜31 件）。
              // 観測の変化がある報はここへ来ず、波高の文が読まれる —— そのとき満潮時刻は
              // 声にならず記憶も進まないので、**次の満潮時刻の報がその分をまとめて伝える**。
              ttsSegments = tsunamiTideToSegments(tideReportChange(event.areas, spokenTideRef.current), event.headline)
              spokenTideAreas = event.areas
              tsunamiSpeechIsQuiet = true
            } else if ((event.observations?.length ?? 0) > 0) {
              // 観測点は載っているのに、波高・最大波の時刻・到達確認・欠測・第1波のどれも
              // 動いていない報（それらは上の `rest` が拾うので、ここへは何も残っていない）。
              ttsSegments = tsunamiObservationNoChangeSegments()
              tsunamiSpeechIsQuiet = true
              // **観測点を 1 つも運ばない報では黙る**（従来どおり）。区域一覧だけを載せた報
              // （津波警報等・VTSE41）が既読の等級変化しか持たないときにここへ来るが、
              // その電文は観測波高について何も述べていない —— 「観測された波高に変わりは
              // ありません」と言うと、電文が言っていないことをアプリが言うことになる。
              // **言い切ってよい範囲は、その報が載せている事実まで。**
            }
          }
        } else if (tsunamiIsAreaGradeChange) {
          // 区域単位で等級が動いた報。**動いた区域だけを読む**（残っている区域はカードが示す）。
          // 全区域を挙げる発表文（`tsunamiToSegments`）へ流すと、2 区域が解除されただけの報で
          // 発表中の全区域を読み直すことになる。
          ttsSegments = tsunamiAreaGradeChangeToSegments(tsunamiAreaChanges)
          // 等級が動いた報と同じく、観測中（波高未確定）で新規に到達が確認された観測点も併せて読む
          const obsOnAreaChange = observationsInCardOrder(event)
          const newlyArrivedObsOnAreaChange = obsOnAreaChange
            .filter(o => isArrivalWorthSpeaking(o))
          // 新たに欠測となった観測点も併せて読む（判定と理由は観測点更新の経路と同じ）。
          const newlyMissingObsOnAreaChange = obsOnAreaChange.filter(o => isMissingWorthSpeaking(o))
          const newlyWarningLevelObsOnAreaChange = obsOnAreaChange.filter(o => isWarningLevelWorthSpeaking(o))
          ttsSegments = joinWithAlso(
            [
              ...ttsSegments,
              ...joinWithAlso(
                tsunamiWarningLevelToSegments(newlyWarningLevelObsOnAreaChange, maxObsPoints),
                tsunamiArrivalToSegments(newlyArrivedObsOnAreaChange, maxObsPoints, spokenObsFirstWaveRef.current),
              ),
            ],
            tsunamiMissingToSegments(newlyMissingObsOnAreaChange, maxObsPoints),
          )
          // 等級の発表と同じ扱いで、既読にするのは到達確認と欠測だけ（実測値は読んでいない）
          spokenObs = selectArrivalsToSpeak(newlyArrivedObsOnAreaChange, maxObsPoints)
          spokenMissingObs = selectMissingToSpeak(newlyMissingObsOnAreaChange, maxObsPoints)
          spokenWarningLevelObs = selectWarningLevelToSpeak(newlyWarningLevelObsOnAreaChange, maxObsPoints)
        } else {
          const isDowngrade = prevGrade !== null && GRADE_PRIORITY[currentGrade] < GRADE_PRIORITY[prevGrade]
          // **区域の並べ替えにはカードと同じ材料を渡す**（`tsunamiCardBasis`）。等級を切り替える報は
          // 観測点をほとんど載せないため、電文の分だけで並べると読み上げが電文順（気象庁の地理順）に
          // 戻り、実測波高の順に並んでいるカードの上を追従スクロールが往復する。
          ttsSegments = isDowngrade
            ? tsunamiDowngradeToSegments(event, tsunamiCardBasis.observations)
            : tsunamiToSegments(event, tsunamiCardBasis.observations, quakeSpokenState ?? undefined, ttsRegionOptions(settings))
          // グレード変化と同時に観測中（波高未確定）で新規到達した観測点も読み上げに含める
          // （こちらもカードの並びに揃える。理由は観測点更新側と同じ）
          const obsOnGradeChange = observationsInCardOrder(event)
          const newlyArrivedObsOnGradeChange = obsOnGradeChange
            .filter(o => isArrivalWorthSpeaking(o))
          // 新たに欠測となった観測点も併せて読む（判定と理由は観測点更新の経路と同じ）。
          const newlyMissingObsOnGradeChange = obsOnGradeChange.filter(o => isMissingWorthSpeaking(o))
          const newlyWarningLevelObsOnGradeChange = obsOnGradeChange.filter(o => isWarningLevelWorthSpeaking(o))
          // **等級を語れない電文では到達確認を継がない。** 区域はあるのに等級が 1 つも取れない
          // （全区域が `Unknown`）電文もここへ来るが、引き下げ側は「津波警報等は全て解除されました」を
          // 返すため、継ぐと解除の直後に新たな到達を伝える矛盾した並びになる。**読まない分は既読にも
          // しない**ので、続く観測情報の続報で「津波観測情報。」の名乗り付きで読まれる。
          //
          // **この式が新規発表・格上げの側を巻き込むことはない。** そちらでは `Unknown` がここまで
          // 来ないため ―― 音の種別が決まらず上の `if (!type) return` で抜けるし、
          // `lastTsunamiGradeRef` は `Unknown` を覚えないので比較の基準にも混ざらない。
          // 種別の判定に「`Unknown` でも鳴らす」分岐を足すなら、ここも併せて見直すこと。
          const canTellGrade = currentGrade !== 'Unknown'
          // **解除された区域はこの文にも足す。** 発表文・降格文が挙げるのは `areas` に居る区域だけで、
          // 解除された区域はそこに現れない（`cancelledAreas`）。足さないと、全体の等級も同時に動いた
          // 報——2025-12-09T06:20 の「津波注意報を解除しました」がまさにこの形——で、解除された
          // 区域が声にも画面にも出ないまま既読になる。等級の話なので、観測点の話題より先に置く。
          const liftedChanges = canTellGrade ? tsunamiAreaChanges.filter(c => c.to === TSUNAMI_GRADE_LIFTED) : []
          // 読まない解除は既読にしない（宣言箇所の理由）。
          if (!canTellGrade) speakableAreaChanges = tsunamiAreaChanges.filter(c => c.to !== TSUNAMI_GRADE_LIFTED)
          ttsSegments = joinWithAlso(ttsSegments, tsunamiAreaGradeChangeToSegments(liftedChanges))
          // 等級の発表と到達確認は別の話題（観測情報の続報と同じ理由で「また、」を挟む）。
          ttsSegments = joinWithAlso(
            ttsSegments,
            canTellGrade
              ? joinWithAlso(
                joinWithAlso(
                  tsunamiWarningLevelToSegments(newlyWarningLevelObsOnGradeChange, maxObsPoints),
                  tsunamiArrivalToSegments(newlyArrivedObsOnGradeChange, maxObsPoints, spokenObsFirstWaveRef.current),
                ),
                tsunamiMissingToSegments(newlyMissingObsOnGradeChange, maxObsPoints),
              )
              : [],
          )
          // **等級の発表では観測点の実測値を読まない。** 読むのは区域の予想波高
          // （`tsunamiToSegments` → `areaHeightSentence`）で、観測点は区域の並べ替えにしか
          // 使わない。ここで観測点を既読にすると、一度も声に出していない実測値が既読になり、
          // 直後の観測情報で読まれなくなる。既読にするのは到達確認だけ。
          spokenObs = canTellGrade ? selectArrivalsToSpeak(newlyArrivedObsOnGradeChange, maxObsPoints) : []
          // 等級を語れない電文では欠測も読まないので、既読にもしない（到達確認と同じ扱い）。
          spokenMissingObs = canTellGrade ? selectMissingToSpeak(newlyMissingObsOnGradeChange, maxObsPoints) : []
          spokenWarningLevelObs = canTellGrade ? selectWarningLevelToSpeak(newlyWarningLevelObsOnGradeChange, maxObsPoints) : []
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
        //
        // **伝える変化が無い報だけは最下位へ落とす**（`tsunamiSpeechIsQuiet`）。あの層は
        // 「何も切らない」ことを保証していて、待ちきれなければ黙る。満潮時刻の報は必ず
        // 等級の発表の直後に届くので、`normal` のままだと大津波警報の読み上げを 90 秒後に
        // 割り込んで切る（→ 宣言箇所）。
        const speechPriority = tsunamiSpeechIsQuiet
          ? SPEECH_PRIORITY.commentary
          : event.kind === 'tsunami' && !tsunamiIsObservationUpdate
            ? SPEECH_PRIORITY.high
            : SPEECH_PRIORITY.normal
        // **変化を伝えない報は主題も分ける。** 層が違うものを同じ主題へ入れると、到来順の裁きが
        // 優先度を見ずに先発を取り下げる（→ `tsunamiObsQuiet` の宣言箇所）。
        const speechTopic: SpeechTopic = event.kind !== 'tsunami'
          ? quakeSpeechTopic
          : tsunamiSpeechIsQuiet
            ? (isTideReport(event) ? 'tsunamiTide' : 'tsunamiObsQuiet')
            : tsunamiIsObservationUpdate ? 'tsunamiObs' : 'tsunami'
        // クロージャで掴むため const に写す（`let` のままでは絞り込みが効かない）
        const obsToMark = spokenObs
        const missingToMark = spokenMissingObs
        const warningLevelToMark = spokenWarningLevelObs
        const maxHeightTimeToMark = spokenMaxHeightTimeObs
        const firstWaveToMark = spokenFirstWaveObs
        const tideAreasToMark = spokenTideAreas
        // 区域の等級変化も**発話を始める瞬間**に既読へ移す（観測点と同じ理由。待たされた末に
        // 見送られた変化は既読にならず、次の報でもう一度読み上げ対象に入る）。
        //
        // **専用の文を読んだ報だけに限らない。** 全体の等級が同時に動いた報では発表文・降格文が
        // 全区域を等級ごとに読み上げるので、動いた区域の「いまの等級」はそこで声になっている。
        // 限ってしまうと、次に全体が落ち着いた報で「〇〇から切り替えられました」を遅れて言い直す。
        //
        // **ただし「そこで声になっている」が成り立つのは `areas` に居る区域だけ。** 解除された区域は
        // 専用の文を足したときにしか声にならないので、`speakableAreaChanges` が外している
        // （宣言箇所の理由）。
        const areasToMark = speakableAreaChanges.length > 0 ? speakableAreaChanges : null
        const spokenState = quakeSpokenState
        speakNonEEWDelayed(
          ttsText,
          speechPriority,
          ttsDelayFor(type),
          speechTopic,
          { tab: followTab, priority: event.kind === 'tsunami' ? TAB_PRIORITY.tsunami : TAB_PRIORITY.quake },
          ttsSegments ?? undefined,
          // 地震情報は**読み終えたあと**に、実際に声になった分だけを記録する。
          spokenState ? refs => applySpokenRefs(spokenState, refs) : undefined,
          // 読み上げた観測点を既読へ移すのは**声に出す瞬間**（宣言は `spokenObsHeightRef`）。
          // 待たされた末に見送られた分は既読にならず、次の電文でもう一度読み上げ対象に入る。
          obsToMark || missingToMark || warningLevelToMark || areasToMark || maxHeightTimeToMark || firstWaveToMark || tideAreasToMark
            ? () => {
              if (obsToMark) {
                rememberObservations(obsToMark, spokenObsNamesRef.current, spokenObsHeightRef.current)
                // **波高の文を読んだ観測点は、その報が伝えた最大波の時刻も既読にする。**
                // 波高の文はその時刻を（前に声にしたものと違えば）読んでいるので、ここで記録
                // しないと同じ時刻を次の報でも読み直す。記録しないと「最大波の観測時刻が
                // 更新されました」の文でも読み直される（記録が無い＝変わった、と判定される）。
                for (const o of obsToMark) {
                  if (o.maxHeightDateTime) spokenObsMaxHeightTimeRef.current.set(o.name, o.maxHeightDateTime)
                }
              }
              // 最大波の観測時刻は**波高の記憶とは別の軸**なので、こちらだけを進める
              // （→ `spokenObsMaxHeightTimeRef`）。波高を触ると、同じ高さの波が次に来たときの
              // 判定が狂う。
              if (maxHeightTimeToMark) {
                for (const o of maxHeightTimeToMark) {
                  if (o.maxHeightDateTime) spokenObsMaxHeightTimeRef.current.set(o.name, o.maxHeightDateTime)
                }
              }
              // 第1波（到達時刻・押し引き）も別の軸（→ `spokenObsFirstWaveRef`）。**内容そのものを
              // 鍵にする**ので、気象庁の訂正（`FirstHeight/Revise` = 更新）を次の報で捉えられる。
              if (firstWaveToMark) {
                for (const o of firstWaveToMark) {
                  const key = firstWaveSpokenKey(o)
                  if (key) spokenObsFirstWaveRef.current.set(o.name, key)
                }
              }
              // 満潮時刻はその報の全地点を既読にしてよい（地点名を読まないので、件数上限で
              // 落ちた分を既読にする心配が無い。→ `rememberTideEntries`）。
              if (tideAreasToMark) rememberTideEntries(tideAreasToMark, spokenTideRef.current)
              // 欠測は名前だけを覚える（波高の記憶＝`spokenObsHeightRef` は触らない。欠測と
              // 同時に来た「これまでの最大波」を既読にすると、復帰後にその値が読まれなくなる）。
              if (missingToMark) {
                for (const o of missingToMark) spokenObsMissingRef.current.add(o.name)
                // 欠測の文は「これまでの最大波」を声にするので波高も進める（名前を入れない理由は
                // `rememberObservationHeights` の宣言箇所）。
                rememberObservationHeights(missingToMark, spokenObsHeightRef.current)
              }
              // 波高の記憶（`spokenObsHeightRef`）は触らない。この状態の観測点は数値を持たないので
              // 進める値が無く、触ると復帰後の実測値が読まれなくなる。
              if (warningLevelToMark) {
                for (const o of warningLevelToMark) {
                  spokenObsWarningLevelRef.current.add(o.name)
                  // 到達確認としても既読にする。この文が「観測しています」と到達を含んで
                  // 伝えているので、状態が解けたあとに「到達を確認しました」と言い直さない。
                  spokenObsNamesRef.current.add(o.name)
                }
              }
              if (areasToMark) rememberAreaGrades(areasToMark, spokenAreaGradeRef.current)
            }
            : undefined,
          // **どの地震について語っているか。** 順番待ちのあいだに選択が別の地震へ移っていないかを
          // 突き合わせるのに使う。使う側は 2 つ ―― 地震情報では未入電モードの自動開閉、
          // 津波では**借りた震源を語っているあいだのカード表示**（どちらも
          // `SpeechFollowSession.subject` を見る）。津波の主題ではなく**原因地震**の鍵が入る。
          quakeSubjectKey ?? undefined,
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
      const prevMap552 = lastMaxObsHeightRef.current
      const prevTimes552 = lastMaxObsTimeRef.current
      const prevFirstWaves552 = lastMaxObsFirstWaveRef.current
      const newStatusEntries: [string, ObsUpdateMark][] = []
      /**
       * その報で動いた項目。**判定の本体は `utils/tsunami.ts`**（記憶は画面用を渡す）。
       *
       * **新規発報（`fresh`）では前値を渡さない。** 観測点の記憶は津波をまたいで残るので、前の津波で
       * 見た同名の観測点と比べると「動いていない」に見える。**縦線（`status`）だけを `'new'` にしても
       * 足りない** —— 項目の色はこの判定から出るので、行だけ緑で値が白いという中途半端な行になる
       * （この巡で直した「初出なのに最大波の観測時刻だけ白」と同じ症状が、津波を跨いだときに戻る）。
       * 前値が無ければ `changedObservationFields` は「値を持つ項目すべて」を返す。
       */
      const fieldsOf552 = (o: import('../types/earthquake').TsunamiObservation, fresh = false) =>
        changedObservationFields(
          o,
          fresh ? undefined : prevTimes552.get(o.name),
          fresh ? undefined : prevFirstWaves552.get(o.name),
          fresh ? NO_PREV_HEIGHTS : prevMap552,
        )
      /**
       * 1 観測点ぶんの印を積む。**どの項目が動いたかまで持つ**（カードの行で、動いた項目を印の色で塗る）。
       *
       * `status` は行の左端の縦線で、従来どおり「その地点で何かあった」だけを言う。
       */
      const pushStatus = (
        o: import('../types/earthquake').TsunamiObservation,
        status: 'new' | 'changed',
        fresh = false,
        // 呼び出し側が既に数えていれば受け取る（同じ引数で 2 度評価しないため）
        fields = fieldsOf552(o, fresh),
      ) => {
        newStatusEntries.push([o.name, { status, fields }])
      }

      // 等級を伝えていない電文（区域が空）も観測点更新として扱う。読み上げ側と同じ判定に
      // 揃えること。片方だけずらすと「読み上げはするのに画面が動かない」が生まれる。
      if (isTsunamiObservationOnly(event)
        || (prevGrade552 !== null && GRADE_PRIORITY[grade] === GRADE_PRIORITY[prevGrade552])) {
        // **バッジ・自動スクロールの対象と、行に出す項目の印は同じ判定から出す**
        // （`changedObservationFields`）。別々に書いていた頃は、読み上げが名指しした観測点の
        // バッジが点滅せずカードもそこへスクロールしない、という食い違いを 2 度作り込んだ
        // （最大波の観測時刻・第1波の訂正）。**判定の本体は `utils/tsunami.ts`。**
        //
        // 波高を持たない観測点（到達確認・欠測）は下の `newlyShownObs552` が担う。
        const updatedObs552 = (event.observations ?? []).filter(o => o.height && fieldsOf552(o).size > 0)
        // 波高を持たない観測点（到達確認・欠測のどちらも）をスクロール・バッジ表示の対象にする。
        // **欠測を除外しないのは意図的** ―― 観測できなくなったこと自体が新しい事実で、
        // 画面に出す価値がある（読み上げ側は文を言い分ける必要があるので除外しているが、
        // 「この報で行が変わった」という画面の印は同じ扱いでよい）。
        //
        // **「初めて現れたか」だけで絞らない。** 一度でも載った名前は `seenObsNamesRef` に入るので、
        // 名前の新しさだけで見ると**二度目以降は何が変わっても印が付かない**。実際に起きるのは
        // 第1波の訂正（`FirstHeight/Revise` = 更新）と、到達確認だけだった地点に到達時刻が付く形で、
        // **読み上げは両方とも名指しして読む**（`firstWaveChanged`）のに画面だけが黙っていた。
        //
        // **欠測へ転じたことは、いまも印にできない。** 画面用の記憶（`lastMaxObsHeightRef`）は
        // 高水位マーク式で値を消さないため、「前の報では観測できていた」と「欠測のまま続いている」を
        // 見分けられない。名前の有無で判定すると欠測の間ずっと毎報光る。**欠測のバッジ自体は出る**ので
        // 情報は落ちないが、縦線の合図は付かない。直すには「前の報で欠測だったか」の記憶が要る。
        const newlyShownObs552 = (event.observations ?? []).filter(o => !o.height
          && (!seenObsNamesRef.current.has(o.name) || fieldsOf552(o).size > 0))
        if (updatedObs552.length > 0 || newlyShownObs552.length > 0) {
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
            districts: uniqueDistricts([...updatedObs552, ...newlyShownObs552]),
            top: topObs
              ? { code: topObs.districtCode, name: topObs.districtName }
              : pickTopFromCardOrder(newlyShownObs552, tsunamiCardBasis.areas, tsunamiCardBasis.observations),
            // **寄せ先が空でも先頭へ戻さない。** 沖合の観測点は津波予報区を持たないので、
            // 新しい観測点があっても `uniqueDistricts` は空を返す。戻すと、その観測点を
            // 読んでいる最中に画面だけ先頭へ飛ぶ。
            resetToTop: false,
            ts: Date.now(),
          })
        } else if (tsunamiAreaChanges.length > 0) {
          // 観測点は動いていないが区域の等級が動いた報（一部解除など）。**動いた区域へ寄せる。**
          // ここを下の「変化が無い」枝へ流すと、解除された区域がカードのどこにあっても
          // 画面は一番上へ戻り、何が変わったのか見えない。
          const changedAreas = tsunamiAreaChanges.flatMap(c => c.areas)
          setFocusedDistrict({
            districts: changedAreas.map(a => ({ code: a.code, name: a.name })),
            // 並びは読み上げと同じ（重い遷移が先）。その先頭を上端に置く
            top: { code: changedAreas[0].code, name: changedAreas[0].name },
            resetToTop: false,
            ts: Date.now(),
          })
        } else {
          // 寄せ先となる変化が無い電文。**先頭へ戻さない** —— 各地の満潮時刻・津波到達予想時刻に
          // 関する情報がここへ来る（観測点を載せず等級も変えないため全部の条件を落ちる）。
          // 戻していたころは、直前の報が変更区域へ寄せた位置を 24 秒後に捨てていた。
          // 再送（中身が前報と同じ）も同じ扱いでよい —— 位置を変える理由が無い。
          setFocusedDistrict({ districts: [], top: null, resetToTop: false, ts: Date.now() })
        }
        for (const o of updatedObs552) pushStatus(o, prevMap552.has(o.name) ? 'changed' : 'new')
        // **波高を持たない行は「名前を前に見たか」で新旧を決める。** `prevMap552` は波高の記憶で、
        // この群の観測点は一度も入らない —— それを使うと第1波が訂正された既出の地点まで
        // 「初めて出た値です」になる。
        for (const o of newlyShownObs552) pushStatus(o, seenObsNamesRef.current.has(o.name) ? 'changed' : 'new')
      } else {
        const obsWithHeight552 = (event.observations ?? []).filter(o => !!o.height)
        // 上と同じ（欠測を除外しない理由も、名前の新しさだけで絞らない理由も同じ）。
        const newlyShownObs552b = (event.observations ?? []).filter(o => !o.height
          && (!seenObsNamesRef.current.has(o.name) || fieldsOf552(o).size > 0))
        if (obsWithHeight552.length > 0 || newlyShownObs552b.length > 0) {
          const topObs = obsWithHeight552.length > 0 ? obsWithHeight552.reduce((a, b) => (b.height!.value > a.height!.value ? b : a)) : null
          setFocusedDistrict({
            districts: uniqueDistricts([...obsWithHeight552, ...newlyShownObs552b]),
            top: topObs
              ? { code: topObs.districtCode, name: topObs.districtName }
              : pickTopFromCardOrder(newlyShownObs552b, tsunamiCardBasis.areas, tsunamiCardBasis.observations),
            resetToTop: false,
            ts: Date.now(),
          })
        } else {
          // 観測データが無い発表（区域・等級のみの電文）。**ここは先頭へ戻す** —— この枝に来るのは
          // 新規発報と等級が変わった報だけ（上の `if` が等級不変の続報を引き受けている）で、
          // どちらもカードの構成が入れ替わるため前の位置に意味が無い。
          setFocusedDistrict({ districts: [], top: null, resetToTop: true, ts: Date.now() })
        }
        // **等級が動いた報では、動いたものだけに印を付ける**（上の枝と同じ判定）。その報には
        // **値が 1 つも変わっていない観測点が同梱されうる**。全件を無条件に `'new'` で押していた
        // ころは、何も変わっていない行に「最新の情報で初めて出た値です」という案内が付いていた。
        //
        // **ただし新規発報では絞らない。** 観測点の記憶（`prevMap552` ほか）は**津波をまたいで
        // 残る** —— 落とすのは表示中の津波へ向けた解除とリプレイのリセットだけで、別の津波へ
        // 移るだけでは落ちない（すぐ下の `tsunamiIsNewFire` の分岐が区域の印しか落としていない
        // のはそのため）。観測点名は全国共通なので前の津波で見た名前が次の津波にも現れ、波高が
        // 前より低ければ「動いていない」と判定される。**新しい津波の初報にその判定は意味が無く、
        // 絞ると印も地図の点滅も出ないまま終わる**（`useTsunamiLayerData` の `blinking` がこの印を
        // 見る）。同じ理由で `'changed'` にも倒さない —— 前の津波で見た名前でも、この津波では初出。
        //
        // **寄せ先（`focusedDistrict`）は上で全件から決めたまま。** 等級が動くとカードの構成が
        // 入れ替わるので、変化の有無に関わらず見せ直すのが正しい。
        // **「まだ何も見ていない」は等級ではなく記憶の空で見る。** `lastTsunamiGradeRef` は等級を
        // 伝えない電文（区域を持たない観測情報）では進まないのに、観測点の記憶はその報でも埋まる。
        // 等級で判定すると、進行中の津波へ途中から接続した直後の報で、正当な継続を「初出」と扱う。
        const noMemory552 = prevMap552.size === 0 && prevTimes552.size === 0
          && prevFirstWaves552.size === 0 && seenObsNamesRef.current.size === 0
        const freshFire552 = tsunamiIsNewFire || noMemory552
        for (const o of obsWithHeight552) {
          // 1 回だけ数える（フィルタと `pushStatus` で同じ引数を 2 度評価しない）
          const fields = fieldsOf552(o, freshFire552)
          if (!freshFire552 && fields.size === 0) continue
          pushStatus(o, !freshFire552 && prevMap552.has(o.name) ? 'changed' : 'new', freshFire552, fields)
        }
        for (const o of newlyShownObs552b) {
          pushStatus(o, !freshFire552 && seenObsNamesRef.current.has(o.name) ? 'changed' : 'new', freshFire552)
        }
      }

      // 津波情報を受信するたびに obsUpdateStatus を今回分だけの Map に置き換える（前回分は破棄）。
      // TSUNAMI_BADGE_TTL_MS 以内に次の情報が来なければ obsStatusClearTimerRef が空 Map にする。
      setObsUpdateStatus(new Map(newStatusEntries))
      window.clearTimeout(obsStatusClearTimerRef.current)
      obsStatusClearTimerRef.current = window.setTimeout(() => setObsUpdateStatus(new Map()), TSUNAMI_BADGE_TTL_MS)
      // **別の津波へ切り替わったら印を落とす。** 印の鍵は区域コード（`tsunamiAreaKey`）だけで、
      // どの津波のものかを持たない。気象庁の津波予報区コードは固定なので、前の津波で動いた区域と
      // 同じコードが次の津波にも現れる。**据え置くようにしたぶん、ここで落とさないと前の津波の印が
      // 新しいカードへ持ち越される**（据え置く前は毎報置き換えていたので、次の報が来た時点で
      // 必ず消えていた）。解除を受けずに別の津波へ移る経路がこれに当たる。
      //
      // カード側（`TsunamiTab`）は「その区域がいま `lastGrade !== grade` か」も併せて見るので、
      // これが無くても持ち越した印がそのまま画面に出るわけではない。**それでも落とす** ——
      // 表示の正しさを別ファイルの独立した判定に頼る形にすると、そちらの条件を緩めたときに
      // 前の津波の印が黙って出る。
      if (tsunamiIsNewFire) {
        window.clearTimeout(areaGradeClearTimerRef.current)
        setAreaGradeChangedKeys(new Set())
      }
      // 等級が動いた区域も「今回分だけ」に置き換える。**ただし、まだ声にしていない等級変化を
      // 持つ報のときだけ。** 等級を語らない続報（満潮時刻・観測情報）で消さない理由と、タイマーを
      // 観測点と分ける理由は宣言箇所。
      //
      // **既読を除く前の値（`tsunamiAreaGradeChanges(event)` の生の結果）で判定しないこと。**
      // 満潮時刻・観測情報の続報も `LastKind` を前報のまま載せるので、そちらを見ると毎報が
      // 「等級を語る報」になり、置き換え自体は同じ中身でもタイマーが張り直されて寿命が伸び続ける。
      if (tsunamiAreaChanges.length > 0) {
        setAreaGradeChangedKeys(new Set(tsunamiAreaChanges.flatMap(c => c.areas.map(tsunamiAreaKey))))
        window.clearTimeout(areaGradeClearTimerRef.current)
        areaGradeClearTimerRef.current = window.setTimeout(() => setAreaGradeChangedKeys(new Set()), TSUNAMI_BADGE_TTL_MS)
      } else {
        // **据え置いたことを残す。** 実機で「この報でなぜ印が変わらなかったのか」を後から追える
        // 唯一の手がかりになる（画面には「変わらなかった」という痕跡が出ない）。
        log.debug('[tsunami] 声にしていない等級変化が無いため、区域の印を据え置く')
      }

      // 画面用の記憶だけをここで進める。読み上げ用（`spokenObsHeightRef`）は発話を始める瞬間まで
      // 待つ（受信時に進めると、鳴らなかった観測値まで既読になり二度と読まれない）。
      rememberObservationsForDisplay(event.observations ?? [], seenObsNamesRef.current, lastMaxObsHeightRef.current, lastMaxObsTimeRef.current, lastMaxObsFirstWaveRef.current)
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
      latestScheduledSeqByPriorityRef.current.clear()
      window.clearTimeout(obsStatusClearTimerRef.current)
      window.clearTimeout(areaGradeClearTimerRef.current)
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
    eewPhase1TokensRef.current.clear()
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
    latestScheduledSeqByPriorityRef.current.clear()
    eewPhase2DoneRef.current.clear()
    // 第 1.5 フェーズ（警報の対象地方）の既読と予約。**第 2 フェーズの対と揃えて落とす** ——
    // 落とし忘れると、同じ `eventId` を再生し直したとき「もう声にした」と判定されて
    // 第 1.5 フェーズがそのセッションで一度も鳴らない（例外もログも出ない）。
    spokenEEWRegionsRef.current.clear()
    spokenEEWUpgradePhraseRef.current.clear()
    eewRegionTokensRef.current.clear()
    eewRetractedKeysRef.current.clear()
    eewPhase1ProgressRef.current.clear()
    lastTsunamiGradeRef.current = null
    // 解除の照合に使う直前の津波も落とす（残すと、リプレイ後の解除を切替前の津波と照合する）
    lastTsunamiRef.current = null
    lastMaxObsHeightRef.current.clear()
    lastMaxObsTimeRef.current.clear()
    lastMaxObsFirstWaveRef.current.clear()
    seenObsNamesRef.current.clear()
    // 読み上げ用の既読も落とす（画面用と対称。残すとリプレイ後の観測情報が「更新なし」になる）
    spokenObsHeightRef.current.clear()
    spokenObsNamesRef.current.clear()
    spokenObsMissingRef.current.clear()
    spokenObsWarningLevelRef.current.clear()
    spokenObsMaxHeightTimeRef.current.clear()
    spokenObsFirstWaveRef.current.clear()
    spokenTideRef.current.clear()
    spokenAreaGradeRef.current.clear()
    seenLpgmEventIdsRef.current.clear()
    // 津波の取消・解除・失効を「もう伝えた」記憶も落とす。**残すと、同じ `eventId` の取消を
    // リプレイで流したときに音・読み上げ・タブ移動のすべてが黙る**（`alreadySpoken` が真に
    // なる経路）。しかも 200 件溜まるまで自己クリアされないので、実質そのセッション中ずっと
    // 効き続ける。他の既読系と揃える。
    spokenTsunamiCancelEventIdsRef.current.clear()
    // 気象庁が書いた文の既読も落とす。残すと、同じシナリオを再生し直したときに本文が
    // 前回と一致して「読んだこと」になり、**新しいセッションで一度も声にならない**
    // （鍵はイベント単位なので、同じ地震を再生すれば必ず一致する）。
    spokenTelegramTextRef.current.clear()
    // バッジ自動消去タイマーもリプレイ切替時に持ち越さない（アンマウント経路と対称）
    window.clearTimeout(obsStatusClearTimerRef.current)
    obsStatusClearTimerRef.current = 0
    window.clearTimeout(areaGradeClearTimerRef.current)
    areaGradeClearTimerRef.current = 0
    // タイマーを止めるだけだと「60 秒で必ず消える」保証が外れ、次の津波電文が来るまで古い
    // バッジと寄せ先が無期限に居座る（表示対象が消えているので画面では気づけない）。中身も落とす。
    setObsUpdateStatus(new Map())
    setAreaGradeChangedKeys(new Set())
    setFocusedDistrict(null)
    // 間を置いてからの読み上げの予約も捨てる。残すと、リプレイを始めた直後に切り替え前の
    // 電文が読まれる（状態はリセット済みなので待ち合わせにも掛からず、そのまま割り込む）。
    cancelPendingSpeech()
    // カードの追従も打ち切る。**鳴っている読み上げはここでは止まらない**ので、追従だけを
    // 残すと、切り替え前の読み上げの進行に合わせて新しく表示されたカードを動かし続ける
    // （区域名や観測点名が新旧で重なれば、実在する別の行を掴む）。
    speechFollow?.reset()
    unreceivedFollow?.reset()
    // 気象庁の文の自動展開も同じ。**3 本とも並べて打ち切る** —— 1 本だけ残すと、
    // 切り替え前の読み上げが自然に終わるまで（南海トラフ臨時情報なら約 3 分）
    // 無関係なバナーが開いたままになる。
    telegramTextFollow?.reset()
    borrowedHypocenterFollow?.reset()
    // 「いま声が語っている緊急地震速報」の印も落とす。切り替え前の eventId が残ると、
    // 新しい時間軸で同じ eventId の地震が来るまで消えない（猶予のタイマーは鳴り終わりで
    // 張るので、割り込みで消えた発話の分は張られない）。
    eewSpeakingCard?.reset()
  }, [cancelPendingSpeech, speechFollow, unreceivedFollow, telegramTextFollow, borrowedHypocenterFollow, eewSpeakingCard])

  // pre-window イベントから T 時点の追跡 ref を復元する（サイレント注入後の正確な音判定に必要）
  const restorePreWindowTracking = useCallback((preFiltered: ReplayEntry[]) => {
    /**
     * **録画モードでは、窓の手前で伝えた内容も「もう伝えた」として扱う。**
     *
     * 通常の再生で復元しないのは「窓から聞き始めた人は一度も聞いていない」ため（`restoreOne` の
     * 地震の分岐に理由がある）。録画は区間を繋いで 1 本の動画にするので、その前提が成り立たない ——
     * 前の区間で既に画面にも声にも出ている。復元しないと区間の境目で同じ長文を読み直す。
     */
    const recording = settingsRef.current.recordingMode
    const opts = ttsRegionOptions(settingsRef.current)
    /**
     * 窓の手前で見た地震と、そこへ与えた読み上げの主題。
     *
     * **報ごとに鍵を作らないこと。** ライブ経路が使う主題はカードの `eventKey` から作られ、
     * その値は**最初に処理された報**で固定される（`mergeQuakeInto`）。一方 `quakeEventKey` を
     * 生の電文へ直に当てると、識別子を持たない経路（P2PQuake）では `p2p:<地震の時刻>#<その報の id>`
     * になり、**続報のたびに別の鍵**になる。窓の手前に同じ地震の報が 2 通以上あると、2 通目以降の
     * 記憶がライブ経路から参照されない鍵の下へ入り、その報で初めて現れた地域が区間の最初の続報で
     * 読み直される —— この復元が消したかった症状そのものが、standard 版でだけ残る。
     *
     * 同一性の判定はライブ経路と同じ `sameQuakeEntry`。
     */
    const quakeTopicFor = createPreWindowQuakeTopics()
    /**
     * 電文 1 通ぶんの復元。**呼び出し側のループが 1 通ずつ例外を受け止める。**
     */
    const restoreOne = (payload: ReplayPayload) => {
      // 気象庁が書いた文は電文の種別を問わないので、種別ごとの分岐より先に見る。
      if (recording) {
        rememberTelegramTextAsSpoken(payload, spokenTelegramTextRef.current, opts)
      }
      if (payload.kind === 'event') {
        const ev = payload.event
        if (ev.kind === 'quake') {
          // ライブ経路（上の handleLiveEvent）と同じキーの組み立て方にそろえる。
          // **この復元はバリアントを問わず呼ばれる。** リプレイの配線（`App.tsx` の
          // `onStartReplay`）は 1 つで、バリアントで分かれるのは取得元だけ。そのため
          // 識別子を持たない経路（P2PQuake）でも通り、鍵の作り方に注意が要る
          // （上の `quakeTopicFor` の注記）。
          //
          // **「声にした内容」（`spokenQuakeStatesRef`）は復元しない。意図的。** 窓の手前の報は
          // 再生されておらず、聞き手は一度も聞いていない。既読として積むと、再生開始直後の
          // 続報が「聞いたことのない地域」を省いて読む。復元しない結果その報は全文で読まれるが、
          // それが窓から聞き始めた人にとって正しい（冒頭は「更新されました」になる）。
          markQuakeReportSeen(seenQuakeReportKeysRef.current, newQuakeTrackingKey(ev as JMAQuake))
          // 録画モードだけは上の理由が成り立たないので、地域と震源要素も既読にする
          // （区間の最初の確定情報が全区域を読み直すのを防ぐ）。
          //
          // **取消の報は対象にしない。** ライブ経路も取消では本体の読み上げを組まない。
          // 取消電文の震源要素はセンチネル（震央名が空・規模 0・位置 -200）で埋まっており、
          // `hasMagnitude(0)` は真なので「Ｍ０．０」として記録され、窓に入った最初の報が
          // 「マグニチュードが更新されました」と**余計に**言うことになる。
          if (recording && !(ev as JMAQuake).cancelled) {
            // **ライブ経路と同じ材料で既読にする。** あちらが借りた震源を持ち込まなくなったので
            // こちらも渡さない —— この関数は `earthquakeToSegments` を通して既読を作るため、
            // 渡すと既読にする区域の集合まで震源距離順で切られる（ライブ側と同じ副作用）。
            // 地震電文の側は震源を語らないので、借りても震源の既読は増えない。
            //
            // **既読にするのは生の入電ではなく、マージ後のカード。** `quakeTopicFor` の内部の
            // バケットは `mergeQuakeInto` を通しており据え置き（`quakeHoldBack`）を反映済み
            // ——据え置かれた報では `card` が変わらないので、退けられた内容（区域・震度等）は
            // 既読に積まれない。生の入電のまま渡すと、画面にも声にも出ていない内容を
            // 「もう声にした」として記録してしまい、後続の正規の報がその内容を黙って省く。
            const quake = ev as JMAQuake
            const { topic, card } = quakeTopicFor(quake)
            rememberQuakeSpeechAsSpoken(
              card, topic, spokenQuakeStatesRef.current, authoritativeReadQuakesRef.current, opts,
            )
          }
        } else if (ev.kind === 'eew') {
          const eew = ev as EEWAlert
          const key = eewEventKey(eew)
          /**
           * **投げうる計算を先に済ませてから ref へ書く。**
           *
           * ここは複数の ref を順に埋めるが、そのうち `activeEEWLevelsRef` だけは意味が違う
           * ——ライブ経路の `isNew`（新規発報か）がこれだけを見る。途中で投げてこれだけが
           * 残ると、**続報が「既存」と判定されて第 1 フェーズ（「緊急地震速報、〇〇で地震。」）が
           * 一度も鳴らない**。他の ref は欠けても「既読が足りない＝読み直す」側なので、
           * ここだけ失敗の向きが逆になる。
           *
           * 書き込みの直前に例外の余地を残さなければ、この分岐は全部書くか 1 つも書かないかに
           * なる。値を束ねたぶん `eewMaxScaleInfo` / `eewMaxLpgmClassInfo` の二度手間も消える。
           */
          const restoredLevel = computeSingleEEWLevel(eew)
          const restoredScale = eewMaxScaleInfo(eew)
          const restoredLpgm = eewMaxLpgmClassInfo(eew)
          const restoredRegions = eew.warningRegions?.length
            ? [...(spokenEEWRegionsRef.current.get(key) ?? []), ...eew.warningRegions]
            : null
          // 最後に告知した震源。**3 通りある。**
          // - 取消の報は**消す**（ライブ経路が取消で `delete` する側なので、文字どおり同じ操作に
          //   する。`set` を飛ばすだけだと取消より前の報の震源が残る）。取消電文の震源は
          //   センチネルなので `hasKnownEpicenter` でも弾かれるが、弾かれることに頼ると
          //   電文の埋め方が変わったときに静かに通る
          // - 震源が読めない報は**触らない**（前の報で入れた震源を消さない）
          // - それ以外は入れ替える
          const announcedHypo = eew.cancelled ? null : eew.earthquake?.hypocenter
          const restoredHypo: AnnouncedHypocenter | 'delete' | 'keep' =
            eew.cancelled ? 'delete'
              : announcedHypo && hasKnownEpicenter(announcedHypo.latitude, announcedHypo.longitude)
                ? { name: announcedHypo.name, lat: announcedHypo.latitude, lng: announcedHypo.longitude }
                : 'keep'

          activeEEWLevelsRef.current.set(key, restoredLevel)
          spokenEEWScalesRef.current.set(key, restoredScale)
          spokenEEWLpgmClassesRef.current.set(key, restoredLpgm)
          // 区分も復元する。落とすと注入後の最初の続報で「警報。」が付き直し、
          // 途中から再生を始めた地震がその場で警報化したように聞こえる。
          spokenEEWLevelsRef.current.set(key, restoredLevel)
          // T 時点までの報は既に発表済みとして扱う。第2フェーズも発話済みにしておかないと、
          // 注入後の続報が読み直され、途中から再生を始めた地震が初報のように聞こえる
          eewPhase2DoneRef.current.add(key)
          // 安定待ちの確定値も復元する。復元しないと注入後最初の続報の跳躍幅計算が
          // 「自分自身」を基準にしてしまい（跳躍0扱い）、実際より短い安定待ちになる。
          eewConfirmedScaleRef.current.set(key, restoredScale)
          eewConfirmedLpgmRef.current.set(key, restoredLpgm)
          // 警報の対象地方も既読にする。**ここが漏れていると、この EEW について他は何も
          // 声にしないのに地方だけが鳴る** —— 第 1 フェーズは `activeEEWLevelsRef` で、
          // 第 2 フェーズは `eewPhase2DoneRef` で止まるのに、地方は「まだ声にしていない地方が
          // あるか」だけで発火するため。窓の手前で既に発表されていた地方を読み直すことになる。
          //
          // **上書きではなく積む。** 他の値（区分・予想値）は最後の報が最新なので上書きでよいが、
          // 地方は「その報が載せた顔ぶれ」であって累積ではない。窓の境界直前の報がたまたま
          // 地方を持たなければ、それ以前に発表済みの地方が未読へ戻る。
          if (restoredRegions) spokenEEWRegionsRef.current.set(key, new Set(restoredRegions))
          // 格上げの前置きも伝え済みにする。**`spokenEEWLevelsRef` の復元に頼らない** ——
          // いまは前置きの判定が「区分が上がったか」を併せて見るので相乗りで防げているが、
          // その依存はどこにも書かれていない。対で復元して切っておく。
          if (restoredLevel >= 1) spokenEEWUpgradePhraseRef.current.add(key)
          if (recording) {
            // 誤報取消（訂正）を受けた事実。自動解除（`expired`）とは区別する
            // ——ライブ経路（`handleLiveEventInner`）と同じ条件。
            if (eew.cancelled && !eew.expired) eewRetractedKeysRef.current.add(key)
            // 最後に第 1 フェーズを読んだときの震源。落とすと、窓に入った最初の続報で
            // 震源の大幅更新の判定に使う比較対象が無くなる（取消での扱いは上の `restoredHypo`）。
            // **窓の手前の分は入れ替える（積まない）。** ここで復元したいのは「窓に入った最初の
            // 続報が比べる相手」で、手前で実際に何を声にしたかは分からない。報ごとに積むと、
            // 声にしていない場所まで「名乗り済み」になり、窓の中の言い直しを黙らせる。
            if (restoredHypo === 'delete') activeEEWAnnouncedHypocentersRef.current.delete(key)
            else if (restoredHypo !== 'keep') activeEEWAnnouncedHypocentersRef.current.set(key, [restoredHypo])
          }
        } else if (ev.kind === 'tsunami') {
          const tsunami = ev as JMATsunami
          // **ライブ経路と同じ形で進めること**（電文は時系列順に渡ってくる）。片方だけずらすと、
          // リプレイを途中から始めたときだけ「解除で終わった津波の観測点が既読のまま残る」
          // （＝次の津波で到達を伝えられない）という、ライブでは起きない食い違いになる。
          if (tsunami.cancelled) {
            // 録画モードでは取消の読み上げも済ませた扱いにする（鍵はライブ経路と同じ組み立て）。
            if (recording) spokenTsunamiCancelEventIdsRef.current.add(tsunami.eventId || tsunami.id)
            lastTsunamiGradeRef.current = null
            lastTsunamiRef.current = null
            lastMaxObsHeightRef.current.clear()
            lastMaxObsTimeRef.current.clear()
            lastMaxObsFirstWaveRef.current.clear()
            seenObsNamesRef.current.clear()
            spokenObsHeightRef.current.clear()
            spokenObsNamesRef.current.clear()
            spokenObsMissingRef.current.clear()
            spokenObsWarningLevelRef.current.clear()
            spokenObsMaxHeightTimeRef.current.clear()
            spokenObsFirstWaveRef.current.clear()
            spokenTideRef.current.clear()
            spokenAreaGradeRef.current.clear()
          } else {
            const grade = tsunamiMaxGrade(tsunami)
            if (grade !== 'Unknown') lastTsunamiGradeRef.current = grade
            lastTsunamiRef.current = tsunami
            // **録画モードでは、津波が語った震源も「もう伝えた」扱いにする。**
            //
            // 津波の読み上げは末尾で原因地震の震源を語り、その既読は**地震の主題**へ積まれる
            // （→ `ttsText.ts` の `sourceHypocenterSegments`）。ここで積まないと、区間の境目で
            // 次の津波が同じ震源を語り直す —— 録画は区間を繋ぐので、通しで聞くと二度述べになる。
            //
            // **主題の組み立てはライブ経路と揃える。** あちらはカードがあればその `eventKey` を
            // 使うが、復元は状態更新の外で流れるためカードを引けない。DMDATA ではどちらも
            // `eventId` なので実運用では一致する（識別子を持たない経路はそもそも震源を貸さない）。
            if (recording && tsunami.eventId) {
              const quakeState = quakeSpokenStateFor(spokenQuakeStatesRef.current, `quake:${tsunami.eventId}`)
              // 既読を渡して組み、返ってきた参照をその既読へ積む。まだ語っていない事実だけが
              // 文になるので、同じ震源を載せた続報が何通あっても二重には積まれない。
              applySpokenRefs(quakeState, tsunamiToSegments(tsunami, undefined, quakeState, opts).flatMap(seg => seg.refs))
            }
            // T 時点までの観測点は「もう伝えた」ものとして扱う。**読み上げ用も埋めること。**
            // 埋め忘れると、注入後の最初の観測情報でそれまでの全観測点が読み直され、途中から
            // 再生を始めたのに津波の到達をいまさら読み上げることになる。
            rememberObservationsForDisplay(tsunami.observations ?? [], seenObsNamesRef.current, lastMaxObsHeightRef.current, lastMaxObsTimeRef.current, lastMaxObsFirstWaveRef.current)
            // ライブ経路が持つ「等級を語れない電文では既読にしない」ガード（`canTellGrade`）は
            // ここに無い。この復元は DMDSS 版のリプレイ専用で、DMDATA は未知の区分を安全側で
            // 津波警報へ丸めるため（`dmdataParser` の Kind/Code 判定）、区域が残ったまま等級だけ
            // 落ちた電文が届かないから。ライブ側のガードを変えるときはこの非対称でよいか確かめる。
            // **欠測の観測点は名前を到達確認の記憶へ入れない**（理由は `rememberObservationHeights`）。
            // 波高だけは進める——欠測と同時に来た「これまでの最大波」を読み直さないため。
            const observations = tsunami.observations ?? []
            rememberObservations(observations.filter(o => !isObservationMissing(o)), spokenObsNamesRef.current, spokenObsHeightRef.current)
            rememberObservationHeights(observations.filter(o => isObservationMissing(o)), spokenObsHeightRef.current)
            // 欠測も「もう伝えた」側へ入れる（入れないと、注入後の最初の観測情報で T 時点までの
            // 欠測が全部読み直される）。**この復元は窓の手前の全報を順に舐める**（呼び出し側の
            // ループ）ので、状態の変わり目もライブ経路と同じ規則で落とす。
            forgetSpokenOnObservationStateChange(observations, spokenObsNamesRef.current, spokenObsMissingRef.current, spokenObsWarningLevelRef.current)
            for (const o of observations) {
              if (isObservationMissing(o)) spokenObsMissingRef.current.add(o.name)
              // 「観測中のまま津波警報相当」も同じ扱い。**記憶を 1 つ足したら、埋める経路も
              // 全部見ること** —— ここを忘れると、窓の手前から続いている状態が注入後の最初の
              // 観測情報で読み直される（欠測で一度踏んだ穴と同型）。
              if (isWarningLevelWhileObserving(o)) spokenObsWarningLevelRef.current.add(o.name)
              // 最大波の観測時刻も同じ扱い。埋め忘れると、窓の手前から持ち越された観測点が
              // 注入後の最初の変化を伝えない報で「時刻が更新された」ものとして読まれる。
              if (o.maxHeightDateTime) spokenObsMaxHeightTimeRef.current.set(o.name, o.maxHeightDateTime)
              // 第1波も同じ扱い。埋め忘れると、窓の手前で到達が確認された観測点の第1波が
              // 注入後の最初の報で読み直される（初出扱いになり、波高の文へ織り込まれる）。
              const firstWaveKey = firstWaveSpokenKey(o)
              if (firstWaveKey) spokenObsFirstWaveRef.current.set(o.name, firstWaveKey)
            }
            // **満潮時刻も埋めること。** `tideReportChange` は記録が空なら無条件に `first` を
            // 返すので、埋め忘れると窓の手前で既に伝えた満潮時刻が「初報」として読み直される。
            rememberTideEntries(tsunami.areas, spokenTideRef.current)
            // **区域の等級変化も同じく埋めること。** `LastKind` は変化した後の続報にも載り続けるため、
            // 埋め忘れると、注入後の最初の続報が T より前に起きた解除を「いま起きた」ものとして
            // 読み上げ・タブ移動する（観測点で防いでいるのと同型の穴）。
            //
            // **解除された区域（`cancelledAreas`）もここで埋まる。** ライブ経路は「等級を語れない
            // 電文では解除を既読にしない」ガードを持つが（`speakableAreaChanges`）、ここには無い ——
            // 上の `canTellGrade` と同じ前提に依存している。パーサーが未知の等級を `Warning` へ
            // 倒すのをやめるなら、この非対称も併せて見直すこと。
            rememberAreaGrades(tsunamiAreaGradeChanges(tsunami), spokenAreaGradeRef.current)
          }
        }
      } else if (payload.kind === 'lpgm' && !payload.data.cancelled) {
        seenLpgmEventIdsRef.current.add(payload.data.eventId)
      }
    }
    /**
     * **1 通の失敗で復元ループごと止めない。**
     *
     * 呼び出し元（`useReplayController`）はこの復元と `loadReplayEvents` を同じ `try` に
     * 入れており、その `catch` は「リプレイデータ取得失敗」として扱う。投げたまま抜けると
     * **電文の再生自体が始まらない**——取得は成功しているので、原因と表示も食い違う。
     *
     * **握ってよいのは、この復元の失敗に「上へ伝えるべきもの」が無いから。** 値を返さず、
     * 触るのは既読の記録だけで、失敗しても再生は成立する（窓の手前で伝えた内容を読み直す
     * ——読み上げが増える側へ倒れる）。取得そのものの失敗は `fetchEvents` の `.catch` が
     * 別に投げるので、ここで握っても取りこぼしは隠れない。**痕跡は残す。**
     *
     * **囲うのは 1 通ずつで、ループ全体ではない。** まとめて囲うと、1 通目で投げたときに
     * 残り全部の復元が飛ぶ。
     *
     * **単位は電文であってステップではない。** 1 通の中で先に走る処理（気象庁が書いた文の
     * 復元）が投げれば、同じ電文の地震・緊急地震速報・津波の復元も走らない。欠ける向きは
     * どれも「既読が足りない＝読み直す」側に揃えてあるので、揃えたまま電文単位で切る
     * （**緊急地震速報だけは向きが逆になりうるので、その分岐の中で塞いである** —— 下記）。
     *
     * **録画モードの復元だけを囲っていた頃の非対称は解いた。** 呼ぶ処理の分岐の数（＝投げる
     * 確率）は違っても、投げたときに起きることは緊急地震速報・津波の復元とまったく同じ。
     */
    const failures: { kind: string; err: unknown }[] = []
    for (const { payload } of preFiltered) {
      try {
        restoreOne(payload)
      } catch (err) {
        failures.push({ kind: payload.kind, err })
      }
    }
    /**
     * **記録は 1 回の復元につき 1 行へまとめる。**
     *
     * 窓の手前は最大 24 時間ぶんで、群発なら 1 回の復元で数百通を積む。共有ロジックの回帰で
     * 同じ形の電文がまとめて読めなくなると、素通しでは同期ループから数百行が出て、単発の
     * 異常となし崩しの系統障害が見分けられなくなる（読めなかったものの記録は他も同じ形で
     * まとめている。→ `docs/spec/data-sources-spec.md` §2「読めなかったものは記録する」）。
     *
     * **黙らせるのではなく畳む。** 件数・種別の内訳・見本 3 件を出すので、何が起きたかは残る。
     */
    if (failures.length > 0) {
      const byKind = new Map<string, number>()
      for (const f of failures) byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1)
      const breakdown = [...byKind].map(([kind, n]) => `${kind}=${n}`).join('・')
      log.warn(
        `[replay] 窓の手前の電文から状態を復元できませんでした（飛ばした電文は既読にならず、`
        + `窓に入ってから読み直します）: ${failures.length}/${preFiltered.length} 通（${breakdown}）。見本:`,
        ...failures.slice(0, 3).map(f => f.err),
      )
    }
  }, [])

  // **タブ復帰で津波カードを先頭へ戻す口はここに置かない。** 先頭復帰は `App.tsx` の
  // `requestAutoTab` が `shouldResetTsunamiScroll` で決める 1 経路だけにしてある。
  // ここから別に要求を出していた頃は、タブが変わっていない復帰でも位置を捨てていた。
  /**
   * 電文 1 通の処理。
   *
   * **気象庁が書いた文は本体の処理が済んでから予約する。** 入口で予約すると、待ち合わせは
   * 「いま鳴っているものがあるか」で判定するため**何も鳴っていない状態で先に鳴り出し**、
   * 後から予約された本体（地震情報・津波）が上位として割り込む —— 最下位の層に置いて
   * 「何も切らない」ようにした意味が消える。本体を先に予約しておけば、本文はそれを待つ。
   *
   * **本体の早期 return を避けるためにラッパーにしてある。** `handleLiveEventInner` には
   * 種別ごとの抑制（試験報・重複報など）による `return` が多数あり、その末尾へ置くと
   * 通らない経路ができる。
   */
  const handleLiveEvent = (event: LiveEvent, meta?: LiveEventMeta) => {
    skipTelegramTextRef.current = false
    handleLiveEventInner(event, meta)
    if (skipTelegramTextRef.current) return
    // **予約そのものを遅らせる。発火を遅らせるのではない。**
    //
    // 到来順の裁き（`overtakenByLaterArrival`）は「自分より**後に予約された**同格以上の
    // 読み上げ」に追い越されたら取り下げる。本文を本体と同じ瞬間に予約すると、直後に届いた
    // 別の電文（地震情報と長周期地震動観測情報は続けて届く）の予約に追い越され、
    // **待つ前に取り下げられる**（実機のログで確認）。
    //
    // 予約を数秒遅らせれば本文が最後の予約になり、追い越されない。そのうえで発火時に本体が
    // 鳴っていれば、今度は待ち合わせ（`speechBlocker`）が正しく待たせる。
    //
    // 追跡できる形で予約する（`scheduleSpeech`）—— 画面を閉じたときとリプレイの開始で
    // 取り消せないと、消したはずの画面へ本文が 1 通だけ届く。
    scheduleSpeech(TELEGRAM_TEXT_SPEECH_RESERVE_DELAY_MS, () => speakTelegramText(event))
  }

  return { handleLiveEvent, resetTracking, restorePreWindowTracking, obsUpdateStatus, areaGradeChangedKeys, focusedDistrict }
}
