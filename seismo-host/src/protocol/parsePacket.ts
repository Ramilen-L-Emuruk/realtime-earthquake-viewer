// センサーノードが投げてくる UDP のパケットを読む。
//
// **例外を投げない。** 相手はネットワークで、壊れた入力は異常ではなく日常
// （途中で切れる・別のプログラムが同じポートへ投げる）。投げる形にすると
// 受信ループを守るために呼び出し側が毎回 try で囲むことになり、しかも
// **何件どんな理由で落ちたかを数えられなくなる。**
//
// **版 1 と版 2 の両方を読む。** 版 1 には版を表す欄そのものが無いので、
// 「`v` が無ければ 1」と決めている。蓄えた記録は実装より長生きするため、
// 古い形式を読めなくすることはできない。
import type { BoardKey, PacketParseFailure, PacketParseResult, SensorPacket } from './types'

/**
 * 版 1 が名乗る時刻のずれ。
 *
 * 版 1 のファームは FIFO を抜き出した時刻を `now` とし、そこから
 * 「最新のサンプルはたった今 採られた」と仮定して先頭サンプルの時刻を逆算していた。
 * 実際には最新サンプルは 0〜1 サンプル分だけ前に採られているので、**名乗る時刻は
 * 平均して半サンプル分だけ遅い**。
 *
 * **読み取りの時点で引く。** 版 2 のファームは自分で補正して送るので、ここで
 * 揃えておかないと、ファームを焼き替えた日を境に記録へ段差ができる。
 * **偏りより段差のほうが厄介** —— 偏りは全体が同じ向きにずれるだけだが、
 * 段差はその前後で比べたときにだけ嘘をつく。
 */
function legacyTimestampBiasMs(sampleRateHz: number): number {
  return 500 / sampleRateHz
}

/**
 * 10 進の符号付き整数だけを受ける。
 *
 * **`Number()` に任せない。** あれは `0x1A` を 26、`1e2` を 100 として受け、
 * 前後の空白も読み飛ばす。どれも送り手の契約には無い形で、**`Number.isInteger` を
 * 通ってしまう**ので、素通りすると壊れた表記が別の値として波形へ混ざる。
 */
const DECIMAL_INTEGER_RE = /^-?\d+$/

/** 版 1 のファームは Wire の 0x68 にある 1 個だけを扱っていた。 */
const LEGACY_SENSOR_ID = 'i2c0-68'

/**
 * 版 1 の x/y/z は、取り付けの向きを補正していない素のセンサー軸。
 * SEED の流儀では方位が確定していない軸を `1/2/3` と書くので、意味はそのまま対応する。
 */
const LEGACY_CHANNELS = ['HN1', 'HN2', 'HN3']

function fail(reason: PacketParseFailure, detail: string): PacketParseResult {
  return { ok: false, reason, detail }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * `Date` が表せる範囲（元期の前後 8.64e15 ミリ秒）。
 *
 * この外の値は有限でも `new Date(v).toISOString()` が投げる。時刻を名乗る欄はここで縛る。
 */
export const MAX_TIME_MS = 8.64e15

/** 有限の数値であることまで見る。`NaN` は比較がすべて偽になるので素通りする。 */
function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function nonNegativeInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null
}

/**
 * 識別子として使う欄を読む。**空白だけの値は拒み、前後の空白は落とす。**
 *
 * 落とすのは、同じ基板が `"seismo-3"` と `" seismo-3"` を名乗り分けたときに
 * 別の流れとして分かれてしまうため —— 前後の空白が意味を持つ識別子は無い。
 */
function nonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  return trimmed.length > 0 ? trimmed : null
}

function stringArray(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0) return null
  const out: string[] = []
  for (const e of v) {
    if (typeof e !== 'string' || e.length === 0) return null
    out.push(e)
  }
  return out
}

interface HeaderShape {
  boardKey: BoardKey
  bootId: string
  sensorId: string
  sensorType: string
  channels: string[]
  ugPerLsb: number
  fullScaleG: number
  sampleRateHz: number
  firstSampleMs: number
  firstSeq: number
  declaredCount: number
  overflowCount: number
  version: 1 | 2
}

