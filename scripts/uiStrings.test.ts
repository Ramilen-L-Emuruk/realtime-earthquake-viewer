import { describe, expect, it } from 'vitest'

import { decodeUtf8Strict, extractUiStrings, htmlTextSegments, parseUiStrings } from './lib/uiStrings'

// 画面に出うる文字列の棚卸し（docs/ui-wording-procedure.md「1. 棚卸しは機械で取る」）。
// **拾うべきものを落とすと、その文言は見直しの一覧に載らないまま残る。** 拾いすぎ（コメント・
// HTML のコメント）は一覧を水増しし、どれが画面に出るのかを読み違えさせる。

const texts = (src: string, name = 'a.ts') => extractUiStrings(name, src).map((s) => s.text)

describe('extractUiStrings: 拾うもの', () => {
  it('日本語を含む文字列リテラルを行番号つきで拾う', () => {
    const src = "const a = 'x'\nconst b = '保存した'\n"
    expect(extractUiStrings('a.ts', src)).toEqual([{ line: 2, kind: 'text', text: '保存した' }])
  })

  it('JSX の地の文と属性の文字列を拾う', () => {
    const src = 'export const A = () => <button title="押すと消える">消去</button>\n'
    expect(texts(src, 'a.tsx').sort()).toEqual(['押すと消える', '消去'])
  })

  it('HTML の文字列はタグを外して地の文ごとに分ける', () => {
    const src = 'const h = `<section>\n  <h2>基板</h2>\n  <p class="muted">まだ 1 枚も無い</p>\n</section>`\n'
    expect(extractUiStrings('a.ts', src)).toEqual([
      { line: 2, kind: 'text', text: '基板' },
      { line: 3, kind: 'text', text: 'まだ 1 枚も無い' },
    ])
  })

  it('HTML の属性値（title・placeholder・aria-label・alt など）を拾う（ホバーや読み上げで利用者に届く）', () => {
    const src = 'const h = `<input placeholder="未設定" /><span title="直近 30 分" aria-label="状態">x</span><img alt="地図">`\n'
    expect(texts(src).sort()).toEqual(['地図', '未設定', '状態', '直近 30 分'].sort())
  })

  it('埋め込み式は「${…}」で表し、中の文字列は別に 1 回だけ拾う', () => {
    const src = "const h = `<p>${ok ? '届いている' : '途絶'} 件</p>`\n"
    expect(texts(src).sort()).toEqual(['${…} 件', '届いている', '途絶'].sort())
  })

  it('埋め込み式の前後に日本語があれば、まとまりとして拾う', () => {
    const src = 'const h = `${n} 件を落とした`\n'
    expect(texts(src)).toEqual(['${…} 件を落とした'])
  })
})

describe('extractUiStrings: 拾わないもの（対照）', () => {
  it('コメント（行・ブロック・JSDoc）は拾わない', () => {
    const src = "// 保存の説明\n/* 消去の説明 */\n/** 鉛直の説明 */\nconst a = 'x'\n"
    expect(texts(src)).toEqual([])
  })

  it('HTML の文字列の中の <!-- --> は拾わない（配られるが画面には出ない）', () => {
    const src = 'const h = `<!-- **表は 1 つ。** 同じ基板が二度出る --><h2>基板</h2>`\n'
    expect(texts(src)).toEqual(['基板'])
  })

  it('日本語を含まない文字列は拾わない', () => {
    expect(texts("const a = 'records-group'\nconst b = `<div class=\"row\"></div>`\n")).toEqual([])
  })

  it('埋め込み式だけの地の文は拾わない', () => {
    expect(texts('const h = `<td>${a}</td>`\n')).toEqual([])
  })
})

describe('extractUiStrings: 種類の見分け（安全弁）', () => {
  it('new Error の文は error、console の文は log として分ける', () => {
    const src = "throw new Error('読めない')\nconsole.warn(`届かない ${n}`)\nshow('保存した')\n"
    expect(extractUiStrings('a.ts', src)).toEqual([
      { line: 1, kind: 'error', text: '読めない' },
      { line: 2, kind: 'log', text: '届かない ${…}' },
      { line: 3, kind: 'text', text: '保存した' },
    ])
  })
})

