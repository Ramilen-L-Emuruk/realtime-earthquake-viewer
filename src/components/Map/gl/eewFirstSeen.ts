import type { EEWAlert } from '../../../types/earthquake'
import { eewEventKey } from '../../../utils/eew'

/**
 * EEW を「初めて見た時刻」の台帳を、いま発報中の EEW（`eews`）に合わせて更新する。
 *
 * `FitToEEWGL` が「新規発報」と「発報中の EEW のところへ入室した」を分ける材料。あちらは
 * リアルタイム震度モードのときだけマウントされるため、台帳は全モードで生きている `JapanMapGL` が
 * 持つ。純関数に切り出してあるのは、**消滅と再出現の境界**をテストで固定するため。
 *
 * - 記録するのは**震源座標が使える EEW だけ**。`FitToEEWGL` は座標が無い間は何もしないので、
 *   そこを起点に数えると「座標が確定したときには初出から 10 秒過ぎていて、第一報として扱われない」
 *   が起きる（標準版の P2PQuake は座標不明を -200 のセンチネルで寄こす）。
 * - 発報が終わった EEW は台帳から落とす。**フォーカス済みの印も一緒に落とす**——残したままだと、
 *   同じ eventId が再び現れたときに第一報のフォーカスが二度と出ない（テスト時刻設定で同じ日時を
 *   再生し直すと、ID を採番し直さないため実際に同じ eventId が戻ってくる）。
 */
export function syncEewFirstSeen(
  seen: Map<string, number>,
  focusedEewIdRef: { current: string | null },
  eews: EEWAlert[],
  now: number,
): void {
  const alive = new Set<string>()
  for (const eew of eews) {
    const { latitude, longitude } = eew.earthquake.hypocenter
    // 座標があるかの判定は `FitToEEWGL` の早期 return と揃える（-200 は「位置不明」センチネル）。
    if (latitude <= -200 || longitude <= -200) continue
    const key = eewEventKey(eew)
    alive.add(key)
    if (!seen.has(key)) seen.set(key, now)
  }
  // 放置すると台帳が伸び続ける。掃除は 2 つとも同じ「もう発報していない」で行う（片方だけ残すと
  // 上記のとおりフォーカスが復活しなくなる）。
  for (const key of [...seen.keys()]) if (!alive.has(key)) seen.delete(key)
  const focused = focusedEewIdRef.current
  if (focused !== null && !alive.has(focused)) focusedEewIdRef.current = null
}
