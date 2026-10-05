/**
 * 公開する内容に個人情報が入っていないかを探す部品（CLAUDE.md「公開する前に個人情報が無いことを確かめる」）。
 *
 * 呼び出し口は `scripts/check-personal-info.ts`。ここは判定だけを持ち、git も fs も触らない（テストで
 * 偽の値を流して確かめるため）。
 *
 * ## 2 種類の照合
 *
 * 1. **手元の照合ファイルの値**（`LocalRules`）—— 実名・自宅の座標・機器名など、**具体的な値**。
 *    一覧はリポジトリに入れない（入れればその一覧ごと公開される）。**許可リストは効かない** ——
 *    どのファイルでも、付帯情報でも、見つかれば止める
 * 2. **一般的な形** —— メールアドレス・電話番号・住所・緯度経度・IP・MAC・端末の中のパス・鍵の形など。
 *    値を知らなくても、形で引っかける。公開データ（地図の境界・観測点の座標）にも同じ形が大量にあるので、
 *    **許可リスト**（`Allowlist`）で「出どころが公的なデータの置き場所」と「公的・架空の値、本人が公開している
 *    第三者の連絡先」だけを外す
 *
 * **機械では見分けられないもの**（個人情報から計算した値 —— 自宅からの距離・S−P 時間など）は
 * ここでは拾えない。手順の側で目視の確認として残す。
 */

export type FindingKind =
  | 'local-text'
  | 'local-mac'
  | 'local-near'
  | 'email'
  | 'phone'
  | 'postal-code'
  | 'address'
  | 'coordinate'
  | 'dms'
  | 'map-url'
  | 'geohash'
  | 'ipv4'
  | 'ipv6'
  | 'mac'
  | 'hostname'
  | 'ssid'
  | 'user-path'
  | 'secret'
  | 'env-file'
  | 'binary'
  | 'media-metadata'
  | 'identity'

export interface Finding {
  readonly kind: FindingKind
  /** どこで見つけたか（ファイルの道筋・`commit <sha> のメッセージ` など）。 */
  readonly where: string
  /** 1 始まりの行。行の無いもの（バイナリ・作者欄）は null。 */
  readonly line: number | null
  /** 見つけた文字列（前後を少し含む）。 */
  readonly excerpt: string
}

/** 手元の照合ファイルの中身。 */
export interface LocalRules {
  /** 小文字にした文字列。 */
  readonly texts: readonly string[]
  /** 区切りを除いて小文字にした 12 桁の 16 進。 */
  readonly macs: readonly string[]
  readonly near: readonly { readonly lat: number; readonly lon: number; readonly km: number }[]
}

/** 一般的な形の検査から外すもの。**ここには個人情報を書かない**（このファイル自体が公開される）。 */
export interface Allowlist {
  /**
   * 出どころが公的なデータの置き場所（前方一致）。公開データに大量に出る一般的な形の検査
   * （メール・電話・住所・座標・IP・MAC・機器名・SSID など）と `near` を外す。
   * 鍵・端末の中のパス・地図の URL（`inPublicData`）と照合ファイルの値は外さない。
   */
  readonly publicDataPaths: readonly string[]
  /** 形の検査で当たっても出してよい値（完全一致）。見本のアドレス・公的な震央など。理由は呼び出し側の JSON に書く。 */
  readonly values: readonly string[]
  /** 作者・コミッターとして出してよいメールアドレス（正規表現）。 */
  readonly identityEmails: readonly string[]
  /** 中身を読まずに出してよいバイナリの拡張子（小文字・ドットなし）。 */
  readonly binaryExtensions: readonly string[]
}

export class LocalRulesError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalRulesError'
  }
}

