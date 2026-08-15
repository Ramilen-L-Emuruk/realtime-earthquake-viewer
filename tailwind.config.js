/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      // レイアウト分岐用のカスタムブレークポイント。既定の sm/md/lg/xl/2xl はそのまま残る。
      // 幅だけで分岐するとスマホ横画面（例 844x390）が「幅は足りないが高さが極端に低い」
      // 状態になり、縦積みのままではパネルが画面高を食い尽くして地図が消える。
      // そのため向き・高さも判定に含める。
      screens: {
        // side: 地図とパネルを左右に並べる条件。
        //   ・幅 1024px 以上（従来の lg 相当。PC・タブレット横）
        //   ・または 横向きかつ高さ 600px 以下（スマホ横・小型タブレット横）
        // これ未満は縦積み（地図が上・パネルが下）で、パネル高さは --panel-ratio で可変。
        side: { raw: '(min-width: 1024px), (orientation: landscape) and (max-height: 600px)' },
        // sideNarrow: 左右分割のうち幅が狭い側（スマホ横など）。パネル幅を狭くして地図を優先する。
        // Tailwind は screens の定義順にユーティリティを出力するため、side より後に置いて
        // side: の指定を上書きできるようにしている（順序を入れ替えると効かなくなる）。
        sideNarrow: { raw: '(orientation: landscape) and (max-height: 600px) and (max-width: 1023px)' },
        // roomy: カード内の文字・余白をゆったり表示できる条件（幅と高さの両方に余裕がある）。
        // これ未満（＝スマホ縦・スマホ横）では圧縮表示にして、各地の震度や警報対象地域が
        // スクロールせずに見えるようにする。モバイルファーストで書くため「既定=圧縮 /
        // roomy:=従来サイズ」の向きで指定する。
        roomy: { raw: '(min-width: 640px) and (min-height: 601px)' },
      },
      colors: {
        app: '#0a0c10',
        panel: '#12151a',
        card: '#1a1d26',
        border: '#2a2d38',
        secondary: '#94a3b8',
      },
      animation: {
        'slide-down': 'slideDown 0.3s ease-out',
        'fade-in': 'fadeIn 0.2s ease-out',
      },
      keyframes: {
        slideDown: {
          from: { transform: 'translateY(-100%)' },
          to: { transform: 'translateY(0)' },
        },
        fadeIn: {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
}
