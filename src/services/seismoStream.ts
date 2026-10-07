// 自作地震計ホスト（`seismo-host/`）の押し出しの口へ繋ぐ受け口。
//
// **繋ぐ先は利用者が指定する LAN 内の機器で、配信元の API ではない。** 設定タブに URL を
// 入れて読み上げと同じように有効にしたときだけ繋ぐ（既定は無効）。繋がらないことは
// 平常の状態のひとつで、アプリの他の機能は何ひとつ止まらない。
//
// **`EventSource` は使わない。** 押し出しの実装は SSE（`seismo-host/README.md`
// 「状態と押し出しの口」）なので `EventSource` で読めるし、管理コンソール側
// （`seismo-host/src/admin/waveStream.ts`）は実際そうしている。それでもこちらが
// `fetch` ＋ `ReadableStream` を採るのは、あちらが自分のコメントに書いている代償が
// こちらでは重いから ——
//
//   - **断られた理由が読めない。** 同時に繋いでいられるのは 8 本までで、超えると
//     ホストは 503 と本文の `too-many-subscribers` を返す。`EventSource` は応答の
//     本文を読ませてくれないので、「上限で断られた」と「ホストが落ちている」が
//     利用者には同じ「繋がりません」に見える
//   - **繋ぎ直す間隔を決められない。** `EventSource` はホストが `retry:` で言った
//     間隔（3 秒）で延々と繋ぎ直す。断られている間もその調子で叩き続けることになる
//
// 管理コンソールは同じ LAN の中から開くものなので、そこは割り切れた。**こちらは
// Tailscale 越し・外出先の電波から繋ぐ**ので、理由と間隔をこちらが握る。
//
// **受け取る形はここに書く。** ホスト側の型（`seismo-host/src/receiver/*`）を
// `import type` で借りない。口は HTTP の JSON で、境界を越えてくる値を型どおりと
// 信じないため —— ホスト側の版が古ければ形は実際に違う。管理コンソールが同じ判断を
// していて、理由もそこにある（`seismo-host/src/admin/readJson.ts`）。

import { createLogThrottle, log } from '../utils/logger'
import { arr, obj, str } from './parseHelpers'

/**
 * 繋ぎ直しの待ち（ms）。**倍々にして上限で頭打ち。**
 *
 * 失敗しても同じ間隔で撃ち続ける形にしない（`docs/spec/data-sources-spec.md` §4
 * 「取得に失敗したら間隔を空ける」と同じ考え方）。**ここでそれが要るのは、
 * 失敗が長く続く形が 2 つあるから** —— 購読の上限で断られている間と、
 * ホストを止めている間。どちらも 3 秒ごとに叩き続ける理由が無い。
 */
const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 30_000

/**
 * 何も届かなくなってから繋ぎ直すまで（ms）。
 *
 * **ホストは 15 秒ごとに生存確認（`: ping`）を送る**ので、これが来なくなれば
 * 押し出しは死んでいる。3 回ぶん待つ。
 *
 * **これが無いと、黙って切れた繋ぎに永久に張り付く。** 途中の機器が状態を捨てた
 * 場合（携帯の回線が切り替わった・スリープから復帰した）、こちら側の読み取りは
 * 終わりも例外も返さない —— 画面には最後に届いた震度が残り続け、
 * 「揺れていない」と区別が付かない。
 */
const STALL_MS = 45_000

/** `/status` を取るときの打ち切り（ms）。LAN 内の相手なので短くてよい。 */
const STATUS_TIMEOUT_MS = 5000

/** 同じ理由の記録を間引く間隔（ms）。到達できない設定のまま放置されても埋めない。 */
const FAILURE_LOG_INTERVAL_MS = 300_000

/**
 * SSE の枠を解く途中の溜めの上限（文字数）。
 *
 * **枠の区切り（空行）が一度も来なければ、溜めは際限なく伸びる。** ホスト側が
 * 末尾の空行を落とす版だった場合と、間に挟まる機器が本文を書き換えた場合に起きる。
 *
 * **止める仕組みがここ以外に無い。** 停滞の検出（{@link STALL_MS}）が見ているのは
 * 「何かバイトが届いたか」で、届いた中身が枠として成立しているかは問わない ——
 * つまり**壊れた本文が流れ続けている間、あちらは「元気に届いている」と判定する**。
 *
 * 1 件は大きくても数 KB なので、これだけあれば正常な途切れ方（枠の途中で読み取りが
 * 切れる）には十分な余裕がある。
 */
const MAX_SSE_BUFFER_CHARS = 1_000_000

/**
 * 観測点の台帳を取り直す最小間隔（ms）。**引けたときの値。**
 *
 * 知らない識別子の震度が届いたら引きに行くが、**引けなかった場合に毎秒叩かない
 * ための下限**（震度は毎秒届く）。観測点やセンサーが増えるのは人が設定を
 * 書き換えたときだけなので、1 分の遅れは実害にならない。
 */
const STATIONS_REFETCH_MIN_MS = 60_000

/**
 * 台帳を引けなかったときに、次を試すまでの最小間隔（ms）。
 *
 * **引けた場合（1 分）と分ける。** 台帳が引けないと、センサー単独の震度
 * （`event: reading`）を**どの観測点にも寄せられない** —— 合成が出ない観測点
 * （有効なセンサーが 2 台未満）ではそれが唯一の経路なので、震度が 1 件も出ない。
 *
 * **1 分の遅れが「実害にならない」のは引けている場合だけ。** 引けていない間は
 * 機能そのものが止まっているので、そこを同じ間隔で待たせる理由が無い
 * （敵対的レビューがこの共有を指摘した）。
 */
const STATIONS_RETRY_MIN_MS = 5000

