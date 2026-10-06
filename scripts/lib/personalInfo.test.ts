import { describe, expect, it } from 'vitest'

import {
  type Allowlist,
  type FindingKind,
  decodeGitObject,
  GitOutputError,
  isBinaryFile,
  type LocalRules,
  LocalRulesError,
  parseCatFileBatch,
  parseCommitObject,
  parseLocalRules,
  parseTagObject,
  scanBinary,
  scanIdentity,
  scanText,
} from './personalInfo'

// **このファイルも公開前の検査に掛かる。** 個人情報の形をした見本をそのまま書くと、このテスト自体が
// push を止める。見本はすべて架空の値で、しかも**実行時に組み立てる**（`s('…', '…')`）——
// 検査が読むのはソースの字面なので、字面に形が現れなければ当たらない。
const s = (...parts: string[]): string => parts.join('')

/** 架空の手元の地点（どこの家でもない）。 */
const HOME_LAT = '35.000000'
const HOME_LON = '135.000000'

const LOCAL: LocalRules = parseLocalRules(
  [
    '# 見本',
    s('near ', HOME_LAT, ' ', HOME_LON, ' 15'),
    'text yamada-taro',
    s('mac 00:16:3e', ':aa:bb:01'),
  ].join('\n'),
)

const ALLOW: Allowlist = {
  publicDataPaths: ['public/data/'],
  values: [s('35.12345', ', ', '139.98765')],
  fileValues: [{ path: 'src/xml.ts', value: s('el', '.local') }],
  identityEmails: ['^noreply@example\\.com$'],
  binaryExtensions: ['pbf'],
}

function kinds(where: string, text: string, local: LocalRules = LOCAL): FindingKind[] {
  return scanText(where, text, local, ALLOW).map((f) => f.kind)
}

describe('parseLocalRules（照合ファイルを読む）', () => {
  it('3 種類の行を読み、文字列と MAC を小文字・区切りなしへ揃える', () => {
    const rules = parseLocalRules('text Foo Bar\nmac AA-BB-CC-DD-EE-FF\nnear 35.5 135.5 10\n')
    expect(rules.texts).toEqual(['foo bar'])
    expect(rules.macs).toEqual(['aabbccddeeff'])
    expect(rules.near).toEqual([{ lat: 35.5, lon: 135.5, km: 10 }])
  })

  it('読めない行があれば投げる（黙って飛ばすとその値が照合から抜ける）', () => {
    expect(() => parseLocalRules('text ok\nmac 12345\n')).toThrow(LocalRulesError)
    expect(() => parseLocalRules('near 35 135\n')).toThrow(LocalRulesError)
    expect(() => parseLocalRules('txet typo\n')).toThrow(LocalRulesError)
  })

  it('項目が 1 つも無ければ投げる（何も照合しないのに通ったことになる）', () => {
    expect(() => parseLocalRules('# コメントだけ\n\n')).toThrow(LocalRulesError)
  })
})

describe('手元の照合ファイルの値', () => {
  it('文字列は大文字小文字を問わず、どこにあっても見つける', () => {
    expect(kinds('README.md', 'Author: YAMADA-TARO')).toContain('local-text')
  })

  it('MAC は区切りの有無・大文字小文字を問わず見つける', () => {
    expect(kinds('a.ts', s("'mac:00163E", "AABB01'"))).toContain('local-mac')
    expect(kinds('a.ts', s('00-16-3e-', 'aa-bb-01'))).toContain('local-mac')
  })

  it('許可リストも公開データの置き場所も効かない（安全弁）', () => {
    expect(kinds('public/data/x.json', 'yamada-taro')).toContain('local-text')
  })
})

describe('緯度経度', () => {
  const near = s(HOME_LAT.slice(0, 5), ', ', HOME_LON.slice(0, 6)) // 2〜3 桁に丸めた手元の地点

  it('手元の地点の近くは、丸めて桁を落としても見つける（正）', () => {
    expect(kinds('a.ts', `{ ${near} }`)).toContain('local-near')
  })

  it('コマンドの引数の形（--lat … --lon …）でも見つける', () => {
    expect(kinds('a.ts', s('--lat ', '35.03', ' --lon ', '135.02'))).toContain('local-near')
    expect(kinds('a.ts', s('lat: ', '35.03', ', lon: ', '135.02'))).toContain('local-near')
  })

  it('手元の地点が日本の外でも、近さは照合する（範囲で絞るのは一般的な形の検査だけ）', () => {
    const abroad = parseLocalRules(s('near ', '10.000000', ' ', '10.000000', ' 15'))
    expect(kinds('a.ts', s('[', '10.01', ', ', '10.02', ']'), abroad)).toContain('local-near')
    expect(kinds('a.ts', s('[', '10.0123', ', ', '10.0234', ']'), abroad)).not.toContain('coordinate')
  })

  it('離れた地点は近さでは当たらない（対照）', () => {
    expect(kinds('a.ts', s('43.06', ', ', '141.35'))).not.toContain('local-near')
  })

  it('小数 4 桁からは、手元の地点でなくても位置として止める（正）', () => {
    expect(kinds('a.ts', s('43.0621', ', ', '141.3544'))).toContain('coordinate')
  })

  it('小数 3 桁までは一般的な形としては止めない（対照）', () => {
    expect(kinds('a.ts', s('43.062', ', ', '141.354'))).not.toContain('coordinate')
  })

  it('許可した値は外れる', () => {
    expect(kinds('a.ts', s('[[', '35.12345', ', ', '139.98765', ']]'))).not.toContain('coordinate')
  })

  it('公開データの置き場所では近さも桁も見ない', () => {
    expect(kinds('public/data/x.json', `[${near}]`)).toEqual([])
  })
})

