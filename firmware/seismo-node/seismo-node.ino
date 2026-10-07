// 自作地震計のセンサーノード。
//
// **ESP32 に時刻を刻ませない。** 素朴に delay() のループで読むと Wi-Fi のスタックが
// 割り込んでサンプル間隔が揺れる。周期補正フィルタ（気象庁告示第4号）は等間隔
// サンプリングを前提にしているので、揺れた波形を等間隔だと思って解析すれば震度の
// 値そのものが信用できなくなる。MPU6050 自身のクロックで FIFO へ溜めさせ、ESP32 は
// 吸い出すだけにすれば、サンプリングの規則性が ESP32 の都合から切り離される。
//
// **gal への換算はしない。** 生カウントのまま送り、換算に必要なスケールはパケットの
// ヘッダで伝える。センサーを差し替えても受け手を直さずに済むようにするため。
//
// **1 枚に複数のセンサーを載せる。** MPU6050 のアドレスは AD0 で選ぶ 0x68 / 0x69 の
// 2 つしか取れないので、3 個載せるには I2C のバスを 2 本に分ける。どのバスのどの
// アドレスから来た波形かは `sid` として名乗り、受け手はそれを別々の流れとして扱う。
//
// **1 個が黙ったら、黙ったと判る形にする。** 1 個だけの頃は「データが来ない」が
// そのまま異常の合図だったが、3 個あると残りが流れ続けるので**外からは正常に見える**。
// そこで ①失敗を種類ごとに数え ②続けて失敗するセンサーは `ok` を下ろし
// ③下ろしたものは定期的に初期化をやり直す、という一巡を持たせてある。
// **③が無いまま①②だけ入れると、一過性の失敗でそのセンサーが永久に死ぬ。**
//
// **ネットワークの側も「黙ったと判る形」にする。** 基板は送る側なので、繋がりが
// 壊れても自分では気づけない——`endPacket()` は成功を返し、HTTP（TCP）は別の経路で
// 応え続けるので、**外からは健全にしか見えない**（2026-09-30 に 1 枚が 5 日間
// その状態だった）。そこで ①時計が合う前は送らない ②Wi-Fi が繋がり直すたび
// 立て直す ③遠隔で再起動できる ④ホストの返事が途絶えたら自分で立て直す、の 4 つを
// 置いてある。それぞれ `clockTrusted`・`onWifiUp`・`handleRestart`・`checkAck` に
// 理由を書いた。

#include <Wire.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <ESPmDNS.h>
#include <ArduinoOTA.h>
#include <WebServer.h>
#include <time.h>
#include <stdarg.h>
#include <esp_mac.h>
#include <esp_random.h>
#include <esp_system.h>
#include <esp_sntp.h>
#include <esp_partition.h>
#include <esp_rom_crc.h>
#include <Preferences.h>
#include <functional>
#include "wifi_config.h"

// **この定義を持たない `wifi_config.h` でも焼けるようにする。** 設定ファイルは
// `.gitignore` で除外してあるので、各基板の手元には足す前の版が残っている。そちらを
// 先に直さないとコンパイルが通らない形にすると、**直したいファームを焼く手前で止まる**。
// 定義が無ければ口は閉じたまま（`adminTokenOk` が空のトークンを常に拒む）。
#ifndef ADMIN_TOKEN
#define ADMIN_TOKEN ""
#endif

// ホストの HTTP の口（`seismo-host` の `SEISMO_HTTP_PORT`）。返事が途絶えたとき、
// **ホストそのものが止まっているのか**を確かめるために叩く（→ `checkAck`）。
// 定義が無ければホストの既定値。理由は `ADMIN_TOKEN` と同じ（焼く手前で止めない）。
#ifndef HOST_HTTP_PORT
#define HOST_HTTP_PORT 50506
#endif

static const uint8_t R_SMPLRT_DIV=0x19, R_CONFIG=0x1A, R_ACCEL_CFG=0x1C, R_FIFO_EN=0x23;
static const uint8_t R_INT_STATUS=0x3A, R_USER_CTRL=0x6A, R_PWR_MGMT_1=0x6B;
static const uint8_t R_FIFO_COUNTH=0x72, R_FIFO_RW=0x74, R_WHO_AM_I=0x75;

// DLPF_CFG=4 は加速度側の帯域を 21Hz へ落とす。100Hz のナイキストは 50Hz なので、
// 44Hz（=3）では余裕がなく帯域外が折り返して 0〜3Hz へ積もる。
static const uint8_t DLPF_CFG=4, SMPLRT_DIV=9, AFS_SEL=0;
static const int     SAMPLE_HZ  = 1000 / (1 + SMPLRT_DIV);
static const float   UG_PER_LSB = 1000000.0f / 16384.0f;   // ±2g は 16384 LSB/g
static const size_t  BPS = 6;                              // XYZ × 2 バイト
static const uint32_t DRAIN_MS = 300;
static const size_t  I2C_CHUNK = 120;   // Wire の受信バッファ超過は黙って切り捨てられる
static const size_t  MAX_PER_PACKET = 40;  // UDP を MTU 内へ収める

// バス 1 の割り当て。バス 0 は既定（GPIO21/22）のまま使う。
// **ESP32-WROVER では使えない。** GPIO16/17 が内蔵 PSRAM に配線されている。
static const int I2C1_SDA = 16, I2C1_SCL = 17;

// 連続してこの回数だけ I2C に失敗したら `ok` を下ろす。300ms 周期なので約 6 秒。
// **1 回で下ろさない**——バスは時々こける。**下ろさないのも駄目**で、その場合
// 初期化をやり直す機会が永久に来ない。
static const uint32_t FAIL_STREAK_TO_DEMOTE = 20;
// `ok` が下りているセンサーの初期化をやり直す間隔。
static const uint32_t RETRY_MS = 10000;

// 時計が合ったと見なす下限（2023-11-15）。**これより前の時刻を名乗るパケットは送らない。**
//
// 基板は SNTP の応答を待たずに波形を読み始める（`configTime` は投げるだけで、
// 返ってくるのは数秒後）。`gettimeofday` はその間 1970 年を返すので、そのまま送ると
// 受け手には**「通し番号は続いているのに、時刻だけが 50 年以上飛んだ」**パケットとして
// 届く。受け手（`seismo-host`）はそれを区間の切れ目として扱うようにしたが、
// **そもそも送らないのが筋**——番号が続いたまま時刻が飛ぶ形は、受け手の側では
// 「基板が壊れた」と「時計がいま合った」を見分けられない。
//
// **この下限だけでは「合った」と言えない**（→ `clockTrusted`）。
static const time_t MIN_SYNCED_UNIX = 1700000000;

// SNTP で時計を取り直す間隔。**コアの既定（3 時間）では長すぎる。**
//
// 水晶のずれは基板ごとに違い、実機の 3 枚で約 5〜14 ppm あった（2026-09-27〜10-02 の
// 生データで、取り直しの跳びと、取り直さなかった間のずれの伸びから測った）。3 時間置くと、
// いちばんずれる基板は 1 回の取り直しで時計が **約 136 ms 跳ぶ**（同じ生データで実測）。
// 受け手はパケットの時刻が 100 ms を超えて跳ぶと区間を切る
// （`seismo-host` の `TIMEBASE_CONSISTENCY_MS`）ので、3 時間ごとに計測震度のフィルタが
// 振り出しへ戻る。しかも取り直しの直前には基板どうしの時計が 100 ms 以上離れ、
// 観測点の合成が待ちきれずに顔ぶれを欠く。15 分なら跳びは 14 ppm でも約 13 ms に収まる。
// 問い合わせは基板 1 枚あたり 1 時間に 4 回。
static const uint32_t SNTP_SYNC_INTERVAL_MS = 15UL * 60UL * 1000UL;

// 起動してからこの時間 Wi-Fi に一度も繋がらなければ、シリアルへ 1 度だけ警告を出す。
//
// **繋がり具合の変わり目でしか記録しない作りには、この穴が開く。** 起動時から
// 繋がらない基板は「繋がっていない」が続くだけなので**遷移が起きず、1 行も出ない**。
// かつては `setup()` が 30 秒待ってから「# wifi FAILED」を出していたので、
// **待つのをやめた時点でこの記録が失われていた**（そしてこの場面では HTTP も OTA も
// 立っていないので、シリアルだけが唯一の診断の手段）。値は当時の 30 秒に合わせてある。
static const uint32_t NO_WIFI_WARN_MS = 30000;

// ホストの返事（`seismo-ack <MAC>`）がこの時間来なければ、段を 1 つ上げる（→ `checkAck`）。
//
// **計り始めるのは、返事のあとで最初に送れたとき。** Wi-Fi が切れている間や時計が
// 合う前は送っていないので、返事が来ないのは当たり前——そこを数えると、送っていない
// 基板が「届いていない」と思い込んで立て直しを始める。
//
// ホストは基板ごとに 1 秒に 1 回返すので、15 秒は 15 回ぶんの取りこぼしにあたる。
// UDP の返事が数回落ちる程度では上がらず、本当に途絶えたときだけ上がる。
static const uint32_t ACK_SILENCE_MS = 15000;

// 段を上げる前にホストへ HTTP で訊くときの待ちの上限（→ `hostReachable`）。
//
// **この間は吸い出しも止まる**（`loop()` が 1 本なので）。FIFO は 1024 バイト＝
// 170 サンプル＝1.7 秒ぶんを抱えられ、吸い出しの周期が 0.3 秒なので、待てるのは
// 1.4 秒まで。**接続 0.5 秒＋答え 0.5 秒＝1.0 秒**で、0.4 秒を残してその内に収める
// （`delay(5)` の刻みや `stop()` の後始末の分も、残りが受け持つ）。LAN 内の相手なら
// 往復は数ミリ秒で、どちらも十分に長い。
static const int32_t  HOST_PROBE_TIMEOUT_MS = 500;
static const uint32_t HOST_PROBE_REPLY_MS = 500;

// 自分で再起動してよい回数と、その数え直しの間隔（→ `restartAllowed`）。
//
// **上限が無いと、再起動しても直らない故障で再起動を繰り返し続ける**——起動のたびに
// 時計合わせからやり直すので、そのあいだ波形が 1 件も出ない。上限に達したら再起動だけを
// 飛ばし、UDP の作り直しと Wi-Fi の繋ぎ直しは続ける（どちらも波形を止める時間が短い）。
static const uint32_t SELF_RESTART_MAX = 3;
static const int64_t  SELF_RESTART_WINDOW_S = 6 * 3600;

// 直前の状態を NVS へ書く間隔（→ `PrevState`・`prevPump`）。
//
// **何も変わらなくても書く。** 書いた時刻が「最後に生きていた時刻」になる —— 固まった基板は
// 固まった時刻で記録が止まり、Wi-Fi に戻れないだけの基板は電源を抜く直前まで書き続ける。
// 変わったときだけ書く形だと、この 2 つが同じ「古い記録」に化ける。
//
// 1 回の記録（`PrevState`・72 バイト）は NVS の項目 5 つ（1 項目 32 バイト。blob のデータの
// 見出し 1 ＋ 中身 3 ＋ blob の索引 1）。既定の区画（20 KB・使い回すのは 4 ページ・1 ページ
// 126 項目）だと 1 ページに約 25 回ぶん入り、各ページの消去は 60 秒ごとの書き込みで約 100 分に
// 1 回 —— 消去の寿命（約 10 万回）まで約 19 年。Wi-Fi の設定も同じ区画に置かれ、ページを
// 詰め直すたびに新しいページへ写し直される（中身は変わらない。写し直しも上の消去の回数に含まれる）。
static const uint32_t PREV_HEARTBEAT_MS = 60000;
// 状態が変わったときに書く間隔の下限。**Wi-Fi が明滅すると変わり目が 1 秒に何度も来る**ので、
// 変わり目ごとに書くと上の見積もりが崩れる。間引いても最新の状態はこの間隔で必ず書く
// （`g_prevDirty`）。**起動直後もこの間は書かない** —— 起動してすぐ落ちる繰り返しに入った
// 基板が、起動のたびに NVS を書くことになるうえ、前回まで動けていた起動の記録をすぐ潰す。
static const uint32_t PREV_MIN_GAP_MS = 10000;
// `loop()` の 1 周がここまで時間を使っていたら、その周では書かずに次の周へ回す（→ `prevPump`）。
//
// **吸い出しが待てるのは 1.4 秒まで**（→ `HOST_PROBE_TIMEOUT_MS`）。返事が途絶えている最中は、
// 同じ周でホストへの問い合わせ（最大 1.0 秒）とフラッシュの区画の書き出し（実機で最長 57 ms。
// 2026-10-06）が重なりうる。NVS もページを詰め直す回は消去が入るので、そこへ 3 つ目を
// 積まない。200 ms なら、問い合わせを挟んだ周だけを避け、普段の周（数 ms）は止めない。
static const uint32_t PREV_DEFER_AFTER_MS = 200;

// 端数（FIFO の件数が 6 の倍数でない）がこの回数だけ続いたら FIFO を作り直す。
//
// **この数字が「書き込み途中の端数」と「本当に境界が崩れた」を分ける。**
// - 書き込み途中の端数は 1 周期で消える。吸い出しの周期（ESP32）とサンプリングの
//   周期（MPU の内部クロック）は別の発振器なので位相が毎周期ミリ秒単位でずれ、
//   数十マイクロ秒の窓を 2 度続けて引き当てることは実質起きない
// - 本当に 1 バイト失われているなら、端数は作り直すまで**永久に残る**
//
// **2 にしてあるのは、答えが出るまでに待つ時間を 1 周期に留めるため。** 大きくすると、
// 境界が本当に崩れている場合に、作り直すまでのあいだ FIFO へサンプルが溜まり続ける。
static const uint32_t PARTIAL_STREAK_TO_DROP = 2;

// FIFO を作り直してもまだ端数が出る、が続いたら `ok` を下ろして初期化からやり直す。
//
// **あふれが続いても降格しないのと、ここは意図して非対称にしてある。** あふれは
// 吸い出しが間に合っていない（Wi-Fi が詰まる等）ということなので、**センサーを
// 初期化し直しても直らない**。いっぽう「FIFO を空にしても端数が残る」なら、次に
// 疑うのは FIFO ではなく設定のほうで、初期化をやり直す意味がある。
//
// 1 回の作り直しに 2 周期かかるので、5 回で約 3 秒。**偽陽性は考えなくてよい** ——
// 書き込み途中を続けて引き当てて作り直しに至ること自体が十数時間に 1 度の頻度で、
// それが端数なしの読み出しを 1 度も挟まずに 5 回続く確率は無視できる。
static const uint32_t REALIGN_STREAK_TO_DEMOTE = 5;

// 送った分を残しておく輪の区画数（→ `BacklogSlot`・`handleBacklog`）。
//
// **送れたかどうかに関わらず、時計が合ってから作ったまとまりは全部残す。** 基板は
// 自分の送ったものが届いたかを知らない —— `endPacket()` は届いていなくても真を返し
// （冒頭の 2026-09-30 の件）、ホストの返事は「生きている」を 1 秒に 1 回知らせるだけで
// どのまとまりが届いたかは言わない。**欠けを知っているのはホストのほう**なので、
// 基板は直近を丸ごと抱えておき、ホストに訊かれた範囲を返す。
//
// 1 区画は 1 まとまり（最大 40 サンプル）。吸い出しは 0.3 秒ごとに 1 センサー 1 まとまりを
// 作るので 3 センサーで毎秒約 10 区画、**300 区画で直近約 30 秒**。1 区画は 264 バイトで
// 約 79 KB を使う（起動時に確保する。確保前の空きメモリは約 200 KB だった）。
//
// **長い途絶えはフラッシュが受け持つ**（→ `SPILL_AFTER_MS`）。メモリの輪は、書き出しが
// 追いつくまでの数秒と、繋がり直してからホストが取りに来るまでの間をつなげれば足りる。
// 360 区画（36 秒）から減らしたのは、フラッシュの書き出しの作業場（約 25 KB）を空けるため。
static const size_t BACKLOG_SLOTS = 300;
// `/backlog` が 1 回に返すまとまりの上限。**応答を作っている間は吸い出しも止まる**
// （`loop()` が 1 本なので）。待てるのは 1.4 秒まで（→ `HOST_PROBE_TIMEOUT_MS`）。
// 1 まとまりは平均約 580 バイトなので、30 まとまりで約 17 KB（実測 0.17 秒で返った）。
// 続きはホストが訊き直す。
static const size_t BACKLOG_MAX_PER_REPLY = 30;

// ホストの返事がこの時間来なければ、送った分をフラッシュへ書き出し始める（→ `spillPump`）。
//
// **メモリの輪だけでは 30 秒しか持たない。** PC の再起動・ホストの落ち・Wi-Fi の長い途絶えは
// 分の単位で続く。フラッシュのデータ領域（既定の分割の `spiffs`、約 1.4 MB）を輪にして使えば
// 約 11 分ぶん抱えられる。
//
// **途絶えている間だけ書く。** 常に書くとフラッシュの書き換え回数（1 区画あたり約 10 万回）を
// 毎日食い潰すが、途絶えている間だけなら、輪を 1 周しても 1 区画 1 回にしかならない。
//
// **8 秒にしてある。3 秒では短すぎた**（2026-10-02 に a0b7 で実測）。電波の弱い基板
// （RSSI −77）では返事が数秒途切れることが珍しくなく、3 秒だと 100 秒に 5 回書き始め、
// そのたびに区画を書いていた。メモリの輪は 30 秒ぶんあるので、8 秒待っても取りこぼさない。
static const uint32_t SPILL_AFTER_MS = 8000;
// 書き始めるとき、最後に返事を受けた時刻からさかのぼって写す幅（→ `spillPump`）。
//
// **輪を丸ごと写さない。** 返事が来ていた間に送った分は届いている（ホストは受けたパケットに
// 返事を返す）。丸ごと写すと、返事が数秒途切れただけで 30 秒ぶん（約 16 区画）を書き直す ——
// 実測で 100 秒に 49 区画になり、区画の書き換え回数を数か月で使い切る勢いだった。
// 2 秒は、返事が 1 秒に 1 回であることと、返事の往復のぶんの余裕。
static const int64_t SPILL_BACKFILL_MS = 2000;
// 返事が途絶えたまま書き出すのはここまで（→ `spillPump`）。**返事を一度も返さないホスト**（返事の口を
// 持たない古いホスト・返事を止めた設定）や、繋がらないまま動き続ける基板では、途絶えが
// 終わらないので書き出しも終わらない。止めないと、フラッシュの輪を 11 分に 1 周ずつ
// 書き換え続ける（1 区画の書き換えは約 10 万回まで）。
//
// **30 分にしてある。** ホストが欠けを諦めるのは見つけてから 20 分（ホストの
// `BACKLOG_BOOK_OPTIONS`）で、フラッシュが抱えられるのは約 11 分 —— それより長く書いても
// 取り戻せる分は増えず、上書きが増えるだけ。PC の再起動や Wi-Fi の数分の途絶えは十分覆う。
// 止めた後は、**返事が一度戻るまで書き始めない**（戻らないまま 8 秒ごとに書き始め直すと、
// 止めた意味が無くなる）。
//
// **`gap=` で頼まれて書いている間には掛けない。** 返事が届いているのでホストは生きていて、
// 指しているのは書く値打ちのある欠け。欠けはホストが 20 分で諦めるので、同じ欠けのために
// 書き続けることもない。干渉が長く続けばそのぶん書くが、それは取り戻せる分を救っている。
static const uint32_t SPILL_MAX_MS = 30UL * 60UL * 1000UL;
// フラッシュの消去の単位。**書き出しは 1 区画（4 KB）ずつ**、`loop()` の 1 周に 1 回まで ——
// 消去の間は処理が止まる（典型で数十ミリ秒）ので、まとめてやると吸い出しを待たせる。
static const size_t FLASH_SECTOR = 4096;
// フラッシュの区画の先頭に置く印。消去された区画（0xFF で埋まる）や別の中身と見分ける。
//
// **"SBL2" は区画の中身の CRC を持つ形。** 前の形（"SBL1"）の区画は読まない（空きとして扱い、
// 輪が回ってきたら上書きする）—— 形が違うので、読むと頭の欄を取り違える。
static const uint32_t FLASH_MAGIC = 0x53424c32;   // "SBL2"

