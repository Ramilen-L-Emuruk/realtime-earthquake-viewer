// 地震情報タブで、どのカードを見える位置へ寄せるか（→ quakeCardScroll.ts）。
//
// 縦長の画面で、取消になったカードが一覧の枠の外へ押し出されて読めなくなっていた。
// 読み上げが有効なら「いま語っているカード」を最優先し、次に取消の表示が出ているカード、最後に選択中のカード。
import { describe, it, expect } from 'vitest'
import { quakeCardScrollTarget, type QuakeCardScrollInput } from './quakeCardScroll'
import type { JMAQuake } from '../types/earthquake'

function quake(eventKey: string, id: string, cancelledAt?: Date): JMAQuake {
  return {
    kind: 'quake',
    id,
    eventKey,
    time: '2024-01-01T23:05:00+09:00',
    issue: { source: '気象庁', time: '2024-01-01T23:05:00+09:00', type: '震度速報', correct: 'なし' },
    earthquake: { time: '2024-01-01T23:04:00+09:00', hypocenter: { name: '', latitude: -200, longitude: -200, depth: -1, magnitude: -1 }, maxScale: 70, domesticTsunami: '調査中' },
    points: [],
    ...(cancelledAt && { cancelledAt }),
  } as unknown as JMAQuake
}

const target = (input: Partial<QuakeCardScrollInput> & Pick<QuakeCardScrollInput, 'earthquakes'>) =>
  quakeCardScrollTarget({ selectedKey: null, speakingKey: null, followSpeech: false, ...input })

describe('quakeCardScrollTarget — 読み上げが有効なとき（声に合わせる）', () => {
  // 正: 語っているカードを、取消の表示・選択中のカードより先に選ぶ。別のカードを読んでいる最中に
  //     無関係な地震が取り消されても、読んでいるあいだは読んでいるカードを見せる。
  it('語っているカードを取消の表示・選択中のカードより優先する', () => {
    const list = [quake('A', 'a1'), quake('B', 'b1'), quake('C', 'c1', new Date(1000))]
    expect(target({ earthquakes: list, selectedKey: 'A', speakingKey: 'B', followSpeech: true })?.key).toBe('B')
  })

  // 正: 取消を読み上げているあいだは取消カード。
  it('取消を読み上げているあいだは取消カードを選ぶ', () => {
    const list = [quake('A', 'a1'), quake('C', 'c1', new Date(1000))]
    expect(target({ earthquakes: list, selectedKey: 'A', speakingKey: 'C', followSpeech: true })?.key).toBe('C')
  })

  // 正（覆した挙動）: 語っていなくても、取消の表示が出ていれば取消カードを選ぶ。以前は「語ったときだけ
  //     寄せる」としていたが、選択中のカードそのものが取り消されると、受け取った瞬間に選択が次のカードへ
  //     移って寄り、遅れて始まる取消の読み上げで戻る —— 2 度動いていた。
  it('語っていなくても、取消の表示が出ていれば取消カードを選ぶ', () => {
    const list = [quake('A', 'a1', new Date(1000)), quake('B', 'b1')]
    expect(target({ earthquakes: list, selectedKey: 'B', followSpeech: true })?.key).toBe('A')
  })

  // 正: 取消を読み終えても、表示が消えるまでは取消カードに留まる（相手は同じ。合図が変わっても
  //     寄せる量は「収まっていれば動かさない」で 0 になる）。
  it('取消を読み終えたあとも、表示が消えるまでは取消カードを選ぶ', () => {
    const list = [quake('A', 'a1'), quake('C', 'c1', new Date(1000))]
    expect(target({ earthquakes: list, selectedKey: 'A', speakingKey: null, followSpeech: true })?.key).toBe('C')
  })

  // 正: 語っているあいだに続報が届いたら（`id` が変わる）頭へ揃え直す。
  it('語っているカードへ続報が届くと合図が変わる', () => {
    const before = target({ earthquakes: [quake('A', 'a1')], speakingKey: 'A', followSpeech: true })!
    const after = target({ earthquakes: [quake('A', 'a2')], speakingKey: 'A', followSpeech: true })!
    expect(after.signature).not.toBe(before.signature)
  })

  // 対照: 語っておらず取消の表示も無ければ選択中のカード。
  it('語っておらず取消の表示も無ければ選択中のカードを選ぶ', () => {
    expect(target({ earthquakes: [quake('A', 'a1'), quake('B', 'b1')], selectedKey: 'A', followSpeech: true })?.key).toBe('A')
  })

  // 対照: 語っていないあいだは、続報が届いても寄せ直さない（読み上げが始まった時点で寄る）。
  //       受信と読み上げの両方で寄せると、通知音の長さだけずれて 2 度動く。
  it('語っていないあいだは、選択中のカードの続報では合図が変わらない', () => {
    const before = target({ earthquakes: [quake('A', 'a1')], selectedKey: 'A', followSpeech: true })!
    const after = target({ earthquakes: [quake('A', 'a2')], selectedKey: 'A', followSpeech: true })!
    expect(after.signature).toBe(before.signature)
  })

  // 正: 語り終わったら選択中のカードへ戻る（相手が替わるので寄せ直す）。
  it('語り終わると選択中のカードへ戻り、合図が変わる', () => {
    const list = [quake('A', 'a1'), quake('C', 'c1')]
    const speaking = target({ earthquakes: list, selectedKey: 'A', speakingKey: 'C', followSpeech: true })!
    const done = target({ earthquakes: list, selectedKey: 'A', speakingKey: null, followSpeech: true })!
    expect(done.key).toBe('A')
    expect(done.signature).not.toBe(speaking.signature)
  })

  // 安全弁: 語っている地震のカードが一覧に無ければ（取消カードが片付いた後に取消を読む等）、
  //         選択中のカードへ落ちる。
  it('語っている地震のカードが一覧に無ければ選択中のカードを選ぶ', () => {
    expect(target({ earthquakes: [quake('A', 'a1')], selectedKey: 'A', speakingKey: 'Z', followSpeech: true })?.key).toBe('A')
  })
})

