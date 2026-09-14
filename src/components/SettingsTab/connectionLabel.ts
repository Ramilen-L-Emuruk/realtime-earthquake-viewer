import type { ConnectionStatus } from '../../types/earthquake'
import { log } from '../../utils/logger'

/** 接続状態の行に出す文言と色。 */
export interface ConnectionLabel {
  text: string
  /** 文字色（`text-xs` は呼び出し側が付ける）。 */
  className: string
}

/**
 * DM-D.S.S の接続状態を、利用者向けの文言と色へ写す。
 *
 * **分岐を JSX の中に書かないこと。** `ConnectionStatus` に値を足したとき、書き忘れても
 * 型検査には掛からず「画面にだけ出ない」形で漏れる（三項演算子の連鎖は最後の `:` が
 * 全部を受けてしまう）。ここへ集めて網羅検査を置けば、足した時点で型検査が止まる。
 *
 * 文言の方針は「**利用者がすべきことが違うなら、文言も分ける**」。
 * - `crowded`（同時接続の上限）で「切断」と出すと、キーや回線を疑わせる。実際にすべきことは
 *   別のタブを閉じることだけで、しかも枠が空けば自動で繋がる（→ `dmdata.ts` の
 *   `RECONNECT_CROWDED_MAX_MS`）。
 * - キーが未設定・不正なときは接続を試みていないので、通信の失敗と区別する。
 */
export function dmdataConnectionLabel(
  status: ConnectionStatus | undefined,
  opts: { apiKeySet: boolean; apiKeyInvalid: boolean },
): ConnectionLabel {
  switch (status) {
    case 'connected':
      return { text: '接続中', className: 'text-green-400 font-medium' }
    case 'connecting':
      return { text: '接続試行中...', className: 'text-blue-400' }
    case 'replay':
      // 過去再生中はライブ受信を意図的に止めている。「切断」と出すと異常のように見え、
      // 更新しないままだと「接続中」が残って実態と食い違う。
      return { text: '再生中（ライブ受信は停止）', className: 'text-blue-400' }
    case 'crowded':
      return {
        text: '同時接続の上限（別のタブか端末が接続中。閉じれば自動で繋がります）',
        className: 'text-amber-400',
      }
    case 'disconnected':
    case undefined:
      if (!opts.apiKeySet) return { text: 'APIキー未設定', className: 'text-secondary' }
      if (opts.apiKeyInvalid) return { text: 'APIキーが不正', className: 'text-red-400' }
      return { text: '切断', className: 'text-secondary' }
    default: {
      // 網羅検査。`ConnectionStatus` に値を足したらここで型検査が止まる。
      // **「切断」へ落とさない** —— 落とすと新しい状態が既存の文言に混ざり、
      // 気づく機会が画面からも型からも失われる。
      //
      // 型の上では到達しないが、記録は残す。型検査を通らない経路（別モジュールが
      // 文字列を渡す・型と呼び出し側の同期が崩れる）で来たとき、画面には出ても
      // **コンソールに手掛かりが無いと原因を追えない**。
      const exhaustive: never = status
      log.warn('[DMDSS] 未知の接続状態を受け取りました', { status: String(exhaustive) })
      return { text: String(exhaustive), className: 'text-secondary' }
    }
  }
}
