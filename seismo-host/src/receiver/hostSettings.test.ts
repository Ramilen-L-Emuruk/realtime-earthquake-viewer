import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  EMPTY_HOST_SETTINGS,
  dirsUnder,
  isInside,
  parseHostSettings,
  readHostSettings,
  resolveStorage,
  samePath,
  storageRootProblem,
  writeHostSettings,
} from './hostSettings'

const DEFAULT_ROOT = join(tmpdir(), 'seismo-default-root')
const OTHER = join(tmpdir(), 'seismo-other-root')
const THIRD = join(tmpdir(), 'seismo-third-root')

describe('resolveStorage', () => {
  it('何も無ければ既定の親フォルダの下に 4 つを並べる', () => {
    const r = resolveStorage({ env: {}, settings: EMPTY_HOST_SETTINGS, defaultRoot: DEFAULT_ROOT })
    expect(r.source).toBe('default')
    expect(r.root).toBe(DEFAULT_ROOT)
    expect(r.dirs).toEqual(dirsUnder(DEFAULT_ROOT))
    expect(r.movedFrom).toBeNull()
    expect(r.nextSettings).toBeNull()
  })

  it('待っている変更は昇格させ、前の親フォルダを複製元として返す', () => {
    const r = resolveStorage({
      env: {},
      settings: { dataRoot: null, pendingDataRoot: OTHER },
      defaultRoot: DEFAULT_ROOT,
    })
    expect(r.source).toBe('settings')
    expect(r.dirs).toEqual(dirsUnder(OTHER))
    expect(r.movedFrom).toBe(DEFAULT_ROOT)
    expect(r.nextSettings).toEqual({ dataRoot: OTHER, pendingDataRoot: null })
  })

  it('2 度目の移動では、設定の保存先が複製元になる', () => {
    const r = resolveStorage({
      env: {},
      settings: { dataRoot: OTHER, pendingDataRoot: THIRD },
      defaultRoot: DEFAULT_ROOT,
    })
    expect(r.movedFrom).toBe(OTHER)
    expect(r.dirs).toEqual(dirsUnder(THIRD))
  })

  it('対照: 待ちが今と同じ場所なら移さず、待ちだけ片付ける', () => {
    const r = resolveStorage({
      env: {},
      settings: { dataRoot: OTHER, pendingDataRoot: OTHER },
      defaultRoot: DEFAULT_ROOT,
    })
    expect(r.movedFrom).toBeNull()
    expect(r.nextSettings).toEqual({ dataRoot: OTHER, pendingDataRoot: null })
  })

  it('安全弁: 環境変数が 1 つでもあれば待っている変更は効かないと返し、足りない種類はいまの保存先に置いたまま（既定へ戻さない）', () => {
    const r = resolveStorage({
      env: { SEISMO_RAW_DIR: join(THIRD, 'r') },
      settings: { dataRoot: OTHER, pendingDataRoot: THIRD },
      defaultRoot: DEFAULT_ROOT,
    })
    expect(r.source).toBe('env')
    expect(r.root).toBeNull()
    expect(r.dirs.raw).toBe(join(THIRD, 'r'))
    // 既定へ戻すと、画面で移した後に環境変数を 1 つ足しただけで残りの種類が既定の場所へ書き始める。
    expect(r.dirs.wave).toBe(dirsUnder(OTHER).wave)
    expect(r.nextSettings).toBeNull()
    expect(r.pendingIgnored).toBe(THIRD)
  })

  it('対照: 設定の保存先が無ければ、足りない種類は既定の置き場所', () => {
    const r = resolveStorage({
      env: { SEISMO_RAW_DIR: join(THIRD, 'r') },
      settings: EMPTY_HOST_SETTINGS,
      defaultRoot: DEFAULT_ROOT,
    })
    expect(r.dirs.wave).toBe(dirsUnder(DEFAULT_ROOT).wave)
  })

  it('空の環境変数は無いのと同じに扱う', () => {
    const r = resolveStorage({ env: { SEISMO_WAVE_DIR: '' }, settings: EMPTY_HOST_SETTINGS, defaultRoot: DEFAULT_ROOT })
    expect(r.source).toBe('default')
  })
})

describe('storageRootProblem', () => {
  it('相対パスを弾く', () => {
    expect(storageRootProblem('data2', DEFAULT_ROOT)).toBe('not-absolute')
  })
  it('今と同じ場所を弾く（Windows では大文字・小文字と末尾の区切りを無視する）', () => {
    expect(storageRootProblem('C:\\Data\\Seismo\\', 'c:\\data\\seismo', 'win32')).toBe('same')
  })
  it('入れ子を両方向とも弾く', () => {
    expect(storageRootProblem(join(DEFAULT_ROOT, 'sub'), DEFAULT_ROOT)).toBe('nested')
    expect(storageRootProblem(tmpdir(), DEFAULT_ROOT)).toBe('nested')
  })
  it('対照: 名前の頭が同じだけの隣のフォルダは入れ子ではない', () => {
    expect(isInside(`${DEFAULT_ROOT}2`, DEFAULT_ROOT)).toBe(false)
    expect(storageRootProblem(`${DEFAULT_ROOT}2`, DEFAULT_ROOT)).toBeNull()
  })
  it('samePath は解決してから比べる', () => {
    expect(samePath(join(DEFAULT_ROOT, 'a', '..'), DEFAULT_ROOT)).toBe(true)
  })
})

describe('設定ファイル', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it('書いて読み戻せる', () => {
    dir = mkdtempSync(join(tmpdir(), 'host-settings-'))
    const path = join(dir, 'config', 'host-settings.json')
    writeHostSettings(path, { dataRoot: OTHER, pendingDataRoot: null })
    expect(readHostSettings(path)).toEqual({ dataRoot: OTHER, pendingDataRoot: null })
  })

  it('無ければ空の設定', () => {
    dir = mkdtempSync(join(tmpdir(), 'host-settings-'))
    expect(readHostSettings(join(dir, 'none.json'))).toEqual(EMPTY_HOST_SETTINGS)
  })

  it('安全弁: 壊れていれば既定へ倒さず投げる（データが 2 か所に割れる）', () => {
    dir = mkdtempSync(join(tmpdir(), 'host-settings-'))
    const path = join(dir, 'host-settings.json')
    writeFileSync(path, '{"dataRoot": 3}')
    expect(() => readHostSettings(path)).toThrow(/形が合わない/)
    writeFileSync(path, 'not json')
    expect(() => readHostSettings(path)).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('not json')
  })

  it('相対パスの保存先は読み取りで弾く', () => {
    expect(parseHostSettings('{"dataRoot":"data"}')).toBeNull()
    expect(parseHostSettings('{"dataRoot":null}')).toEqual(EMPTY_HOST_SETTINGS)
  })
})
