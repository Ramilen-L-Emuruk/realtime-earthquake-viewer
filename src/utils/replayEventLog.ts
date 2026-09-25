/**
 * 録画ツール向けのイベントログ（純粋コア）。
 *
 * アプリの中で**何がいつ起きたか**を、外（`window.__replay.drainEvents()`）から汲み出せる形で
 * 溜める。読み上げ・通知音・電文の受信・画面の変化・再生の制御が対象。
 *
 * 【なぜ要るか】録画の編集は「この読み上げはどの電文のものか」を知る必要がある。計画は電文を
 * 取捨選択するので、落とすと決めた電文の読み上げは本編から外さなければいけない。ところが外から
 * 観測できるのは `isSpeaking()` の真偽だけで、**連続して読み上げると 1 本に融ける** ——
 * `speakingCount` は本数を数えるだけで、どの発話かを持たないため。2024-01-01 18:27 の実例では
 * 津波（観測）の 36 秒と震源・震度情報の 24 秒が 60.3 秒 1 本として記録され、落とすと決めた
 * 電文の読み上げが本編に入った。**音の途切れからも分けられない**（0.12〜0.31 秒の息継ぎが
 * 均等に並ぶだけで、境目と区別が付かない）。アプリが出せば根から消える。
 *
 * 【溜めるだけで書き出さない】ブラウザには許可なくファイルへ書き込む口が無い。汲み出しは
 * 外の録画ツールが CDP 越しに定期的に呼ぶ（→ `docs/spec/recording-interface-spec.md`）。
 *
 * 【このファイルは副作用を持たない】配線は各所の呼び出し側、外への口は `App.tsx` の `__replay`。
 * 時刻だけは `clock.ts` から取る —— 記録する側に渡させると、**渡し忘れても型では落ちない**
 * 実時刻とシナリオ時刻の取り違えが起きる（両方 `number`）。
 */
import { serverNow } from './clock'
import { log } from './logger'

/**
 * 溜めておけるイベントの件数。超えたら古い方から捨てる。
 *
 * 録画は 1 区間が最大 65 分、電文は多いときで数秒に 1 通。汲む側は数百ミリ秒ごとに呼ぶ想定なので
 * 通常は数件しか溜まらず、この上限に触れるのは**汲む側が止まったとき**だけ。そのとき黙って
 * 消えるのがいちばん困るので、捨てた件数を {@link ReplayEventBatch.dropped} で返す。
 */
export const REPLAY_EVENT_LOG_CAPACITY = 2000

/**
 * 1 イベントが持てるテキストの上限（文字）。超えたら切って印を付ける。
 *
 * 読み上げ文は長いもので 1000 字強（南海トラフ臨時情報の本文が実測 1055 字）。全文を残すのは
 * 後から中身を確かめられるようにするためで、上限はその倍を見ている。
 */
export const REPLAY_EVENT_TEXT_LIMIT = 2000

/**
 * 鍵ごとに覚えておく「最後に受信した電文」の件数。
 *
 * 遅れて発火する読み上げ（緊急地震速報の第 2 フェーズは安定待ちのタイマーから呼ばれる）が
 * 持ち主を引くために使う。鍵は地震・緊急地震速報の識別子なので、群発でも実用上は数十件で足りる。
 */
export const REPLAY_TELEGRAM_MEMORY_CAPACITY = 100

/** 電文の種別（`LiveEvent` の `kind` と、そこへ流れない「お知らせ」を合わせたもの）。 */
export type ReplayTelegramKind =
  | 'quake' | 'tsunami' | 'eew' | 'lpgm' | 'nankai' | 'nankaiCommentary'
  | 'kohatsu' | 'earthquakeCount' | 'estimatedIntensity' | 'quakeNotice'

/**
 * 「どの電文か」を指す参照。読み上げ・通知音・警報のイベントへ添える。
 *
 * **`seq` だけでなく中身も持つ。** 参照先の `telegram` イベントがバッファから溢れても、
 * 種別と識別子だけは読めるようにしておくため。
 */
export interface ReplayTelegramRef {
  /** その電文の `telegram` イベントの `seq`。 */
  seq: number
  kind: ReplayTelegramKind
  /** 電文が名乗る情報種別（「震度速報」「津波観測に関する情報」等）。読めないものは null。 */
  infoType: string | null
  eventId: string | null
  /** 報番号。気象庁が振らない種別・振らない報では null（震度速報・震源情報は空で届く）。 */
  serial: string | null
}

