// 津波観測情報の読み上げで、**第1波（到達時刻と押し引き）**をどう扱うかのテスト。
//
// 押し引き（`FirstHeight/Initial`）は第1波の属性で、最大波には付かない。最大波の句へ混ぜると
// 「最大波が押し波だった」という別の事実を言うことになる（→ docs/spec/audio-tts-spec.md §4）。
//
// 第1波は点ごとに一度きりの事実に見えるが、**気象庁は訂正する** —— 2024 年能登半島地震では
// 佐渡市鷲崎の到達時刻が 16時10分 から 16時32分 へ動いた（`FirstHeight/Revise` = 更新）。
import { describe, it, expect } from 'vitest'
import {
  tsunamiObservationUpdateToText,
  tsunamiArrivalToText,
  tsunamiFirstWaveToSegments,
  selectFirstWaveUpdatesToSpeak,
  FIRST_WAVE_UPDATE_SPEAK_MAX_POINTS,
} from './ttsText'
import { firstWaveSpokenKey } from './tsunami'
import type { TsunamiObservation } from '../types/earthquake'

const text = (segments: { text: string }[]) => segments.map(s => s.text).join('')

const AT = '2024-01-01T16:13:00+09:00'
const AT2 = '2024-01-01T16:35:00+09:00'

const toyama = (over: Partial<TsunamiObservation> = {}): TsunamiObservation => ({
  name: '富山',
  districtCode: '250',
  districtName: '富山県',
  height: { value: 0.5, description: '0.5m' },
  maxHeightDateTime: '2024-01-01T16:23:00+09:00',
  arrivalTime: AT,
  initial: '引き',
  ...over,
})

describe('第1波を波高の文へ織り込む', () => {
  // 正: まだ声にしていない第1波は、その地点の句の中で読む（地点名を 2 回読まないため）
  it('第1波が未読なら、波高の句へ織り込む', () => {
    const t = tsunamiObservationUpdateToText([toyama()], undefined, undefined, new Set<string>(), new Map<string, string>())
    expect(t).toContain('富山県、富山で、16時13分に引き波が到達し、16時23分に0.5メートルを観測しました。')
  })

  // 対照: 既に声にした第1波は織り込まない（二度読まない）
  it('第1波が既読なら織り込まない', () => {
    const t = tsunamiObservationUpdateToText([toyama()], undefined, undefined, new Set<string>(), new Map([['富山', firstWaveSpokenKey(toyama())!]]))
    expect(t).toContain('富山県、富山で16時23分に0.5メートルを観測しました。')
    expect(t).not.toContain('引き波')
  })

  // 対照: **訂正された第1波は織り込まない。** この句の言い回しは「〜に◯◯波が到達し」で
  // 初出の形なので、訂正をここへ入れると訂正だと聞き分けられない（訂正は「〜の◯◯波に
  // 更新されました」という別の文型で読む）。訂正を拾うのは `firstWaveChanged` の側で、
  // **そちらの除外条件も「初出だけ外す」に揃えてある**（揃えないと訂正がどの文からも落ちる）。
  it('第1波が訂正されたら織り込まない（専用の文へ回す）', () => {
    const corrected = toyama({ arrivalTime: AT2 })
    const t = tsunamiObservationUpdateToText(
      [corrected], undefined, undefined,
      new Set(['富山']),
      // 前に声にしたのは訂正前の内容。
      new Map([['富山', firstWaveSpokenKey(toyama())!]]),
    )
    expect(t).toContain('富山県、富山で16時23分に0.5メートルへ更新されました。')
    expect(t).not.toContain('到達し')
  })

  // 安全弁: 押し引きが無い電文（`Initial` は必須でない）でも到達時刻だけは読む
  it('押し引きが無ければ「第一波」と呼ぶ', () => {
    const t = tsunamiObservationUpdateToText([toyama({ initial: undefined })], undefined, undefined, new Set<string>(), new Map<string, string>())
    expect(t).toContain('16時13分に第一波が到達し')
  })

  // 安全弁: 到達時刻が無ければ句ごと落ちる（第１波識別不能の地点）
  it('到達時刻が無ければ何も織り込まない', () => {
    const t = tsunamiObservationUpdateToText(
      [toyama({ arrivalTime: undefined, initial: undefined })],
      undefined, undefined, new Set<string>(), new Map<string, string>(),
    )
    expect(t).toContain('富山県、富山で16時23分に0.5メートルを観測しました。')
    expect(t).not.toContain('到達し')
  })

  // 安全弁: 押し引きを最大波の句へ混ぜない（別の波の属性なので嘘になる）
  it('最大波の時刻に押し引きを付けない', () => {
    const t = tsunamiObservationUpdateToText([toyama()], undefined, undefined, new Set<string>(), new Map<string, string>())
    expect(t).not.toContain('16時23分に引き波')
  })
})

