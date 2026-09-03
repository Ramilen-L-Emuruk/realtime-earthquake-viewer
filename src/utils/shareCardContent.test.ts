import { describe, expect, it } from 'vitest'
import type { MapMode } from '../components/Map/mapTypes'
import type { EEWAlert, JMAQuake, JMATsunami } from '../types/earthquake'
import { ATTRIBUTION_SOURCES, EEW_NOTICE } from './shareCard'
import { buildShareCardContent, type ShareCardContent, type ShareCardContentInput } from './shareCardContent'

function quake(over: { maxScale?: number; magnitude?: number; depth?: number } = {}): JMAQuake {
  return {
    id: 'q1',
    time: '2026/08/24 12:35:00',
    issue: { source: '', time: '', type: '震源・震度情報' },
    earthquake: {
      time: '2026/08/24 12:34:00',
      hypocenter: {
        name: '日向灘',
        latitude: 32,
        longitude: 131.6,
        depth: over.depth ?? 30,
        magnitude: over.magnitude ?? 5.2,
      },
      maxScale: over.maxScale ?? 40,
      domesticTsunami: 'None',
    },
    points: [],
  } as unknown as JMAQuake
}

function eew(
  over: { severity?: string; scaleTo?: number; cancelled?: boolean; name?: string; condition?: string } = {},
): EEWAlert {
  return {
    id: 'e1',
    earthquake: {
      originTime: '2026/08/24 12:34:00',
      condition: over.condition ?? '',
      hypocenter: { name: over.name ?? '日向灘', latitude: 32, longitude: 131.6, depth: 30, magnitude: 6.5 },
    },
    severity: over.severity ?? 'Forecast',
    cancelled: over.cancelled ?? false,
    areas: [{ pref: '宮崎県', name: '宮崎県南部平野部', scaleFrom: 40, scaleTo: over.scaleTo ?? 45 }],
  } as unknown as EEWAlert
}

/** 本文の末尾に入るアプリの URL。実際の値は `standardAppUrl` の担当（shareCard.test.ts）。 */
const APP_URL = 'https://example.test/realtime-earthquake-viewer/'

/** 見出しと出典を見るテストは URL を気にしないので、既定の URL で包んで呼ぶ。 */
function build(i: ShareCardContentInput): ShareCardContent {
  return buildShareCardContent(i, APP_URL)
}

function tsunami(over: { grade?: string; areaName?: string } = {}): JMATsunami {
  return {
    kind: 'tsunami',
    id: 't1',
    time: '2026/08/24 12:40:00',
    cancelled: false,
    issue: { source: '', time: '2026/08/24 12:40:00', type: 'Focus' },
    sourceEarthquake: { hypocenterName: '日向灘', magnitude: 8.1 },
    areas: [{ grade: over.grade ?? 'MajorWarning', immediate: false, name: over.areaName ?? '宮崎県' }],
  } as unknown as JMATsunami
}

/** 既定は「海底地形も活断層もプレート境界も表示している」＝アプリの既定設定に合わせる。 */
function input(over: Partial<ShareCardContentInput> & { mode: MapMode }): ShareCardContentInput {
  return {
    quake: null,
    tsunamis: [],
    eews: [],
    showBathymetry: true,
    showActiveFaults: true,
    showPlateBoundaries: true,
    ...over,
  }
}