/** 全イベント共通の枠。記録する側は渡さない（コアが付ける）。 */
export interface ReplayEventCommon {
  /**
   * 通し番号（1 始まり・単調増加）。
   *
   * **捨てられたことがここからも読める。** 汲んだ配列の `seq` が飛んでいれば、その間のイベントは
   * 上限を超えて捨てられている（{@link ReplayEventBatch.dropped} と二重の保険）。
   */
  seq: number
  /** シナリオ時刻（epoch ms）。`__replay.now()` と同じ時間軸で、再生の速度・オフセットを掛けた後の値。 */
  at: number
  /** 実時刻（epoch ms）。突き合わせの保険。 */
  wallAt: number
}

/**
 * 読み上げ 1 本の始まり。
 *
 * **1 回の `speakWithVoicevox` につき 1 件。** 連続して読み上げても融けないのはこのため。
 */
export interface ReplaySpeechStartEvent extends ReplayEventCommon {
  type: 'speechStart'
  /** この読み上げの識別子。`speechEnd` / `speechChunk` が同じ値で指す。 */
  speechId: number
  /** 緊急地震速報の列か、それ以外か（列が別で、割り込みの規則も違う）。 */
  channel: 'eew' | 'other'
  /** 読み上げの主題（非 EEW の `SpeechTopic`。緊急地震速報では null）。 */
  topic: string | null
  /** 緊急地震速報の地震を指す鍵（`eewEventKey`）。それ以外では null。 */
  eewKey: string | null
  /** 画面の追従が使う主題（渡されていなければ null）。 */
  subject: string | null
  telegram: ReplayTelegramRef | null
  /** 読み上げたテキスト。{@link REPLAY_EVENT_TEXT_LIMIT} で切る。 */
  text: string
  /** 切る前の文字数。 */
  textLength: number
  textTruncated: boolean
}

/** 読み上げ 1 本の終わり（割り込まれて途中で終わった場合も含む）。 */
export interface ReplaySpeechEndEvent extends ReplayEventCommon {
  type: 'speechEnd'
  speechId: number
  /**
   * 1 音でも実際に鳴ったか。
   *
   * 偽になるのは合成が 1 つも成功しなかった場合と、鳴り始める前に取り下げた場合。
   * **「終わった」と「鳴った」は別物** —— VOICEVOX 未起動でも読み上げは正常終了する。
   */
  spoke: boolean
  /** 開始からの経過（ms・実時刻で測る）。 */
  durationMs: number
}

/**
 * チャンクの再生予約。
 *
 * **`startAt` は予約であって鳴り始めではない。** 2 番目以降のチャンクでは未来を指す。
 */
export interface ReplaySpeechChunkEvent extends ReplayEventCommon {
  type: 'speechChunk'
  speechId: number
  /** `chunks` の添字。**連番になるとは限らない**（合成に失敗したチャンクは飛ぶ）。 */
  index: number
  chunkCount: number
  text: string
  /** AudioContext の時間軸（秒）での再生開始予定。`at` とは基準が違う。 */
  startAt: number
}

/** 通知音の再生。 */
export interface ReplaySoundEvent extends ReplayEventCommon {
  type: 'sound'
  /** 音の種別（`AlertSoundType`）。 */
  sound: string
  telegram: ReplayTelegramRef | null
}

/**
 * 電文が画面・音へ回らなかった理由。回ったなら null。
 *
 * **「届いたのに読まれなかった」を残すために要る。** これが無いと、編集側は電文の一覧と
 * 読み上げの一覧を突き合わせて欠けを推測するしかない。
 */