describe('到達確認の文にも第1波を添える', () => {
  const nanao: TsunamiObservation = {
    name: '七尾港', districtCode: '251', districtName: '石川県能登', arrivalTime: AT, initial: '押し',
  }

  // 正: 波高がまだ出ていない地点は、到達確認の文で第1波を読む
  it('時刻と押し引きを読む', () => {
    expect(tsunamiArrivalToText([nanao])).toBe(
      '次の地点で津波の到達を確認しました。石川県能登、七尾港で16時13分に押し波を観測しました。最大波高は観測中です。',
    )
  })

  // 対照: 時刻を 1 つも読めない報は従来の一文へ落とす（見出しと同じことを 2 回言わないため）
  it('時刻が無ければ従来の形に戻る', () => {
    expect(tsunamiArrivalToText([{ ...nanao, arrivalTime: undefined, initial: undefined }])).toBe(
      '石川県能登、七尾港で到達を確認しました。最大波高は観測中です。',
    )
  })

  // 安全弁: 時刻のある地点と無い地点が混ざっても、地点ごとに述語の語幹を持たせて 1 文に並べる
  it('時刻のある地点と無い地点を 1 文に並べる', () => {
    const t = tsunamiArrivalToText([nanao, { name: '岩美町田後', districtCode: '690', districtName: '鳥取県' }])
    expect(t).toContain('石川県能登、七尾港で16時13分に押し波を観測、鳥取県、岩美町田後で到達を確認しました。')
  })

  // 対照: **織り込むのは初出だけ。** この句の言い回し「〜に押し波を観測」は初出の形なので、
  // 訂正をここへ入れると訂正だと聞き分けられない。訂正は専用の文が読む。
  //
  // **切り分けを波高の文と揃えないと二重読みになる** —— 欠測から復帰した観測点は到達確認の
  // 既読（観測点名）だけが落ち、第1波の既読は残る。この文が既読を見ずに織り込むと、同じ
  // 第1波が「〜に押し波を観測」と「〜の押し波へ更新されました」の両方で読まれる。
  it('第1波が既読なら織り込まず、従来の形に戻る', () => {
    const t = tsunamiArrivalToText([nanao], undefined, new Map([['七尾港', firstWaveSpokenKey(nanao)!]]))
    expect(t).toBe('石川県能登、七尾港で到達を確認しました。最大波高は観測中です。')
    expect(t).not.toContain('押し波')
  })

  // 正: 内容が変わっていれば（訂正）も織り込まない —— 判定は「一度でも声にしたか」で、
  // 内容の一致は見ない。訂正を読むのは専用の文の役目。
  it('第1波が訂正されていても織り込まない', () => {
    const corrected = { ...nanao, arrivalTime: AT2 }
    const t = tsunamiArrivalToText([corrected], undefined, new Map([['七尾港', firstWaveSpokenKey(nanao)!]]))
    expect(t).toBe('石川県能登、七尾港で到達を確認しました。最大波高は観測中です。')
    expect(t).not.toContain('16時35分')
  })
})

