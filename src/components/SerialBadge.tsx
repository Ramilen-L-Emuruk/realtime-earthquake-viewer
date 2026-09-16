/**
 * 種別ヘッダーに添える報番号（`#22`）。
 *
 * **緊急地震速報と地震情報カードで同じ見た目にする。** どちらも同じ器（`text-xs font-bold
 * tracking-widest` の種別ヘッダー）に出すもので、番号は種別名より弱い情報なので、余白を
 * 空けて細く薄くする。**別々に書くと片方だけ変わる** —— 実際に地震情報カード側が種別名へ
 * 直付けの太字で出ていて、並べたときに書き方が食い違っていた。
 *
 * **揃えるのは見た目だけ。** 番号が何を数えたものかは出す側で違う（緊急地震速報は電文の
 * 報番号、地震情報カードは受け取った通数）。それぞれの単一情報源は
 * [`docs/spec/eew-spec.md`](../../docs/spec/eew-spec.md) §3 と
 * [`docs/spec/quake-spec.md`](../../docs/spec/quake-spec.md) §8。
 *
 * `serial` は正の整数だけを受ける。出す側が既に絞ってあり（緊急地震速報は `eewSerial`、
 * 地震情報カードは `quakeReportLabels`）、ここでは値を確かめ直さない。
 */
export function SerialBadge({ serial, suffix }: { serial: number; suffix?: string }) {
  return (
    <span className="ml-2 font-normal opacity-75">
      #{serial}{suffix}
    </span>
  )
}
