// DMDATA の購読区分を、利用者の契約と API キーの権限に合わせて決める。
//
// **一部の区分しか契約していない人・権限を絞った鍵の人でも、受けられる区分だけで繋がるようにする。**
// 配信元は、申し込んだ区分のどれか 1 つでも受けられないと**申し込みごと断る**（2026-10-14 実測）。
//   - 鍵に権限が無い区分を含む → 403 `Insufficient scope for eew.get.forecast.`（権限名を「, 」で並べる）
//   - 契約の無い区分を含む     → 402 `No contract. [telegram.volcano]`（区分名が角括弧に載る）
// 受けられる区分だけで繋がる、ということは起きない。そこで**断られた応えに載る区分を外して
// 申し込み直す**。契約一覧（`/v2/contract`）から決めないのは、その口に `contract.list` の権限が
// 要り、最小限の権限の鍵では読めないため（実測で 403）。
//
// 実測の詳細と、区分ごとの取得元の挙動は docs/spec/data-sources-spec.md §2「一部の区分だけ受けられる人」。
import { log } from '../utils/logger'

/** このアプリが申し込みうる区分。 */
export type DmdataClassification = 'eew.forecast' | 'eew.warning' | 'telegram.earthquake'

/**
 * 最初に申し込む区分。**予報（`eew.forecast`）があれば警報（`eew.warning`）は申し込まない** ——
 * 予報の VXSE45 が警報報も兼ねており、VXSE43 はその複製として遅れて届き区域塗りを削るため
 * （→ `dmdataTelegramPayload.ts` の `EEW_TYPES`）。
 */
export const PREFERRED_CLASSIFICATIONS: readonly DmdataClassification[] = ['eew.forecast', 'telegram.earthquake']

/** 予報を受けられないときに代わりに試す区分。 */
const FALLBACK_FOR: Partial<Record<DmdataClassification, DmdataClassification>> = {
  'eew.forecast': 'eew.warning',
}

/** 403 の応えに載る権限名と、それが要る区分。 */
const SCOPE_TO_CLASSIFICATION: Record<string, DmdataClassification> = {
  'eew.get.forecast': 'eew.forecast',
  'eew.get.warning': 'eew.warning',
  'telegram.get.earthquake': 'telegram.earthquake',
}

const ALL_CLASSIFICATIONS: readonly DmdataClassification[] = ['eew.forecast', 'eew.warning', 'telegram.earthquake']

export function isDmdataClassification(v: unknown): v is DmdataClassification {
  return typeof v === 'string' && (ALL_CLASSIFICATIONS as readonly string[]).includes(v)
}

/**
 * 断られた応えの読み方。
 *   - `drop`  … 応えに載った区分を外せば繋がりうる
 *   - `fatal` … 区分を外しても直らない（`socket.start` の権限が無い・区分と結び付かない権限が足りない）
 *   - `unknown` … 応えの文が読めない。**区分を外す根拠にしない**（呼び出し側は従来の扱いへ倒す）
 */
export type SocketRejection =
  | { kind: 'drop'; drop: DmdataClassification[] }
  | { kind: 'fatal'; reason: string }
  | { kind: 'unknown' }

/**
 * Socket Start が断った応えから、外す区分を読む。
 *
 * **申し込んでいない区分は外す対象にしない。** 応えに載った名前が申し込みに無ければ、
 * 文の形が変わったか別の理由で断られている —— 外しても同じ応えが返るだけなので `unknown` にする。
 *
 * @param status HTTP の状態コード
 * @param message 応えの `error.message`
 * @param requested 申し込んだ区分
 */
export function readSocketRejection(
  status: number,
  message: string | undefined,
  requested: readonly DmdataClassification[],
): SocketRejection {
  const text = message ?? ''
  if (status === 402) {
    const m = /No contract\.?\s*\[([^\]]*)\]/.exec(text)
    if (!m) return { kind: 'unknown' }
    const names = m[1].split(',').map((s) => s.trim()).filter((s) => s !== '')
    const drop = requested.filter((c) => names.includes(c))
    return drop.length > 0 ? { kind: 'drop', drop } : { kind: 'unknown' }
  }
  if (status === 403) {
    const m = /Insufficient scope for\s+(.+?)\.?\s*$/.exec(text)
    if (!m) return { kind: 'unknown' }
    const scopes = m[1].split(',').map((s) => s.trim()).filter((s) => s !== '')
    const drop: DmdataClassification[] = []
    for (const scope of scopes) {
      const c = SCOPE_TO_CLASSIFICATION[scope]
      // 区分と結び付かない権限（`socket.start` など）が足りないなら、区分を外しても繋がらない
      if (c === undefined || !requested.includes(c)) return { kind: 'fatal', reason: `権限が足りない: ${scope}` }
      if (!drop.includes(c)) drop.push(c)
    }
    return drop.length > 0 ? { kind: 'drop', drop } : { kind: 'unknown' }
  }
  return { kind: 'unknown' }
}

/**
 * 外す区分を除いた、次に申し込む区分。予報を外したら警報を代わりに足す（まだ外していなければ）。
 *
 * @param requested いま申し込んだ区分
 * @param excluded これまでに外した区分（今回外すものを含む）
 * @returns 申し込める区分が 1 つも残らなければ null
 */
export function nextClassifications(
  requested: readonly DmdataClassification[],
  excluded: ReadonlySet<DmdataClassification>,
): DmdataClassification[] | null {
  const next: DmdataClassification[] = []
  for (const c of requested) {
    if (!excluded.has(c)) {
      if (!next.includes(c)) next.push(c)
      continue
    }
    const alt = FALLBACK_FOR[c]
    if (alt !== undefined && !excluded.has(alt) && !next.includes(alt)) next.push(alt)
  }
  return next.length > 0 ? next : null
}

