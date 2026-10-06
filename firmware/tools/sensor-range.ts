// センサーの品種ごとに「震度いくつからいくつまで測れるか」を出す。
//
// **本番と同じ計測震度の計算を通す。** `I = 2·log10(a) + 0.94` の a はフィルタ後の
// 3 成分合成値で、生の加速度の振幅とは一致しない（周波数ごとに利得が違う）。振幅から
// 直に換算すると、実際より良い数字が出る。
//
// **揺らすのは水平 1 軸だけで、残りの 2 軸は 0 とする。** 品種どうしを同じ条件で並べる
// ため（IIS2ICLX は 2 軸しか無い）。実際の地震では上下動も乗るので、真の震度はこれより
// 高い側に出る ＝ 上限は「少なくともここまで測れる」の側の値。
//
// 使い方（リポジトリのいちばん上で）: npx tsx firmware/tools/sensor-range.ts
//
// 結果と読み方は firmware/README.md「センサーの品種を比べた」。
import { calcSeismicIntensity } from '../../src/utils/knet/seismicIntensity'

/** 標準重力。1 g = 980.665 gal = 1000 mg。 */
const GAL_PER_MG = 0.980665

/** 波形の長さ（秒）。0.3 秒の継続を判定するのに十分な長さを取る。 */
const DURATION_SEC = 20

/** 揺らす周波数。地震動の主な帯（0.1〜10 Hz 前後）を挟んで広めに取る。 */
const FREQS_HZ = [0.2, 0.5, 1, 2, 3, 5, 7, 10, 15, 20, 30, 40]

interface Case {
  readonly label: string
  /** 正弦波の片側振幅（mg）。 */
  readonly amplitudeMg: number
  /** 出力頻度（Hz）。 */
  readonly hz: number
}

/**
 * 測る場合。**数値の出どころ**:
 *
 * - 測定範囲（±2 g・±500 mg）と出力頻度（100 Hz・104 Hz）は、ファームで設定している値
 * - σ は firmware/README.md「センサーの品種を比べた」の実測値
 * - IIS2ICLX の傾き（±500 mg で 65.00 mg、±2 g で 66.08 mg）は、その測定範囲で実測した
 *   2 枚 4 軸の平均のうち絶対値がいちばん大きいもの（その軸は、揺れに使える余地がそのぶん
 *   片側で狭い）。範囲によって少し違う理由は確かめていない
 * - IIS2ICLX の σ は、寝かせた 2 枚の水平 4 軸の中央値のうち最小と最大（測定範囲ごと）
 * - 「立てた軸」は重力 1 g を受ける向きに置いた軸。±2 g でも片側の余地は 1 g しか無い
 */
const CASES: readonly Case[] = [
  { label: 'MPU6050 水平の飽和（±2 g）', amplitudeMg: 2000, hz: 100 },
  { label: 'MPU6050 上下の飽和（重力 1 g を引いた余地）', amplitudeMg: 1000, hz: 100 },
  { label: 'MPU6050 水平 σ×3（σ = 1.04 mg）', amplitudeMg: 1.04 * 3, hz: 100 },
  { label: 'MPU6050 上下 σ×3（σ = 1.53 mg）', amplitudeMg: 1.53 * 3, hz: 100 },
  { label: 'IIS2ICLX ±500 mg の飽和', amplitudeMg: 500, hz: 104 },
  { label: 'IIS2ICLX ±500 mg の飽和（傾き 65.00 mg を引いた余地）', amplitudeMg: 500 - 65.0, hz: 104 },
  { label: 'IIS2ICLX ±500 mg σ×3（σ = 0.102 mg）', amplitudeMg: 0.102 * 3, hz: 104 },
  { label: 'IIS2ICLX ±500 mg σ×3（σ = 0.121 mg）', amplitudeMg: 0.121 * 3, hz: 104 },
  { label: 'IIS2ICLX ±2 g の飽和', amplitudeMg: 2000, hz: 104 },
  { label: 'IIS2ICLX ±2 g の飽和（傾き 66.08 mg を引いた余地）', amplitudeMg: 2000 - 66.08, hz: 104 },
  { label: 'IIS2ICLX ±2 g の立てた軸の飽和（重力 1 g を引いた余地）', amplitudeMg: 1000, hz: 104 },
  { label: 'IIS2ICLX ±2 g σ×3（σ = 0.106 mg）', amplitudeMg: 0.106 * 3, hz: 104 },
  { label: 'IIS2ICLX ±2 g σ×3（σ = 0.123 mg）', amplitudeMg: 0.123 * 3, hz: 104 },
]

function intensityAt(amplitudeMg: number, freqHz: number, hz: number): number | null {
  const gal = amplitudeMg * GAL_PER_MG
  const n = Math.round(DURATION_SEC * hz)
  const zero = new Array<number>(n).fill(0)
  const wave = Array.from({ length: n }, (_, i) => gal * Math.sin(2 * Math.PI * freqHz * (i / hz)))
  return calcSeismicIntensity(wave, zero, zero, hz)
}

for (const c of CASES) {
  let best: { freq: number; value: number } | null = null
  const cells: string[] = []
  for (const f of FREQS_HZ) {
    const value = intensityAt(c.amplitudeMg, f, c.hz)
    cells.push(`${f} Hz: ${value === null ? '—' : value.toFixed(2)}`)
    if (value !== null && (best === null || value > best.value)) best = { freq: f, value }
  }
  console.log(`\n${c.label}（振幅 ${c.amplitudeMg.toFixed(2)} mg・${c.hz} Hz）`)
  console.log(`  ${cells.join('  ')}`)
  console.log(best === null ? '  → 計算できなかった' : `  → 最大 I=${best.value.toFixed(2)}（${best.freq} Hz）`)
}
