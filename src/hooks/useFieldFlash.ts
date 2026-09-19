import { useEffect, useState } from 'react'
import { statusOf, type SnapshotValue, type UpdateStatus } from '../utils/updateMark'

/** 欄ごとの減衰の状態。`tick` は要素の `key` に使い、動くたび減衰をやり直させる。 */
export interface FieldFlash {
  tick: number
  status: UpdateStatus
}

/**
 * 「この欄が動いた」を、印を残さずその場の減衰で示すための連番。
 *
 * 緊急地震速報のように**秒の単位で続報が届く**カードでは、印を持続させると次の報が来る前に
 * 消えず、光りっぱなしになって「いま動いた」を指せなくなる（控え 8 日・続報 1,184 通の実測で、
 * 規模は 45.0%・座標は 35.9% の続報で動いていた）。代わりに、動いた瞬間だけ印の色にして
 * そこから元の色へ戻す（`src/index.css` の `update-fade-*`）。
 *
 * 返すのは欄ごとの連番。**要素の `key` に使うと、値が続けて動いたときに減衰がやり直される**
 * （CSS アニメーションは同じ要素のままでは再生し直さない）。
 *
 * **前回値は state で持つ。レンダー中に ref を書き換えない。** React が捨てたレンダーでも
 * ref への書き込みだけは残るので、描き直したときに「変わっていない」と見えて減衰が出ない
 * （このリポジトリで一度踏んでいる罠。jsdom のテストでは再現しない）。
 *
 * @param id 対象の同一性。これが変われば「別のもの」なので、連番を 0 に戻して減衰させない
 *   （初めて見た値は「動いた」ではない）。
 * @param values 欄の名前 → いま表示している値。値を文字列にして渡すこと。
 */
export function useFieldFlash<K extends string>(
  id: string,
  values: Readonly<Record<K, SnapshotValue | undefined>>,
): Readonly<Partial<Record<K, FieldFlash>>> {
  const [seen, setSeen] = useState<{
    id: string
    values: Readonly<Record<string, SnapshotValue | undefined>>
    ticks: Readonly<Record<string, FieldFlash>>
  }>(() => ({ id, values, ticks: {} }))

  // 値をひとつなぎにした署名で走らせる。**欄の値そのものを依存に並べない** ——
  // 欄が増減したときに依存配列の長さが変わり、React が警告のうえで挙動を変える。
  const signature = `${id}\u0000${(Object.keys(values) as K[]).sort().map(k => `${k}=${values[k]?.key ?? ''}`).join('\u0000')}`
  useEffect(() => {
    setSeen(prev => {
      if (prev.id !== id) return { id, values, ticks: {} }
      let changed = false
      const ticks: Record<string, FieldFlash> = { ...prev.ticks }
      for (const key of Object.keys(values) as K[]) {
        const before = prev.values[key]
        const after = values[key]
        if (before?.key === after?.key) continue
        changed = true
        // **初めて現れた欄は動いていない。** 仮定震源要素の報では規模・深さの欄自体が
        // 出ないので、確定してから現れた瞬間に「動いた」として光らせない。
        if (before === undefined || after === undefined) continue
        const status = statusOf(before, after)
        if (!status) continue
        ticks[key] = { tick: (ticks[key]?.tick ?? 0) + 1, status }
      }
      // 何も動いていなければ同じ参照を返す（無駄な再描画を避ける）。
      return changed ? { id, values, ticks } : prev
    })
    // `values` は毎レンダー新しい参照になるので依存に入れない。中身の変化は署名が表す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  return seen.ticks as Readonly<Partial<Record<K, FieldFlash>>>
}