/** 照合ファイルを読む。**書式が崩れていれば投げる** —— 黙って読み飛ばすと、その値が照合から抜ける。 */
export function parseLocalRules(text: string): LocalRules {
  const texts: string[] = []
  const macs: string[] = []
  const near: { lat: number; lon: number; km: number }[] = []
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) return
    const [kind, ...rest] = line.split(/\s+/)
    const value = rest.join(' ')
    if (kind === 'text' && value !== '') {
      texts.push(value.toLowerCase())
    } else if (kind === 'mac' && /^[0-9a-f]{12}$/i.test(value.replace(/[:-]/g, ''))) {
      macs.push(value.replace(/[:-]/g, '').toLowerCase())
    } else if (kind === 'near' && rest.length === 3 && rest.every((v) => Number.isFinite(Number(v)))) {
      near.push({ lat: Number(rest[0]), lon: Number(rest[1]), km: Number(rest[2]) })
    } else {
      throw new LocalRulesError(`照合ファイルの ${i + 1} 行目が読めない: ${JSON.stringify(raw)}`)
    }
  })
  if (texts.length + macs.length + near.length === 0) {
    throw new LocalRulesError('照合ファイルに項目が 1 つも無い（空のまま通すと、何も照合しないのに通ったことになる）')
  }
  return { texts, macs, near }
}

