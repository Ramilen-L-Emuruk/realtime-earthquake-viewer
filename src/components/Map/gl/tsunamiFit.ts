// 津波モードのカメラ追従（TsunamiFitGL）の判定。
//
// 「どこへ寄るか」を決める部分だけを純関数に切り出してある。カメラ操作は副作用が地図の見た目に
// しか現れず、条件の抜けを目視で見つけるのが難しいため、優先順位の取り決めをテストで固定できる形に
// しておく（`utils/tsunami.ts` の isTsunamiNewFire / isTsunamiGradeUpgrade と同じ流儀）。

/** TsunamiFitGL が実行するカメラ操作の種別。 */
export type TsunamiFitAction =
  /** 直前の受信で値が変わった観測点へ寄る。 */
  | 'obs'
  /** 発表中の対象海域（海岸線）全体を収める。 */
  | 'coast'
  /** 日本全体へ帰る。 */
  | 'japan'
  /** 何もしない。 */
  | 'none'

export interface TsunamiFitInput {
  /** 地図が津波モードか。津波以外のモードでは津波側からカメラを動かさない。 */
  isTsunamiMode: boolean
  /** ユーザーが地図を手動操作中か（操作ガード）。 */
  isUserInteracting: boolean
  /** 値が変わった観測点の持ち越しがあるか。 */
  hasPendingObs: boolean
  /** 現在の海岸線 signature（`区域名:等級` の連結。発表中の津波が無ければ空文字）。 */
  signature: string
  /** 最後にカメラへ反映（消費）した海岸線 signature。 */
  lastSignature: string
  /**
   * 海岸線のフィット対象座標があるか（生成データの取得失敗時は false）。
   *
   * signature と同じ `tsunamiLines` から導出されるため、両者は同時に空になる
   * （`useTsunamiLayerData` は海岸線データが無ければ行そのものを作らない）。つまり
   * 「signature が非空なのに寄る先が無い」状態は起きない前提で分岐を並べてある。
   * 導出元を変えるときはこの前提が崩れていないか確かめること。
   */
  hasCoastPositions: boolean
  /** 津波モードへ入った直後の評価か。 */
  enteredTsunamiMode: boolean
  /** 俯瞰へ戻す期限が来ているか（操作ガードの解除・アイドルタイマーの満了）。 */
  isIdleReturnDue: boolean
}

/**
 * 津波モードのカメラ操作を 1 つ選ぶ。上から順に評価し、最初に当たったものを返す。
 *
 * 観測点を海岸線より優先するのは、観測情報は「今どこで津波が観測されたか」という速報性のある
 * 変化で、対象海域の俯瞰はその背景に当たるため。俯瞰へはアイドル復帰の経路で帰る。
 */
export function decideTsunamiFit(input: TsunamiFitInput): TsunamiFitAction {
  if (!input.isTsunamiMode) return 'none'
  // 手動操作中は自動追従を止める。持ち越し（hasPendingObs・isIdleReturnDue）は呼び出し側が
  // 保持し続けるため、ガードが解けた評価で改めてここへ流れてくる。
  if (input.isUserInteracting) return 'none'
  if (input.hasPendingObs) return 'obs'
  // 区域・等級が変わったとき（新規発表・格上げ・区域追加）は対象海域を出し直す。
  if (input.signature && input.signature !== input.lastSignature && input.hasCoastPositions) return 'coast'
  // 発表中だった津波が消えた（解除表示の 10 秒後の purge・有効期間の満了）。寄ったままにせず帰る。
  if (!input.signature && input.lastSignature) return 'japan'
  // 入室時・アイドル復帰時は俯瞰へ。海岸線が引けない場合（生成データの取得失敗）は日本全体で代替する。
  if (input.enteredTsunamiMode || input.isIdleReturnDue) return input.hasCoastPositions ? 'coast' : 'japan'
  return 'none'
}