/** センサー 1 本の計測震度（`event: reading`）。 */
export interface SeismoSensorReading {
  readonly boardKey: string
  readonly sensorId: string
  /** この値が代表する時刻。読めなければ null。 */
  readonly atMs: number | null
  /**
   * 計測震度相当。**窓の中身が足りなければ null。**
   *
   * 「揺れていない」を意味する値ではないので 0 として扱わないこと。
   */
  readonly intensity: number | null
}

/**
 * 観測点ぶんの計測震度（`event: station-reading`。複数センサーの合成）。
 *
 * **表示名を持たない。** ホストが送るのは `stationId` だけなので、名前は
 * `/status` から引く（{@link fetchSeismoStations}）。
 */
export interface SeismoStationReading {
  readonly stationId: string
  readonly atMs: number | null
  readonly intensity: number | null
}

/** 観測点ぶんの合成波形（`event: station-wave`）。 */
export interface SeismoStationWave {
  readonly stationId: string
  /** 先頭サンプルの時刻。 */
  readonly firstSampleMs: number
  readonly msPerSample: number
  /**
   * 3 成分の加速度（gal）。**直流を落とした変動分。**
   *
   * ホスト側は落とした直流（`dcGal`）も併せて送ってくるが、こちらは受け取らない ——
   * 絵にするのは揺れの大きさで、取り付けの傾きぶんのオフセットは要らない。
   */
  readonly gal: readonly [readonly number[], readonly number[], readonly number[]]
  /**
   * そのサンプルへ実際に効いたセンサーの本数。**`gal` と同じ長さ。**
   *
   * **1 台しか効いていない区間を見分けるために持つ。** 合成の売りは複数台で
   * 揺れを裏付けることなので、本数が落ちている区間は「合成の絵」として
   * 同じ重みで読めない。
   */
  readonly memberCount: readonly number[]
}

/**
 * ホストが取り戻した区間の合成波形を作り直し、控え（`GET /waves`）へ足し終えた知らせ
 * （`event: station-wave-revised`・#597）。**範囲だけで、波形は載っていない** —— 自分の抱えている
 * 穴と重なるときだけ取りに行く。
 */
export interface SeismoStationWaveRevised {
  readonly stationId: string
  /** 作り直した範囲の始まり（含む）。 */
  readonly fromMs: number
  /** 作り直した範囲の終わり（含まない）。 */
  readonly toMs: number
}

/** 押し出しで届く 1 件。 */
export type SeismoMessage =
  | { readonly kind: 'reading'; readonly reading: SeismoSensorReading }
  | { readonly kind: 'station-reading'; readonly reading: SeismoStationReading }
  | { readonly kind: 'station-wave'; readonly wave: SeismoStationWave }
  | { readonly kind: 'station-wave-revised'; readonly revised: SeismoStationWaveRevised }

/**
 * 波形をどこまで要求するか。**ホストの `?wave=` に対応する。**
 *
 * **`'all'`（センサー単独の波形）は用意しない。** あれは管理コンソールの波形タブが
 * 使うもので、実測で毎秒 65 KB ある。こちらが描くのは観測点の合成 1 本だけなので、
 * 要求する理由が無い（口の側の粒度は `seismo-host/src/receiver/readingHub.ts` の
 * `WaveWant`）。
 *
 * **震度はここで選り分けられない。** `reading`（センサー単独）も
 * `station-reading`（観測点の合成）も波形の粒度に関わらず配られる。
 * 捨てずに読むのは、**観測点に 1 台しか割り当てていない場合ホストは合成を作らず、
 * `station-reading` が出ない**ため —— そのときの震度は `reading` からしか取れない。
 */
export type SeismoWaveWant = 'none' | 'station'

/**
 * 繋がり具合。
 *
 * **`reconnecting` に理由を載せる。** これが `fetch` を選んだ見返り ——
 * 「上限で断られた」と「ホストが落ちている」を利用者が見分けられる。
 */
export type SeismoStreamState =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'open' }
  | { readonly kind: 'reconnecting'; readonly detail: string; readonly nextAttemptInMs: number }