// 1 枚にぶら下がるセンサー 1 個ぶんの状態。
//
// **勘定をセンサーごとに持つ。** 通し番号もあふれの回数も、まとめて数えると
// 受け手が「どの流れが途切れたか」を辿れなくなる。`q`（通し番号）と `o`（あふれ）は
// 不連続を見つけるための値なので、混ぜた時点で役目を失う。
//
// **失敗も種類ごとに分ける。** 「読めていない」「境界が合わない」「送れていない」は
// 原因も手当ても違うのに、1 つに合算すると状態ページを見ても何が起きたか判らない。
struct Sensor {
  TwoWire*    wire;
  uint8_t     addr;
  const char* sid;      // 受け手がこの名前で流れを分ける。バス番号とアドレスの組
  bool        ok;
  uint8_t     who;
  uint32_t    seq;
  uint32_t    overflow;
  uint32_t    sent;
  int16_t     last[3];
  uint32_t    i2cFail;      // I2C の取引が失敗した回数（読み・書きとも）
  uint32_t    failStreak;   // 連続で失敗している回数。成功したら 0 へ戻す
  // **FIFO の件数が 6 の倍数にならないことがある。それ自体は異常ではない。**
  //
  // データシート（RM-MPU-6000A-00）が定めているのは「FIFO_COUNT は溜まっている
  // **バイト数**」（Register 114/115）と「データは**レジスタ番号の順に** FIFO へ
  // 書かれる」（Register 116）の 2 つだけで、**件数が 1 サンプル分の倍数になるとは
  // 書いていない。** 6 バイトを内部で書いている最中に件数をラッチすれば端数が出る。
  uint32_t    partial;        // 端数を見た回数
  uint32_t    partialStreak;  // 端数が続いている周期の数。倍数で読めたら 0 へ戻す
  uint32_t    realign;        // 端数が続いたので FIFO を作り直した回数（こちらが異常）
  uint32_t    realignStreak;  // 連続で作り直した回数。1 度でも端数なしで読めたら 0 へ戻す
  // 端数の内訳。**添字 0 が端数 1 バイト。** 書き込み途中なら 1〜5 に散り、本当に
  // 1 バイト失われているなら 5 に偏る——2 つの原因を実機で分けるための値。
  uint32_t    remHist[BPS - 1];
  uint32_t    unsent;       // 読めたのに送れなかったサンプル数
  // **時計が合う前に読めたサンプル数。** `unsent` と分けてあるのは、原因も手当ても
  // 違うため——あちらは Wi-Fi が繋がっていない、こちらは繋がっているが SNTP の応答が
  // まだ来ていない。**起動直後に少し増えて止まるのが正常。** 増え続けているなら
  // 時刻が取れておらず、その基板は一度も波形を送らない（`clockTrusted` の項）。
  uint32_t    pretime;
  uint32_t    initTries;    // 初期化を試みた回数（1 回目の起動時を含む）
  // 直近の初期化で失敗した I2C 取引の数。**設定の書き込みと WHO_AM_I の読み取りの
  // 両方が入る。** 「書き込み」と名乗ると、読み取りだけが落ちたときに設定が飛んだと
  // 誤診断される。
  uint8_t     initFails;
};

// **`sid` はバスとアドレスから機械的に決まる名前**にしてある。設置の都合（どの向きか、
// どの棚か）を混ぜると、センサーを挿し替えた日を境に同じ名前が別の個体を指す。
//
// **残りの欄は書かない。** 集成体の初期化では、書かなかった欄は 0（`bool` は false・
// 配列は全要素 0）で埋まる。3 行に 0 を並べる形だと欄を 1 つ足すたびに 3 行とも
// 数え直すことになり、**数え違えても型検査は通る**——どれも同じ型の 0 なので、
// ずれたまま隣の欄へ入るだけ。数える作業そのものを無くしてある。
static Sensor g_sensors[] = {
  { &Wire,  0x68, "i2c0-68" },
  { &Wire,  0x69, "i2c0-69" },
  { &Wire1, 0x68, "i2c1-68" },
};
static const size_t SENSOR_N = sizeof(g_sensors) / sizeof(g_sensors[0]);

// 組み立て中のパケット。
//
// **積んだ分は必ず出ていく。** 通し番号と先頭時刻の繰り上げもここが見る。
//
// 以前は `drainSensor` が「溜める配列」「通し番号」「先頭時刻」を手で回しており、
// **読み出しに失敗して途中で抜ける経路が、既に読めていたサンプルを送らずに捨てていた**
// （I2C の 1 取引は 20 サンプル・1 パケットは 40 サンプルなので、2 回目の取引で
// こけると 20 件が消える）。積む口と出す口を 1 つの持ち物へまとめれば、
// **出し忘れる場所そのものが無くなる。**
//
// **宣言をここから下げないこと。** Arduino は最初の関数定義の直前へ、ファイル中の
// 全関数のプロトタイプをまとめて挿し込む。関数の引数に使う型がそれより後ろにあると、
// 挿し込まれた時点では未定義で **`Packet was not declared in this scope` になる**
// （実際に踏んだ）。`Sensor` を冒頭に置いてあるのも同じ理由。
struct Packet {
  Sensor*  s;
  size_t   n;
  uint32_t seq0;
  int64_t  tFirstMs;
  int16_t  v[MAX_PER_PACKET * 3];
};

// 送った分の輪の 1 区画（→ `BACKLOG_SLOTS`）。**送ったときのヘッダを作り直せる値だけを持つ。**
//
// `o`（あふれの累計）も残す。送った時点の値を返さないと、ホストが取り戻した分の切れ目を
// 読み違える（取り戻した時点の `s.overflow` は、送った後のあふれまで数えている）。
// 宣言をここに置く理由は `Packet` と同じ。
struct BacklogSlot {
  int64_t  tFirstMs;
  uint32_t seq0;
  uint32_t overflow;
  uint8_t  sensor;   // `g_sensors` の添字
  uint8_t  n;        // 積んだサンプル数
  // フラッシュへ写したか（→ `spillPump`）。**写したかどうかは位置では分からない** —— `gap=` で
  // 書き出すと輪の途中から写し始め、手前を後から追って写すので、写した分は輪の中で飛び飛びになる。
  // 輪へ積むたびに 0 へ戻す（`backlogPut`）。
  uint8_t  flashed;
  int16_t  v[MAX_PER_PACKET * 3];
};

// `/backlog` が返すまとまりの在りか（→ `collectBacklog`）。中身は持たず、返すときに取り出す。
// 宣言をここに置く理由は `Packet` と同じ。
struct BacklogRef {
  uint32_t seq0;
  uint16_t sector;   // フラッシュの区画の添字。`BACKLOG_REF_MEMORY` ならメモリの輪
  uint16_t at;       // 区画の中のバイト位置か、メモリの輪の位置（0 がいちばん古い）
  uint8_t  n;
};
static const uint16_t BACKLOG_REF_MEMORY = 0xFFFF;

// フラッシュの 1 区画が抱える、センサーごとの通し番号の範囲 `[from, to)`。
struct FlashRange {
  uint32_t from;
  uint32_t to;
  uint32_t has;      // 0 ならこのセンサーの分は無い（`from`・`to` は無意味）
};

// フラッシュの 1 区画（4 KB）の先頭。**起動 ID を区画ごとに持つ** —— 基板が再起動しても、
// 前の起動の分をそのまま返せる（ホストはその起動 ID で訊いてくる）。
//
// 後ろには 1 まとまりずつ詰めて並べる。1 まとまりは 20 バイトの頭 ＋ サンプル数 × 6 バイトで、
// **区画の大きさに合わせて切らない**（メモリの輪の区画は最大の 40 サンプルぶんを取っているが、
// フラッシュでは実際の長さで書く。約 30 サンプルが普通なので、同じ領域に 1.3 倍ほど入る）。
// センサーが 3 個のときの形。**4 個目にするときはここも広げる**（`static_assert` が止める）。
struct FlashSectorHead {
  uint32_t   magic;     // `FLASH_MAGIC`
  uint32_t   seq;       // 書いた順。大きいほど新しい
  uint32_t   bid;       // 起動 ID（`g_bootId` の 16 進を数にしたもの）
  uint16_t   records;   // 入っているまとまりの数
  uint16_t   used;      // 頭を含めて使ったバイト数
  // 頭の後ろ（`used` まで）の CRC-32。**読むたびに確かめる** —— 書いている途中で電源が落ちた
  // 区画や、上書きの途中で読んだ区画は、頭が正しくても中身が壊れている。壊れたまとまりを
  // 本物として返すと、ホストは欠けを埋めたと信じて二度と取りに来ない。
  uint32_t   crc;
  FlashRange range[3];
};

// フラッシュの区画の目録（メモリに置く）。**起動時に 1 回だけ作る**（`flashInit`）—— `/backlog` の
// たびに 1.4 MB を読み直すと、応答を作る間ずっと吸い出しが止まる。
struct FlashSectorIndex {
  uint32_t   seq;
  uint32_t   bid;
  uint32_t   valid;     // 0 なら空き（消去済み・壊れている）
  FlashRange range[3];
};
// **センサーの数とフラッシュの区画の形を揃える。** ずれたまま焼くと、4 個目のセンサーの範囲が
// 区画の頭からはみ出して隣の欄を壊す（コンパイルは通ってしまう）。
static_assert(sizeof(FlashSectorHead::range) / sizeof(FlashRange) == SENSOR_N,
              "FlashSectorHead::range must have one entry per sensor");
static_assert(sizeof(FlashSectorIndex::range) / sizeof(FlashRange) == SENSOR_N,
              "FlashSectorIndex::range must have one entry per sensor");


static WiFiUDP    udp;
static WebServer  http(80);
static uint32_t   g_bootMs = 0;
static char       g_node[24] = "";
static char       g_mac[18] = "";       // コロン区切り。表の照合と状態ページ用
static char       g_macFlat[13] = "";   // 区切りなし。パケットが名乗る識別子
static char       g_bootId[9] = "";
// バスごとのスキャン結果。応答したアドレスを "0x68,0x69" の形で持つ。
static char       g_scan[2][96] = {"", ""};
static uint8_t    g_scanN[2] = {0, 0};
static bool       g_scanCut[2] = {false, false};   // 並びが収まらず途中で切れた
static bool       g_busOk[2] = {false, false};     // Wire.begin() が成功したか
// ヘッダの JSON が収まらなかった回数。**起こらないはずのことなので、起きたら数える。**
static uint32_t   g_headTrunc = 0;
// Wi-Fi がいま繋がっているか。**変わり目を見るために持つ**——`WiFi.status()` を
// その場で読むだけでは「たったいま繋がった」が判らず、立て直す契機を作れない。
static bool       g_wifiUp = false;
// アドレスを取り直したことをイベントで知らせる旗。
//
// **`loop()` の見張りだけでは取りこぼす。** 切れてから繋がるまでが `loop()` の
// 1 周より短いと、状態はずっと `WL_CONNECTED` のままに見えて変わり目が立たない
// ——そのとき**ソケットは切れる前の無効なまま残る**。つまり今回直そうとしている
// 症状（送れたつもりで出ていない）が、別の入口からそのまま再現する。
//
// `volatile` なのは、立てるのが Arduino のイベントタスクで読むのが `loop()` と、
// **別の実行の流れをまたぐ**ため。
static volatile bool g_wifiGotIp = false;
// 一度だけ立てるもの（mDNS・OTA・状態ページ）を立て終えたか。繋ぎ直すたびに
// 立て直してはいけない理由は `onWifiUp` の項。
static bool       g_servicesUp = false;
// UDP のソケットを開けた回数。**普段は `g_wifiGotIpCount` と一致する**
// （2026-10-01 に繋ぎ直しを繰り返して差 0 を確認）。
//
// **一致を当てにはしない。** 差はどちら向きにも出うる：
// - `g_wifiGotIpCount` が大きい：`STA_GOT_IP` が `loop()` の 1 周のうちに 2 度来ると、
//   旗が 1 つなので 1 回の開き直しにまとまる
// - こちらが大きい：1 度の接続を、繋がり具合の見張りとイベントの両方が拾って 2 回開く
//   （勘定を分ける前の版で、起動直後に 2 になったのを 1 度見た。どちらの理由かは
//   切り分けていない）
// どちらも無害。**開きすぎは害が無いが、開き漏らすと「送れたつもりで出ていない」が
// そのまま戻る**ので、漏らさない側へ倒してある。開き損ねは `g_udpArmFail` に出る。
static uint32_t   g_udpArmed = 0;
// `STA_GOT_IP` を受けた回数。**`g_udpArmed` と並べて出すためだけに持つ。**
//
// 片方だけだと「繋ぎ直しが 2 回起きた」と「1 回の繋ぎ直しで 2 回開いた」が
// 同じ数字に化ける——**原因の違う 2 つを見分けられない**。
//
// **`volatile` が要る。** 書くのはイベントタスク・読むのは `loop()`（状態ページ）で、
// 隣の `g_wifiGotIp` と同じく実行の流れをまたぐ。**食い違いを見つけるために置いた値が、
// 古い値のまま読まれては役目を果たさない。**
static volatile uint32_t g_wifiGotIpCount = 0;
// UDP のソケットを開こうとして失敗した回数。
//
// **`udp_armed` を無条件に進めてはいけない。** 進めると、あの数字は「開けた回数」では
// なく「開こうとした回数」になる——**`endPacket()` が真を返しながら 1 バイトも
// 出ていなかった**のと同じ、名前と実態の乖離をこちらで作ることになる。
static uint32_t   g_udpArmFail = 0;
// 時計が合ったことを一度でも見たか。**起動ログへ 1 行出すためだけに持つ。**
//
// 時計が合うまで 1 件も送らない作りなので（→ `clockTrusted`）、**SNTP が
// 返ってこない環境ではその基板が永久に沈黙する**。状態ページには `time_synced` と
// `pretime` が出るが、**シリアルを見ている最中に「待っている」のか「始まった」のかが
// 判る印が要る**——起動ログだけ追っている場面で、沈黙の理由が時刻だと分からない。
static bool       g_timeReady = false;
// **この起動で** SNTP が時計を合わせた回数と、最後に合わせた時刻（unix 秒）。
//
// **書き手は SNTP のコールバック（lwIP のタスク）だけ。** `loop()` は読むだけなので、
// `volatile` の 32 bit 値なら読み書きが割れない（`g_wifiGotIpCount` と同じ形）。
// 時刻を 32 bit に収めるのは割れないため——unix 秒なら 2106 年まで足りる。
static volatile uint32_t g_sntpSyncs = 0;
static volatile uint32_t g_sntpLastSyncUnix = 0;
// この起動で SNTP を始めたか（→ `onWifiUp`）。
static bool       g_sntpStarted = false;

static void onSntpSync(struct timeval *tv){
  g_sntpLastSyncUnix = (uint32_t)tv->tv_sec;
  // `++` で書かない理由は `g_wifiGotIpCount` と同じ。
  g_sntpSyncs = g_sntpSyncs + 1;
}

// 名乗ってよい時計か。**送信の門（`sendChunk`）と状態ページの `time_synced` の両方が
// これを通る。** 別々に持つと、ページが「合っている」と名乗りながら送信は止まっている
// （またはその逆の）状態が作れてしまい、**外から見て説明の付かない基板**になる。
//
// **「時刻が 2023 年以降か」だけでは判らない。** ESP32 はソフトウェアの再起動
// （OTA の書き込み後・`/restart`・返事の途絶による自分での再起動）では、時計を
// RTC に残したまま起き上がる（`CONFIG_LIBC_TIME_SYSCALL_USE_RTC_HRT`）。下限は
// 起動した瞬間から満たされるのに、中身は最後に合わせたときから水晶のずれを
// 積んだままの値で、**どれだけ古いかは基板自身にも分からない**。2026-10-01 に
// この下限だけで判定していたため SNTP を一度も始めず、3 枚の時計が 22 時間で
// 0.5〜1.3 秒遅れた（受け手の観測点の合成が、毎回いちばん遅れた基板を欠いた）。
// **この起動で一度でも合わせたことを条件にする。** 電源投入（1970 年から始まる）でも
// ソフトウェアの再起動でも、同じ 1 つの条件で判定できる。
//
// **SNTP が届かない間は送らないまま待つ。持ち越した時計で送る逃げ道は置かない**（2026-10-02 に
// 決めた）。置けば、ここで直した「ずれた時刻のデータが黙って流れる」状態をわざわざ作り直す。
// 代わりに失うものが 1 つある —— 送らないので返事の途絶も起きず、**返事による立て直し
// （`checkAck`）が動かない**。一時的な不通なら lwIP の SNTP が自分で再試行して合ったところで
// 送り始めるので、黙り続けるのは SNTP が恒常的に届かないときだけ。そのときは状態ページ
// （`time_synced:false`・`sntp_syncs:0`・増え続ける `pretime`）と、ホストの「割り当てた基板が
// 届いていない」で気づける（電源投入のときはもとからこの振る舞い）。
static bool clockTrusted(time_t now){
  return g_sntpSyncs > 0 && now >= MIN_SYNCED_UNIX;
}
// UDP のソケットがいま開いているか。**返事を読みに行ってよいかの門。**
//
// 開いていないソケットで `parsePacket()` を呼ぶと、コアが `ioctl` の失敗を
// `loop()` の 1 周ごとにログへ出す（`NetworkUdp.cpp` の `parsePacket`）。
static bool       g_udpOpen = false;
// 最後に UDP を開こうとした時刻（→ `armUdp`・`retryUdpOpen`）。
static uint32_t   g_lastArmMs = 0;

// --- ホストの返事（→ `checkAck`） ---
static uint32_t   g_acks = 0;            // 自分宛ての返事を受けた数
static uint32_t   g_lastAckMs = 0;       // 最後に受けた時刻（`g_acks` が 0 なら無意味）
// 最後に返事を受けた時刻（unix ミリ秒）。**サンプルの時刻と比べるため**（→ `SPILL_BACKFILL_MS`）。
// `millis()` の物差しではまとまりの時刻（`tFirstMs`）と比べられない。
static int64_t    g_lastAckUnixMs = 0;
static uint32_t   g_ackForeign = 0;      // 同じソケットへ届いた、自分宛ての返事ではないもの
// 返事を待っているか、と待ち始めた時刻。**返事のあとで最初に送れた時点から計る**
// （→ `ACK_SILENCE_MS`）。
static bool       g_ackWaiting = false;
static uint32_t   g_ackWaitStartMs = 0;
// 次に打つ手。0: UDP を作り直す／1: Wi-Fi を繋ぎ直す／2: 再起動。**返事が 1 つ届けば 0 へ戻る。**
// Wi-Fi が繋がり直しても戻さない——戻すと繋ぎ直しのたびに 0 からやり直し、再起動の段へ届かない。
static uint8_t    g_ackLevel = 0;
static uint32_t   g_ackRearms = 0;       // 返事の途絶で UDP を作り直した回数
// 返事の `gap=`（→ `readAcks`・`spillPump`）。**ホストがまだ取り戻せていない欠けの、
// センサーごとのいちばん古い始まり。** 最後に `gap=` 付きの返事を受けたときの値を持つ。
static uint32_t   g_gapFrom[SENSOR_N] = {};
static bool       g_gapHas[SENSOR_N] = {};
static uint32_t   g_lastGapMs = 0;       // 最後に `gap=` 付きの返事を受けた時刻（`g_gapAcks` が 0 なら無意味）
static uint32_t   g_gapAcks = 0;         // `gap=` 付きの返事を受けた数
static uint32_t   g_gapBad = 0;          // `gap=` の中身を読めなかった数（返事としては受ける）
// `gap=` を受けてから、書き出しの位置より手前をまだ見直していない（→ `spillBackCopy`）。
static bool       g_gapBackPending = false;
static uint32_t   g_ackReconnects = 0;   // 返事の途絶で Wi-Fi を繋ぎ直した回数
static uint32_t   g_hostProbeFail = 0;   // 返事が途絶えてホストへ HTTP で訊いたが答えが無かった回数
static uint32_t   g_restartSkipped = 0;  // 再起動の段に来たが上限で飛ばした回数
static bool       g_warnedNoAck = false; // 「返事を一度も受けていない」を 1 度だけ出したか

// 自分で再起動した回数の帳面。**再起動をまたいで残す**ので RTC の初期化しない領域に置く。
//
// **`RTC_DATA_ATTR` では足りない。** あちらが残るのは深いスリープからの復帰だけで、
// `ESP.restart()` ではブートローダが初期値を載せ直す。`RTC_NOINIT_ATTR` は
// ソフトウェアの再起動では触られず、**電源を入れたときは中身が不定**になる——
// そこで `magic` で「読める帳面か」を見分け、電源投入なら必ず白紙にする（→ `setup`）。
//
// **時刻は unix 秒で持つ。** `millis()` は再起動で 0 へ戻るが、RTC の時計は
// ソフトウェアの再起動を越えて進み続ける（段 A で `pretime` が電源の入れ直しでしか
// 増えないことを実機で確かめた。**いまは送信の門が `clockTrusted` なので、ソフトウェアの
// 再起動のあとも SNTP が最初に合わせるまでの数秒は `pretime` が増える**）。窓を測るだけなら
// 持ち越した時計で足りるので、ここは `clockTrusted` ではなく下限だけを見る。
struct RestartLedger {
  uint32_t magic;
  uint32_t count;        // `firstUnix` から数えた自分での再起動の回数
  int64_t  firstUnix;    // 数え始めた時刻
  uint32_t pending;      // 1 なら「直前の再起動は自分で起こした」
};
static const uint32_t RESTART_LEDGER_MAGIC = 0x5e15ac01;
RTC_NOINIT_ATTR static RestartLedger g_restartLedger;
// この起動が、返事の途絶による自分での再起動から始まったか。**状態ページで確かめるため。**
// `/restart` でも OTA でも理由は同じ `ESP_RST_SW` になるので、理由だけでは分けられない。
static bool       g_bootedBySelfRestart = false;
static esp_reset_reason_t g_resetReason = ESP_RST_UNKNOWN;

