// ParsedTsunamiStage[] / ParsedTsunamiObservationRow[]（historicalTsunamiParser.ts の出力）を
// アプリの HistoricalArchiveEntry 形式へ変換する。
//
// 各地域の予測高さは、一次資料に時系列値が残っている範囲は heightOverrides で上書きし、
// それ以外は「発表した津波警報・注意報の検証」ページの観測表にある予測高さ（その地域が
// 到達した最も高い区分の値）を用いる。津波注意報は全地域一律 0.5m（観測表で確認済み）。
import type { HistoricalArchiveEntry } from '../src/types/historicalArchive'
import type { TsunamiGrade } from '../src/types/earthquake'
import type { ParsedTsunamiObservationRow, ParsedTsunamiStage } from './historicalTsunamiParser'

const JST_OFFSET_MS = 9 * 3600_000

/** 観測表の class 属性（ootsunami/tsunami/chuui）→ TsunamiGrade の対応。 */
const OBSERVATION_CLASS_TO_GRADE: Record<string, TsunamiGrade> = {
  ootsunami: 'MajorWarning',
  tsunami: 'Warning',
  chuui: 'Watch',
}

function toHalfWidthDigits(text: string): string {
  return text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
}

function toIso(year: number, monthDay: string, timeText: string): string {
  const md = toHalfWidthDigits(monthDay).match(/(\d+)月(\d+)日/)
  const t = toHalfWidthDigits(timeText).match(/(\d+)時(\d+)分/)
  if (!md || !t) throw new Error(`日時を解析できません: ${monthDay} ${timeText}`)
  const jstMs = Date.UTC(year, Number(md[1]) - 1, Number(md[2]), Number(t[1]), Number(t[2]), 0)
  return new Date(jstMs - JST_OFFSET_MS).toISOString()
}

export interface BuildTsunamiEntriesOptions {
  idPrefix: string
  eventId: string
  year: number
  hypocenterName: string
  originTimeIso: string
  /** ステージ番号（1始まり）ごとの、その時点で公表されていたマグニチュード推定値。 */
  magnitudeByStage: Record<number, number>
  /** [ステージ番号][地域名] = 予測高さ(m)。一次資料で時系列値が判明している場合のみ指定する。 */
  heightOverrides?: Record<number, Record<string, number>>
  /** 予報区コードが判明している地域のみ（分からない地域は省略してよい。型上 optional）。 */
  regionCodes?: Record<string, string>
}

export function buildTsunamiEntries(
  stages: ParsedTsunamiStage[],
  observations: ParsedTsunamiObservationRow[],
  opts: BuildTsunamiEntriesOptions,
): HistoricalArchiveEntry[] {
  const peakByRegion = new Map(observations.map((o) => [o.regionName, o]))
  const entries: HistoricalArchiveEntry[] = []

  stages.forEach((stage, i) => {
    const stageNum = i + 1
    const timeIso = toIso(opts.year, stage.monthDay, stage.timeText)
    const id = `${opts.idPrefix}-tsunami-${stageNum}`

    if (!stage.isFullCancel && !(stageNum in opts.magnitudeByStage)) {
      // magnitudeByStage[stageNum] が undefined のまま書き出すと、JSON.stringify が
      // magnitude キーごと黙って消してしまい「意図して省略した」のと区別が付かなくなる。
      throw new Error(`${id}: magnitudeByStage にステージ${stageNum}の指定がありません`)
    }

    if (stage.isFullCancel) {
      entries.push({
        time: timeIso,
        payload: {
          kind: 'event',
          event: {
            kind: 'tsunami',
            id,
            eventId: opts.eventId,
            time: timeIso,
            cancelled: true,
            cancelReason: 'lifted',
            issue: { source: '気象庁', time: timeIso, type: 'Focus' },
            areas: [],
          },
        },
      })
      return
    }

    const graded: { name: string; grade: TsunamiGrade }[] = [
      ...stage.majorWarning.map((name) => ({ name, grade: 'MajorWarning' as TsunamiGrade })),
      ...stage.warning.map((name) => ({ name, grade: 'Warning' as TsunamiGrade })),
      ...stage.watch.map((name) => ({ name, grade: 'Watch' as TsunamiGrade })),
    ]

    const areas = graded.map(({ name, grade }) => {
      const override = opts.heightOverrides?.[stageNum]?.[name]
      const peak = peakByRegion.get(name)
      // 発表テーブルに出てくる地域は、必ず観測テーブル（全予報区を掲載）にも載っているはず。
      // 見つからないのは大抵、表記ゆれ（別資料からの転記ミス等）による名前の不一致で、
      // 黙って「高さ不明」にすると気づけない。
      if (!peak) throw new Error(`${id}: 地域 "${name}" が観測テーブルに見つかりません（表記ゆれの可能性）`)
      const peakGrade = OBSERVATION_CLASS_TO_GRADE[peak.grade]
      // 観測表の予測高さは「その地域が最終的に到達した区分」の値。今の等級がまだ最終到達
      // 区分に届いていない（後で格上げされる）段階に流用すると、実際より過大な値になる
      // （例: 注意報の段階なのに最終値の大津波(8m)を出してしまう）。
      // 確定できるのは (a) 明示的な上書き値がある場合と (b) 今の等級が最終到達等級と
      // 一致する場合（＝以後この地域は格上げされない）のみ。それ以外は maxHeight を省略する
      // （型は optional。「わからない」を確定値として書かない）。
      let heightM: number | undefined
      let usesOverText = false
      if (override !== undefined) {
        heightM = override
      } else if (grade === 'Watch') {
        heightM = 0.5 // この地震の津波注意報は観測表で全地域一律0.5mと確認済み
      } else if (peakGrade === grade && peak.predictedHeightM !== null) {
        heightM = peak.predictedHeightM
        usesOverText = peak.predictedText.includes('以上')
      }
      const code = opts.regionCodes?.[name]
      return {
        grade,
        immediate: grade !== 'Watch',
        name,
        ...(code ? { code } : {}),
        ...(heightM !== undefined
          ? { maxHeight: { description: `${heightM}m${usesOverText ? '以上' : ''}`, value: heightM } }
          : {}),
      }
    })

    entries.push({
      time: timeIso,
      payload: {
        kind: 'event',
        event: {
          kind: 'tsunami',
          id,
          eventId: opts.eventId,
          time: timeIso,
          cancelled: false,
          sourceEarthquakes: [{
            hypocenterName: opts.hypocenterName,
            magnitude: opts.magnitudeByStage[stageNum],
            originTime: opts.originTimeIso,
          }],
          issue: { source: '気象庁', time: timeIso, type: 'Focus' },
          areas,
        },
      },
    })
  })

  return entries
}