export interface SeismoStreamOptions {
  /** ホストの基点 URL（設定タブに入力された値）。 */
  readonly baseUrl: string
  /**
   * 波形も要るか。**要らないなら送らせない**（合成 1 本で毎秒 15 KB）。
   *
   * **`'none'` でも無料ではない。** 波形の粒度に関わらず配られる種別
   * （`reading`・`station-reading`）が毎秒およそ 2.6 KB ある。実測値の出どころは
   * ホスト側（`seismo-host/src/receiver/readingHub.ts` の `SubscribeOptions.wave`）。
   */
  readonly wave: SeismoWaveWant
  /** これが落ちたら閉じる。**画面を離れたら必ず落とすこと**（同時購読は 8 本まで）。 */
  readonly signal: AbortSignal
  readonly onMessage: (message: SeismoMessage) => void
  /** 繋がり具合が変わったら呼ぶ。**同じ状態では呼ばない。** */
  readonly onState: (state: SeismoStreamState) => void
  /**
   * 読めない押し出しが届いたら呼ぶ。**累計と、最後の理由。**
   *
   * **黙って捨てない。** 形が変わったこと（ホストと PWA の版の食い違い）は、
   * 画面からは「震度が出ない」としか見えない —— 繋がっていないのか、読めて
   * いないのかを分ける手掛かりがここにしか無い。
   */
  readonly onUnreadable?: (count: number, detail: string) => void
  /** テストで差し替える。既定は `globalThis.fetch`。 */
  readonly fetchImpl?: typeof fetch
  /** テストで差し替える。既定は `setTimeout` を包んだ待ち。 */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

export interface SeismoStreamHandle {
  /** 閉じる。**`signal` を落とすのと同じ。** 二度呼んでもよい。 */
  close(): void
}

/** 観測点 1 つぶんの素性（`/status` から引く）。 */
export interface SeismoStationInfo {
  readonly stationId: string
  readonly displayName: string
  readonly lat: number | null
  readonly lon: number | null
}

/**
 * センサー 1 個がどの観測点に属するか（`/status` の `sensors[]` から引く）。
 *
 * **これが無いと、センサー単独の震度（`event: reading`）を観測点へ寄せられない。**
 * 押し出しが名乗るのは `boardKey`・`sensorId` だけで、観測点との対応はホストの設定に
 * しかない —— 引けなければ画面に出るのは「自宅」ではなく `mac:020000000003` になる。
 */
export interface SeismoSensorInfo {
  readonly boardKey: string
  readonly sensorId: string
  /**
   * 割り当てられた観測点。**設定に無い基板は `null`。**
   *
   * 観測点を知らないことと震度が出せないことは別の事実なので、ホスト側も混ぜていない
   * （`statusReport.ts` の `station` の説明）。
   */
  readonly stationId: string | null
}

// **`/status` の `enabled`（センサーが有効か）は読まない。** 「合成が出るかどうかは
// これで決まる」ので拾いたくなるが、読んでも使い道が無い ——
//
//   - **無効なセンサーからは震度そのものが届かない。** ホストは換算より前で弾く
//     （`seismo-host/src/receiver/intensityPipeline.ts` の `sensor-disabled`）ので、
//     こちらで選り分ける相手がいない
//   - **合成が出るかどうかは「届いたか」で判断する**（`useSeismoStation.ts`）。
//     設定を根拠にすると、設定と実際が食い違ったときに判断ごと狂う

/**
 * `/status` を取った結果。
 *
 * **`stationIntensities[]`（合成が出している最新の震度）は読まない。** 繋いだ直後の
 * 空白を埋められそうに見えるが、埋まるのは**最大 1 秒**（震度は毎秒 1 件）で、
 * 代償のほうが大きい —— あの値の時刻はホストの時計なので、こちらから見て
 * 古いかどうかを測る術が無い。止まった観測点の値を「たった今届いた」として
 * 数秒出すことになる（`useSeismoStation.ts` が古さを端末側の経過時間で測るのは
 * まさにそのため）。
 */
export type SeismoHostCheck =
  /** 繋がって、形も読めた。 */
  | {
      readonly kind: 'ok'
      readonly stations: readonly SeismoStationInfo[]
      /** ホストが把握しているセンサーの本数（観測点へ割り当てていないものも含む）。 */
      readonly sensorCount: number
      /** センサーごとの割り当て。**素性を読めなかったものは並ばない。** */
      readonly sensors: readonly SeismoSensorInfo[]
    }
  /** 応答が返らなかった（落ちている・経路が無い・混在コンテンツで止められた）。 */
  | { readonly kind: 'unreachable'; readonly detail: string }
  /** 応答は返ったが HTTP が成功ではない。 */
  | { readonly kind: 'http-error'; readonly status: number }
  /** 応答は返ったが、こちらが期待する形ではない（別のものが応えている・版が古い）。 */
  | { readonly kind: 'unreadable'; readonly detail: string }

/**
 * 繋げる形の URL かを判定する。
 *
 * **`isValidVoicevoxUrl`（`utils/voicevox.ts`）と同じ方針。** 見るのは「HTTP で
 * 叩ける URL として成立しているか」だけで、ホスト名の中身には踏み込まない
 * （LAN のホスト名・IPv4・IPv6・Tailscale の名前のいずれも来る）。
 *
 * **入力途中の値をここで弾き切ることは期待できない。** `http://1` も URL としては
 * 正常に解析できる。ここが担うのは、スキームの書き忘れのような直らない誤りを
 * 「ホストが応えません」と誤診しないこと。
 */
export function isValidSeismoHostUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 経路を繋ぐための基点（末尾のスラッシュを落とす）。
 *
 * **落とさないと二重スラッシュになる。** `http://host:50506/` ＋ `/status` は
 * `http://host:50506//status` で、ホストは 404 を返す —— URL としては正しいので
 * {@link isValidSeismoHostUrl} は通り、接続状態だけが「応えません」になって
 * **動いているのに繋がらない**という誤診になる（VOICEVOX 側で実際に踏んだ罠）。
 */
function apiBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/** 数として読めるものだけ通す。**`null`・文字列・`NaN`・無限は通さない。** */
function readFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 数の並びとして読めるものだけ通す。**1 つでも読めなければ `null`。**
 *
 * **読めない点だけを飛ばして繋がない。** 波形の途中の 1 点を抜いて前後を詰めると、
 * そこだけ時間が縮んだ波形になる —— 絵としては普通に見えるので、見ている人には
 * 確かめる手立てが無い（管理コンソール側の `readJson.ts` と同じ判断）。
 */
function readFiniteArray(value: unknown): readonly number[] | null {
  if (!Array.isArray(value)) return null
  for (const n of value) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return null
  }
  return value as readonly number[]
}

/** 3 成分の並びとして読む。**成分の数が 3 でない・長さが揃わないものは通さない。** */
function readGal(
  value: unknown,
): readonly [readonly number[], readonly number[], readonly number[]] | null {
  if (!Array.isArray(value) || value.length !== 3) return null
  const ns = readFiniteArray(value[0])
  const ew = readFiniteArray(value[1])
  const ud = readFiniteArray(value[2])
  if (ns === null || ew === null || ud === null) return null
  if (ns.length !== ew.length || ns.length !== ud.length) return null
  return [ns, ew, ud]
}

/**
 * 読み取りに失敗した理由。
 *
 * **文字列で返す。** 受け手（`onUnreadable`）が画面へ出すためのもので、
 * 分岐には使わない —— 形が違うことへの対処は「捨てる」以外に無い。
 */
type ReadResult<T> = { readonly value: T } | { readonly detail: string }