function excerptOf(line: string, index: number, length: number): string {
  const from = Math.max(0, index - 30)
  const to = Math.min(line.length, index + length + 30)
  return `${from > 0 ? '…' : ''}${line.slice(from, to)}${to < line.length ? '…' : ''}`
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad
  const dLon = (lon2 - lon1) * rad
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** 日本とその周辺に入る緯度経度か。 */
function inJapan(lat: number, lon: number): boolean {
  return lat >= 20 && lat <= 46 && lon >= 122 && lon <= 154
}

function decimals(s: string): number {
  const dot = s.indexOf('.')
  return dot < 0 ? 0 : s.length - dot - 1
}

interface Pattern {
  readonly kind: FindingKind
  readonly re: RegExp
  /** 当たった文字列を出してよいものとして外すか（`line`・`index` は当たった行と位置）。 */
  readonly ok?: (match: string, groups: readonly (string | undefined)[], line: string, index: number) => boolean
  /** 公開データの置き場所でも検査するか（既定は外す）。 */
  readonly inPublicData?: boolean
}

const PLACEHOLDER = /^(<[^>]*>|\$\{?[A-Z_]+\}?|%[A-Z_]+%|your[-_ ]?\w*|x{3,}|\.{3}|\*+|example\w*|dummy\w*|placeholder\w*)$/i

function isIgnoredIpv4(ip: string): boolean {
  return (
    // 0.0.0.0/8（「このネットワーク」。宛先として実在しない）。
    ip.startsWith('0.') ||
    ip === '127.0.0.1' ||
    ip === '255.255.255.255' ||
    // 仕様書用の見本アドレス（RFC 5737）。
    ip.startsWith('192.0.2.') ||
    ip.startsWith('198.51.100.') ||
    ip.startsWith('203.0.113.')
  )
}

/**
 * 機器を指さない MAC か。機器に焼かれている番号は「全体で一意・単一宛て」（先頭のバイトの下 2 ビットが
 * どちらも 0）なので、それ以外 —— 手元で割り振る印（`02:00:00:…` など）・マルチキャスト（`11:…`・
 * `ff:…`）—— と、同じバイトを 6 つ並べた見本（`cc:cc:cc:cc:cc:cc`）を外す。
 */
function isFakeMac(hex: string): boolean {
  const first = Number.parseInt(hex.slice(0, 2), 16)
  if ((first & 0b11) !== 0) return true
  return /^([0-9a-f]{2})\1{5}$/.test(hex)
}

const PATTERNS: readonly Pattern[] = [
  {
    kind: 'email',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
  },
  {
    kind: 'phone',
    re: /(?<![\w.+-])(?:\+81[-\s]?\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}|0\d{1,4}-\d{1,4}-\d{3,4}|0[5789]0\d{8})(?![\w-])/g,
  },
  { kind: 'postal-code', re: /〒\s?\d{3}-?\d{4}|郵便番号\s*[:：]?\s*\d{3}-?\d{4}/g },
  {
    kind: 'address',
    // 番地の「数字-数字-数字」は 1〜4 桁ずつ。年月日（`2026-07-28`）は外す。
    re: /(?:北海道|東京都|京都府|大阪府|[^\s、。,]{2,3}県)[^\s、。,]{1,12}?[市区町村郡][^\s、。,]{0,20}?(?:\d+丁目|\d+番地?|(?<!\d)(?!\d{4}-\d{1,2}-\d{1,2}(?!\d))[0-9０-９]{1,4}[-－‐][0-9０-９]{1,4}[-－‐][0-9０-９]{1,4}(?![0-9０-９]))/g,
  },
  { kind: 'dms', re: /\d{1,3}\s?°\s?\d{1,2}\s?['′’]/g },
  {
    kind: 'map-url',
    re: /(?:google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps|openstreetmap\.org\/[^\s)]*#map=|maps\.apple\.com|map\.yahoo\.co\.jp|mapion\.co\.jp)/gi,
    inPublicData: true,
  },
  { kind: 'geohash', re: /geohash["']?\s*[:=]\s*["']?[0-9b-hjkmnp-z]{5,12}/gi },
  {
    kind: 'ipv4',
    // `Chrome/150.0.0.0` のような版番号（直前が「英字と `/`」か英字）は外す。`http://` の直後は外さない。
    re: /(?<![\d.A-Za-z])(?<![A-Za-z]\/)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g,
    ok: (m) => isIgnoredIpv4(m),
  },
  {
    kind: 'ipv6',
    re: /(?<![\w:.])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?)(?![\w:.])/gi,
    ok: (m) => m === '::1',
  },
  {
    kind: 'mac',
    re: /(?<![0-9a-f:-])[0-9a-f]{2}([:-])(?:[0-9a-f]{2}\1){4}[0-9a-f]{2}(?![0-9a-f:-])|mac:[0-9a-f]{12}(?![0-9a-f])/gi,
    ok: (m) => isFakeMac(m.replace(/^mac:/i, '').replace(/[:-]/g, '').toLowerCase()),
  },
  {
    kind: 'hostname',
    // ファイル名（`.env.local`・`settings.local.json`）は外す: 直前が `.` か語の一部、直後に拡張子が続くもの。
    // 書式の穴（`%s.local`）も外す。
    re: /(?<![\w.%])[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:local|lan|home\.arpa|localdomain|ts\.net)(?![\w-]|\.[a-z])/gi,
    ok: (m) => /(^|\.)example\./i.test(m),
  },
  {
    // `ssid = WIFI_SSID` のように引用符の無い値は名前（コードの参照）として外す。
    // 引用符で囲んだ値と `#define …SSID "…"` は文字列そのものなので、名前の形でも外さない。
    kind: 'ssid',
    re: /\bssid\b["']?\s*[:=]\s*(?:["']([^"']*)["']|([^"'`\s;,)]+))|#define\s+\w*SSID\w*\s+"([^"]*)"/gi,
    ok: (_m, g) => {
      const quoted = g[0] ?? g[2]
      if (quoted !== undefined) return quoted === '' || PLACEHOLDER.test(quoted)
      const bare = g[1] ?? ''
      return PLACEHOLDER.test(bare) || /^[A-Za-z_][A-Za-z0-9_.]*$/.test(bare)
    },
  },
  {
    kind: 'user-path',
    re: /[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s"'`<>]+)|(?<![\w.])\/Users\/([^/\s"'`<>]+)|(?<![\w.])\/home\/([^/\s"'`<>]+)/g,
    ok: (_m, g) => {
      const name = g[0] ?? g[1] ?? g[2] ?? ''
      return PLACEHOLDER.test(name) || /^(user|username|you|runner|public|shared|default|me|name)$/i.test(name)
    },
    inPublicData: true,
  },
  {
    kind: 'secret',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    inPublicData: true,
  },
  {
    // 長い 16 進（管理用トークン・鍵）。**値のすぐ手前**（40 文字以内）がハッシュ値だと名乗っていれば外す。
    // 行のどこかに語があるだけで外すと、同じ行の無関係なコメントで本物の鍵が素通りする。
    kind: 'secret',
    re: /(?<![0-9a-f])[0-9a-f]{48,}(?![0-9a-f])/gi,
    ok: (_m, _g, line, index) =>
      /(?:sha\d*|hash|digest|integrity|checksum|commit|blob)/i.test(line.slice(Math.max(0, index - 40), index)),
    inPublicData: true,
  },
  {
    // `TOKEN = '…'`・`API_KEY=…` のような代入。値が見本（dummy・example・test など）なら外す。
    // **引用符の無い値**がコードの式（`listJson.nextToken`・`++seqRef.current`）や名前なら外す。
    // 引用符で囲んだ値は文字列そのものなので、英字だけでも名前とは見なさない（弱いパスワードを通さない）。
    kind: 'secret',
    re: /\b(?:\w*token|\w*secret|password|passwd|\w*api[_-]?key|apikey)\b["']?\s*[:=]\s*(["'`]?)([A-Za-z0-9_\-+/=.]{16,})/gi,
    ok: (_m, g) => {
      const quoted = (g[0] ?? '') !== ''
      const value = g[1] ?? ''
      if (PLACEHOLDER.test(value) || /dummy|fake|example|sample|placeholder|test|secret-token/i.test(value)) return true
      if (quoted) return false
      // 式（メンバーの参照を含む）か、数字を含まない名前。鍵はほぼ必ず数字を含むので、
      // 英数字だけの 1 語を名前として外すことはしない。
      return /^(\+\+|--)?[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(value) || /^[A-Za-z_$]+$/.test(value)
    },
    inPublicData: true,
  },
]

/**
 * 緯度経度の組（数字を 2 つ並べた形と、lat/lon の名前つきの形）。名前つきは `lat: 35.1`・`lat=35.1`
 * のほか、コマンドの引数（`--lat 35.1 --lon 135.2`）のように空白だけで区切った形も拾う。
 */
const COORD_PAIR = /(?<![\d.])(-?\d{1,3}\.\d+)\s*[,，/\s]\s*(-?\d{1,3}\.\d+)(?![\d.])/g
const COORD_NAMED = /\blat(?:itude)?\b["']?\s*[:=\s]\s*(-?\d{1,3}\.\d+)[^\n]{0,60}?\blo(?:n|ng|ngitude)\b["']?\s*[:=\s]\s*(-?\d{1,3}\.\d+)/gi

/**
 * 一般的な形として「位置」と見なす小数の桁数。2〜3 桁（1 km 前後）は震央・観測点の見本で
 * どこにでも出るので、4 桁（約 10 m）からにする。手元の地点の近さは桁数によらず `near` が見る。
 */
const PRECISE_DECIMALS = 4

/**
 * 数字の組を緯度経度の候補として拾う。**範囲で絞らない** —— 手元の地点（`near`）はどこにあっても
 * 照合する。`orders` は「緯度・経度」と見なせる並べ方（経度が先の書き方もあるので両方）、
 * `inJapan` は一般的な形の検査（日本とその周辺だけを位置と見なす）に使う。
 */
function coordinatePairs(line: string): {
  orders: [number, number][]
  inJapan: boolean
  text: string
  index: number
  precise: boolean
}[] {
  const out: { orders: [number, number][]; inJapan: boolean; text: string; index: number; precise: boolean }[] = []
  const valid = (lat: number, lon: number) => Math.abs(lat) <= 90 && Math.abs(lon) <= 180
  for (const re of [COORD_PAIR, COORD_NAMED]) {
    re.lastIndex = 0
    for (const m of line.matchAll(re)) {
      const a = Number(m[1])
      const b = Number(m[2])
      const orders = ([[a, b], [b, a]] as [number, number][]).filter(([lat, lon]) => valid(lat, lon))
      if (orders.length === 0) continue
      out.push({
        orders,
        inJapan: inJapan(a, b) || inJapan(b, a),
        text: m[0],
        index: m.index ?? 0,
        precise: decimals(m[1] as string) >= PRECISE_DECIMALS && decimals(m[2] as string) >= PRECISE_DECIMALS,
      })
    }
  }
  return out
}

function isPublicData(path: string, allow: Allowlist): boolean {
  return allow.publicDataPaths.some((p) => path.startsWith(p))
}

/** 手元の照合ファイルの値だけを探す（文字列の部分一致・MAC の区切り違い）。 */
export function scanLocal(where: string, text: string, local: LocalRules): Finding[] {
  const findings: Finding[] = []
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    const lower = line.toLowerCase()
    for (const t of local.texts) {
      const at = lower.indexOf(t)
      if (at >= 0) findings.push({ kind: 'local-text', where, line: i + 1, excerpt: excerptOf(line, at, t.length) })
    }
    if (local.macs.length > 0) {
      const flat = lower.replace(/[:-]/g, '')
      for (const mac of local.macs) {
        if (flat.includes(mac)) findings.push({ kind: 'local-mac', where, line: i + 1, excerpt: excerptOf(line, 0, 0) })
      }
    }
  })
  return findings
}

/**
 * 文字のファイル（または付帯情報）を調べる。`where` は道筋か `commit … のメッセージ` のような名前で、
 * 公開データの置き場所かどうかもこれで決まる。
 */
export function scanText(where: string, text: string, local: LocalRules, allow: Allowlist): Finding[] {
  const findings = scanLines(where, isPublicData(where, allow), text, local, allow)
  // `.env`・`.env.local` のほか、先頭に点の無い `app.env` の流儀も拾う。
  if (/(^|\/)\.env(\.[^/]+)?$|\.env$/.test(where)) {
    if (!/(^|\/)\.env\.example$/.test(where)) {
      findings.push({ kind: 'env-file', where, line: null, excerpt: '.env を公開しようとしている' })
    } else {
      text.split(/\r?\n/).forEach((line, i) => {
        if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*\S/.test(line)) {
          findings.push({ kind: 'env-file', where, line: i + 1, excerpt: '雛形に値が入っている' })
        }
      })
    }
  }
  return findings
}

/** ファイルの道筋そのもの（ディレクトリ名・ファイル名にも機器名や実名は入りうる）。 */
export function scanFileName(path: string, local: LocalRules, allow: Allowlist): Finding[] {
  return scanLines(`${path}（ファイル名）`, isPublicData(path, allow), path, local, allow)
}

function scanLines(where: string, publicData: boolean, text: string, local: LocalRules, allow: Allowlist): Finding[] {
  const findings = scanLocal(where, text, local)
  const allowed = new Set(allow.values)
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    for (const p of PATTERNS) {
      // 公開データでは位置・アドレスの形を見ない。鍵・端末のパス・地図の URL は見る（行がどれだけ長くても）。
      if (publicData && p.inPublicData !== true) continue
      p.re.lastIndex = 0
      for (const m of line.matchAll(p.re)) {
        const s = m[0]
        if (allowed.has(s)) continue
        if (p.ok?.(s, m.slice(1), line, m.index ?? 0) === true) continue
        if (p.kind === 'email' && allow.identityEmails.some((re) => new RegExp(re, 'i').test(s))) continue
        findings.push({ kind: p.kind, where, line: i + 1, excerpt: excerptOf(line, m.index ?? 0, s.length) })
      }
    }
    if (!publicData) {
      for (const c of coordinatePairs(line)) {
        for (const n of local.near) {
          if (c.orders.some(([lat, lon]) => haversineKm(lat, lon, n.lat, n.lon) <= n.km)) {
            findings.push({ kind: 'local-near', where, line: i + 1, excerpt: excerptOf(line, c.index, c.text.length) })
          }
        }
        if (c.inJapan && c.precise && !allowed.has(c.text.trim())) {
          findings.push({ kind: 'coordinate', where, line: i + 1, excerpt: excerptOf(line, c.index, c.text.length) })
        }
      }
    }
  })
  return findings
}

