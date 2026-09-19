// 読み上げ文の骨格（述語・助詞・数値の周り）を「文型 × 値」で総当たりに組み、
// **何文できるか・合成エンジンへ何回訊くことになるか**を数える計測台。
//
//   TTS_SWEEP_OUT=<書き出し先.json> npx vitest run src/utils/ttsSentenceSweep.probe.test.ts
//
// 【なぜ Vitest の中に置くか】`ttsText.ts` は `import.meta.env`（Vite が注入する値）を踏む
// モジュールを芋づるで読むため、素の Node からは import できない。実測の口はここしかない。
//
// 【環境変数を渡さないと飛ばす】通常の `npm test` を汚さないため
// （`src/services/dmdataCoverage.probe.test.ts` と同じ作り）。
//
// 【値は 1 つずつ振る】全部の掛け合わせは組めないし、要らない。差し込む値が声にどう影響するかは
// **その値と直後の述語**で決まり、離れた別の穴の値には左右されない。基準の形を 1 つ置いて、
// 穴を 1 つずつ振る。
import { describe, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  earthquakeToText, earthquakeCancelToText,
  eewAlertToText, eewIntensityText, eewScaleOnlyText, eewLpgmOnlyText,
  eewWarningRegionsText, eewCancelToText,
  tsunamiToText, tsunamiDowngradeToText, tsunamiAreaGradeChangeToText, tsunamiCancelToText,
  tsunamiArrivalToText, tsunamiMissingToText, tsunamiObservationUpdateToText,
  tsunamiWarningLevelToText,
  lpgmToText, nankaiToText, nankaiCommentaryToText, kohatsuToText,
  earthquakeCountToText, estimatedIntensityToText, voicevoxPreviewTexts, telegramTextToSpeak,
  type TtsSpeechOptions,
} from './ttsText'
import { splitIntoChunks, buildAccentPhrases, buildChunkQuery } from './voicevox'
import { findPhraseBreakMatch, loadTtsPhraseBreakDict, getTtsPhraseBreakDictCache } from './ttsPhraseBreakDict'
import { loadTtsStationReadings, getTtsStationReadingsCache } from './ttsStationReadings'
import { loadTtsEpicenterAccents, getTtsEpicenterAccentsCache } from './ttsEpicenterAccents'
import { mergeSpeechDicts } from './ttsGeneratedDict'
import { TSUNAMI_GRADE_LIFTED, type TsunamiAreaGradeChange } from './tsunami'
import type {
  LiveEvent,
  JMAQuake, JMALpgm, JMATsunami, JMANankai, JMANankaiCommentary, JMAKohatsu,
  JMAEarthquakeCount, EEWAlert, EarthquakePoint, IntensityScale, TsunamiArea,
  TsunamiObservation, TsunamiGrade, IssueType, DomesticTsunami, LpgmClass,
} from '../types/earthquake'

const OUT = process.env.TTS_SWEEP_OUT ?? ''
/** 合成エンジンの接続先。渡さなければ本番経路の段だけ飛ばす（生成側の計数は engine 無しで回る）。 */
const ENGINE = (process.env.VOICEVOX_URL ?? '').replace(/\/+$/, '')
const SPEAKER = Number(process.env.VOICEVOX_SPEAKER ?? 6)
/** 音の書き出し先と、聞く文の一覧（1 行 1 文）。どちらも渡したときだけ最後の段が動く。 */
const WAV_DIR = process.env.TTS_SWEEP_WAV ?? ''
const TEXTS = process.env.TTS_SWEEP_TEXTS ?? ''

/** 句を落とさせない設定（読み上げの詳しさは既定で全部読む側へ寄せる）。 */
const OPTS: TtsSpeechOptions = { intensityLevels: 0, maxRegions: 0, alwaysReadScale: -1, regionTolerance: 0 }

