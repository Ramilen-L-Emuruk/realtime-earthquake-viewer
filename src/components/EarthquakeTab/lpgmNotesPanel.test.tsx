// @vitest-environment jsdom
//
// 長周期地震動に添える気象庁からの補足の折りたたみ（→ docs/spec/quake-spec.md §8
// 「気象庁からの補足は畳んで置く」）を固定する。
//
// **描いてみないと確かめられないものばかり。** 見出しを出す条件・既定で畳んでいること・
// `categoryNote` だけが折りたたみの外に残ること。どれも型検査を素通りするうえ、
// 壊れても例外は出ず「画面に出ない」という形でしか現れない。
//
// **ここで捕まえられないもの。** 畳んだことで主要な情報がどれだけ画面に戻るか（実測値）は
// jsdom では測れない（要素の高さが 0 になる）。押し下げ量の確認は実機で行う。
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { EarthquakeTab } from './index'
import { quakeEventKey } from '../../utils/quakeMerge'
import { telegramTextSubject } from '../../utils/ttsFollow'
import type { JMAQuake, JMALpgm } from '../../types/earthquake'
import { createEmptyTelegramLoss } from '../../utils/telegramLoss'

afterEach(cleanup)

// jsdom は `scrollIntoView` を持たない。選択中のカードは描画後に自分を画面内へ寄せるので、
// 何もしない実装を置いて描画だけ通す（寄せる動きはこのテストの対象ではない）。
HTMLElement.prototype.scrollIntoView = () => {}

const EVENT_ID = '20240101161000'

// 折りたたみの外に残る一文（`category` 2・4 のときだけ出る → `lpgmCategoryNote`）。
const CATEGORY_NOTE = '震度が小さくても高層階が大きく揺れた地域があります'
// 実電文（2024-01-01 能登半島地震の本震・VXSE62）の固定付加文と自由付加文の冒頭。
const FORECAST_TEXT = 'この地震について、緊急地震速報を発表しています。'
const FREE_FORM_HEAD = '各長周期地震動階級に対する簡易な現象表現'
const URI = 'https://www.data.jma.go.jp/eew/data/ltpgm/event.php?eventId=20240101161010'
const URI_LABEL = '気象庁の詳細ページ（波形・スペクトル）'
// 固定付加文（その他）。**ここで確かめるのは表示の経路であって文面ではない**ので、
// 地震情報側の実電文にある「震源要素を訂正します。」（0256）を借りる。長周期に付く
// `VarComment` の実電文は `＊` 印の説明（0263）が主。
const VAR_COMMENT_TEXT = '震源要素を訂正します。'

const QUAKE: JMAQuake = {
  kind: 'quake',
  id: `dmdata-quake-${EVENT_ID}-1`,
  eventId: EVENT_ID,
  time: '2024-01-01T07:24:00Z',
  issue: { source: 'テスト', time: '2024-01-01T07:24:00Z', type: '震源・震度情報', correct: 'なし' },
  earthquake: {
    time: '2024-01-01T07:10:00Z',
    hypocenter: { name: '石川県能登地方', latitude: 37.495, longitude: 137.27, depth: 16, magnitude: 7.6 },
    maxScale: 70,
    domesticTsunami: '警報等',
  },
  points: [],
}

function makeLpgm(overrides: Partial<JMALpgm> = {}): JMALpgm {
  return {
    id: `test-lpgm-${EVENT_ID}`,
    eventId: EVENT_ID,
    time: '2024-01-01T07:23:00Z',
    originTime: '2024-01-01T07:10:00Z',
    maxClass: 4,
    cancelled: false,
    category: 4,
    forecastText: FORECAST_TEXT,
    varCommentText: VAR_COMMENT_TEXT,
    freeFormText: `${FREE_FORM_HEAD}\n 階級１やや大きな揺れ`,
    uri: URI,
    ...overrides,
  }
}

/** 畳む対象を 1 つも持たない電文。1 項目ずつ足して確かめるときの土台。 */
const NO_NOTES = { forecastText: undefined, varCommentText: undefined, freeFormText: undefined, uri: undefined } as const

const renderTab = (lpgm: JMALpgm) => render(
  <EarthquakeTab
    earthquakes={[QUAKE]}
    selectedId={quakeEventKey(QUAKE)}
    onSelect={() => {}}
    isLoading={false}
    isLoadingMore={false}
    hasMore={false}
    onLoadMore={() => {}}
    error={null}
    historyLoss={createEmptyTelegramLoss()}
    loadMoreFailed={false}
    fetchThrottled={false}
    lpgmByEventId={new Map([[EVENT_ID, lpgm]])}
    updateMarks={new Map()}
    activeLpgmEventId={null}
    onToggleLpgm={() => {}}
    estimatedIntensity={null}
    distributionQuakeKey={null}
    onToggleDistribution={() => {}}
    unreceivedQuakeKey={null}
    onToggleUnreceived={() => {}}
    onFocusMap={() => {}}
    speakingTelegramTextSubject={null}
  />
)