function readSensorReading(data: unknown): ReadResult<SeismoSensorReading> {
  const o = obj(data)
  const boardKey = str(o.boardKey)
  const sensorId = str(o.sensorId)
  if (boardKey === '' || sensorId === '') return { detail: 'reading に boardKey / sensorId が無い' }
  return {
    value: { boardKey, sensorId, atMs: readFinite(o.atMs), intensity: readFinite(o.intensity) },
  }
}

function readStationReading(data: unknown): ReadResult<SeismoStationReading> {
  const o = obj(data)
  const stationId = str(o.stationId)
  if (stationId === '') return { detail: 'station-reading に stationId が無い' }
  return { value: { stationId, atMs: readFinite(o.atMs), intensity: readFinite(o.intensity) } }
}

function readStationWave(data: unknown): ReadResult<SeismoStationWave> {
  const o = obj(data)
  const stationId = str(o.stationId)
  if (stationId === '') return { detail: 'station-wave に stationId が無い' }
  const firstSampleMs = readFinite(o.firstSampleMs)
  const msPerSample = readFinite(o.msPerSample)
  // **刻みが 0 以下のものは通さない。** 絵の横軸がそこで壊れる（0 なら全サンプルが
  // 同じ時刻に重なり、負なら時間が逆へ進む）。
  if (firstSampleMs === null || msPerSample === null || msPerSample <= 0) {
    return { detail: 'station-wave の時刻・刻みが読めない' }
  }
  const gal = readGal(o.gal)
  if (gal === null) return { detail: 'station-wave の gal が読めない' }
  const memberCount = readFiniteArray(o.memberCount)
  // **`memberCount` の長さが `gal` と違うものは通さない。** 揃っていることを前提に
  // 「このサンプルは何本で裏付けたか」を読むので、ずれたまま描くと別のサンプルの
  // 本数を見せることになる。
  if (memberCount === null || memberCount.length !== gal[0].length) {
    return { detail: 'station-wave の memberCount が gal と揃わない' }
  }
  return { value: { stationId, firstSampleMs, msPerSample, gal, memberCount } }
}

function readStationWaveRevised(data: unknown): ReadResult<SeismoStationWaveRevised> {
  const o = obj(data)
  const stationId = str(o.stationId)
  if (stationId === '') return { detail: 'station-wave-revised に stationId が無い' }
  const fromMs = readFinite(o.fromMs)
  const toMs = readFinite(o.toMs)
  // **逆向きの範囲は通さない。** 取りに行く範囲がそこで壊れる。
  if (fromMs === null || toMs === null || toMs <= fromMs) {
    return { detail: 'station-wave-revised の範囲が読めない' }
  }
  return { value: { stationId, fromMs, toMs } }
}

/**
 * 押し出しの 1 件を読む。
 *
 * **知らない `event` 名は「読めない」に数えない。** ホストが将来種別を足しても
 * こちらは困らない（要らないものが届いているだけ）ので、`null` を返して黙って捨てる。
 * **`wave`（センサー単独の波形）もここへ落ちる** —— 要求していないのに届くのは
 * ホスト側が `?wave=station` を知らない古い版のときだが、それで画面が壊れる
 * わけではない。
 */
function readMessage(event: string, data: string): ReadResult<SeismoMessage> | null {
  if (
    event !== 'reading' &&
    event !== 'station-reading' &&
    event !== 'station-wave' &&
    event !== 'station-wave-revised'
  ) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return { detail: `${event} の JSON を読めない` }
  }
  switch (event) {
    case 'reading': {
      const r = readSensorReading(parsed)
      return 'value' in r ? { value: { kind: 'reading', reading: r.value } } : r
    }
    case 'station-reading': {
      const r = readStationReading(parsed)
      return 'value' in r ? { value: { kind: 'station-reading', reading: r.value } } : r
    }
    case 'station-wave': {
      const r = readStationWave(parsed)
      return 'value' in r ? { value: { kind: 'station-wave', wave: r.value } } : r
    }
    case 'station-wave-revised': {
      const r = readStationWaveRevised(parsed)
      return 'value' in r ? { value: { kind: 'station-wave-revised', revised: r.value } } : r
    }
  }
}

/**
 * SSE の文面を 1 件ずつに解く。
 *
 * **自分で解く。** `EventSource` を使わないのだから、枠の解釈もこちらの仕事。
 * 押さえるのは 4 つ ——
 *
 *   - 区切りは**空行**。1 回の読み取りが枠の途中で切れることも、複数の枠を
 *     まとめて含むこともある（TCP は境界を保たない）
 *   - `:` で始まる行は**コメント**。ホストの生存確認（`: ping`）がこれ
 *   - `retry:` は**読み飛ばす**。繋ぎ直しの間隔はこちらが決める
 *   - `data:` は**複数行になりうる**ので改行で繋ぐ（SSE の定め）
 *
 * **`\r\n` も受ける。** 今のホストは `\n` で書くが、間に代理が挟まれば変わりうる。
 *
 * @param onOverflow 溜めが上限（{@link MAX_SSE_BUFFER_CHARS}）を超えて捨てたときに呼ぶ。
 *   **黙って捨てない** —— 枠として成立しない本文が流れ続けていることは、
 *   停滞の検出では見つけられない（あちらの説明を見ること）。
 */
