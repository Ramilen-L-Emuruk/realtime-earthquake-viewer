// 事前生成 SDF グリフのフォントスタック名の単一情報源。
//
// この値は 2 箇所で完全一致していなければならない:
//   - symbol レイヤーの `text-font`（LabelsGL.tsx）。MapLibre はこの値を glyphs URL の {fontstack} に展開する。
//   - 生成物の出力ディレクトリ名 `public/fonts/<stack>/`（scripts/build-glyphs.mjs の STACK）。
//
// 両者がずれると MapLibre はエラーを出さず、該当テキストが**無音で消える**だけになる（背景・レイヤー自体は
// 正常に描かれるためデバッグしにくいサイレント障害）。そこでアプリ側の唯一の定義をここに集約し、
// build-glyphs.mjs は本ファイルを読んで STACK と突き合わせ、不一致ならビルドを失敗させる。
export const JP_FONT_STACK = 'Noto Sans JP'