/**
 * 申し込みを繰り返してよい回数の上限。外すたびに区分が 1 つ以上減り、代わりに足すのは
 * 予報 → 警報の 1 度だけなので、区分の数＋1 回で必ず決着する。これを超えたら打ち切る。
 */
export const MAX_SOCKET_START_ATTEMPTS = ALL_CLASSIFICATIONS.length + 1

/** Socket Start を 1 回投げた結果（`negotiateClassifications` へ渡す口の戻り値）。 */
export interface SocketStartAttempt {
  status: number
  body: unknown
}

/** 区分の取り決めの結果。 */
export type NegotiationResult =
  | { kind: 'ok'; attempt: SocketStartAttempt; classifications: DmdataClassification[]; excluded: DmdataClassification[] }
  /** 受けられる区分が 1 つも無い、または区分を外しても直らない。再試行しても直らない */
  | { kind: 'fatal'; attempt: SocketStartAttempt; reason: string }
  /** 区分と関係の無い失敗（409・5xx・読めない 402 など）。扱いは呼び出し側が状態コードで決める */
  | { kind: 'other'; attempt: SocketStartAttempt }
  /** 途中で止められた（`isStopped` が真になった）。呼び出し側は結果を使わない */
  | { kind: 'stopped' }

/**
 * 断られた区分を外しながら Socket Start を投げ直し、受けられる区分で通るまで続ける。
 *
 * @param start 区分を受け取って 1 回投げる口
 * @param initial 最初に申し込む区分（前の接続で通った区分を渡すと、再接続のたびに投げ直さずに済む）
 * @param isStopped 止められたか。**申し込みの合間ごとに見る** —— 見ないと、接続を捨てた後も
 *   断られる申し込みを最大 `MAX_SOCKET_START_ATTEMPTS` 回まで投げ続ける
 */
export async function negotiateClassifications(
  start: (classifications: readonly DmdataClassification[]) => Promise<SocketStartAttempt>,
  initial: readonly DmdataClassification[],
  isStopped: () => boolean,
): Promise<NegotiationResult> {
  let request: DmdataClassification[] = [...initial]
  const excluded = new Set<DmdataClassification>()
  let attempt: SocketStartAttempt = { status: 0, body: null }
  for (let i = 0; i < MAX_SOCKET_START_ATTEMPTS; i++) {
    if (isStopped()) return { kind: 'stopped' }
    attempt = await start(request)
    if (attempt.status === 200) {
      return { kind: 'ok', attempt, classifications: acceptedClassifications(attempt.body, request), excluded: [...excluded] }
    }
    const message = (attempt.body as { error?: { message?: unknown } } | null)?.error?.message
    const rejection = readSocketRejection(attempt.status, typeof message === 'string' ? message : undefined, request)
    if (rejection.kind === 'fatal') return { kind: 'fatal', attempt, reason: rejection.reason }
    if (rejection.kind === 'unknown') return { kind: 'other', attempt }
    for (const c of rejection.drop) excluded.add(c)
    const next = nextClassifications(request, excluded)
    if (next === null) return { kind: 'fatal', attempt, reason: '受けられる区分が無い' }
    request = next
  }
  return { kind: 'fatal', attempt, reason: `区分の取り決めが ${MAX_SOCKET_START_ATTEMPTS} 回で決着しなかった` }
}

/**
 * 受けている区分のうち、緊急地震速報としてどの電文種別を取り込むか。
 * 予報があれば VXSE45 だけ、予報が無く警報があれば VXSE43 だけ、どちらも無ければ null。
 */
export function eewHeadTypeFor(classifications: readonly DmdataClassification[]): 'VXSE45' | 'VXSE43' | null {
  if (classifications.includes('eew.forecast')) return 'VXSE45'
  if (classifications.includes('eew.warning')) return 'VXSE43'
  return null
}

/** 地震・津波などの電文（`telegram.earthquake`）を受けているか。履歴を取りに行くかの判断に使う。 */
export function hasQuakeTelegrams(classifications: readonly DmdataClassification[]): boolean {
  return classifications.includes('telegram.earthquake')
}

/** DMDATA の購入区分名。設定タブの「受信している区分」に出す。 */
const CLASSIFICATION_LABELS: Record<DmdataClassification, string> = {
  'eew.forecast': '緊急地震（予報）',
  'eew.warning': '緊急地震（警報）',
  'telegram.earthquake': '地震・津波関連',
}

/** 区分を購入区分名で「・」に繋ぐ。並びは区分の定義順に固定する（申し込みの順に依らない）。 */
export function classificationLabel(classifications: readonly DmdataClassification[]): string {
  return ALL_CLASSIFICATIONS.filter((c) => classifications.includes(c)).map((c) => CLASSIFICATION_LABELS[c]).join('・')
}

/**
 * Socket Start の応えから、実際に受けている区分を読む。読めなければ申し込んだ区分を返す
 * （成功した以上、申し込んだものはすべて受けている）。
 */
export function acceptedClassifications(body: unknown, requested: readonly DmdataClassification[]): DmdataClassification[] {
  const raw = (body as { classifications?: unknown } | null)?.classifications
  if (Array.isArray(raw)) {
    const list = raw.filter(isDmdataClassification)
    if (list.length > 0) return list
  }
  // 応えの形が変わった疑い。申し込んだ区分は通ったはずなので使うが、黙らない
  log.warn('[DMDSS] Socket Start の応えから受け付けた区分を読めないため、申し込んだ区分を使います', { requested, raw })
  return [...requested]
}