export function createSseParser(
  onEvent: (event: string, data: string) => void,
  onOverflow?: (droppedChars: number) => void,
): (chunk: string) => void {
  let buffer = ''
  return (chunk) => {
    buffer += chunk
    // **溜めを捨てるのは区切りを探す前。** 後ろへ置くと、上限を超えた溜めの中に
    // 区切りが 1 つも無い（＝この関数が何も進められない）状態でだけ捨てることになり、
    // 判定そのものが「進めなかった」ことに依存する。
    if (buffer.length > MAX_SSE_BUFFER_CHARS) {
      const dropped = buffer.length
      // **丸ごと捨てて仕切り直す。** 末尾を残すと壊れた枠の断片が次の区切りまで
      // 生き延びる —— どこから壊れているか分からないので、部分的に信じる根拠が無い。
      buffer = ''
      onOverflow?.(dropped)
      return
    }
    for (;;) {
      const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer)
      if (match === null) break
      const block = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      let event = 'message'
      const dataLines: string[] = []
      for (const line of block.split(/\r\n|\n|\r/)) {
        if (line === '' || line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        // **値の先頭の空白 1 つだけを落とす。** SSE の定め（`data:  x` の値は ` x`）。
        const rawValue = colon === -1 ? '' : line.slice(colon + 1)
        const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue
        if (field === 'event') event = value
        else if (field === 'data') dataLines.push(value)
        // `id`・`retry` とそれ以外は捨てる。
      }
      if (dataLines.length > 0) onEvent(event, dataLines.join('\n'))
    }
  }
}

/** 次の待ち時間。**倍々にして上限で止める。** */
function nextBackoff(previousMs: number): number {
  return Math.min(previousMs * 2, RECONNECT_MAX_MS)
}

/**
 * 受け手のコールバックを呼ぶ。**投げても飲み込む。**
 *
 * **飲み込まないと、受け手の不具合 1 つが 2 つの形で化ける。** どちらも
 * 「コールバックが投げた」より重い。
 *
 *   - **繋ぎ直しの輪が永久に止まる。** `loop` の中で投げれば `while` を抜け、
 *     以後この接続は二度と繋ぎ直さない（`close()` を呼んでも戻らない）。画面には
 *     最後に届いた震度が残り続け、**「揺れていない」と区別が付かなくなる** ——
 *     まさにそれを防ぐために置いた停滞の検出（{@link STALL_MS}）も、もう回って
 *     いないので効かない
 *   - **切れた理由が嘘になる。** `runOnce` の中で投げると外側の `catch` が拾い、
 *     受け手の不具合が「回線が切れた」として `reconnecting` の理由へ出る。しかも
 *     繋がった時点で待ちは最小へ戻っているので、**1 秒ごとに繋ぎ直して同じ例外を
 *     繰り返す** —— 購読の枠は 8 本しかないので、そこを専有しうる
 *
 * **記録は回線の理由と別の枠で残す。** 混ぜると上の 2 つ目をログの側で再現する
 * ことになる。
 */
function callSafely(what: string, run: () => void): void {
  try {
    run()
  } catch (error) {
    log.error(`[seismo] 受け手の ${what} が投げた`, error)
  }
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 失敗の理由を 1 行へ削る。**そのまま画面へ出す値なので、長さを切る。** */
function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const tame = raw.replace(/[\u0000-\u001F\u007F]/g, ' ')
  return tame.length > 120 ? `${tame.slice(0, 120)}…` : tame
}

/**
 * 1 回だけ繋いで、切れるまで読む。
 *
 * @returns 繋ぎ直す理由（正常に終わったなら `null`）
 */
async function runOnce(
  options: SeismoStreamOptions,
  signal: AbortSignal,
  onOpen: () => void,
  noteUnreadable: (detail: string) => void,
): Promise<string | null> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const url = `${apiBase(options.baseUrl)}/stream${options.wave === 'station' ? '?wave=station' : ''}`

  // **停滞したらこちらから切る。** `reader.read()` は黙って切れた繋ぎでは
  // 終わりも例外も返さない（{@link STALL_MS}）。
  const stall = new AbortController()
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  let stalled = false
  const armStall = (): void => {
    if (stallTimer !== null) clearTimeout(stallTimer)
    stallTimer = setTimeout(() => {
      stalled = true
      stall.abort()
    }, STALL_MS)
  }
  const disarmStall = (): void => {
    if (stallTimer !== null) clearTimeout(stallTimer)
    stallTimer = null
  }
  const onOuterAbort = (): void => stall.abort()
  signal.addEventListener('abort', onOuterAbort, { once: true })

  try {
    armStall()
    const res = await fetchImpl(url, {
      signal: stall.signal,
      headers: { Accept: 'text/event-stream' },
      // **控えを通さない。** 押し出しを控えから配られては意味が無い。
      cache: 'no-store',
    })
    if (!res.ok) {
      // **本文を読む。** これが `fetch` を選んだ理由そのもの —— 購読の上限
      // （503 ＋ `too-many-subscribers`）を「落ちている」と混ぜない。
      let detail = `HTTP ${res.status}`
      try {
        const body = (await res.text()).trim()
        if (body !== '') detail = `HTTP ${res.status}（${describeError(body)}）`
      } catch {
        // 本文が読めなくても状態コードは伝わる。
      }
      return detail
    }
    if (res.body === null) return '応答に本文が無い'

    onOpen()
    const parse = createSseParser(
      (event, data) => {
        const read = readMessage(event, data)
        // 知らない種別は黙って捨てる（{@link readMessage}）。
        if (read === null) return
        if ('detail' in read) {
          noteUnreadable(read.detail)
          return
        }
        options.onMessage(read.value)
      },
      (dropped) => noteUnreadable(`枠の区切りが来ないまま ${dropped} 文字を溜めたので捨てた`),
    )

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return '押し出しが終わった'
        // **届いたことを生存の印にする。** 中身が読めたかは問わない ——
        // ここで見ているのは繋ぎが生きているかで、形が合うかは別の問い。
        armStall()
        parse(decoder.decode(value, { stream: true }))
      }
    } finally {
      // **必ず手放す。** 掴んだままだと、閉じたはずの繋ぎが枠（8 本）を食い続ける。
      //
      // **待たない。** 解放を待つ理由が無いうえ、`cancel()` の約束が解決しない実装に
      // 当たると `finally` を抜けられず、繋ぎ直しの輪が**記録も状態も出さないまま**
      // 止まる（このファイルで最も静かな止まり方になる）。
      //
      // **失敗は記録する。** できることは無いが、上のコメントが言う枠の枯渇
      // （繋ぎ直しがずっと `too-many-subscribers` で断られる）を後から追う手掛かりが
      // ここにしか無い。
      void reader.cancel().catch((error: unknown) => {
        log.warn(`[seismo] 読み取りを手放せず: ${describeError(error)}`)
      })
    }
  } catch (error) {
    if (stalled) return `${STALL_MS / 1000} 秒のあいだ何も届かなかった`
    // 外から閉じられた。**繋ぎ直す理由ではない。**
    if (signal.aborted) return null
    return describeError(error)
  } finally {
    disarmStall()
    signal.removeEventListener('abort', onOuterAbort)
  }
}

