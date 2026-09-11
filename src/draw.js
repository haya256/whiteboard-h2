'use strict';

// 手書き（フリーハンド）の線。
// マウスの軌跡を「ノードの外接矩形の中の 0..1 正規化座標」の点列として持ち、
// そこから <path> の d を組み立てる純粋関数だけを置く（DOM には触らない）。
//
// 正規化座標にしている理由は2つある。
//  1. リサイズが width / height の変更だけで完結する（点列を作り直さなくてよい）。
//  2. そのため points 配列は作ったあと二度と書き換わらない。src/history.js の cloneNode() は
//     style しか深くコピーしないので、もし点列を破壊的に書き換えると Undo 履歴まで巻き添えで
//     変わってしまう。不変にしておけば、画像ノードの src（長い文字列）と同じ理屈で
//     参照を共有したままで安全になる。
//
// 描画（src/view.js）・リサイズ・.svg 書き出し（src/io.js は View の生成関数を再利用）が
// すべて Draw.pathD() を通る。
const Draw = (() => {

  // ノードの最小サイズ。src/model.js の updateSize() と src/app.js の MIN_SIZE に合わせてある。
  // 外接矩形をここまで広げておくと、真横に引いた線（高さ0）でも正規化の割り算が 0 除算にならない
  const MIN_SIZE = 40;

  function r(v) { return Math.round(v * 100) / 100; }
  // 正規化座標は 0..1 なので小数4桁（外接矩形が 1000px でも 0.1px の精度）まで残せば十分。
  // 保存する .svg / localStorage を小さく保つために丸める
  function rn(v) { return Math.round(v * 10000) / 10000; }

  // ---- 点列の間引き（Ramer–Douglas–Peucker） ----
  // 元の線から tol 以上離れない範囲で中間点を捨てる。マウスの軌跡はそのままだと
  // 1本で数百点になり、保存サイズと d 文字列の長さに効いてくる。

  // 点 p と線分 ab の距離
  function pointLineDist(p, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    // 線分上の最近傍点を求めるための媒介変数 t を 0..1 に収める
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }

  // 再帰ではなくスタックで回す（長い線でも呼び出しが深くならないように）
  function simplify(points, tol) {
    if (!points || points.length <= 2) return (points || []).slice();
    const keep = new Array(points.length).fill(false);
    keep[0] = keep[points.length - 1] = true;

    const stack = [[0, points.length - 1]];
    while (stack.length > 0) {
      const [first, last] = stack.pop();
      let maxDist = -1;
      let idx = -1;
      for (let i = first + 1; i < last; i++) {
        const d = pointLineDist(points[i], points[first], points[last]);
        if (d > maxDist) { maxDist = d; idx = i; }
      }
      if (maxDist > tol && idx > 0) {
        keep[idx] = true;
        stack.push([first, idx], [idx, last]);
      }
    }
    return points.filter((_, i) => keep[i]);
  }

  // ---- 世界座標の軌跡 → ノード1件ぶんの外接矩形と正規化点列 ----
  // strokeWidth ぶんの余白を足したうえで、最小 MIN_SIZE になるよう中心を保ったまま広げる。
  // 戻り値は { x, y, width, height, points }（そのままノードのフィールドになる）
  function normalize(worldPoints, strokeWidth) {
    const pts = (worldPoints || []).filter(p => p && isFinite(p[0]) && isFinite(p[1]));
    if (pts.length === 0) return null;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    pts.forEach(p => {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    });

    // 線は座標の中心を通るので、太さの半分は矩形からはみ出す。その分を余白として持たせる
    const pad = Math.max(2, (strokeWidth || 2) / 2 + 1);
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;

    let w = maxX - minX;
    let h = maxY - minY;
    if (w < MIN_SIZE) { const g = (MIN_SIZE - w) / 2; minX -= g; maxX += g; w = MIN_SIZE; }
    if (h < MIN_SIZE) { const g = (MIN_SIZE - h) / 2; minY -= g; maxY += g; h = MIN_SIZE; }

    return {
      x: r(minX),
      y: r(minY),
      width: r(w),
      height: r(h),
      points: pts.map(p => [rn((p[0] - minX) / w), rn((p[1] - minY) / h)])
    };
  }

  // ---- 正規化点列 → d 文字列 ----
  // Catmull-Rom スプラインを3次ベジェに変換して、折れ線のカクつきをならす。
  // 制御点は「前後の点を結んだ向きに 1/6 だけ伸ばす」標準的な式（張力 0.5 相当）。
  function pathD(points, w, h) {
    const pts = (points || []).map(p => [p[0] * w, p[1] * h]);
    if (pts.length === 0) return '';
    // 点が1つだけ（クリックしただけ）のときは長さ0の線分にする。
    // stroke-linecap="round" が効いて丸い点として見える
    if (pts.length === 1) return `M${r(pts[0][0])},${r(pts[0][1])} L${r(pts[0][0])},${r(pts[0][1])}`;
    if (pts.length === 2) return `M${r(pts[0][0])},${r(pts[0][1])} L${r(pts[1][0])},${r(pts[1][1])}`;

    let d = `M${r(pts[0][0])},${r(pts[0][1])}`;
    for (let i = 0; i < pts.length - 1; i++) {
      // 両端では自分自身を折り返して使う（端点の接線が暴れないように）
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const c1x = p1[0] + (p2[0] - p0[0]) / 6;
      const c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6;
      const c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ` C${r(c1x)},${r(c1y)} ${r(c2x)},${r(c2y)} ${r(p2[0])},${r(p2[1])}`;
    }
    return d;
  }

  // 描画中のプレビュー用。まだ外接矩形が決まっていない世界座標の点列を、
  // そのまま（正規化せず）滑らかな d にする
  function rawPathD(worldPoints) {
    return pathD((worldPoints || []).map(p => [p[0], p[1]]), 1, 1);
  }

  return { MIN_SIZE, simplify, normalize, pathD, rawPathD };
})();

// Node（scripts/ 配下の変換スクリプト）からも同じ定義を使えるようにする
if (typeof module !== 'undefined' && module.exports) module.exports = Draw;