/** 中身が文字ではなさそうか（先頭 8000 バイトに NUL があるか）。git と同じ見分け方。 */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000)
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true
  return false
}

function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot < 0 ? '' : base.slice(dot + 1).toLowerCase()
}

function ascii(bytes: Uint8Array, from: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(from, from + length))
}

/** 画像・文書・音声に埋め込まれた付帯情報（撮影地点・機種・作者など）の印。 */
function mediaMetadata(path: string, bytes: Uint8Array): string | null {
  const ext = extOf(path)
  if (ext === 'png') {
    let at = 8
    const found: string[] = []
    let ended = false
    while (at + 8 <= bytes.length) {
      const length = ((bytes[at] ?? 0) << 24) | ((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0)
      const type = ascii(bytes, at + 4, 4)
      if (['eXIf', 'tEXt', 'iTXt', 'zTXt'].includes(type)) found.push(type)
      if (type === 'IEND') {
        ended = true
        break
      }
      if (length < 0) break
      at += 12 + length
    }
    if (found.length > 0) return `PNG の付帯情報（${[...new Set(found)].join('・')}）`
    // 終わりの印まで辿れなかった PNG は、その先に付帯情報があっても見えていない。「無し」と言わない。
    return ended ? null : 'PNG の構造を最後まで読めなかった（付帯情報の有無を確かめられない）'
  }
  const latin1 = Buffer.from(bytes).toString('latin1')
  if (ext === 'jpg' || ext === 'jpeg') {
    if (latin1.includes('Exif\u0000\u0000')) return 'JPEG の EXIF'
    if (latin1.includes('http://ns.adobe.com/xap')) return 'JPEG の XMP'
    return null
  }
  if (ext === 'webp' || ext === 'gif' || ext === 'tif' || ext === 'tiff' || ext === 'heic') {
    return /EXIF|XMP |http:\/\/ns\.adobe\.com\/xap|Exif\u0000/.test(latin1) ? `${ext} の付帯情報` : null
  }
  if (ext === 'pdf') return /\/Author|\/Creator|\/Producer/.test(latin1) ? 'PDF の作成者情報' : null
  if (ext === 'mp3') return latin1.startsWith('ID3') ? 'MP3 の ID3 タグ' : null
  if (ext === 'mp4' || ext === 'mov' || ext === 'm4a') return /udta|©xyz|©nam/.test(latin1) ? `${ext} の付帯情報` : null
  return null
}

/** 付帯情報を読み分ける種類（画像・文書・音声・動画）。 */
const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'tif', 'tiff', 'heic', 'pdf', 'mp3', 'mp4', 'mov', 'm4a'])

