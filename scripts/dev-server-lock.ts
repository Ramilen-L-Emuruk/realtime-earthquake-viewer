/**
 * 同じ場所・同じバリアントで dev サーバーが二本立つのを止める門。
 *
 * 立ち上がった dev サーバーは、その作業ディレクトリ直下の `.dev-server.json` へ
 * 「PID・実ポート・URL・起動時刻・起動したセッション」を書き残す。次に同じバリアントを
 * 起動しようとしたとき、そこに**生きている別のプロセス**があれば URL と止め方を出して起動せずに終える。
 *
 * **記憶ではなく実物で判定する。** 「さっき立てたことを覚えている」前提の運用は、セッションが
 * 変われば成り立たない。判定の根拠はファイルとプロセスに置く。
 *
 * **二本目は失敗として現れない。** Vite は使用中のポートを避けて 5174・5175… と勝手にずれるので、
 * 二重起動しても何も起きていないように見える。だから人が気をつける形では防げない。
 *
 * ## 自分自身を二本目と誤認しないこと（最重要）
 *
 * **Vite は設定ファイルとその依存が変わると `restartServer()` を呼ぶ。** そこでは
 * **新しいプラグインの `configureServer` を先に実行し、旧サーバーを閉じるのはその後**。つまり
 * 判定の瞬間、自分がさっき書いた記録の PID は生きていて、そのポートも応答している。
 * ここで PID を見ずに止めると、**再起動のたびにプロセスごと終了する**。しかも終了コードは 0 で
 * 「既に動いています」と出るため、落ちた理由が誰にも分からない。
 *
 * このファイル自身も `vite.config.ts` の依存なので、**ここを編集して保存するたびに発火する**。
 * 2026-09-30 に実際に踏んだ（`touch vite.config.ts` だけでサーバーが消えた）。
 *
 * ## バリアントごとにエントリを分ける理由
 *
 * standard 版と DMDSS 版は別のものなので、同じ場所で両方立てたいことがある。止めたいのは
 * 「同じバリアントの二本目」だけなので、`{ "dmdss": {...}, "standard": {...} }` の形で持つ。
 *
 * ## 生存判定に PID だけを使わない理由
 *
 * **PID は再利用される。** 前のサーバーが死んだ後に別のプロセスが同じ番号を取れば、PID だけを
 * 見る判定は「まだ生きている」と誤る。そうなると起動できなくなるうえ、示す URL も嘘になる。
 * そこで **PID が生きていること**と**そのポートが実際に応答すること**の両方を求める。
 *
 * ## 記録を消す経路を当てにしない
 *
 * 正常終了時にはファイルを消すが、`Stop-Process` で強制終了されるとその後始末は走らない。
 * **消し忘れた記録が残ることを前提に**、読む側が生存判定で無効化する。
 * 逆に**消すときは自分の記録であることを確かめる** —— 競合で上書きされた後に消しにいくと、
 * 生きている別のサーバーの記録を落としてしまう。
 */

import { readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { connect } from 'node:net'
import type { Plugin } from 'vite'

/** 記録ファイルの名前。作業ディレクトリ直下に置く（`.gitignore` 済み）。 */
export const LOCK_FILE_NAME = '.dev-server.json'

/** ポートが応答するかを見るときの待ち時間。ローカルなので短くてよい。 */
const PORT_PROBE_TIMEOUT_MS = 500

export type DevServerRecord = {
  /** dev サーバーのプロセス ID。止めるときと、自分の記録かを見分けるのに使う。 */
  pid: number
  /** Vite が実際に取ったポート（指定値ではなくフォールバック後の値）。 */
  port: number
  /** ブラウザで開く URL。サブパスまで含めた完全な形で持つ。 */
  url: string
  /** ISO 8601。いつから動いているかを一覧で見せるため。 */
  startedAt: string
  /** 起動した Claude セッション。持ち主を特定できるようにする（取れなければ null）。 */
  sessionId: string | null
}

/** バリアント名（`standard` / `dmdss`）をキーにした記録。 */
export type DevServerLockFile = Record<string, DevServerRecord>

/**
 * 台帳を読めなかったことを伝える口。
 *
 * **省略できるようにしない。** 任意引数にしたら 3 箇所で渡し忘れ、読み取り失敗が黙って
 * 「記録なし」に化けた（2026-09-30 のレビューで発覚）。**黙ると決めたなら `() => {}` と書く** ——
 * 型が渡し忘れを落としてくれるうえ、「ここは黙ってよい」という判断がコードに残る。
 */
export type OnWarn = (message: string) => void

/** そのプロセスが生きているか。シグナル 0 は「送らずに存在だけ確かめる」指定。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // ESRCH（居ない）のほか EPERM（居るが権限が無い）でも例外になる。
    // EPERM は「別の誰かのプロセスがその番号を使っている」＝自分の dev サーバーではない、
    // と読めるので、どちらも「生きていない」に倒してよい。
    return false
  }
}

/** そのポートに TCP で繋がるか。PID の再利用に騙されないための二つ目の条件。 */
export function isPortServing(port: number, timeoutMs = PORT_PROBE_TIMEOUT_MS): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return Promise.resolve(false)
  return new Promise(resolve => {
    const socket = connect({ port, host: '127.0.0.1' })
    const settle = (result: boolean) => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

/**
 * 記録ファイルを読む。無い・壊れているときは空として扱う（起動を妨げない）。
 *
 * **「ファイルが無い」と「読めない」を混ぜない。** 前者は初回起動の正常な姿だが、後者
 * （権限が無い・他プロセスが掴んでいる）は門が黙って効かなくなる合図なので `onWarn` で伝える。
 * どちらの場合も空を返すのは変えない —— 読めないことを理由に起動を止めるのは過剰。
 */
export function readLockFile(root: string, onWarn: OnWarn): DevServerLockFile {
  const path = join(root, LOCK_FILE_NAME)
  if (!existsSync(path)) return {}
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch (error) {
    // **消えただけなら異常ではない。** `existsSync` の直後に別のプロセスが片付けることがある
    // （このリポジトリは常時いくつものワークツリーが並行する）。恐ろしげな警告を出すと、
    // 本物の障害と見分けが付かなくなる。
    if ((error as { code?: string }).code !== 'ENOENT') {
      onWarn(`[dev-server-lock] ${LOCK_FILE_NAME} を読めませんでした（門は働きません）: ${String(error)}`)
    }
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as DevServerLockFile
  } catch {
    // 手で編集して壊れた場合など。書き込みはアトミックなので、中途半端な内容は原理的に読めない。
    onWarn(`[dev-server-lock] ${LOCK_FILE_NAME} の中身を読み取れませんでした（作り直します）`)
    return {}
  }
}

/**
 * そのバリアントで**いま動いている** dev サーバーの記録を返す。
 * 記録はあるが死んでいる（消し忘れ・PID 再利用）場合は null。
 *
 * **これは「自分かどうか」を見ない。** 呼び出し側が PID を突き合わせること（→ 冒頭の注意）。
 */
export async function findLiveRecord(
  root: string,
  variant: string,
  onWarn: OnWarn,
): Promise<DevServerRecord | null> {
  const record = readLockFile(root, onWarn)[variant]
  if (!record || typeof record.pid !== 'number' || typeof record.port !== 'number') return null
  if (!isProcessAlive(record.pid)) return null
  if (!(await isPortServing(record.port))) return null
  return record
}

/**
 * 書き込みは一時ファイルへ出してから `rename` で置き換える。
 *
 * **直接上書きすると、読み手が書きかけの中身を掴む**（torn read）。そうなると記録が無いものとして
 * 扱われ、門が素通りする・他バリアントのエントリが消える、という形で静かに壊れる。
 * `rename` は同一ボリューム内で不可分なので、読み手には必ず旧か新のどちらかが見える。
 */
function writeFileAtomic(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, content, 'utf-8')
  try {
    renameSync(temporary, path)
  } catch (error) {
    // **置き換えに失敗したら一時ファイルを片付ける。** 残すと作業ディレクトリに
    // `.dev-server.json.<PID>.tmp` が溜まり、`git status` にも現れる。
    try {
      rmSync(temporary, { force: true })
    } catch {
      // 片付けにも失敗したら諦める。`.gitignore` が拾うので、誤ってコミットはされない。
    }
    throw error
  }
}

/**
 * 記録を書く。他のバリアントのエントリは残す。失敗は例外として呼び出し側へ返す。
 *
 * **`onWarn` を必ず渡すこと。** ここで台帳が読めないと、他バリアントの生きた記録を
 * 消したまま上書きしてしまう（そのバリアントは次の起動で門を素通りする）。
 */
export function writeRecord(
  root: string,
  variant: string,
  record: DevServerRecord,
  onWarn: OnWarn,
): void {
  const next = { ...readLockFile(root, onWarn), [variant]: record }
  writeFileAtomic(join(root, LOCK_FILE_NAME), `${JSON.stringify(next, null, 2)}\n`)
}

/**
 * 自分のエントリだけ消す。最後の 1 つならファイルごと消す。
 *
 * **`expectedPid` を渡すと、その PID の記録のときだけ消す。** 競合で自分の記録が
 * 上書きされた後に消しにいくと、**生きている別のサーバーの記録を落とす**ため。
 * 省略した場合は無条件に消す（テストと手作業の片付け用）。
 */
export function clearRecord(
  root: string,
  variant: string,
  expectedPid: number | undefined,
  onWarn: OnWarn,
): void {
  const current = readLockFile(root, onWarn)
  const record = current[variant]
  if (!record) return
  if (expectedPid !== undefined && record.pid !== expectedPid) return
  delete current[variant]
  const path = join(root, LOCK_FILE_NAME)
  try {
    if (Object.keys(current).length === 0) rmSync(path, { force: true })
    else writeFileAtomic(path, `${JSON.stringify(current, null, 2)}\n`)
  } catch (error) {
    // 消し損ねても、読む側が生存判定で無効化するので門は正しく働く。ただし**黙らない** ——
    // 記録が残り続ける理由を後から追えるようにする。
    onWarn(`[dev-server-lock] ${LOCK_FILE_NAME} から記録を消せませんでした: ${String(error)}`)
  }
}

/** 既に動いているときに出す案内。URL と止め方の両方を出す（次の行動が決まるように）。 */
export function formatAlreadyRunning(variant: string, record: DevServerRecord): string {
  const started = record.startedAt ? new Date(record.startedAt).toLocaleString('ja-JP') : '不明'
  const owner = record.sessionId ? `\n  起動したセッション: ${record.sessionId}` : ''
  return [
    '',
    `[dev-server-lock] この場所では ${variant} 版の dev サーバーが既に動いています。`,
    `  URL:  ${record.url}`,
    `  PID:  ${record.pid}`,
    `  起動: ${started}${owner}`,
    '',
    `  止めるなら: Stop-Process -Id ${record.pid}`,
    '',
    '  そのまま二本目を立てると Vite が別のポートへ逃げ、どちらが目的のものか分からなくなるため、',
    '  起動を見送りました。上の URL へ接続してください。',
    '',
  ].join('\n')
}

/**
 * ## `process.on('exit')` は使わない
 *
 * 後始末は `httpServer` の `close` だけで行う。プロセス終了時のフックは**置かない**。
 *
 * 理由は 2 つ。
 *
 * 1. **モジュールスコープのガードが効かない。** Vite は設定ファイルが変わるたびに
 *    それを**一意な一時ファイル名へ再バンドルして `import()` し直す**（ESM のモジュール
 *    キャッシュを意図的に外す作り）。だから「1 回だけ登録する」旗は毎回リセットされ、
 *    リスナーは再起動のたびに積み上がる。11 回目で `MaxListenersExceededWarning` が出る。
 *    **1 巡目でこのガードを足したが、まったく効いていなかった**（2026-09-30 のレビューで発覚）
 * 2. **そもそも要らない。** フックが担うのは「`close` が発火しない異常終了」のケアだが、
 *    そこは**読む側の生存判定**（PID が生きている ＋ ポートが応答する）が既に無害化している。
 *    強制終了で記録が残っても、次の起動はそれを「死んでいる」と正しく判断する
 */

/**
 * 門を Vite へ差し込むプラグイン。
 *
 * `configureServer` は listen の前に呼ばれるので、そこで既存の記録を調べ、**自分以外の**
 * 生きたサーバーがあれば案内を出して終える。実ポートは listen してからでないと決まらないため、
 * 書き込みは `listening` を待つ。
 *
 * **`vite build` / `vite preview` では何もしない**（`apply: 'serve'`）。
 */
export function devServerLockPlugin(options: {
  variant: string
  /** サブパス（`/realtime-earthquake-viewer/dmdss/` など）。案内の URL に使う。 */
  base: string
  /** 記録の置き場所。Vite の `root`（= その作業ディレクトリ）。 */
  root: string
  /** テスト用の差し替え口。既定は実際にプロセスを終える。 */
  exit?: (code: number) => void
}): Plugin {
  const { variant, base, root, exit = (code: number) => process.exit(code) } = options
  return {
    name: 'dev-server-lock',
    apply: 'serve',
    async configureServer(server) {
      const warn = (message: string) => server.config.logger.warn(message)
      const live = await findLiveRecord(root, variant, warn)

      // **自分自身は「二本目」ではない**（→ 冒頭「自分自身を二本目と誤認しないこと」）。
      // Vite の再起動では、旧サーバーがまだ listen している間に新しい configureServer が走る。
      if (live && live.pid !== process.pid) {
        warn(formatAlreadyRunning(variant, live))
        // 「既にある」は異常ではないので 0 で終える。npm が失敗として扱うと、
        // 呼び出し側が本物の起動失敗と区別できなくなる。
        exit(0)
        return
      }

      server.httpServer?.once('listening', () => {
        const address = server.httpServer?.address()
        const port = address && typeof address === 'object' ? address.port : null
        if (port == null) {
          warn('[dev-server-lock] 実ポートを取得できず、起動を記録しませんでした（門は働きません）')
          return
        }
        try {
          writeRecord(
            root,
            variant,
            {
              pid: process.pid,
              port,
              url: `http://localhost:${port}${base}`,
              startedAt: new Date().toISOString(),
              sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null,
            },
            warn,
          )
        } catch (error) {
          // **ここで投げると dev サーバーが起動した瞬間に落ちる。**
          // `listening` は同期コールバックなので、例外はそのまま uncaught exception になる。
          // 門が働かないのは不便だが、起動できないよりはるかにましなので、伝えて続ける。
          warn(`[dev-server-lock] 起動を記録できませんでした（門は働きません）: ${String(error)}`)
        }
      })

      // **後始末はここだけ。** プロセス終了時のフックは置かない（理由は上の注記）。
      // 強制終了で残った記録は、読む側の生存判定が無効化する。
      server.httpServer?.once('close', () => {
        clearRecord(root, variant, process.pid, warn)
      })
    },
  }
}
