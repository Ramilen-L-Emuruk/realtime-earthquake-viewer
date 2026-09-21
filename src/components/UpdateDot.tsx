import { UPDATE_MARK_COLOR, UPDATE_MARK_TITLE, type UpdateStatus } from '../utils/updateMark'

/**
 * 「この報で動いた」を示す肩の印。**値の右上に小さな点を置く。**
 *
 * **文字色も器の色も触らない。** 印の当たり先を文字色にすると、色に意味がある文字
 * （津波区分＝区分の色・津波の波高＝等級の色）には当てられず、そこだけ別の表し方に
 * なる。点なら同じ印を全部の欄・全部の項目へ置ける。
 *
 * **使うのは地震カードの欄（震源要素・最大震度）。** 津波カードの観測点の行は文字色で示す ——
 * あちらは 1 行に時刻と波高が並ぶだけで、動いた項目を直接塗るほうが指しやすい。**色の語彙
 * （{@link UPDATE_MARK_COLOR}）はどちらも共有する。** 行の左端の縦線は別の役目（「この行で
 * 何かあった」）なのでそのまま残る。
 */
export function UpdateDot({ status, size = 'md', className = '' }: {
  status: UpdateStatus
  /**
   * 点の大きさ。**隣の値の大きさに合わせる** —— 同じ寸法で置くと、大きい数字の脇では
   * 埃のように見え、小さい文字の脇では値より目立つ。
   *
   * - `lg` … 最大震度のような大きく出す値
   * - `md` … 震央地名・規模・深さ
   * - `sm` … 補助的な小さい文字（座標・観測点の行）
   */
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  // **rem で書く。** 表示倍率の設定は UI 全体を rem で拡縮する（→ `settings-pwa-spec.md` §2）。
  const px = size === 'lg' ? '0.625rem' : size === 'sm' ? '0.375rem' : '0.5rem'
  return (
    <span
      role="img"
      aria-label={UPDATE_MARK_TITLE[status]}
      title={UPDATE_MARK_TITLE[status]}
      className={`inline-block shrink-0 rounded-full ${className}`}
      style={{ width: px, height: px, backgroundColor: UPDATE_MARK_COLOR[status] }}
    />
  )
}
