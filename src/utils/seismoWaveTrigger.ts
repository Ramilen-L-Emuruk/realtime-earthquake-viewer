// 自作地震計の波形グラフを自動で出すかどうかの判定。
//
// **3 つの経路を or で見る。** 揺れに気づく手段は状況で変わるので、1 つに絞ると
// 出てほしい場面で出ない（行動チェックリストが 3 経路を持つのと同じ理由。ただし
// あちらは「緊急度の順に 1 つ選ぶ」——出す文言が経路で変わるため。こちらは
// 出すか出さないかだけなので選ぶ必要が無い）。
//
//   - **EEW の有感範囲** … 揺れる前。いちばん早い
//   - **強震モニタの検知** … 揺れている最中。直下型では EEW が間に合わない
//   - **自作地震計自身の震度** … 外部の判定に依存しない。**普段の計測震度より
//     はっきり上がったら出す**（`SEISMO_WAVE_USUAL_MARGIN`）。置き場所の静かさで
//     線が動くので、静かな場所では震度1 に届かない揺れも拾い、騒がしい場所では
//     普段の揺れで出っぱなしにならない
//
// **閾値に行動チェックリストの設定（`actionChecklistMinScale`）を流用しない。**
// あちらは「行動を促すべき揺れ」の線引きで、「絵を見たい揺れ」より高いところに
// ある。しかも「出さない」に切り替えられるので、流用すると**あちらを切っている
// 端末で波形の自動表示まで死ぬ**。

import type { EEWAlert } from '../types/earthquake'
import {
  eewScaleForScope,
  kyoshinScaleForScope,
  type NearbyScope,
} from './actionChecklistTrigger'
import type { DetectedPoint } from './kyoshinDetectionView'
import { measuredIntensityToGrade } from './measuredIntensity'

/**
 * 波形グラフの出し方（設定タブ）。
 *
 * **`'auto'` でも購読は張りっぱなしにする。** 揺れを検知してから購読を上げたのでは
 * 間に合わない（繋ぎ直しに数百 ms〜数秒かかり、しかもその時点から 0 秒ぶんしか
 * 波形が無い）。切り替えるのは絵の出し入れだけ（→ `hooks/useSeismoWaveVisibility.ts`）。
 *
 * **定義をここへ置くのは、設定（`hooks/useSettings.ts`）が参照するため。** 設定から
 * 生やすと utils → hooks の向きで参照が要り、依存が逆流する（読み上げの
 * `TtsUnreceivedDetail` を `utils/ttsText.ts` に置いているのと同じ理由）。
 */
export type SeismoWaveMode = 'off' | 'auto' | 'always'

/**
 * 外部の経路（EEW・強震モニタ）で見る最低震度。**震度1。**
 *
 * 絵を見たいだけなので低く取る。これより下げられない理由は
 * `actionChecklistTrigger.ts` の `scanPoints` と同じ —— 強震モニタでは震度0 と
 * 震度1 の階級値が同じ（どちらも 10）なので、震度0 まで通すと平常時のノイズで
 * 出っぱなしになる。
 */
export const WAVE_TRIGGER_MIN_SCALE = 10

/**
 * 自作地震計の震度が普段の計測震度をどれだけ上回ったら出すか。**0.5。**
 *
 * 2026-10-15 ユーザー承認（「＋0.5（推奨）」）。観測点 1 の 2026-10-11〜15（約 4.6 日・
 * ノイズ密度の設定を入れた後）で測った値で、気象庁の地震 23 件のうち普段より上がったのは
 * M3.6 の 1 件（普段 +0.66）だけ。これを拾えるのは
 * 0.5 以下で、そのとき地震以外でも 1 日 2〜3 回ほど出る（0.3 で約 3 回・1.0 で約 1.7 回）。
 * **基板はまだ仮置きなので、本設置の後に測り直す。**
 *
 * 地震カードの `USUAL_MARGIN`（`utils/seismoQuakeReach.ts`）とは別物 —— あちらは予測の下限を
 * 普段から**下げる**余裕、こちらは実測が普段を**上回る**余裕。同じ 0.5 でも向きが逆なので、
 * 片方を動かすときにもう片方を合わせない。
 */