/** 読み上げの主題を渡せる版（自動展開の確認用）。**`rerender` へ渡せるよう JSX を返す。** */
const tabWith = (subject: string | null, lpgm: JMALpgm = makeLpgm()) => (
  <EarthquakeTab
    earthquakes={[QUAKE]}
    selectedId={quakeEventKey(QUAKE)}
    onSelect={() => {}}
    isLoading={false}
    isLoadingMore={false}
    hasMore={false}
    onLoadMore={() => {}}
    error={null}
    historyLoss={createEmptyTelegramLoss()}
    loadMoreFailed={false}
    fetchThrottled={false}
    lpgmByEventId={new Map([[EVENT_ID, lpgm]])}
    updateMarks={new Map()}
    activeLpgmEventId={null}
    onToggleLpgm={() => {}}
    estimatedIntensity={null}
    distributionQuakeKey={null}
    onToggleDistribution={() => {}}
    unreceivedQuakeKey={null}
    onToggleUnreceived={() => {}}
    onFocusMap={() => {}}
    speakingTelegramTextSubject={subject}
  />
)
const renderSpeaking = (subject: string | null, lpgm: JMALpgm = makeLpgm()) =>
  render(tabWith(subject, lpgm))

/** この地震の長周期を読み上げている主題。 */
const SPEAKING = telegramTextSubject('lpgm', EVENT_ID)

// **カード自体も `<button>`** で、そのアクセシブルネーム（カード全体の文字列）にも
// 「気象庁からの補足」が含まれる。見出しだけを取るため、矢印まで込みの完全一致で絞る。
const HEADER_NAME = /^気象庁からの補足\s*[▸▾]$/
const notesHeader = () => screen.getByRole('button', { name: HEADER_NAME })

describe('長周期地震動の「気象庁からの補足」の折りたたみ', () => {
  // 正: 見出しが出て、中身は押すまで出ない。
  it('既定では畳んでおり、見出しを押すと付加文と詳細ページが出る', () => {
    renderTab(makeLpgm())

    const header = notesHeader()
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(FORECAST_TEXT)).toBeNull()
    expect(screen.queryByText(VAR_COMMENT_TEXT)).toBeNull()
    expect(screen.queryByText(new RegExp(FREE_FORM_HEAD))).toBeNull()
    expect(screen.queryByText(URI_LABEL)).toBeNull()

    fireEvent.click(header)

    expect(notesHeader().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText(FORECAST_TEXT)).toBeTruthy()
    expect(screen.getByText(VAR_COMMENT_TEXT)).toBeTruthy()
    expect(screen.getByText(new RegExp(FREE_FORM_HEAD))).toBeTruthy()
    expect(screen.getByText(URI_LABEL)).toBeTruthy()
  })

  // 対照: 中身が 1 つも無ければ見出し自体を出さない。
  // 押せる見た目だけ与えると、開いても何も出ない理由が利用者に分からない。
  //
  // **この 1 件だけは折りたたみを入れる前でも通る**（見出しという概念が無いため）。
  // 役目は将来 `hasLpgmNotes` の条件を緩めたときに落ちること。他の 4 件は実装を
  // 変更前へ戻すと落ちることを確認済み。
  it('付加文も詳細ページも無ければ見出しを出さない', () => {
    renderTab(makeLpgm(NO_NOTES))

    expect(screen.queryByRole('button', { name: HEADER_NAME })).toBeNull()
    // 階級のバッジ自体は出ている（折りたたみが無いだけで、長周期の表示は生きている）
    expect(screen.getByText('階級4')).toBeTruthy()
  })

  // 安全弁: アプリが組む一文は折りたたみへ巻き込まない。
  // 1 行しかないうえ、その地震でしか言えない事実なので常に見えていること。
  it('観測情報の種類から出す一文は、畳んでいても開いていても出る', () => {
    renderTab(makeLpgm())

    expect(screen.getByText(CATEGORY_NOTE)).toBeTruthy()
    fireEvent.click(notesHeader())
    expect(screen.getByText(CATEGORY_NOTE)).toBeTruthy()
  })

  // 安全弁: 中身が 4 つ揃っていなくても、1 つでもあれば入口を出す。
  //
  // **4 項目を 1 つずつ確かめる。** まとめて渡すテストだけでは、`hasLpgmNotes` の OR から
  // どれか 1 項目を落とす退行を捕まえられない（残り 3 つで見出しが出てしまう）。
  // **テストボタンのデータは `varCommentText` を持たない**ので、ここで足さないとその行は
  // 一度も評価されない（実電文では `＊` 印の説明（0263）が常時入る）。
  it.each([
    ['固定付加文', { forecastText: FORECAST_TEXT }, FORECAST_TEXT],
    ['固定付加文（その他）', { varCommentText: VAR_COMMENT_TEXT }, VAR_COMMENT_TEXT],
    ['自由付加文', { freeFormText: FREE_FORM_HEAD }, FREE_FORM_HEAD],
    ['詳細ページ', { uri: URI }, URI_LABEL],
  ])('%s だけを持つ電文でも見出しを出し、押すとその 1 つが出る', (_name, only, shown) => {
    renderTab(makeLpgm({ ...NO_NOTES, ...only }))

    // 押すまでは出ない
    expect(screen.queryByText(shown)).toBeNull()

    fireEvent.click(notesHeader())

    expect(screen.getByText(shown)).toBeTruthy()
  })

  // 開いた状態から閉じられること（`toggle` は既存の `expanded` Set を共有しており、
  // 鍵を取り違えると開きっぱなしになる）。
  it('もう一度押すと畳む', () => {
    renderTab(makeLpgm())

    fireEvent.click(notesHeader())
    expect(screen.getByText(FORECAST_TEXT)).toBeTruthy()

    fireEvent.click(notesHeader())
    expect(notesHeader().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText(FORECAST_TEXT)).toBeNull()
  })
})

