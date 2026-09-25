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
#include "wifi_config.h"

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
// Wi-Fi の接続待ちは最大 30 秒あり、そのあいだ FIFO を吸い出せない。FIFO は
// 1.7 秒ぶんしか無いので必ずあふれている。ここで作り直さないと、起動直後の
// 1 回は必ず OVERFLOW として数えられる。
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

static void handleStatus(){
  time_t now = time(nullptr);
  char buf[2048];
  size_t u = 0;
  appendf(buf, sizeof(buf), u,
    "{\"node\":\"%s\",\"mac\":\"%s\",\"boot_id\":\"%s\",\"sensor\":\"MPU6050\","
    "\"uptime_s\":%lu,\"rssi\":%d,\"ip\":\"%s\",\"time_synced\":%s,\"unix\":%ld,"
    "\"sample_hz\":%d,\"ug_per_lsb\":%.4f,\"head_truncated\":%lu,",
    g_node, g_mac, g_bootId,
    (unsigned long)((millis()-g_bootMs)/1000), WiFi.RSSI(), WiFi.localIP().toString().c_str(),
    now > 1700000000 ? "true":"false", (long)now,
    SAMPLE_HZ, UG_PER_LSB, (unsigned long)g_headTrunc);
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
      "\"init_tries\":%lu,\"init_fails\":%u,\"rem_hist\":[",
      i == 0 ? "" : ",", s.sid, s.ok ? "true":"false", s.who,
      (unsigned long)s.seq, (unsigned long)s.sent, (unsigned long)s.overflow,
      (unsigned long)s.i2cFail, (unsigned long)s.failStreak,
      (unsigned long)s.partial, (unsigned long)s.partialStreak,
      (unsigned long)s.realign, (unsigned long)s.realignStreak,
      (unsigned long)s.unsent,
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

void setup(){
  Serial.begin(115200);
  delay(300);
  g_bootMs = millis();
  resolveNodeName();

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
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  // **起動 ID は Wi-Fi を起こしてから採る。** `esp_random()` が真の乱数を返すのは
  // RF が動いているときだけで、それより前だと擬似乱数になる。衝突すると受け手は
  // 再起動をパケットの並び替えと読み、通し番号の戻りを繋いでしまう。
  snprintf(g_bootId, sizeof(g_bootId), "%08x", (unsigned)esp_random());

  Serial.printf("\n# %s (%s) booting bid=%s\n", g_node, g_mac, g_bootId);
  for (int b = 0; b < 2; b++) {
    Serial.printf("# i2c%d begun=%d scan: %u found (%s)%s\n",
                  b, g_busOk[b], (unsigned)g_scanN[b], g_scan[b], g_scanCut[b] ? " …切れ" : "");
  }
  for (size_t i = 0; i < SENSOR_N; i++) {
    const Sensor &s = g_sensors[i];
    Serial.printf("# sensor %s ok=%d who=0x%02X initFails=%u\n",
                  s.sid, s.ok, s.who, (unsigned)s.initFails);
  }

  for (int i = 0; i < 60 && WiFi.status() != WL_CONNECTED; i++) { delay(500); Serial.print('.'); }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("# wifi ok ip=%s rssi=%d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    configTime(0, 0, "ntp.nict.jp", "pool.ntp.org");   // UTC で持つ。表示側で直す
    if (MDNS.begin(g_node)) Serial.printf("# mdns %s.local\n", g_node);
    ArduinoOTA.setHostname(g_node);
    ArduinoOTA.begin();
    http.on("/", handleStatus);
    http.begin();
    udp.begin(0);
  } else {
    Serial.println("# wifi FAILED (シリアルでは動き続ける)");
  }
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
static void sendChunk(Sensor &s, const int16_t *v, size_t n, uint32_t seq0, int64_t tFirstMs){
  if (WiFi.status() != WL_CONNECTED) { s.unsent += n; return; }
  char head[320];
  const int hl = snprintf(head, sizeof(head),
    "{\"v\":2,\"mac\":\"%s\",\"bid\":\"%s\",\"sid\":\"%s\",\"st\":\"MPU6050\","
    "\"ch\":[\"HN1\",\"HN2\",\"HN3\"],\"ug\":%.4f,\"fs\":%d,\"hz\":%d,"
    "\"t\":%lld,\"q\":%lu,\"c\":%u,\"o\":%lu}\n",
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
  if (udp.endPacket()) s.sent++; else s.unsent += n;
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
  ArduinoOTA.handle();
  http.handleClient();

  const uint32_t nowMs = millis();

  static uint32_t lastRetry = 0;
  if (nowMs - lastRetry >= RETRY_MS) { lastRetry = nowMs; retryStuck(); }

  static uint32_t last = 0;
  if (nowMs - last < DRAIN_MS) return;
  last = nowMs;
  for (size_t i = 0; i < SENSOR_N; i++) drainSensor(g_sensors[i]);
  demoteStuck();
}