/**
 * 押し出しの口へ繋ぎ、切れたら繋ぎ直す。
 *
 * **諦めない。** 待ちを倍々にして上限（30 秒）で頭打ちにするだけで、繋ぎ直しを
 * やめる条件は持たない —— やめる形にすると、ホストを再起動しただけで
 * 「設定を入れ直すまで二度と繋がらない」状態になる。止めるのは `signal` を
 * 落としたときだけ。
 *
 * **繋いだあとは待ちを戻す。** 戻さないと、1 日に 1 回切れる程度の繋ぎでも
 * 待ちが上限へ張り付いたままになる。
 */
export function connectSeismoStream(options: SeismoStreamOptions): SeismoStreamHandle {
  // **落ちている `signal` を渡されたら 1 件も投げない。** `AbortSignal` は既に
  // 発火した `abort` を後から登録した相手へ配らないので、下の `addEventListener`
  // では気づけない —— 呼び出し側が「もう要らない」と渡したつもりの接続が始まり、
  // `close()` を明示的に呼ぶまで購読の枠（8 本）を食い続ける。
  if (options.signal.aborted) return { close: () => {} }

  const inner = new AbortController()
  const onOuterAbort = (): void => inner.abort()
  options.signal.addEventListener('abort', onOuterAbort, { once: true })

  const sleep = options.sleep ?? defaultSleep
  // **間引きの枠を用途ごとに分ける。** 1 つを共有すると、先に鳴った側が別種の障害の
  // 「初めて起きた 1 行」を 5 分隠す —— ホストの版が古くて押し出しが毎秒弾かれて
  // いる間に回線が切れても、その切断だけが記録に残らない（`akamaiClock.ts` が
  // 「理由ごとに独立したスロットルを持つ」と決めているのと同じ理由）。
  //
  // **切れた理由ごとには分けない。** あちらの理由は自由文（`describeError` の結果）で
  // 鍵にできず、鍵にすると外から来た文面でいくらでも枠を増やせることになる。
  const throttledUnreadableLog = createLogThrottle(FAILURE_LOG_INTERVAL_MS)
  const throttledReconnectLog = createLogThrottle(FAILURE_LOG_INTERVAL_MS)
  let unreadableCount = 0

  // **受け手のコールバックは包んでから渡す**（{@link callSafely}）。`runOnce` へも
  // 包んだものを渡すので、押し出し 1 件ごとの `onMessage` もここで守られる。
  const safeOptions: SeismoStreamOptions = {
    ...options,
    onMessage: (message) => callSafely('onMessage', () => options.onMessage(message)),
    onState: (state) => callSafely('onState', () => options.onState(state)),
  }

  const noteUnreadable = (detail: string): void => {
    unreadableCount += 1
    const count = unreadableCount
    callSafely('onUnreadable', () => options.onUnreadable?.(count, detail))
    throttledUnreadableLog(() =>
      log.warn(`[seismo] 読めない押し出しが届いた（累計 ${count}）: ${detail}`),
    )
  }

  const loop = async (): Promise<void> => {
    let backoffMs = RECONNECT_MIN_MS
    while (!inner.signal.aborted) {
      safeOptions.onState({ kind: 'connecting' })
      const reason = await runOnce(
        safeOptions,
        inner.signal,
        () => {
          // **繋がった時点で待ちを戻す。**
          backoffMs = RECONNECT_MIN_MS
          safeOptions.onState({ kind: 'open' })
        },
        noteUnreadable,
      )
      if (inner.signal.aborted || reason === null) return
      safeOptions.onState({ kind: 'reconnecting', detail: reason, nextAttemptInMs: backoffMs })
      throttledReconnectLog(() =>
        log.warn(`[seismo] 押し出しが切れた（${backoffMs}ms 後に繋ぎ直す）: ${reason}`),
      )
      await sleep(backoffMs, inner.signal)
      backoffMs = nextBackoff(backoffMs)
    }
  }

  // **ここへ到達したら、この接続はもう繋ぎ直さない。** 受け手のコールバックは
  // 包んであるので、残る経路は `sleep` の差し替えが投げた場合くらい ——
  // それでも `log.error` を出すだけにする（`onState` へ終端を通知する形にすると、
  // その `onState` が投げたときに同じ穴がもう 1 段できる）。
  void loop().catch((error: unknown) => {
    log.error('[seismo] 押し出しの繋ぎ直しが止まった（以後この接続は繋ぎ直さない）', error)
  })

  return {
    close: () => {
      options.signal.removeEventListener('abort', onOuterAbort)
      inner.abort()
    },
  }
}