// 読み上げに合わせた自動展開（→ docs/spec/audio-tts-spec.md §6「読み上げに合わせて気象庁の文を開く」）。
//
// **長周期はこの仕組みから漏れていた。** 「地震情報と同じで付加文は畳んでいない」と扱って
// 対象から外していたが、実際にはこの補足として畳んであり、中身は読み上げる 3 ブロックそのもの。
// 声だけが本文を伝えて画面は見出しのまま、という状態が残っていた。
describe('読み上げに合わせて補足を開く', () => {
  // 正: 読み始めで開き、読み終わりで閉じる
  it('読み始めで開き、読み終わりで閉じる', () => {
    const { container, rerender } = renderSpeaking(null)
    expect(container.textContent).not.toContain(FORECAST_TEXT)

    rerender(tabWith(SPEAKING))
    expect(container.textContent).toContain(FORECAST_TEXT)

    rerender(tabWith(null))
    expect(container.textContent).not.toContain(FORECAST_TEXT)
  })

  // 安全弁: **手で開いていたものは、読み終わりで閉じない。** 見ようとしていた中身を奪わない
  // （規約は `useAutoOpenWhileSpeakingIn` が持つ。ここでは配線が効いていることを確かめる）。
  it('読み上げの前から手で開いていたものは、読み終わりで閉じない', () => {
    const { container, rerender } = renderSpeaking(null)
    fireEvent.click(notesHeader())
    expect(container.textContent).toContain(FORECAST_TEXT)

    rerender(tabWith(SPEAKING))
    rerender(tabWith(null))
    expect(container.textContent).toContain(FORECAST_TEXT)
  })

  // 安全弁: 読み上げ中に手で閉じたら、その読み上げのあいだは開き直さない
  it('読み上げ中に手で閉じたら、そのまま閉じたままにする', () => {
    const { container, rerender } = renderSpeaking(SPEAKING)
    expect(container.textContent).toContain(FORECAST_TEXT)

    fireEvent.click(notesHeader())
    expect(container.textContent).not.toContain(FORECAST_TEXT)

    rerender(tabWith(SPEAKING))
    expect(container.textContent).not.toContain(FORECAST_TEXT)
  })

  // 対照: **別の地震の長周期を読んでいるときは開かない。** カードは複数並ぶので、
  // 種別だけで判定すると読んでいるのとは違う地震の補足まで開く。
  it('別の地震の長周期を読んでいるときは開かない', () => {
    const { container } = renderSpeaking(telegramTextSubject('lpgm', '20240101999999'))
    expect(container.textContent).not.toContain(FORECAST_TEXT)
  })

  // 対照: 種別だけの主題（識別子なし）でも開かない
  it('識別子を持たない主題では開かない', () => {
    const { container } = renderSpeaking('telegramText:lpgm')
    expect(container.textContent).not.toContain(FORECAST_TEXT)
  })

  // 対照: 別種別の文を読んでいるときは開かない
  it('別種別の文を読んでいるときは開かない', () => {
    const { container } = renderSpeaking(telegramTextSubject('nankai'))
    expect(container.textContent).not.toContain(FORECAST_TEXT)
  })
})