describe('一般的な形', () => {
  it('私的な IPv4 は止め、見本・ループバック・0.0.0.0/8・版番号は通す', () => {
    expect(kinds('a.md', s('http://', '192.168', '.1.20:50021'))).toContain('ipv4')
    expect(kinds('a.md', s('192.0', '.2.10 127.0.0.1 0.0.0.192'))).not.toContain('ipv4')
    expect(kinds('a.md', s('Chrome/', '150.0', '.0.0'))).not.toContain('ipv4')
  })

  it('機器に焼かれる形の MAC は止める（正）', () => {
    expect(kinds('a.ts', s('00:1b:44', ':11:3a:b7'))).toContain('mac')
  })

  it('手元で割り振る印・マルチキャスト・同じバイトの並びは通す（対照）', () => {
    expect(kinds('a.ts', s('02:00:00', ':00:00:01'))).not.toContain('mac')
    expect(kinds('a.ts', s('aa:bb:cc', ':dd:ee:ff'))).not.toContain('mac')
    expect(kinds('a.ts', s('mac:cccc', 'cccccccc'))).not.toContain('mac')
  })

  it('LAN の機器名は止め、ファイル名と書式の穴は通す', () => {
    expect(kinds('a.md', s('http://living-pc', '.local/'))).toContain('hostname')
    expect(kinds('a.md', s('.env', '.local と settings', '.local.json'))).not.toContain('hostname')
    expect(kinds('a.ino', s('printf("%s', '.local")'))).not.toContain('hostname')
  })

  it('正: 許可リストの fileValues に載せた値は、そのファイルの中でだけ通す', () => {
    expect(kinds('src/xml.ts', s('return numberText(el.text, el', '.local, where)'))).not.toContain('hostname')
  })

  it('対照: 同じ値でも、別のファイル・ファイル名・コミットメッセージ・ref 名では止める', () => {
    expect(kinds('src/other.ts', s('return numberText(el.text, el', '.local, where)'))).toContain('hostname')
    expect(kinds('src/xml.ts（ファイル名）', s('el', '.local'))).toContain('hostname')
    expect(kinds('commit abc のメッセージ', s('el', '.local へ配った'))).toContain('hostname')
    // ref 名は道筋の形をしていても前置きが付くので、ファイルの組とは一致しない。
    expect(kinds('ref 名 src/xml.ts', s('el', '.local'))).toContain('hostname')
  })

  it('安全弁: 載せたファイルの中でも、載せていない値は止める（形で推し量って外さない）', () => {
    expect(kinds('src/xml.ts', s('const host = el', '.local + root', '.local'))).toContain('hostname')
    expect(kinds('src/xml.ts', s("fetch('http://living", ".local/')"))).toContain('hostname')
  })

  it('鍵の形は止める', () => {
    expect(kinds('a.ts', s('ghp_', 'A'.repeat(36)))).toContain('secret')
    expect(kinds('a.ts', s('-----BEGIN RSA ', 'PRIVATE KEY-----'))).toContain('secret')
  })

  it('長い 16 進は、すぐ手前がハッシュだと名乗るときだけ通す（同じ行の離れた語では外さない）', () => {
    const hex = 'ab12'.repeat(16)
    expect(kinds('a.ts', `// sha256: ${hex}`)).not.toContain('secret')
    expect(kinds('a.ts', `const key = "${hex}" ${'x'.repeat(50)} // 前の commit を参照`)).toContain('secret')
  })

  it('公開データの長い行でも鍵は探す（位置の形だけを外す）', () => {
    const line = `${'[1.5,2.5],'.repeat(3000)}"${s('ghp_', 'B'.repeat(36))}"`
    expect(kinds('public/data/x.json', line)).toContain('secret')
  })

  it('引用符で囲んだ値は、英字だけでも名前と見なさない（弱いパスワードを通さない）', () => {
    expect(kinds('a.ts', s('password = "', 'correcthorsebatterystaple"'))).toContain('secret')
    expect(kinds('a.ts', 'password = correcthorsebatterystaple')).not.toContain('secret')
  })

  it('SSID は引用符つき・#define の文字列なら名前の形でも止め、引用符の無い名前は通す', () => {
    expect(kinds('a.h', s('#define WIFI', '_SSID "HomeNetwork5G"'))).toContain('ssid')
    expect(kinds('a.ts', s('ssid: "', 'HomeNetwork5G"'))).toContain('ssid')
    expect(kinds('a.ts', 'ssid = WIFI_SSID')).not.toContain('ssid')
    expect(kinds('a.h', '#define WIFI_SSID "<your-ssid>"')).not.toContain('ssid')
  })

  it('代入の右辺がコードの式なら通す（対照）', () => {
    expect(kinds('a.ts', 'cursorToken = listJson.nextToken')).not.toContain('secret')
    expect(kinds('a.ts', 'const token = ++seqRef.current')).not.toContain('secret')
  })

  it('数字を含む英数字の値は 1 語でも止める（安全弁: 名前と見なして外さない）', () => {
    expect(kinds('a.ts', s('API_KEY=', 'Ab3dE5fG7hJ9kL1mN3pQ'))).toContain('secret')
  })

  it('住所の番地は止め、年月日は通す', () => {
    expect(kinds('a.md', s('東京都', '千代田区丸の内', '1-2-3'))).toContain('address')
    expect(kinds('a.md', s('東京都', '千代田区で ', '2026-07-28'))).not.toContain('address')
  })

  it('メールは許可した形だけ通す', () => {
    expect(kinds('a.md', s('taro', '@', 'mail.invalid-domain.jp'))).toContain('email')
    expect(kinds('a.md', s('noreply', '@', 'example.com'))).not.toContain('email')
  })

  it('.env は公開しない。雛形は値が入っていれば止める', () => {
    expect(kinds('.env.local', 'X=1')).toContain('env-file')
    expect(kinds('config/app.env', 'X=1')).toContain('env-file')
    expect(kinds('src/env.ts', 'X=1')).not.toContain('env-file')
    expect(kinds('.env.example', '# X の説明\nX=')).not.toContain('env-file')
    expect(kinds('.env.example', 'X=abc')).toContain('env-file')
  })
})