export type ReplayTelegramSkip =
  /** カードが中身を採らなかった（音・読み上げ・タイトル・タブ移動が起きない）。 */
  | 'heldBack'
  /** 緊急地震速報の古い報（受け入れ済みの報番号より前）。受信の入口で捨てる。 */
  | 'staleSerial'
  /** 試験報・訓練報。 */
  | 'testReport'
  /**
   * そもそも音・読み上げの経路へ流さないと決めている——**種別まるごと**（地震・津波に関する
   * お知らせ）と、**種別内の特定の値**（長周期地震動観測情報の取消・階級 0。この 2 つは
   * 音読み上げの対象外と決めているだけで、`lpgmByEventId` への反映自体は必ず起こる）の
   * どちらも指す。**`notApplied` との違いは「状態が動いたか」ではなく「意図した除外か」**——
   * `notApplied` は古い報・重複配信・期限切れという**受信側の事情**で棄却されるのに対し、
   * こちらは電文の内容（取消・階級）を見て**アプリが最初から音読み上げの対象に含めないと
   * 決めている**。
   */
  | 'notDispatched'
  /**
   * リプレイ開始時の「窓の手前」を作るサイレント注入（→ `docs/spec/settings-pwa-spec.md` §6
   * 「初期状態（24 時間）では足りないものを、履歴の遡り（7 日）から補う」）。**画面には反映
   * されるが、音・読み上げ・タブ移動は起こさない**設計そのもの。届いた電文を全件記録すると
   * 掲げている以上、ここを漏らすと録画ツールは再生開始直後の状態を電文一覧から追えない。
   */
  | 'silentReplayInit'
  /**
   * 反映されなかった（古い報・重複配信・期限切れで棄却された）。`silentReplayInit` とは
   * 別の理由——サイレントかどうかに関わらず、電文自体が状態を動かさなかった場合。
   */
  | 'notApplied'

/** 電文の受信。 */
export interface ReplayTelegramEvent extends ReplayEventCommon {
  type: 'telegram'
  kind: ReplayTelegramKind
  infoType: string | null
  eventId: string | null
  serial: string | null
  cancelled: boolean
  skipped: ReplayTelegramSkip | null
}

/** 表示中のタブが実際に変わった。 */
export interface ReplayTabEvent extends ReplayEventCommon {
  type: 'tab'
  tab: string
  /**
   * 直前のタブ。**既定タブで初期化されるため、実際には null にならない**——記録する側
   * （`App.tsx` の `recordedTabRef`）は「まだ何も描いていない」状態を持たず、起動時の
   * タブで最初から埋まっている。型が `string | null` なのは将来の初期化順の変更に備えた
   * 余裕であって、いまの実装がその値を返す保証ではない。
   */
  prevTab: string | null
}

/** 警報・注意報の状態が動いた。 */
export interface ReplayAlertEvent extends ReplayEventCommon {
  type: 'alert'
  category: 'eew' | 'tsunami'
  change:
    /** 新規の発表。 */
    | 'issued'
    /** 段階が上がった（予報 → 警報、津波注意報 → 津波警報 等）。 */
    | 'upgraded'
    /** 段階が下がった（全部は解けていない）。 */
    | 'downgraded'
    /** 解除。 */
    | 'lifted'
    /** 取消（誤報）。 */
    | 'retracted'
    /** 時間切れで消えた（自動解除・有効期限）。 */
    | 'expired'
  /** 段階の名前（「大津波警報」「緊急地震速報（警報）」等）。読めないときは null。 */
  grade: string | null
  telegram: ReplayTelegramRef | null
}

/** 画面の一部が自動で開いた・閉じた。 */
export interface ReplayOverlayEvent extends ReplayEventCommon {
  type: 'overlay'
  overlay:
    /** 推計震度分布図のモード。 */
    | 'distribution'
    /** 震度を入手していない地点の一覧。 */
    | 'unreceived'
    /** 長周期地震動の一覧。 */
    | 'lpgm'
    /** 気象庁が書いた文の表示。 */
    | 'telegramText'
    /** 特別情報のためのパネル展開。 */
    | 'specialInfoPanel'
    /** 行動チェックリストの帯。 */
    | 'actionChecklist'
  open: boolean
  /** 何がそれを開いた・閉じたか（呼び出し側が渡す短い語）。 */
  reason: string
  /**
   * どの主題の表示か（渡されていなければ null）。
   *
   * **`telegramText` は 1 つの `overlay` 種別を 6 箇所（地震カードの補足・南海トラフ臨時情報・
   * 後発地震注意情報・関連解説情報・地震回数・津波のコメント欄）が共有しているため、これが
   * 無いと「どの表示が開いたか」が区別できない。他の `overlay` 種別は 1 対 1 で対応する
   * 呼び出し元しか持たないため、いまのところ渡していない。**
   */
  subject: string | null
}

/** 再生の開始・停止（シナリオ時刻のジャンプはこれで起きる）。 */
export interface ReplayControlEvent extends ReplayEventCommon {
  type: 'control'
  action: 'start' | 'stop'
  /** 再生の基準時刻（ISO 8601）。`stop` では null。 */
  target: string | null
  /** 壁時計に足すオフセット(ms)。`stop` では null（ライブへ戻る）。 */
  offset: number | null
}