export const SEISMO_WAVE_USUAL_MARGIN = 0.5

/**
 * 普段によらず必ず出す震度の階級（`measuredIntensityToGrade` の `rank`）。**震度3。**
 *
 * 2026-10-15 ユーザー承認（「震度3 以上は必ず出す」）。普段が高い間（置き場所での作業・余震が
 * 続く間）は普段 + 余裕の線も上がるので、それだけだと強い揺れでも出ない —— 2026-10-10 の作業中は
 * 普段が 5.5 まで上がり、震度5 でも出ない状態だった。観測点 1 の 2026-10-11〜15 では、地震以外で
 * 震度3 に届いたのは 2 回。
 */
export const SEISMO_WAVE_ALWAYS_RANK = 3

/**
 * 自作地震計の震度だけを見るための最小の形。
 *
 * **`SeismoStationState` を型として受け取らない。** `utils/` から `hooks/` を
 * 参照する向きを作らないため。ここで要るのは計測震度と普段の計測震度だけ。
 */
export interface SeismoIntensityLike {
  readonly intensity: number | null
  /**
   * 普段の計測震度。**読めない・震度と比べられない（観測点の合成でない）なら `null`**
   * （そのときは震度1 以上で見る）。
   */
  readonly usualMeasured: number | null
}

/**
 * 自作地震計自身が揺れているか。
 *
 * - **震度3 以上なら普段によらず出す**（{@link SEISMO_WAVE_ALWAYS_RANK}）
 * - それより弱ければ、**普段が読めれば「普段 + {@link SEISMO_WAVE_USUAL_MARGIN} を超えたか」、
 *   読めなければ「震度1 以上か」。** 普段が読めない間（ホストの起動直後・古いホスト・測り直しが
 *   止まった）に何も出さない形にすると、その間の揺れを丸ごと見落とす
 *
 * **階級の境目を書き写さない。** `0.5` と直に比べる形にすると、階級表を動かしたときにここだけ
 * 古い境目のまま残る（同じ揺れが画面の場所によって違う階級で出る形の入口）。表は
 * `measuredIntensity.ts` が単一情報源。
 */
function seismoStationShaking(stations: readonly SeismoIntensityLike[]): boolean {
  for (const s of stations) {
    if (s.intensity === null || !Number.isFinite(s.intensity)) continue
    const grade = measuredIntensityToGrade(s.intensity)
    if (grade !== null && grade.rank >= SEISMO_WAVE_ALWAYS_RANK) return true
    if (s.usualMeasured !== null && Number.isFinite(s.usualMeasured)) {
      if (s.intensity > s.usualMeasured + SEISMO_WAVE_USUAL_MARGIN) return true
      continue
    }
    if (grade !== null && grade.rank >= 1) return true
  }
  return false
}

/**
 * いま波形を出すべきか。
 *
 * **これは「いまこの瞬間」だけを見る。** 揺れが収まってから一定時間は出し続ける
 * 余韻の扱いは、状態を持つ側（`useSeismoWaveVisibility`）の担当。
 */
export function seismoWaveTriggered(params: {
  scope: NearbyScope
  eews: readonly EEWAlert[]
  /** 検知エンジンが確定した揺れのメンバー観測点（音・地図の検知点と同じ集合）。 */
  detectedPoints: readonly DetectedPoint[]
  stations: readonly SeismoIntensityLike[]
}): boolean {
  const { scope, eews, detectedPoints, stations } = params
  if (seismoStationShaking(stations)) return true
  for (const eew of eews) {
    // 取り消された報で出さない（行動チェックリストと同じ扱い）。
    if (eew.cancelled) continue
    if (eewScaleForScope(eew, scope, WAVE_TRIGGER_MIN_SCALE) !== null) return true
  }
  return kyoshinScaleForScope(detectedPoints, scope, WAVE_TRIGGER_MIN_SCALE) !== null
}