/**
 * `/status` を取り、観測点の素性とセンサーの本数を読む。
 *
 * **観測点の表示名はここにしか無い。** 押し出しの `station-reading` は
 * `stationId` だけを名乗るので、名前を出すにはこれが要る。出どころは
 * `sensors[].station` ——**`stationIntensities[]` は表示名を持たない**
 * （あちらは合成の生存を出す配列で、素性は持たない）。
 *
 * **同じ観測点が複数のセンサーから現れるので畳む。** 1 つの観測点に複数台を
 * 割り当てるのが前提の作り（`seismo-host/REQUIREMENTS.md` §7）なので、
 * `sensors` をそのまま並べると同じ観測点が台数ぶん出る。
 */
export async function fetchSeismoStatus(
  baseUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<SeismoHostCheck> {
  // **失敗の理由を記録へ 1 行残す。** 画面に出すのは「何を確かめればよいか」だけで
  // （`SettingsTab/seismoStatusLine.ts`）、`fetch` が返す文面は利用者の行動に
  // 繋がらないので載せない。**そのぶん記録が唯一の手掛かりになる** ——
  // ここが無いと、DNS か TLS か CORS か JSON の破損かを誰も切り分けられない。
  //
  // **間引かない。** 呼ばれるのは設定タブの確認（デバウンス後に 1 回）と台帳の
  // 取り直し（引けていれば 60 秒・**引けない間は 5 秒**に 1 回。
  // {@link STATIONS_RETRY_MIN_MS}）だけ。
  //
  // **5 秒に 1 回の側でも間引かない。** その頻度で出るのは台帳が引けない間だけで、
  // そのとき機能は止まっている（設定タブには「応答がありません」が出る）——
  // **止まっていることと、止まり続けていることを区別できる記録が要る。**
  // 間引くと「回復したのか、間引かれているのか」が読めなくなる。
  const fail = <T extends SeismoHostCheck>(result: T, why: string): T => {
    log.warn(`[seismo] /status を読めず（${result.kind}）: ${why}`)
    return result
  }

  // **ここも記録へ出す。** 通信の前に弾く唯一の経路なので `fail()` を飛ばしたく
  // なるが、飛ばすと**この経路だけ何も残らない** —— `SeismoHostDirectory` は
  // `baseUrl` を検めずに受け取るので、不正な値で作られたら「名前が引けないのに
  // 理由がどこにも無い」状態になる（あちらのコメントが「理由はここが出す」と
  // 書いている前提が、その 1 経路で崩れる）。
  if (!isValidSeismoHostUrl(baseUrl)) {
    return fail({ kind: 'unreadable' as const, detail: 'URL の形が正しくない' }, 'URL の形が正しくない')
  }
  let res: Response
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), STATUS_TIMEOUT_MS)
    try {
      res = await fetchImpl(`${apiBase(baseUrl)}/status`, { signal: ctrl.signal, cache: 'no-store' })
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    const detail = describeError(error)
    return fail({ kind: 'unreachable' as const, detail }, detail)
  }
  if (!res.ok) return fail({ kind: 'http-error' as const, status: res.status }, `HTTP ${res.status}`)

  let parsed: unknown
  try {
    parsed = await res.json()
  } catch (error) {
    const detail = describeError(error)
    return fail({ kind: 'unreadable' as const, detail }, detail)
  }
  const root = obj(parsed)
  // **`sensors` が配列でないものは「読めない」。** 別のものが応えている印なので、
  // 観測点 0 件として扱わない —— 「機材がまだ 1 本も繋がっていない」と
  // 「相手が seismo-host ではない」を混ぜることになる。
  if (!Array.isArray(root.sensors)) {
    return fail({ kind: 'unreadable' as const, detail: 'sensors が無い' }, 'sensors が無い')
  }

  const stations = new Map<string, SeismoStationInfo>()
  const sensors: SeismoSensorInfo[] = []
  for (const raw of arr(root.sensors)) {
    const sensor = obj(raw)
    const station = obj(sensor.station)
    const stationId = str(station.stationId)

    // **割り当ては観測点が無くても並べる。** `stationId` が空なのは「設定に無い基板」
    // （ホスト側は `station: null` で出す）で、そのセンサーが存在しないことではない。
    // ここで捨てると、`reading` が届いたのに帳面に無い基板が「まだ `/status` を
    // 読めていない」ものと区別が付かず、**取り直しを毎分繰り返す**ことになる。
    const boardKey = str(sensor.boardKey)
    const sensorId = str(sensor.sensorId)
    if (boardKey !== '' && sensorId !== '') {
      sensors.push({ boardKey, sensorId, stationId: stationId === '' ? null : stationId })
    }

    if (stationId === '') continue
    if (stations.has(stationId)) continue
    const displayName = str(station.displayName)
    stations.set(stationId, {
      stationId,
      // **名前が無ければ識別子で出す。** 空文字を通すと画面が名無しになる。
      displayName: displayName === '' ? stationId : displayName,
      lat: readFinite(station.lat),
      lon: readFinite(station.lon),
    })
  }

  return { kind: 'ok', stations: [...stations.values()], sensorCount: root.sensors.length, sensors }
}

/**
 * 観測点の素性とセンサーの割り当てを引くための台帳。
 *
 * **押し出しが名乗るのは識別子だけ。** 観測点の名前も、センサーがどの観測点に
 * 属するかも `/status` にしかないので、押し出しと並べてこれを引く。
 *
 * **繋がったときに 1 回＋知らない識別子が来たら取り直す。** `/status` を定期的に
 * 叩く形にしない —— 観測点やセンサーが増えるのは人が設定を書き換えたときだけで、
 * 押し出しが届いている間ずっと問い合わせる理由が無い。
 *
 * **取り直しに下限を置く。** 震度は毎秒届くので、引けなかった識別子があると
 * 毎秒叩く形になる（{@link STATIONS_REFETCH_MIN_MS}）。
 */
