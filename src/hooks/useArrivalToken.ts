import { useEffect, useState } from 'react'
import { verifyArrivalToken, type ArrivalTokenStatus } from '../utils/arrivalToken'
import { serverNow } from '../utils/clock'
import { log } from '../utils/logger'

/**
 * `setTimeout` が受け取れる遅延の上限（符号付き 32bit ミリ秒・約 24.8 日）。
 *
 * **これを超える値を渡すと桁があふれて即座に発火する。** 発行しているトークンの期限は既定で
 * 365 日なので、失効時刻まで一気に張ると必ずここに掛かる。刻んで張り直す。
 */
const MAX_TIMER_MS = 2_147_483_000

const initialStatus = (token: string): ArrivalTokenStatus =>
  token
    ? { valid: false, expMs: null, problem: null, checking: true }
    : { valid: false, expMs: null, problem: 'empty', checking: false }

/**
 * 到達予想トークンの検証結果。自前の走時計算を開く唯一の門（→ `utils/arrivalToken.ts`）。
 *
 * **検証は非同期**（`crypto.subtle`）なのに、設定の読み書きは同期。そのため「まだ検証して
 * いない」状態が必ず生まれる。**そこでは `valid` を偽にする** —— 検証が済むまで公開版と同じ
 * 挙動にしておけば、遅れて開くだけで済む。逆に真から始めると、トークンが無効な端末でも
 * 検証が終わるまでのあいだ自前計算が動く。同じ理由で、**トークンが差し替わった瞬間も閉じる側へ
 * 倒す**（前の値の検証結果を、新しい値の検証が済むまで流用しない）。
 *
 * **失効は時間の経過だけで起きるので、失効時刻に再検証を張る。** トークン文字列が変わった
 * ときにしか検証しない作りだと、このアプリのように開きっぱなしで使う端末では期限を過ぎても
 * 自前計算が有効なまま残り、渡した相手の分を失効させる手段が実質的に消える。
 *
 * **理由と期限まで返すのは、設定タブがその結果を描くため。** 呼び出し側で検証をもう 1 度
 * 走らせる形にはしない —— 別々に検証すると、期限の境目で「画面は有効と言っているのに門は
 * 閉じている」（またはその逆）が起きる。**門と表示は同じ 1 つの結果から出す。**
 *
 * トークンを書き換えている最中は毎打鍵で検証が走るが、鍵の取り込みは 1 度だけで、
 * 署名検証はローカルの計算なので通信も鍵の再取り込みも起きない。
 */
export function useArrivalTokenCheck(token: string | null | undefined): ArrivalTokenStatus {
  // **前後の空白を落としてから扱う。** 検証の側も同じことをするので結果は変わらないが、
  // 空白だけの入力がここでは真になり「確認中」が一瞬出る。空白を足しただけの打鍵で
  // 検証を張り直さないのも、揃えておく理由のひとつ。
  const trimmed = token?.trim() ?? ''
  const [status, setStatus] = useState<ArrivalTokenStatus>(() => initialStatus(trimmed))

  useEffect(() => {
    // 検証が済むまでは閉じておく（トークンが差し替わった直後に古い結果を残さない）。
    setStatus(initialStatus(trimmed))
    if (!trimmed) return

    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const check = () => {
      void verifyArrivalToken(trimmed)
        .then((result) => {
          // 検証中にトークンが変わったら、古い結果を捨てる（後から解決した順で上書きさせない）。
          if (!active) return
          setStatus({ ...result, checking: false })
          if (!result.valid || result.expMs === null) return
          // 失効したら閉じるために、その時刻で検証し直す。上限を超える遅延は刻んで張り直す。
          // 下限を置くのは、時計が飛んで残りが負になったときに張り直しが詰まらないようにするため。
          const remainingMs = result.expMs - serverNow()
          timer = setTimeout(check, Math.min(Math.max(remainingMs + 1000, 1000), MAX_TIMER_MS))
        })
        .catch((err) => {
          // **いまの `verifyArrivalToken` は reject しない**（全経路を内部の try で囲い、
          // 失敗しても `problem: 'error'` を返す）。それでも受けておくのは、**その約束が
          // 型でもテストでも強制されていない**から —— 将来 try の外に `await` が 1 つ増えれば
          // `.then` へ到達せず、`checking: true` のまま**永久に「確認中」で固まる**。
          // 門は閉じたままなので危険側には倒れないが、画面からは理由が消えて記録も出ない。
          if (!active) return
          log.warn('[arrival] トークンの検証が例外で終わりました', err)
          setStatus({ valid: false, expMs: null, problem: 'error', checking: false })
        })
    }
    check()

    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
    }
    // **見るのは空白を落とした値。** 生の値を見ると、末尾に空白を足しただけの打鍵で
    // 検証を張り直し、そのあいだ門が閉じて自前計算が止まる。
  }, [trimmed])

  return status
}
