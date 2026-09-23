import { useEffect, useState } from 'react'
import { verifyArrivalToken } from '../utils/arrivalToken'
import { serverNow } from '../utils/clock'

/**
 * `setTimeout` が受け取れる遅延の上限（符号付き 32bit ミリ秒・約 24.8 日）。
 *
 * **これを超える値を渡すと桁があふれて即座に発火する。** 発行しているトークンの期限は既定で
 * 365 日なので、失効時刻まで一気に張ると必ずここに掛かる。刻んで張り直す。
 */
const MAX_TIMER_MS = 2_147_483_000

/**
 * 到達予想トークンが有効か。自前の走時計算を開く唯一の門（→ `utils/arrivalToken.ts`）。
 *
 * **検証は非同期**（`crypto.subtle`）なのに、設定の読み書きは同期。そのため「まだ検証して
 * いない」状態が必ず生まれる。**そこでは false を返す** —— 検証が済むまで公開版と同じ
 * 挙動にしておけば、遅れて開くだけで済む。逆に true から始めると、トークンが無効な端末でも
 * 検証が終わるまでのあいだ自前計算が動く。同じ理由で、**トークンが差し替わった瞬間も閉じる側へ
 * 倒す**（前の値の検証結果を、新しい値の検証が済むまで流用しない）。
 *
 * **失効は時間の経過だけで起きるので、失効時刻に再検証を張る。** トークン文字列が変わった
 * ときにしか検証しない作りだと、このアプリのように開きっぱなしで使う端末では期限を過ぎても
 * 自前計算が有効なまま残り、渡した相手の分を失効させる手段が実質的に消える。
 *
 * トークンを書き換えている最中は毎打鍵で検証が走るが、鍵の取り込みは 1 度だけで、
 * 署名検証はローカルの計算なので通信も鍵の再取り込みも起きない。
 */
export function useArrivalTokenValid(token: string | null | undefined): boolean {
  const [valid, setValid] = useState(false)

  useEffect(() => {
    // 検証が済むまでは閉じておく（トークンが差し替わった直後に古い結果を残さない）。
    setValid(false)
    if (!token) return

    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const check = () => {
      void verifyArrivalToken(token).then(({ valid: ok, expMs }) => {
        // 検証中にトークンが変わったら、古い結果を捨てる（後から解決した順で上書きさせない）。
        if (!active) return
        setValid(ok)
        if (!ok || expMs === null) return
        // 失効したら閉じるために、その時刻で検証し直す。上限を超える遅延は刻んで張り直す。
        // 下限を置くのは、時計が飛んで残りが負になったときに張り直しが詰まらないようにするため。
        const remainingMs = expMs - serverNow()
        timer = setTimeout(check, Math.min(Math.max(remainingMs + 1000, 1000), MAX_TIMER_MS))
      })
    }
    check()

    return () => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [token])

  return valid
}
