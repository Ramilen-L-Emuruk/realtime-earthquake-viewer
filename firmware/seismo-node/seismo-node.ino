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
static uint32_t   g_ackForeign = 0;      // 同じソケットへ届いた、自分宛ての返事ではないもの
// 返事を待っているか、と待ち始めた時刻。**返事のあとで最初に送れた時点から計る**
// （→ `ACK_SILENCE_MS`）。
static bool       g_ackWaiting = false;
static uint32_t   g_ackWaitStartMs = 0;
// 次に打つ手。0: UDP を作り直す／1: Wi-Fi を繋ぎ直す／2: 再起動。**返事が 1 つ届けば 0 へ戻る。**
// Wi-Fi が繋がり直しても戻さない——戻すと繋ぎ直しのたびに 0 からやり直し、再起動の段へ届かない。
static uint8_t    g_ackLevel = 0;
static uint32_t   g_ackRearms = 0;       // 返事の途絶で UDP を作り直した回数
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

// 状態ページ。
//
// **バッファの余裕を測ってある。** すべての勘定を 32bit の上限（4294967295）へ置き、
// ノード名と走査結果も最長にした最悪形で **約 2000 バイト**（2026-10-01 に実測。
// 実際の応答は約 1300 バイト）。返事と立て直しの欄（段 B）で最悪形が **約 300 バイト**
// 増えて約 2300 バイト、SNTP の欄（`sntp_syncs`・`sntp_last_sync_unix`）で **約 60 バイト**
// 増えて約 2360 バイト（2026-10-02 の実際の応答は約 1600 バイト）。**2048 では 50 バイトしか残らなかった** ——
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
  static char buf[3072];
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
  ArduinoOTA.begin();
  http.on("/", handleStatus);
  http.on("/restart", HTTP_POST, handleRestart);
  http.on("/wifi-reconnect", HTTP_POST, handleWifiReconnect);
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

  Serial.printf("\n# %s (%s) booting bid=%s reset=%s%s self_restarts=%lu\n",
                g_node, g_mac, g_bootId, resetReasonName(g_resetReason),
                g_bootedBySelfRestart ? "（返事の途絶で自分から）" : "",
                (unsigned long)g_restartLedger.count);
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
static void sendChunk(Sensor &s, const int16_t *v, size_t n, uint32_t seq0, int64_t tFirstMs){
  if (WiFi.status() != WL_CONNECTED) { s.unsent += n; return; }
  const time_t nowSec = time(nullptr);
  if (!clockTrusted(nowSec)) { s.pretime += n; return; }
  if (!g_timeReady) {
    g_timeReady = true;
    Serial.printf("# 時計が合った（unix=%ld）。ここから送り始める\n", (long)nowSec);
  }
  char head[320];
  const int hl = snprintf(head, sizeof(head),
    "{\"v\":2,\"mac\":\"%s\",\"bid\":\"%s\",\"sid\":\"%s\",\"st\":\"MPU6050\","
    "\"ch\":[\"HN1\",\"HN2\",\"HN3\"],\"ug\":%.4f,\"fs\":%d,\"hz\":%d,"
    // `"ack":1` は「届いたら返事をくれ」。ホストは求めた基板にだけ返す（→ `checkAck`）。
    "\"t\":%lld,\"q\":%lu,\"c\":%u,\"o\":%lu,\"ack\":1}\n",
    g_macFlat, g_bootId, s.sid, UG_PER_LSB, 2 << AFS_SEL, SAMPLE_HZ,
    (long long)tFirstMs, (unsigned long)seq0, (unsigned)n, (unsigned long)s.overflow);
  // 切り詰められた JSON を送らない。受け手には「先頭行が読めない」としか見えず、
  // 別のプログラムが同じ口へ投げている疑いの件数に混ざる。
  if (hl <= 0 || (size_t)hl >= sizeof(head)) { g_headTrunc++; s.unsent += n; return; }
  udp.beginPacket(UDP_HOST, UDP_PORT);
  udp.write((const uint8_t*)head, hl);
  for (size_t i = 0; i < n; i++) {
    char line[32];
    const int ll = snprintf(line, sizeof(line), "%d,%d,%d\n", v[i*3], v[i*3+1], v[i*3+2]);
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
// 1 周に読むのは 4 つまで。返事は 1 秒に 1 つなので、溜まっていても次の周で読める。
static void readAcks(){
  // Wi-Fi が切れている間は読まない（`retryUdpOpen`・`checkAck` と同じ門）。切れても記述子は
  // 有効なままなので読んで害は無いが、届くはずの無いものを読みに行く理由も無い。
  if (!g_wifiUp || !g_udpOpen) return;
  char want[32];
  const int wl = snprintf(want, sizeof(want), "seismo-ack %s\n", g_macFlat);
  for (int i = 0; i < 4; i++) {
    if (udp.parsePacket() <= 0) return;
    char got[40];
    const int n = udp.read(got, sizeof(got) - 1);
    udp.clear();
    got[n > 0 ? n : 0] = '\0';
    if (wl > 0 && n == wl && memcmp(got, want, (size_t)wl) == 0) {
      g_acks++;
      g_lastAckMs = millis();
      g_ackWaiting = false;
      if (g_ackLevel != 0) {
        Serial.printf("# ホストの返事が戻った（段 %u まで上がっていた）\n", (unsigned)g_ackLevel);
        g_ackLevel = 0;
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
    if (up) onWifiUp();
    else Serial.println("# wifi down");
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

  static uint32_t lastRetry = 0;
  if (nowMs - lastRetry >= RETRY_MS) { lastRetry = nowMs; retryStuck(); }

  static uint32_t last = 0;
  if (nowMs - last < DRAIN_MS) return;
  last = nowMs;
  for (size_t i = 0; i < SENSOR_N; i++) drainSensor(g_sensors[i]);
  demoteStuck();
}