const SCALES = [10, 20, 30, 40, 45, 50, 55, 60, 70] as IntensityScale[]
/** 気象庁の深さは 10km 刻み。0 は「ごく浅い」で語形が変わる。 */
const DEPTHS = [0, ...Array.from({ length: 70 }, (_, i) => (i + 1) * 10)]
/** 規模は小数 1 桁。読みの単位として効くのは整数部 × 小数部。 */
const MAGNITUDES = Array.from({ length: 100 }, (_, i) => i / 10)
const TSUNAMI_GRADES: TsunamiGrade[] = ['MajorWarning', 'Warning', 'Watch', 'Forecast']
const ISSUE_TYPES = ['震度速報', '震源情報', '震源・震度情報', '各地の震度情報', '遠地地震'] as IssueType[]
const DOMESTIC: DomesticTsunami[] = ['なし', '不明', '調査中', '海面変動の可能性', '若干の海面変動', '注意報', '警報等']
/** 気象庁の予想波高の表記（コード表の値域）。 */
const FORECAST_HEIGHTS = ['１０ｍ超', '１０ｍ', '５ｍ', '３ｍ', '１ｍ', '０．２ｍ未満', '巨大', '高い']
/**
 * 緊急地震速報の警報対象地方（地方予報区）。**電文が載せるのは「地方」を付けない短い名前**
 * （`dmdataParser.test.ts` の期待値が `['北陸', '甲信', '東海', '関東']`）。値域の一覧は
 * `docs/spec/eew-spec.md` §3「警報の対象地方」。
 *
 * **ここへ実在しない形（「北陸地方」等）を書くと、その形でだけ起きる崩れを「実在の欠陥」として
 * 数えてしまう。** 実際に一度そう書いて、エンジンが「チホオ」の「ホ」の後へ核を置く崩れを
 * 12 種ぶん拾った —— どれも電文には現れない形だった。
 */
const CHIHOU = [
  '北海道', '東北', '関東', '伊豆諸島', '小笠原', '北陸', '甲信',
  '東海', '近畿', '中国', '四国', '九州', '奄美', '沖縄',
]

/**
 * 件数の文型（「ほかN地点」）を振るための名前。**実在する観測点名を使う**
 * （`public/data/station-coords.json` の石川県・`tsunami-obs-coords.json` の潮位観測点）。
 * 作り物の連番（「地点12」）だと、番号の読みが 1 モーラの句として浮き、骨格の欠陥と区別が付かない。
 */
const STATIONS = [
  '七尾市本府中町', '七尾市袖ヶ江町', '七尾市垣吉町', '七尾市能登島向田町', '七尾市中島町中島',
  '輪島市舳倉島', '輪島市鳳至町', '輪島市河井町', '輪島市門前町走出', '珠洲市三崎町',
  '珠洲市正院町', '珠洲市大谷町', '羽咋市柳田町', '羽咋市旭町', '志賀町富来領家町',
  '志賀町香能', '志賀町末吉千古', '宝達志水町子浦', '宝達志水町今浜', '中能登町末坂',
  '中能登町井田', '中能登町能登部下', '穴水町大町', '能登町宇出津', '能登町柳田',
  '能登町松波', '金沢市西念', '金沢市弥生', '小松市小馬出町', '小松市向本折町',
]
const TIDE_GAUGES = ['輪島港', '珠洲市長橋', '金沢', '七尾港', '柏崎市鯨波', '佐渡市鷲崎', '富山', '伏木富山港新湊']

/**
 * 読み上げ辞書を**本番と同じ経路で**読み込み、モジュール側のキャッシュを埋める。
 *
 * `buildChunkQuery` は内部で `speechDict()` を呼び、それは 3 つのローダーのキャッシュを見る。
 * ローダーは `import.meta.env.BASE_URL` 付きの URL へ `fetch` するので、ブラウザの外では
 * 何も取れず**キャッシュが空のまま**になる。そのまま合成すると辞書が 1 件も当たらない音が出る
 * ——「大津波警報」がエンジンの素の読み `ダイツナミ` で鳴り、**耳で聞くまで気づけない**
 * （実際に一度その音を出して、聞いた人に見つけてもらった）。
 *
 * **辞書を引数で渡せるようにする形は採らない。** 本番が通る経路と別の口を作ると、経路のほうが
 * 変わったときに計測台だけ古い口で通り続ける。ここでは `fetch` をファイル読み込みへ差し替えて、
 * ローダーそのものを走らせる。
 */
