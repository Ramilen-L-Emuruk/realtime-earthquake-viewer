// UDP を待ち受けて、届いた 1 つずつを文字列で渡す。
//
// **ここでは中身を見ない。** 読み取りも数え上げも上の層の仕事で、この層が持つのは
// ソケットの開け閉めと、届いた順に渡すことだけ。混ぜると、読み取りを直すたびに
// 受信の検証をやり直すことになる（記録係の原型 `capture.mjs` が置いていた分担）。
//
// **1 つのパケットは 1 つのデータグラム。** TCP と違って境界が保たれるので、
// 継ぎ足しの組み立ては要らない。途中で切れたものは長さが合わなくなるだけで、
// 読み取り側が `sample-count-mismatch` として落とす。
import { createSocket } from 'node:dgram'
import type { Socket } from 'node:dgram'

/** 送り手。**速度の上限を掛ける鍵になる**（担当は上の層）。 */
export interface DatagramSource {
  readonly address: string
  readonly port: number
}

/**
 * 届いたものの送り手へ 1 つ返す口。**投げない。** 結果は `onDone` で受け取る
 * （送れたら `null`）。
 *
 * **受けたのと同じソケットから返す。** 基板は送るのに使ったソケットでしか返事を
 * 待っていない（送り元のポートは基板が開くたびに変わる）ので、別のソケットから
 * 投げると宛先のポートが合っていても届かない。
 */
export type DatagramReply = (payload: string, onDone: (error: Error | null) => void) => void

export interface UdpReceiverOptions {
  /** 待ち受けるポート。**0 を渡すと空いているものが選ばれる**（テスト用）。 */
  readonly port: number
  /** 待ち受けるアドレス。省略すると全インターフェース。 */
  readonly address?: string
  /**
   * OS に頼む受信バッファの大きさ（バイト）。
   *
   * **受け手の処理が止まっている間、届いたものを抱えておけるのはここだけ。** あふれた分は
   * OS が黙って捨て、受け手からは数えられない（基板の番号が飛んだことで後から分かるだけ）。
   * 既定（Windows で 64 KB）は基板 3 枚の約 3 秒ぶんしか無く、2026-10-02 にホストが
   * 約 45 秒止まったときはその間の分をまるごと失った。
   *
   * **OS が言われた大きさに従うとは限らない**（Linux は `rmem_max` で頭打ちにする）。
   * 実際の大きさは `UdpReceiver.recvBuffer` で確かめる。
   */
  readonly recvBufferBytes: number
  /**
   * 1 つ届くたびに呼ばれる。
   *
   * **返す口は届いたものと一緒に渡す。** 受信口そのものを受け手へ持たせる形にすると、
   * 受け手が「受信口を作り終える前に届いた 1 件」で未初期化の参照を踏みうる。
   */
  readonly onDatagram: (payload: string, from: DatagramSource, reply: DatagramReply) => void
  /**
   * ソケットの異常と、`onDatagram` が投げた例外。
   *
   * **握り潰さない。** 受信口が黙っても画面は静かなままなので、
   * 気づく手立てを呼び出し側が必ず受け取る形にする。
   */
  readonly onError: (error: Error) => void
}

/**
 * 受信バッファを広げた結果。
 *
 * **広げられなくても待ち受けは続ける。** 止まったときに落としやすくなるだけで、
 * 受け取れなくなるわけではない —— 起動を止めるほうが失うものが大きい。
 */
export interface RecvBufferOutcome {
  readonly requestedBytes: number
  /** OS が実際に割り当てた大きさ。読めなかったら null。 */
  readonly actualBytes: number | null
  /** 広げる・読むのどちらかで投げた理由。どちらも通れば null。 */
  readonly error: string | null
}

