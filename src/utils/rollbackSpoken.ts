/**
 * 発話が 1 音も鳴らなかったときに、**自分が書いた既読だけ**を元へ戻す。
 *
 * 緊急地震速報の第 1・第 2 フェーズは既読を発話の直前に記録する（予約の時点で記録すると、
 * 取消で捨てられた発話まで既読になるため）。だが発話の直前から先にも失敗はある ——
 * 合成が 1 つも成功しなければ `speakWithVoicevox` は例外を投げずに正常終了し、
 * **1 音も出ていないのに既読だけが進む**（→ `docs/spec/audio-tts-spec.md` §6）。
 *
 * **他が上書きしていたら触らない。** 自分が書いた値のままのときだけ戻す —— 書き込みは別の
 * フェーズからも起こるので、他の発話が声にした事実を消してはならない。
 *
 * **`written` には呼び出しのたびに新しく作られた値を渡すこと**（数値・文字列のような
 * プリミティブは除く）。判定は `Map.get` との同一性比較なので、同じ参照を使い回す実装
 * （値をメモ化して返す関数など）を相手にすると「他が書いた新しい値」と見分けが付かず、
 * 正当な書き込みを消しうる。いまの呼び出し元（`eewMaxScaleInfo` / `eewMaxLpgmClassInfo`）は
 * 毎回オブジェクトリテラルを返す。
 */
export function rollbackSpokenEntry<K, V>(map: Map<K, V>, key: K, written: V, previous: V | undefined) {
  if (map.get(key) !== written) return
  if (previous === undefined) map.delete(key)
  else map.set(key, previous)
}