let dictsReady: Promise<void> | null = null
function primeSpeechDicts(): Promise<void> {
  if (dictsReady) return dictsReady
  const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'data')
  const real = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const m = /(?:^|\/)data\/([\w.-]+\.json)$/.exec(url)
    if (m && !url.startsWith('http')) {
      return new Response(readFileSync(join(dataDir, m[1]), 'utf8'), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }
    return real(input, init)
  }) as typeof fetch
  dictsReady = Promise.all([
    loadTtsPhraseBreakDict(), loadTtsStationReadings(), loadTtsEpicenterAccents(),
  ]).then(() => undefined)
  return dictsReady
}

/** 本番の `speechDict()` と同じ合わせ方（キーが衝突したら手書きが勝つ）。 */
function speechDictForProbe(): Record<string, string> {
  const d = mergeSpeechDicts(
    getTtsPhraseBreakDictCache(), getTtsStationReadingsCache(), getTtsEpicenterAccentsCache(),
  )
  if (!d) throw new Error('辞書を読めませんでした')
  return d
}

// ---- フィクスチャ ---------------------------------------------------------

type QuakeOver = {
  type?: IssueType; depth?: number; magnitude?: number; magnitudeCondition?: string
  maxScale?: IntensityScale; domesticTsunami?: DomesticTsunami; points?: EarthquakePoint[]
}

function quake(over: QuakeOver = {}): JMAQuake {
  return {
    kind: 'quake',
    id: 'sweep-quake',
    time: '2026-07-17T23:52:00+09:00',
    issue: { source: '気象庁', time: '2026-07-17T23:52:00+09:00', type: over.type ?? '震源・震度情報', correct: 'なし' },
    earthquake: {
      time: '2026-07-17T23:49:00+09:00',
      hypocenter: {
        name: '能登半島沖', latitude: 37.5, longitude: 137.2,
        depth: over.depth ?? 10,
        magnitude: over.magnitude ?? 7.6,
        ...(over.magnitudeCondition ? { magnitudeCondition: over.magnitudeCondition } : {}),
      },
      maxScale: over.maxScale ?? 70,
      domesticTsunami: over.domesticTsunami ?? 'なし',
    },
    points: over.points ?? [],
  } as unknown as JMAQuake
}

function point(addr: string, scale: IntensityScale, unreceived = false): EarthquakePoint {
  return { pref: '石川県', addr, scale, isArea: false, ...(unreceived ? { unreceived: true } : {}) } as unknown as EarthquakePoint
}

function eew(over: { depth?: number; forecastMaxScale?: IntensityScale } = {}): EEWAlert {
  return {
    kind: 'eew', id: 'sweep-eew', time: '2026-01-01T12:00:00Z', test: false,
    earthquake: {
      originTime: '2026-01-01T12:00:00Z', arrivalTime: '2026-01-01T12:00:20Z', condition: '以上',
      hypocenter: { name: '三陸沖', latitude: 38.1, longitude: 142.9, depth: over.depth ?? 24, magnitude: 7.2 },
    },
    severity: 'Warning', cancelled: false,
    forecastMaxScale: over.forecastMaxScale,
    issue: { eventId: 'e1', serial: '1', time: '2026-01-01T12:00:00Z' },
    areas: [],
  } as unknown as EEWAlert
}

function tsunami(areas: TsunamiArea[], observations?: TsunamiObservation[]): JMATsunami {
  return {
    kind: 'tsunami', id: 'sweep-tsunami', time: '2026-01-01T00:00:00Z', cancelled: false,
    issue: { source: '気象庁', time: '2026-01-01T00:00:00Z', type: 'Focus' },
    areas, ...(observations ? { observations } : {}),
  } as unknown as JMATsunami
}