/**
 * `scanBinary` へ回すか。NUL の有無だけで決めると、先頭に NUL を持たない画像が文字として扱われ、
 * 付帯情報の検査を素通りする。画像・文書・音声の拡張子は中身によらずこちらへ回す。
 */
export function isBinaryFile(path: string, bytes: Uint8Array): boolean {
  return MEDIA_EXTENSIONS.has(extOf(path)) || looksBinary(bytes)
}

/**
 * 文字でないファイルを調べる。**読めない種類は、許可した拡張子でなければ止める** —— 中身を
 * 確かめられないものを「何も見つからなかった」として通さない。
 */
export function scanBinary(where: string, bytes: Uint8Array, local: LocalRules, allow: Allowlist): Finding[] {
  const findings = scanLocal(where, Buffer.from(bytes).toString('latin1'), local)
  const meta = mediaMetadata(where, bytes)
  if (meta !== null) findings.push({ kind: 'media-metadata', where, line: null, excerpt: meta })
  const ext = extOf(where)
  if (!MEDIA_EXTENSIONS.has(ext) && !allow.binaryExtensions.includes(ext)) {
    findings.push({ kind: 'binary', where, line: null, excerpt: `中身を確かめられない種類のファイル（.${ext || '拡張子なし'}）` })
  }
  return findings
}