describe('quakeCardScrollTarget — 読み上げが無効なとき（受信した時点で寄せる）', () => {
  // 正: 取消の表示が出ているカードを、選択中のカードより先に選ぶ。
  it('取消の表示が出ているカードを、選択中のカードより優先する', () => {
    const list = [quake('A', 'a1', new Date(1000)), quake('B', 'b1')]
    expect(target({ earthquakes: list, selectedKey: 'B' })?.key).toBe('A')
  })

  // 正: 先頭でないカードが取り消されても、そのカードへ寄せる。
  it('一覧の途中のカードが取り消されても、そのカードを選ぶ', () => {
    const list = [quake('A', 'a1'), quake('B', 'b1'), quake('C', 'c1', new Date(1000))]
    expect(target({ earthquakes: list, selectedKey: 'A' })?.key).toBe('C')
  })

  // 正: 取消の表示が重なったら、いちばん新しく取り消されたものを選ぶ。
  it('取消の表示が複数あれば、いちばん新しく取り消されたものを選ぶ', () => {
    const list = [quake('A', 'a1', new Date(1000)), quake('B', 'b1', new Date(2000))]
    expect(target({ earthquakes: list })?.key).toBe('B')
  })

  // 対照: 取消の表示が無ければ、選択中のカードへ寄せる。
  it('取消の表示が無ければ、選択中のカードを選ぶ', () => {
    expect(target({ earthquakes: [quake('A', 'a1'), quake('B', 'b1')], selectedKey: 'B' })?.key).toBe('B')
  })

  // 対照: 寄せる相手が無ければ何もしない。
  it('取消も選択も無ければ null', () => {
    expect(target({ earthquakes: [quake('A', 'a1')] })).toBeNull()
    expect(target({ earthquakes: [quake('A', 'a1')], selectedKey: 'Z' })).toBeNull()
  })

  // 正: 選択中のカードへ続報が届いたら寄せ直す（震度速報 → 震源 → 震源・震度と伸びていく頭へ揃える）。
  it('選択中のカードへ続報が届くと合図が変わる', () => {
    const before = target({ earthquakes: [quake('A', 'a1')], selectedKey: 'A' })!
    const after = target({ earthquakes: [quake('A', 'a2')], selectedKey: 'A' })!
    expect(after.key).toBe(before.key)
    expect(after.signature).not.toBe(before.signature)
  })

  // 正: 取消が付いた・取消のカードが消えた、のどちらでも合図が変わる（相手が替わるため）。
  it('取消が付いたとき・取消のカードが消えたときに合図が変わる', () => {
    const selected = target({ earthquakes: [quake('A', 'a1'), quake('B', 'b1')], selectedKey: 'A' })!
    const cancelled = target({ earthquakes: [quake('A', 'a1', new Date(1000)), quake('B', 'b1')], selectedKey: 'B' })!
    const purged = target({ earthquakes: [quake('B', 'b1')], selectedKey: 'B' })!
    expect(cancelled.signature).not.toBe(selected.signature)
    expect(purged.signature).not.toBe(cancelled.signature)
    expect(purged.key).toBe('B')
  })

  // 安全弁: 読み上げが無効なら、語っている鍵が渡ってきても見ない（無効の端末では声が出ない）。
  it('語っている鍵があっても見ない', () => {
    expect(target({ earthquakes: [quake('A', 'a1'), quake('B', 'b1')], selectedKey: 'A', speakingKey: 'B' })?.key).toBe('A')
  })

  // 安全弁: 寄せる相手の報が変わらないかぎり、ほかのカードが増えても合図は変わらない。
  it('ほかのカードの出入りでは合図が変わらない', () => {
    const before = target({ earthquakes: [quake('B', 'b1')], selectedKey: 'B' })!
    const after = target({ earthquakes: [quake('C', 'c1'), quake('B', 'b1')], selectedKey: 'B' })!
    expect(after.signature).toBe(before.signature)
  })
})
