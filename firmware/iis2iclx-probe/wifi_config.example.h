// 接続先の設定。**このファイルをそのまま使わず、wifi_config.h という名前で
// 複製してから書き換えること。** wifi_config.h は .gitignore で除外してある。
// このリポジトリは公開されているので、資格情報を含むファイルを置かないこと。
//
// **保存する文字コードは UTF-8 のまま変えないこと**（理由は ../seismo-node/wifi_config.example.h）。
//
// 本体のファーム（seismo-node）の雛形より項目が少ない。このスケッチは UDP で送らず、
// 名前も固定（iis2iclx-probe）なので、要るのは Wi-Fi の 2 つだけ。
#pragma once

#define WIFI_SSID   "YOUR_SSID"
#define WIFI_PASS   "YOUR_PASSWORD"
