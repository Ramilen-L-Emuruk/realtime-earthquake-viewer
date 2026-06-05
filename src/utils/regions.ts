// 地方区分のラベル。引き（広域表示）のときに地方名を表示する。
// 座標は各地方のおおよその中心。

export interface Region {
  name: string
  lat: number
  lng: number
}

export const REGIONS: Region[] = [
  { name: '北海道', lat: 43.4, lng: 142.8 },
  { name: '東北', lat: 39.6, lng: 140.6 },
  { name: '関東', lat: 36.1, lng: 139.7 },
  { name: '中部', lat: 36.2, lng: 137.6 },
  { name: '近畿', lat: 34.5, lng: 135.8 },
  { name: '中国', lat: 34.9, lng: 132.6 },
  { name: '四国', lat: 33.6, lng: 133.5 },
  { name: '九州', lat: 32.3, lng: 130.9 },
  { name: '沖縄', lat: 26.5, lng: 128.0 },
]
