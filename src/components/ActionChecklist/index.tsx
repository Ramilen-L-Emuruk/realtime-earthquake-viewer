// 地震の直後に出す行動チェックリスト。
//
// 【なぜ画面の上に出すか】下端は特別情報バナー（`SpecialInfoBanner`）が使っており、あちらは
// `:last-child` で下端の余白を付けているため子を足せない。加えてこれは「いま動くための情報」で、
// 揺れの最中に届くこともある。目に入る位置を優先して上端へ置く。左上の更新バッジと重ならない
// よう、その下から始める。
//
// 【畳んだ状態で 3 つだけ見せる】揺れた直後に読めるのはせいぜいそのくらい。残りは開いてもらう。

import { useState } from 'react'
import {
  IMMEDIATE_ACTIONS,
  EMERGENCY_KIT,
  CHECKLIST_SOURCES,
  COLLAPSED_ACTION_COUNT,
} from '../../utils/actionChecklist'
import { getIntensityLabel } from '../../utils/intensity'

/** どの経路で出たか。文言を変えるために持つ。 */
export type ChecklistReason = 'eew' | 'kyoshin' | 'quake'

interface Props {
  reason: ChecklistReason
  /** 判定のもとになった震度階級（気象庁の値）。 */
  scale: number
  /**
   * ホーム地点の周りで判定したか。false なら全国基準（地点が未登録・近くに観測点なし）。
   *
   * **見出しの言い回しを選ぶためだけに使う。** 判定の根拠そのものは画面に出さない
   * （揺れた直後に読むのは行動だけでよい）。
   */
  scoped: boolean
  /** 畳んでいるか。true なら小さなボタンだけを出す。 */
  collapsed: boolean
  onDismiss: () => void
  onRestore: () => void
}

/**
 * 見出し。**EEW だけ地点の有無で言い分ける。**
 *
 * 「来ます」は読み手のところへ揺れが向かうという意味になるため、全国のどこかで予想が出ている
 * だけの状態で使うと嘘になる。一方「観測しています」「ありました」は場所を主張しない事実の
 * 記述なので、地点が無くてもそのまま成り立つ。
 */
const HEADLINE: Record<ChecklistReason, { scoped: string; global: string }> = {
  eew: { scoped: '強い揺れが来ます', global: '強い揺れが予想されています' },
  kyoshin: { scoped: '強い揺れを観測しています', global: '強い揺れを観測しています' },
  quake: { scoped: '強い揺れがありました', global: '強い揺れがありました' },
}

/**
 * 帯と畳んだボタンで共有する外枠。
 *
 * z-[99999]: 区域集約震度バッジが scale×1000（最大 70000）まで積むため、それより高くして最前面に出す。
 */
const WRAPPER_CLASS =
  'absolute top-12 left-0 right-0 z-[99999] pointer-events-none px-2 flex justify-center'

