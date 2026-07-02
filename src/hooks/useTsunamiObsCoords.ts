import { useState, useEffect } from 'react'
import { loadTsunamiObsCoords, type TsunamiObsCoords } from '../utils/tsunamiObsCoords'

export function useTsunamiObsCoords(): TsunamiObsCoords | null {
  const [coords, setCoords] = useState<TsunamiObsCoords | null>(null)
  useEffect(() => {
    loadTsunamiObsCoords().then(setCoords).catch(() => {})
  }, [])
  return coords
}