/** 電文の取得。 */
export interface ReplayFetchEvent extends ReplayEventCommon {
  type: 'fetch'
  phase: 'start' | 'done' | 'error'
  /**
   * 何の取得か（`main` 本編／`prefetch` 先読み）。
   *
   * **いま出るのはこの 2 つだけ。** 初期状態（24 時間）と地震カードの履歴は本編の取得と
   * 同じ呼び出しの中で並行して走り、終わりを別に持たないため分けていない。
   */
  target: string
  /** 失敗の内容（`error` のときだけ）。 */
  message: string | null
}

export type ReplayEvent =
  | ReplaySpeechStartEvent
  | ReplaySpeechEndEvent
  | ReplaySpeechChunkEvent
  | ReplaySoundEvent
  | ReplayTelegramEvent
  | ReplayTabEvent
  | ReplayAlertEvent
  | ReplayOverlayEvent
  | ReplayControlEvent
  | ReplayFetchEvent

/** 共通の枠を除いた、記録する側が渡す形。 */
type WithoutCommon<T> = T extends unknown ? Omit<T, keyof ReplayEventCommon> : never
export type ReplayEventInput = WithoutCommon<ReplayEvent>

/**
 * 汲み出したひとまとまり。
 *
 * **配列だけを返す形にしていない。** 捨てた件数を別の関数で読ませると、汲むのと読むのとの間に
 * 起きた捨てを取りこぼす。同じ呼び出しで返せば、その齟齬が起きない。
 */
export interface ReplayEventBatch {
  events: ReplayEvent[]
  /** 前回汲んでから、上限を超えて捨てた件数。 */
  dropped: number
}

// ─── 状態 ─────────────────────────────────────────────

const buffer: ReplayEvent[] = []
let nextSeq = 1
let nextSpeech = 1
let droppedSinceDrain = 0
let currentTelegram: ReplayTelegramRef | null = null
const telegramByKey = new Map<string, ReplayTelegramRef>()

// ─── 記録 ─────────────────────────────────────────────

/**
 * イベントを 1 件溜める。戻り値はそのイベントの `seq`。
 *
 * **`at` / `wallAt` / `seq` はここで付ける。** 記録する側に渡させると、シナリオ時刻と実時刻の
 * 取り違え（どちらも `number`）が型では捕まらない。
 *
 * **記録の失敗で本体を止めない。** これは収録のための仕掛けで、呼び出し側は地震の電文を
 * 処理している最中。ここから例外が抜けると、記録が取れないどころか**警報そのものが画面に
 * 出なくなる**。握ったことは残す。
 *
 * **番号は握る前に採る。** そうすれば記録できなかった回も連番が進み、汲んだ側は `seq` の
 * 飛びとして気づける（捨てたときと同じ形で表に出る）。
 */
export function recordReplayEvent(input: ReplayEventInput): number {
  const seq = nextSeq++
  try {
    // 共通の枠を足すと元のバリアントに戻るが、TypeScript は共用体ごとの結合を推論しない。
    const event = { ...input, seq, at: serverNow(), wallAt: Date.now() } as ReplayEvent
    buffer.push(event)
    while (buffer.length > REPLAY_EVENT_LOG_CAPACITY) {
      buffer.shift()
      droppedSinceDrain++
    }
  } catch (err) {
    log.warn('[replay] イベントを記録できなかった（本体は続行）', err)
  }
  return seq
}

/** 読み上げ 1 本ぶんの識別子を採る（`speechStart` / `speechEnd` / `speechChunk` を結ぶ）。 */
export function nextSpeechId(): number {
  return nextSpeech++
}

/** テキストを上限で切る。戻り値は `[切ったテキスト, 元の長さ, 切ったか]`。 */
export function truncateReplayText(text: string): [string, number, boolean] {
  if (text.length <= REPLAY_EVENT_TEXT_LIMIT) return [text, text.length, false]
  let cut = REPLAY_EVENT_TEXT_LIMIT
  // **サロゲートペアの中間で切らない。** `slice` は UTF-16 コード単位で切るため、
  // 上限がちょうど補助水面文字（絵文字等）の上位サロゲートに当たると、末尾に孤立
  // サロゲートが残る（不正な UTF-16 列）。読み上げ文は漢字・かなが中心で滅多に
  // 起きないが、境界が一致すれば起こりうる。
  const code = text.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1
  return [text.slice(0, cut), text.length, true]
}

