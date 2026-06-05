// 主要都市（県庁所在地）の一覧。ズームイン時に都市名ラベルとして表示する。
// 座標は代表点（おおよその市役所・県庁付近）。

export interface City {
  name: string
  lat: number
  lng: number
}

export const PREFECTURE_CAPITALS: City[] = [
  { name: '札幌', lat: 43.064, lng: 141.347 },
  { name: '青森', lat: 40.824, lng: 140.74 },
  { name: '盛岡', lat: 39.704, lng: 141.153 },
  { name: '仙台', lat: 38.269, lng: 140.872 },
  { name: '秋田', lat: 39.719, lng: 140.102 },
  { name: '山形', lat: 38.24, lng: 140.364 },
  { name: '福島', lat: 37.75, lng: 140.468 },
  { name: '水戸', lat: 36.342, lng: 140.447 },
  { name: '宇都宮', lat: 36.566, lng: 139.884 },
  { name: '前橋', lat: 36.391, lng: 139.061 },
  { name: 'さいたま', lat: 35.857, lng: 139.649 },
  { name: '千葉', lat: 35.605, lng: 140.123 },
  { name: '東京', lat: 35.69, lng: 139.692 },
  { name: '横浜', lat: 35.448, lng: 139.643 },
  { name: '新潟', lat: 37.902, lng: 139.023 },
  { name: '富山', lat: 36.695, lng: 137.211 },
  { name: '金沢', lat: 36.561, lng: 136.656 },
  { name: '福井', lat: 36.065, lng: 136.222 },
  { name: '甲府', lat: 35.664, lng: 138.568 },
  { name: '長野', lat: 36.651, lng: 138.181 },
  { name: '岐阜', lat: 35.391, lng: 136.722 },
  { name: '静岡', lat: 34.977, lng: 138.383 },
  { name: '名古屋', lat: 35.181, lng: 136.906 },
  { name: '津', lat: 34.73, lng: 136.509 },
  { name: '大津', lat: 35.004, lng: 135.868 },
  { name: '京都', lat: 35.021, lng: 135.756 },
  { name: '大阪', lat: 34.686, lng: 135.52 },
  { name: '神戸', lat: 34.691, lng: 135.183 },
  { name: '奈良', lat: 34.685, lng: 135.833 },
  { name: '和歌山', lat: 34.226, lng: 135.167 },
  { name: '鳥取', lat: 35.504, lng: 134.238 },
  { name: '松江', lat: 35.472, lng: 133.051 },
  { name: '岡山', lat: 34.662, lng: 133.935 },
  { name: '広島', lat: 34.397, lng: 132.46 },
  { name: '山口', lat: 34.186, lng: 131.471 },
  { name: '徳島', lat: 34.066, lng: 134.559 },
  { name: '高松', lat: 34.34, lng: 134.043 },
  { name: '松山', lat: 33.842, lng: 132.766 },
  { name: '高知', lat: 33.56, lng: 133.531 },
  { name: '福岡', lat: 33.607, lng: 130.418 },
  { name: '佐賀', lat: 33.249, lng: 130.3 },
  { name: '長崎', lat: 32.745, lng: 129.874 },
  { name: '熊本', lat: 32.79, lng: 130.742 },
  { name: '大分', lat: 33.238, lng: 131.613 },
  { name: '宮崎', lat: 31.911, lng: 131.424 },
  { name: '鹿児島', lat: 31.56, lng: 130.558 },
  { name: '那覇', lat: 26.212, lng: 127.681 },
]
