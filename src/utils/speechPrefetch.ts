import type { LiveEvent } from '../types/earthquake'
import type { ReplayPayload } from '../types/replay'
import {
  earthquakeToSegments, earthquakeCancelToText, tsunamiToSegments, tsunamiCancelToText,
  eewAlertToText, eewCancelToText, lpgmToText, nankaiToText, nankaiCommentaryToText,
  kohatsuToText, earthquakeCountToText, estimatedIntensityToText, telegramTextToSpeak,
  type TtsSpeechOptions,
} from './ttsText'
import { joinSegments } from './ttsFollow'
import { log } from './logger'

/**
 * リプレイ中、**これから届く電文の読み上げを先に合成しておく**ための文の組み立て。
 *
 * ## なぜ投機でよいのか
 *
 * 読み上げ文は受信の瞬間に組まれ、**既読状態（前の報で何を声にしたか）に依存する**。差分読み・
 * 優先度・割り込みが絡むので、実際に読まれる文は再生の順番が来るまで確定しない。
 *
 * **それでも投機が成り立つのは、控えがチャンク単位だから**（`speechAudioCache.ts`）。文が
 * 少しずれても、句読点で割った断片の大半は一致する。外れたぶんの損は「使われない合成 1 件」
 * だけで、当たれば往復が丸ごと消える。**正確に当てるために読み上げの状態機械をもう 1 つ持つ
 * ほうが高くつく** —— 保守が二重になり、片方だけ古くなったときに誰も気づけない。
 *
 * ## 何がどこまで当たるか
 *
 * | 種別 | 既読状態への依存 | 投機の精度 |
 * |---|---|---|
 * | 気象庁が書いた文（`telegramTextToSpeak`） | 無し | 完全 |
 * | 南海トラフ臨時／解説・後発地震・地震回数 | 無し | 完全 |
 * | 緊急地震速報の第 1 フェーズ | 無し | 完全（下記） |
 * | 長周期・推計震度分布図 | 真偽 1 つ | 2 通りとも焼く |
 * | 地震情報・津波 | 既読状態 | 部分（既読なしの「通しの文」で代用） |
 *
 * **いちばん長い文が「依存なし」の側にある。** 南海トラフ解説の本文は 1721 字＝65 チャンク、
 * 津波の避難行動の固定付加文は 641 字＝25 チャンク。合成が再生に追いつかなくなるのはこの
 * 長さの文で、そこが丸ごと控えから出せる。
 */

/**
 * 1 通の電文から、投機的に合成しておく読み上げ文を列挙する。
 *
 * **実際に読まれる保証はない。** 設定で切られている・優先度で捨てられる・既読で差分になる、
 * いずれも起こりうる。ここが返すのは「読まれるとしたらこういう文」であって、予言ではない。
 *
 * @param payload リプレイのキューに積まれた電文
 * @param opts 読み上げのオプション（`ttsRegionOptions(settings)` と同じもの）
 */
export function speculativeSpeechTexts(payload: ReplayPayload, opts: TtsSpeechOptions): string[] {
  const texts: string[] = []
  const add = (text: string | null | undefined) => { if (text) texts.push(text) }

  switch (payload.kind) {
    case 'event': {
      const event = payload.event
      if (event.kind === 'quake') {
        // 取消の報は本体が理由を読む。発表報は既読なし（＝通しの文）で組む。
        if (event.cancelled) add(earthquakeCancelToText(event.earthquake?.time ?? null, event.cancelText))
        else add(joinSegments(earthquakeToSegments(event, opts, true)))
      } else if (event.kind === 'tsunami') {
        if (event.cancelled) add(tsunamiCancelToText(event.cancelReason, event.cancelText))
        else add(joinSegments(tsunamiToSegments(event, undefined, undefined, opts)))
      } else if (event.kind === 'eew') {
        if (event.cancelled) add(eewCancelToText(event))
        // **区分（予報／警報／震源更新）は渡す値を選ばない。** 第 1 フェーズの文は
        // 「切り出し語＋震源名で地震。」の形で、切り出し語は 3 通りとも独立したチャンクになり
        // **起動時の作り置き（`warmFixedPhrases`）が既に焼いている**。残る「〇〇で地震。」の
        // チャンクは区分に依らず同じなので、どれか 1 つで焼けば足りる。
        else add(eewAlertToText(event, 'warning'))
      }
      break
    }
    case 'lpgm':
      // 初報・続報で文頭が変わるだけ。**2 通りとも焼く** —— 真偽 1 つの分岐に投機の精度を
      // 賭ける理由がなく、外した側の損は控えの 1 件ぶんに収まる。
      add(lpgmToText(payload.data, opts, true))
      add(lpgmToText(payload.data, opts, false))
      break
    case 'nankai':
      add(nankaiToText(payload.data))
      break
    case 'nankaiCommentary':
      add(nankaiCommentaryToText(payload.data))
      break
    case 'kohatsu':
      add(kohatsuToText(payload.data))
      break
    case 'earthquakeCount':
      add(earthquakeCountToText(payload.data))
      break
    case 'estimatedIntensity':
      add(estimatedIntensityToText(payload.data.arrivalTime, true))
      add(estimatedIntensityToText(payload.data.arrivalTime, false))
      break
    case 'quakeNotice':
      // 地震・津波に関するお知らせは音も読み上げも起こさない（運用連絡）。
      // → `docs/spec/data-sources-spec.md` §2「扱う電文種別」
      break
  }

  // 気象庁が書いた文は最下位の層で別の発話として読まれる（→ audio-tts-spec.md §6）。
  // **本体とは別に焼くこと。** 1 つの文字列へ繋ぐと、実際に鳴るときのチャンクの割れ目が
  // 変わって控えが当たらない。
  const liveEvent = toLiveEvent(payload)
  if (liveEvent) add(telegramTextToSpeak(liveEvent, opts)?.text)

  return texts
}

/**
 * キューの電文を、読み上げ側が受け取る形（{@link LiveEvent}）へ直す。
 *
 * **そのまま渡せない。** キューの型（`ReplayPayload`）と読み上げの型（`LiveEvent`）は
 * よく似ているが 2 か所違う —— 推計震度分布図は `isNew` を必須で持ち、お知らせ
 * （`quakeNotice`）は `LiveEvent` に含まれない（音も読み上げも起こさないため）。
 *
 * @returns 読み上げの対象にならない電文では null
 */
function toLiveEvent(payload: ReplayPayload): LiveEvent | null {
  switch (payload.kind) {
    case 'event': return payload.event
    case 'lpgm':
    case 'nankai':
    case 'nankaiCommentary':
    case 'kohatsu':
    case 'earthquakeCount':
      return payload
    // 気象庁の文を引くだけなので `isNew` は結果に効かない（`telegramTextToSpeak` は見ない）。
    case 'estimatedIntensity': return { ...payload, isNew: true }
    case 'quakeNotice': return null
  }
}

/**
 * 1 通ぶんの投機を、例外を漏らさずに行う。
 *
 * **投機の失敗で再生を壊さない。** ここが投げると、覗いた電文の並びごと処理が止まって
 * 以降の投機が走らなくなる。読み上げ文の組み立ては電文の中身次第で例外を出しうる
 * （実データにしか無い形は必ずある）ので、1 通ずつ受け止めて次へ進む。
 */
export function speculativeSpeechTextsSafe(payload: ReplayPayload, opts: TtsSpeechOptions): string[] {
  try {
    return speculativeSpeechTexts(payload, opts)
  } catch (err) {
    log.debug('[VoiceVox] 投機の文を組めなかった（この電文は先に焼かない）', { kind: payload.kind, err })
    return []
  }
}