// --- 直前の状態（→ `prevSave`・`prevPump`） ---
//
// **電源を入れ直しても消えない場所に、いまの様子を書いておく。** 上の帳面（`RTC_NOINIT_ATTR`）も
// 数え上げ（`g_ackReconnects` など）も電源を切ると消える。2026-10-05 01:02 に 3 枚が同時に受信を
// 欠き、1 枚だけが戻らず ping も ARP も消えた —— 電源を入れ直すしか戻す手が無く、入れ直した時点で
// `reset_reason=poweron`・数え上げは 0 になり、「Wi-Fi に戻れなかった」のか「固まった」のかを
// 見分ける手掛かりが全部消えた。
//
// **見分ける手掛かりは書いた時刻（`savedUnix`・`uptimeS`）。** 生きていれば 60 秒ごとに書くので
// （`PREV_HEARTBEAT_MS`）、固まった基板の記録は固まった時刻で止まり、動いていた基板の記録は
// 電源を抜く直前まで進む。
//
// **置き場所は NVS。** フラッシュのデータ領域（`spiffs`）は送った分の輪が丸ごと使っている
// （→ `flashInit`）。NVS は書き込みを区画へ散らし、1 件の書き込みを丸ごと残すか残さないかの
// どちらかにする（書いている途中で電源が落ちても、前の記録が残る）。
//
// **形を変えたら `PREV_STATE_VERSION` を上げる。** 大きさが同じまま意味の違う欄を読むと、
// 前の版の記録を別の値として出してしまう。
struct PrevState {
  uint32_t version;       // `PREV_STATE_VERSION`
  uint32_t bootId;        // 書いた起動の `g_bootIdNum`
  uint32_t savedUnix;     // 書いた時刻（unix 秒）。**時計が合う前（`clockTrusted` が偽）なら 0**
  uint32_t uptimeS;       // 書いた時点の稼働秒数
  uint32_t saves;         // この起動で書いた回数（自分を含む）
  uint8_t  why;           // 書いた理由（`PrevWhy`）
  uint8_t  resetReason;   // その起動の理由（`esp_reset_reason_t`）
  uint8_t  bootedBySelfRestart;
  uint8_t  wifiUp;
  uint8_t  ackLevel;
  uint8_t  sensorsOk;     // `ok` が立っていたセンサーの数
  int16_t  rssi;          // 最後に繋がっていたときの電波の強さ（一度も繋がっていなければ 0）
  uint32_t wifiDownS;     // 切れていたなら、切れてからの秒数（繋がっていれば 0）
  uint32_t wifiDowns;     // この起動で切れた回数
  int32_t  ackAgeS;       // 最後の返事からの秒数（一度も受けていなければ -1）
  uint32_t acks;
  uint32_t ackRearms;
  uint32_t ackReconnects;
  uint32_t hostProbeFail;
  uint32_t selfRestarts;  // 数え直しの窓の中で自分から再起動した回数（`selfRestartsInWindow`）
  uint32_t restartSkipped;
  uint32_t sntpSyncs;
  uint32_t freeHeap;
};
static const uint32_t PREV_STATE_VERSION = 1;
// 大きさは `PREV_HEARTBEAT_MS` のすり減りの見積もりの前提。**欄を足したらあちらも見直す。**
static_assert(sizeof(PrevState) == 72, "PrevState size changed: revisit PREV_HEARTBEAT_MS wear estimate");
// 書いた理由。**状態ページへは名前で出す**（`prevWhyName`）。
enum PrevWhy : uint8_t { PREV_WHY_HEARTBEAT = 0, PREV_WHY_CHANGE = 1, PREV_WHY_RESTART = 2, PREV_WHY_OTA = 3 };

static Preferences g_prefs;
static bool       g_prefsOk = false;      // NVS を開けたか
// 起動時に読んだ前の起動の記録。**この起動の最初の書き込みで NVS からは消える**ので、
// 読んだ時点でここへ写しておく。
static PrevState  g_prev;
static bool       g_prevValid = false;
static PrevState  g_cur;                  // この起動の記録（書くたびに組み直す）
static uint32_t   g_prevSaves = 0;
static uint32_t   g_prevSaveFails = 0;
static uint32_t   g_prevSaveMaxMs = 0;    // 1 回の書き込みにかかった最長の時間
static uint32_t   g_lastPrevSaveMs = 0;   // 最後に書いた時刻（`millis()`）。起動時は `g_bootMs`
// 書いていない変わり目があるか。**間引いた分を落とさない**ための旗（→ `PREV_MIN_GAP_MS`）。
// 起動したこと自体が変わり目なので、真から始める。
static bool       g_prevDirty = true;
// Wi-Fi が切れた回数と、切れた時刻。**一度も繋がっていなければ起動から数える。**
static uint32_t   g_wifiDowns = 0;
static uint32_t   g_wifiDownSinceMs = 0;
static int16_t    g_lastRssi = 0;

// --- 送った分の輪（→ `BacklogSlot`・`handleBacklog`） ---
//
// **起動時にヒープから取る。** 静的な配列にすると、リンク時の DRAM の枠（静的な変数を
// 置ける領域）を約 95 KB 食う。あの枠は空きメモリ全体より狭く、溢れればビルドが通らない。
// 取れなければ輪を持たずに動き（`/backlog` は 503）、波形の送信は止めない。
static BacklogSlot* g_backlog = nullptr;
static size_t     g_backlogUsed = 0;        // 埋まっている区画の数（最大 `BACKLOG_SLOTS`）
// 輪へ入れた累計。**次に書く区画はここから引く**（`累計 % BACKLOG_SLOTS`）。フラッシュへの
// 写しがどこまで進んだか（`g_spillCursor`）を、上書きをまたいで同じ物差しで数えるため。
// 1 秒に約 10 増えるので、32 bit が一周するのは約 13 年後。
static uint32_t   g_backlogTotal = 0;
static uint32_t   g_backlogRequests = 0;    // `/backlog` を受けた回数
static uint32_t   g_backlogServed = 0;      // 返したまとまりの数
static uint32_t   g_backlogBad = 0;         // 引数が読めずに断った回数
static uint32_t   g_backlogOtherBoot = 0;   // 訊かれた起動 ID の分がメモリにもフラッシュにも無かった回数
static uint32_t   g_backlogLoadFails = 0;   // 返す分を取り出せず 500 で答えた回数（→ `handleBacklog`）
static uint32_t   g_bootIdNum = 0;          // `g_bootId` を数にしたもの（フラッシュの区画が名乗る）

// --- フラッシュの輪（→ `FlashSectorHead`・`spillPump`） ---
//
// **取れなければフラッシュ無しで動く**（メモリの輪だけ。`/backlog` も返せる範囲だけ返す）。
static const esp_partition_t* g_flashPart = nullptr;
static size_t     g_flashSectors = 0;       // 使える区画の数
static FlashSectorIndex* g_flashIndex = nullptr;
static size_t     g_flashNext = 0;          // 次に消して書く区画
static uint32_t   g_flashSeq = 0;           // 最後に書いた区画の `seq`
// 書きかけの区画（メモリ）。満ちたら 1 区画ぶんを消して書く。
static uint8_t*   g_flashPage = nullptr;
// 読み出し用の作業場（`/backlog` がフラッシュの区画を読むとき）。
static uint8_t*   g_flashRead = nullptr;
static bool       g_spilling = false;       // いまフラッシュへ書き出しているか
// メモリの輪のどこまでをフラッシュへ写したか（`g_backlogTotal` と同じ数え方）。
static uint32_t   g_spillCursor = 0;
// 返事が戻ったとき、写し終える目標（そこまで写したら書きかけの区画を書いて止める）。
static uint32_t   g_spillStopAt = 0;
static bool       g_spillDraining = false;
static uint32_t   g_spillStarts = 0;        // 書き出しを始めた回数
static uint32_t   g_spillGapStarts = 0;     // そのうち、返事は届いていて `gap=` で始めた回数
static uint32_t   g_spillLost = 0;          // 写す前にメモリの輪が上書きしてしまったまとまりの数
static uint32_t   g_spillBackCopies = 0;    // 書き出しの位置より手前から追って写したまとまりの数（→ `spillBackCopy`）
// `g_spillCursor` が前の書き出しの位置を指しているか。**始め直すときはそこより前へ戻らない**
// （→ `spillPump`）—— もう写した分を写し直すと、返事が途切れるたびに同じ分で区画を食う。
static bool       g_spillCursorValid = false;
static uint32_t   g_spillSinceMs = 0;       // いまの書き出しを始めた時刻（`millis()`）
// 続けて書き出したのが `SPILL_MAX_MS` に達して止めた。返事が戻るまで書き始めない。
static bool       g_spillCapped = false;
static uint32_t   g_spillCaps = 0;          // `SPILL_MAX_MS` で止めた回数
static uint32_t   g_flashWrites = 0;        // 区画を書いた回数
static uint32_t   g_flashFails = 0;         // 消去・書き込みに失敗した回数
// 読み出しの失敗。**書き込みの失敗と分ける** —— 書けないのは区画の寿命や電源の疑い、
// 読めないのは訊かれた分を返せなかったことで、手当てが違う。
static uint32_t   g_flashReadFails = 0;     // `/backlog` が区画を読めなかった回数
static uint32_t   g_flashCrcBad = 0;        // 読んだ区画の CRC が合わなかった数（その区画は以後読まない）
static uint32_t   g_flashInitMs = 0;        // 起動時に全区画を読んで確かめるのにかかった時間
static uint32_t   g_flashMaxMs = 0;         // 1 区画の消去と書き込みにかかった最長の時間

// 追記して `used` を進める。**溢れたら書かない。**
//
// `vsnprintf` は収まらなくても「収めるのに必要だった長さ」を返すので、戻り値を
// そのまま足すと `used` が buf の外を指す。以後の追記が配列外へ書き込む。
static void appendf(char *buf, size_t size, size_t &used, const char *fmt, ...) {
  if (size == 0 || used >= size - 1) return;
  va_list ap;
  va_start(ap, fmt);
  const int n = vsnprintf(buf + used, size - used, fmt, ap);
  va_end(ap);
  if (n < 0) return;
  used += ((size_t)n < size - used) ? (size_t)n : (size - used - 1);
}

// **ノード名は板そのものから引く。** ビルド時の定義で切り替える形だと、焼き直しの
// たびに取り違えうる——しかも取り違えても何のエラーも出ず、別のセンサーの波形として
// 静かに混ざるだけ。複数台で突き合わせるために増やした台数が、そこで意味を失う。
// 1 つのバイナリを全台へ焼ける形にしておけば、焼き間違いという事故が起こりえない。
//
// **どの MAC がどの名前かは `wifi_config.h` が持つ**（`NODE_NAMES`）。あれは
// 設置ごとの事実であって firmware の論理ではないので、送り先（`UDP_HOST`）と
// 同じ場所へ置く。手元の機材の識別子をリポジトリへ入れずに済む利点もある。
//
// **名前はパケットに載せない**（版 2）。名前は設置ごとに変わるのに、データを名前で
// 引く形にすると、基板を別の部屋へ移した日を境に同じ名前が別の場所の波形を指す。
// ここで引いた名前を使うのは mDNS・OTA のホスト名と状態ページ——どれも人が見る側。

// 表に無い板は MAC の下 3 バイトで名乗る。既定の名前へ倒すと、4 台目を足したときに
// 同じ名前が 2 つ現れ、受け手はそれを 1 台のセンサーの波形として混ぜてしまう。
// 名前が一意でありさえすれば、表への追記を忘れても受け手側で気づける。
static void resolveNodeName(){
  uint8_t m[6] = {0,0,0,0,0,0};
  if (esp_read_mac(m, ESP_MAC_WIFI_STA) != ESP_OK) {
    Serial.println("# WARN MAC を読めなかった");
  }
  snprintf(g_mac, sizeof(g_mac), "%02x:%02x:%02x:%02x:%02x:%02x",
           m[0], m[1], m[2], m[3], m[4], m[5]);
  snprintf(g_macFlat, sizeof(g_macFlat), "%02x%02x%02x%02x%02x%02x",
           m[0], m[1], m[2], m[3], m[4], m[5]);
  // NODE_NAMES は MAC と名前を交互に並べた表。**終端の番兵を置かず、配列の
  // 大きさから数える。** 番兵だと書き忘れたときに配列の外を読むが、こちらの形
  // なら書き忘れようがない。
  // **`i + 1 < n` で止めること。** 名前を書かずに MAC だけ足された表では、
  // `i < n` にすると最後の 1 つで配列の外を読む。
  const size_t n = sizeof(NODE_NAMES) / sizeof(NODE_NAMES[0]);
  for (size_t i = 0; i + 1 < n; i += 2) {
    if (strcmp(NODE_NAMES[i], g_mac) == 0) {
      // **切り詰めを黙って通さないこと。** 長い名前は snprintf が静かに詰めるので、
      // 頭が同じ 2 つの名前が同じ文字列へ落ちうる。「名前が一意でありさえすれば
      // 受け手側で気づける」という、この仕組みの拠り所がそこで崩れる。
      if (strlen(NODE_NAMES[i + 1]) >= sizeof(g_node)) {
        Serial.printf("# WARN 名前が長すぎる（%u 文字まで）。切り詰めると衝突しうる: %s\n",
                      (unsigned)(sizeof(g_node) - 1), NODE_NAMES[i + 1]);
      }
      snprintf(g_node, sizeof(g_node), "%s", NODE_NAMES[i + 1]);
      return;
    }
  }
  snprintf(g_node, sizeof(g_node), "seismo-%02x%02x%02x", m[3], m[4], m[5]);
  Serial.printf("# WARN mac %s は表に無い。仮に %s と名乗る\n", g_mac, g_node);
}

// I2C の 1 取引ぶんの成否を勘定へ返す。**成功したら連続失敗を 0 へ戻す。**
// 戻さないと、たまたま 20 回積み上がった時点で健全なセンサーを降格させてしまう。
static bool note(Sensor &s, bool ok){
  if (ok) { s.failStreak = 0; return true; }
  s.i2cFail++; s.failStreak++; return false;
}

static bool w8(Sensor &s, uint8_t r, uint8_t v){
  s.wire->beginTransmission(s.addr); s.wire->write(r); s.wire->write(v);
  return note(s, s.wire->endTransmission() == 0);
}
static bool r8(Sensor &s, uint8_t r, uint8_t &o){
  s.wire->beginTransmission(s.addr); s.wire->write(r);
  if (s.wire->endTransmission(false) != 0) return note(s, false);
  if (s.wire->requestFrom(s.addr, (uint8_t)1) != 1) return note(s, false);
  o = s.wire->read();
  return note(s, true);
}

// FIFO の件数を **1 回の取引で** 読む。
//
// 上位バイトと下位バイトを別々に読むと、**その間に件数が変わったとき読み違える**
// （上位を読んだ後に桁が上がると、古い上位と新しい下位を組み合わせた値になる）。
// 件数が 6 の倍数でなくなれば下流で気づけるが、たまたま倍数になれば黙って通り、
// 6 バイト境界がずれたまま軸が入れ替わる。
static bool readFifoCount(Sensor &s, uint16_t &cnt){
  s.wire->beginTransmission(s.addr); s.wire->write(R_FIFO_COUNTH);
  if (s.wire->endTransmission(false) != 0) return note(s, false);
  if (s.wire->requestFrom(s.addr, (uint8_t)2) != 2) return note(s, false);
  // **1 つの式の中で read() を 2 回呼ばないこと**（下の FIFO の読み出しと同じ理由）。
  const uint8_t hi = s.wire->read();
  const uint8_t lo = s.wire->read();
  cnt = ((uint16_t)hi << 8) | lo;
  return note(s, true);
}

// **作り直したら端数の連続も切れる。** FIFO を空にした時点で 6 バイト境界は引き直される
// ので、前に数えていた連続を持ち越すと、次に 1 回端数を見ただけで「続いている」と
// 誤判定してまた作り直す。呼び出し側（初期化・再武装・`dropFifo`）に書かせない。
//
// **あふれで作り直したときも同じく消える。** 端数を 1 回見た直後にあふれが割り込むと、
// その回の進捗は失われる —— 承知のうえ。あふれも FIFO を作り直して `o` を進めるので、
// **必要な後始末は既に済んでいる**（失われるのは検出の進捗だけで、手当てではない）。
// ここで連続を持ち越すほうが誤りで、境界が引き直された後の端数は別の観測。
// なお `realignStreak` はここで消さないので、**降格までの積み上げは取り消されない**。
static void fifoReset(Sensor &s){
  s.partialStreak = 0;
  w8(s, R_USER_CTRL, 0x04); delay(2); w8(s, R_USER_CTRL, 0x40);
}

// **吸い出しの途中で FIFO を捨てるときは必ずこちらを通す。**
//
// `fifoReset` はデバイスの中に溜まっていたサンプルを物理的に捨てる。捨てた以上
// 前後を繋いではいけないが、**それを受け手へ伝える手段は `o`（累計）しかない** ——
// 読み出しに失敗した周期は `q`（通し番号）も進まないので、`o` を進めなければ
// 受け手からは切れ目が 1 つも見えない。
//
// **枝ごとに `overflow++` を書き足す形にしない。** 失敗の枝が 2 つ並ぶ場所で、実際に
// 片方だけ書き忘れていた（読み出しのアドレスを送れなかった側）。**どちらを通っても
// 失われる量は同じ**なのに、記録が非対称だと「検知できるかどうか」が失敗した位置で
// 決まってしまう。1 つの操作にまとめれば書き忘れようがない。
//
// 初期化（`sensorInit`）と再武装（`armSensor`）は素の `fifoReset` を使う。前者は
// まだ何も溜まっていない時点で、後者は伝えるかどうかを呼び出し側が決めるため。
static void dropFifo(Sensor &s){ s.overflow++; fifoReset(s); }

// 端数を数える。**合計と内訳を別々に書かない**——片方だけ書き足すと、状態ページの
// 2 つの数字が食い違って、どちらが正しいのか読む側には決められなくなる。
//
// **`rem` は 1〜`BPS-1` であること**（`cnt % BPS` が 0 でないと確かめた後に呼ぶ）。
// 範囲の判定は現状どの呼び出しでも真になる保険で、弾くためではなく、**添字を作る式の
// すぐ隣に値域を書いておくため**に置いてある。
static void notePartial(Sensor &s, uint8_t rem){
  s.partial++;
  if (rem >= 1 && rem < BPS) s.remHist[rem - 1]++;
}

// **`ok` は「WHO_AM_I が読めたか」ではなく「設定を書き込めたか」で決める。**
// WHO_AM_I は静的なレジスタなので、スリープ解除や FIFO_EN の書き込みが落ちていても
// 平然と応答する。読めるが溜めないセンサーが `ok=true` のまま無言になるのがいちばん
// 厄介な壊れ方——「届かない」は気づけるが、「健全と名乗って届かない」は気づけない。
static void sensorInit(Sensor &s){
  s.initTries++;
  const uint32_t before = s.i2cFail;
  w8(s, R_PWR_MGMT_1, 0x80); delay(100);
  w8(s, R_PWR_MGMT_1, 0x01); delay(50);      // CLKSEL=1（ジャイロ X の PLL 参照）
  w8(s, R_CONFIG, DLPF_CFG);
  w8(s, R_SMPLRT_DIV, SMPLRT_DIV);
  w8(s, R_ACCEL_CFG, (uint8_t)(AFS_SEL << 3));
  w8(s, R_FIFO_EN, 0x08);                    // 加速度 XYZ だけ
  fifoReset(s);
  // **0x69 の個体も WHO_AM_I は 0x68 を返す。** このレジスタが持つのはデバイス
  // アドレスの上位 6 ビットで、AD0 で決まる最下位ビットを反映しない仕様。
  // ここを `who == s.addr` と書くと、2 個目が永久に ok=false のまま黙る。
  // 両方を通すのは値域を広げるためではなく、別系統のチップ（MPU6500 は 0x70、
  // MPU9250 は 0x71）を引き続き弾くため。
  const bool whoOk = r8(s, R_WHO_AM_I, s.who) && (s.who == 0x68 || s.who == 0x69);
  const uint32_t fails = s.i2cFail - before;
  s.initFails = fails > 255 ? 255 : (uint8_t)fails;
  s.ok = whoOk && fails == 0;
}

// 吸い出しを始められる状態にする。初期化のあとと、再試行で復帰したときに通す。
//
// **かつてここは「必ずあふれている」ことへの手当てだった。** `setup()` が Wi-Fi を
// 最大 30 秒待っており、そのあいだ FIFO（1.7 秒ぶん）は確実に溢れていた。
// **いまは待たない**ので（→ `onWifiUp`）、初期化から `loop()` の最初の吸い出しまでは
// 数百ミリ秒しかなく、**起動直後のあふれは稀**になった（電源を入れ直した実機で
// `overflow=0`）。それでも作り直すのは、次の段落の理由のほう。
//
// **INT_STATUS のあふれビットはラッチで、読むまで消えない。** FIFO を作り直しても
// 旗は立ったままなので、ここで読み捨てないと最初の吸い出しが古い旗を見て 1 回
// 数えてしまう。取りこぼしを受け手へ伝えるための値が、起動直後から 1 になる。
//
// **`overflow` には触らない。** ここで 0 へ戻すと、復帰したセンサーの `o` が落ちる前と
// 同じ値（あふれの経験が無ければ 0 のまま）になり、**受け手は空白に気づかない**。
// 空白があったかどうかを知っているのは呼び出し側なので、伝えるかどうかもそちらが決める。
static void armSensor(Sensor &s){
  if (!s.ok) return;
  fifoReset(s);
  uint8_t discard = 0;
  r8(s, R_INT_STATUS, discard);
}

// バスを舐めて応答したアドレスを `out` へ並べ、**見つけた数を返す**。
//
// これが無いと、AD0 の設定ミスも SDA/SCL の逆挿しも切り分けられない——どちらも
// 「そのセンサーだけ ok=false」という同じ顔で現れる。誰がどこにいるかを先に出す。
static uint8_t scanBus(TwoWire &w, char *out, size_t outSize, bool &cut){
  uint8_t found = 0;
  size_t used = 0;
  cut = false;
  if (outSize > 0) out[0] = '\0';
  for (uint8_t a = 0x08; a <= 0x77; a++) {
    w.beginTransmission(a);
    if (w.endTransmission() != 0) continue;
    found++;
    // 1 件は最長 5 文字（",0xNN"）。**8 文字ぶん空いているときだけ書く**ので、
    // ここでの snprintf は必ず収まる（＝戻り値を足して安全）。
    if (used + 8 < outSize) {
      used += snprintf(out + used, outSize - used, used == 0 ? "0x%02X" : ",0x%02X", a);
    } else {
      // **切れたことを黙らせない。** 件数との差で気づけとは言えても、読む側に
      // 数えさせる形は「気づける」とは言わない。
      cut = true;
    }
  }
  return found;
}

