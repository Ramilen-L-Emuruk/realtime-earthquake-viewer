import { useEffect, useState } from 'react'

/**
 * ページ（ブラウザのタブ・ウィンドウ）が表示されているかを返す。裏に回っている間は false。
 *
 * 「ユーザーの目に入っているか」で挙動を変えたい表示に使う。アプリ内のどのタブを開いて
 * いるかは App が持つ状態（`activeTab` / `panelCollapsed`）で判るが、ブラウザのタブを別へ
 * 移した・ウィンドウを最小化した状態はそれでは判らないため、こちらで補う。
 *
 * 初期値を `visibilityState` から取るのは、裏に回っている間に mount されうるため
 * （このアプリのタブは常時マウントで、表示されていなくても描画は走る）。
 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')

  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onChange)
    // 購読を張るまでの間に変わっていることがあるため、初回に 1 度だけ合わせる。
    onChange()
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])

  return visible
}