function area(grade: TsunamiGrade, name: string, description?: string, value = 0, lastGrade?: TsunamiGrade): TsunamiArea {
  return {
    grade, immediate: false, name,
    ...(description ? { maxHeight: { description, value } } : {}),
    ...(lastGrade ? { lastGrade } : {}),
  } as unknown as TsunamiArea
}

function obs(name: string, over: Partial<TsunamiObservation> = {}): TsunamiObservation {
  return { name, districtCode: '170', districtName: '石川県能登', ...over } as unknown as TsunamiObservation
}

function lpgmEvent(maxClass: LpgmClass): JMALpgm {
  return {
    id: 'sweep-lpgm', eventId: '20260817230900', time: '2026-08-17T23:12:00+09:00',
    originTime: '2026-08-17T23:09:00+09:00', maxClass, cancelled: false,
    regions: [{ code: '130', name: '東京都23区', maxLgInt: maxClass }],
  } as unknown as JMALpgm
}

function countEvent(number: number, feltNumber: number): JMAEarthquakeCount {
  return {
    id: 'sweep-count', time: '2026-01-01T12:00:00+09:00', eventId: 'e', cancelled: false,
    reportDateTime: '2026-01-01T12:00:00+09:00', expireAt: '2026-01-08T12:00:00+09:00', headline: '',
    items: [{
      type: '累積地震回数',
      startTime: '2026-01-01T00:00:00+09:00', endTime: '2026-01-01T12:00:00+09:00',
      number, feltNumber,
    }],
  } as unknown as JMAEarthquakeCount
}

// ---- 掃き出し -------------------------------------------------------------

type Row = { group: string; dim: string; value: string; text: string }
const rows: Row[] = []
const push = (group: string, dim: string, value: unknown, text: string): void => {
  if (text) rows.push({ group, dim, value: String(value), text })
}

function sweepQuake(): void {
  for (const t of ISSUE_TYPES) for (const isNew of [true, false]) {
    push('地震情報', '種別×初報', `${t}/${isNew}`, earthquakeToText(quake({ type: t }), OPTS, isNew))
  }
  for (const s of SCALES) {
    push('地震情報', '最大震度（地域なし）', s, earthquakeToText(quake({ maxScale: s }), OPTS, true))
    push('地震情報', '最大震度（地点あり）', s,
      earthquakeToText(quake({ maxScale: s, points: [point('輪島市', s)] }), OPTS, true))
    push('地震情報', '未入電の震度', s,
      earthquakeToText(quake({ maxScale: s, points: [point('輪島市', 45 as IntensityScale, true)] }), OPTS, true))
  }
  for (const m of MAGNITUDES) {
    push('地震情報', '規模', m.toFixed(1), earthquakeToText(quake({ magnitude: m }), OPTS, true))
  }
  for (const c of ['Ｍ不明', 'Ｍ８を超える巨大地震', 'Ｍ９を超える謎の値']) {
    push('地震情報', '規模の説明', c, earthquakeToText(quake({ magnitude: NaN, magnitudeCondition: c }), OPTS, true))
  }
  for (const d of DEPTHS) push('地震情報', '深さ', d, earthquakeToText(quake({ depth: d }), OPTS, true))
  for (const dt of DOMESTIC) push('地震情報', '津波区分', dt, earthquakeToText(quake({ domesticTsunami: dt }), OPTS, true))
  for (let n = 1; n <= STATIONS.length; n += 1) {
    const pts = STATIONS.slice(0, n).map(name => point(name, 45 as IntensityScale, true))
    push('地震情報', '未入電の件数', n, earthquakeToText(quake({ maxScale: 45 as IntensityScale, points: pts }), OPTS, true))
  }
  push('地震情報', '取消', '理由なし', earthquakeCancelToText('2026-07-17T23:52:00+09:00'))
  push('地震情報', '取消', '理由あり',
    earthquakeCancelToText('2026-07-17T23:52:00+09:00', '先ほどの、装置の誤作動による誤報を取り消します。'))
}