// 起動の理由を状態ページ用の短い名前へ。**数字のまま出さない**——列挙の値は
// ESP-IDF の版で並びが変わりうるので、読む人が版ごとの表を引くことになる。
static const char* resetReasonName(esp_reset_reason_t r){
  switch (r) {
    case ESP_RST_POWERON:   return "poweron";
    case ESP_RST_EXT:       return "ext";
    case ESP_RST_SW:        return "sw";
    case ESP_RST_PANIC:     return "panic";
    case ESP_RST_INT_WDT:   return "int_wdt";
    case ESP_RST_TASK_WDT:  return "task_wdt";
    case ESP_RST_WDT:       return "wdt";
    case ESP_RST_DEEPSLEEP: return "deepsleep";
    case ESP_RST_BROWNOUT:  return "brownout";
    case ESP_RST_SDIO:      return "sdio";
    default:                return "other";
  }
}

// まとまりの先頭行（ヘッダの JSON）を書く。**送る口（`sendChunk`）と `/backlog` の両方がここを通る。**
//
// 別々に書くと、取り戻した分だけ形の違うパケットになる。受け手は同じ読み取りに通すので
// 1 字違えば取り戻した分だけが読めず、生データでも「同じまとまりが 2 度届いた」ことを
// 中身の一致で見分けられなくなる。`"ack":1` も同じ理由で残す（取り戻しは HTTP なので
// ホストは返事をしない）。戻り値は `snprintf` のまま。
//
// **起動 ID は引数で受ける。** フラッシュから返すのは前の起動の分のこともあり、そのときは
// 送ったときの起動 ID を名乗らないと、ホストは別の流れのパケットとして読む。
static int formatHead(char *head, size_t size, const char *bid, const Sensor &s, size_t n,
                      uint32_t seq0, int64_t tFirstMs, uint32_t overflow){
  return snprintf(head, size,
    "{\"v\":2,\"mac\":\"%s\",\"bid\":\"%s\",\"sid\":\"%s\",\"st\":\"MPU6050\","
    "\"ch\":[\"HN1\",\"HN2\",\"HN3\"],\"ug\":%.4f,\"fs\":%d,\"hz\":%d,"
    // `"ack":1` は「届いたら返事をくれ」。ホストは求めた基板にだけ返す（→ `checkAck`）。
    "\"t\":%lld,\"q\":%lu,\"c\":%u,\"o\":%lu,\"ack\":1}\n",
    g_macFlat, bid, s.sid, UG_PER_LSB, 2 << AFS_SEL, SAMPLE_HZ,
    (long long)tFirstMs, (unsigned long)seq0, (unsigned)n, (unsigned long)overflow);
}

// サンプル 1 行（`x,y,z\n`）を書く。共有する理由は `formatHead` と同じ。
static int formatLine(char *line, size_t size, const int16_t *xyz){
  return snprintf(line, size, "%d,%d,%d\n", xyz[0], xyz[1], xyz[2]);
}

// 送ったまとまりを輪へ残す。**いちばん古い区画から上書きする。**
//
// 呼ぶのは `sendChunk` だけ。**送れたかどうかを問わない**理由は `BACKLOG_SLOTS` の項。
static void backlogPut(const Sensor &s, const int16_t *v, size_t n, uint32_t seq0, int64_t tFirstMs){
  if (g_backlog == nullptr || n == 0 || n > MAX_PER_PACKET) return;
  BacklogSlot &b = g_backlog[g_backlogTotal % BACKLOG_SLOTS];
  b.tFirstMs = tFirstMs;
  b.seq0 = seq0;
  b.overflow = s.overflow;
  b.sensor = (uint8_t)(&s - g_sensors);
  b.n = (uint8_t)n;
  b.flashed = 0;
  memcpy(b.v, v, n * 3 * sizeof(int16_t));
  g_backlogTotal++;
  if (g_backlogUsed < BACKLOG_SLOTS) g_backlogUsed++;
}

// 輪の k 番目に古い区画（0 がいちばん古い）。**添字は累計から引く**（`g_backlogTotal` の項）。
static const BacklogSlot& backlogAt(size_t k){
  return g_backlog[(g_backlogTotal - (uint32_t)g_backlogUsed + (uint32_t)k) % BACKLOG_SLOTS];
}

// まとまりが通し番号の範囲 [from, to) に掛かるか。
//
// **差を符号付きで見る。** 通し番号は 100 Hz で進み、約 497 日で 32 bit を一周する。
// 大小をそのまま比べると、一周した瞬間に範囲の判定が逆さまになる。
static bool backlogOverlaps(const BacklogSlot &b, uint32_t from, uint32_t to){
  return (int32_t)(b.seq0 + b.n - from) > 0 && (int32_t)(to - b.seq0) > 0;
}

// 10 進の符号なし 32 bit を読む。**数字以外が 1 字でも混ざれば偽。**
// `strtoul` だけだと、先頭の空白・符号・途中の文字を黙って読み流す。
static bool parseU32(const String &text, uint32_t &out){
  if (text.length() == 0 || text.length() > 10) return false;
  uint64_t v = 0;
  for (size_t i = 0; i < text.length(); i++) {
    const char c = text[i];
    if (c < '0' || c > '9') return false;
    v = v * 10 + (uint64_t)(c - '0');
  }
  if (v > 0xFFFFFFFFULL) return false;
  out = (uint32_t)v;
  return true;
}

// 起動 ID（小文字の 16 進 8 桁。`g_bootId` の形）を数にする。**形が違えば偽。**
static bool parseBid(const String &text, uint32_t &out){
  if (text.length() != 8) return false;
  uint32_t v = 0;
  for (size_t i = 0; i < 8; i++) {
    const char c = text[i];
    uint32_t d;
    if (c >= '0' && c <= '9') d = (uint32_t)(c - '0');
    else if (c >= 'a' && c <= 'f') d = (uint32_t)(c - 'a' + 10);
    else return false;
    v = (v << 4) | d;
  }
  out = v;
  return true;
}

// --- フラッシュの輪（→ `FlashSectorHead`・`SPILL_AFTER_MS`） ---

// 1 まとまりの頭のバイト数（センサー・件数・予備 2・`q`・`o`・`t`）。後ろにサンプル × 6 バイト。
static const size_t FLASH_REC_HEAD = 20;

static size_t flashRecordSize(uint8_t n){ return FLASH_REC_HEAD + (size_t)n * 6; }

static void flashEncode(uint8_t *p, const BacklogSlot &b){
  p[0] = b.sensor; p[1] = b.n; p[2] = 0; p[3] = 0;
  memcpy(p + 4, &b.seq0, 4);
  memcpy(p + 8, &b.overflow, 4);
  memcpy(p + 12, &b.tFirstMs, 8);
  memcpy(p + FLASH_REC_HEAD, b.v, (size_t)b.n * 6);
}

// 1 まとまりを読む。**壊れた区画を信じない** —— 件数・センサーの番号が範囲外なら偽。
static bool flashDecode(const uint8_t *p, size_t avail, BacklogSlot &b){
  if (avail < FLASH_REC_HEAD) return false;
  b.sensor = p[0];
  b.n = p[1];
  if (b.n == 0 || b.n > MAX_PER_PACKET || b.sensor >= SENSOR_N) return false;
  if (avail < flashRecordSize(b.n)) return false;
  memcpy(&b.seq0, p + 4, 4);
  memcpy(&b.overflow, p + 8, 4);
  memcpy(&b.tFirstMs, p + 12, 8);
  memcpy(b.v, p + FLASH_REC_HEAD, (size_t)b.n * 6);
  return true;
}

// 区画の頭の後ろ（`used` まで）の CRC-32。書くときと読むときで同じ範囲を取る。
static uint32_t flashBodyCrc(const uint8_t *sector, uint16_t used){
  return esp_rom_crc32_le(0, sector + sizeof(FlashSectorHead), (uint32_t)(used - sizeof(FlashSectorHead)));
}

static FlashSectorHead& pageHead(){ return *reinterpret_cast<FlashSectorHead*>(g_flashPage); }

// 書きかけの区画を空にする。**消去した区画と同じ 0xFF で埋める**（書かなかった後ろが
// 読み出しで別の中身に化けない）。
static void pageReset(){
  memset(g_flashPage, 0xFF, FLASH_SECTOR);
  FlashSectorHead &h = pageHead();
  h.magic = FLASH_MAGIC;
  h.seq = g_flashSeq + 1;
  h.bid = g_bootIdNum;
  h.records = 0;
  h.used = (uint16_t)sizeof(FlashSectorHead);
  h.crc = 0;
  for (size_t i = 0; i < SENSOR_N; i++) { h.range[i].from = 0; h.range[i].to = 0; h.range[i].has = 0; }
}

// 書きかけの区画へ 1 まとまり足す。**入らなければ偽**（呼び出し側が区画を書いてから足し直す）。
static bool pageAppend(const BacklogSlot &b){
  FlashSectorHead &h = pageHead();
  const size_t sz = flashRecordSize(b.n);
  if ((size_t)h.used + sz > FLASH_SECTOR) return false;
  flashEncode(g_flashPage + h.used, b);
  h.used = (uint16_t)(h.used + sz);
  h.records++;
  FlashRange &r = h.range[b.sensor];
  const uint32_t end = b.seq0 + b.n;
  if (!r.has) {
    r.from = b.seq0; r.to = end; r.has = 1;
  } else {
    if ((int32_t)(b.seq0 - r.from) < 0) r.from = b.seq0;
    if ((int32_t)(end - r.to) > 0) r.to = end;
  }
  return true;
}

// 書きかけの区画を、輪の次の区画へ書く。**消してから書く**（フラッシュは 1 を 0 にしか書けない）。
//
// **目録は先に落とし、書けてから立てる。** 途中で電源が落ちても、目録（起動時に頭から作り直す）と
// 中身が食い違わない。書けなかった区画の分は失う（`g_flashFails` に数える）—— 同じ区画へ
// 書き直すと、壊れた区画に当たったとき輪がそこで止まる。
static void flashFlushPage(){
  if (g_flashPart == nullptr) return;
  FlashSectorHead &h = pageHead();
  if (h.records == 0) return;
  h.crc = flashBodyCrc(g_flashPage, h.used);
  const uint32_t t0 = millis();
  const size_t off = g_flashNext * FLASH_SECTOR;
  FlashSectorIndex &ix = g_flashIndex[g_flashNext];
  ix.valid = 0;
  const bool ok = esp_partition_erase_range(g_flashPart, off, FLASH_SECTOR) == ESP_OK
               && esp_partition_write(g_flashPart, off, g_flashPage, FLASH_SECTOR) == ESP_OK;
  const uint32_t took = millis() - t0;
  if (took > g_flashMaxMs) g_flashMaxMs = took;
  if (ok) {
    ix.seq = h.seq;
    ix.bid = h.bid;
    for (size_t i = 0; i < SENSOR_N; i++) ix.range[i] = h.range[i];
    ix.valid = 1;
    g_flashSeq = h.seq;
    g_flashWrites++;
  } else {
    g_flashFails++;
  }
  g_flashNext = (g_flashNext + 1) % g_flashSectors;
  pageReset();
}

// フラッシュの輪を開き、**区画を読んで CRC まで確かめてから目録を作る**。起動 ID（`g_bootIdNum`）が
// 決まってから 1 回だけ呼ぶ。
//
// **起動時に中身まで確かめる。** 頭だけで目録を作ると、書いている途中で電源が落ちた区画も
// 「抱えている」と数え、`/backlog` の `X-Backlog-Have` がその範囲まで名乗る。ホストはそれを信じて
// 訊き、中身が返らなかった分を「基板の輪が上書きした（`not-held`）」と記録する —— フラッシュの
// 傷みが、ふつうの上書きと見分けられなくなる。全区画（約 1.4 MB）を読むのは起動時の 1 回だけ
// （かかった時間は `g_flashInitMs`）。
//
// **書く位置は、いちばん新しい有効な区画の次。** 輪を一周したところで古い区画から上書きする。
// いちばん新しい区画が壊れていれば（書きかけで落ちた）、次に書くのはその区画になる。
// 取れない・確保できないときは、フラッシュ無しで動く（メモリの輪だけ）。
static void flashInit(){
  g_flashPart = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_SPIFFS, nullptr);
  if (g_flashPart == nullptr) {
    Serial.println("# WARN フラッシュのデータ領域（spiffs）が見つからない。メモリの輪だけで動く");
    return;
  }
  g_flashSectors = g_flashPart->size / FLASH_SECTOR;
  g_flashIndex = (FlashSectorIndex*)calloc(g_flashSectors, sizeof(FlashSectorIndex));
  g_flashPage = (uint8_t*)malloc(FLASH_SECTOR);
  g_flashRead = (uint8_t*)malloc(FLASH_SECTOR);
  if (g_flashSectors == 0 || g_flashIndex == nullptr || g_flashPage == nullptr || g_flashRead == nullptr) {
    free(g_flashIndex); free(g_flashPage); free(g_flashRead);
    g_flashIndex = nullptr; g_flashPage = nullptr; g_flashRead = nullptr;
    g_flashPart = nullptr;
    Serial.println("# WARN フラッシュの輪の作業場を確保できなかった。メモリの輪だけで動く");
    return;
  }
  bool any = false;
  uint32_t maxSeq = 0;
  size_t maxAt = 0;
  const uint32_t t0 = millis();
  for (size_t i = 0; i < g_flashSectors; i++) {
    if (esp_partition_read(g_flashPart, i * FLASH_SECTOR, g_flashRead, FLASH_SECTOR) != ESP_OK) {
      g_flashReadFails++;
      continue;
    }
    const FlashSectorHead &h = *reinterpret_cast<const FlashSectorHead*>(g_flashRead);
    if (h.magic != FLASH_MAGIC || h.records == 0 || h.used < sizeof(h) || h.used > FLASH_SECTOR) continue;
    if (flashBodyCrc(g_flashRead, h.used) != h.crc) {
      g_flashCrcBad++;
      continue;
    }
    FlashSectorIndex &ix = g_flashIndex[i];
    ix.seq = h.seq;
    ix.bid = h.bid;
    for (size_t s = 0; s < SENSOR_N; s++) ix.range[s] = h.range[s];
    ix.valid = 1;
    if (!any || (int32_t)(h.seq - maxSeq) > 0) { maxSeq = h.seq; maxAt = i; any = true; }
  }
  g_flashInitMs = millis() - t0;
  g_flashSeq = maxSeq;
  g_flashNext = any ? (maxAt + 1) % g_flashSectors : 0;
  pageReset();
}

// 返事の途絶を見て、フラッシュへの書き出しを始め・止め、1 周ぶん進める。**`loop()` から毎周呼ぶ。**
//
// **始めるときは、最後に返事を受けた時刻の少し前（`SPILL_BACKFILL_MS`）から写す。** 途絶えた
// ことに気づくまでに `SPILL_AFTER_MS` かかるので、その間に送った分も届いていないかもしれない。
// この起動でまだ返事を受けていなければ、輪にある分を全部写す。
//
// **止めるときは、返事が戻った時点までを写し切ってから止める。** その時点より後は届いている。
// 書きかけの区画も書いてから止める（書かずに止めると、その分はメモリの輪にしか無くなる）。
//
// **1 周に書く区画は 1 つまで**（`FLASH_SECTOR` の項）。書き出しが追いつかず、写す前に
// メモリの輪が上書きした分は `g_spillLost` に数える。
//
// **返事が途絶えたまま書くのは `SPILL_MAX_MS` まで。** 止めたら、返事が一度戻るまで書き始めない。
// `gap=` で頼まれて書いている間には掛けない（`SPILL_MAX_MS` の項）。
//
// **返事が届いていても、ホストが `gap=` で欠けを知らせてきたら書き出す**（→ `readAcks`）。
// 電子レンジのような干渉では返事がまばらに届くので途絶えの判定が立たず、ホストが取りに来る
// 前にメモリの輪から消えていた（2026-10-06、約 86% が取り戻せなかった）。写し始めは指された
// 番号のまとまりから。`gap=` の無い返事が来たら欠けは片付いたので、写し切って止める。
// `gap=` 付きの返事が `SPILL_AFTER_MS` 来なくても止める（返事そのものが落ちている間は、
// 途絶えの判定のほうが引き継ぐ）。書き出しの位置より手前に指されたまとまりが残っていれば、
// それも追って写す（`spillBackCopy`）。
static bool gapHinted(uint32_t nowMs){
  if (g_gapAcks == 0 || (int32_t)(nowMs - g_lastGapMs) > (int32_t)SPILL_AFTER_MS) return false;
  for (size_t s = 0; s < SENSOR_N; s++) if (g_gapHas[s]) return true;
  return false;
}

// 指された欠けの始まりを含むまとまりのうち、いちばん古いものの位置（`g_backlogTotal` と同じ数え方）。
// 指された番号がもう輪に無ければ、輪のいちばん古いところ（そこから先は残っている）。
static uint32_t gapCursor(){
  const uint32_t oldest = g_backlogTotal - (uint32_t)g_backlogUsed;
  for (size_t k = 0; k < g_backlogUsed; k++) {
    const BacklogSlot &b = backlogAt(k);
    if (b.sensor < SENSOR_N && g_gapHas[b.sensor]
        && (int32_t)(b.seq0 + (uint32_t)b.n - g_gapFrom[b.sensor]) > 0) {
      return oldest + (uint32_t)k;
    }
  }
  return g_backlogTotal;
}

// 書き出しの位置より手前で、`gap=` が指しているのにまだ写していないまとまりを写す。
// **区画を書いたら真**（1 周に書く区画は 1 つまで。呼び出し側はその周を終える）。
//
// **前へ進む写しだけでは拾えない分がある。** 書き出しは指された欠けのうち輪でいちばん手前の位置から
// 始めるが、ホストがまだ気づいていない欠けはそこに入っていない —— あるセンサーのまとまりが届かず、
// その後のまとまりも届かないうちは、ホストはそのセンサーの欠けを知らない。別のセンサーの欠けで
// 書き出しが先に始まると、気づかれていない側のまとまりは位置の手前に取り残され、メモリの輪から
// 落ちた時点で失われる（2026-10-08 の電子レンジで 3 か所、それぞれ 1 まとまり）。
//
// 見直すのは `gap=` を受けた後に 1 回だけ（`g_gapBackPending`）。写したかは区画の印で見るので、
// 同じまとまりを二度写さない。
static bool spillBackCopy(){
  if (!g_gapBackPending) return false;
  const uint32_t oldest = g_backlogTotal - (uint32_t)g_backlogUsed;
  for (size_t k = 0; k < g_backlogUsed; k++) {
    const uint32_t pos = oldest + (uint32_t)k;
    // **ここから先は前へ進む写しが受け持つ。**
    if ((int32_t)(pos - g_spillCursor) >= 0) break;
    BacklogSlot &b = g_backlog[pos % BACKLOG_SLOTS];
    if (b.flashed || b.sensor >= SENSOR_N || !g_gapHas[b.sensor]) continue;
    if ((int32_t)(b.seq0 + (uint32_t)b.n - g_gapFrom[b.sensor]) <= 0) continue;
    if (!pageAppend(b)) {
      flashFlushPage();
      return true;  // 見直しは次の周に続ける（`g_gapBackPending` は立てたまま）
    }
    b.flashed = 1;
    g_spillBackCopies++;
  }
  g_gapBackPending = false;
  return false;
}

static void spillPump(uint32_t nowMs){
  if (g_flashPart == nullptr || g_backlog == nullptr) return;
  const bool hinted = gapHinted(nowMs);
  const uint32_t heardMs = g_acks > 0 ? g_lastAckMs : g_bootMs;
  // **差は符号付きで取る。** `nowMs` は `loop()` の頭で取った時刻で、同じ周の `readAcks()` が
  // それより後の `millis()` を `g_lastAckMs` へ書く。符号無しで引くと負の差が約 49 日に化けて
  // 「途絶えた」と読み、返事が来た直後に書き出しを始めて次の周で止める —— 区画を 1 つ書いて
  // 終わる空振りが、2026-10-03 の実機で返事が 1 秒も途切れていないのに 1 枚あたり 2 分で 8〜23 回起きていた。
  // 符号付きで測れるのは約 24.8 日まで（それを超えて返事が無いと「途絶えていない」に戻る）。
  // その頃には `SPILL_MAX_MS` で書き出しを止めてあり、`silent` が偽に戻っても書き始めないので、挙動は変わらない。
  const bool silent = (int32_t)(nowMs - heardMs) > (int32_t)SPILL_AFTER_MS;
  const bool wanted = silent || hinted;
  // **止めたままにするのは返事が途絶えている間だけ**（`SPILL_MAX_MS` の項）。`gap=` は返事に乗って
  // 来るので、それが届いている間はホストが生きていて、書く値打ちのある欠けを指している。
  if (!silent) g_spillCapped = false;
  if (wanted && !g_spilling && !g_spillCapped) {
    g_spilling = true;
    g_spillDraining = false;
    g_spillSinceMs = nowMs;
    uint32_t cursor = g_backlogTotal - (uint32_t)g_backlogUsed;
    if (!silent) {
      cursor = gapCursor();
      g_spillGapStarts++;
    } else if (g_acks > 0) {
      const int64_t since = g_lastAckUnixMs - SPILL_BACKFILL_MS;
      for (size_t k = 0; k < g_backlogUsed; k++) {
        const BacklogSlot &b = backlogAt(k);
        if (b.tFirstMs + (int64_t)b.n * 1000 / SAMPLE_HZ >= since) break;
        cursor++;
      }
    }
    // **前に写した位置より前へは戻らない。** 返事が数秒戻ってまた途絶えると、さかのぼる幅が
    // 写し終えた分に掛かる。
    if (g_spillCursorValid && (int32_t)(g_spillCursor - cursor) > 0) cursor = g_spillCursor;
    g_spillCursor = cursor;
    g_spillCursorValid = true;
    g_spillStarts++;
    if (silent) {
      Serial.printf("# ホストの返事が %lu ms 途絶えた。送った分をフラッシュへ書き出す\n",
                    (unsigned long)(nowMs - heardMs));
    } else {
      Serial.println("# ホストが欠けを知らせてきた。送った分をフラッシュへ書き出す");
    }
  } else if (wanted && g_spillDraining) {
    // 止める途中でまた途絶えた・欠けを知らされた。写した位置はそのまま、止めるのをやめる。
    g_spillDraining = false;
  } else if (!wanted && g_spilling && !g_spillDraining) {
    g_spillDraining = true;
    g_spillStopAt = g_backlogTotal;
  }
  if (!g_spilling) return;
  // **測るのは返事が途絶えてからの長さ。** 書き始めてからの長さで測ると、`gap=` で頼まれて書いている
  // 間（干渉が 30 分を超えて続く場面）まで止めてしまい、返事は届き続けるので止めたまま解けない。
  if (!g_spillDraining && silent && (int32_t)(nowMs - heardMs) > (int32_t)SPILL_MAX_MS) {
    // 写した分を書いて止める（`SPILL_MAX_MS` の項）。
    flashFlushPage();
    g_spilling = false;
    g_spillCapped = true;
    g_spillCaps++;
    Serial.printf("# ホストの返事が %lu 分途絶えたので書き出しを止めた。返事が戻るまで書き始めない\n",
                  (unsigned long)(SPILL_MAX_MS / 60000UL));
    return;
  }
  // **手前に取り残した分を先に写す**（`spillBackCopy`）。輪から先に落ちるのは古い側なので。
  // **`gap=` の鮮度（`hinted`）では止めない。** 干渉で `gap=` 付きの返事が 8 秒途絶えても、
  // 書き出しは途絶えの判定で続く —— そこで手前を追うのをやめると、直したい場面そのもので働かない。
  // 何を写すかは最後に受けた `gap=` が決める（欠けが片付いた返事なら `g_gapHas` が落ちていて何も写さない）。
  if (spillBackCopy()) return;
  const uint32_t target = g_spillDraining ? g_spillStopAt : g_backlogTotal;
  while ((int32_t)(target - g_spillCursor) > 0) {
    const uint32_t oldest = g_backlogTotal - (uint32_t)g_backlogUsed;
    if ((int32_t)(g_spillCursor - oldest) < 0) {
      g_spillLost += oldest - g_spillCursor;
      g_spillCursor = oldest;
      continue;
    }
    BacklogSlot &slot = g_backlog[g_spillCursor % BACKLOG_SLOTS];
    // 手前から追って写した分（`spillBackCopy`）は写し直さない。
    if (!slot.flashed) {
      if (!pageAppend(slot)) {
        flashFlushPage();
        return;
      }
      slot.flashed = 1;
    }
    g_spillCursor++;
  }
  if (g_spillDraining) {
    flashFlushPage();
    g_spilling = false;
    g_spillDraining = false;
    Serial.println("# ホストの返事が戻り、欠けも片付いた。フラッシュへの書き出しを止めた");
  }
}

