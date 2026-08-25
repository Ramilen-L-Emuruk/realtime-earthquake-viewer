// 地震の直後に出す行動チェックリストの中身。
//
// 【何を載せるか】公的機関が挙げているものだけを載せる。独自の判断で項目を足さない。出典は画面にも
// 出し、最後に「気象庁・自治体の指示を優先する」と添える。ここは行動を促す場所であって、公的な
// 指示に置き換わるものではない。
//
// 【なぜ 2 部構成か】使う場面が違う。直後の行動は揺れが収まってすぐ、持ち出すものは避難を決めた後。
// 同時に全部見せると、いま読むべきものが埋もれる。帯には最初の 3 つだけを出し、残りは開いて読む。
//
// 出典:
//   - 東京消防庁「地震 その時10のポイント」https://www.tfd.metro.tokyo.lg.jp/lfe/bou_topic/jisin/point10.html
//   - 消防庁「非常用持出品チェックシート」https://www.fdma.go.jp/relocation/bousai_manual/too/pdf/mocidashi.pdf

/** チェックリストの 1 項目。`detail` は補足で、無い項目もある。 */
export interface ChecklistItem {
  text: string
  detail?: string
}

/**
 * 揺れの直後にとる行動。**並び順が優先順位**を表す。
 *
 * 先頭 3 つ（身の安全・火の元・靴）は帯に畳んだ状態でも見える位置に置く。揺れた直後に読めるのは
 * せいぜいこのくらいで、それ以上は開いてもらう前提。
 */
export const IMMEDIATE_ACTIONS: readonly ChecklistItem[] = [
  {
    text: '身の安全を確保する',
    detail: '丈夫な机の下など、物が落ちてこない・倒れてこない・移動してこない場所へ',
  },
  {
    text: '火の元を確認する',
    detail: 'ガスの元栓を閉め、ストーブを切る。地震後の火災はガス機器・暖房器具が原因になりやすい',
  },
  {
    text: '靴を履く',
    detail: '床にガラスの破片が散っている。室内でも裸足で歩かない',
  },
  {
    text: '出口を確保する',
    detail: 'ドアや窓を開ける。建物がゆがむと閉じ込められる',
  },
  {
    text: '余震に備える',
    detail: '大きな地震のあとは続けて揺れることがある。倒れやすい物から離れる',
  },
  {
    text: 'エレベーターを使わない',
    detail: '停止して閉じ込められる。乗っている場合は全階のボタンを押して最初に止まった階で降りる',
  },
  {
    text: '避難するならブレーカーを落とす',
    detail: '電気が復旧したときの通電火災を防ぐ。ガスの元栓も閉める',
  },
] as const

/** 持ち出すものの 1 分類。 */
export interface EmergencyKitGroup {
  label: string
  items: readonly string[]
}

/**
 * 避難するときに持ち出すもの。
 *
 * **両手が空くリュックにまとめ、軽くコンパクトに**（消防庁・首相官邸）。持病の薬・杖・補聴器・
 * 乳幼児用品など、その人にしか分からないものは各自で足してもらう。ここに列挙できるのは
 * 誰にでも当てはまる最大公約数だけ。
 */
export const EMERGENCY_KIT: readonly EmergencyKitGroup[] = [
  {
    label: '避難用具',
    items: ['懐中電灯', '携帯ラジオ', '予備の乾電池', 'ヘルメット・防災ずきん'],
  },
  {
    label: '貴重品',
    items: ['現金（公衆電話用の10円玉も）', '預金通帳', '印鑑', '保険証・免許証'],
  },
  {
    label: '生命維持',
    items: ['飲料水（1人 500ml×2〜3本）', '常備薬', '救急用品'],
  },
  {
    label: '生活用品',
    items: ['携帯電話の充電器', 'マスク', 'タオル', 'ウェットティッシュ'],
  },
] as const

/** 出典の表示。画面に出して、どこの推奨かを分かるようにする。 */
export const CHECKLIST_SOURCES: readonly { label: string; url: string }[] = [
  {
    label: '東京消防庁「地震 その時10のポイント」',
    url: 'https://www.tfd.metro.tokyo.lg.jp/lfe/bou_topic/jisin/point10.html',
  },
  {
    label: '消防庁「非常用持出品チェックシート」',
    url: 'https://www.fdma.go.jp/relocation/bousai_manual/too/pdf/mocidashi.pdf',
  },
] as const

/** 帯を畳んだ状態で見せる項目数。揺れた直後に読める量に絞る。 */
export const COLLAPSED_ACTION_COUNT = 3
