/**
 * その緊急地震速報について「まだ声にする予定が残っているか」を数える材料。
 *
 * **`useLiveEventHandler` が持つ予約の参照をそのまま渡す。** 値の型は問わない（在るかどうか
 * しか見ない）ので、トークン・タイマー・安定待ちサイクルが混ざっていてよい。
 *
 * **項目を増やすときはここへ足すこと。** 詳細は `audio-tts-spec.md` §6
 * 「読み上げに合わせて緊急地震速報のカードを示す」を参照。
 */
export interface EewPendingSpeechSources {
  /** 第 1 フェーズ（名乗り・震源の言い直し）の予約 */
  phase1: ReadonlyMap<string, unknown>
  /** 第 1.5 フェーズ（警報の対象地方）の予約 */
  warningRegions: ReadonlyMap<string, unknown>
  /** 第 2 フェーズ（予想値）の予約 */
  phase2: ReadonlyMap<string, unknown>
  /** 震度の安定待ち（確定すると第 2 フェーズが積まれる） */
  scaleStability: ReadonlyMap<string, unknown>
  /** 長周期地震動階級の安定待ち（同上） */
  lpgmStability: ReadonlyMap<string, unknown>
  /** 予想震度がまだ付かず、付くのを上限まで待っている */
  forecastMaxWait: ReadonlyMap<string, unknown>
  /**
   * 誤報取消の読み上げの予約。**これだけ形が違う** —— 他の 5 つは発話の直前に自分を
   * 取り下げるトークンだが、取消は間（`ttsDelayFor('eewCancel')`）を置いてから
   * チェーンへ積まれる一回性の予約なので、専用の集合で覚える。
   */
  cancelSpeech: ReadonlySet<string>
}

/**
 * その緊急地震速報について、**まだ声にする予定が残っているか**（`eewEventKey` 単位）。
 *
 * 「いま声が語っているカード」の印を、段と段のあいだも保つための判定。読み上げは名乗り →
 * （警報級なら警報の対象地方 →）予想値と段が分かれ、段のあいだには安定待ち（最大
 * `EEW_PHASE2_STABILITY_MAX_WAIT_MS`）が挟まる —— **その待ちを時間の猶予で代用しない**。
 * 猶予を超えれば読み上げの途中で印が消え、語り終われば猶予のぶん余計に残る（両方向にずれる）。
 *
 * **key 単位でなければならない。** `speechBlocker` も似た判定を持つが、あちらは「いま非 EEW を
 * 始めてよいか」を全 EEW 横断（`.size > 0`）で見るもの。混ぜると、語り終わった地震の印が
 * **別の地震の待ちが明けるまで**消えない。
 *
 * **自分自身の発話は数に入らない。** 各フェーズの予約トークンは `speak()` の中、つまり印を
 * 立てる（`begin`）より手前で自分を取り下げる。ここで真になるのは「**次に**語る予定」だけ。
 */
export function hasPendingEewSpeech(key: string, sources: EewPendingSpeechSources): boolean {
  return sources.phase1.has(key)
    || sources.warningRegions.has(key)
    || sources.phase2.has(key)
    || sources.scaleStability.has(key)
    || sources.lpgmStability.has(key)
    || sources.forecastMaxWait.has(key)
    || sources.cancelSpeech.has(key)
}