describe('scanBinary（文字でないファイル）', () => {
  const png = (chunkType: string): Uint8Array => {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    const chunk = (type: string, len: number) => [0, 0, 0, len, ...[...type].map((c) => c.charCodeAt(0)), ...new Array(len + 4).fill(0)]
    return Uint8Array.from([...sig, ...chunk(chunkType, 2), ...chunk('IEND', 0)])
  }

  it('画像の付帯情報（PNG の tEXt）を見つける', () => {
    expect(scanBinary('a.png', png('tEXt'), LOCAL, ALLOW).map((f) => f.kind)).toContain('media-metadata')
    expect(scanBinary('a.png', png('IDAT'), LOCAL, ALLOW)).toEqual([])
  })

  it('終わりの印まで辿れない PNG は「付帯情報なし」と言わない', () => {
    const truncated = png('IDAT').subarray(0, 20)
    expect(scanBinary('a.png', truncated, LOCAL, ALLOW).map((f) => f.kind)).toContain('media-metadata')
  })

  it('画像は先頭に NUL が無くてもバイナリとして調べる', () => {
    expect(isBinaryFile('a.png', Buffer.from('no nul here'))).toBe(true)
    expect(isBinaryFile('a.txt', Buffer.from('no nul here'))).toBe(false)
  })

  it('中身を確かめられない種類は、許可した拡張子でなければ止める', () => {
    const bytes = Uint8Array.from([0, 1, 2, 3])
    expect(scanBinary('a.bin', bytes, LOCAL, ALLOW).map((f) => f.kind)).toContain('binary')
    expect(scanBinary('tiles/0.pbf', bytes, LOCAL, ALLOW)).toEqual([])
  })

  it('バイナリの中の照合ファイルの値も見つける（安全弁）', () => {
    const bytes = Uint8Array.from([0, ...Buffer.from('yamada-taro')])
    expect(scanBinary('tiles/0.pbf', bytes, LOCAL, ALLOW).map((f) => f.kind)).toContain('local-text')
  })
})