// `[from, to)` に掛かる、起動 ID とセンサーの合うまとまりのうち、**通し番号の若いものから
// `cap` 個**の在りかを `refs` へ並べて数を返す。それより後ろにもまだあれば `more` を立てる。
//
// **フラッシュとメモリの輪を、通し番号で突き合わせて並べる。** どちらかの順に読んで「直前に返した
// 末尾より手前は重なり」と捨てる形は、フラッシュが輪の古い側だけを持つときにしか成り立たない。
// `gap=` で書き出すと輪の途中から写すので、フラッシュの分のほうが後ろの番号を持つことがあり、
// その形ではメモリの輪にしか無い手前のまとまりを重なりと取り違えて落としていた（2026-10-08、
// ホストは「基板がもう抱えていない」と諦めた）。手前から追って写す分（`spillBackCopy`）もあるので、
// フラッシュの中でも番号順には並ばない。
//
// **同じまとまりは 1 つにまとめる**（同じ `seq0`。書き出し中の分は両方にあり、書き出しを始め直すと
// 同じ分をもう一度写すこともある）。両方にあればメモリの輪のほうを採る（返すときに読み直さずに済む）。
static size_t collectBacklog(uint32_t bid, uint8_t si, uint32_t from, uint32_t to,
                             BacklogRef *refs, size_t cap, bool &more){
  size_t count = 0;
  more = false;
  auto consider = [&](const BacklogSlot &b, uint16_t sector, uint16_t at){
    if (b.sensor != si || !backlogOverlaps(b, from, to)) return;
    // **並べる鍵は `from` からの差。** 通し番号は約 497 日で一周するので、そのまま比べない。
    const int32_t key = (int32_t)(b.seq0 - from);
    size_t pos = count;
    for (size_t i = 0; i < count; i++) {
      const int32_t ki = (int32_t)(refs[i].seq0 - from);
      if (ki == key) {
        if (sector == BACKLOG_REF_MEMORY) { refs[i].sector = sector; refs[i].at = at; }
        return;
      }
      if (key < ki) { pos = i; break; }
    }
    if (count == cap) {
      more = true;
      if (pos == cap) return;
      count--;  // いちばん後ろを押し出す（そちらは次に訊かれたときに返す）
    }
    for (size_t i = count; i > pos; i--) refs[i] = refs[i - 1];
    refs[pos].seq0 = b.seq0;
    refs[pos].sector = sector;
    refs[pos].at = at;
    refs[pos].n = b.n;
    count++;
  };
  if (g_flashPart != nullptr) {
    for (size_t k = 0; k < g_flashSectors; k++) {
      const size_t i = (g_flashNext + k) % g_flashSectors;
      const FlashSectorIndex &ix = g_flashIndex[i];
      if (!ix.valid || ix.bid != bid || !ix.range[si].has) continue;
      if (!((int32_t)(ix.range[si].to - from) > 0 && (int32_t)(to - ix.range[si].from) > 0)) continue;
      // **揃った後は、後ろにしか無い区画を読まない。** 目録の範囲の頭が `cap` 個目より後ろなら、
      // その区画からは並びに入るものが無い（あることだけ分かれば足りる）。これが無いと、
      // 長い欠けを訊かれるたびにフラッシュの区画を全部読み、その間ずっと吸い出しが止まる。
      if (count == cap && (int32_t)(ix.range[si].from - from) > (int32_t)(refs[cap - 1].seq0 - from)) {
        more = true;
        continue;
      }
      if (esp_partition_read(g_flashPart, i * FLASH_SECTOR, g_flashRead, FLASH_SECTOR) != ESP_OK) {
        g_flashReadFails++;
        continue;
      }
      const FlashSectorHead &h = *reinterpret_cast<const FlashSectorHead*>(g_flashRead);
      // **目録と食い違う区画は読まない**（目録を作った後に上書きされた・壊れている）。
      if (h.magic != FLASH_MAGIC || h.seq != ix.seq || h.used < sizeof(FlashSectorHead) || h.used > FLASH_SECTOR) continue;
      // **中身の壊れた区画は、目録から外して以後読まない**（訊かれるたびに数え直さないため）。
      if (flashBodyCrc(g_flashRead, h.used) != h.crc) {
        g_flashCrcBad++;
        g_flashIndex[i].valid = 0;
        continue;
      }
      size_t off = sizeof(FlashSectorHead);
      BacklogSlot b;
      for (uint16_t r = 0; r < h.records; r++) {
        if (!flashDecode(g_flashRead + off, h.used - off, b)) break;
        consider(b, (uint16_t)i, (uint16_t)off);
        off += flashRecordSize(b.n);
      }
    }
  }
  if (bid == g_bootIdNum) {
    for (size_t k = 0; k < g_backlogUsed; k++) consider(backlogAt(k), BACKLOG_REF_MEMORY, (uint16_t)k);
  }
  return count;
}

// `collectBacklog` が並べた在りかから、まとまりを取り出す。**取り出せなければ偽**（区画を読めない・
// 並べた後で中身が食い違う）。`cachedSector` は `g_flashRead` に入っている区画（無ければ -1）——
// 同じ区画のまとまりが続く間は読み直さない。**いつも続くとは限らない**（手前から追って写した分は
// 後の区画に入るので、番号順に並べると区画が行き来する）。そのときは読み直すだけで、中身は変わらない。
static bool loadBacklogRef(const BacklogRef &r, BacklogSlot &out, int32_t &cachedSector){
  if (r.sector == BACKLOG_REF_MEMORY) {
    out = backlogAt(r.at);
    return out.seq0 == r.seq0;
  }
  if (cachedSector != (int32_t)r.sector) {
    cachedSector = -1;
    if (esp_partition_read(g_flashPart, (size_t)r.sector * FLASH_SECTOR, g_flashRead, FLASH_SECTOR) != ESP_OK) {
      g_flashReadFails++;
      return false;
    }
    cachedSector = (int32_t)r.sector;
  }
  const FlashSectorHead &h = *reinterpret_cast<const FlashSectorHead*>(g_flashRead);
  // 並べてから取り出すまでの間に区画は書き換わらない（書くのも読むのも `loop()` だけ）。それでも
  // 目印と範囲は確かめる —— 前提が崩れたとき、別の中身をまとまりとして読まないため。
  if (h.magic != FLASH_MAGIC || h.used > FLASH_SECTOR || r.at >= h.used) return false;
  return flashDecode(g_flashRead + r.at, h.used - r.at, out) && out.seq0 == r.seq0;
}

// 送ったまとまりを返す口。`GET /backlog?sid=<センサー>&bid=<起動 ID>&from=<q>&to=<q>`。
//
// **ホストが取りに来る形にしてある。** 欠けを知っているのはホストのほうで（`BACKLOG_SLOTS`
// の項）、HTTP なら届いたかどうかを TCP が確かめる。取りに来る速さもホストが決めるので、
// 基板の吸い出しを詰まらせない。
//
// 返すのは `[from, to)` に掛かるまとまり。**中身は送ったときのパケットそのもの**
// （`formatHead`・`formatLine`）を、ヘッダの行で区切って並べる。応答の見出しに次を載せる。
// - `X-Backlog-Have`: このセンサーで抱えている範囲 `<先頭>-<末尾の次>`。無ければ `none`。
//   **訊かれた範囲がこれより古ければ、その分はもう取り戻せない**（輪が上書きした）
// - `X-Backlog-More`: 上限（`BACKLOG_MAX_PER_REPLY`）で打ち切ったなら 1
// - `X-Backlog-Next`: 返した最後のまとまりの末尾の次。続きはここから訊き直す
//
// **その起動の分がメモリにもフラッシュにも無ければ 410。** メモリの輪は再起動で消えるが、
// 返事が途絶えていた間の分はフラッシュに残っている（区画が起動 ID を持つ）。どちらにも無いのに
// 黙って空を返すと、ホストは「その範囲には何も無かった」と読む。
//
// **引数を確かめてから輪を読む。** 読めない値で探すと、空振りの 200 が「何も無かった」と
// 同じ顔で返る。
static void handleBacklog(){
  g_backlogRequests++;
  if (g_backlog == nullptr && g_flashPart == nullptr) {
    http.send(503, "text/plain", "backlog unavailable\n");
    return;
  }
  const String sid = http.arg("sid");
  int si = -1;
  for (size_t i = 0; i < SENSOR_N; i++) {
    if (sid == g_sensors[i].sid) si = (int)i;
  }
  uint32_t from = 0, to = 0, bid = 0;
  if (si < 0 || !parseU32(http.arg("from"), from) || !parseU32(http.arg("to"), to)
      || (int32_t)(to - from) <= 0 || !parseBid(http.arg("bid"), bid)) {
    g_backlogBad++;
    http.send(400, "text/plain", "need sid, bid, from, to (from < to)\n");
    return;
  }
  const uint8_t sensor = (uint8_t)si;
  http.sendHeader("X-Backlog-Bid", g_bootId);

  // 抱えている範囲（メモリの輪とフラッシュを合わせて）。**その起動の分が 1 つも無ければ 410。**
  bool known = bid == g_bootIdNum;
  bool have = false;
  uint32_t haveFrom = 0, haveTo = 0;
  auto widen = [&](uint32_t f, uint32_t t){
    if (!have) { haveFrom = f; haveTo = t; have = true; return; }
    if ((int32_t)(f - haveFrom) < 0) haveFrom = f;
    if ((int32_t)(t - haveTo) > 0) haveTo = t;
  };
  if (g_flashPart != nullptr) {
    for (size_t i = 0; i < g_flashSectors; i++) {
      const FlashSectorIndex &ix = g_flashIndex[i];
      if (!ix.valid || ix.bid != bid) continue;
      known = true;
      if (ix.range[sensor].has) widen(ix.range[sensor].from, ix.range[sensor].to);
    }
  }
  if (bid == g_bootIdNum) {
    for (size_t k = 0; k < g_backlogUsed; k++) {
      const BacklogSlot &b = backlogAt(k);
      if (b.sensor == sensor) widen(b.seq0, b.seq0 + b.n);
    }
  }
  if (!known) {
    g_backlogOtherBoot++;
    http.send(410, "text/plain", "other boot\n");
    return;
  }

  // **見出しは本文より先に出す**ので、何を返すかを先に数えてから書き出す。
  // 応答を作っている間に輪は書き換わらない（書くのも読むのも `loop()` だけ）。
  static BacklogRef refs[BACKLOG_MAX_PER_REPLY];
  bool more = false;
  const size_t found = collectBacklog(bid, sensor, from, to, refs, BACKLOG_MAX_PER_REPLY, more);
  // **見出しを出す前に、返す分を作業場へ取り出し切る。** 見出しで「ここまで答えた」と名乗った後で
  // 取り出しに失敗して飛ばすと、ホストは答え切ったのに残った分を「基板がもう抱えていない」と諦める。
  // **1 つでも取り出せなければ応答ごと 500 にする** —— ホストは「取りに行けず」として間を空けて訊き直す
  // （`backlogFetcher.ts`）。取り出せた分だけ返して `more` を立てる形は、ホストが間を空けずに訊き直すので、
  // 読めない区画が続くと休みなく訊かれる輪になる。作業場は `static`（30 × 264 バイト。`loop()` の
  // タスクのスタックは 8 KB しかない）。
  static BacklogSlot slots[BACKLOG_MAX_PER_REPLY];
  int32_t cachedSector = -1;
  for (size_t k = 0; k < found; k++) {
    if (!loadBacklogRef(refs[k], slots[k], cachedSector)) {
      g_backlogLoadFails++;
      http.send(500, "text/plain", "backlog read failed\n");
      return;
    }
  }
  const size_t picked = found;
  const uint32_t next = picked > 0 ? slots[picked - 1].seq0 + slots[picked - 1].n : from;
  http.sendHeader("X-Backlog-Have", have ? String(haveFrom) + "-" + String(haveTo) : String("none"));
  http.sendHeader("X-Backlog-More", more ? "1" : "0");
  http.sendHeader("X-Backlog-Next", String(next));
  http.setContentLength(CONTENT_LENGTH_UNKNOWN);
  http.send(200, "text/plain", "");

  // 1 まとまりは最大で 320 + 40 × 21 バイト（`-32768,-32768,-32768\n` が 21 文字）。
  static char buf[1280];
  char bidText[9];
  snprintf(bidText, sizeof(bidText), "%08lx", (unsigned long)bid);
  const Sensor &s = g_sensors[sensor];
  for (size_t k = 0; k < picked; k++) {
    const BacklogSlot &b = slots[k];
    const int hl = formatHead(buf, sizeof(buf), bidText, s, b.n, b.seq0, b.tFirstMs, b.overflow);
    if (hl <= 0 || (size_t)hl >= sizeof(buf)) { g_headTrunc++; continue; }
    size_t u = (size_t)hl;
    for (size_t i = 0; i < b.n; i++) {
      const int ll = formatLine(buf + u, sizeof(buf) - u, &b.v[i * 3]);
      if (ll <= 0 || (size_t)ll >= sizeof(buf) - u) break;
      u += (size_t)ll;
    }
    http.sendContent(buf, u);
    g_backlogServed++;
  }
  http.sendContent("");
}

