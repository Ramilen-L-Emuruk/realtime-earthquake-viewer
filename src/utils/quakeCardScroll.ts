/**
 * 地震情報タブで、どのカードを見える位置へ寄せるか（→ docs/spec/quake-spec.md §8「一覧の寄せ方」）。
 *
 * 寄せる量そのものは津波カードの追従と同じ `planFollowScroll` が決める。ここが決めるのは
 * **寄せる相手**と、**いつ寄せ直すか**の 2 つだけ。
 */
import type { JMAQuake } from '../types/earthquake'
import { quakeEventKey } from './quakeMerge'

/**
 * 一覧が寄せる相手のカードを見つけるための印（値は `quakeEventKey`）。**カード（書く側）と
 * 一覧（探す側）の両方がこの定数を通すこと** —— 片方だけ名前を変えると、探しても見つからず
 * 黙って寄らなくなる（型でもテストでも捕まらない）。
 */
export const QUAKE_CARD_KEY_ATTR = 'data-quake-key'

export interface QuakeCardScrollTarget {
  /** 寄せる相手のカードの `quakeEventKey`。 */
  key: string
  /**
   * 寄せ直す合図。**この値が変わったときだけ寄せる。**
   *
   * 利用者がスクロールして読んでいる位置を、関係のない更新（波形が伸びた・別のカードが
   * 増えた）で動かさないため、変わる場面を絞ってある（下の {@link quakeCardScrollTarget}）。
   */
  signature: string
}

export interface QuakeCardScrollInput {
  /** 一覧に並ぶ順のカード。 */
  earthquakes: readonly JMAQuake[]
  /** 選択中のカードの鍵（無ければ null）。 */
  selectedKey: string | null
  /**
   * いま読み上げが語っている地震の鍵（語っていなければ null。語り終わりの残像のあいだも残る）。
   * 取消の読み上げも同じ鍵で来る。
   */
  speakingKey: string | null
  /** 読み上げが有効か。有効なら語っているカードを最優先し、続報の受信では寄せ直さない。 */
  followSpeech: boolean
}

/**
 * 寄せる相手を決める。**読み上げが有効かどうかで、語っているカードを見るかだけが変わる。**
 *
 * 1. （読み上げが有効なときだけ）いま語っているカード（取消の読み上げなら取消カード）。
 *    語っているあいだに続報が届けば（`id` は報ごとに変わる）頭へ揃え直す
 * 2. 取消の表示が出ているカード（いちばん新しく取り消されたもの）。取消になったカードは選択が外れ、
 *    選択は次のカードへ移る（`App.tsx` の選択の導出）。選択中のカードへ寄せると取消カードが
 *    一覧の枠の外へ押し出され、取り消されたことが読めなくなる。取消の表示は 10 秒で消えるので、
 *    その後は 3 へ戻る
 * 3. 選択中のカード
 *
 * **読み上げが有効でも 2 を 1 の後ろに置く。** 選択中のカードそのものが取り消されると、受け取った
 * 瞬間に選択が次のカードへ移り、取消の読み上げは通知音のぶん遅れて始まる。2 が無いと、まず次の
 * カードへ寄り、読み上げが始まって取消カードへ戻る —— 2 度動く。読み終えたあとも取消の表示が
 * 消えるまでは取消カードを見せる（読み上げは 3 秒ほどで終わるが、表示は 10 秒残る）。
 *
 * **3 で選択中のカードへ続報が届いたとき、寄せ直すのは読み上げが無効なときだけ。** 有効なときは
 * 続報は読み上げが始まった時点で 1 で寄る。受信と読み上げの両方で寄せると、間（通知音の長さ）
 * だけずれて 2 度動く。
 */
export function quakeCardScrollTarget(input: QuakeCardScrollInput): QuakeCardScrollTarget | null {
  const { earthquakes, selectedKey, speakingKey, followSpeech } = input
  const find = (key: string) => earthquakes.find(q => quakeEventKey(q) === key)

  if (followSpeech && speakingKey !== null) {
    const speaking = find(speakingKey)
    // 語っている地震のカードが一覧に無いことは正常に起きる（取消カードが片付いた後に
    // 取消を読み上げる等）。そのときは 2・3 へ落ちる。
    if (speaking) return { key: speakingKey, signature: `speaking|${speakingKey}|${speaking.id}` }
  }

  let cancelled: JMAQuake | null = null
  for (const q of earthquakes) {
    if (!q.cancelledAt) continue
    if (cancelled === null || q.cancelledAt.getTime() > cancelled.cancelledAt!.getTime()) cancelled = q
  }
  if (cancelled) {
    const key = quakeEventKey(cancelled)
    return { key, signature: `cancelled|${key}|${cancelled.id}` }
  }

  if (selectedKey === null) return null
  const selected = find(selectedKey)
  if (!selected) return null
  return {
    key: selectedKey,
    signature: followSpeech ? `selected|${selectedKey}` : `selected|${selectedKey}|${selected.id}`,
  }
}