// ─── 汲み出し ─────────────────────────────────────────

/** 溜まったイベントを返して、バッファから消す。 */
export function drainReplayEvents(): ReplayEventBatch {
  const events = buffer.splice(0, buffer.length)
  const dropped = droppedSinceDrain
  droppedSinceDrain = 0
  return { events, dropped }
}

/**
 * 消さずに覗く（デバッグ用）。
 *
 * **捨てた件数も持ち越したままにする。** ここで 0 へ戻すと、覗いただけで取りこぼしの印が
 * 消え、あとから汲んだ側が欠けに気づけない。
 */
export function peekReplayEvents(): ReplayEventBatch {
  return { events: [...buffer], dropped: droppedSinceDrain }
}

// ─── 電文の文脈 ───────────────────────────────────────

/**
 * 受信処理が走っている間だけ「いま処理中の電文」を立てる。
 *
 * **読み上げの持ち主をこれで決める。** 受信処理は同期で走り、読み上げはその中で予約されるので、
 * 予約した瞬間の文脈がその読み上げの持ち主になる。呼び出し側へ引数を配る形にすると、経路を
 * 足したときに渡し忘れが起き、症状は「持ち主が空」という静かな形でしか出ない。
 *
 * **`fn` に非同期関数を渡さないこと。** 戻すのは `finally` なので、`await` を跨ぐ関数を
 * 渡すと**最初の `await` で文脈が戻ってしまい**、その後に予約した読み上げは持ち主を引けない。
 * 型は `T` が `Promise` でも通るので検査では止まらず、症状は「持ち主が空」だけ。
 * 間を置く経路は {@link captureReplayTelegramContext}（こちらも同期の `fn` を取る）で
 * 掴み直すこと。
 */
export function withReplayTelegramContext<T>(ref: ReplayTelegramRef, fn: () => T): T {
  const prev = currentTelegram
  currentTelegram = ref
  try {
    return fn()
  } finally {
    // **例外でも必ず戻す。** 戻し忘れると、以後すべての読み上げがこの電文の持ち物として
    // 記録される —— 編集側から見れば「別の電文の読み上げ」が紛れ込む形になる。
    currentTelegram = prev
  }
}

/** いま処理中の電文（受信処理の外では null）。 */
export function currentReplayTelegram(): ReplayTelegramRef | null {
  return currentTelegram
}

/**
 * いまの文脈を捕まえて、あとから同じ文脈で実行するための関数を返す。
 *
 * 間を置いてから読み上げる経路（通知音との間・誤報取消）は、発火する頃には受信処理を抜けている。
 * 予約するときにこれで捕まえておけば、タイマーの中でも持ち主を引ける。
 */
export function captureReplayTelegramContext(): <T>(fn: () => T) => T {
  const captured = currentTelegram
  return <T,>(fn: () => T): T => {
    const prev = currentTelegram
    currentTelegram = captured
    try {
      return fn()
    } finally {
      currentTelegram = prev
    }
  }
}

/**
 * 鍵ごとに「最後に受信した電文」を覚える。
 *
 * 文脈を捕まえられない経路（緊急地震速報の第 2 フェーズは安定待ちのタイマーから発火する）が
 * 持ち主を引くための控え。
 */
export function rememberReplayTelegram(key: string, ref: ReplayTelegramRef): void {
  // **入れ直して古さの順を更新する。** `Map` は挿入順を保つので、上書きだけでは順序が動かず、
  // 更新され続けている鍵が「いちばん古い」ものとして捨てられる。
  telegramByKey.delete(key)
  telegramByKey.set(key, ref)
  while (telegramByKey.size > REPLAY_TELEGRAM_MEMORY_CAPACITY) {
    const oldest = telegramByKey.keys().next()
    if (oldest.done) break
    telegramByKey.delete(oldest.value)
  }
}

/** 鍵から「最後に受信した電文」を引く（覚えていなければ null）。 */
export function latestReplayTelegram(key: string): ReplayTelegramRef | null {
  return telegramByKey.get(key) ?? null
}

/** テスト用に全部の状態を捨てる。 */
export function __resetReplayEventLogForTest(): void {
  buffer.length = 0
  nextSeq = 1
  nextSpeech = 1
  droppedSinceDrain = 0
  currentTelegram = null
  telegramByKey.clear()
}
