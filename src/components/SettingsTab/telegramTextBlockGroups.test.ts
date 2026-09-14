// 気象庁が書いた文の内訳が、設定タブに全部出ること。
//
// ラベルの対応表（`TELEGRAM_TEXT_BLOCK_LABELS`）は `Record<TelegramTextBlockKey, string>` なので
// 書き忘れると型検査が止める。**しかしグループ分け（`TELEGRAM_TEXT_BLOCK_GROUPS`）は配列なので
// 型では守れない** —— ここから漏れたキーは画面に出ず、既定のまま二度と触れなくなる。
//
// 実装を import せずソースを読んでいるのは、対象が JSX を含むモジュールで、
// このためだけに描画環境（jsdom）を用意したくないため。**照合するのはキーの集合だけ**なので、
// 字面の走査で足りる。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { TELEGRAM_TEXT_BLOCK_KEYS } from '../../utils/ttsText'

const source = readFileSync('src/components/SettingsTab/index.tsx', 'utf8')

/** `const NAME = ... [ ... ]` の中身を、次の閉じ括弧までまとめて取り出す。 */
function blockOf(name: string): string {
  const start = source.indexOf(`const ${name}`)
  expect(start, `${name} が見つからない`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('\n]', start)
  expect(end, `${name} の終わりが見つからない`).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('設定タブに出す「気象庁が書いた文」の内訳', () => {
  // 正: 全キーがどこかのグループに入っている
  it('全ブロックがいずれかの電文種別のグループに入っている', () => {
    const groups = blockOf('TELEGRAM_TEXT_BLOCK_GROUPS')
    const missing = TELEGRAM_TEXT_BLOCK_KEYS.filter(key => !groups.includes(`'${key}'`))
    expect(missing, `グループに入っていないブロック: ${missing.join(', ')}`).toEqual([])
  })

  // 安全弁: ラベルも全キーぶんある（型で守られているが、対応表を配列へ変えたときに気付けるように）
  it('全ブロックに表示名がある', () => {
    const labels = blockOf('TELEGRAM_TEXT_BLOCK_LABELS')
    const missing = TELEGRAM_TEXT_BLOCK_KEYS.filter(key => !labels.includes(`${key}:`))
    expect(missing, `表示名が無いブロック: ${missing.join(', ')}`).toEqual([])
  })

  // 対照: グループに、一覧に無いキーを書いていない（消したキーが画面に残らない）
  it('一覧に無いキーをグループへ書いていない', () => {
    const groups = blockOf('TELEGRAM_TEXT_BLOCK_GROUPS')
    const written = [...groups.matchAll(/'([a-zA-Z]+)'/g)].map(m => m[1])
    const unknown = written.filter(key => !(TELEGRAM_TEXT_BLOCK_KEYS as readonly string[]).includes(key))
    expect(unknown, `一覧に無いキー: ${unknown.join(', ')}`).toEqual([])
  })
})