export interface UdpReceiver {
  /** 実際に待ち受けているポート。`port: 0` で開けたときはここで確かめる。 */
  readonly port: number
  readonly recvBuffer: RecvBufferOutcome
  close(): Promise<void>
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * 待ち受けを始める。開けなかったら**返る約束のほうが失敗する**。
 *
 * 開けなかったこと（ポートの取り合い・権限）と、開いたあとの異常は別の事象なので
 * 渡し先を分ける。混ぜると、起動に失敗したプロセスが「動いているつもり」で走り続ける。
 */
export function startUdpReceiver(options: UdpReceiverOptions): Promise<UdpReceiver> {
  return new Promise<UdpReceiver>((resolve, reject) => {
    const socket = createSocket({ type: 'udp4' })

    const onBindError = (error: Error): void => {
      socket.removeListener('listening', onListening)
      try {
        socket.close()
      } catch {
        // 束ねられなかったソケットは既に閉じていることがある。閉じられないこと自体は
        // 異常ではないので、開けなかった理由のほうを返す。
      }
      reject(error)
    }

    const onListening = (): void => {
      socket.removeListener('error', onBindError)
      socket.on('error', (error) => options.onError(error))
      socket.on('message', (buffer, rinfo) => {
        try {
          // **読めないバイト列でも投げない。** utf8 の復号は不正な並びを置換文字へ倒すので、
          // 形が違うものは読み取り側が `header-unreadable` として数える。
          options.onDatagram(
            buffer.toString('utf8'),
            { address: rinfo.address, port: rinfo.port },
            (payload, onDone) => replyTo(socket, rinfo.address, rinfo.port, payload, onDone),
          )
        } catch (error) {
          // **受け手の例外でソケットごと落とさない。** 1 台の壊れた送り手が、
          // 他の基板の受信まで止めることになる。黙らせはせず同じ口へ流す。
          options.onError(toError(error))
        }
      })
      resolve({
        port: socket.address().port,
        recvBuffer: widenRecvBuffer(socket, options.recvBufferBytes),
        close: () => closeSocket(socket),
      })
    }

    socket.once('error', onBindError)
    socket.once('listening', onListening)
    socket.bind(options.port, options.address)
  })
}

/**
 * 受信バッファを広げる。**束ねた後でしか呼べない**（Node は開いていないソケットで投げる）。
 *
 * **頼んだ値ではなく、読み直した値を返す。** OS が黙って小さくすることがあり、頼んだ値を
 * そのまま出すと「抱えられるつもり」の数字が残る。
 */
function widenRecvBuffer(socket: Socket, requestedBytes: number): RecvBufferOutcome {
  let error: string | null = null
  try {
    socket.setRecvBufferSize(requestedBytes)
  } catch (e) {
    error = toError(e).message
  }
  let actualBytes: number | null = null
  try {
    actualBytes = socket.getRecvBufferSize()
  } catch (e) {
    error ??= toError(e).message
  }
  return { requestedBytes, actualBytes, error }
}

/**
 * 1 つ返す。**どの失敗も `onDone` へ寄せる。**
 *
 * `send` は 2 通りに失敗する —— 閉じたソケットへ投げると**その場で例外**、宛先へ
 * 出せなかった（経路が無い等）ときは**あとで callback へ**。片方だけ拾うと、もう片方が
 * 受け手（`onDatagram`）の例外として受信の異常の口へ流れ、返事の失敗が数に載らない。
 */
function replyTo(
  socket: Socket,
  address: string,
  port: number,
  payload: string,
  onDone: (error: Error | null) => void,
): void {
  try {
    socket.send(payload, port, address, (error) => onDone(error ?? null))
  } catch (error) {
    onDone(toError(error))
  }
}

function closeSocket(socket: Socket): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      socket.close(() => resolve())
    } catch {
      // 既に閉じていれば投げる。**二度目の後片付けを異常として扱わない** ——
      // 終了の経路は複数あり（合図・入口の失敗）、どれから来ても締まればよい。
      resolve()
    }
  })
}
