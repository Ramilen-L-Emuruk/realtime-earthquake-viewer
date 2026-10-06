import { describe, expect, it } from 'vitest'

import { childOf, escapeXml, parseXml, XmlReadError } from './xmlLite'

describe('parseXml', () => {
  it('要素・属性・文字を読み、名前空間を URI で引く', () => {
    const root = parseXml(
      '<?xml version="1.0" encoding="UTF-8"?>\n<a xmlns="urn:a" xmlns:b="urn:b" k="1"><b:c x=\'2\'>text</b:c><d/></a>',
    )
    expect(root.ns).toBe('urn:a')
    expect(root.local).toBe('a')
    expect(root.attrs.get('k')).toBe('1')
    // xmlns の宣言は属性に混ぜない。
    expect(root.attrs.has('xmlns')).toBe(false)
    const c = childOf(root, 'urn:b', 'c')
    expect(c?.text).toBe('text')
    expect(c?.attrs.get('x')).toBe('2')
    expect(childOf(root, 'urn:a', 'd')).not.toBeNull()
  })

  it('接頭辞が違っても、同じ URI なら同じ要素として引ける', () => {
    // 道具で整形し直されて接頭辞が変わったファイルでも読めること。
    const root = parseXml('<x:a xmlns:x="urn:a"><y:b xmlns:y="urn:b">1</y:b></x:a>')
    expect(childOf(root, 'urn:b', 'b')?.text).toBe('1')
  })

  it('文字参照を戻す（定義済みの 5 つと数値参照）', () => {
    const root = parseXml('<a v="&quot;&amp;&apos;">&lt;&gt;&#x3042;&#12354;</a>')
    expect(root.attrs.get('v')).toBe(`"&'`)
    expect(root.text).toBe('<>ああ')
  })

  it('escapeXml で逃がした文字列は、読み戻すと元に戻る', () => {
    const raw = `<書斎 & "居間" の'東'>`
    const root = parseXml(`<a v="${escapeXml(raw)}">${escapeXml(raw)}</a>`)
    expect(root.attrs.get('v')).toBe(raw)
    expect(root.text).toBe(raw)
  })

  it('escapeXml は TAB・LF・CR を文字参照にし、属性値でも読み戻すと元に戻る', () => {
    const raw = '書斎\t1 階\n東側\r'
    const escaped = escapeXml(raw)
    expect(escaped).toBe('書斎&#9;1 階&#10;東側&#13;')
    const root = parseXml(`<a v="${escaped}">${escaped}</a>`)
    expect(root.attrs.get('v')).toBe(raw)
    expect(root.text).toBe(raw)
  })

  it('escapeXml は XML に書けない文字（制御文字・対になっていないサロゲート）で投げる', () => {
    expect(() => escapeXml('a\u0001b')).toThrow(/XML に書けない文字/)
    expect(() => escapeXml('a\uD800b')).toThrow(/XML に書けない文字/)
    // 安全弁: 対になったサロゲート（BMP 外の文字）は書ける。
    expect(escapeXml('a\u{1F600}b')).toBe('a\u{1F600}b')
  })

  it('XML に書けない文字を指す数値参照は読めないとする', () => {
    expect(() => parseXml('<a>&#1;</a>')).toThrow(XmlReadError)
    expect(() => parseXml('<a>&#xD800;</a>')).toThrow(XmlReadError)
    expect(parseXml('<a>&#9;</a>').text).toBe('\t')
  })

  it('コメントと先頭の BOM は読み飛ばす', () => {
    const root = parseXml('﻿<!-- 先頭 --><a><!-- 中 -->x</a>')
    expect(root.text).toBe('x')
  })

  it.each([
    ['閉じていない', '<a><b></a>'],
    ['閉じタグが合わない', '<a></b>'],
    ['最後まで閉じていない', '<a>'],
    ['根が 2 つ', '<a/><b/>'],
    ['根の外の文字', '<a/>x'],
    ['DOCTYPE', '<!DOCTYPE a><a/>'],
    ['CDATA', '<a><![CDATA[x]]></a>'],
    ['知らない実体参照', '<a>&nbsp;</a>'],
    ['宣言の無い接頭辞', '<p:a/>'],
    ['属性の重複', '<a k="1" k="2"/>'],
    ['引用符の無い属性', '<a k=1/>'],
    ['空', ''],
  ])('読めない形は投げる: %s', (_, source) => {
    expect(() => parseXml(source)).toThrow(XmlReadError)
  })
})
