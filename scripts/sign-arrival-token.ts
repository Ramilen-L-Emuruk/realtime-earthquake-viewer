/**
 * 到達予想トークンの発行。
 *
 * 自前計算による「特定地点への主要動到達予想」は、鍵を渡した相手だけが使える形にしてある
 * （背景と法令上の整理は `docs/spec/eew-spec.md`）。このスクリプトは**秘密鍵で署名した
 * トークンを 1 本作るだけ**で、検証はアプリ側（`src/utils/arrivalToken.ts`）が公開鍵で行う。
 *
 * **共有の文字列ではなく署名にしている理由は 2 つ。**
 * - 公開鍵は配ってよいので、アプリのソースへそのまま埋められる（漏れても偽造できない）
 * - 渡した相手ごとに発行でき、期限を切れる。共有文字列は一度出回ったら作り直すしかない
 *
 * **トークンはテキスト**（`<payload>.<signature>` の 2 部・どちらも base64url）。設定欄へ
 * 貼る・設定の書き出し（JSON）に載る・チャットで渡す、のどれもテキストでないと成り立たない。
 *
 * **JWT にはしない。** 見た目は似ているが、JWT はヘッダで署名方式を名乗る仕様なので、
 * 検証側がヘッダを信じると方式のすり替え（`alg: none` 等）に開く。ここでは方式を
 * 実装側に固定し、電文に方式を書かせない。
 *
 * 使い方:
 *   npx tsx scripts/sign-arrival-token.ts --init          # 鍵を作る（初回だけ）
 *   npx tsx scripts/sign-arrival-token.ts --subject=自分  # トークンを 1 本発行する
 */
import { createSign, generateKeyPairSync } from 'node:crypto'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const ENV_PATH = resolve(REPO_ROOT, '.env.local')

/**
 * 秘密鍵の置き場所。**`ARRIVAL_` で始めない。** `vite.config.ts` は `loadEnv` に
 * プレフィクスを渡して環境変数を読むので、注入対象（`ARRIVAL_TOKEN`）と同じ頭文字にすると
 * 秘密鍵までバンドルへ載りうる。
 */
const PRIVATE_KEY_VAR = 'TOKEN_SIGNING_PRIVATE_KEY'
/** dev サーバーで自動投入する自分用トークン。 */
const TOKEN_VAR = 'ARRIVAL_TOKEN'

/** 既定の有効期間。無期限にしないのは、渡した相手の分を失効させる手段を残すため。 */
const DEFAULT_DAYS = 365

const b64url = (buf: Buffer) => buf.toString('base64url')

function readEnvVar(name: string): string | null {
  if (!existsSync(ENV_PATH)) return null
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`).exec(line)
    if (m) return m[1].trim()
  }
  return null
}

function init(): void {
  if (readEnvVar(PRIVATE_KEY_VAR)) {
    throw new Error(
      `${PRIVATE_KEY_VAR} が既に ${ENV_PATH} にあります。作り直すと発行済みのトークンが全部無効になるので、` +
        '意図しているなら手で消してから実行してください。',
    )
  }
  // ECDSA P-256。ブラウザの Web Crypto がどこでも持っている曲線で、鍵も署名も短い。
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer
  const pub = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  appendFileSync(ENV_PATH, `\n# 到達予想トークンの署名鍵（アプリは読まない・配らない）\n${PRIVATE_KEY_VAR}=${priv.toString('base64')}\n`, 'utf8')
  console.log(`秘密鍵を ${ENV_PATH} へ書きました（${PRIVATE_KEY_VAR}）。`)
  console.log('\n公開鍵（src/utils/arrivalToken.ts の PUBLIC_KEY_SPKI_BASE64 へ貼る。公開してよい値）:')
  console.log(pub.toString('base64'))
}

function sign(subject: string, days: number): string {
  const b64 = readEnvVar(PRIVATE_KEY_VAR)
  if (!b64) throw new Error(`${PRIVATE_KEY_VAR} がありません。先に --init を実行してください。`)
  const nowSec = Math.floor(Date.now() / 1000)
  // **並びを固定した JSON を自分で組む。** `JSON.stringify` のキー順は入力順なので、
  // ここで書いた順がそのまま署名対象になる。検証側は中身を読むだけで順序に依存しない。
  const payload = JSON.stringify({ sub: subject, iat: nowSec, exp: nowSec + days * 86400 })
  const payloadPart = b64url(Buffer.from(payload, 'utf8'))
  const signer = createSign('SHA256')
  signer.update(payloadPart)
  // **`ieee-p1363`（r||s の生の 64 バイト）で署名する。** 既定の DER は Web Crypto の
  // `verify('ECDSA', ...)` が受け付けない。
  const sig = signer.sign(
    { key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8', dsaEncoding: 'ieee-p1363' },
  )
  return `${payloadPart}.${b64url(sig)}`
}

export function main(): void {
  const args = process.argv.slice(2)
  if (args.includes('--init')) {
    init()
    return
  }
  const subject = args.find((a) => a.startsWith('--subject='))?.slice('--subject='.length)
  if (!subject) {
    throw new Error('--subject=<渡す相手の名前> は必須です（--init で鍵を作ってから実行します）')
  }
  const daysArg = args.find((a) => a.startsWith('--days='))?.slice('--days='.length)
  const days = daysArg ? Number(daysArg) : DEFAULT_DAYS
  if (!Number.isFinite(days) || days <= 0) throw new Error(`--days が読めません: ${daysArg}`)

  const token = sign(subject, days)
  console.log(token)
  if (!readEnvVar(TOKEN_VAR)) {
    appendFileSync(ENV_PATH, `\n# dev サーバーで自動投入する自分用トークン\n${TOKEN_VAR}=${token}\n`, 'utf8')
    console.log(`\n${ENV_PATH} へ ${TOKEN_VAR} として書きました（dev サーバーで自動投入されます）。`)
  } else {
    console.log(`\n${ENV_PATH} には既に ${TOKEN_VAR} があるので上書きしていません。差し替えるなら手で書き換えてください。`)
  }
}

/**
 * **直接実行されたときだけ走らせる。**
 *
 * テストが定数を読むために import するので、読み込みだけで `main()` が動くと
 * `npm test` が鍵を作って `.env.local` へ書き込む（→ `scripts/scriptEntrypoints.test.ts`）。
 */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}
