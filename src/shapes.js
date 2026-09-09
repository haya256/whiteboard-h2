'use strict';

// 図形カタログ。
// 図形は「幅 w・高さ h（ノードの外接矩形）から <path> の d を組み立てる関数」として、すべてここに定義する。
// 描画（src/view.js）・リサイズ・パレットのサムネイル（src/app.js）・.svg 書き出し（src/io.js は View の
// 生成関数を再利用）・変換スクリプト（scripts/board-from-spec.js）が、すべてこの Shapes.pathD() を通る。
// 図形を増やすときは CATALOG に1件足すだけでよい。
//
// 内部の線（本の背表紙・円筒の口・定義済み処理の縦線）は、「行って戻る」閉じたサブパスとして書く。
// 面積がゼロなので塗りには影響せず、stroke だけが線として見える（要素は1つの <path> のまま）。
const Shapes = (() => {

  function r(v) { return Math.round(v * 100) / 100; }

  // 多角形（頂点の配列 → 閉じたパス）
  function poly(pts) {
    return 'M' + pts.map(p => r(p[0]) + ',' + r(p[1])).join(' L') + ' Z';
  }

  // 内部の線（行って戻る＝面積ゼロ。塗られず、stroke だけが見える）
  function line(x1, y1, x2, y2) {
    return `M${r(x1)},${r(y1)} L${r(x2)},${r(y2)} L${r(x1)},${r(y1)} Z`;
  }

  // 内部の円弧（同上。sweep を反転して同じ弧を戻る）
  function arcLine(x1, y1, x2, y2, rx, ry) {
    return `M${r(x1)},${r(y1)} A${r(rx)},${r(ry)} 0 0 0 ${r(x2)},${r(y2)} A${r(rx)},${r(ry)} 0 0 1 ${r(x1)},${r(y1)} Z`;
  }

  function roundRect(w, h, rad) {
    const a = r(Math.min(rad, w / 2, h / 2));
    return `M${a},0 H${r(w - a)} A${a},${a} 0 0 1 ${r(w)},${a} V${r(h - a)} A${a},${a} 0 0 1 ${r(w - a)},${r(h)} `
         + `H${a} A${a},${a} 0 0 1 0,${r(h - a)} V${a} A${a},${a} 0 0 1 ${a},0 Z`;
  }

  function ellipse(cx, cy, rx, ry) {
    return `M${r(cx - rx)},${r(cy)} A${r(rx)},${r(ry)} 0 1 0 ${r(cx + rx)},${r(cy)} `
         + `A${r(rx)},${r(ry)} 0 1 0 ${r(cx - rx)},${r(cy)} Z`;
  }

  // 正 n 角形（inner を与えると星形）。外接矩形いっぱいに広がるよう正規化する
  function star(n, w, h, inner) {
    const raw = [];
    const count = inner ? n * 2 : n;
    for (let i = 0; i < count; i++) {
      const rad = (-90 + (360 / count) * i) * Math.PI / 180;
      const len = inner && i % 2 ? inner : 1;
      raw.push([Math.cos(rad) * len, Math.sin(rad) * len]);
    }
    const xs = raw.map(p => p[0]), ys = raw.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const y0 = Math.min(...ys), y1 = Math.max(...ys);
    return poly(raw.map(p => [(p[0] - x0) / (x1 - x0) * w, (p[1] - y0) / (y1 - y0) * h]));
  }

  // ---- カタログ ----
  // id      : node.shape に保存される値。既存ボードとの互換のため rect / ellipse / diamond は変えない
  // label   : パレットに出す名前
  // category: CATEGORIES のキー
  // d       : (w, h) => path の d
  // size    : 既定の追加サイズ（省略時は 160×120）
  // pad     : 文字を置く領域の内側余白 [上, 右, 下, 左]（w・h に対する割合。省略時は全面＝従来どおり）
  const CATALOG = [
    // ---- 基本 ----
    { id: 'rect', label: '矩形', category: 'basic', d: (w, h) => roundRect(w, h, 8) },
    { id: 'round-rect', label: '角丸矩形', category: 'basic', d: (w, h) => roundRect(w, h, Math.min(w, h) * 0.22) },
    { id: 'ellipse', label: '楕円', category: 'basic', d: (w, h) => ellipse(w / 2, h / 2, w / 2, h / 2) },
    { id: 'diamond', label: 'ひし形', category: 'basic', d: (w, h) => poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]) },
    { id: 'triangle', label: '三角形', category: 'basic', pad: [0.35, 0.14, 0.04, 0.14],
      d: (w, h) => poly([[w / 2, 0], [w, h], [0, h]]) },
    { id: 'triangle-down', label: '逆三角形', category: 'basic', pad: [0.04, 0.14, 0.35, 0.14],
      d: (w, h) => poly([[0, 0], [w, 0], [w / 2, h]]) },
    { id: 'trapezoid', label: '台形', category: 'basic', pad: [0.05, 0.22, 0.05, 0.22],
      d: (w, h) => poly([[w * 0.22, 0], [w * 0.78, 0], [w, h], [0, h]]) },
    { id: 'parallelogram', label: '平行四辺形', category: 'basic', pad: [0.05, 0.25, 0.05, 0.25],
      d: (w, h) => poly([[w * 0.25, 0], [w, 0], [w * 0.75, h], [0, h]]) },
    { id: 'pentagon', label: '五角形', category: 'basic', pad: [0.18, 0.1, 0.05, 0.1],
      d: (w, h) => star(5, w, h) },
    { id: 'hexagon', label: '六角形', category: 'basic', pad: [0.05, 0.2, 0.05, 0.2],
      d: (w, h) => poly([[w * 0.25, 0], [w * 0.75, 0], [w, h / 2], [w * 0.75, h], [w * 0.25, h], [0, h / 2]]) },
    { id: 'octagon', label: '八角形', category: 'basic', pad: [0.08, 0.08, 0.08, 0.08],
      d: (w, h) => poly([[w * 0.29, 0], [w * 0.71, 0], [w, h * 0.29], [w, h * 0.71],
                         [w * 0.71, h], [w * 0.29, h], [0, h * 0.71], [0, h * 0.29]]) },
    { id: 'cross', label: '十字', category: 'basic', pad: [0.3, 0.3, 0.3, 0.3],
      d: (w, h) => poly([[w * 0.34, 0], [w * 0.66, 0], [w * 0.66, h * 0.34], [w, h * 0.34],
                         [w, h * 0.66], [w * 0.66, h * 0.66], [w * 0.66, h], [w * 0.34, h],
                         [w * 0.34, h * 0.66], [0, h * 0.66], [0, h * 0.34], [w * 0.34, h * 0.34]]) },
    { id: 'star', label: '星', category: 'basic', size: { w: 140, h: 140 }, pad: [0.3, 0.24, 0.18, 0.24],
      d: (w, h) => star(5, w, h, 0.382) },

    // ---- フローチャート ----
    // 「処理」＝矩形、「判断」＝ひし形は基本と同じ形なので重複させない
    { id: 'terminator', label: '端子', category: 'flow', pad: [0.05, 0.16, 0.05, 0.16],
      d: (w, h) => roundRect(w, h, h / 2) },
    { id: 'predefined-process', label: '定義済み処理', category: 'flow', pad: [0.05, 0.16, 0.05, 0.16],
      d: (w, h) => roundRect(w, h, 4) + ' ' + line(w * 0.12, 0, w * 0.12, h) + ' ' + line(w * 0.88, 0, w * 0.88, h) },
    { id: 'document', label: '書類', category: 'flow', pad: [0.04, 0.06, 0.2, 0.06],
      d: (w, h) => `M0,0 H${r(w)} V${r(h * 0.82)} C${r(w * 0.75)},${r(h * 1.02)} ${r(w * 0.25)},${r(h * 0.62)} 0,${r(h * 0.82)} Z` },
    { id: 'cylinder', label: '円筒', category: 'flow', pad: [0.22, 0.08, 0.1, 0.08],
      d: (w, h) => {
        const ry = Math.min(h * 0.16, w * 0.3);
        return `M0,${r(ry)} A${r(w / 2)},${r(ry)} 0 0 1 ${r(w)},${r(ry)} V${r(h - ry)} `
             + `A${r(w / 2)},${r(ry)} 0 0 1 0,${r(h - ry)} Z ` + arcLine(0, ry, w, ry, w / 2, ry);
      } },
    { id: 'display', label: '表示', category: 'flow', pad: [0.05, 0.16, 0.05, 0.16],
      d: (w, h) => `M${r(w * 0.16)},0 H${r(w * 0.82)} A${r(w * 0.2)},${r(h / 2)} 0 0 1 ${r(w * 0.82)},${r(h)} `
                 + `H${r(w * 0.16)} L0,${r(h / 2)} Z` },
    { id: 'manual-input', label: '手操作入力', category: 'flow', pad: [0.2, 0.08, 0.05, 0.08],
      d: (w, h) => poly([[0, h * 0.22], [w, 0], [w, h], [0, h]]) },
    { id: 'connector', label: '結合子', category: 'flow', size: { w: 100, h: 100 },
      d: (w, h) => ellipse(w / 2, h / 2, w / 2, h / 2) },

    // ---- 矢印・吹き出し ----
    { id: 'arrow-right', label: '右矢印', category: 'arrow', pad: [0.32, 0.4, 0.32, 0.05],
      d: (w, h) => poly([[0, h * 0.3], [w * 0.65, h * 0.3], [w * 0.65, 0], [w, h / 2],
                         [w * 0.65, h], [w * 0.65, h * 0.7], [0, h * 0.7]]) },
    { id: 'arrow-lr', label: '左右矢印', category: 'arrow', pad: [0.32, 0.28, 0.32, 0.28],
      d: (w, h) => poly([[0, h / 2], [w * 0.25, 0], [w * 0.25, h * 0.3], [w * 0.75, h * 0.3],
                         [w * 0.75, 0], [w, h / 2], [w * 0.75, h], [w * 0.75, h * 0.7],
                         [w * 0.25, h * 0.7], [w * 0.25, h]]) },
    { id: 'chevron', label: 'シェブロン', category: 'arrow', pad: [0.05, 0.2, 0.05, 0.22],
      d: (w, h) => poly([[0, 0], [w * 0.75, 0], [w, h / 2], [w * 0.75, h], [0, h], [w * 0.25, h / 2]]) },
    { id: 'callout', label: '吹き出し', category: 'arrow', pad: [0.05, 0.08, 0.3, 0.08],
      d: (w, h) => {
        const b = h * 0.76, a = Math.min(10, w / 4, b / 2);
        return `M${r(a)},0 H${r(w - a)} A${r(a)},${r(a)} 0 0 1 ${r(w)},${r(a)} V${r(b - a)} `
             + `A${r(a)},${r(a)} 0 0 1 ${r(w - a)},${r(b)} H${r(w * 0.44)} L${r(w * 0.28)},${r(h)} `
             + `L${r(w * 0.3)},${r(b)} H${r(a)} A${r(a)},${r(a)} 0 0 1 0,${r(b - a)} V${r(a)} `
             + `A${r(a)},${r(a)} 0 0 1 ${r(a)},0 Z`;
      } },
    { id: 'cloud', label: '雲', category: 'arrow', pad: [0.3, 0.16, 0.14, 0.16],
      d: (w, h) => `M${r(w * 0.26)},${r(h)} C${r(w * 0.1)},${r(h)} ${r(w * 0.03)},${r(h * 0.76)} ${r(w * 0.15)},${r(h * 0.6)} `
                 + `C${r(w * 0.06)},${r(h * 0.4)} ${r(w * 0.2)},${r(h * 0.22)} ${r(w * 0.35)},${r(h * 0.28)} `
                 + `C${r(w * 0.42)},${r(h * 0.06)} ${r(w * 0.7)},${r(h * 0.06)} ${r(w * 0.73)},${r(h * 0.28)} `
                 + `C${r(w * 0.92)},${r(h * 0.26)} ${r(w)},${r(h * 0.46)} ${r(w * 0.89)},${r(h * 0.62)} `
                 + `C${r(w)},${r(h * 0.82)} ${r(w * 0.9)},${r(h)} ${r(w * 0.74)},${r(h)} Z` },

    // ---- アイコン ----
    // 胴体の頂点は頭の真下（接する位置）まで伸ばす。重ねると evenodd で塗りが欠けるので、接するまでに留める
    { id: 'person', label: '人', category: 'icon', size: { w: 120, h: 120 },
      d: (w, h) => {
        const rad = Math.min(w, h) * 0.17;
        const cy = h * 0.2, top = cy + rad;          // 頭の中心と、胴体の頂点（＝頭の下端）
        const c = top + (h - top) * 0.28;            // 肩の張り具合を決める制御点
        return ellipse(w / 2, cy, rad, rad) + ' '
             + `M${r(w * 0.12)},${r(h)} C${r(w * 0.12)},${r(c)} ${r(w * 0.28)},${r(top)} ${r(w / 2)},${r(top)} `
             + `C${r(w * 0.72)},${r(top)} ${r(w * 0.88)},${r(c)} ${r(w * 0.88)},${r(h)} Z`;
      } },
    // 閉じた本。手前の表紙と、奥に見える裏表紙を1つの輪郭にまとめて薄い厚みを出す。
    // 左上と右下は背表紙側の折り返しとして同じ曲線でつなぎ、残る2つの角（奥の右上・手前の左下）は同じ角丸にする
    { id: 'book', label: '本', category: 'icon', size: { w: 110, h: 140 }, pad: [0.16, 0.16, 0.06, 0.14],
      d: (w, h) => {
        const dx = w * 0.08, dy = h * 0.08;            // 奥の表紙のずれ（本の厚み）
        const rr = Math.min(w, h) * 0.05;
        // 外形
        const outline = `M0,${r(dy)} C0,${r(dy * 0.35)} ${r(dx * 0.35)},0 ${r(dx)},0 `
             + `H${r(w - rr)} A${r(rr)},${r(rr)} 0 0 1 ${r(w)},${r(rr)} `
             + `V${r(h - dy)} C${r(w)},${r(h - dy * 0.35)} ${r(w - dx * 0.35)},${r(h)} ${r(w - dx)},${r(h)} `
             + `H${r(rr)} A${r(rr)},${r(rr)} 0 0 1 0,${r(h - rr)} Z `;
        // 手前の表紙の上辺・右辺（右上の角は奥の表紙と同じ角丸）。行って戻る＝面積ゼロの線
        const cover = `M0,${r(dy)} H${r(w - dx - rr)} A${r(rr)},${r(rr)} 0 0 1 ${r(w - dx)},${r(dy + rr)} V${r(h)} `
             + `V${r(dy + rr)} A${r(rr)},${r(rr)} 0 0 0 ${r(w - dx - rr)},${r(dy)} H0 Z `;
        return outline + cover + line(w * 0.075, dy * 1.15, w * 0.075, h);
      } }
  ];

  const CATEGORIES = [
    { key: 'basic', label: '基本' },
    { key: 'flow', label: 'フローチャート' },
    { key: 'arrow', label: '矢印・吹き出し' },
    { key: 'icon', label: 'アイコン' }
  ];

  const BY_ID = {};
  CATALOG.forEach(s => { BY_ID[s.id] = s; });

  const DEFAULT_SIZE = { w: 160, h: 120 };

  // 未知の id（新しい版で作ったボードを古い版で開いた場合など）は矩形として描く
  function get(id) { return BY_ID[id] || BY_ID.rect; }

  return {
    CATALOG,
    CATEGORIES,
    get,
    pathD(id, w, h) { return get(id).d(w, h); },
    defaultSize(id) { return get(id).size || DEFAULT_SIZE; },
    // 文字を置く foreignObject の領域。pad を持たない図形は全面（従来どおり）
    textBox(id, w, h) {
      const pad = get(id).pad;
      if (!pad) return { x: 0, y: 0, width: w, height: h };
      const [t, rt, b, l] = pad;
      return {
        x: Math.round(w * l),
        y: Math.round(h * t),
        width: Math.max(1, Math.round(w * (1 - l - rt))),
        height: Math.max(1, Math.round(h * (1 - t - b)))
      };
    }
  };
})();

// Node（scripts/board-from-spec.js）からも同じ定義を使う
if (typeof module !== 'undefined' && module.exports) module.exports = Shapes;