describe('buildShareCardContent — 地震', () => {
  it('最大震度を見出しにし、震源・規模・深さを副見出しに並べる', () => {
    const c = build(input({ mode: 'quake', quake: quake() }))
    expect(c.header.title.startsWith('最大震度 ')).toBe(true)
    expect(c.header.subtitle).toContain('日向灘')
    expect(c.header.subtitle).toContain('M5.2')
    expect(c.header.subtitle).toContain('深さ 30km')
  })

  // 震度を伝えない電文（震源情報など）は maxScale がセンチネルで届く。「最大震度 不明」と
  // 書くくらいなら見出しを種別名に落とす。
  it('震度が階級表に無い値なら見出しを「地震情報」に落とす', () => {
    const c = build(input({ mode: 'quake', quake: quake({ maxScale: -1 }) }))
    expect(c.header.title).toBe('地震情報')
    expect(c.header.titleColor).toBeUndefined()
  })

  // 「不明」という語を並べても読み手には何も伝わらない。項目ごと落とす。
  it('規模・深さが不明なら副見出しから項目ごと落とす', () => {
    const c = build(input({ mode: 'quake', quake: quake({ magnitude: NaN, depth: -1 }) }))
    expect(c.header.subtitle).toBe('日向灘')
    expect(c.header.subtitle).not.toContain('不明')
  })

  it('地震が無くても見出しだけは作る', () => {
    const c = build(input({ mode: 'quake' }))
    expect(c.header.title).toBe('地震情報')
  })
})

describe('buildShareCardContent — 出典', () => {
  it('気象庁の出典は常に入る', () => {
    const c = build(input({ mode: 'quake', quake: quake() }))
    const line = c.notices.join('\n')
    expect(line).toContain(ATTRIBUTION_SOURCES.jma)
    expect(line).toContain('加工して作成')
  })

  // 海底地形は設定で消せる。消していれば画像に写らないので挙げない。
  it('海底地形は表示しているときだけ挙げる', () => {
    const shown = build(input({ mode: 'quake', quake: quake() }))
    expect(shown.notices.join('\n')).toContain(ATTRIBUTION_SOURCES.bathymetry)
    const hidden = build(input({ mode: 'quake', quake: quake(), showBathymetry: false }))
    expect(hidden.notices.join('\n')).not.toContain(ATTRIBUTION_SOURCES.bathymetry)
  })

  // 境界線・活断層・プレート境界は元データを変換して使っている（加工にあたる）が、海底地形は
  // 配信されるタイルをそのまま描いている。まとめて「加工して作成」で括ると、加工していない
  // ものまで加工したと述べることになる。
  it('海底地形は「加工して作成」の側に含めない', () => {
    const c = build(input({ mode: 'quake', quake: quake() }))
    const line = c.notices.join('\n')
    const derivedPart = line.slice(line.indexOf('／'))
    expect(derivedPart).toContain('加工して作成')
    expect(derivedPart).not.toContain(ATTRIBUTION_SOURCES.bathymetry)
  })

  // プレート境界の出典（PB2002）は Open Data Commons Attribution License で、
  // 成果物を公に利用する際の帰属表示が利用条件そのもの。描いているのに挙げないのは違反になる。
  it('活断層・プレート境界を描いているなら出典に挙げる', () => {
    const c = build(input({ mode: 'quake', quake: quake() }))
    const line = c.notices.join('\n')
    expect(line).toContain(ATTRIBUTION_SOURCES.activeFaults)
    expect(line).toContain(ATTRIBUTION_SOURCES.plateBoundaries)
  })

  it('表示を切っているものは出典に挙げない', () => {
    const c = build(
      input({ mode: 'quake', quake: quake(), showActiveFaults: false, showPlateBoundaries: false }),
    )
    const line = c.notices.join('\n')
    expect(line).not.toContain(ATTRIBUTION_SOURCES.activeFaults)
    expect(line).not.toContain(ATTRIBUTION_SOURCES.plateBoundaries)
    expect(line).toContain(ATTRIBUTION_SOURCES.jma)
  })

  // 活断層とプレート境界は地震／リアルタイム震度モードでしか描かれない（JapanMapGL の
  // showOverlayLines）。設定が入りでも津波モードの画像には写らないので挙げない。
  it('津波モードでは、設定が入りでも活断層・プレート境界を挙げない', () => {
    const c = build(input({ mode: 'tsunami' }))
    const line = c.notices.join('\n')
    expect(line).not.toContain(ATTRIBUTION_SOURCES.activeFaults)
    expect(line).not.toContain(ATTRIBUTION_SOURCES.plateBoundaries)
  })
})

