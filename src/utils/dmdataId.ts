/**
 * DMDATA 由来の電文 id を扱うユーティリティ。
 *
 * 電文 id はアプリが組み立てる文字列（`dmdata-<種別>-<eventId>-<serial>` の形）で、
 * 電文そのものには含まれない。**localStorage に残る値**でもあるため、書式を変えると
 * 更新前に保存された値と一致しなくなる。ここはその橋渡しを 1 箇所にまとめる場所。
 */

/**
 * 電文 id から、経路を XML へ一本化する前に挟まっていた `xml-` を落とす。
 *
 * かつては JSON 経路と XML 経路の出所を見分けるため `dmdata-xml-…` と付けていた。
 * JSON 経路を撤去して区別が要らなくなったので作る側は付けなくなったが、
 * **既読の記録のように永続化された値には旧書式が残る**。保存値と突き合わせる前に
 * 両辺をこれに通すと、更新をまたいだ利用者に「閉じたはずのものが出てくる」ことがない。
 */
export function normalizeDmdataTelegramId(id: string): string {
  return id.replace(/^dmdata-xml-/, 'dmdata-')
}
