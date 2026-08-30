// オン・オフのつまみ。設定タブと震源カタログタブで共有する。
//
// `role="switch"` と `aria-checked` を持つので、読み上げには「オン／オフ」として伝わる。

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  /** 読み上げ用の名前。行のラベルが別にあるなら省略してよい。 */
  label?: string
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`
        relative inline-flex h-6 w-11 items-center rounded-full transition-colors
        ${checked ? 'bg-blue-500' : 'bg-border'}
      `}
    >
      <span
        className={`
          inline-block h-4 w-4 rounded-full bg-white shadow transition-transform
          ${checked ? 'translate-x-6' : 'translate-x-1'}
        `}
      />
    </button>
  )
}