// 状態ページ。
//
// **バッファの余裕を測ってある。** すべての勘定を 32bit の上限（4294967295）へ置き、
// ノード名と走査結果も最長にした最悪形で **約 2000 バイト**（2026-10-01 に実測。
// 実際の応答は約 1300 バイト）。返事と立て直しの欄（段 B）で最悪形が **約 300 バイト**
// 増えて約 2300 バイト、SNTP の欄（`sntp_syncs`・`sntp_last_sync_unix`）で **約 60 バイト**
// 増えて約 2360 バイト（2026-10-02 の実際の応答は約 1600 バイト）、送った分の輪の欄で **約 210 バイト**、
// フラッシュの輪の欄で **約 220 バイト**増えて約 2790 バイト。**2048 では 50 バイトしか残らなかった** ——
// `seq` と `unsent` と `pretime` は 100Hz で進むので **約 497 日の連続稼働で 10 桁へ届く**。
// 数百日動かす基板なので、桁が伸びた日に状態ページだけが 500 を返し始める。
//
// **3072 へ広げ、`static` にしてある。** 置き場所をスタックから移したのは、
// `loop()` のタスクのスタックは 8 KB しかないため。**再入は無い**（`handleClient()` を
// 呼ぶのは `loop()` だけ）。
//
// **センサーを 4 個目にするときは、ここも一緒に上げること。** 1 個ぶんが最悪形で
// 430 バイトある。
static void handleStatus(){
  time_t now = time(nullptr);
  // **前の起動の記録（`prev`）で約 700 バイト増えたので 4 KB にした。** センサー 3 個の実機で
  // 足す前が約 2050 バイト（2026-10-06）で、足すと 3 KB の手前まで来る。数え上げの桁が
  // 伸びれば溢れうる（溢れたら下で 500 を返す）。
  static char buf[4096];
  size_t u = 0;
  appendf(buf, sizeof(buf), u,
    "{\"node\":\"%s\",\"mac\":\"%s\",\"boot_id\":\"%s\",\"sensor\":\"MPU6050\","
    "\"uptime_s\":%lu,\"rssi\":%d,\"ip\":\"%s\",\"time_synced\":%s,\"unix\":%ld,"
    "\"sample_hz\":%d,\"ug_per_lsb\":%.4f,\"head_truncated\":%lu,"
    // **空きメモリを出す。** Wi-Fi が繋がり直すたびにソケットを開き直す作りなので
    // （→ `onWifiUp`）、**放し忘れがあれば繋ぎ直しの回数だけ減っていく**。
    // `udp_armed` と並べて読めば、増える側と減る側を突き合わせられる。
    "\"wifi_up\":%s,\"udp_armed\":%lu,\"udp_arm_fail\":%lu,\"wifi_got_ip\":%lu,"
    "\"free_heap\":%lu,"
    // **時計を最後にいつ合わせたかを出す。** `time_synced` だけでは、合わせてから
    // どれだけ経ったかが判らない——2026-10-01 にはこれが無く、22 時間一度も
    // 合わせていない基板が外からは「合っている」としか見えなかった（→ `clockTrusted`）。
    // `sntp_last_sync_unix` は一度も合わせていなければ 0。
    "\"sntp_syncs\":%lu,\"sntp_last_sync_unix\":%lu,",
    g_node, g_mac, g_bootId,
    (unsigned long)((millis()-g_bootMs)/1000), WiFi.RSSI(), WiFi.localIP().toString().c_str(),
    // **送るか送らないかを決めている式と同じものを出す。** 別の閾値で書くと、
    // ページが「合っている」と名乗りながら 1 件も送っていない状態が作れる。
    clockTrusted(now) ? "true":"false", (long)now,
    SAMPLE_HZ, UG_PER_LSB, (unsigned long)g_headTrunc,
    g_wifiUp ? "true":"false", (unsigned long)g_udpArmed, (unsigned long)g_udpArmFail,
    (unsigned long)g_wifiGotIpCount, (unsigned long)ESP.getFreeHeap(),
    (unsigned long)g_sntpSyncs, (unsigned long)g_sntpLastSyncUnix);
  // ホストの返事と、途絶えたときの立て直し（→ `checkAck`）。
  //
  // **`ack_age_s` は一度も受けていなければ -1。** 0 と書くと「たったいま受けた」と読める。
  // **`self_restarts` は数え直しの窓の中の回数**で、上限（`SELF_RESTART_MAX`）に
  // 達していれば `restart_skipped` が増え始める。
  const long ackAge = g_acks == 0 ? -1L : (long)((millis() - g_lastAckMs) / 1000);
  appendf(buf, sizeof(buf), u,
    "\"udp_open\":%s,\"acks\":%lu,\"ack_age_s\":%ld,\"ack_foreign\":%lu,\"ack_level\":%u,"
    "\"ack_rearms\":%lu,\"ack_reconnects\":%lu,\"host_probe_fail\":%lu,"
    "\"self_restarts\":%lu,\"restart_skipped\":%lu,\"reset_reason\":\"%s\","
    "\"booted_by_self_restart\":%s,",
    g_udpOpen ? "true":"false",
    (unsigned long)g_acks, ackAge, (unsigned long)g_ackForeign, (unsigned)g_ackLevel,
    (unsigned long)g_ackRearms, (unsigned long)g_ackReconnects, (unsigned long)g_hostProbeFail,
    (unsigned long)selfRestartsInWindow(now), (unsigned long)g_restartSkipped,
    resetReasonName(g_resetReason), g_bootedBySelfRestart ? "true":"false");
  // 送った分の輪（→ `handleBacklog`）。**`backlog_oldest_age_s` は空なら -1**（`ack_age_s` と同じ理由）。
  // 抱えている時間の長さは、この値で直接読める（区画数から換算させない）。
  long backlogAge = -1;
  if (g_backlog != nullptr && g_backlogUsed > 0) {
    struct timeval tv; gettimeofday(&tv, nullptr);
    const int64_t nowMs = (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
    backlogAge = (long)((nowMs - backlogAt(0).tFirstMs) / 1000);
  }
  appendf(buf, sizeof(buf), u,
    "\"backlog_ok\":%s,\"backlog_slots\":%u,\"backlog_used\":%u,\"backlog_oldest_age_s\":%ld,"
    "\"backlog_requests\":%lu,\"backlog_served\":%lu,\"backlog_bad\":%lu,\"backlog_other_boot\":%lu,\"backlog_load_fails\":%lu,",
    g_backlog != nullptr ? "true":"false", (unsigned)BACKLOG_SLOTS, (unsigned)g_backlogUsed, backlogAge,
    (unsigned long)g_backlogRequests, (unsigned long)g_backlogServed,
    (unsigned long)g_backlogBad, (unsigned long)g_backlogOtherBoot, (unsigned long)g_backlogLoadFails);
  // フラッシュの輪（→ `spillPump`）。**`flash_max_ms` は 1 区画の消去と書き込みの最長** ——
  // 吸い出しが待てるのは 1.4 秒まで（`HOST_PROBE_TIMEOUT_MS` の項）なので、ここが近づいたら危ない。
  size_t flashValid = 0;
  for (size_t i = 0; g_flashPart != nullptr && i < g_flashSectors; i++) if (g_flashIndex[i].valid) flashValid++;
  appendf(buf, sizeof(buf), u,
    "\"flash_ok\":%s,\"flash_sectors\":%u,\"flash_valid\":%u,\"spilling\":%s,\"spill_starts\":%lu,"
    "\"spill_gap_starts\":%lu,\"gap_acks\":%lu,\"gap_bad\":%lu,"
    "\"spill_lost\":%lu,\"spill_back_copies\":%lu,\"spill_caps\":%lu,\"spill_capped\":%s,\"flash_writes\":%lu,\"flash_fails\":%lu,"
    "\"flash_read_fails\":%lu,\"flash_crc_bad\":%lu,\"flash_max_ms\":%lu,\"flash_init_ms\":%lu,",
    g_flashPart != nullptr ? "true":"false", (unsigned)g_flashSectors, (unsigned)flashValid,
    g_spilling ? "true":"false", (unsigned long)g_spillStarts,
    (unsigned long)g_spillGapStarts, (unsigned long)g_gapAcks, (unsigned long)g_gapBad,
    (unsigned long)g_spillLost, (unsigned long)g_spillBackCopies,
    (unsigned long)g_spillCaps, g_spillCapped ? "true":"false",
    (unsigned long)g_flashWrites, (unsigned long)g_flashFails,
    (unsigned long)g_flashReadFails, (unsigned long)g_flashCrcBad, (unsigned long)g_flashMaxMs,
    (unsigned long)g_flashInitMs);
  // 直前の状態（→ `PrevState`）。**この起動の書き込みの健全性と、前の起動の最後の記録を並べる。**
  // `prev` は記録が無ければ null。`saved_age_s` は書いてから今までの秒数で、
  // 書いた時刻か今の時計のどちらかが合っていなければ -1（電源投入の直後、SNTP が合うまで）。
  appendf(buf, sizeof(buf), u,
    "\"wifi_downs\":%lu,\"nvs_ok\":%s,\"prev_saves\":%lu,\"prev_save_fails\":%lu,\"prev_save_max_ms\":%lu,",
    (unsigned long)g_wifiDowns, g_prefsOk ? "true":"false", (unsigned long)g_prevSaves,
    (unsigned long)g_prevSaveFails, (unsigned long)g_prevSaveMaxMs);
  if (g_prevValid) {
    const PrevState &p = g_prev;
    const long savedAge = (p.savedUnix > 0 && clockTrusted(now)) ? (long)((int64_t)now - p.savedUnix) : -1L;
    appendf(buf, sizeof(buf), u,
      "\"prev\":{\"boot_id\":\"%08lx\",\"reset_reason\":\"%s\",\"booted_by_self_restart\":%s,"
      "\"why\":\"%s\",\"saved_unix\":%lu,\"saved_age_s\":%ld,\"uptime_s\":%lu,\"saves\":%lu,"
      "\"wifi_up\":%s,\"wifi_down_s\":%lu,\"wifi_downs\":%lu,\"rssi\":%d,"
      "\"ack_level\":%u,\"ack_age_s\":%ld,\"acks\":%lu,\"ack_rearms\":%lu,\"ack_reconnects\":%lu,"
      "\"host_probe_fail\":%lu,\"self_restarts\":%lu,\"restart_skipped\":%lu,"
      "\"sntp_syncs\":%lu,\"free_heap\":%lu,\"sensors_ok\":%u},",
      (unsigned long)p.bootId, resetReasonName((esp_reset_reason_t)p.resetReason),
      p.bootedBySelfRestart ? "true":"false", prevWhyName(p.why),
      (unsigned long)p.savedUnix, savedAge, (unsigned long)p.uptimeS, (unsigned long)p.saves,
      p.wifiUp ? "true":"false", (unsigned long)p.wifiDownS, (unsigned long)p.wifiDowns, (int)p.rssi,
      (unsigned)p.ackLevel, (long)p.ackAgeS, (unsigned long)p.acks, (unsigned long)p.ackRearms,
      (unsigned long)p.ackReconnects, (unsigned long)p.hostProbeFail, (unsigned long)p.selfRestarts,
      (unsigned long)p.restartSkipped, (unsigned long)p.sntpSyncs, (unsigned long)p.freeHeap,
      (unsigned)p.sensorsOk);
  } else {
    appendf(buf, sizeof(buf), u, "\"prev\":null,");
  }
  appendf(buf, sizeof(buf), u, "\"i2c\":[");
  for (int b = 0; b < 2; b++) {
    appendf(buf, sizeof(buf), u,
      "%s{\"bus\":%d,\"begun\":%s,\"found\":%u,\"addrs\":\"%s\",\"addrs_truncated\":%s}",
      b == 0 ? "" : ",", b, g_busOk[b] ? "true":"false",
      (unsigned)g_scanN[b], g_scan[b], g_scanCut[b] ? "true":"false");
  }
  appendf(buf, sizeof(buf), u, "],\"sensors\":[");
  for (size_t i = 0; i < SENSOR_N; i++) {
    const Sensor &s = g_sensors[i];
    appendf(buf, sizeof(buf), u,
      "%s{\"sid\":\"%s\",\"ok\":%s,\"who_am_i\":\"0x%02X\",\"seq\":%lu,"
      "\"packets\":%lu,\"overflow\":%lu,\"i2c_fail\":%lu,\"fail_streak\":%lu,"
      "\"partial\":%lu,\"partial_streak\":%lu,\"realign\":%lu,\"realign_streak\":%lu,\"unsent\":%lu,"
      "\"pretime\":%lu,\"init_tries\":%lu,\"init_fails\":%u,\"rem_hist\":[",
      i == 0 ? "" : ",", s.sid, s.ok ? "true":"false", s.who,
      (unsigned long)s.seq, (unsigned long)s.sent, (unsigned long)s.overflow,
      (unsigned long)s.i2cFail, (unsigned long)s.failStreak,
      (unsigned long)s.partial, (unsigned long)s.partialStreak,
      (unsigned long)s.realign, (unsigned long)s.realignStreak,
      (unsigned long)s.unsent, (unsigned long)s.pretime,
      (unsigned long)s.initTries, (unsigned)s.initFails);
    // 端数の内訳。**先頭が端数 1 バイト**で、末尾が 5 バイト。
    for (size_t r = 0; r < BPS - 1; r++) {
      appendf(buf, sizeof(buf), u, "%s%lu", r == 0 ? "" : ",", (unsigned long)s.remHist[r]);
    }
    appendf(buf, sizeof(buf), u, "],\"last\":[%d,%d,%d]}",
      s.last[0], s.last[1], s.last[2]);
  }
  appendf(buf, sizeof(buf), u, "]}");
  // **切り詰めた JSON を返さない。** 読み手は壊れた中身を「センサーが無い」と
  // 読みうる。収まらなかったことを、そうと判る形で伝える。
  if (u >= sizeof(buf) - 1) {
    http.send(500, "text/plain", "status json truncated");
    return;
  }
  http.send(200, "application/json", buf);
}

// 管理の口のヘッダ名。**`WebServer` は指定したヘッダしか拾わない**ので、
// `http.begin()` より前に `collectHeaders` へ渡すこと（→ `onWifiUp`）。
static const char* const ADMIN_TOKEN_HEADER = "X-Seismo-Token";

// 管理の口のトークンを照合する。
//
// **トークンが空なら必ず拒む。** 設定ファイルに `ADMIN_TOKEN` が無い基板
// （定義を足す前の `wifi_config.h` が手元に残っている）では、口が開くのではなく
// 閉じるほうへ倒れる。**開くほうへ倒れる作りだと、焼いた瞬間に
// 「同じ LAN の誰でも落とせる基板」が増える。**
//
// **長さの違いも含めて一定の時間で比べる。** 早期に抜ける比較は、合っている文字数が
// 応答時間に出る。LAN 内の開発用の基板なので現実の脅威は小さいけれど、
// **正しく書くほうが安い**。
static bool adminTokenOk(){
  const char* want = ADMIN_TOKEN;
  const size_t wn = strlen(want);
  // **空のときに真を返させない。** 空なら下のループが 1 度も回らず、ヘッダも空なら
  // `diff` が 0 のまま真になる——**合言葉を設定していない基板で誰でも通る。**
  // 呼び出し前に `adminAllowed` が弾いているが、ここだけを使う人が現れても落ちないように残す。
  if (wn == 0) return false;
  const String got = http.header(ADMIN_TOKEN_HEADER);
  uint8_t diff = (got.length() == wn) ? 0 : 1;
  for (size_t i = 0; i < wn; i++) {
    diff |= (uint8_t)(want[i] ^ (i < got.length() ? got[i] : 0));
  }
  return diff == 0;
}

// 管理の口を通してよいか。**通らない理由ごとに別の応答を返し、返したうえで偽を返す。**
//
// **「この基板に口が無い」と「合言葉が違う」を同じ 403 にしない。** `ADMIN_TOKEN` を
// 足す前の `wifi_config.h` は各基板の手元に残っている（`.gitignore` なのでリポジトリから
// 配れない）ため、焼き直していない基板では口が閉じている。そこへ 403 を返すと、
// 呼んだ側はそれを「打ち間違えた」と読んで正しい合言葉を何度も試す ——
// **いちばん助けが要る基板（古いファームのまま黙ったもの）で、復旧の手が迷走する。**
//
// **口の有無が漏れることは問わない。** 合言葉そのものを守れていればよく、
// LAN 内の開発用の基板で「再起動の口があるか」を隠す意味はない（`adminTokenOk` の
// 脅威の見立てと同じ）。
static bool adminAllowed(){
  if (ADMIN_TOKEN[0] == '\0') {
    http.send(501, "text/plain", "admin disabled: no ADMIN_TOKEN on this board\n");
    return false;
  }
  if (!adminTokenOk()) {
    http.send(403, "text/plain", "bad token\n");
    return false;
  }
  return true;
}

// 遠隔で再起動する口。
//
// **これが無いと、送信経路が壊れた基板を電源の抜き差し以外で戻せない。**
// 2026-09-30 に 1 枚がその状態に陥り、HTTP も ping も応えるのに UDP だけが
// 5 日間 1 バイトも出ていなかった——状態ページは読めるのに、戻す手が無かった。
//
// **POST 限定にする。** GET だと、ブラウザの先読み・履歴の復元・クローラが
// 踏むだけで基板が落ちる。誰も頼んでいない再起動は、起きた理由が追えない。
//
// **応答を返してから間を置いて落とす。** 即座に `ESP.restart()` すると応答が返らず、
// 呼んだ側には「繋がらなかった」としか見えない——**再起動できたのか届かなかったのかが
// 区別できない口は、再起動を頼む口として使えない。**
static void handleRestart(){
  if (!adminAllowed()) return;
  Serial.println("# /restart を受けたので再起動する");
  prevSave(millis(), PREV_WHY_RESTART);
  http.send(200, "text/plain", "restarting\n");
  // **応答が出ていく猶予は `delay` が作っている。`flush()` ではない。**
  // Arduino の `Client::flush()` は**受け取ったまま読んでいないものを捨てる**操作で、
  // 送信が線に出たことの保証ではない。**`flush()` があるから `delay` は要らない、と
  // 読まないこと**——削ると応答が返らなくなり、「再起動できたのか届かなかったのか」を
  // 区別できない口に戻る。
  http.client().flush();
  delay(200);
  ESP.restart();
}

// Wi-Fi のイベントを受ける。**旗を立てるだけ。**
//
// **ここで立て直しそのものをやらない。** 呼ばれるのは Arduino のイベントタスクで、
// `loop()` とは別の流れ・別のスタック。そこから `http.begin()` や `udp.begin()` を
// 叩くのは、同じ持ち物を 2 つの流れから触ることになる。
static void onWifiEvent(WiFiEvent_t event){
  if (event == ARDUINO_EVENT_WIFI_STA_GOT_IP) {
    g_wifiGotIp = true;
    // `++` で書かない。`volatile` への複合代入は C++20 で非推奨（コンパイラが警告する）。
    // 書き手はこのイベントタスクだけなので、読んで足して書く形でも数え落としは起きない。
    g_wifiGotIpCount = g_wifiGotIpCount + 1;
  }
}

// Wi-Fi を切って繋ぎ直す。**遠隔の口（`handleWifiReconnect`）と返事の途絶（`checkAck`）の
// 両方がここを通る**——別々に書くと、片方だけ `begin()` を呼び忘れる形が作れてしまう
// （その形で基板を 1 枚落とした。理由は `handleWifiReconnect` の項）。
//
// **引数を足さないこと。** `WiFi.disconnect(wifioff, eraseap)` の `eraseap` を真に
// すると保存してある接続先ごと消える。**遠隔で戻す口を作るはずのものが、
// 遠隔で殺す口になる。**
static void reconnectWifi(){
  WiFi.disconnect();
  delay(200);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

// UDP のソケットを閉じて開き直す。**繋がり直したとき（`onWifiUp`）と、返事が途絶えたとき
// （`checkAck`）の 2 箇所から呼ぶ。**
//
// **閉じてから開く。** 閉じずに開くと、切れる前の記述子が残る。
// **開けたかを数える。** 無条件に `g_udpArmed` を進めると「開こうとした回数」になる
// （→ `g_udpArmFail`）。
static void armUdp(){
  // 最後に開こうとした時刻。**呼び出し元を問わずここで記録する**——開き直しの再試行
  // （`retryUdpOpen`）は ここから数えるので、繋がり直し（`onWifiUp`）や段 0（`checkAck`）で
  // 開いた直後に、もう一度開き直すことが無い。
  g_lastArmMs = millis();
  udp.stop();
  g_udpOpen = false;
  if (udp.begin(0)) {
    g_udpArmed++;
    g_udpOpen = true;
  } else {
    g_udpArmFail++;
    Serial.println("# udp.begin(0) が失敗した（このままでは 1 件も送れない）");
  }
}

// Wi-Fi をわざと切る口。**繋ぎ直しで本当に立て直せるかを、現地で試すため。**
//
// **これが無いと「繋がり直したら立て直す」は推測のまま残る。** 今回のいちばんの
// 直しどころなのに、基板の側に切断を起こす手が無いと、焼いたあとで効いているかを
// 確かめられない——AP を落とせば試せるが、同じ LAN のすべてを巻き込む。
// **運用でも使える**：送れなくなった基板が自力で戻れるかを、電源を抜く前に試せる。
//
// **繋ぎ直しは必ず自分で呼ぶ。`setAutoReconnect(true)` は当てにできない。**
//
// あちらが効くのは**予期しない**切断（電波が届かない・AP が落ちた）に対してだけで、
// **こちらから呼んだ `disconnect()` は「意図した切断」として扱われ、繋ぎ直されない**。
// 2026-10-01 に自動で戻ると思って `disconnect()` だけを呼び、**基板を 1 枚
// ネットワークから落とした**（ping も通らず、電源を入れ直すまで戻らなかった）。
//
// **`begin()` を自分で呼んでも、確かめたいものは確かめられる。** 見たいのは
// 「繋がったときに `onWifiUp` が立て直すか」で、そこへ至る道（`loop()` の
// 変わり目の検出）は実際の切断と共通。誰が `begin()` を呼んだかは問わない。
// 切り方と繋ぎ方は `reconnectWifi` が持つ（返事の途絶でも同じ道を通る）。
static void handleWifiReconnect(){
  if (!adminAllowed()) return;
  Serial.println("# /wifi-reconnect を受けたので Wi-Fi を切って繋ぎ直す");
  http.send(200, "text/plain", "reconnecting\n");
  // 猶予を作っているのは `delay` のほう（理由は `handleRestart` の同じ箇所）。
  //
  // **`handleRestart` と同じ 200 ms にしてある。** 短くする理由が無いうえ、
  // `WiFi.disconnect()` は AP との結び付きを先に切るので、**再起動より早く線が消える**
  // ——応答が出る前に切れると「再起動できたのか届かなかったのか」が区別できなくなる。
  http.client().flush();
  delay(200);
  reconnectWifi();
}

// Wi-Fi が繋がったときに立てるもの。**起動時と、切れて繋がり直したときの両方で通る。**
//
// **以前はこれを `setup()` の中へ直に書いていて、起動時に 30 秒待って繋がらなければ
// SNTP も mDNS も OTA も状態ページも UDP も丸ごと飛ばしていた。**
// `setAutoReconnect(true)` が後で繋ぎ直すので Wi-Fi だけは復活するが、そのとき
// **開いていないソケットへ UDP を投げ続け、状態ページも出ず、OTA も立っていないので
// 遠隔で焼き直すこともできない**——電源を抜くしか戻せない基板になる。
// **停電からの復帰で普通に踏む**：ルーターが立ち上がるのに 1 分以上かかるのに、
// 基板は 1 秒で起きて 30 秒で諦めるため。
//
// **二度立ててよいものと、そうでないものを分ける。** `WebServer::begin()`・
// `ArduinoOTA.begin()`・`MDNS.begin()` には対になる「放す」口が無く、繋ぎ直すたびに
// 呼ぶと listen のソケットが積み上がりうる。**毎回やり直すのは SNTP と UDP だけ**で、
// UDP は `stop()` で古いものを閉じてから開く（閉じずに開くと、切れる前の記述子が残る）。
static void onWifiUp(){
  Serial.printf("# wifi up ip=%s rssi=%d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());

  // **この起動で合うまでは繋ぎ直しのたびに呼び、合ったあとは呼ばない。** UTC で持つ
  // （表示側で直す）。
  //
  // lwIP の SNTP は**自分で再試行する**（間隔を倍々に伸ばしながら）ので、
  // 一度合ったあとに作り直す意味は無い。**むしろ呼び直しを続けると、回線が激しく
  // 明滅する環境で往復が終わる前に初期化され直し、初回の同期がいつまでも
  // 終わらない余地が残る**（頻度は未測定）。合う前だけ呼べば、その余地だけが消える。
  //
  // **「合ったか」を時計の値で見てはいけない。** ソフトウェアの再起動では時計が
  // 残るので、値だけ見ると起動した瞬間に「合っている」と判定し、**SNTP を一度も
  // 始めないまま走り続ける**（理由と実例は `clockTrusted`）。見るのは、この起動で
  // SNTP のコールバックが来たかどうか。
  //
  // 通知と間隔は `configTime`（中で `sntp_init` を呼ぶ）より前に渡す。間隔は
  // 走り出してから変えると、次の取り直しまで古い値のまま待つ。
  if (g_sntpSyncs == 0) {
    esp_sntp_set_time_sync_notification_cb(onSntpSync);
    esp_sntp_set_sync_interval(SNTP_SYNC_INTERVAL_MS);
    configTime(0, 0, "ntp.nict.jp", "pool.ntp.org");
    if (!g_sntpStarted) {
      g_sntpStarted = true;
      Serial.printf("# sntp を始めた（起動時の時計 unix=%ld）\n", (long)time(nullptr));
    }
  }

  // **繋ぎ直したら必ず開き直す。** ESP32 の `WiFiUDP` は Wi-Fi が切れるとソケットが
  // 無効になり、**それでも `beginPacket()`／`endPacket()` は成功を返す**。
  // 2026-09-30 に実機で 144 万パケットぶん「送れたつもり」を数えていた。
  armUdp();
  // **返事の計時は計り直す**（新しいソケットで送れた時点から）。段は戻さない
  // （→ `g_ackLevel`）。
  g_ackWaiting = false;

  if (g_servicesUp) return;
  if (MDNS.begin(g_node)) Serial.printf("# mdns %s.local\n", g_node);
  ArduinoOTA.setHostname(g_node);
  // 焼き直しも再起動を伴うので、始める前に書く（`why: "ota"`）。書かないと前の起動の記録は
  // 最大 60 秒前の生存記録のまま残り、焼き直したのか止まったのかが記録から読めない。
  // 呼ばれるのは `ArduinoOTA.handle()` の中、つまり `loop()` の流れ。
  ArduinoOTA.onStart([](){ prevSave(millis(), PREV_WHY_OTA); });
  ArduinoOTA.begin();
  http.on("/", handleStatus);
  http.on("/restart", HTTP_POST, handleRestart);
  http.on("/wifi-reconnect", HTTP_POST, handleWifiReconnect);
  // **合言葉を掛けない。** 返すのは UDP で LAN へ流しているのと同じ波形で、
  // 状態ページと同じく読むだけの口（基板の状態を変えない）。
  http.on("/backlog", HTTP_GET, handleBacklog);
  // **`begin()` より前に渡す。** `WebServer` は列挙したヘッダだけを保存し、
  // それ以外は捨てる。渡し忘れると `http.header()` が常に空を返し、
  // **トークンが正しくても 403 になる**（しかも「トークンが違う」としか見えない）。
  //
  // **可変長引数版は使えない。** esp32 コア 3.3.12 の `WebServer` が持つのは
  // `collectHeaders(const char* keys[], size_t n)` の 1 つだけ（実際に落ちた）。
  // 配列の要素は `const char*`——`const char* const` にすると `const char**` へ
  // 渡らない。
  const char* adminHeaders[] = { ADMIN_TOKEN_HEADER };
  http.collectHeaders(adminHeaders, 1);
  http.begin();
  g_servicesUp = true;
}

void setup(){
  Serial.begin(115200);
  delay(300);
  g_bootMs = millis();
  resolveNodeName();
  // 前の起動の記録を読む（→ `PrevState`）。書くのは `PREV_MIN_GAP_MS` 経ってから。
  prevLoad();
  g_lastPrevSaveMs = g_bootMs;
  g_wifiDownSinceMs = g_bootMs;

  // 送った分の輪（→ `g_backlog`）。**Wi-Fi やソケットより先に取る** —— 大きな塊は、
  // ヒープが細切れになる前のほうが取りやすい。
  g_backlog = (BacklogSlot*)malloc(sizeof(BacklogSlot) * BACKLOG_SLOTS);
  if (g_backlog == nullptr) {
    Serial.printf("# WARN 送った分の輪（%u バイト）を確保できなかった。取り戻しの口は閉じたまま\n",
                  (unsigned)(sizeof(BacklogSlot) * BACKLOG_SLOTS));
  }

  // 自分で再起動した回数の帳面を読む（→ `RestartLedger`）。**電源投入なら必ず白紙にする**
  // ——中身が不定なので、`magic` がたまたま合っても信じない。
  g_resetReason = esp_reset_reason();
  if (g_resetReason == ESP_RST_POWERON || g_restartLedger.magic != RESTART_LEDGER_MAGIC) {
    g_restartLedger.magic = RESTART_LEDGER_MAGIC;
    g_restartLedger.count = 0;
    g_restartLedger.firstUnix = 0;
    g_restartLedger.pending = 0;
  }
  // **ソフトウェアの再起動で始まったときだけ「自分で起こした」と読む。** 印を立てて
  // 再起動へ向かう途中で番犬に落とされた（理由が `ESP_RST_SW` ではない）なら、
  // 自分の再起動として数えるのは誤り。
  g_bootedBySelfRestart = g_restartLedger.pending == 1 && g_resetReason == ESP_RST_SW;
  g_restartLedger.pending = 0;

  g_busOk[0] = Wire.begin();
  Wire.setClock(400000);
  g_busOk[1] = Wire1.begin(I2C1_SDA, I2C1_SCL);
  Wire1.setClock(400000);

  // **初期化より先に舐める。** 初期化が失敗した理由（居ない／別のアドレスに居る）を
  // 分けるには、素のバスに誰が居たかを先に取っておくしかない。
  g_scanN[0] = scanBus(Wire,  g_scan[0], sizeof(g_scan[0]), g_scanCut[0]);
  g_scanN[1] = scanBus(Wire1, g_scan[1], sizeof(g_scan[1]), g_scanCut[1]);

  for (size_t i = 0; i < SENSOR_N; i++) sensorInit(g_sensors[i]);

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);          // 省電力で受信が遅れると取りこぼしの原因になる
  // **予期しない切断（電波が届かない・AP が落ちた）だけを拾う。** こちらから呼んだ
  // `disconnect()` は「意図した切断」として扱われ、これでは戻らない（→ `handleWifiReconnect`）。
  WiFi.setAutoReconnect(true);
  // **`begin()` より前に登録する。** 後だと、繋がるのが速かった回の
  // `STA_GOT_IP` を取りこぼす（→ `g_wifiGotIp`）。
  WiFi.onEvent(onWifiEvent);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  // **起動 ID は Wi-Fi を起こしてから採る。** `esp_random()` が真の乱数を返すのは
  // RF が動いているときだけで、それより前だと擬似乱数になる。衝突すると受け手は
  // 再起動をパケットの並び替えと読み、通し番号の戻りを繋いでしまう。
  snprintf(g_bootId, sizeof(g_bootId), "%08x", (unsigned)esp_random());
  g_bootIdNum = (uint32_t)strtoul(g_bootId, nullptr, 16);
  // フラッシュの輪は起動 ID が決まってから開く（書きかけの区画が名乗るため）。
  flashInit();
  if (g_flashPart != nullptr) {
    size_t valid = 0;
    for (size_t i = 0; i < g_flashSectors; i++) if (g_flashIndex[i].valid) valid++;
    Serial.printf("# フラッシュの輪: %u 区画（うち %u 区画に前の分）・次は %u\n",
                  (unsigned)g_flashSectors, (unsigned)valid, (unsigned)g_flashNext);
  }

  Serial.printf("\n# %s (%s) booting bid=%s reset=%s%s self_restarts=%lu\n",
                g_node, g_mac, g_bootId, resetReasonName(g_resetReason),
                g_bootedBySelfRestart ? "（返事の途絶で自分から）" : "",
                (unsigned long)g_restartLedger.count);
  if (g_prevValid) {
    const PrevState &p = g_prev;
    Serial.printf("# 前の起動 bid=%08lx reset=%s 最後の記録=%s uptime=%lus unix=%lu "
                  "wifi_up=%u down=%lus downs=%lu rssi=%d ack_level=%u ack_age=%lds\n",
                  (unsigned long)p.bootId, resetReasonName((esp_reset_reason_t)p.resetReason),
                  prevWhyName(p.why), (unsigned long)p.uptimeS, (unsigned long)p.savedUnix,
                  (unsigned)p.wifiUp, (unsigned long)p.wifiDownS, (unsigned long)p.wifiDowns,
                  (int)p.rssi, (unsigned)p.ackLevel, (long)p.ackAgeS);
  } else {
    Serial.println("# 前の起動の記録は無い");
  }
  for (int b = 0; b < 2; b++) {
    Serial.printf("# i2c%d begun=%d scan: %u found (%s)%s\n",
                  b, g_busOk[b], (unsigned)g_scanN[b], g_scan[b], g_scanCut[b] ? " …切れ" : "");
  }
  for (size_t i = 0; i < SENSOR_N; i++) {
    const Sensor &s = g_sensors[i];
    Serial.printf("# sensor %s ok=%d who=0x%02X initFails=%u\n",
                  s.sid, s.ok, s.who, (unsigned)s.initFails);
  }

  // **Wi-Fi が繋がるのを待たない。** 待って諦める形だと、諦めた回の起動では
  // SNTP も OTA も状態ページも UDP も立たないまま走り続ける（理由は `onWifiUp`）。
  // 繋がったことは `loop()` が変わり目として拾い、何度でも立て直す。
  Serial.println("# wifi は loop() が繋がり次第立てる");
  for (size_t i = 0; i < SENSOR_N; i++) armSensor(g_sensors[i]);
}

// `q`（通し番号）は「送れたサンプル」しか数えないので、FIFO があふれて落とした分は
// 番号が飛ばずに詰まってしまう。取りこぼしを見つけるための番号が取りこぼしを隠す形。
// そこで累積の OVERFLOW 回数を `o` として同梱し、受け手が不連続を知れるようにする。
// 時刻 `t` と件数 `c` の突き合わせも併せて使えば、どこで落ちたかまで辿れる。
//
// **送れなかったぶんは `unsent` に数える。** `s.seq` は吸い出した時点で進むので、
// 送らずに戻ると受け手からは「通し番号が飛んだ」としか見えない。基板の側に理由を
// 残しておかないと、センサーが死んだのか Wi-Fi が切れていたのかを分けられない。
//
// **時計が合う前は送らない**（`pretime` に数える）。1970 年を名乗るパケットは、
// 受け手では「番号は続いているのに時刻だけが飛んだ」形になる（→ `MIN_SYNCED_UNIX`）。
// ソフトウェアの再起動で持ち越した時計も、この起動で SNTP が合わせるまでは送らない
// （→ `clockTrusted`）——送れば、最初の同期で時計がずれの分だけ跳び、受け手の区間が切れる。
// 判定をここへ置くのは、**送る口がここ 1 つだけ**だから——`drainSensor` の側で
// 弾くと、時刻を組み立てる場所と送る場所に判定が 2 つできる。
//
// **時計が合っていれば、送れるかどうかより先に輪へ残す**（→ `backlogPut`）。Wi-Fi が
// 切れている間の分こそ、あとでホストが取りに来る。時計が合う前の分は残さない ——
// 名乗る時刻が信用できないので、取り戻しても受け手を惑わせるだけ。
static void sendChunk(Sensor &s, const int16_t *v, size_t n, uint32_t seq0, int64_t tFirstMs){
  const time_t nowSec = time(nullptr);
  const bool trusted = clockTrusted(nowSec);
  if (trusted) backlogPut(s, v, n, seq0, tFirstMs);
  if (WiFi.status() != WL_CONNECTED) { s.unsent += n; return; }
  if (!trusted) { s.pretime += n; return; }
  if (!g_timeReady) {
    g_timeReady = true;
    Serial.printf("# 時計が合った（unix=%ld）。ここから送り始める\n", (long)nowSec);
  }
  char head[320];
  const int hl = formatHead(head, sizeof(head), g_bootId, s, n, seq0, tFirstMs, s.overflow);
  // 切り詰められた JSON を送らない。受け手には「先頭行が読めない」としか見えず、
  // 別のプログラムが同じ口へ投げている疑いの件数に混ざる。
  if (hl <= 0 || (size_t)hl >= sizeof(head)) { g_headTrunc++; s.unsent += n; return; }
  udp.beginPacket(UDP_HOST, UDP_PORT);
  udp.write((const uint8_t*)head, hl);
  for (size_t i = 0; i < n; i++) {
    char line[32];
    const int ll = formatLine(line, sizeof(line), &v[i*3]);
    udp.write((const uint8_t*)line, ll);
  }
  if (udp.endPacket()) {
    s.sent++;
    // 返事の計時は、返事のあとで最初に送れた時点から（→ `ACK_SILENCE_MS`）。
    if (!g_ackWaiting) {
      g_ackWaiting = true;
      g_ackWaitStartMs = millis();
    }
  } else {
    s.unsent += n;
  }
}

// 開き損ねた UDP を開き直す。**返事の門（`checkAck`）とは独立に回す。**
//
// **これが無いと、開き損ねた基板は立て直しの仕組みごと止まる。** コアの `beginPacket()` は
// ソケットが無ければその場で作るので（`NetworkUdp.cpp` の `beginPacket`）、送信は通って
// しまうことが多い——ところが `g_udpOpen` は偽のままなので `readAcks` が返事を読まず、
// 返事を一度も受けていない起動では門が閉じたまま段が上がらない。その場の作成まで
// 失敗すれば `endPacket()` が偽を返し、計時も始まらない。**どちらも外からは黙るだけ。**
//
// 段を上げる話ではない（開き損ねたものを開くだけ）ので、門も HTTP の到達確認も通さない。
// 間隔は `ACK_SILENCE_MS` に揃え、**最後に開こうとした時刻（どこから開いたかを問わない）**
// から数える——開けない原因（記述子の枯渇など）がすぐには消えない場面で、`loop()` の
// 1 周ごとに試してシリアルを埋めないため。繋がり直しで開き損ねた直後に、同じ周で
// もう一度試すことも無い。
static void retryUdpOpen(uint32_t nowMs){
  if (!g_wifiUp || g_udpOpen) return;
  // 符号無しで引いてよいのは、`g_lastArmMs` を書く経路（`onWifiUp`・`checkAck`）がどれも
  // この呼び出しより後に `nowMs` を取り直すか、同じ周でこれより後に走るから。**`loop()` の
  // 呼び出し順を入れ替えたら見直すこと**（`spillPump` が同じ形で取り違えた）。
  if (nowMs - g_lastArmMs < ACK_SILENCE_MS) return;
  Serial.println("# UDP のソケットが開いていない。開き直す");
  armUdp();
}

// 届いている返事を読む。**自分宛てなら段を 0 へ戻す。**
//
// **読んだら必ず捨てる（`clear()`。旧名の `flush()` は非推奨）。** `parsePacket()` は
// 前のパケットを読み残していると
// **次から 0 を返し続ける**（`NetworkUdp.cpp` の `parsePacket` が冒頭で抜ける）。
// 想定より長いものが 1 つ届いただけで、以後の返事が 1 つも読めなくなり、
// 基板は「返事が途絶えた」と取り違えて立て直しを始める。
//
// **送り元のアドレスは見ない。** `UDP_HOST` は名前でも書けるので突き合わせには
// 名前解決が要り、LAN の中で返事を偽る相手は想定していない。宛名の MAC だけを照合する。
//
// **返事は `seismo-ack <MAC>[ gap=<sid>:<seq>,…]\n`。** 宛名の後ろが改行なら欠けは無く、
// ` gap=` が続けば、ホストがまだ取り戻せていない欠けのいちばん古い始まりがセンサーごとに並ぶ
// （ホストの `ackReplier.ts`）。読めた分を `g_gapFrom` へ写し、`spillPump` が書き出しを始める。
// **`gap=` の中身が読めなくても返事としては受ける** —— 返事を落とすと段が上がり始める。
// 知らない名前のセンサーは飛ばす（届くのは自分の名乗った名前だけのはず）。
//
// 1 周に読むのは 4 つまで。返事は 1 秒に 1 つなので、溜まっていても次の周で読める。
static const size_t ACK_LINE_MAX = 192;
static bool parseGapField(const char* p){
  bool has[SENSOR_N] = {};
  uint32_t from[SENSOR_N] = {};
  while (*p != '\n') {
    const char* colon = strchr(p, ':');
    if (colon == nullptr || colon == p) return false;
    const size_t nameLen = (size_t)(colon - p);
    char* end = nullptr;
    const unsigned long long seq = strtoull(colon + 1, &end, 10);
    if (end == colon + 1 || seq > 0xffffffffULL || (*end != ',' && *end != '\n')) return false;
    for (size_t s = 0; s < SENSOR_N; s++) {
      const char* sid = g_sensors[s].sid;
      if (strlen(sid) == nameLen && memcmp(sid, p, nameLen) == 0) {
        has[s] = true;
        from[s] = (uint32_t)seq;
      }
    }
    p = *end == ',' ? end + 1 : end;
  }
  for (size_t s = 0; s < SENSOR_N; s++) { g_gapHas[s] = has[s]; g_gapFrom[s] = from[s]; }
  return true;
}

static void readAcks(){
  // Wi-Fi が切れている間は読まない（`retryUdpOpen`・`checkAck` と同じ門）。切れても記述子は
  // 有効なままなので読んで害は無いが、届くはずの無いものを読みに行く理由も無い。
  if (!g_wifiUp || !g_udpOpen) return;
  char want[32];
  const int wl = snprintf(want, sizeof(want), "seismo-ack %s", g_macFlat);
  for (int i = 0; i < 4; i++) {
    if (udp.parsePacket() <= 0) return;
    char got[ACK_LINE_MAX];
    const int n = udp.read(got, sizeof(got) - 1);
    udp.clear();
    got[n > 0 ? n : 0] = '\0';
    // 宛名まで一致し、その直後が改行か ` gap=`。**改行で終わっていない行は受けない**
    // （入れ物からはみ出して切れた行を、欠けの無い返事と取り違えない）。
    const bool mine = wl > 0 && n > wl && memcmp(got, want, (size_t)wl) == 0
                      && got[n - 1] == '\n' && (got[wl] == '\n' || strncmp(got + wl, " gap=", 5) == 0);
    if (mine) {
      if (got[wl] == '\n') {
        for (size_t s = 0; s < SENSOR_N; s++) g_gapHas[s] = false;
      } else if (parseGapField(got + wl + 5)) {
        bool any = false;
        for (size_t s = 0; s < SENSOR_N; s++) any = any || g_gapHas[s];
        if (any) { g_gapAcks++; g_lastGapMs = millis(); g_gapBackPending = true; }
      } else {
        g_gapBad++;
      }
      g_acks++;
      g_lastAckMs = millis();
      {
        struct timeval tv; gettimeofday(&tv, nullptr);
        g_lastAckUnixMs = (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
      }
      g_ackWaiting = false;
      if (g_ackLevel != 0) {
        Serial.printf("# ホストの返事が戻った（段 %u まで上がっていた）\n", (unsigned)g_ackLevel);
        g_ackLevel = 0;
        g_prevDirty = true;
      }
    } else {
      g_ackForeign++;
    }
  }
}

// ホストが HTTP で答えるか。**返事が途絶えたとき、ホストが止まっているだけかを確かめる。**
//
// **答えなければ段を上げない。** 開発でホストを止めるたびに基板が繋ぎ直しと再起動を
// 始めると、ホストを戻したときには基板のほうが時計合わせの最中で、しばらく波形が来ない。
//
// **TCP が繋がるだけでは足りない。** 接続を受け付けるのは OS で、ホストのプロセスが
// 止まっていても繋がる（処理の止まった node へ 6 ms で繋がり、HTTP は時間切れになった。
// 2026-10-02 に実測）。2026-10-02 13:41 には同じ機械の重い処理でホストが約 45 秒止まり、
// 基板 2 枚が「ホストは生きている」と読んで再起動まで段を上げた。**答えが返って初めて、
// ホストの処理が回っている**と言える。
//
// **状態コードは見ない。** `HTTP/` で始まる答えが返れば生きている —— `/healthz` を
// 持たない古いホストも 404 で答える。
//
// **HTTP が答えるのに UDP の返事が来ない**、が直したい形そのもの——UDP のソケットだけが
// 壊れていても、HTTP は別のソケットなので答える（2026-09-30 の基板は HTTP に応え続けていた）。
static bool hostReachable(){
  WiFiClient c;
  if (!c.connect(UDP_HOST, HOST_HTTP_PORT, HOST_PROBE_TIMEOUT_MS)) {
    c.stop();
    return false;
  }
  c.printf("GET /healthz HTTP/1.0\r\nHost: %s\r\nConnection: close\r\n\r\n", UDP_HOST);
  const uint32_t start = millis();
  while (c.available() < 5 && millis() - start < HOST_PROBE_REPLY_MS) {
    // 閉じられて何も残っていなければ、待っても答えは来ない。
    if (!c.connected() && c.available() == 0) break;
    delay(5);
  }
  bool ok = false;
  if (c.available() >= 5) {
    char head[5];
    ok = c.read((uint8_t*)head, 5) == 5 && memcmp(head, "HTTP/", 5) == 0;
  }
  c.stop();
  return ok;
}

// 自分で再起動してよいか。**数え直しの窓（`SELF_RESTART_WINDOW_S`）を過ぎていたら白紙に戻す。**
// 時計が戻っていたとき（`now < firstUnix`）も白紙へ倒す——そのままだと窓が永久に閉じない。
static bool restartWindowExpired(time_t now){
  const RestartLedger &l = g_restartLedger;
  return l.count > 0
    && ((int64_t)now - l.firstUnix > SELF_RESTART_WINDOW_S || (int64_t)now < l.firstUnix);
}

static bool restartAllowed(time_t now){
  if (restartWindowExpired(now)) g_restartLedger.count = 0;
  return g_restartLedger.count < SELF_RESTART_MAX;
}

// 状態ページへ出す回数。**`restartAllowed` が見るのと同じ数を出す**（窓を過ぎていれば 0）。
// 帳面そのものは書き換えない。**時計が合う前は帳面の数をそのまま出す**——1970 年の
// 時刻で窓を測ると「時計が戻った」と読んで 0 を出してしまう。
static uint32_t selfRestartsInWindow(time_t now){
  if (now < MIN_SYNCED_UNIX) return g_restartLedger.count;
  return restartWindowExpired(now) ? 0 : g_restartLedger.count;
}

static const char* prevWhyName(uint8_t why){
  switch (why) {
    case PREV_WHY_HEARTBEAT: return "heartbeat";
    case PREV_WHY_CHANGE:    return "change";
    case PREV_WHY_RESTART:   return "restart";
    case PREV_WHY_OTA:       return "ota";
    default:                 return "unknown";
  }
}

// 前の起動の記録を読む（→ `PrevState`）。**`setup()` の最初の方で 1 度だけ呼ぶ。**
//
// **キーがあるかを先に訊く。** 無いキーの長さを訊くと、コアが初回の起動でエラーの行を
// ログへ出す（記録が無いのは正常なのに、異常に見える）。
static void prevLoad(){
  g_prefsOk = g_prefs.begin("seismo", false);
  if (!g_prefsOk) {
    Serial.println("# WARN NVS を開けなかった。直前の状態は残らない");
    return;
  }
  if (!g_prefs.isKey("prev")) return;
  // **大きさと版の両方が合ったときだけ信じる。** 大きさだけだと、欄の意味を変えた前の版の
  // 記録を読み違える（→ `PREV_STATE_VERSION`）。
  if (g_prefs.getBytesLength("prev") != sizeof(PrevState)) return;
  if (g_prefs.getBytes("prev", &g_prev, sizeof(g_prev)) != sizeof(g_prev)) return;
  g_prevValid = g_prev.version == PREV_STATE_VERSION;
}

// いまの様子を NVS へ書く。**成否に関わらず計時は進める** —— 書けない NVS へ毎周書きに
// 行くと、その間ずっと吸い出しを待たせる。
//
// **`why` を `PrevWhy` で受けない。** arduino-cli は `.ino` の関数の宣言を先頭へ自動で
// 足すが、その位置からは `PrevWhy` がまだ見えずコンパイルが落ちる（実際に落ちた）。
static void prevSave(uint32_t nowMs, uint8_t why){
  g_lastPrevSaveMs = nowMs;
  g_prevDirty = false;
  if (!g_prefsOk) return;
  const time_t now = time(nullptr);
  if (g_wifiUp) g_lastRssi = (int16_t)WiFi.RSSI();
  uint8_t sensorsOk = 0;
  for (size_t i = 0; i < SENSOR_N; i++) if (g_sensors[i].ok) sensorsOk++;

  PrevState &c = g_cur;
  c.version = PREV_STATE_VERSION;
  c.bootId = g_bootIdNum;
  // **合っていない時計の時刻は書かない。** 電源投入直後は 1970 年、ソフトウェアの再起動の
  // 直後は前の起動から持ち越したずれた時刻で（→ `clockTrusted`）、どちらも「いつ」の
  // 答えにならない。そのときは稼働秒数だけが手掛かりになる。
  c.savedUnix = clockTrusted(now) ? (uint32_t)now : 0;
  c.uptimeS = (nowMs - g_bootMs) / 1000;
  c.saves = g_prevSaves + 1;
  c.why = why;
  c.resetReason = (uint8_t)g_resetReason;
  c.bootedBySelfRestart = g_bootedBySelfRestart ? 1 : 0;
  c.wifiUp = g_wifiUp ? 1 : 0;
  c.ackLevel = g_ackLevel;
  c.sensorsOk = sensorsOk;
  c.rssi = g_lastRssi;
  c.wifiDownS = g_wifiUp ? 0 : (nowMs - g_wifiDownSinceMs) / 1000;
  c.wifiDowns = g_wifiDowns;
  c.ackAgeS = g_acks == 0 ? -1 : (int32_t)((nowMs - g_lastAckMs) / 1000);
  c.acks = g_acks;
  c.ackRearms = g_ackRearms;
  c.ackReconnects = g_ackReconnects;
  c.hostProbeFail = g_hostProbeFail;
  c.selfRestarts = selfRestartsInWindow(now);
  c.restartSkipped = g_restartSkipped;
  c.sntpSyncs = g_sntpSyncs;
  c.freeHeap = ESP.getFreeHeap();

  // **かかった時間を測る。** NVS がページを詰め直す回は消去が入り、その間は吸い出しが止まる
  // （待てるのは 1.4 秒まで。→ `HOST_PROBE_TIMEOUT_MS`）。
  const uint32_t t0 = millis();
  const size_t n = g_prefs.putBytes("prev", &c, sizeof(c));
  const uint32_t dt = millis() - t0;
  if (dt > g_prevSaveMaxMs) g_prevSaveMaxMs = dt;
  // 書けない状態は続きがちなので、**書けていた状態から書けなくなったときだけ**出す
  // （数は状態ページの `prev_save_fails`）。初回だけにすると、一度戻ってから再発したときに黙る。
  static bool lastFailed = false;
  if (n == sizeof(c)) {
    g_prevSaves++;
    lastFailed = false;
  } else {
    g_prevSaveFails++;
    if (!lastFailed) Serial.println("# WARN 直前の状態を NVS へ書けなかった");
    lastFailed = true;
  }
}

// 書く番か。**毎周呼ぶ**（`loop()`）。変わり目は間引いて書き（`PREV_MIN_GAP_MS`）、
// 変わらなくても `PREV_HEARTBEAT_MS` ごとに書く。
//
// 符号無しで引いてよいのは、`g_lastPrevSaveMs` を書くのが `prevSave` だけで、そこへ渡すのは
// 同じ周か過去の `millis()` だから。
static void prevPump(uint32_t nowMs){
  // この周がもう時間を使っていれば次の周へ回す（`PREV_DEFER_AFTER_MS`）。`nowMs` は周の頭で
  // 読んだ値なので、ここまでの所要時間になる。書く番は旗と計時のまま残るので、落としはしない。
  if (millis() - nowMs > PREV_DEFER_AFTER_MS) return;
  const uint32_t since = nowMs - g_lastPrevSaveMs;
  if (since >= PREV_HEARTBEAT_MS) {
    prevSave(nowMs, g_prevDirty ? PREV_WHY_CHANGE : PREV_WHY_HEARTBEAT);
  } else if (g_prevDirty && since >= PREV_MIN_GAP_MS) {
    prevSave(nowMs, PREV_WHY_CHANGE);
  }
}

// 返事が途絶えたら、段を 1 つ上げて立て直す。
//
// **これが段 A で残した穴を塞ぐ。** 段 A は「Wi-Fi が繋がり直したら UDP を開き直す」で、
// 繋がり直したことに気づけた場合しか効かない。気づけない形（ソケットだけが壊れる・
// 変わり目を取りこぼす）では、基板は自分の送信が届いていないことを知る手段を持たない。
// ホストの返事が、その唯一の手掛かり。
//
// 段は軽いものから：
//   0. UDP を作り直す（波形はほとんど止まらない）
//   1. Wi-Fi を繋ぎ直す（数秒止まる）
//   2. 再起動する（時計合わせからやり直すので十数秒止まる。回数に上限がある）
// 再起動を上限で飛ばしたら 0 へ戻って繰り返す。**返事が 1 つ届けば 0 へ戻る**（`readAcks`）。
//
// **この起動で返事を一度も受けていなければ段を上げない。** 返事を返さないホスト
// （返事の仕組みより古い版・`SEISMO_ACK=off` で起動したもの）へ繋いだ基板が、
// 立て直しを延々と繰り返さないため。**再起動の繰り返しもここで止まる**——再起動した先で
// 返事が戻らなければ、その起動では段を上げない。引き換えに、**起動した直後から送れて
// いない基板は自分では戻らない**（起動したばかりならソケットも新しいので、起きにくい形）。
static void checkAck(uint32_t nowMs){
  // Wi-Fi が切れている間は計らない。繋がり直せば `onWifiUp` が UDP を開き直す。
  if (!g_wifiUp) { g_ackWaiting = false; return; }
  // 符号無しで引いてよいのは、`g_ackWaitStartMs` を書く `sendChunk` が `loop()` でこれより
  // 後に走るから（同じ周の `nowMs` より新しい値と比べることが無い）。**呼び出し順を入れ替えたら
  // 見直すこと**（`spillPump` が同じ形で取り違えた）。
  if (!g_ackWaiting || nowMs - g_ackWaitStartMs < ACK_SILENCE_MS) return;
  // 次の計時は、次に送れた時点から。
  g_ackWaiting = false;

  if (g_acks == 0) {
    if (!g_warnedNoAck) {
      g_warnedNoAck = true;
      Serial.println("# ホストから返事が一度も来ていない。この起動では立て直しを行わない");
      Serial.println("#   （ホストが返事の仕組みより古いか、SEISMO_ACK=off で動いている）");
    }
    return;
  }

  // ここから先はどの道も残すべき変わり目（ホストが答えない・段が上がる）。
  g_prevDirty = true;
  if (!hostReachable()) {
    g_hostProbeFail++;
    Serial.printf("# 返事が %lu 秒途絶えたが、ホスト %s:%d も HTTP に答えない。止まっていると見て待つ\n",
                  (unsigned long)(ACK_SILENCE_MS / 1000), UDP_HOST, HOST_HTTP_PORT);
    return;
  }

  switch (g_ackLevel) {
    case 0:
      Serial.println("# 返事が途絶えた（ホストは生きている）。UDP を作り直す");
      g_ackRearms++;
      g_ackLevel = 1;
      armUdp();
      break;
    case 1:
      Serial.println("# 作り直しても返事が戻らない。Wi-Fi を繋ぎ直す");
      g_ackReconnects++;
      g_ackLevel = 2;
      // **変わり目は `loop()` が拾う**（切れて繋がれば `onWifiUp` が UDP を開き直す）。
      reconnectWifi();
      break;
    default: {
      const time_t now = time(nullptr);
      if (!restartAllowed(now)) {
        g_restartSkipped++;
        g_ackLevel = 0;
        Serial.printf("# 繋ぎ直しても返事が戻らない。再起動は上限（%lu 時間に %lu 回）に達したので飛ばす\n",
                      (unsigned long)(SELF_RESTART_WINDOW_S / 3600), (unsigned long)SELF_RESTART_MAX);
        break;
      }
      RestartLedger &l = g_restartLedger;
      if (l.count == 0) l.firstUnix = (int64_t)now;
      l.count++;
      l.pending = 1;
      Serial.printf("# 繋ぎ直しても返事が戻らない。再起動する（%lu 回目）\n", (unsigned long)l.count);
      // **落とす直前に書く。** 次の起動が電源投入で始まることもある（再起動へ向かう途中で
      // 電源を抜かれた等）ので、帳面（`RTC_NOINIT_ATTR`）だけに頼らない。
      prevSave(millis(), PREV_WHY_RESTART);
      delay(100);   // シリアルへ出し切る
      ESP.restart();
    }
  }
}

static void packetBegin(Packet &p, Sensor &s, int64_t tFirstMs){
  p.s = &s; p.n = 0; p.seq0 = s.seq; p.tFirstMs = tFirstMs;
}

// 溜まっている分を送って空にする。**0 件なら何もしない**ので、何度呼んでも構わない。
static void packetFlush(Packet &p){
  if (p.n == 0) return;
  sendChunk(*p.s, p.v, p.n, p.seq0, p.tFirstMs);
  // 次のパケットの先頭は、いま送った分だけ後ろへ進む。
  p.tFirstMs += (int64_t)p.n * 1000 / SAMPLE_HZ;
  p.seq0 = p.s->seq;
  p.n = 0;
}

static void packetAdd(Packet &p, int16_t x, int16_t y, int16_t z){
  p.v[p.n*3+0] = p.s->last[0] = x;
  p.v[p.n*3+1] = p.s->last[1] = y;
  p.v[p.n*3+2] = p.s->last[2] = z;
  p.n++; p.s->seq++;
  if (p.n == MAX_PER_PACKET) packetFlush(p);
}

// FIFO から `want` バイト読んで、6 バイトずつパケットへ積む。
//
// **I2C の失敗はここでは判定して返すだけ。** 何を捨てて何を数えるかは呼び出し側が
// 1 箇所で決める —— 枝ごとに書くと、必ずどれかを書き忘れる。
//
// **センサーはパケットから引く。** `Sensor&` も引数で受け取る形にすると、失敗を数える
// 相手（`note`）と値を積む相手（`packetAdd` の `p.s`）が食い違いうる——いまは
// 呼び出し方の約束でしか揃っていない。引数を 1 つにすれば食い違いようがない。
static bool readFifoInto(Packet &p, size_t want){
  Sensor &s = *p.s;
  s.wire->beginTransmission(s.addr); s.wire->write(R_FIFO_RW);
  if (s.wire->endTransmission(false) != 0) return note(s, false);
  if (s.wire->requestFrom(s.addr, (uint8_t)want) != want) return note(s, false);
  for (size_t i = 0; i < want; i += BPS) {
    // **1 つの式の中で Wire.read() を 2 回呼ばないこと。** `|` の左右の評価順は
    // C++ で規定されておらず、上位バイトと下位バイトが入れ替わりうる。
    const uint8_t xh=s.wire->read(), xl=s.wire->read();
    const uint8_t yh=s.wire->read(), yl=s.wire->read();
    const uint8_t zh=s.wire->read(), zl=s.wire->read();
    packetAdd(p, (int16_t)(((uint16_t)xh<<8)|xl),
                 (int16_t)(((uint16_t)yh<<8)|yl),
                 (int16_t)(((uint16_t)zh<<8)|zl));
  }
  return note(s, true);
}

static void drainSensor(Sensor &s){
  if (!s.ok) return;

  uint8_t st = 0;
  if (!r8(s, R_INT_STATUS, st)) return;   // 失敗は note() が数えている
  if (st & 0x10) {
    // FIFO があふれた＝サンプルを落とし、6 バイト境界も合わなくなっている。
    // 黙って続けると軸が入れ替わるので必ず作り直す。
    dropFifo(s);
    Serial.printf("# OVERFLOW %s n=%lu\n", s.sid, (unsigned long)s.overflow);
    return;
  }
  uint16_t cnt = 0;
  if (!readFifoCount(s, cnt)) return;
  // **まだ 1 サンプルも溜まっていない状態は、端数とは別の事象。** 下の判定より前に
  // 抜けること——ここを通すと、作り直した直後の空の FIFO が「端数を見た」として
  // 数えられ、2 つの原因を分けるための内訳（`remHist`）が汚れる。
  if (cnt < BPS) return;

  // **端数を見たら、その周期は読まない。1 周期置いて数え直す。**
  //
  // 件数が 6 の倍数でないのは、たいてい 1 サンプル分の 6 バイトが**いま書かれている
  // 最中**だから（`struct Sensor` の `partial` の項を参照）。FIFO ごと捨てる必要は
  // 無い——捨てればそのたびに受け手の区間が切れて、計測震度のフィルタが振り出しに戻る。
  //
  // **ただし「書き込み途中」と「本当に 1 バイト失われた」は、その場では見分けられない。**
  // 見分けるのは続き方のほうで、前者は 1 周期で消え、後者は作り直すまで残る。
  //
  // **だから端数を切り捨てて読み進めない。** 読めば、取り違えていた場合に軸がずれた
  // 30 サンプルが**何の印も付かずに**流れる——受け手が切れ目を知る手段は `o` の変化
  // だけで、ここでは `o` を進めないのだから、あとから遡って無効にすることもできない。
  // 1 周期待てば答えが出る。**待つ間サンプルは FIFO に残るので、失われもしない**
  // （溜まるのは 60 サンプルで、FIFO の 170 サンプル分にはまだ遠い）。
  const uint8_t rem = (uint8_t)(cnt % BPS);
  if (rem != 0) {
    notePartial(s, rem);
    if (++s.partialStreak >= PARTIAL_STREAK_TO_DROP) {
      // 続いた＝書き込み途中では説明が付かない。境界が崩れているほうを疑う。
      //
      // **あふれと同じくシリアルへも出す。** これは「軸がずれているかもしれない」と
      // いう、あふれより重い報せなのに、状態ページを能動的に見に行かないと気づけない
      // 形にはできない。頻度は 2 周期に 1 回が上限なので、記録は埋まらない。
      s.realign++; s.realignStreak++;
      dropFifo(s);
      Serial.printf("# REALIGN %s n=%lu streak=%lu\n",
                    s.sid, (unsigned long)s.realign, (unsigned long)s.realignStreak);
      return;
    }
    // **端数の「値」が前回と同じかは見ない。** 同じ値が続くことを条件にすると、値が
    // 入れ替わりながら端数が出続ける形で連続が永久に成立せず、**読むことも作り直す
    // こともないまま黙って止まる**。偽の作り直しを減らすより、必ず決着することを採る。
    return;
  }
  // **端数が無かった＝いま境界は無事。** 2 つの連続をここで切る。
  s.partialStreak = 0;
  s.realignStreak = 0;

  // 抜き出した時点を基準に、先頭サンプルの時刻を逆算する。サンプル「間隔」は
  // FIFO が保証しているので、不確かなのは絶対位置だけ。
  //
  // **最新のサンプルは「たった今」ではない。** FIFO の中の最新サンプルは、前回の
  // サンプリングの瞬間から今までのどこかで採られている——一様に見れば平均して
  // 半サンプル分だけ前。引かないと、名乗る時刻が系統的に半サンプル分だけ遅れる。
  struct timeval tv; gettimeofday(&tv, nullptr);
  const int64_t nowMs = (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
  //
  // **ここへ来るのは端数が無かった周期だけ**なので、補正は常に半サンプル。端数がある
  // 周期は上で抜けており、「いま書かれている最中のサンプル」を抱えたまま読むことは無い。
  const uint16_t total = cnt / BPS;
  const int64_t tFirstMs = nowMs - (int64_t)((total - 1) * 1000 / SAMPLE_HZ) - (500 / SAMPLE_HZ);

  // **センサーをまたいで共有される。** `loop()` が 3 個を順に、しかも `sendChunk` が
  // 送り終えてから戻る形で回しているので競合しない（`packetBegin` が毎回すべての
  // 欄を入れ直すので、前のセンサーの状態も残らない）。**非同期にするならここを見直す。**
  static Packet p;
  packetBegin(p, s, tFirstMs);

  bool aborted = false;
  uint16_t remain = cnt;
  while (remain >= BPS) {
    size_t want = remain > I2C_CHUNK ? I2C_CHUNK : remain;
    want -= want % BPS;
    if (!readFifoInto(p, want)) { aborted = true; break; }
    remain -= want;
  }

  // **出口はここだけ。** 読めた分は必ず送り、そのうえで諦めたぶんを捨てて数える。
  // 早期 return を残すと、また「読めていたのに送らずに捨てる」経路ができる。
  packetFlush(p);
  if (aborted) dropFifo(s);
}

// 続けて失敗しているセンサーの `ok` を下ろす。**下ろすのは見捨てるためではなく、
// 初期化をやり直す機会を作るため。** 下ろさないと `drainSensor` が失敗し続ける
// だけで、設定が飛んだセンサーは電源を入れ直すまで戻らない。
static void demoteStuck(){
  for (size_t i = 0; i < SENSOR_N; i++) {
    Sensor &s = g_sensors[i];
    if (!s.ok) continue;
    if (s.failStreak >= FAIL_STREAK_TO_DEMOTE) {
      s.ok = false;
      Serial.printf("# sensor %s を降格（連続 %lu 回失敗）\n", s.sid, (unsigned long)s.failStreak);
    } else if (s.realignStreak >= REALIGN_STREAK_TO_DEMOTE) {
      // **I2C は成功しているので `failStreak` には 1 つも積まれない。** この経路を
      // 足さないと、境界が崩れ続けるセンサーだけが降格も再初期化も受けられない。
      s.ok = false;
      Serial.printf("# sensor %s を降格（FIFO を連続 %lu 回作り直しても端数が残る）\n",
                    s.sid, (unsigned long)s.realignStreak);
    }
  }
}

// `ok` が下りているセンサーの初期化をやり直す。
//
// **1 周期に 1 個だけ。** `sensorInit` は 150ms の待ちを含むので、3 個まとめて試すと
// そのあいだ OTA も状態ページも応答しない。順繰りに当てれば、3 個死んでいても
// 1 個あたり 30 秒で必ず番が回る。
static void retryStuck(){
  static size_t next = 0;
  for (size_t k = 0; k < SENSOR_N; k++) {
    Sensor &s = g_sensors[next];
    next = (next + 1) % SENSOR_N;
    if (s.ok) continue;
    sensorInit(s);
    if (s.ok) {
      armSensor(s);
      // **落ちていたあいだに失われたサンプルを、受け手へ必ず伝える。**
      // 降格は 20 回連続の失敗（約 6 秒）で起きるのに FIFO は 1.7 秒ぶんしか持たない
      // ので、**黙っていた時間のあいだサンプルは確実に失われている**。ところが読めて
      // いない間は `q`（通し番号）も進まないため、受け手から見ると切れ目が無い ——
      // `o` を進めることだけが、この空白を伝える手段。
      //
      // **`drainSensor` の側では上がらない。** 読み取り自体に失敗している間は FIFO の
      // あふれビットを一度も観測できないので、実際にあふれていても記録に残らない。
      s.overflow++;
      s.failStreak = 0;
      s.realignStreak = 0;
      Serial.printf("# sensor %s 復帰（%lu 回目の初期化・o=%lu）\n",
                    s.sid, (unsigned long)s.initTries, (unsigned long)s.overflow);
    }
    return;   // 1 周期に 1 個
  }
}

void loop(){
  // **繋がり具合の変わり目を先に見る。** 繋がった瞬間に SNTP と UDP を立て直す
  // （理由は `onWifiUp`）。**ここを `WiFi.status()` の直読みで済ませられない** ——
  // 「いま繋がっている」は読めても「たったいま繋がった」は読めないので、
  // 立て直す契機が作れない。
  // **イベントは「いま持っている見立てを捨てる」ことにだけ使う。** 旗が立っていれば
  // 繋がっていないことにして、下の判定へ立て直しを任せる——立て直す場所を
  // 1 つに保てる（イベント側にも書くと、2 箇所が同じ持ち物を別の流れから触る）。
  if (g_wifiGotIp) {
    g_wifiGotIp = false;
    g_wifiUp = false;
  }
  const bool up = WiFi.status() == WL_CONNECTED;
  if (up != g_wifiUp) {
    g_wifiUp = up;
    if (up) {
      onWifiUp();
    } else {
      Serial.println("# wifi down");
      g_wifiDowns++;
      g_wifiDownSinceMs = millis();
    }
    g_prevDirty = true;
  }

  // **立てる前に回さない。** `begin()` を通っていない口を叩くのは、たとえ無害でも
  // 「立っているかどうか」を 2 箇所で仮定することになる。
  if (g_servicesUp) {
    ArduinoOTA.handle();
    http.handleClient();
  }

  const uint32_t nowMs = millis();

  // 一度も繋がらないままの基板を黙らせない（理由は `NO_WIFI_WARN_MS`）。
  static bool warnedNoWifi = false;
  if (!warnedNoWifi && !g_servicesUp && (nowMs - g_bootMs) > NO_WIFI_WARN_MS) {
    warnedNoWifi = true;
    Serial.println("# wifi に一度も繋がれていない。SSID とパスワード、AP の生死を疑う");
    Serial.println("#   （シリアルでは動き続ける。状態ページも OTA も立っていない）");
  }

  // **返事は毎周読む。** 吸い出しの周期（0.3 秒）に合わせると、読むまでの間に
  // 返事が溜まるだけで得が無い。
  retryUdpOpen(nowMs);
  readAcks();
  checkAck(nowMs);
  // 返事の途絶を見てフラッシュへ書き出す（→ `spillPump`）。**毎周呼ぶ** —— 1 周に書く区画は
  // 1 つまでなので、吸い出しの周期に合わせると書き出しが追いつかない。
  spillPump(nowMs);
  prevPump(nowMs);

  static uint32_t lastRetry = 0;
  if (nowMs - lastRetry >= RETRY_MS) { lastRetry = nowMs; retryStuck(); }

  static uint32_t last = 0;
  if (nowMs - last < DRAIN_MS) return;
  last = nowMs;
  for (size_t i = 0; i < SENSOR_N; i++) drainSensor(g_sensors[i]);
  demoteStuck();
}
