import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

import { Writable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RawStore, jstDay, stuckSince } from './rawStore'

/** 2026-09-25 23:00 JST。日本時間では 25 日、UTC では 24 日 —— **境目の向きを見分ける値**。 */
const AT_2026_09_25_2300_JST = Date.parse('2026-09-25T14:00:00.000Z')

const DAY_MS = 24 * 60 * 60 * 1000

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'seismo-raw-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function lines(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as unknown)
}

/** 版 1 の形に倣った複数行のパケット。**改行を含むことがこの試験の肝。** */
function payload(rows: number): string {
  const head = '{"n":"seismo-3","s":"MPU6050","ug":61.0352,"hz":100,"r":2,"t":1,"q":0,"c":3,"o":0}'
  const body = Array.from({ length: rows }, (_, i) => `${i},${i + 1},${i + 2}`)
  return [head, ...body].join('\n') + '\n'
}

/**
 * 差し替え用の流し口。`delayMs` を渡すと遅いだけ、`null` を渡すと止まったまま。
 *
 * **本物のファイルでは作れない。** 速さは OS の都合で決まるので、締めくくりの手当てが
 * 効いているかを本物で試すことはできない。
 */
function sink(delayMs: number | null): Writable {
  return new Writable({
    write(_chunk, _enc, done) {
      if (delayMs === null) return
      setTimeout(done, delayMs)
    },
  })
}

/** 書き込みは返らないまま、少し後に自分から壊れる流し口。**本物のディスク障害の形。** */
function breakingSink(): Writable {
  const stream = new Writable({
    write() {
      // 返らない。
    },
  })
  setTimeout(() => stream.emit('error', new Error('壊れた')), 5)
  return stream
}

/** 書き込みは順調に終わるのに、閉じ終わらない流し口。**失うものは無い。** */
function slowClosingSink(): Writable {
  return new Writable({
    write(_chunk, _enc, done) {
      done()
    },
    final() {
      // 返らない。
    },
  })
}

/**
 * 書き込みを頼まれたその場で投げる流し口。
 *
 * **非同期の失敗とは別の経路。** コールバックは呼ばれないので、そちらで数える形だけでは
 * この 1 件がどこにも計上されない。
 */
function sinkThatThrowsOnWrite(): Writable {
  const stream = new Writable({
    write(_chunk, _enc, done) {
      done()
    },
  })
  stream.write = (): boolean => {
    throw new Error('同期で壊れた')
  }
  return stream
}

/**
 * 止まったまま、捨てられるときに溜まっていた分へエラーを返す流し口。
 *
 * **本物のファイルはこう振る舞う**（開けなかった流し口へ 3 件積むと 3 件ともコールバックが
 * エラーを受けると実測した）。素の `Writable` は 1 件も返さないので、両方を試さないと
 * 「締めくくりの側と書き込みの側で二重に数える」形が出ない。
 */
function stalledSinkThatFailsPending(): Writable {
  const waiting: ((error?: Error | null) => void)[] = []
  return new Writable({
    write(_chunk, _enc, done) {
      waiting.push(done)
    },
    destroy(error, done) {
      for (const pending of waiting.splice(0)) pending(new Error('destroyed'))
      done(error)
    },
  })
}

describe('jstDay', () => {
  it('日本時間の日を返す（UTC の日ではない）', () => {
    // 14:00Z は JST の 23:00。**UTC で切っていれば 24 日になる。**
    expect(jstDay(Date.parse('2026-09-24T14:00:00.000Z'))).toBe('2026-09-24')
    expect(jstDay(Date.parse('2026-09-24T15:00:00.000Z'))).toBe('2026-09-25')
  })

  it('時刻として表せない値では null を返す', () => {
    expect(jstDay(Number.NaN)).toBeNull()
    expect(jstDay(Number.POSITIVE_INFINITY)).toBeNull()
    // **有限なだけでは足りない。** 下駄を足すと `Date` の範囲を出る値。
    expect(jstDay(8.64e15)).toBeNull()
    expect(jstDay(8.64e15 - 9 * 60 * 60 * 1000)).not.toBeNull()
  })
})