function sweepEew(): void {
  for (const k of ['forecast', 'warning', 'hypocenterUpdate'] as const) {
    push('EEW', '切り出し', k, eewAlertToText(eew(), k))
  }
  for (const s of SCALES) for (const orAbove of [false, true]) {
    push('EEW', '予想最大震度', `${s}/${orAbove}`, eewScaleOnlyText({ scale: s, orAbove }, eew()))
  }
  for (const c of [1, 2, 3, 4]) for (const over of [false, true]) {
    push('EEW', '予想最大階級', `${c}/${over}`, eewLpgmOnlyText(c, over))
  }
  for (const s of SCALES) for (const orAbove of [false, true]) {
    for (const c of [0, 1, 2, 3, 4]) for (const over of [false, true]) for (const up of [false, true]) {
      push('EEW', '震度×階級×格上げ', `${s}/${orAbove}/${c}/${over}/${up}`,
        eewIntensityText({ scale: s, orAbove }, c, eew({ forecastMaxScale: s }), up, over, OPTS))
    }
  }
  // 予想震度が付かない 3 通り（単独点処理・深発・理由不明）
  push('EEW', '予想震度なし', 'deep', eewScaleOnlyText({ scale: 0, orAbove: false }, eew({ depth: 400 })))
  push('EEW', '予想震度なし', 'unknown', eewScaleOnlyText({ scale: 0, orAbove: false }, eew({ depth: 24 })))
  for (let n = 1; n <= CHIHOU.length; n += 1) {
    for (const additional of [false, true]) for (const up of [false, true]) {
      push('EEW', '警報の対象地方', `${n}/${additional}/${up}`,
        eewWarningRegionsText(CHIHOU.slice(0, n), additional, up))
    }
  }
  push('EEW', '取消', '-', eewCancelToText(eew()))
}

function sweepTsunami(): void {
  for (const g of TSUNAMI_GRADES) {
    for (const h of FORECAST_HEIGHTS) {
      push('津波', '等級×予想波高', `${g}/${h}`, tsunamiToText(tsunami([area(g, '石川県能登', h, 5)])))
    }
    push('津波', '等級のみ（波高なし）', g, tsunamiToText(tsunami([area(g, '石川県能登')])))
    push('津波', '引き下げ', g, tsunamiDowngradeToText(tsunami([area(g, '石川県能登', '１ｍ', 1)])))
  }
  const gradesTo = [...TSUNAMI_GRADES, TSUNAMI_GRADE_LIFTED] as (TsunamiGrade | typeof TSUNAMI_GRADE_LIFTED)[]
  for (const from of TSUNAMI_GRADES) for (const to of gradesTo) {
    if (from === to) continue
    const change = { from, to, areas: [area(from, '石川県能登')], raised: false } as unknown as TsunamiAreaGradeChange
    push('津波', '区域の等級変化', `${from}→${to}`, tsunamiAreaGradeChangeToText([change]))
  }
  for (let v = 1; v <= 60; v += 1) {
    const d = (v / 10).toFixed(1)
    push('津波', '観測波高', d,
      tsunamiObservationUpdateToText([obs('輪島港', { height: { value: v / 10, description: `${d}m` } })], undefined, 5))
    push('津波', '観測波高（以上）', d,
      tsunamiObservationUpdateToText([obs('輪島港', { height: { value: v / 10, description: `${d}m以上`, over: true } })], undefined, 5))
  }
  for (let n = 1; n <= TIDE_GAUGES.length; n += 1) {
    const many = <T,>(f: (name: string) => T): T[] => TIDE_GAUGES.slice(0, n).map(f)
    push('津波', '波高更新の件数', n, tsunamiObservationUpdateToText(
      many(name => obs(name, { height: { value: 1.2, description: '1.2m' } })), undefined, 5))
    push('津波', '到達確認の件数', n, tsunamiArrivalToText(many(name => obs(name)), 5))
    push('津波', '欠測の件数', n, tsunamiMissingToText(
      many(name => obs(name, { condition: { maxHeightMissing: true } })), 5))
    push('津波', '警報相当の件数', n, tsunamiWarningLevelToText(
      many(name => obs(name, { condition: { observing: true, important: true }, offshore: true })), 5))
  }
  for (const r of ['lifted', 'retracted', 'expired'] as const) {
    push('津波', '解除', r, tsunamiCancelToText(r))
  }
  push('津波', '解除', 'retracted+理由', tsunamiCancelToText('retracted', '先ほどの、装置の誤作動による誤報を取り消します。'))
}