function CloseIcon() {
  return (
    <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
    </svg>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`w-4 h-4 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    >
      <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 畳んだボタンの目印。チェックの付いた紙で「読むもの」だと分かるようにする。 */
function ChecklistIcon() {
  return (
    <svg className="w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2" strokeLinecap="round" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <path d="M9 14l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function ActionChecklist({ reason, scale, scoped, collapsed, onDismiss, onRestore }: Props) {
  const [open, setOpen] = useState(false)
  const [kitOpen, setKitOpen] = useState(false)

  const shown = open ? IMMEDIATE_ACTIONS : IMMEDIATE_ACTIONS.slice(0, COLLAPSED_ACTION_COUNT)
  const label = getIntensityLabel(scale)

  // 畳んだ状態。**消さずにボタンを残す** —— 余震のたびに帯が出直すのは邪魔だが、読み返したく
  // なることはある。震度を添えるのは、畳んでいる間に届いた揺れの大きさが分かるようにするため。
  if (collapsed) {
    return (
      <div className={WRAPPER_CLASS}>
        <button
          className="pointer-events-auto flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-950/90 border border-red-400/80 shadow-lg text-white/90 hover:text-white hover:bg-red-900/90"
          onClick={onRestore}
          aria-label={`震度${label}の行動チェックリストを開く`}
        >
          <ChecklistIcon />
          <span className="text-xs font-bold whitespace-nowrap">震度{label} 行動チェック</span>
        </button>
      </div>
    )
  }

  return (
    <div className={WRAPPER_CLASS}>
      {/* w-fit で中身の幅に合わせる。畳んだ状態は 3 行しかないので、固定幅にすると横に間延びして
          地図を無駄に覆う。展開すれば中身が増えて自然に広がり、max-w-2xl で頭打ちにする。 */}
      <div className="pointer-events-auto w-fit max-w-2xl max-h-[70dvh] overflow-y-auto overflow-x-hidden overscroll-x-none rounded-lg bg-red-950/95 border-2 border-red-400 shadow-lg">
        <div className="px-3 py-2 flex items-start gap-2">
          {/* 判定の根拠（全国基準か周辺基準か）はここに書かない。揺れた直後に読むのは行動だけで、
              仕組みの説明は要らない。その説明は設定タブの「出す最低震度」の項目に置いてある。 */}
          <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
            <span className="text-xs font-bold text-white px-1.5 py-0.5 rounded bg-red-500 flex-shrink-0">
              震度{label}
            </span>
            <span className="text-white text-sm font-bold leading-tight">
              {scoped ? HEADLINE[reason].scoped : HEADLINE[reason].global}
            </span>
          </div>
          <button
            className="text-white/70 hover:text-white p-1 -m-1 flex-shrink-0"
            onClick={onDismiss}
            aria-label="チェックリストを閉じる"
          >
            <CloseIcon />
          </button>
        </div>

        <ol className="px-3 pb-1 space-y-1.5">
          {shown.map((item, i) => (
            <li key={item.text} className="flex gap-2">
              <span className="text-red-300 text-sm font-bold flex-shrink-0 tabular-nums">{i + 1}.</span>
              <div className="min-w-0">
                <p className="text-white text-sm font-bold leading-tight">{item.text}</p>
                {item.detail && open && (
                  <p className="text-white/70 text-xs leading-relaxed mt-0.5">{item.detail}</p>
                )}
              </div>
            </li>
          ))}
        </ol>

        <button
          className="w-full px-3 py-1.5 flex items-center justify-center gap-1 text-white/80 hover:text-white text-xs"
          onClick={() => setOpen(v => !v)}
        >
          {open ? '閉じる' : `続きを見る（全 ${IMMEDIATE_ACTIONS.length} 項目）`}
          <ChevronIcon open={open} />
        </button>

        {open && (
          <div className="px-3 pb-2">
            <button
              className="w-full py-1.5 flex items-center justify-between gap-2 text-left border-t border-red-400/40"
              onClick={() => setKitOpen(v => !v)}
            >
              <span className="text-white text-sm font-bold">避難するとき持ち出すもの</span>
              <ChevronIcon open={kitOpen} />
            </button>
            {kitOpen && (
              <div className="space-y-1.5 pb-1">
                <p className="text-white/70 text-xs leading-relaxed">
                  両手が空くリュックにまとめ、軽くコンパクトに。持病の薬・杖・乳幼児用品など、
                  必要なものは各自で足してください。
                </p>
                {EMERGENCY_KIT.map(group => (
                  <div key={group.label}>
                    <p className="text-red-300 text-xs font-bold">{group.label}</p>
                    <p className="text-white/90 text-xs leading-relaxed">{group.items.join('・')}</p>
                  </div>
                ))}
              </div>
            )}
            <p className="text-white/50 text-xs leading-relaxed border-t border-red-400/40 pt-1.5 mt-1">
              出典:{' '}
              {CHECKLIST_SOURCES.map((s, i) => (
                <span key={s.url}>
                  {i > 0 && '／'}
                  <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline hover:text-white/80">
                    {s.label}
                  </a>
                </span>
              ))}
              。実際の避難は気象庁・自治体の指示に従ってください。
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
