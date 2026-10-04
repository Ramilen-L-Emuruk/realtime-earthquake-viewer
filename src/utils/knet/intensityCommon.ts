// 震度の 2 つの計算（`seismicIntensity.ts` の気象庁の手順と、`realtimeIntensity.ts` の
// リアルタイム震度）が共有する、小さな定数と換算。
//
// **FFT を持たないファイルとして分けてある。** `seismicIntensity.ts` は FFT（`fft.ts`）を読み込むので、
// 刻みや 0.3 秒の定数を借りるだけの側（リアルタイム震度・自作地震計のホスト・管理コンソール・
// K-NET 取り込みの配線）がそこを import すると、使わない FFT まで一緒に入る。管理コンソールは
// ブラウザへ配るバンドルなので、実際に FFT 一式（当時は `fft-js`）が載っていた。

/** 継続時間0.3秒基準（気象庁告示式で固定値）。 */
export const DURATION_THRESHOLD_SEC = 0.3

/**
 * 0.3秒の継続時間を測るために見る位置（降順に並べたときの添字）。
 *
 * **ストリーミング処理（`seismo-host/`）が窓の下限を決めるのにも使う単一情報源。**
 * 同じ境界を2つの式で書くと、サンプリング周波数を変えたときに片方だけ古くなる
 * （`0.3 * hz` と書き換えたくなるが、丸めの経路が変わるため式はこのまま保つ）。
 */
export function durationThresholdIndex(sampleRateHz: number): number {
  const dt = 1 / sampleRateHz
  return Math.floor(DURATION_THRESHOLD_SEC / dt) - 1
}

/**
 * 震度を時系列で出すときの刻み（秒）。
 *
 * **取得経路ではなく、計算の側に置く。** K-NET取り込み（`buildEventResultFromZip.ts`）と自作センサーの
 * 受け手（`seismo-host/src/receiver/`）が共有する——どちらの値も最後は同じ画面へ並ぶので、
 * 物差しが違えば「揺れ方の違い」と「測り方の違い」を見分けられない。取得経路のどちらかに
 * 置くともう片方がそこへ引きに行くことになり、Nodeで動く受け手の型検査へブラウザ専用の
 * コードが入り込む。
 *
 * `STEP_SEC_DEFAULT`は`kyoshinLocalArchiveSource.ts`の`getMergedKyoshinArchive`呼び出しにも
 * 使われる——インポート時に刻んだ秒間隔とマージ時に読み出す秒間隔がずれると、`buildEventFrames`
 * （厳密なepoch秒の完全一致ルックアップ、補間なし）が該当秒を「データ無し」とみなし、
 * 震度データが無警告で欠測（-1）扱いに化けるため、必ず同じ定数を使うこと。
 *
 * **時系列の震度そのものは `realtimeIntensity.ts`（強震モニタと同じ方式）が出す。** この
 * ファイルが持つ気象庁の手順は、記録全体へ 1 回当てて「その地震の計測震度」を出す用途。
 */
export const STEP_SEC_DEFAULT = 1

/**
 * 秒をサンプル数へ直す。
 *
 * **バッチ処理（`realtimeIntensity.ts` の `computeRealtimeIntensityTimeSeries`）と、届いたそばから
 * 計算するストリーミング処理（`seismo-host/`）で同じ刻みを返すための単一情報源。** 両者が厳密に
 * 一致することは後者の要件で、その一致は丸め方が揃っていることに依存している。
 */
export function samplesForSeconds(sec: number, sampleRateHz: number): number {
  return Math.round(sec * sampleRateHz)
}

/** ウィンドウを進める幅。0サンプルでは前に進まないので最低1とする。 */
export function stepSamplesForSeconds(sec: number, sampleRateHz: number): number {
  return Math.max(1, samplesForSeconds(sec, sampleRateHz))
}