function sweepOthers(): void {
  for (const c of [1, 2, 3, 4] as LpgmClass[]) for (const isNew of [true, false]) {
    push('長周期', '階級×初報', `${c}/${isNew}`, lpgmToText(lpgmEvent(c), OPTS, isNew))
  }
  for (const kindName of ['調査中', '巨大地震注意', '巨大地震警戒', '調査終了', '未知の段階']) {
    push('特別情報', '南海トラフ臨時情報', kindName,
      nankaiToText({ kindName, cancelled: false, retracted: false } as unknown as JMANankai))
  }
  push('特別情報', '南海トラフ臨時情報', '取消',
    nankaiToText({ kindName: '調査中', cancelled: false, retracted: true } as unknown as JMANankai))
  push('特別情報', '南海トラフ解説情報', '定例解説',
    nankaiCommentaryToText({ serialName: '定例解説', headline: '' } as unknown as JMANankaiCommentary))
  for (const n of ['１', '２', '１０']) {
    push('特別情報', '南海トラフ解説情報', `臨時解説(第${n}号)`, nankaiCommentaryToText(
      { serialName: '臨時解説', headline: `南海トラフ地震関連解説情報（第${n}号）` } as unknown as JMANankaiCommentary))
  }
  for (const headline of ['北海道・三陸沖後発地震注意情報', '北海道・三陸沖後発地震注意情報（第１号）']) {
    push('特別情報', '後発地震注意情報', headline, kohatsuToText({ headline } as unknown as JMAKohatsu))
  }
  for (const n of [1, 7, 35, 100, 1587, 10000]) for (const felt of [0, 1, 12]) {
    push('特別情報', '地震回数', `${n}/${felt}`, earthquakeCountToText(countEvent(n, felt)))
  }
  push('特別情報', '地震回数', '取消', earthquakeCountToText({ ...countEvent(1, 0), cancelled: true }))
  for (const isNew of [true, false]) {
    push('特別情報', '推計震度分布図', isNew, estimatedIntensityToText('2026-01-01T15:04:00+09:00', isNew))
  }
  // **気象庁が書いた文を読む経路の「見出し文」も掃く。** あれは電文本体とは別の発話で
  // （§6「気象庁が書いた文は最下位の層で読む」）、種別ごとに違う名乗りを持つ。本文そのものは
  // 気象庁が書いた文なのでこちらの担当ではないが、**名乗りはアプリが組んでいる**。
  // 文字列を写さず `telegramTextToSpeak` から取る —— 写すと文型を変えたときに掃き出しだけ古くなる。
  const BODY = 'これは本文です。'
  const withText = (label: string, event: unknown): void => {
    // **読む設定でなければ何も返らない**（`readTelegramText`）。既定値のまま渡すと 0 件になる
    const r = telegramTextToSpeak(event as LiveEvent, { ...OPTS, readTelegramText: true })
    if (!r) throw new Error(`気象庁の文が組めません: ${label}`)
    push('気象庁の文', '名乗り', label, r.text)
  }
  withText('地震情報', { kind: 'quake', cancelled: false, freeText: BODY })
  withText('津波情報', { kind: 'tsunami', cancelled: false, bodyText: BODY })
  withText('長周期地震動観測情報', { kind: 'lpgm', data: { cancelled: false, freeFormText: BODY } })
  withText('南海トラフ臨時情報', { kind: 'nankai', data: { cancelled: false, summary: BODY } })
  withText('南海トラフ解説情報', { kind: 'nankaiCommentary', data: { cancelled: false, summary: BODY } })
  withText('後発地震注意情報', { kind: 'kohatsu', data: { cancelled: false, summary: BODY } })
  withText('地震回数', { kind: 'earthquakeCount', data: { cancelled: false, freeText: BODY } })

  voicevoxPreviewTexts().forEach((t, i) => push('試聴', '試聴文', i, t))
}