describe('第1波の訂正を読み直す', () => {
  const sado: TsunamiObservation = {
    name: '佐渡市鷲崎', districtCode: '310', districtName: '佐渡', arrivalTime: AT2, initial: '押し',
  }

  // 正: 訂正は専用の文で読む。助詞は「の」（名詞句で受けるため）
  it('「〜の押し波へ更新されました」と読む', () => {
    expect(text(tsunamiFirstWaveToSegments([sado], 'updated'))).toBe(
      '次の地点で第一波が更新されました。佐渡、佐渡市鷲崎で16時35分の押し波へ更新されました。',
    )
  })

  // 対照: 対象が無ければ何も返さない
  it('対象が無ければ空', () => {
    expect(tsunamiFirstWaveToSegments([], 'updated')).toEqual([])
  })

  // 安全弁: 上限で落ちた分を黙って捨てない
  it('件数上限を超えたら「ほか◯地点」を足す', () => {
    const many = Array.from(
      { length: FIRST_WAVE_UPDATE_SPEAK_MAX_POINTS + 2 },
      (_, i) => ({ ...sado, name: `地点${i}`, districtName: `予報区${i}`, districtCode: `${i}` }),
    )
    expect(text(tsunamiFirstWaveToSegments(many, 'updated'))).toContain('ほか2地点でも更新されています。')
    expect(selectFirstWaveUpdatesToSpeak(many)).toHaveLength(FIRST_WAVE_UPDATE_SPEAK_MAX_POINTS)
  })
})

// どの句にも織り込めない初出（`FirstHeight` が `Condition`「第１波識別不能」だけだった観測点が、
// 続報で到達時刻を得る形）。波高が上がらなければ波高の文に入らず、`height` を持つので到達確認の
// 文にも入らない —— 受け皿が無いと一度も声にならず、記録も空のままで以後の訂正まで落ちる。
describe('織り込めなかった初出の第1波', () => {
  const kuji: TsunamiObservation = {
    name: '久慈港', districtCode: '210', districtName: '岩手県',
    height: { value: 4.4, description: '4.4m' }, arrivalTime: AT, initial: '押し',
  }

  // 正: 初出は「〜に押し波を観測しました」（動詞が続くので助詞は「に」）
  it('初出は到達確認の言い方で読む', () => {
    expect(text(tsunamiFirstWaveToSegments([kuji], 'new'))).toBe(
      '次の地点で第一波の到達を確認しました。岩手県、久慈港で16時13分に押し波を観測しました。',
    )
  })

  // 安全弁: 初出でも「最大波高は観測中です」を付けない（この地点は波高を持っている）
  it('初出でも「最大波高は観測中です」を付けない', () => {
    expect(text(tsunamiFirstWaveToSegments([kuji], 'new'))).not.toContain('観測中')
  })

  // 対照: 訂正の側は名詞句で受けるので助詞が「の」になる
  it('訂正は助詞が「の」', () => {
    expect(text(tsunamiFirstWaveToSegments([kuji], 'updated'))).toContain('16時13分の押し波へ更新されました。')
  })
})

describe('firstWaveSpokenKey', () => {
  // 正: 到達時刻と押し引きの組を鍵にする（どちらが動いても変化として捉える）
  it('時刻が動けば鍵が変わる', () => {
    expect(firstWaveSpokenKey({ arrivalTime: AT, initial: '押し' }))
      .not.toBe(firstWaveSpokenKey({ arrivalTime: AT2, initial: '押し' }))
  })

  // 正: 押し引きだけが直った形も捉える
  it('押し引きが動けば鍵が変わる', () => {
    expect(firstWaveSpokenKey({ arrivalTime: AT, initial: '押し' }))
      .not.toBe(firstWaveSpokenKey({ arrivalTime: AT, initial: '引き' }))
  })

  // 対照: 同じ内容なら同じ鍵（再送で読み直さない）
  it('同じ内容なら同じ鍵', () => {
    expect(firstWaveSpokenKey({ arrivalTime: AT, initial: '押し' }))
      .toBe(firstWaveSpokenKey({ arrivalTime: AT, initial: '押し' }))
  })

  // 安全弁: 到達時刻が無ければ鍵を作らない（声にできるものが無いので記録もしない）
  it('到達時刻が無ければ null', () => {
    expect(firstWaveSpokenKey({ initial: '押し' })).toBeNull()
  })

  // 安全弁: 日時として読めない値でも鍵を作らない。作ると「変化あり」と判定される一方、
  // 実際に声にする側（`firstWaveParts`）は句ごと落とすので、「〇〇で更新されました。」とだけ
  // 読む空疎な発話になる（いつの・どちらの第1波かを一言も言わない）。判定と発話で条件を揃える。
  it('日時として読めない到達時刻では null', () => {
    expect(firstWaveSpokenKey({ arrivalTime: '壊れた値', initial: '押し' })).toBeNull()
  })
})
