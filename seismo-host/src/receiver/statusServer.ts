// 状態の口。**読み取りだけ。**
//
// - `GET /status` — いまの様子を JSON で返す（宛先は**運用者**）
// - `GET /stream` — 計測震度を押し出す。`?wave=1` を付けたときだけ波形も付く（宛先は **PWA**）
//
// **書き込みの口は作らない。** 機材の管理（センサー一覧・版数・OTA・校正・保存設定）は
// ビューアーの外という線引きなので、ここが受けるのは読み取りだけ。
//
// **過ぎた波形を読み返す口も無い。** 生データはディスクに残っているので後から作れるが、
// 時刻の範囲を受けて圧縮済みのファイルを展開し間引いて返す、という別の仕事になる。
//
// **SSE を選んだ理由**（WebSocket ではなく）。速さはどちらも同じで、差が出るのは別のところ。
// 再接続をブラウザが自分でやること、普通の HTTP なので HTTPS のページから
// プライベート IP を叩けるという実測がそのまま当てはまること（`ws://` には既に
// 「非推奨」の警告が出ている）、そしてこちらから送るものが無いので双方向の利点が効かないこと。

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

import type { HubMessage, ReadingHub } from './readingHub'
import type { StatusReport } from './statusReport'

/** 繋ぎ直すまでブラウザに待たせる時間。**SSE の `retry:` で伝える。** */
const RETRY_MS = 3_000

/**
 * 生存確認を送る間隔。
 *
 * **相手が黙って消えたことに気づくための仕組み。** 送るのはコメント行なので
 * `EventSource` の `message` には現れない。これが無いと、電源を抜かれた端末のぶんが
 * 枠を占めたまま残り、**新しく開いたタブが上限で断られる。**
 */
const HEARTBEAT_MS = 15_000

export type LogLevel = 'log' | 'warn' | 'error'

export interface StatusServerOptions {
  readonly port: number
  readonly address?: string
  readonly hub: ReadingHub
  /**
   * いまの様子を作って返す。**呼ばれた時点で組み立てる。**
   *
   * 溜め込んだものを返す形にすると、見に来た人が「いつの様子か」を自分で確かめられない。
   */
  readonly status: () => StatusReport
  /**
   * 記録を 1 行出す。**間引きは呼び出し側が持つ**（`main.ts` の `emit`）。
   *
   * ここで数を抑えないのは、抑え方の規約が 1 箇所（`logThrottle.ts`）にある約束を
   * 崩さないため。
   */
  readonly log?: (level: LogLevel, kind: string, detail: string, line: string) => void
  /**
   * 生存確認を送る間隔。**テストのために差し替える。**
   *
   * 既定を運用で変える用途は無い（値の根拠は `HEARTBEAT_MS`）。ここを開けてあるのは、
   * **生存確認がそもそも飛んでいるか**を確かめる手が他に無いため —— 実際に 15 秒
   * 待つテストは書けず、待たずに済ませるとこの間隔タイマーの配線を誰も見ない。
   *
   * **ここで観測できるのは「飛ぶこと」までで、書き込みが失敗した側は覆えない。**
   * 相手が切れば `req` の `'close'` が先に走って間隔タイマーを止めるので、
   * **外から壊せるソケットでは `stopFailed` へ到達しない**（あの経路が要るのは、
   * `'close'` を伴わずに壊れる場合）。`closeFailed` 自体の振る舞いは
   * `readingHub.test.ts` が押さえているが、**ここからの配線は覆われていない。**
   */
  readonly heartbeatMs?: number
}

export interface StatusServer {
  /** 実際に開いた port。**0 を渡した場合はここで判る。** */
  readonly port: number
  close(): Promise<void>
}

/** SSE の 1 件。 */
function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

function encode(message: HubMessage): string {
  if (message.kind === 'reading') return sseEvent('reading', message.reading)
  if (message.kind === 'wave') return sseEvent('wave', message.wave)
  return sseEvent('station-reading', message.reading)
}

/**
 * 横断の許しを付ける。
 *
 * **オリジンを列挙せず `*` で開く。** 読み取り専用で、出るのは家の揺れの計測震度と
 * 機材の健全性だけ。繋ぎ先（GitHub Pages・dev サーバー・preview・別の端末のブラウザ）は
 * 増えるので、列挙する形にすると**増えるたびに受け手を書き換える運用**になる。
 */
function applyCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
}

/**
 * 先回りの問い合わせ（preflight）へ答える。
 *
 * **プライベート網への許しも返す。** HTTPS のページからプライベート IP を叩く構成なので、
 * ブラウザが `Access-Control-Request-Private-Network` を付けてくることがある。
 * **2026-09-22 の実測（プライベート IP への `http://` は通った）は単一ブラウザ・
 * 単一版・各条件 1 回**なので、通ることを当てにせず、訊かれたら答える形にしてある。
 */
