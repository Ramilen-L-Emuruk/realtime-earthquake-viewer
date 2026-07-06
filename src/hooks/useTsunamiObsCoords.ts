import { useState, useEffect } from 'react'
import { loadTsunamiObsCoords, type TsunamiObsCoords } from '../utils/tsunamiObsCoords'
import { log } from '../utils/logger'

export function useTsunamiObsCoords(): TsunamiObsCoords | null {
  const [coords, setCoords] = useState<TsunamiObsCoords | null>(null)
  useEffect(() => {
    loadTsunamiObsCoords().then(setCoords).catch((err) => {
      // 観測点座標が取得できなくても津波タブ自体は動作する
      log.warn('[data] tsunami-obs-coords 取得失敗（観測点マーカーなしで継続）', err)
    })
  }, [])
  return coords
}
