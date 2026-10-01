// センサーノードから届くパケットを、版によらない 1 つの形へ正規化した型。
//
// **識別の鍵は名前ではない。** 表示名も観測点も「どこへ置いたか」で変わるのに対し、
// MAC は焼いても置き換えても変わらない。データを名前で引く形にすると、基板を別の
// 部屋へ移した日を境に、同じ名前が別の場所の波形を指すようになる。

/** 何を根拠にその基板だと言えるか。前置きは出どころを消さないために付ける。 */
export type BoardKey = `mac:${string}` | `name:${string}`

export interface SensorPacket {
  /** 読み取った形式の版。1 は MAC を名乗らないので `boardKey` が `name:` になる。 */
  version: 1 | 2
  /** 基板の同一性。 */
  boardKey: BoardKey
  /**
   * 起動ごとに変わる値。**通し番号はこれと組にしないと一意にならない** ——
   * 再起動で 0 へ戻るため、蓄えた記録の中では別の起動の番号と衝突する。
   * 版 1 は持っていないので空になる（その範囲では衝突を検知できない）。
   */
  bootId: string
  /** 基板の中のどのセンサーか。配線で決まる事実なので基板側が名乗る。 */
  sensorId: string
  /** 型番。換算の根拠を後から辿るために持つ。 */
  sensorType: string
  /**
   * 軸の名前。`samples` の列と 1 対 1 で並ぶ。
   * **ここを見れば軸数が分かるので、読む側は型番を知らなくてよい。**
   * 命名は SEED に倣う（`HN` = 100Hz 級の加速度計、3 文字目が向き）。
   * 方位が確定していなければ `1/2/3`、確定したら `Z/N/E`。
   *
   * **読み取り専用。** 版 1 は全パケットが同じ配列を共有するので、1 箇所で書き換えると
   * プロセス内の全ストリームの軸名がまとめて壊れる。型で禁じておく。
   */
  channels: readonly string[]
  /** 1 LSB あたりの µg。**保存するのは生の値で、換算はこれを使って読むときに行う。** */
  ugPerLsb: number
  /** フルスケール（g）。 */
  fullScaleG: number
  sampleRateHz: number
  /**
   * 先頭サンプルの時刻（unix ミリ秒）。
   * **版 1 は約 +5 ms 遅い値を送ってくるので、読み取りの時点で補正してある**
   * （理由は `parseSensorPacket` のコメント）。
   */
  firstSampleMs: number
  /** 先頭サンプルの通し番号。起動ごとに 0 から。 */
  firstSeq: number
  /** そのセンサーで積み上がった、FIFO があふれた回数。 */
  overflowCount: number
  /** 生のカウント値。`samples[i][j]` が `channels[j]` の i 番目。 */
  samples: number[][]
}

/** 読めなかった理由。**数えるために分ける** —— 原因ごとに手当てが違う。 */
export type PacketParseFailure =
  /** 中身が無い。 */
  | 'empty'
  /** 先頭行が JSON として読めない。別のプログラムが同じポートへ投げている疑い。 */
  | 'header-unreadable'
  /** 知らない版。形式が先に進んだ合図なので、黙って捨てない。 */
  | 'unsupported-version'
  /** 欄の値が型・値域から外れている。 */
  | 'header-field-invalid'
  /** 宣言された件数とサンプル行の数が合わない。**UDP が途中で切れた疑い。** */
  | 'sample-count-mismatch'
  /** 列の数が軸の数と合わない。 */
  | 'sample-column-mismatch'
  /** 整数として読めない値が混じっている。 */
  | 'sample-not-integer'

export type PacketParseResult =
  | {
    ok: true
    packet: SensorPacket
    /**
     * 送り手が「届いたら返事をくれ」と言っているか（ヘッダの `"ack":1`）。
     *
     * **`packet` に入れない。** これは届け方の取り決めで、観測値ではない ——
     * `SensorPacket` は区間の時間軸・震度・生データの保存へそのまま流れるので、
     * 混ぜるとそれらが通信の都合を知ることになる。
     *
     * **求めていない送り手には返さない**（`../receiver/ackReplier.ts`）。
     * 返事を読まない古いファームへ投げても、向こうの受信バッファに溜まるだけ。
     */
    ackRequested: boolean
  }
  | { ok: false; reason: PacketParseFailure; detail: string }