function handlePreflight(req: IncomingMessage, res: ServerResponse): void {
  applyCors(res)
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] ?? '*')
  if (req.headers['access-control-request-private-network'] === 'true') {
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
  }
  res.setHeader('Access-Control-Max-Age', '600')
  res.writeHead(204)
  res.end()
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  applyCors(res)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.writeHead(code)
  res.end(JSON.stringify(body))
}

export async function startStatusServer(options: StatusServerOptions): Promise<StatusServer> {
  const { hub } = options
  const writeLog = options.log ?? ((): void => {})

  /**
   * 記録を 1 行出す。**投げさせない。**
   *
   * `log` は呼び出し側が注入する関数で、この層からは中身を保証できない
   * （標準出力がパイプになっていて読み手が先に閉じれば、`console.*` は同期で投げる）。
   * ここから呼ぶのは**後始末の途中と間隔タイマーの中**なので、抜ければ
   * 後始末が飛ぶか、**この受け手のプロセスごと落ちる** —— 押し出しの購読 1 つのために
   * UDP の受信も生データの保存も道連れになる。
   *
   * **1 箇所ずつ `try` で囲う形にしない。** 呼ぶ場所は 5 つあり、囲い忘れても
   * 型検査もテストも通る（壊れるのは記録の口そのものが壊れたときだけなので、
   * 書き忘れに気づく機会が無い）。ここで一度だけ握れば、以後は素直に呼べる。
   */
  const log = (level: LogLevel, kind: string, detail: string, line: string): void => {
    try {
      writeLog(level, kind, detail, line)
    } catch {
      // **記録する手段そのものが壊れている。** `console` を経由せず、最後の望みとして
      // 直に 1 行だけ書く —— ここまで黙ると、SSE について以後どんな異常が起きても
      // 痕跡がどこにも残らない（切れた件数は数えられるが、**なぜ切れたかが消える**）。
      //
      // **ここも握る。** 握らなければ、記録の口が壊れたことを伝えるために
      // プロセスを落とすことになる。
      try {
        process.stderr.write(`[sse] 記録の口が投げた: ${kind}/${detail}\n`)
      } catch {
        // 伝える手段が 1 つも残っていない。
      }
    }
  }

  const handleStream = (req: IncomingMessage, res: ServerResponse, wantsWave: boolean): void => {
    applyCors(res)
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    // **間に挟まるものに溜め込ませない。** 逆向きの代理が居ると、溜めてから
    // まとめて流す既定のせいで押し出しの意味が消える。
    res.setHeader('X-Accel-Buffering', 'no')

    let heartbeat: NodeJS.Timeout | null = null
    const subscription = hub.subscribe({
      wave: wantsWave,
      deliver: (message) => {
        // **書く前に詰まりを見る。** 書いてから「詰まっている」と申告すると、
        // こちらは捨てたつもりでいるのに向こうの待ち行列だけが伸び続ける
        // （溜めない、という約束がそこで崩れる）。
        if (res.writableEnded || res.writableNeedDrain) return false
        res.write(encode(message))
        return true
      },
      onDetach: (reason) => {
        if (heartbeat !== null) clearInterval(heartbeat)
        // **`log` は投げない**（上の包みが握る）ので、後始末を `finally` へ逃がす
        // 必要は無い。ここで囲い直すと、守りの重なりが「なぜ 2 重なのか」として
        // 読めなくなる。
        log('warn', 'sse', reason, `[sse] 押し出しを切った（${reason}）`)
        res.end()
      },
    })

    if (subscription === null) {
      const limit = hub.snapshot().limit
      // **こちら側にも残す。** 切った理由（詰まり・壊れた・締めくくり）は `onDetach` が
      // 1 行ずつ出しているのに、断った回だけ黙ると非対称になる —— 断りは
      // `/status` の `rejected` にしか出ないので、**見に来ない運用では上限に
      // 張り付いたまま誰も気づけない**（向こうには 503 が返るが、それは向こうの記録）。
      log('warn', 'sse', 'rejected', `[sse] 購読の上限（${limit}）で断った`)
      // **断ったことを相手に伝える。** 黙って閉じると、繋がらない理由が
      // 向こうの画面にも記録にも残らない。
      sendJson(res, 503, { error: 'too-many-subscribers', limit })
      return
    }

    res.writeHead(200)
    // 繋ぎ直しの間隔を先に伝える。コメント行は `message` には現れない。
    res.write(`retry: ${RETRY_MS}\n\n`)

    const stop = (): void => {
      if (heartbeat !== null) clearInterval(heartbeat)
      subscription.close()
    }

    /**
     * 押し出しが壊れたので畳む。**`stop` と分ける。**
     *
     * 相手が閉じただけの正常な終わり方と同じ扱いにすると、**壊れて切れた購読が
     * `/status` の数のどこにも現れない** —— 見えるのは購読者が 1 つ減ったことだけで、
     * ふつうにタブを閉じたのと区別が付かない。詰まり・書き込み失敗を検知するための
     * 口なのに、まさにそれが起きた回だけ黙ることになる。
     */
    const stopFailed = (detail: string): void => {
      if (heartbeat !== null) clearInterval(heartbeat)
      subscription.closeFailed(detail)
      // **後始末はここで済ませる。** `closeFailed` はハブの一覧から外すだけなので、
      // 以後 `closeAll()` はこの購読を見つけられず `onDetach`（＝`res.end()`）も呼ばれない。
      // 壊れたソケットは既に閉じていることが多いが、**そう限らない** ——
      // 残ると、締めくくりで `server.close()` が返らない形になりうる。
      try {
        res.destroy()
      } catch {
        // 既に壊れている。捨てる以上にできることは無い。
      }
    }

    heartbeat = setInterval(() => {
      // **詰まっていたら送らない。** 本体の配達と同じ契約にする —— 小さいとはいえ、
      // 詰まった相手の待ち行列へ 15 秒ごとに積み増す理由が無い。
      if (res.writableEnded || res.writableNeedDrain) return
      // **投げさせない。** 破棄されたソケットへの書き込みは `res` の `'error'` を
      // 経由せず未捕捉例外まで抜けることがある。ここは間隔タイマーの中なので、
      // 抜ければ**この受け手のプロセスごと落ちる** —— 押し出しの購読 1 つのために
      // UDP の受信も生データの保存も道連れになる。
      try {
        res.write(': ping\n\n')
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        log('warn', 'sse', 'heartbeat', `[sse] 生存確認を送れず: ${detail}`)
        stopFailed(detail)
      }
    }, options.heartbeatMs ?? HEARTBEAT_MS)
    // **プロセスの終了を妨げない。** 締めくくりで必ず止めるが、止め損ねた経路が
    // あったときに待ち受けだけで終わらなくなるのは避ける。
    heartbeat.unref?.()
    // 相手が閉じた・壊れた。**どちらでも枠を返す。**
    req.on('close', stop)
    res.on('error', (error: Error) => {
      log('warn', 'sse', error.name, `[sse] 押し出しの書き込みで失敗: ${error.message}`)
      stopFailed(error.message)
    })
  }

  const server: Server = createServer((req, res) => {
    // **投げさせない。** ここで投げると Node が既定でプロセスごと落とす ——
    // 状態を見に来ただけの相手の打ち間違いで、受信そのものが止まる。
    try {
      if (req.method === 'OPTIONS') {
        handlePreflight(req, res)
        return
      }
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method-not-allowed' })
        return
      }
      // `req.url` は経路と問い合わせ文字列だけ。**基点は読まれないので何でもよい。**
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/status') {
        sendJson(res, 200, options.status())
        return
      }
      if (url.pathname === '/stream') {
        handleStream(req, res, url.searchParams.get('wave') === '1')
        return
      }
      sendJson(res, 404, { error: 'not-found' })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      log('error', 'http', 'handler', `[http] 応答を作れず: ${detail}`)
      if (!res.headersSent) {
        try {
          sendJson(res, 500, { error: 'internal' })
          return
        } catch (inner) {
          // **二重目の失敗も記録する。** 黙ると運用者のログには「応答を作れず」の
          // 1 行しか残らず、**応答を送ることすらできずに切ったこと**が痕跡として
          // 残らない（向こうからは「接続がリセットされた」としか見えない）。
          const why = inner instanceof Error ? inner.message : String(inner)
          log('error', 'http', 'fatal', `[http] 500 も返せず繋ぎを切った: ${why}`)
        }
      }
      res.destroy()
    }
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.address, () => {
      const addr = server.address()
      server.removeListener('error', reject)
      resolve(typeof addr === 'object' && addr !== null ? addr.port : options.port)
    })
  })

  return {
    port,
    close: async () => {
      // **押し出しを先に切る。** 開いたままだと `server.close()` は
      // 「まだ応答の途中」とみなして永久に返らない。
      hub.closeAll()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        // 状態を見たあと黙って繋ぎっぱなしのソケットも手放す。
        server.closeIdleConnections()
      })
    },
  }
}