/** 版によらず要る欄。読めたぶんだけ返し、足りなければ欄の名前を添えて落とす。 */
function readCommonFields(h: Record<string, unknown>):
  | { ok: true; ug: number; fs: number; hz: number; t: number; q: number; c: number; o: number }
  | { ok: false; field: string } {
  const ug = finiteNumber(h.ug)
  if (ug === null || ug <= 0) return { ok: false, field: 'ug' }
  const fs = finiteNumber(h.fs ?? h.r)
  if (fs === null || fs <= 0) return { ok: false, field: 'fs' }
  const hz = nonNegativeInt(h.hz)
  if (hz === null || hz <= 0) return { ok: false, field: 'hz' }
  const t = finiteNumber(h.t)
  // **有限なだけでは足りない。** `Date` が扱えるのは元期の前後 8.64e15 ミリ秒までで、
  // `Number.isFinite` は `1e20` を通すが `toISOString()` はその値で例外を投げる。
  //
  // **弾くのは原因を残すため。** 出す側（`../../main.ts` の `formatAt`）も範囲を見て
  // 投げない形にしてあるので、ここを通しても落ちはしない —— ただし下流に残るのは
  // 「時刻不正」という印だけで、**どの欄が壊れていたのかも、何件届いたのかも辿れない**。
  // ここで落とせば理由（`header-field-invalid` の `t`）が付いて 1 件として数えられる。
  //
  // **「いまに近いか」では弾かない。** 昔の記録を流し直す使い方があるので、
  // 縛るのは「時刻として表せること」だけにとどめる。
  if (t === null || Math.abs(t) > MAX_TIME_MS) return { ok: false, field: 't' }
  const q = nonNegativeInt(h.q)
  if (q === null) return { ok: false, field: 'q' }
  const c = nonNegativeInt(h.c)
  // **0 件のパケットは受けない。** いまの送り手は必ず 1 件以上を積んで送る。
  // 生存確認のような「中身の無い便り」を足すなら、それは別の種類として名乗らせること
  // —— ここで通すと、サンプルの無い便りが「読めたパケット」として数えられる。
  if (c === null || c === 0) return { ok: false, field: 'c' }
  const o = nonNegativeInt(h.o)
  if (o === null) return { ok: false, field: 'o' }
  return { ok: true, ug, fs, hz, t, q, c, o }
}

function readHeader(h: Record<string, unknown>):
  | { ok: true; head: HeaderShape }
  | { ok: false; reason: 'unsupported-version' | 'header-field-invalid'; detail: string } {
  // 版 1 は版を名乗らない。ここだけは「欄が無いこと」に意味がある。
  const rawVersion = h.v === undefined ? 1 : h.v
  if (rawVersion !== 1 && rawVersion !== 2) {
    return { ok: false, reason: 'unsupported-version', detail: `v=${JSON.stringify(h.v)}` }
  }
  const version: 1 | 2 = rawVersion

  const common = readCommonFields(h)
  if (!common.ok) {
    return { ok: false, reason: 'header-field-invalid', detail: common.field }
  }

  if (version === 1) {
    const name = nonEmptyString(h.n)
    if (name === null) return { ok: false, reason: 'header-field-invalid', detail: 'n' }
    const sensorType = nonEmptyString(h.s)
    if (sensorType === null) return { ok: false, reason: 'header-field-invalid', detail: 's' }
    return {
      ok: true,
      head: {
        // **版 1 は MAC を名乗らない。** 名前しか手掛かりが無いので前置きで出どころを残す。
        boardKey: `name:${name}`,
        bootId: '',
        sensorId: LEGACY_SENSOR_ID,
        sensorType,
        channels: LEGACY_CHANNELS,
        ugPerLsb: common.ug,
        fullScaleG: common.fs,
        sampleRateHz: common.hz,
        firstSampleMs: common.t - legacyTimestampBiasMs(common.hz),
        firstSeq: common.q,
        declaredCount: common.c,
        overflowCount: common.o,
        version,
      },
    }
  }

  const mac = nonEmptyString(h.mac)
  if (mac === null) return { ok: false, reason: 'header-field-invalid', detail: 'mac' }
  const bootId = nonEmptyString(h.bid)
  if (bootId === null) return { ok: false, reason: 'header-field-invalid', detail: 'bid' }
  const sensorId = nonEmptyString(h.sid)
  if (sensorId === null) return { ok: false, reason: 'header-field-invalid', detail: 'sid' }
  const sensorType = nonEmptyString(h.st)
  if (sensorType === null) return { ok: false, reason: 'header-field-invalid', detail: 'st' }
  const channels = stringArray(h.ch)
  if (channels === null) return { ok: false, reason: 'header-field-invalid', detail: 'ch' }

  return {
    ok: true,
    head: {
      boardKey: `mac:${mac}`,
      bootId,
      sensorId,
      sensorType,
      channels,
      ugPerLsb: common.ug,
      fullScaleG: common.fs,
      sampleRateHz: common.hz,
      // 版 2 のファームが送る前に補正しているので、ここでは触らない。
      firstSampleMs: common.t,
      firstSeq: common.q,
      declaredCount: common.c,
      overflowCount: common.o,
      version,
    },
  }
}

