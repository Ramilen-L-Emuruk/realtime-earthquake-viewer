import type { EarthquakePoint } from '../../types/earthquake'

/** 「震度を入手していない地点」の 1 行分。 */
export interface UnreceivedPointName {
  name: string
  /** 気象庁以外が運用する観測点か（→ {@link EarthquakePoint.nonJma}）。 */
  nonJma: boolean
  /**
   * この行が指すのが一次細分区域か（→ {@link EarthquakePoint.isArea}）。
   *
   * **座標表は観測点と区域を別の表に持つ**ので、行から地図へ寄せるときにどちらを引くかの
   * 判断に要る。地点を持たない電文（震度速報）は区域名でしか未入電を伝えられないため、
   * この一覧には両方が並ぶ。
   */
  isArea: boolean
}

/**
 * 未入電の地点を、画面に並べる 1 行ずつへまとめる。
 *
 * 電文には同じ名前の点が複数入りうる（都道府県のロールアップ点と観測点、複数の県にまたがる
 * 同名の市町村）。行を重ねても読み手に伝わるものが増えないので 1 行にまとめる。
 * **渡された順序をそのまま保つ** —— 並びは呼び出し側が気象庁の標準順で決めている。
 *
 * **「気象庁以外」の印は、その名前の点が全部そうだったときだけ付ける。** 同名で出所の違う
 * 点が混ざったときに、気象庁の観測点へ他所の印を付けないため（逆向きの取り違えなら、
 * 印が出ないだけで嘘は言わない）。
 *
 * **「区域である」も同じく全部そうだったときだけ。** 観測点と区域が同名で混ざったら観測点として
 * 扱う —— 地図の印（`QuakeUnreceivedPointsGL`）は観測点の位置に出るので、寄り先もそちらが合う。
 */
export function mergeUnreceivedPointNames(
  points: (Pick<EarthquakePoint, 'addr' | 'nonJma'> & Partial<Pick<EarthquakePoint, 'isArea'>>)[],
): UnreceivedPointName[] {
  const byName = new Map<string, { nonJma: boolean; isArea: boolean }>()
  for (const p of points) {
    const prev = byName.get(p.addr)
    byName.set(p.addr, prev === undefined
      ? { nonJma: !!p.nonJma, isArea: !!p.isArea }
      : { nonJma: prev.nonJma && !!p.nonJma, isArea: prev.isArea && !!p.isArea })
  }
  return [...byName].map(([name, flags]) => ({ name, ...flags }))
}

/** 未入電の一覧を都道府県で区切った 1 かたまり。 */
export interface UnreceivedPointGroup {
  /** 都道府県名。引けなかった点は空文字（見出しを出さずに並べる）。 */
  pref: string
  names: UnreceivedPointName[]
}

/**
 * 未入電の地点を都道府県で区切る（一覧を平らに並べるとき用）。
 *
 * **全部が同じ「5弱以上」なので、震度一覧のような 4 段の入れ子にする意味が無い。** 段を開いて
 * 回らずに済むよう平らに並べ、どこの話かだけを県の見出しで示す。
 *
 * **並びは渡された順序をそのまま保つ** —— 呼び出し側が気象庁の標準順で決めている。県の並びは
 * その県の点が最初に現れた位置で決まる。
 *
 * **同名の点をまとめるのは県の中だけ**（{@link mergeUnreceivedPointNames} を県ごとに呼ぶ）。
 * 市町村名は全国で一意ではない（府中市＝東京都・広島県）ので、県をまたいでまとめると別の場所が
 * 1 行に潰れる。
 */
export function groupUnreceivedPointNames(
  points: (Pick<EarthquakePoint, 'addr' | 'nonJma'> & Partial<Pick<EarthquakePoint, 'isArea'>> & { pref: string })[],
): UnreceivedPointGroup[] {
  const byPref = new Map<string, (Pick<EarthquakePoint, 'addr' | 'nonJma'> & Partial<Pick<EarthquakePoint, 'isArea'>>)[]>()
  for (const p of points) {
    const list = byPref.get(p.pref)
    if (list) list.push(p)
    else byPref.set(p.pref, [p])
  }
  return [...byPref].map(([pref, list]) => ({ pref, names: mergeUnreceivedPointNames(list) }))
}
