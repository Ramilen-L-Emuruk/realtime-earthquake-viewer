import { describe, it, expect } from 'vitest'
import { convertEvent } from './p2pquake'
import type { EEWAlert } from '../types/earthquake'

describe('convertEvent', () => {
  describe('code=556（EEW）', () => {
    it('kind=eew と severity=Warning を必ず付与する（P2PQuake ペイロードに severity フィールドは無いため）', () => {
      const result = convertEvent({ code: 556, id: 'test-1', time: '2026-01-01T00:00:00Z' })
      expect(result).not.toBeNull()
      expect(result!.kind).toBe('eew')
      expect((result as EEWAlert).severity).toBe('Warning')
    })

    it('生ペイロードに severity フィールドがあっても Warning で確定させる（将来の API 変更に対する保険）', () => {
      const result = convertEvent({ code: 556, id: 'test-2', severity: 'Forecast' })
      expect((result as EEWAlert).severity).toBe('Warning')
    })

    it('その他のフィールドは透過する', () => {
      const result = convertEvent({ code: 556, id: 'abc', extra: 42 })
      expect(result).not.toBeNull()
      expect((result as unknown as { id: string }).id).toBe('abc')
      expect((result as unknown as { extra: number }).extra).toBe(42)
    })
  })

  describe('code=551（地震情報）', () => {
    it('kind=quake を付与し severity は付与しない', () => {
      const result = convertEvent({ code: 551, id: 'q-1' })
      expect(result!.kind).toBe('quake')
      expect((result as unknown as { severity?: unknown }).severity).toBeUndefined()
    })
  })

  describe('code=552（津波）', () => {
    it('kind=tsunami を付与する', () => {
      const result = convertEvent({ code: 552, id: 't-1' })
      expect(result!.kind).toBe('tsunami')
    })
  })

  describe('未対応 code', () => {
    it('null を返す', () => {
      expect(convertEvent({ code: 9999 })).toBeNull()
    })
  })

  describe('issue.type / issue.correct / earthquake.domesticTsunami の変換', () => {
    it('issue.type の英語コードを日本語に変換する', () => {
      const result = convertEvent({ code: 551, issue: { type: 'ScalePrompt' } })
      expect((result as unknown as { issue: { type: string } }).issue.type).toBe('震度速報')
    })

    it('未知の issue.type は「その他」にフォールバックする（将来の API 拡張時に UI が壊れないため）', () => {
      const result = convertEvent({ code: 551, issue: { type: 'FutureType' } })
      expect((result as unknown as { issue: { type: string } }).issue.type).toBe('その他')
    })

    it('issue.correct の英語コードを日本語に変換し、未知値は「なし」にフォールバック', () => {
      const known = convertEvent({ code: 551, issue: { correct: 'ScaleOnly' } })
      expect((known as unknown as { issue: { correct: string } }).issue.correct).toBe('震度のみ訂正')
      const unknown = convertEvent({ code: 551, issue: { correct: 'FooBar' } })
      expect((unknown as unknown as { issue: { correct: string } }).issue.correct).toBe('なし')
    })

    it('earthquake.domesticTsunami の英語コードを日本語に変換し、未知値は「不明」にフォールバック', () => {
      const known = convertEvent({ code: 551, earthquake: { domesticTsunami: 'Warning' } })
      expect((known as unknown as { earthquake: { domesticTsunami: string } }).earthquake.domesticTsunami).toBe('警報等')
      const unknown = convertEvent({ code: 551, earthquake: { domesticTsunami: 'FooBar' } })
      expect((unknown as unknown as { earthquake: { domesticTsunami: string } }).earthquake.domesticTsunami).toBe('不明')
    })
  })
})