/** 作者・コミッター・タグの作成者。メールは許可した形だけ、名前とメールは照合ファイルとも突き合わせる。 */
export function scanIdentity(where: string, name: string, email: string, local: LocalRules, allow: Allowlist): Finding[] {
  const findings = scanLocal(where, `${name} <${email}>`, local)
  if (!allow.identityEmails.some((re) => new RegExp(re, 'i').test(email))) {
    findings.push({ kind: 'identity', where, line: null, excerpt: `${name} <${email}>（許可していないメールアドレス）` })
  }
  return findings
}

// ── git の出力を読む ─────────────────────────────────────────────
// **読み違いは投げる。** ここが黙って 1 件でも落とすと、調べていないものを「見つからなかった」と言って
// push を通す。想定の形でなければ、その時点で止める（呼び出し口が終了コード 2 にする）。

export class GitOutputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitOutputError'
  }
}

/**
 * `git cat-file --batch` の出力を、オブジェクト名ごとの中身へ分ける。**頼んだものが 1 つでも
 * 返らなければ投げる**（`<名前> missing` —— 部分 clone で取ってきていない・壊れている —— を含む）。
 */
export function parseCatFileBatch(buf: Buffer, requested: readonly string[]): Map<string, { type: string; body: Buffer }> {
  const out = new Map<string, { type: string; body: Buffer }>()
  let at = 0
  while (at < buf.length) {
    const nl = buf.indexOf(0x0a, at)
    if (nl < 0) throw new GitOutputError('cat-file の見出し行が途中で切れている')
    const header = buf.subarray(at, nl).toString('utf8')
    const m = /^([0-9a-f]{40,64}) (blob|tree|commit|tag) (\d+)$/.exec(header)
    if (m === null) throw new GitOutputError(`cat-file が中身を返さなかった: ${header}`)
    const size = Number(m[3])
    const end = nl + 1 + size
    if (end + 1 > buf.length || buf[end] !== 0x0a) throw new GitOutputError(`cat-file の中身の長さが合わない: ${header}`)
    out.set(m[1] as string, { type: m[2] as string, body: buf.subarray(nl + 1, end) })
    at = end + 1
  }
  const missing = requested.filter((sha) => !out.has(sha))
  if (missing.length > 0) throw new GitOutputError(`cat-file が ${missing.length} 件を返さなかった（例: ${missing[0]}）`)
  return out
}