describe('git の出力を読む（読み違いは投げる）', () => {
  const A = 'a'.repeat(40)
  const B = 'b'.repeat(40)
  const entry = (sha: string, type: string, body: string) => Buffer.concat([Buffer.from(`${sha} ${type} ${Buffer.byteLength(body)}\n`), Buffer.from(body), Buffer.from('\n')])

  it('cat-file --batch の出力を中身ごとに分ける', () => {
    const out = parseCatFileBatch(Buffer.concat([entry(A, 'blob', 'one\n'), entry(B, 'blob', '')]), [A, B])
    expect(out.get(A)?.body.toString()).toBe('one\n')
    expect(out.get(B)?.body.length).toBe(0)
  })

  it('missing が混じれば投げる（後ろのブロブを黙って落とさない）', () => {
    const buf = Buffer.concat([entry(A, 'blob', 'x'), Buffer.from(`${B} missing\n`), entry('c'.repeat(40), 'blob', 'y')])
    expect(() => parseCatFileBatch(buf, [A, B, 'c'.repeat(40)])).toThrow(GitOutputError)
  })

  it('頼んだのに返らなかったもの・長さが合わないものがあれば投げる', () => {
    expect(() => parseCatFileBatch(entry(A, 'blob', 'x'), [A, B])).toThrow(GitOutputError)
    const broken = Buffer.from(`${A} blob 10\nshort\n`)
    expect(() => parseCatFileBatch(broken, [A])).toThrow(GitOutputError)
  })

  const person = (field: string, name: string) => s(field, ' ', name, ' <', 'noreply', '@', 'example.com> 1700000000 +0900')

  it('コミットの作者・コミッター・メッセージを生の中身から取る（署名の続きの行・区切り文字を含む本文）', () => {
    const raw = [
      `tree ${A}`,
      `parent ${B}`,
      person('author', 'Taro'),
      person('committer', 'Hanako'),
      'gpgsig -----BEGIN PGP SIGNATURE-----',
      ' author Fake <fake> 0 +0000',
      ' -----END PGP SIGNATURE-----',
      '',
      'subject\u001f\u001e',
      '',
      'body',
    ].join('\n')
    const c = parseCommitObject(raw)
    expect(c.author.name).toBe('Taro')
    expect(c.committer.name).toBe('Hanako')
    expect(c.message).toBe('subject\u001f\u001e\n\nbody')
  })

  it('encoding 見出しがあればその文字コードで読む（Shift_JIS の名前を化かさない）', () => {
    const sjisName = Buffer.from([0x8e, 0x52, 0x93, 0x63]) // 「山田」
    const raw = Buffer.concat([
      Buffer.from(`tree ${A}\nauthor `),
      sjisName,
      Buffer.from(s(' <x', '@', 'example.com> 1700000000 +0900\n', person('committer', 'c'), '\nencoding Shift_JIS\n\nmsg')),
    ])
    expect(parseCommitObject(decodeGitObject(raw)).author.name).toBe('山田')
  })

  it('UTF-8 として読めないバイトがあれば投げる（置換文字に化けた名前は何とも一致しない）', () => {
    const raw = Buffer.concat([Buffer.from(`tree ${A}\nauthor `), Buffer.from([0x8e, 0x52]), Buffer.from(' <x> 0 +0000\n\nmsg')])
    expect(() => decodeGitObject(raw)).toThrow(GitOutputError)
  })

  it('author の行が無い・読めないコミットは投げる', () => {
    expect(() => parseCommitObject(`tree ${A}\n${person('committer', 'x')}\n\nmsg`)).toThrow(GitOutputError)
    expect(() => parseCommitObject(`tree ${A}\nauthor broken\n${person('committer', 'x')}\n\nmsg`)).toThrow(GitOutputError)
  })

  it('タグは作成者が無くても読み、本文が無ければ空にする', () => {
    expect(parseTagObject(`object ${A}\ntype commit\ntag v1`)).toEqual({ tagger: null, message: '' })
    expect(parseTagObject(`object ${A}\ntype commit\ntag v1\n${person('tagger', 'T')}\n\nnote`).message).toBe('note')
  })
})

describe('scanIdentity（作者・コミッター）', () => {
  it('許可していないメールは止め、許可したものは通す', () => {
    expect(scanIdentity('作者', 'x', s('x', '@', 'corp.invalid'), LOCAL, ALLOW).map((f) => f.kind)).toEqual(['identity'])
    expect(scanIdentity('作者', 'x', s('noreply', '@', 'example.com'), LOCAL, ALLOW)).toEqual([])
  })

  it('メールが許可した形でも、名前に照合ファイルの値があれば止める', () => {
    expect(scanIdentity('作者', 'Yamada-Taro', s('noreply', '@', 'example.com'), LOCAL, ALLOW).map((f) => f.kind)).toEqual(['local-text'])
  })
})