describe('extractUiStrings: 黙って落としやすい形', () => {
  it('どの属性でも、日本語を含む値は拾う（optgroup の label・button の value も画面に出る）', () => {
    const src = 'const h = `<optgroup label="観測点の合成波形"></optgroup><input type="submit" value="保存する" data-x="a">`\n'
    expect(texts(src).sort()).toEqual(['保存する', '観測点の合成波形'].sort())
  })

  it('属性値の中の > でタグを切らない', () => {
    const src = 'const h = `<span title="A > B の関係">比べる</span>`\n'
    expect(texts(src).sort()).toEqual(['A > B の関係', '比べる'].sort())
  })

  it('閉じていない < はタグとみなさず、地の文のまま残す', () => {
    expect(texts("const s = '値が a<b の場合は 説明 です'\n")).toEqual(['値が a<b の場合は 説明 です'])
  })

  it('半角カナ・々だけの文字列も日本語として拾う', () => {
    expect(texts("const a = 'ｾﾝｻｰ'\nconst b = '々'\n")).toEqual(['ｾﾝｻｰ', '々'])
  })

  it('CRLF のソースでも、複数行のテンプレートの行番号がずれない', () => {
    const lines = ['const h = `<div>', ...Array.from({ length: 20 }, (_, i) => `  <p>行${i + 2}</p>`), '</div>`', '']
    const got = extractUiStrings('a.ts', lines.join('\r\n'))
    expect(got.at(-1)).toEqual({ line: 21, kind: 'text', text: '行21' })
  })

  it('log の見分けは呼び出しの末尾で取る（this.log.warn も log）', () => {
    const src = "this.log.warn('届かない')\nctx.logger.info('保存した')\nnotify('保存した')\n"
    expect(extractUiStrings('a.ts', src).map((s) => s.kind)).toEqual(['log', 'log', 'text'])
  })

  it('ホストのログの口（opts.log(…)・deps.logError(…)）も log にする', () => {
    const src = "this.opts.log('warn', `[quake-feed] 取れない ${n}`)\ndeps.logError('[udp] 読めない')\ncatalog('一覧')\n"
    expect(extractUiStrings('a.ts', src).map((s) => s.kind)).toEqual(['log', 'log', 'text'])
  })

  it('字下げした複数行の JSX でも、地の文の行番号がずれない', () => {
    const src = 'export const A = () => (\n  <div>\n    <button>\n                再読み込み\n    </button>\n  </div>\n)\n'
    expect(extractUiStrings('a.tsx', src)).toEqual([{ line: 4, kind: 'text', text: '再読み込み' }])
  })

  it('throw の中でも、関数を越えた先の文字列は error にしない', () => {
    const src = "throw new Error(format(() => { show('画面の文') ; return 'x' }))\n"
    expect(extractUiStrings('a.ts', src)).toEqual([{ line: 1, kind: 'text', text: '画面の文' }])
  })
})

describe('parseUiStrings: 読めなかったことを返す', () => {
  it('構文エラーがあれば、その行を返す（木は返るので黙ると一部だけ読んだことになる）', () => {
    const r = parseUiStrings('a.ts', "const a = '保存'\nfunction ( {\nconst b = '消去'\n")
    expect(r.problems.length).toBeGreaterThan(0)
  })

  it('問題が無ければ空（ソースに正当な U+FFFD が書かれていても、読めない扱いにしない）', () => {
    expect(parseUiStrings('a.ts', "const a = '保存'\nconst re = /[\\uE000-�]/u\n").problems).toEqual([])
  })
})

describe('decodeUtf8Strict', () => {
  it('UTF-8 として読めればそのまま返す', () => {
    expect(decodeUtf8Strict(Buffer.from('保存 �', 'utf8'))).toEqual({ text: '保存 �', ok: true })
  })

  it('UTF-8 として読めないバイト列（Shift-JIS など）は ok: false にする', () => {
    const sjis = Buffer.from([0x95, 0xdb, 0x91, 0xb6]) // 「保存」の Shift-JIS
    expect(decodeUtf8Strict(sjis).ok).toBe(false)
  })
})

describe('extractUiStrings: HTML のファイル', () => {
  it('.html は地の文を行番号つきで拾う（静的な見出し・ボタンが置かれる）', () => {
    const src = '<!doctype html>\n<html lang="ja">\n<head><title>自作地震計 管理コンソール</title></head>\n<body>\n  <h1>管理コンソール</h1>\n</body>\n</html>\n'
    expect(extractUiStrings('index.html', src)).toEqual([
      { line: 3, kind: 'text', text: '自作地震計 管理コンソール' },
      { line: 5, kind: 'text', text: '管理コンソール' },
    ])
  })

  it('<style> と <script> の中身は拾わない（CSS のコメントに日本語があっても画面には出ない）', () => {
    const src = '<style>\n  /* 幅を絞らない */\n  .a { color: red }\n</style>\n<script>const x = "読めない"</script>\n<p>基板</p>\n'
    expect(texts(src, 'index.html')).toEqual(['基板'])
  })
})

describe('htmlTextSegments', () => {
  it('タグが無ければ空白を詰めた 1 つを返す', () => {
    expect(htmlTextSegments('  観測点を\n  登録する ').map((s) => s.text)).toEqual(['観測点を 登録する'])
  })

  it('閉じていないコメントは末尾まで外す（地の文を取り違えない）', () => {
    expect(htmlTextSegments('<p>基板</p><!-- 途中で終わる').map((s) => s.text)).toEqual(['基板'])
  })
})
