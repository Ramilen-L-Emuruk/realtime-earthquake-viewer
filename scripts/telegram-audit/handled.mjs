// 種別 → 担当のパース関数。**2 つのスクリプトで別々に持たない**（片方だけ直して食い違う）。
// 関数名が実在するかは `assertRoots` で必ず確かめる —— 閉包の生成は存在しない名前を
// 黙ってスキップするので、リネームに気づけないまま「その種別は全要素が未読」と出る。
export const HANDLED = {
  VTSE41: ['parseTsunamiFromXml'],
  VTSE51: ['parseTsunamiFromXml'],
  VTSE52: ['parseTsunamiFromXml'],
  VXSE45: ['parseEEWFromXml'],
  VXSE51: ['parseEarthquakeFromXml'],
  VXSE52: ['parseEarthquakeFromXml'],
  VXSE53: ['parseEarthquakeFromXml'],
  VXSE61: ['parseEarthquakeFromXml'],
  VXSE62: ['parseLpgmFromXml'],
  VYSE50: ['parseNankaiFromXml'],
  VYSE51: ['parseNankaiCommentaryFromXml'],
  VYSE52: ['parseNankaiCommentaryFromXml'],
  VYSE60: ['parseVyse60FromXml'],
}

export function assertRoots(fnBodies) {
  const missing = [...new Set(Object.values(HANDLED).flat())].filter(n => !fnBodies.has(n))
  if (missing.length) {
    throw new Error(`HANDLED に実在しない関数名があります: ${missing.join(', ')}`)
  }
}