describe('buildShareCardContent — 緊急地震速報の注意文', () => {
  // **要点**: 緊急地震速報の予報円と震源は、地図のモードに関わらず描かれる（JapanMapGL の
  // PsWaveGL / EewEpicentersGL）。モードで注意文の要否を決めると、地震モードで撮ったカードに
  // 予報円が写っているのに注意文が無い、という状態を作れてしまう。
  it('地震モードでも、発報中の緊急地震速報があれば注意文を入れる', () => {
    const c = build(input({ mode: 'quake', quake: quake(), eews: [eew()] }))
    expect(c.notices[0]).toBe(EEW_NOTICE)
  })

  it('取り消された緊急地震速報では注意文を入れない', () => {
    const c = build(input({ mode: 'kyoshin', eews: [eew({ cancelled: true })] }))
    expect(c.notices).not.toContain(EEW_NOTICE)
  })

  // 精度の話だけを残すと、速報が届く前に揺れが来る場合があるという行動に直結する留保が
  // 伝わらない。文言を縮めるときもこの部分は落とさない。
  it('注意文は精度だけでなく「間に合わないことがある」まで伝える', () => {
    expect(EEW_NOTICE).toContain('間に合わない')
    expect(EEW_NOTICE).toContain('誤報')
  })
})

describe('buildShareCardContent — 緊急地震速報', () => {
  it('区分と予想最大震度を見出しに出す', () => {
    const c = build(input({ mode: 'kyoshin', eews: [eew({ severity: 'Warning' })] }))
    expect(c.header.title).toBe('緊急地震速報')
    expect(c.header.subtitle).toContain('予想最大震度')
  })

  // 並びは発報を受けた順で深刻さとは無関係。先頭を採ると、連続する余震や離れた 2 地域で
  // ほぼ同時に起きたときに弱い方を見出しにしてしまう。
  it('複数発報しているときは受信順ではなく深刻な方を見出しにする', () => {
    const mild = eew({ severity: 'Forecast', scaleTo: 30, name: '和歌山県北部' })
    const severe = eew({ severity: 'Warning', scaleTo: 55, name: '日向灘' })
    const c = build(input({ mode: 'kyoshin', eews: [mild, severe] }))
    expect(c.header.title).toBe('緊急地震速報')
    expect(c.header.subtitle).toContain('日向灘')
  })

  // 仮定震源要素の報は、電文に数値が入っていても地震学的に意味を持たない仮の値。
  // 画面（RealtimeTab）は隠しているので、共有した後で訂正できない画像でも隠す。
  it('仮定震源要素では規模を出さない', () => {
    const c = build(input({ mode: 'kyoshin', eews: [eew({ condition: '仮定震源要素' })] }))
    expect(c.header.subtitle).not.toContain('M6.5')
    expect(c.header.subtitle).toContain('日向灘')
  })

  // 対照。震源が確定していれば規模は出す（上のテストが「常に隠す」で通ってしまわないように）。
  it('震源が確定していれば規模を出す', () => {
    const c = build(input({ mode: 'kyoshin', eews: [eew()] }))
    expect(c.header.subtitle).toContain('M6.5')
  })

  // 安全弁。規模を隠しても、予想震度は隠さない（避難の判断に要る値で、仮定震源要素でも
  // 区域ごとの予想として発表される）。
  it('仮定震源要素でも予想最大震度は出す', () => {
    const c = build(input({ mode: 'kyoshin', eews: [eew({ condition: '仮定震源要素' })] }))
    expect(c.header.subtitle).toContain('予想最大震度')
  })

  it('発報が無ければリアルタイム震度の見出しにする', () => {
    const c = build(input({ mode: 'kyoshin' }))
    expect(c.header.title).toBe('リアルタイム震度')
  })
})

describe('buildShareCardContent — 津波', () => {
  it('等級が無ければ見出しを「津波情報」に落とす', () => {
    const c = build(input({ mode: 'tsunami' }))
    expect(c.header.title).toBe('津波情報')
  })
})