export class SeismoHostDirectory {
  private names = new Map<string, SeismoStationInfo>()
  /**
   * 基板がどの観測点に属するか。**値が `null` なら「設定に無い基板」。**
   *
   * **`null` でも取り直しの対象から外さない**（{@link requireBoard}）。
   * 「取り直す理由が無い」と書いて外した形を一度作り、敵対的レビューが覆した ——
   * **ホスト側の割り当ては後から変わる**（管理コンソールの
   * `PUT /api/boards/:boardKey` は upsert）。外すと、利用者が割り当てを直しても
   * そのブラウザが生きている間は震度が出ず、記録にも何も残らない。
   */
  private boards = new Map<string, string | null>()
  private lastFetchAtMs = -Infinity
  /** 直前の取り直しが成功したか。**次までの間隔を決める。** */
  private lastFetchOk = false
  private inFlight = false

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    /**
     * 経過時間を測る時計。**既定は単調時計。**
     *
     * 壁時計（`Date.now`）を使うと、時刻の補正で後ろへ跳んだとき差が負になり、
     * 跳んだ分だけ取り直しが止まる（`useSeismoStation.ts` が古さの判定で
     * 同じ理由から壁時計を避けているのと揃えた）。
     */
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** 引けた名前。**引けていなければ識別子をそのまま返す。** */
  displayName(stationId: string): string {
    return this.names.get(stationId)?.displayName ?? stationId
  }

  get stations(): readonly SeismoStationInfo[] {
    return [...this.names.values()]
  }

  /**
   * この基板が属する観測点。**引けていない・割り当てが無いなら `null`。**
   *
   * 2 つを同じ `null` で返すのは、呼び手にできることが同じだから（その震度を
   * どの観測点にも寄せられない）。取り直しの要否は {@link requireBoard} が見る。
   */
  stationIdForBoard(boardKey: string): string | null {
    return this.boards.get(boardKey) ?? null
  }

  /**
   * この観測点の名前が要る。**知らなければ取りに行く。**
   *
   * 待たない（戻りは `void`）—— 名前が付くのは次の描画からでよく、
   * 震度の反映を問い合わせに待たせる理由が無い。
   */
  require(stationId: string): void {
    if (this.names.has(stationId)) return
    this.refreshSoon()
  }

  /**
   * この基板の割り当てが要る。**引けていない・割り当てが無いなら取りに行く。**
   *
   * **`has()` で見ないこと。** 値が `null`（設定に無い基板）でも `has()` は真を
   * 返すので、そこで打ち切ると**その基板は二度と取り直しの契機を得ない** ——
   * ホスト側で割り当てを直しても、このブラウザが生きている間は震度が出ない
   * （管理コンソールの `PUT /api/boards/:boardKey` は upsert なので、割り当ては
   * 実際に後から変わる）。**叩く頻度は `refresh` の下限が担う**ので、ここを
   * 緩めても毎秒叩くことにはならない。
   */
  requireBoard(boardKey: string): void {
    if (this.boards.get(boardKey) != null) return
    this.refreshSoon()
  }

  private refreshSoon(): void {
    // **`catch` を置く。** `refresh` は投げない作りだが、ここは待たない呼び出しなので
    // 将来その前提が崩れたときに `unhandledRejection` として外へ漏れる
    // （他の 2 箇所の待たない呼び出しはどちらも受けを持っている）。
    void this.refresh().catch((error: unknown) => {
      log.warn('[seismo] 観測点の台帳の取り直しが投げた', error)
    })
  }

  /**
   * 取り直す。**間隔の下限と、重なりを見る。**
   *
   * **下限は直前の結果で変わる** —— 引けていれば 1 分（設定が変わるのを待つだけ）、
   * 引けていなければ 5 秒（機能が止まっているので待たせる理由が無い）。
   *
   * **見送ったことは記録へ出さない。** 見送りは正常な間引きで、しかも
   * **症状が出ている状況では記録から区別できる** —— `fetchSeismoStatus` は失敗を
   * 全経路で 1 行残すので、「名前が識別子のまま」なのに記録が無ければ叩いていない
   * （＝次の下限で叩く）と読める。行数を増やしても分かることが増えない。
   */
  async refresh(): Promise<void> {
    if (this.inFlight) return
    const now = this.now()
    const floor = this.lastFetchOk ? STATIONS_REFETCH_MIN_MS : STATIONS_RETRY_MIN_MS
    if (now - this.lastFetchAtMs < floor) return
    this.inFlight = true
    this.lastFetchAtMs = now
    try {
      const result = await fetchSeismoStatus(this.baseUrl, this.fetchImpl)
      this.lastFetchOk = result.kind === 'ok'
      // **失敗しても前の台帳を消さない。** 名前が引けないだけなら識別子で出せるが、
      // 引けていた名前を落とすと画面の表示が後退する。
      //
      // **理由は `fetchSeismoStatus` が記録へ出す**（URL の形が違う場合も含めて
      // 全経路で 1 行残す）。ここで重ねて出さないのは、症状（観測点名が識別子の
      // まま）に対して行数を増やしても分かることが増えないため。
      if (result.kind !== 'ok') return
      // **丸ごと置き換える。** 設定から外した観測点・基板を残さない。
      const nextNames = new Map<string, SeismoStationInfo>()
      for (const s of result.stations) nextNames.set(s.stationId, s)
      const nextBoards = new Map<string, string | null>()
      for (const s of result.sensors) {
        // **同じ基板の 2 個目以降は、割り当てが引けた側を採る。** ホストは観測点を
        // 基板ごとに解くので（`stations.resolve(boardKey)`）同じ値が並ぶはずだが、
        // 先に `null` を書いてしまうと**この基板は割り当て済みなのに `null`**
        // という台帳ができる。
        if (nextBoards.get(s.boardKey) == null) nextBoards.set(s.boardKey, s.stationId)
      }
      this.names = nextNames
      this.boards = nextBoards
    } finally {
      this.inFlight = false
    }
  }
}