export interface GitPerson {
  readonly name: string
  readonly email: string
}

function parsePerson(line: string, field: string): GitPerson {
  const m = new RegExp(`^${field} (.*) <([^>]*)> -?\\d+ [+-]\\d{4}$`).exec(line)
  if (m === null) throw new GitOutputError(`${field} の行が読めない`)
  return { name: m[1] as string, email: m[2] as string }
}

/** 見出し（`key value`・続きの行は空白で始まる）と本文へ分ける。本文が無ければ空。 */
function splitObject(raw: string): { headers: string[]; message: string } {
  const blank = raw.indexOf('\n\n')
  const head = blank < 0 ? raw : raw.slice(0, blank)
  const message = blank < 0 ? '' : raw.slice(blank + 2)
  return { headers: head.split('\n').filter((l) => !l.startsWith(' ')), message }
}

/**
 * コミット・タグの生の中身を文字列へ戻す。**`encoding` 見出しがあればその文字コードで読む**
 * （`git log` はこれを自動で UTF-8 へ直すが、生の中身にはその手当てが無い。Shift_JIS の名前を
 * UTF-8 として読むと化けて照合をすり抜ける）。見出しが無ければ UTF-8 で、**読めないバイトがあれば投げる**
 * —— 置換文字へ化けた名前は何とも一致しない。
 */
export function decodeGitObject(body: Uint8Array): string {
  const bytes = Buffer.from(body)
  const blank = bytes.indexOf('\n\n')
  const head = bytes.subarray(0, blank < 0 ? bytes.length : blank).toString('latin1')
  const declared = /^encoding (\S+)$/m.exec(head)?.[1] ?? 'utf-8'
  let decoder: TextDecoder
  try {
    decoder = new TextDecoder(declared, { fatal: true })
  } catch {
    throw new GitOutputError(`読めない文字コードのオブジェクト（encoding ${declared}）`)
  }
  try {
    return decoder.decode(bytes)
  } catch {
    throw new GitOutputError(`${declared} として読めないバイトを含むオブジェクト`)
  }
}

/** コミットの生の中身（`cat-file commit` を `decodeGitObject` で戻したもの）から、作者・コミッター・メッセージを取る。 */
export function parseCommitObject(raw: string): { author: GitPerson; committer: GitPerson; message: string } {
  const { headers, message } = splitObject(raw)
  const author = headers.find((l) => l.startsWith('author '))
  const committer = headers.find((l) => l.startsWith('committer '))
  if (author === undefined || committer === undefined) throw new GitOutputError('コミットに author か committer の行が無い')
  return { author: parsePerson(author, 'author'), committer: parsePerson(committer, 'committer'), message }
}

/** 注釈つきタグの生の中身（`cat-file tag`）から、作成者とメッセージを取る。作成者の行は無いこともある。 */
export function parseTagObject(raw: string): { tagger: GitPerson | null; message: string } {
  const { headers, message } = splitObject(raw)
  const tagger = headers.find((l) => l.startsWith('tagger '))
  return { tagger: tagger === undefined ? null : parsePerson(tagger, 'tagger'), message }
}
