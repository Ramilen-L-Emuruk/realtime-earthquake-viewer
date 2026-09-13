import type { JMAEarthquakeCount, JMAEarthquakeCountItem } from '../../types/earthquake'

/**
 * 地震回数に関する情報（VXSE60）の帯を開いたときの中身。
 *
 * 他の帯は本文が自由文ひとつきりなので `EarthquakeInfoDetail` にまとめてあるが、こちらは
 * **区間ごとの回数を表で出す**ため別に持つ。
 *
 * **取消しの理由（`cancelText`）は描かない。** `applyEarthquakeCount` は取消が自分の群発に
 * 一致すれば帯ごと消し、一致しなければ表示中の帯をそのまま残す —— どちらの道でも取消の報が
 * ここへ渡ることはない。理由が届く先は読み上げだけ（`ttsText.ts` の `earthquakeCountToText`）で、
 * お知らせ（VZSE40）も同じ構造（→ `docs/spec/data-sources-spec.md` §2）。
 * 防御のつもりで分岐を置くと、次に触る人へ「取消も描ける」という誤った保証を与える
 * （下の `earthquakeCountHeadline` と同じ理由）。
 */
const fmt = new Intl.DateTimeFormat('ja-JP', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
})
const fmtTimeOnly = new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit' })

/**
 * 区間の期間を「9/10 15:00〜16:00」の形にする。
 *
 * 同じ日に収まる区間では終わりの日付を省く。1 時間区間が縦に並ぶため、毎行に日付を書くと
 * 数字ばかりになって回数のほうが読み取りにくくなる。**日をまたぐ区間では省かない** ——
 * 累積区間は初めの地震から現在までを指すので、何日ぶんの数字かが分からなくなる。
 */
function formatSpan(startTime: string, endTime: string): string {
  const start = new Date(startTime)
  const end = new Date(endTime)
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    // **電文に入っていた文字列はここへ届かない。** 読み取りの時点で捨てて記録に残す作りに
    // なっている（`dmdataParser.ts` の `readTelegramDateTime`）ので、ここへ来るのは空文字だけ。
    // 生の値を出していた頃の名残で `${startTime}〜${endTime}` と書くと、区切りの「〜」だけが
    // 並んで値を読み落としたように見える。**原因はコンソールの
    // `[dmdata XML] 地震回数の区間の…` を見ること。**
    //
    // **片方だけ読めても期間としては出さない。** 端が 1 つでは何日ぶんの数字か決まらず、
    // 読める側だけを出すと区間が確定しているように見える（読み上げ側が同じ場面で
    // 「これまで」へ落とすのと揃えてある）。
    return '期間不明'
  }
  const sameDay = start.getFullYear() === end.getFullYear()
    && start.getMonth() === end.getMonth()
    && start.getDate() === end.getDate()
  return `${fmt.format(start)}〜${sameDay ? fmtTimeOnly.format(end) : fmt.format(end)}`
}

/**
 * 累積の区間。**畳んだ見出しと開いた表で同じものを指す**ので、判定はここに 1 つだけ置く。
 *
 * **`type` の語で判定する** —— 並び順（最後が累積）は電文の書き方にすぎず、`type` のほうが
 * 電文自身の宣言。
 */
export function cumulativeItem(count: JMAEarthquakeCount): JMAEarthquakeCountItem | undefined {
  return count.items.find(it => it.type.includes('累積'))
}

/**
 * 畳んだ帯に出す一行。
 *
 * **電文の見出し（`Head/Headline/Text`）は使わない** —— 「地震回数に関する情報をお知らせします。」
 * という中身の無い定型文で、畳んだままでは何も伝わらない。累積の区間から数字を組む。
 *
 * 累積が読めなければ種別名だけを返す（部分の区間の数字を総数のように見せない）。
 *
 * **取消の分岐は持たない。** 取消が自分の群発に一致すれば `applyEarthquakeCount` が帯ごと消し、
 * 一致しなければ表示中の帯はそのまま残る —— どちらの道でも取消の報がここへ渡ることはない。
 * 防御のつもりで分岐を置くと、次に触る人へ「取消も描ける」という誤った保証を与える。
 */
export function earthquakeCountHeadline(count: JMAEarthquakeCount): string {
  const total = cumulativeItem(count)
  if (!total) return '地震回数に関する情報'
  const start = new Date(total.startTime)
  const since = Number.isFinite(start.getTime())
    ? `${start.getMonth() + 1}/${start.getDate()} ${String(start.getHours()).padStart(2, '0')}時から `
    : ''
  return `${since}${total.number.toLocaleString('ja-JP')}回（うち有感 ${total.feltNumber.toLocaleString('ja-JP')}回）`
}

export function EarthquakeCountDetail({ count }: { count: JMAEarthquakeCount }) {
  return (
    <div className="px-3 pb-2">
      {count.freeText && (
        <p className="text-white/90 text-xs leading-relaxed whitespace-pre-wrap mb-2">{count.freeText}</p>
      )}

      {count.items.length > 0 && (
        // 幅が足りないときは表だけ横に流す（帯ごと横スクロールさせない）
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="text-white/60">
                <th className="text-left font-normal py-0.5 pr-2 whitespace-nowrap">区間</th>
                <th className="text-left font-normal py-0.5 pr-2 whitespace-nowrap">期間</th>
                <th className="text-right font-normal py-0.5 pr-2 whitespace-nowrap">回数</th>
                {/* 「有感」だけでは何を数えた列か初見で伝わらないので、表の下に一言添える */}
                <th className="text-right font-normal py-0.5 whitespace-nowrap">うち有感</th>
              </tr>
            </thead>
            <tbody>
              {count.items.map((item, i) => (
                <tr
                  // 同じ `type` の区間が並ぶうえ、続報では区間そのものが入れ替わる。位置で
                  // 引くのが素直で、行に状態も持たせていない。
                  key={i}
                  // 累積の行だけ地の色を変えて区切る。電文は「区間ごとの回数」と「初めからの累計」を
                  // 同じ `Item` の並びで送ってくるので、見た目を揃えると 1 時間の 47 回と累計の
                  // 1704 回が同じ重みで並んでしまう。
                  className={`border-t border-white/15 ${item.type.includes('累積') ? 'bg-white/10 font-bold' : ''}`}
                >
                  {/* 電文の語（「１時間地震回数」等）をそのまま出す。言い換えると、
                      気象庁が区間をどう区切ったかが伝わらなくなる */}
                  <td className="py-0.5 pr-2 text-white whitespace-nowrap">{item.type}</td>
                  <td className="py-0.5 pr-2 text-white/70 whitespace-nowrap">
                    {formatSpan(item.startTime, item.endTime)}
                  </td>
                  <td className="py-0.5 pr-2 text-white text-right tabular-nums whitespace-nowrap">
                    {item.number.toLocaleString('ja-JP')}
                  </td>
                  <td className="py-0.5 text-white text-right tabular-nums whitespace-nowrap">
                    {item.feltNumber.toLocaleString('ja-JP')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-white/60 text-[0.6875rem] mt-1">「うち有感」は震度1以上を観測した地震の数</p>
        </div>
      )}

      {count.nextAdvisory && (
        <p className="text-white/90 text-xs leading-relaxed whitespace-pre-wrap mt-2">{count.nextAdvisory}</p>
      )}
    </div>
  )
}
