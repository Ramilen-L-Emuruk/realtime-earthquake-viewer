/**
 * バリアントごとに、Workbox の古いキャッシュの片付け（`cleanupOutdatedCaches`）を走らせるか。
 *
 * standard 版の scope（`/yuremado/`）は DMDSS 版の scope（`/yuremado/dmdss/`）を包む。
 * Workbox の deleteOutdatedCaches は「`-precache-` を含み、自分の scope を**部分文字列として**含み、
 * 自分の名前でない」キャッシュを消すので、standard 版で走らせると、SW が入れ替わるたびに
 * DMDSS 版の事前キャッシュ（`workbox-precache-v2-…/yuremado/dmdss/`）を丸ごと消す。
 * 目録に SRI が無いため Workbox は取り直した応答をキャッシュへ書き戻さず、次に DMDSS 版の SW が
 * 更新されるまで DMDSS 版はオフラインで起動できない。だから standard 版だけ切る。
 *
 * 切っても、自分のキャッシュ内の古いファイルは precache の activate が別に消す。
 * 切って失うのは、自分の scope を含む「いまの名前でない」precache の掃除すべて ——
 * Workbox がキャッシュ名の形式（いまは `-v2-`）を変えたとき、または `cacheId` を変えたときに、
 * standard 版の旧いキャッシュがディスクに残る（機能には響かない）。そうする変更を入れるなら、
 * standard 版の SW で旧い名前を名指しで `caches.delete` する後始末を併せて入れること。
 *
 * DMDSS 版の scope は standard 版のキャッシュ名に含まれないので、DMDSS 版は既定どおり片付ける。
 */
export function cleanupOutdatedCachesForVariant(variant: string | undefined): boolean {
  return variant === 'dmdss'
}
