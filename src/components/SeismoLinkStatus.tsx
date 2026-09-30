import { useEffect, useState } from 'react'
import type { SeismoStreamState } from '../services/seismoStream'
import { READING_STALE_MS } from '../hooks/useSeismoStation'

/**
 * 繋がらない状態が続いたと見なすまで（ms）。
 *
 * **震度を落とす値をそのまま借りる。** 押し出しが切れれば震度も届かなくなるので、
 * 地図の左上の帯は最後の震度から同じ時間で消える —— 揃えておけば、同じ瞬間に
 * 「値がある」と「繋がっていない」が並ばない。**書き写すと、片方だけ動かしたときに
 * 黙って崩れる。**
 *
 * **瞬断では出さないための間でもある。** 繋ぎ直しの最小待ちは 1 秒
 * （`services/seismoStream.ts` の `RECONNECT_MIN_MS`）なので、一度きりの失敗なら
 * この間に `open` へ戻る。
 *
 * **「帯が消えるのと入れ替わりに出る」とは限らない。** ここが見ているのは接続層が
 * 名乗る状態で、**黙って切れた繋ぎでは停滞の検出（`STALL_MS` = 45 秒）を待つ**まで
 * `'open'` のまま —— 帯が消えてからこの行が出るまで最大 45 秒の空白ができる
 * （即座に例外が返る切れ方なら数秒）。**この空白と、観測点だけが沈黙する形は、
 * どちらもこの行では拾えない**（→ `docs/spec/data-sources-spec.md` §4.5
 * 「繋がらなくなったことを地図の右上へ出す」の「拾えない形」）。
 */
const GRACE_MS = READING_STALE_MS

/**
 * 出す文言。
 *
 * **「【何が】【どうなった】」だけ。** 隣に並ぶ波形の「波形 途絶」と同じ形で、
 * 地図の隅は 1 行しか使えない —— 折り返すと何本出ているか読めなくなる。
 *
 * **行動の案内（「ホストが起動しているか確認」の類）は付けない。** 繋がらない理由は
 * 4 通りあり（切っている・URL が空・URL の形が違う・ホストが応えない）、**どれか 1 つを
 * 括弧へ書くと残りでは誤った案内になる** —— 購読の上限（同時 8 本）で断られている
 * ときは、ホストは元気に動いている。切り分けは設定タブの 1 行が受け持つ
 * （`SettingsTab/seismoStatusLine.ts`）。
 */
const TEXT = '地震計 未接続'

interface Props {
  /** 押し出しの繋がり具合。**機能が切れている・URL の形が違うときは `null`。** */
  readonly stream: SeismoStreamState | null
}

/**
 * 自作地震計の押し出しが繋がらなくなったことを知らせる（`services/seismoStream.ts`）。
 *
 * **この機能でいちばん重い失敗は「揺れていない」と「届いていない」の混同**
 * （`docs/spec/data-sources-spec.md` §4.5）。震度が届かなくなると地図の左上の帯は
 * 消えるが、**消えたことだけでは理由が分からない** —— 揺れていないのか、繋がって
 * いないのかを分ける手掛かりがここにしか無い。
 *
 * **設定タブの 1 行では代われない。** あちらは `GET /status` を 1 回叩く別の確認で
 * （`SettingsTab/seismoStatusLine.ts`）、押し出しが切れたことは映らないし、そもそも
 * 地図を見ている利用者は設定タブを開いていない。
 *
 * **正常時は何も描かない**（`MapDataStatus`・`MapRenderStatus` と同じ作法）。
 */
export function SeismoLinkStatus({ stream }: Props) {
  // **`stream` そのものを依存にしない。** 繋ぎ直しのたびに待ち時間の載った別の値が
  // 来るので（`reconnecting` の `nextAttemptInMs`）、オブジェクトを見張ると**待ちが
  // 張り直され続けて永久に出ない**。見るのは「繋がっていないか」の真偽だけ。
  const down = stream !== null && stream.kind !== 'open'
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (!down) {
      setShown(false)
      return
    }
    const timer = window.setTimeout(() => setShown(true), GRACE_MS)
    return () => window.clearTimeout(timer)
  }, [down])

  // **`down` も併せて見る。** 繋がった直後の 1 レンダーは `shown` がまだ真のまま
  // （state の書き換えは効果が走ってから）なので、これが無いと復旧の瞬間に 1 度だけ
  // 残る。
  if (!down || !shown) return null

  return (
    <div className="bg-black/80 rounded text-xs px-2 py-0.5 roomy:text-lg roomy:px-2.5 roomy:py-1 text-amber-300">
      {TEXT}
    </div>
  )
}