describe('buildShareCardContent — 保存名', () => {
  it('保存名の語は ASCII に限る（日本語のファイル名を扱えない環境があるため）', () => {
    const cases = [
      build(input({ mode: 'quake', quake: quake() })),
      build(input({ mode: 'tsunami' })),
      build(input({ mode: 'kyoshin' })),
      build(input({ mode: 'kyoshin', eews: [eew()] })),
    ]
    for (const c of cases) expect(c.filenameLabel).toMatch(/^[a-z]+$/)
  })
})

describe('buildShareCardContent — 共有の本文', () => {
  it('見出しと副見出しを 1 行目に、時刻を 2 行目に、URL を最後に置く', () => {
    const c = build(input({ mode: 'quake', quake: quake() }))
    const lines = c.shareText.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('最大震度')
    expect(lines[0]).toContain('日向灘')
    expect(lines[0]).toContain('M5.2')
    expect(lines[1]).toContain('発生')
    expect(lines[2]).toBe(APP_URL)
  })

  // 画像と本文で違うことを述べない。材料は見出しと同じものだけを使う。
  it('本文の中身は見出しから作る', () => {
    const c = build(input({ mode: 'kyoshin', eews: [eew({ severity: 'Warning' })] }))
    expect(c.shareText).toContain(c.header.title)
    expect(c.shareText).toContain(c.header.subtitle ?? '')
    expect(c.shareText).toContain(c.header.meta ?? '')
  })

  // 対照。項目が無いモードでも空行を作らない——読み手には何も伝わらないうえ、
  // 共有先で不自然な余白になる。
  it('副見出しも時刻も無ければ見出しと URL だけにする', () => {
    const c = build(input({ mode: 'kyoshin' }))
    expect(c.shareText).toBe(`リアルタイム震度\n${APP_URL}`)
  })

  // **要点**: 緊急地震速報の注意文は画像へ焼いてあり、本文と画像は共有シートで一緒に渡る。
  // 本文にも重ねると X の全角 140 字にほぼ届き、震源名が長ければ超える——利用者が削ることに
  // なり、削られた結果として注意文そのものが落ちうる。
  it('緊急地震速報でも本文に注意文は入れない（画像には入る）', () => {
    const c = build(input({ mode: 'kyoshin', eews: [eew({ severity: 'Warning' })] }))
    expect(c.notices).toContain(EEW_NOTICE)
    expect(c.shareText).not.toContain(EEW_NOTICE)
    expect(c.shareText).not.toContain('間に合わない')
  })

  // 安全弁。注意文を外したぶん、本文だけを見ても何の速報かは判るようにしておく。
  it('緊急地震速報の本文は区分と震源を伝える', () => {
    const c = build(input({ mode: 'kyoshin', eews: [eew({ severity: 'Warning' })] }))
    expect(c.shareText).toContain('緊急地震速報')
    expect(c.shareText).toContain('日向灘')
  })

  it('出典は本文に入れない（画像へ焼いてある）', () => {
    const c = build(input({ mode: 'quake', quake: quake() }))
    expect(c.shareText).not.toContain(ATTRIBUTION_SOURCES.jma)
  })

  // 津波は時刻の語が「発表」になり、震源と区域数が副見出しに入る。地震・緊急地震速報とは
  // 材料の作り方が別の関数なので、本文まで通しで固定する。
  it('津波でも等級・震源・区域数・発表時刻を本文にする', () => {
    const c = build(input({ mode: 'tsunami', tsunamis: [tsunami()] }))
    const lines = c.shareText.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('大津波警報')
    expect(lines[0]).toContain('日向灘')
    expect(lines[0]).toContain('1 区域')
    expect(lines[1]).toContain('発表')
    expect(lines[2]).toBe(APP_URL)
  })

  // 対照。等級を取れない電文では見出しだけに落ち、時刻の行も作らない。
  it('津波で等級が無ければ見出しと URL だけにする', () => {
    const c = build(input({ mode: 'tsunami' }))
    expect(c.shareText).toBe(`津波情報\n${APP_URL}`)
  })
})