describe('stuckSince', () => {
  it('締めくくりに入っていない本は起点を持たない', () => {
    expect(stuckSince(null, null)).toBeNull()
  })

  it('まだ一度も進んでいなければ、締めくくりに入った時刻から測る', () => {
    expect(stuckSince(1000, null)).toBe(1000)
  })

  it('進んだ時刻があれば、そちらから測り直す', () => {
    // **これが無いと、書き出しが進み続けている本まで「戻ってこない」と数える。**
    // 第 1 相は進んでいる限り何秒でも待つ設計なので、低速なだけの相手が必ず引っかかる。
    expect(stuckSince(1000, 5000)).toBe(5000)
  })

  it('進んだ時刻が起点より前でも、起点より手前へは戻さない', () => {
    // 対照。時計が戻っても起点より古い値は採らない。
    expect(stuckSince(5000, 1000)).toBe(5000)
  })
})

describe('RawStore', () => {
  it('1 データグラムを 1 行として、受信時刻・送信元・生の中身とともに残す', async () => {
    const store = new RawStore({ dir, now: () => AT_2026_09_25_2300_JST })
    const raw = payload(3)
    expect(store.write('192.168.0.31:51234', raw)).toEqual({ saved: true })
    await store.close()

    const path = join(dir, 'raw-2026-09-25.ndjson')
    const got = lines(path)
    expect(got).toHaveLength(1)
    // **複数行のパケットが 1 行に収まり、そのまま読み戻せること。**
    expect(got[0]).toEqual({ rx: AT_2026_09_25_2300_JST, src: '192.168.0.31:51234', raw })
  })

  it('読めない中身でもそのまま残す', async () => {
    const store = new RawStore({ dir, now: () => AT_2026_09_25_2300_JST })
    const junk = 'not json at all\n\u0000�'
    expect(store.write('10.0.0.9:1', junk)).toEqual({ saved: true })
    await store.close()

    const got = lines(join(dir, 'raw-2026-09-25.ndjson')) as { raw: string }[]
    expect(got[0]?.raw).toBe(junk)
  })

  describe('日ごとに回す', () => {
    it('日本時間の日境界で本が変わる', async () => {
      let now = Date.parse('2026-09-25T14:59:59.999Z')
      const store = new RawStore({ dir, now: () => now })
      store.write('a:1', 'before')
      now = Date.parse('2026-09-25T15:00:00.000Z')
      store.write('a:1', 'after')
      await store.close()

      // **UTC で切っていれば 1 本にまとまってしまう値。**
      expect(lines(join(dir, 'raw-2026-09-25.ndjson'))).toHaveLength(1)
      expect(lines(join(dir, 'raw-2026-09-26.ndjson'))).toHaveLength(1)
    })

    it('同じ日のあいだは 1 本へ書き足す', async () => {
      let now = AT_2026_09_25_2300_JST
      const store = new RawStore({ dir, now: () => now })
      store.write('a:1', 'one')
      now += 1000
      store.write('a:1', 'two')
      await store.close()

      expect(lines(join(dir, 'raw-2026-09-25.ndjson'))).toHaveLength(2)
      expect(readdirSync(dir)).toEqual(['raw-2026-09-25.ndjson'])
    })

    it('時計が壊れても回さない', async () => {
      let now: number = AT_2026_09_25_2300_JST
      const store = new RawStore({ dir, now: () => now })
      store.write('a:1', 'one')
      now = Number.NaN
      // **名前を決められない値で本を切らない。** 切ると行き先が決まらないまま失われる。
      expect(store.write('a:1', 'two')).toEqual({ saved: true })
      expect(store.currentDay).toBe('2026-09-25')
      await store.close()

      const got = lines(join(dir, 'raw-2026-09-25.ndjson')) as { rx: number | null }[]
      expect(got).toHaveLength(2)
      // 受け取った時刻が判らなかったことは、取り繕わずそのまま残す。
      expect(got[1]?.rx).toBeNull()
    })

    it('1 件目から時計が壊れていれば書けないことを返す', async () => {
      const store = new RawStore({ dir, now: () => Number.NaN })
      expect(store.write('a:1', 'one')).toEqual({ saved: false, reason: 'no-stream' })
      await store.close()
      expect(readdirSync(dir)).toEqual([])
    })
  })

  describe('gzip', () => {
    function seed(day: string, text: string): void {
      writeFileSync(join(dir, `raw-${day}.ndjson`), text, 'utf8')
    }

    it('前日より古い分だけを圧縮し、今日と昨日は素のまま残す', async () => {
      seed('2026-09-22', 'old\n')
      seed('2026-09-23', 'older-boundary\n')
      seed('2026-09-24', 'yesterday\n')
      seed('2026-09-25', 'today\n')

      const store = new RawStore({ dir, now: () => AT_2026_09_25_2300_JST })
      await store.sweep()
      await store.close()

      expect(existsSync(join(dir, 'raw-2026-09-22.ndjson'))).toBe(false)
      expect(existsSync(join(dir, 'raw-2026-09-23.ndjson'))).toBe(false)
      // **対照。** ここまで圧縮すると、取ったばかりの記録を `grep` や `tail` で触れなくなる。
      expect(existsSync(join(dir, 'raw-2026-09-24.ndjson'))).toBe(true)
      expect(existsSync(join(dir, 'raw-2026-09-25.ndjson'))).toBe(true)
      expect(store.compressed).toBe(2)
      expect(store.compressFailures).toBe(0)
    })

    it('圧縮しても中身は読み戻せる', async () => {
      seed('2026-09-23', 'alpha\nbeta\n')
      const store = new RawStore({ dir, now: () => AT_2026_09_25_2300_JST })
      await store.sweep()
      await store.close()

      const gz = readFileSync(join(dir, 'raw-2026-09-23.ndjson.gz'))
      expect(gunzipSync(gz).toString('utf8')).toBe('alpha\nbeta\n')
    })

    it('書きかけを残さない', async () => {
      seed('2026-09-23', 'alpha\n')
      const store = new RawStore({ dir, now: () => AT_2026_09_25_2300_JST })
      await store.sweep()
      await store.close()

      expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
    })

    it('同じ日の gz が既にあれば上書きせず別名へ逃がす', async () => {
      // 時計が戻った端末で起きる形。**上書きは削除と同じで「消さない」に反する。**
      writeFileSync(
        join(dir, 'raw-2026-09-23.ndjson.gz'),
        gzipSync(Buffer.from('先にあった分\n', 'utf8')),
      )
      seed('2026-09-23', 'あとから書いた分\n')

      const store = new RawStore({ dir, now: () => AT_2026_09_25_2300_JST })
      await store.sweep()
      await store.close()

      const kept = readFileSync(join(dir, 'raw-2026-09-23.ndjson.gz'))
      expect(gunzipSync(kept).toString('utf8')).toBe('先にあった分\n')
      const escaped = readFileSync(join(dir, 'raw-2026-09-23.ndjson.2.gz'))
      expect(gunzipSync(escaped).toString('utf8')).toBe('あとから書いた分\n')
      expect(existsSync(join(dir, 'raw-2026-09-23.ndjson'))).toBe(false)
      // **逃がしたこと自体は成功だが、黙って通さない。** 同じ日の記録が別の中身で
      // 2 つできるのは時計が戻った印で、日付でファイルを分ける前提が揺らいでいる。
      expect(store.escaped).toBe(1)
    })

    it('既に別名へ逃がしてあれば、作り直さず元を消すことだけ試す', async () => {
      // **元を消せなかった場合、次の掃き取りでも `settled` との食い違いは残る。**
      // そこで作り直すと同じ中身の `.N.gz` が掃き取りのたびに増え、1 回の時計の狂いが
      // 毎日起きているように見える。
      writeFileSync(
        join(dir, 'raw-2026-09-23.ndjson.gz'),
        gzipSync(Buffer.from('先にあった分\n', 'utf8')),
      )
      writeFileSync(
        join(dir, 'raw-2026-09-23.ndjson.2.gz'),
        gzipSync(Buffer.from('あとから書いた分\n', 'utf8')),
      )
      seed('2026-09-23', 'あとから書いた分\n')

      const store = new RawStore({ dir, now: () => AT_2026_09_25_2300_JST })
      await store.sweep()
      await store.close()

      // 3 本目を作らない。
      expect(existsSync(join(dir, 'raw-2026-09-23.ndjson.3.gz'))).toBe(false)
      // 逃がしたのは前回で、今回ではない。
      expect(store.escaped).toBe(0)
      expect(store.compressed).toBe(0)
      // 元は消える（後始末だけは進む）。
      expect(existsSync(join(dir, 'raw-2026-09-23.ndjson'))).toBe(false)
    })

    it('逃がし先の番号が飛んでいても、その先の同じ中身を見つける', async () => {
      // **`.N.gz` は掃除のスクリプトなど外から消されうる。** 欠番で走査を打ち切ると、
      // その先に残っている同じ中身を見落とし、**防ごうとした重複をかえって作る**。
      writeFileSync(
        join(dir, 'raw-2026-09-23.ndjson.gz'),
        gzipSync(Buffer.from('先にあった分\n', 'utf8')),
      )
      // `.2.gz` は無い（外から消された想定）。`.3.gz` に逃がした分が残っている。
      writeFileSync(
        join(dir, 'raw-2026-09-23.ndjson.3.gz'),
        gzipSync(Buffer.from('あとから書いた分\n', 'utf8')),
      )
      seed('2026-09-23', 'あとから書いた分\n')

      const store = new RawStore({ dir, now: () => AT_2026_09_25_2300_JST })
      await store.sweep()
      await store.close()

      expect(existsSync(join(dir, 'raw-2026-09-23.ndjson.2.gz'))).toBe(false)
      expect(store.escaped).toBe(0)
      expect(store.compressed).toBe(0)
      expect(existsSync(join(dir, 'raw-2026-09-23.ndjson'))).toBe(false)
    })

    it('元を読めなければ、圧縮の失敗として数えて元を残す', async () => {
      // **読めないものを消さない。** 中身を照らせていないファイルを消しにいけば、
      // この受け手の「消さない」という約束に反する。
      writeFileSync(
        join(dir, 'raw-2026-09-23.ndjson.gz'),
        gzipSync(Buffer.from('先にあった分\n', 'utf8')),
      )
      writeFileSync(
        join(dir, 'raw-2026-09-23.ndjson.2.gz'),
        gzipSync(Buffer.from('あとから書いた分\n', 'utf8')),
      )
      // 元をディレクトリにして読めなくする（本物の破損を安定して作れる唯一の手）。
      mkdirSync(join(dir, 'raw-2026-09-23.ndjson'))

      const store = new RawStore({ dir, now: () => AT_2026_09_25_2300_JST })
      await store.sweep()
      await store.close()

      expect(store.escaped).toBe(0)
      // 既にある `.gz` と照らす手前で読めず、圧縮の失敗として数える。
      expect(store.compressFailures).toBe(1)
      // **消そうとしていない。**
      expect(store.leftovers).toBe(0)
      expect(existsSync(join(dir, 'raw-2026-09-23.ndjson'))).toBe(true)
    })

    it('逃がせなかったときは「逃がした」と数えない', async () => {
      // **数えるのは成功した後。** 検出した時点で数えると、逃がせなかったときも
      // 「別名へ逃がしてある」と主張することになる。しかも元のファイルは消えないので、
      // **翌日以降のたびに同じ食い違いを検出し、1 回の時計の狂いが毎日積み上がって見える**。
      writeFileSync(
        join(dir, 'raw-2026-09-23.ndjson.gz'),
        gzipSync(Buffer.from('先にあった分\n', 'utf8')),
      )
      // 逃がし先（`.2.gz` 〜 `.99.gz`）を埋めて、逃がせない状況を作る。
      for (let i = 2; i <= 99; i += 1) {
        writeFileSync(join(dir, `raw-2026-09-23.ndjson.${i}.gz`), Buffer.from(''))
      }
      seed('2026-09-23', 'あとから書いた分\n')

      const store = new RawStore({ dir, now: () => AT_2026_09_25_2300_JST })
      await store.sweep()
      await store.close()

      expect(store.escaped).toBe(0)
      expect(store.compressFailures).toBe(1)
      // 元は消えていない（次の掃き取りでまた試せる）。
      expect(existsSync(join(dir, 'raw-2026-09-23.ndjson'))).toBe(true)
    })

    it('同じ中身の gz が既にあれば作り直さず、元を消すことだけ試す', async () => {
      // 前回、圧縮まで済んで元を消せなかった形。**作り直すと、同じ中身の `.gz` が
      // 掃き取りのたびに増えて、埋めまいとしていたディスクを自分で埋める。**
      const body = 'alpha\nbeta\n'
      seed('2026-09-23', body)
      writeFileSync(join(dir, 'raw-2026-09-23.ndjson.gz'), gzipSync(Buffer.from(body, 'utf8')))

      const store = new RawStore({ dir, now: () => AT_2026_09_25_2300_JST })
      await store.sweep()
      await store.close()

      expect(existsSync(join(dir, 'raw-2026-09-23.ndjson'))).toBe(false)
      // **対照。** 中身が違うときだけ別名へ逃がす（1 つ上の試験）。
      expect(existsSync(join(dir, 'raw-2026-09-23.ndjson.2.gz'))).toBe(false)
      expect(store.compressed).toBe(0)
      expect(store.compressFailures).toBe(0)
    })

    it('既にある gz を読めなければ、素のまま残して失敗として数える', async () => {
      // **中身を照らせない以上、同じものか別物か決められない。** 隣へ積み足すと
      // 壊れたファイルの横に増え続けるので、素のまま残して人が見に来るのを待つ。
      writeFileSync(join(dir, 'raw-2026-09-23.ndjson.gz'), '壊れている', 'utf8')
      seed('2026-09-23', 'あとから書いた分\n')

      const store = new RawStore({ dir, now: () => AT_2026_09_25_2300_JST })
      await store.sweep()
      await store.close()

      expect(existsSync(join(dir, 'raw-2026-09-23.ndjson'))).toBe(true)
      expect(existsSync(join(dir, 'raw-2026-09-23.ndjson.2.gz'))).toBe(false)
      expect(store.compressFailures).toBe(1)
      expect(store.lastSweepError).not.toBeNull()
    })

    it('日が変わったときにも掃き取る', async () => {
      seed('2026-09-23', 'old\n')
      let now = AT_2026_09_25_2300_JST
      const store = new RawStore({ dir, now: () => now })
      store.write('a:1', 'one')
      now += DAY_MS
      store.write('a:1', 'two')
      // 回転は待たずに掃き取りを始める。締めくくりで合流する。
      await store.close()

      expect(existsSync(join(dir, 'raw-2026-09-23.ndjson.gz'))).toBe(true)
      expect(store.compressed).toBe(1)
    })

    it('回した本も流し切ってから締める', async () => {
      // **小さい書き込みでは差が出ない** —— 溜まっていないので、閉じ忘れても届く。
      // 内側の控えを超える量を入れて、締めるときに待っていることを確かめる。
      let now = AT_2026_09_25_2300_JST
      const store = new RawStore({ dir, now: () => now, maxPendingBytes: 64 * 1024 * 1024 })
      const big = 'x'.repeat(200_000)
      for (let i = 0; i < 10; i += 1) store.write('a:1', big)
      now += DAY_MS
      store.write('a:1', 'next day')
      await store.close()

      expect(lines(join(dir, 'raw-2026-09-25.ndjson'))).toHaveLength(10)
      expect(lines(join(dir, 'raw-2026-09-26.ndjson'))).toHaveLength(1)
    })

    it('回した本を開いたままにしない', async () => {
      // **閉じ忘れは中身の欠けとしては出ない**（放っておいても書き出される）。
      // 日をまたぐたびに 1 つ漏れる形は、開いたファイルの数でしか捕まえられない。
      let now = AT_2026_09_25_2300_JST
      const store = new RawStore({ dir, now: () => now })
      store.write('a:1', 'one')
      now += DAY_MS
      store.write('a:1', 'two')
      await store.close()

      expect(store.openFiles).toBe(0)
    })

    it('日の名前を付けられないファイルには触らない', async () => {
      writeFileSync(join(dir, 'raw-notes.txt'), 'keep me', 'utf8')
      writeFileSync(join(dir, 'raw-2026-9-3.ndjson'), 'keep me too', 'utf8')
      // **日付のあとに何か続くものも触らない。** 名前の型を緩めると、これが
      // 「2020-01-01-extra」という日として圧縮の対象に入る。
      writeFileSync(join(dir, 'raw-2020-01-01-extra.ndjson'), 'keep me three', 'utf8')
      const store = new RawStore({ dir, now: () => AT_2026_09_25_2300_JST })
      await store.sweep()
      await store.close()

      expect(readFileSync(join(dir, 'raw-notes.txt'), 'utf8')).toBe('keep me')
      expect(readFileSync(join(dir, 'raw-2026-9-3.ndjson'), 'utf8')).toBe('keep me too')
      expect(readFileSync(join(dir, 'raw-2020-01-01-extra.ndjson'), 'utf8')).toBe('keep me three')
      expect(store.compressed).toBe(0)
    })

    it('置き場所を走査できなければ、書き込みの側の文面を汚さない', async () => {
      // **系統ごとに分ける。** 1 つの欄を共有すると、直近の別系統の理由が
      // 「その事象の理由」の顔をして記録に出る。
      const store = new RawStore({ dir, now: () => AT_2026_09_25_2300_JST })
      rmSync(dir, { recursive: true, force: true })
      await store.sweep()

      // **圧縮の失敗とは別の枠。** あちらは 1 本ずつの結果で、こちらは「そこに何本
      // あったかも判らない」—— 混ぜると 1 件の異常が 1 本の失敗に見える。
      expect(store.listFailures).toBe(1)
      expect(store.compressFailures).toBe(0)
      expect(store.lastSweepError).not.toBeNull()
      expect(store.lastWriteError).toBeNull()

      await store.close()
    })

    it('時計が壊れていれば掃き取らない', async () => {
      writeFileSync(join(dir, 'raw-2026-09-23.ndjson'), 'old\n', 'utf8')
      const store = new RawStore({ dir, now: () => Number.NaN })
      await store.sweep()
      await store.close()

      // **どれが「昨日」か判らないまま消しにかからない。**
      expect(existsSync(join(dir, 'raw-2026-09-23.ndjson'))).toBe(true)
      expect(store.compressed).toBe(0)
    })
  })

  describe('書けなかったとき', () => {
    it('置き場所を作れなければ投げる', () => {
      // ファイルの下にはディレクトリを作れない。
      const blocked = join(dir, 'blocker')
      writeFileSync(blocked, 'x', 'utf8')
      expect(() => new RawStore({ dir: join(blocked, 'raw') })).toThrow()
    })

    it('抱えた量が上限を超えたら捨てて、そのことを返す', async () => {
      const store = new RawStore({ dir, now: () => AT_2026_09_25_2300_JST, maxPendingBytes: 200 })
      const line = 'x'.repeat(120)
      expect(store.write('a:1', line)).toEqual({ saved: true })
      // 2 本目で上限を超える。**捨てたことを黙らない。**
      expect(store.write('a:1', line)).toEqual({ saved: false, reason: 'backpressure' })
      await store.close()

      expect(lines(join(dir, 'raw-2026-09-25.ndjson'))).toHaveLength(1)
    })

    it('流し口が壊れたら数え、間隔を置いてから開き直す', async () => {
      // 同じ名前のディレクトリがあると `createWriteStream` は EISDIR で落ちる。
      mkdirSync(join(dir, 'raw-2026-09-25.ndjson'))
      let now = AT_2026_09_25_2300_JST
      const store = new RawStore({ dir, now: () => now, reopenIntervalMs: 5_000 })

      store.write('a:1', 'one')
      await new Promise((r) => setTimeout(r, 20))
      expect(store.writeErrors).toBe(1)
      expect(store.lastWriteError).not.toBeNull()
      // **掃き取りの失敗と混ぜない。** 混ぜると、無関係な系統の理由が「その事象の理由」になる。
      expect(store.lastSweepError).toBeNull()

      // 間隔の中では開き直さない。**詰まったディスクを毎パケット叩かない。**
      expect(store.write('a:1', 'two')).toEqual({ saved: false, reason: 'no-stream' })
      expect(store.writeErrors).toBe(1)

      // 間隔が過ぎたら試みる（この試験では行き先が塞がったままなので、また壊れる）。
      now += 5_000
      store.write('a:1', 'three')
      await new Promise((r) => setTimeout(r, 20))
      expect(store.writeErrors).toBe(2)

      await store.close()
    })

    it('時計が壊れている間は開き直しの間隔が効き続ける', async () => {
      mkdirSync(join(dir, 'raw-2026-09-25.ndjson'))
      let now: number = AT_2026_09_25_2300_JST
      const store = new RawStore({ dir, now: () => now, reopenIntervalMs: 5_000 })
      store.write('a:1', 'one')
      await new Promise((r) => setTimeout(r, 20))
      expect(store.writeErrors).toBe(1)

      // **非有限を素通りさせると `NaN < reopenAtMs` が偽になり、間隔が黙って効かなくなる。**
      now = Number.NaN
      for (let i = 0; i < 5; i += 1) {
        expect(store.write('a:1', 'more')).toEqual({ saved: false, reason: 'no-stream' })
      }
      await new Promise((r) => setTimeout(r, 20))
      expect(store.writeErrors).toBe(1)

      await store.close()
    })

    it('書き出す途中で失った件数を数える', async () => {
      // **流し口が壊れた回数では代わりにならない。** 積んであった分はまとめて失われるのに、
      // 異常は 1 回しか立たない（実測: 3 件積んで 3 件ともコールバックがエラーを受ける）。
      mkdirSync(join(dir, 'raw-2026-09-25.ndjson'))
      const store = new RawStore({ dir, now: () => AT_2026_09_25_2300_JST })

      // **どれも同期には成功として返る。** 失ったと判るのは後から。
      expect(store.write('a:1', 'one')).toEqual({ saved: true })
      expect(store.write('a:1', 'two')).toEqual({ saved: true })
      expect(store.write('a:1', 'three')).toEqual({ saved: true })
      await new Promise((r) => setTimeout(r, 30))

      expect(store.lostRecords).toBe(3)
      expect(store.writeErrors).toBe(1)

      await store.close()
    })

    it('締めたあとは書かない', async () => {
      const store = new RawStore({ dir, now: () => AT_2026_09_25_2300_JST })
      store.write('a:1', 'one')
      await store.close()
      expect(store.write('a:1', 'two')).toEqual({ saved: false, reason: 'closed' })
      expect(lines(join(dir, 'raw-2026-09-25.ndjson'))).toHaveLength(1)
    })
  })

  describe('締めくくりは進み具合で見る', () => {
    it('遅いだけの流し口は締め切らない', async () => {
      // **経過時間で切ると、遅いが壊れていない記憶装置でまだ渡していない分を自分で捨てる。**
      // 1 件 5ms・20 件で書き切るのに 100ms かかる相手を、50ms の間隔で見張る。
      // 単純な締め切りなら 50ms で切られて大半を失う。
      const store = new RawStore({
        dir,
        now: () => AT_2026_09_25_2300_JST,
        closeStallMs: 50,
        openStream: () => sink(5),
      })
      for (let i = 0; i < 20; i += 1) expect(store.write('a:1', `x${i}`)).toEqual({ saved: true })
      await store.close()

      expect(store.writeErrors).toBe(0)
      expect(store.lostRecords).toBe(0)
      expect(store.openFiles).toBe(0)
    })

    it('壊れた流し口も締めくくりの待ち合わせに入る', async () => {
      // **手放す口が 2 つあると、壊れた側だけが待ち合わせから漏れる。**
      // 溜まっていた分の勘定が終わる前にプロセスが終わり、失った件数がどこにも残らない。
      const store = new RawStore({
        dir,
        now: () => AT_2026_09_25_2300_JST,
        closeStallMs: 10,
        openStream: breakingSink,
      })
      for (let i = 0; i < 3; i += 1) expect(store.write('a:1', `x${i}`)).toEqual({ saved: true })
      await new Promise((r) => setTimeout(r, 30))
      await store.close()

      expect(store.writeErrors).toBe(1)
      expect(store.lostRecords).toBe(3)
      expect(store.openFiles).toBe(0)
    })

    it('書き出しが済んでいれば、閉じるのが遅くても「壊れた」と数えない', async () => {
      // **失うものが無い相手を「流し口が壊れた」と数えると、閉じるのが遅い記憶装置で
      // 日をまたぐたびに誤報が積み上がり、本物の異常が埋もれる。**
      const store = new RawStore({
        dir,
        now: () => AT_2026_09_25_2300_JST,
        closeStallMs: 20,
        openStream: slowClosingSink,
      })
      for (let i = 0; i < 3; i += 1) expect(store.write('a:1', `x${i}`)).toEqual({ saved: true })
      await store.close()

      expect(store.lostRecords).toBe(0)
      expect(store.writeErrors).toBe(0)
      expect(store.slowCloses).toBe(1)
      expect(store.openFiles).toBe(0)
    })

    it('締めている最中に壊れた流し口でも、失った件数を数える', async () => {
      // **待たずに締める。** 壊れる合図が締めくくりの最中に届く形で、
      // 上の「壊れた流し口も待ち合わせに入る」とは通る経路が違う（あちらは締める前に壊れる）。
      const store = new RawStore({
        dir,
        now: () => AT_2026_09_25_2300_JST,
        closeStallMs: 1_000,
        openStream: breakingSink,
      })
      for (let i = 0; i < 3; i += 1) expect(store.write('a:1', `x${i}`)).toEqual({ saved: true })
      await store.close()

      expect(store.lostRecords).toBe(3)
      expect(store.writeErrors).toBe(1)
      expect(store.openFiles).toBe(0)
    })

    it('止まった流し口は諦め、失った件数を数える', async () => {
      // **待ち続けない。** 返らない相手を待つと、終了の合図を受けてもプロセスが終わらない。
      const store = new RawStore({
        dir,
        now: () => AT_2026_09_25_2300_JST,
        closeStallMs: 10,
        openStream: () => sink(null),
      })
      for (let i = 0; i < 3; i += 1) expect(store.write('a:1', `x${i}`)).toEqual({ saved: true })
      await store.close()

      expect(store.writeErrors).toBe(1)
      // **諦めた時点で溜まっていた分は失われる。** 黙らせず件数として残す。
      expect(store.lostRecords).toBe(3)
      expect(store.lastWriteError).toContain('進まないので締めた')
      expect(store.openFiles).toBe(0)
    })
  })

  it('捨てた分へエラーを返す流し口でも、失った件数を二重に数えない', async () => {
    const store = new RawStore({
      dir,
      now: () => AT_2026_09_25_2300_JST,
      closeStallMs: 10,
      openStream: stalledSinkThatFailsPending,
    })
    for (let i = 0; i < 3; i += 1) store.write('a:1', `x${i}`)
    await store.close()

    // 締めくくりの側で 3 件、書き込みのコールバックでも 3 件 —— 印が無いと 6 件になる。
    expect(store.lostRecords).toBe(3)
  })

  it('書き込みがその場で投げた 1 件も、失った件数に入る', async () => {
    // **どちらの勘定にも入らない経路があった。** 件数を先に減らしてから手放すと、
    // この 1 件は手放す側の数え（溜まっていた分）にも、書き込みのコールバック
    // （同期で投げたので呼ばれない）にも入らず、黙って消えていた。
    const store = new RawStore({
      dir,
      now: () => AT_2026_09_25_2300_JST,
      closeStallMs: 10,
      openStream: sinkThatThrowsOnWrite,
    })

    expect(store.write('a:1', 'x')).toEqual({ saved: false, reason: 'write-failed' })
    await store.close()

    expect(store.lostRecords).toBe(1)
    expect(store.writeErrors).toBe(1)
  })

  it('締めるまでに書いた分を取りこぼさない', async () => {
    const store = new RawStore({ dir, now: () => AT_2026_09_25_2300_JST })
    for (let i = 0; i < 500; i += 1) store.write('a:1', payload(30))
    await store.close()

    expect(lines(join(dir, 'raw-2026-09-25.ndjson'))).toHaveLength(500)
  })

  describe('締めくくりの待ち時間の上限', () => {
    it('流し口の側がまだ待つ気でいても、上限で切り上げて返る', async () => {
      // **流し口ごとの見切り（`closeStallMs`）だけでは足りない。** 本が何冊も積まれれば
      // その分だけ待ちが伸び、掃き取りが走っていればそれも待つ。終了の合図を受けても
      // プロセスが終わらない形は、ここでしか塞げない。
      const store = new RawStore({
        dir,
        now: () => AT_2026_09_25_2300_JST,
        closeStallMs: 60_000,
        closeBudgetMs: 20,
        openStream: () => sink(null),
      })
      expect(store.write('a:1', 'x')).toEqual({ saved: true })

      const startedAt = Date.now()
      await store.close()

      // 上限が効いていなければ 60 秒待ち、その手前で時間切れになる。
      expect(Date.now() - startedAt).toBeLessThan(5_000)
      expect(store.cutShort).toBe(true)
      // **打ち切ったなら、まだ閉じ切っていない。** 0 に戻っていないことが外から見える。
      expect(store.openFiles).toBe(1)
      // **被害の大きさも読める。** 失った件数（`lostRecords`）は締め終わって初めて確定するので、
      // 打ち切るとその加算は間に合わない —— 抱えている分を集合から引けば取りこぼさない。
      expect(store.recordsAtRisk).toBe(1)
      expect(store.lostRecords).toBe(0)
    })

    it('締めくくりから戻ってこない本を、時間が経ってから数える', async () => {
      // **冊数では代用できない。** 日が変わる瞬間は新旧 2 冊が数秒共存するのが正常なので、
      // 冊数で鳴らすと毎日その瞬間に誤報が出る。かといって「2 回続けて 2 冊に見えた」で
      // 代用すると、無関係な単発の事象が 2 つ続いただけでも鳴る —— 知りたいのは
      // **同じ本が閉じ終わらずに居座っていること**。
      let t = AT_2026_09_25_2300_JST
      const store = new RawStore({
        dir,
        now: () => t,
        closeStallMs: 60_000,
        closeBudgetMs: 20,
        openStream: () => sink(null),
      })
      expect(store.write('a:1', 'x')).toEqual({ saved: true })
      await store.close()

      // 打ち切った直後はまだ「居座っている」とは言わない。
      expect(store.openFiles).toBe(1)
      expect(store.stuckBooks).toBe(0)

      t += 61_000
      expect(store.stuckBooks).toBe(1)
    })

    it('普通に締め終わったときは、打ち切ったことにしない', async () => {
      // 対照。上限を短くしても、待つものが無ければ触れない。
      const store = new RawStore({
        dir,
        now: () => AT_2026_09_25_2300_JST,
        closeBudgetMs: 50,
      })
      expect(store.write('a:1', 'x')).toEqual({ saved: true })
      await store.close()

      expect(store.cutShort).toBe(false)
      expect(store.openFiles).toBe(0)
      // 対照。締め終われば本が集合から外れ、抱えている分も居座りも 0 になる。
      expect(store.recordsAtRisk).toBe(0)
      expect(store.stuckBooks).toBe(0)
    })
  })
})