/**
 * パケット 1 つを読む。先頭行がヘッダの JSON、以降が 1 行 1 サンプル。
 *
 * **宣言された件数と実際の行数が合わなければ落とす。** 少ないぶんだけ採る形にすると、
 * 途中で切れたパケットが「その通し番号から先のサンプル」として通り、以後の
 * 連続性の判定がまるごとずれる。
 */
export function parseSensorPacket(payload: string): PacketParseResult {
  if (payload.length === 0) return fail('empty', 'payload length 0')

  const lines = payload.split('\n')
  // 末尾の改行が作る空要素だけを落とす。途中の空行は異常として扱う（下の列数の検査で落ちる）。
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  // **改行だけの中身は「読めない」ではなく「無い」。** ここで落とさないと
  // `JSON.parse('')` が投げて `header-unreadable` として数えられ、
  // 「別のプログラムが同じポートへ投げている」疑いの件数に空パケットが混ざる。
  if (lines.length === 0 || (lines.length === 1 && lines[0].length === 0)) {
    return fail('empty', 'no content')
  }

  let header: unknown
  try {
    header = JSON.parse(lines[0])
  } catch {
    return fail('header-unreadable', lines[0].slice(0, 80))
  }
  if (!isRecord(header)) return fail('header-unreadable', 'header is not an object')

  const read = readHeader(header)
  if (!read.ok) return fail(read.reason, read.detail)
  const head = read.head

  const sampleLines = lines.slice(1)
  if (sampleLines.length !== head.declaredCount) {
    return fail('sample-count-mismatch', `declared ${head.declaredCount}, got ${sampleLines.length}`)
  }

  const width = head.channels.length
  const samples: number[][] = new Array(sampleLines.length)
  for (let i = 0; i < sampleLines.length; i++) {
    // **空行を先に落とす。** `''.split(',')` は長さ 1 の配列を返すので、
    // 軸が 1 つのセンサーでは列数の検査を素通りし、同じ「空行」という事象が
    // 軸数によって別の理由へ振り分けられてしまう（理由は数えるために分けている）。
    if (sampleLines[i].length === 0) {
      return fail('sample-column-mismatch', `line ${i}: empty line`)
    }
    const cols = sampleLines[i].split(',')
    if (cols.length !== width) {
      return fail('sample-column-mismatch', `line ${i}: expected ${width}, got ${cols.length}`)
    }
    const row = new Array<number>(width)
    for (let j = 0; j < width; j++) {
      const raw = cols[j]
      // **`Number('')` は 0 を返す。** 空欄を 0 として通すと、静止している値として
      // 平然と解析へ流れる。書式を先に見るので、ここは正規表現が兼ねる。
      if (!DECIMAL_INTEGER_RE.test(raw)) {
        return fail('sample-not-integer', `line ${i} col ${j}: ${raw.slice(0, 16)}`)
      }
      const v = Number(raw)
      // 桁が多すぎて正確に表せない値も落とす。**丸めた値を生の観測値として扱わない。**
      if (!Number.isSafeInteger(v)) {
        return fail('sample-not-integer', `line ${i} col ${j}: ${raw.slice(0, 16)}`)
      }
      row[j] = v
    }
    samples[i] = row
  }

  const packet: SensorPacket = {
    version: head.version,
    boardKey: head.boardKey,
    bootId: head.bootId,
    sensorId: head.sensorId,
    sensorType: head.sensorType,
    channels: head.channels,
    ugPerLsb: head.ugPerLsb,
    fullScaleG: head.fullScaleG,
    sampleRateHz: head.sampleRateHz,
    firstSampleMs: head.firstSampleMs,
    firstSeq: head.firstSeq,
    overflowCount: head.overflowCount,
    samples,
  }
  // **`1` だけを「求めている」と読む。** 真偽値や文字列の `"1"` は今の送り手が出さない形で、
  // 寛容に受けると、何を送れば返事が来るのかが送り手の側から読めなくなる。
  // 読めない値でパケットごと落とさないのは、返事の有無が観測値の正しさと無関係なため ——
  // ここで落とすと、返事の取り決めを書き損じた基板の波形が丸ごと消える。
  // **版 1 は返事を求められない**（MAC を名乗らないので、宛名を書けない）。
  const ackRequested = head.version === 2 && header.ack === 1
  return { ok: true, packet, ackRequested }
}