describe('読み上げ文の骨格の総当たり（計測台）', () => {
  it.skipIf(!OUT)('文型 × 値を組み、文数とチャンク数を数える', { timeout: 300_000 }, () => {
    sweepQuake()
    sweepEew()
    sweepTsunami()
    sweepOthers()

    const sentences = new Set(rows.map(r => r.text))
    const chunks = new Set<string>()
    for (const t of sentences) for (const c of splitIntoChunks(t)) chunks.add(c)

    const byGroup = new Map<string, { combos: number; texts: Set<string> }>()
    const byDim = new Map<string, { combos: number; texts: Set<string> }>()
    for (const r of rows) {
      const g = byGroup.get(r.group) ?? { combos: 0, texts: new Set<string>() }
      g.combos += 1; g.texts.add(r.text); byGroup.set(r.group, g)
      const dk = `${r.group} / ${r.dim}`
      const d = byDim.get(dk) ?? { combos: 0, texts: new Set<string>() }
      d.combos += 1; d.texts.add(r.text); byDim.set(dk, d)
    }
    const shape = (m: Map<string, { combos: number; texts: Set<string> }>) =>
      Object.fromEntries([...m].map(([k, v]) => [k, { 組み合わせ: v.combos, 文: v.texts.size }]))

    const summary = {
      組み合わせ: rows.length,
      重複を除いた文: sentences.size,
      重複を除いたチャンク: chunks.size,
      群別: shape(byGroup),
      軸別: shape(byDim),
    }
    console.log(JSON.stringify(summary, null, 2))
    writeFileSync(OUT, JSON.stringify({ summary, rows, chunks: [...chunks] }, null, 2), 'utf8')
  })

  // **本番と同じ組み立てを通す。** 素の `/audio_query` だけで測ると、辞書が直している崩れ
  // （`心配はありません`・`4程度以上` ほか）まで候補に混ざる。実運用のチャンクは
  // `synthesizeChunk` が辞書の一致を見て `buildAccentPhrases` で組み直すので、そちらを呼ぶ。
  it.skipIf(!OUT || !ENGINE)('本番の組み立てで句を引き直す', { timeout: 1_800_000 }, async () => {
    if (rows.length === 0) { sweepQuake(); sweepEew(); sweepTsunami(); sweepOthers() }
    const chunks = [...new Set(rows.flatMap(r => splitIntoChunks(r.text)))]

    await primeSpeechDicts()
    const dict = speechDictForProbe()

    type Mora = { text: string }
    type Phrase = { moras: Mora[]; accent: number }
    const built = new Map<string, Phrase[] | { error: string }>()
    let done = 0
    const lane = async (list: string[]): Promise<void> => {
      for (const c of list) {
        try {
          const r = await buildAccentPhrases(ENGINE, c, SPEAKER, dict)
          built.set(c, r ? (r.phrases as unknown as Phrase[]) : { error: 'null' })
        } catch (e) {
          built.set(c, { error: String(e) })
        }
        done += 1
        if (done % 100 === 0) console.log(`  ${done}/${chunks.length}`)
      }
    }
    const CONCURRENCY = 6
    await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) =>
      lane(chunks.filter((_, j) => j % CONCURRENCY === i))))

    const hit = chunks.filter(c => findPhraseBreakMatch(c, dict) != null)
    console.log(JSON.stringify({
      チャンク: chunks.length,
      辞書が当たったチャンク: hit.length,
      組み立てに失敗: [...built.values()].filter(v => !Array.isArray(v)).length,
    }, null, 2))
    writeFileSync(`${OUT}.built.json`, JSON.stringify(Object.fromEntries(built)), 'utf8')
  })

  // **耳で決めるための音を、本番と同じ組み立てで作る。** `buildChunkQuery` をそのまま呼ぶので、
  // 話速（1.2 倍）・辞書の当たり方・チャンク末尾の間まで実運用と同じ。`TTS_SWEEP_WAV` に
  // ディレクトリを渡すと、そこへ文ごとの wav を書き出す。
  //
  // **聞く文は外から渡す**（`TTS_SWEEP_TEXTS` に 1 行 1 文のファイル）。候補は計測の結果から
  // 選ぶもので、ここへ焼き込むと絞り込みを変えるたびに書き換えることになる。
  it.skipIf(!WAV_DIR || !TEXTS || !ENGINE)('選んだ文を本番の組み立てで合成する', { timeout: 1_800_000 }, async () => {
    await primeSpeechDicts()
    const texts = readFileSync(TEXTS, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    mkdirSync(WAV_DIR, { recursive: true })
    console.log(`${texts.length} 文を合成します`)

    // **何を合成したかを残す。** 句の並びが出ないと、辞書が当たっているかを音でしか確かめられない
    // （辞書が空のまま合成していたことに、聞くまで気づけなかった）。
    const spoken: { text: string; phrases: string; pitch: string }[] = []

    for (const [i, text] of texts.entries()) {
      const cs = splitIntoChunks(text)
      const parts: Buffer[] = []
      const shape: string[] = []
      const pitch: string[] = []
      for (const [j, c] of cs.entries()) {
        // 実運用と同じく「最後のチャンクには末尾の間を付けない」
        const query = await buildChunkQuery(ENGINE, c, SPEAKER, undefined, j < cs.length - 1)
        if (!query) throw new Error(`audio_query に失敗: ${c}`)
        // **音高と間まで残す。** 句の形（カナと核の位置）だけでは、繋ぎ目の引き直しが
        // 何を変えたのかが見えない（核の直後の下がりが潰れていたことに、聞くまで気づけなかった）。
        type Mora = { text: string; pitch: number }
        type Phrase = { moras: Mora[]; accent: number; pause_mora?: { vowel_length: number } | null }
        const ps = query.accent_phrases as Phrase[]
        shape.push(ps.map(ph =>
          ph.moras.map(m => m.text).join('') + `[${ph.accent}]`
          + (ph.pause_mora ? `+間${ph.pause_mora.vowel_length.toFixed(2)}` : '')).join('｜'))
        pitch.push(ps.map(ph =>
          ph.moras.map(m => `${m.text}:${m.pitch.toFixed(2)}`).join(' ')
          + (ph.pause_mora ? ` +間${ph.pause_mora.vowel_length.toFixed(2)}` : '')).join('  ｜  '))
        const res = await fetch(`${ENGINE}/synthesis?speaker=${SPEAKER}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query),
        })
        if (!res.ok) throw new Error(`synthesis に失敗(${res.status}): ${c}`)
        parts.push(Buffer.from(await res.arrayBuffer()))
      }
      // **チャンクは隙間なく詰めて鳴らす**（実運用の再生と同じ）。wav の 44 バイトのヘッダを
      // 先頭のものだけ残し、残りは PCM を繋いで長さを書き直す。
      const pcm = parts.map((b, k) => (k === 0 ? b.subarray(44) : b.subarray(44)))
      const body = Buffer.concat(pcm)
      const head = Buffer.from(parts[0].subarray(0, 44))
      head.writeUInt32LE(36 + body.length, 4)
      head.writeUInt32LE(body.length, 40)
      const name = `${String(i + 1).padStart(2, '0')}-${text.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}.wav`
      writeFileSync(join(WAV_DIR, name), Buffer.concat([head, body]))
      spoken.push({ text, phrases: shape.join(' ‖ '), pitch: pitch.join(' ‖ ') })
      console.log(`  ${String(i + 1).padStart(2, '0')} ${shape.join(' ‖ ')}`)
    }
    writeFileSync(join(WAV_DIR, 'phrases.json'), JSON.stringify(spoken, null, 2), 'utf8')
  })
})
