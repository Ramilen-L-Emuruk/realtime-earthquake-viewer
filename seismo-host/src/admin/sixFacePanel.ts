// センサーカードの「6 面で測る」欄に出すものを組み立てる（REQUIREMENTS.md §16）。
//
// **計算は `sixFaceFit.ts`、ここは読むことと言葉にすることだけ。** 画面（`viewBoards.ts`）に
// 文言を直書きすると、どの理由でどの文が出るかをテストで押さえられない。

import { FACE_ORDER, SIX_FACE_LIMITS } from './sixFaceFit'
import type { Face, FaceCoverage, FitWindow, SixFaceFit, SixFaceRefusal } from './sixFaceFit'
import { readFinite, readNonEmptyString, readVec3 } from './readJson'

/** 1 センサーぶんの静止窓（`GET /api/rest-windows` の 1 要素）。 */
export interface SensorFitWindows {
  readonly boardKey: string
  readonly sensorId: string
  readonly windows: readonly FitWindow[]
}

/**
 * `GET /api/rest-windows` の応答を読む。**1 か所でも形が違えば `null`**（呼ぶ側が理由を出す）。
 *
 * **崩れた要素だけ落として続けない。** センサーや窓を黙って落とすと、画面は「まだ揃って
 * いない面がある」と出るだけで、取得そのものが壊れていることと見分けが付かない
 * （ホストとこの画面で形がずれた日に、静止窓が無いのと同じ見た目になる）。
 */
export function parseRestWindowsBody(body: unknown): readonly SensorFitWindows[] | null {
  if (typeof body !== 'object' || body === null) return null
  const sensors = (body as { sensors?: unknown }).sensors
  if (!Array.isArray(sensors)) return null
  const out: SensorFitWindows[] = []
  for (const s of sensors) {
    if (typeof s !== 'object' || s === null) return null
    const boardKey = readNonEmptyString((s as { boardKey?: unknown }).boardKey)
    const sensorId = readNonEmptyString((s as { sensorId?: unknown }).sensorId)
    const rawWindows = (s as { windows?: unknown }).windows
    if (boardKey === null || sensorId === null || !Array.isArray(rawWindows)) return null
    const windows: FitWindow[] = []
    for (const w of rawWindows) {
      if (typeof w !== 'object' || w === null) return null
      const meanGal = readVec3((w as { meanGal?: unknown }).meanGal)
      const sampleCount = readFinite((w as { sampleCount?: unknown }).sampleCount)
      if (meanGal === null || sampleCount === null || sampleCount <= 0) return null
      windows.push({ meanGal, sampleCount })
    }
    out.push({ boardKey, sensorId, windows })
  }
  return out
}

const FACE_LABEL: Readonly<Record<Face, string>> = {
  '+x': '＋X',
  '-x': '−X',
  '+y': '＋Y',
  '-y': '−Y',
  '+z': '＋Z',
  '-z': '−Z',
}

/** 揃い具合の 1 行（例: `＋X ✓　−X ✓　＋Y —　…`）。 */
export function describeFaces(faces: FaceCoverage): string {
  return FACE_ORDER.map((f) => `${FACE_LABEL[f]} ${faces[f] ? '✓' : '—'}`).join('　')
}

function formatGal(v: number): string {
  return v.toFixed(1)
}

/** ボタンを押せない理由。**押せるなら `null`。** */
export function sixFaceProblem(result: SixFaceFit | SixFaceRefusal): string | null {
  if (result.ok) return null
  switch (result.reason) {
    case 'missing-faces': {
      const missing = FACE_ORDER.filter((f) => !result.faces[f]).map((f) => FACE_LABEL[f])
      return `まだ揃っていない面がある（${missing.join('・')}）`
    }
    case 'degenerate':
      // 6 面が揃った後にしか来ないので、向きの足りなさを理由に挙げない。
      return '計算できなかった（方程式が解けない。置き直して測り直すこと）'
    case 'out-of-range':
      return `出た値が個体差の幅を超えている（感度 ${SIX_FACE_LIMITS.sensitivityMin}〜${SIX_FACE_LIMITS.sensitivityMax} 倍・オフセット ±${Math.round(SIX_FACE_LIMITS.offsetMaxGal)} gal）`
    case 'residual-too-large':
      return `姿勢の間で辻褄が合わない（残差 ${result.maxResidualGal === null ? '—' : formatGal(result.maxResidualGal)} gal）。動かしている最中の窓が混ざった疑い`
  }
}

/**
 * センサーカードの欄を描き直せなかったときの、画面上部へ出す 1 行。**どちらも 0 なら `null`。**
 *
 * **取り付けの診断と 6 面法の欄をまとめて 1 行にする。** 画面上部の欄は 1 つしか無いので、
 * 別々に書くと後の書き手が先の知らせを消す。
 */
export function cardPanelFailureMessage(tiltBroken: number, sixFaceBroken: number): string | null {
  const tail = '画面を再読込すること'
  if (tiltBroken > 0 && sixFaceBroken > 0) {
    return `${tiltBroken} 枚のセンサーカードで取り付けの診断を、${sixFaceBroken} 枚で 6 面法の欄を出せない。${tail}`
  }
  if (tiltBroken > 0) return `${tiltBroken} 枚のセンサーカードで取り付けの診断を出せない。${tail}`
  if (sixFaceBroken > 0) return `${sixFaceBroken} 枚のセンサーカードで 6 面法の欄を出せない。${tail}`
  return null
}

/** 静止した窓を取れなかったときの理由。 */
export function restWindowsFetchProblem(reason: string): string {
  return `静止した窓を取得できない（${reason}）`
}

/**
 * フォームへ入れる値と、入れた後に出す文。
 *
 * **桁は読める範囲で切る。** オフセットは 0.01 gal（静止窓の平均のぶれ 0.03 gal と同じ桁）、
 * 感度は 10⁻⁵（1 g に対して 0.01 gal）。
 */
export function sixFaceApplied(fit: SixFaceFit): {
  readonly offset: readonly [string, string, string]
  readonly sensitivity: readonly [string, string, string]
  readonly note: string
} {
  const check = fit.maxResidualGal === null ? '検算なし' : `残差 ${formatGal(fit.maxResidualGal)} gal`
  return {
    offset: [fit.offset[0].toFixed(2), fit.offset[1].toFixed(2), fit.offset[2].toFixed(2)],
    sensitivity: [fit.sensitivity[0].toFixed(5), fit.sensitivity[1].toFixed(5), fit.sensitivity[2].toFixed(5)],
    note: `オフセットと感度を入れた（姿勢 ${fit.poseCount}・${check}）。保存するまで効かない。保存したら元の場所へ据え直し、「鉛直を合わせる」を押し直すこと`,
  }
}
