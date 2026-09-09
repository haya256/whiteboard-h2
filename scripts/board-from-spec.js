#!/usr/bin/env node
'use strict';

// 仕様 JSON（付箋・テキスト・図形・コネクタの一覧）から openboard 用の .svg を生成する。
// アプリの「開く (.svg)」で読める <metadata>（JSON）と、アプリの書き出しと同じ構造の見た目
// （foreignObject + src/io.js の EXPORT_CSS）を出力する。
//
// 使い方:
//   node scripts/board-from-spec.js <spec.json>
//   node scripts/board-from-spec.js --dims <image>   # 画像のピクセルサイズを表示するだけ
//
// 仕様 JSON の形式は .claude/skills/board-from-image/SKILL.md を参照。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Shapes = require('../src/shapes.js');

const ROOT = path.resolve(__dirname, '..');
const XHTML = 'http://www.w3.org/1999/xhtml';

// アプリの付箋パレット（src/model.js STICKY_COLORS と揃える）
const STICKY_COLORS = {
  yellow: '#FFF275', pink: '#FF7EB9', blue: '#7AFCFF', green: '#A7F3D0', purple: '#E2B0FF'
};
const DEFAULT_TEXT_COLOR = '#333333';
const GREY = '#757575';

// ---- 画像サイズ（JPEG / PNG のヘッダから読む。外部ライブラリ不要） ----
function imageDims(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), mime: 'image/png' };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), mime: 'image/jpeg' };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  throw new Error('JPEG / PNG 以外の画像には対応していません: ' + file);
}

// 埋め込み用の MIME（imageDims と違い、未知の形式でも拡張子から推測して落ちない）
function mimeOf(file, buf) {
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (/\.svg$/i.test(file)) return 'image/svg+xml';
  return 'application/octet-stream';
}

// ---- 引数 ----
const argv = process.argv.slice(2);
if (argv[0] === '--dims') {
  const d = imageDims(argv[1]);
  console.log(`${d.width} x ${d.height} (${d.mime})`);
  process.exit(0);
}
if (!argv[0]) {
  console.error('使い方: node scripts/board-from-spec.js <spec.json>');
  process.exit(1);
}
const specPath = path.resolve(argv[0]);
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const specDir = path.dirname(specPath);
const resolveFrom = p => (path.isAbsolute(p) ? p : path.resolve(specDir, p));

const warnings = [];
const uid = () => crypto.randomUUID();
const scale = spec.scale || 1;
const offX = spec.offset ? spec.offset[0] : 0;
const offY = spec.offset ? spec.offset[1] : 0;
const W = v => v * scale; // 画像px → ワールド
const X = v => offX + v * scale;
const Y = v => offY + v * scale;

// ---- 元画像（任意）：再現図の右隣に並べる ----
let imageNode = null;
let imgDims = null;
if (spec.image) {
  const imgPath = resolveFrom(spec.image);
  imgDims = imageDims(imgPath);
  if (spec.includeImage !== false) {
    const bytes = fs.readFileSync(imgPath);
    if (bytes.length > 1.5 * 1024 * 1024) {
      warnings.push(`元画像が大きい（${(bytes.length / 1024 / 1024).toFixed(1)}MB）ため埋め込みを省略しました。includeImage を明示すれば埋め込めます`);
    } else {
      imageNode = {
        id: uid(), type: 'image',
        x: X(imgDims.width) + 80, y: Y(0),
        width: W(imgDims.width), height: W(imgDims.height),
        src: `data:${imgDims.mime};base64,${bytes.toString('base64')}`
      };
    }
  }
}

// ---- ノード ----
const nodes = [];
const byName = {};

function colorOf(v, fallback) {
  if (!v) return fallback;
  return STICKY_COLORS[v] || v;
}

function textMetrics(content, fontSize) {
  const lines = content.split('\n');
  const chars = Math.max(...lines.map(l => l.length));
  return { lines: lines.length, chars };
}

// 付箋の文字がはみ出しそうなら警告する（全角文字幅 ≒ fontSize、行高 1.55、余白 上下10 左右12）
function checkStickyFit(name, content, w, h, fontSize) {
  const availW = w - 24, availH = h - 20;
  const perLine = Math.max(1, Math.floor(availW / fontSize));
  const lines = content.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
  if (lines * fontSize * 1.55 > availH) {
    warnings.push(`付箋「${name}」: 文字（${fontSize}px）が ${w}x${h} に収まらない可能性があります（推定 ${lines} 行）`);
  }
}

for (const n of spec.nodes || []) {
  const type = n.type || 'sticky';
  const name = n.name || n.content;
  const content = n.content || '';
  if (byName[name]) warnings.push(`ノード名が重複しています: ${name}`);

  if (type === 'sticky') {
    const fontSize = n.fontSize || 32;
    const w = n.w || n.size || 200;
    const h = n.h || n.size || w;
    checkStickyFit(name, content, W(w), W(h), fontSize);
    const node = {
      id: uid(), type: 'sticky',
      x: X(n.cx - w / 2), y: Y(n.cy - h / 2), width: W(w), height: W(h),
      content,
      style: {
        background: colorOf(n.bg, STICKY_COLORS.yellow), fontSize,
        color: n.color || DEFAULT_TEXT_COLOR, bold: !!n.bold,
        align: n.align || 'center', valign: n.valign || 'middle'
      }
    };
    nodes.push(node); byName[name] = node;
  } else if (type === 'shape') {
    const fontSize = n.fontSize || 32;
    const w = n.w || 160, h = n.h || 120;
    const node = {
      id: uid(), type: 'shape', shape: n.shape || 'rect',
      x: X(n.cx - w / 2), y: Y(n.cy - h / 2), width: W(w), height: W(h),
      content,
      style: {
        background: colorOf(n.bg, '#ffffff'), border: n.border || '#4a90e2', fontSize,
        color: n.color || DEFAULT_TEXT_COLOR, bold: !!n.bold,
        align: n.align || 'center', valign: n.valign || 'middle'
      }
    };
    nodes.push(node); byName[name] = node;
  } else if (type === 'text') {
    const fontSize = n.fontSize || 32;
    const m = textMetrics(content, fontSize);
    const w = n.w || (m.chars * fontSize + 14) / scale;
    const h = n.h || (m.lines * fontSize * 1.4 + 10) / scale;
    const node = {
      id: uid(), type: 'text',
      x: X(n.cx - w / 2), y: Y(n.cy - h / 2), width: W(w), height: W(h),
      content,
      style: { fontSize, color: n.color || DEFAULT_TEXT_COLOR, bold: !!n.bold, align: n.align || 'center' }
    };
    nodes.push(node); byName[name] = node;
  } else if (type === 'image') {
    // src はファイルパス（仕様ファイルからの相対可）か data: URI。ファイルは base64 で埋め込む
    let src = n.src || '';
    let w = n.w, h = n.h;
    if (src && !/^data:/.test(src)) {
      const p = resolveFrom(src);
      if (!fs.existsSync(p)) { warnings.push(`画像が見つかりません: ${src}（${name}）`); continue; }
      const bytes = fs.readFileSync(p);
      if (!w || !h) { const d = imageDims(p); w = w || d.width; h = h || d.height; }
      src = `data:${mimeOf(p, bytes)};base64,${bytes.toString('base64')}`;
    }
    w = w || 200; h = h || 200;
    const node = {
      id: uid(), type: 'image',
      x: X(n.cx - w / 2), y: Y(n.cy - h / 2), width: W(w), height: W(h), src
    };
    nodes.push(node); byName[name] = node;
  } else {
    warnings.push(`未対応のノード種別: ${type}（${name}）`);
  }
  if (n.link) nodes[nodes.length - 1].link = n.link;
}

// ---- コネクタ（アンカー計算はアプリ src/model.js / src/view.js と同じ） ----
function getAnchors(n) {
  const cx = n.x + n.width / 2, cy = n.y + n.height / 2;
  return { top: { x: cx, y: n.y }, bottom: { x: cx, y: n.y + n.height }, left: { x: n.x, y: cy }, right: { x: n.x + n.width, y: cy } };
}
function pickAnchors(a, b) {
  const ax = a.x + a.width / 2, ay = a.y + a.height / 2, bx = b.x + b.width / 2, by = b.y + b.height / 2;
  const dx = bx - ax, dy = by - ay;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? { a: 'right', b: 'left' } : { a: 'left', b: 'right' };
  return dy >= 0 ? { a: 'bottom', b: 'top' } : { a: 'top', b: 'bottom' };
}
function anchorOffset(name, off) {
  return { right: { dx: off, dy: 0 }, left: { dx: -off, dy: 0 }, bottom: { dx: 0, dy: off }, top: { dx: 0, dy: -off } }[name] || { dx: 0, dy: 0 };
}
function edgeGeometry(from, to, line) {
  const { a, b } = pickAnchors(from, to);
  const p1 = getAnchors(from)[a], p2 = getAnchors(to)[b];
  const { x: x1, y: y1 } = p1, { x: x2, y: y2 } = p2;
  let d, mid;
  if (line === 'curved') {
    const dist = Math.hypot(x2 - x1, y2 - y1), off = Math.max(40, dist * 0.4);
    const oa = anchorOffset(a, off), ob = anchorOffset(b, off);
    const c1 = { x: x1 + oa.dx, y: y1 + oa.dy }, c2 = { x: x2 + ob.dx, y: y2 + ob.dy };
    d = `M${x1},${y1} C${c1.x},${c1.y} ${c2.x},${c2.y} ${x2},${y2}`;
    // t=0.5 のベジェ上の点
    mid = { x: (x1 + 3 * c1.x + 3 * c2.x + x2) / 8, y: (y1 + 3 * c1.y + 3 * c2.y + y2) / 8 };
  } else if (line === 'elbow') {
    if (a === 'left' || a === 'right') {
      const mx = (x1 + x2) / 2;
      d = `M${x1},${y1} L${mx},${y1} L${mx},${y2} L${x2},${y2}`;
      mid = { x: mx, y: (y1 + y2) / 2 };
    } else {
      const my = (y1 + y2) / 2;
      d = `M${x1},${y1} L${x1},${my} L${x2},${my} L${x2},${y2}`;
      mid = { x: (x1 + x2) / 2, y: my };
    }
  } else {
    d = `M${x1},${y1} L${x2},${y2}`;
    mid = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  }
  return { d, mid };
}

const edges = [];
const labelNodes = [];
const pairs = new Set();
for (const e of spec.edges || []) {
  const from = byName[e.from], to = byName[e.to];
  if (!from || !to) { warnings.push(`コネクタの端点が見つかりません: ${e.from} → ${e.to}`); continue; }
  const key = [from.id, to.id].sort().join('|');
  if (pairs.has(key)) {
    warnings.push(`同じ2ノード間のコネクタが複数あります（${e.from} と ${e.to}）。アプリでは1本しか引けず重なって見えるので、両端矢印1本にまとめてラベルを2つ置くのが無難です`);
  }
  pairs.add(key);
  const style = { line: e.line || 'straight', arrow: e.arrow || 'end', color: e.color || DEFAULT_TEXT_COLOR, width: e.width || 2 };
  edges.push({ id: uid(), type: 'connector', from: from.id, to: to.id, style });

  // ラベル：線の中点付近にテキストノードを置く（labelOffset は画像px単位）
  const labels = [].concat(e.label || []);
  labels.forEach((label, i) => {
    const text = typeof label === 'string' ? label : label.text;
    const off = (typeof label === 'object' && label.offset) || (e.labelOffset && e.labelOffset[i]) || [0, i === 0 ? -14 : 14];
    const fontSize = (typeof label === 'object' && label.fontSize) || e.labelFontSize || 14;
    const color = (typeof label === 'object' && label.color) || e.labelColor || style.color;
    const { mid } = edgeGeometry(from, to, style.line);
    const m = textMetrics(text, fontSize);
    const w = m.chars * fontSize + 14, h = m.lines * fontSize * 1.4 + 10;
    labelNodes.push({
      id: uid(), type: 'text',
      x: mid.x + W(off[0]) - w / 2, y: mid.y + W(off[1]) - h / 2, width: w, height: h,
      content: text,
      style: { fontSize, color, bold: false, align: 'center' }
    });
  });
}

// ---- 出力データ ----
const allNodes = [...(imageNode ? [imageNode] : []), ...nodes, ...labelNodes];
const out = {
  version: '0.1',
  meta: { title: spec.title || path.basename(specPath, '.json'), modified: new Date().toISOString() },
  viewport: spec.viewport || { x: 40, y: 40, zoom: 0.5 },
  nodes: allNodes,
  edges
};

// ---- SVG 生成 ----
const ioText = fs.readFileSync(path.join(ROOT, 'src/io.js'), 'utf8');
const EXPORT_CSS = ioText.match(/const EXPORT_CSS = `([\s\S]*?)`;/)[1];
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const br = content => content.split('\n').map(esc).join(`<br xmlns="${XHTML}"/>`);
const VALIGN = { top: 'flex-start', middle: 'center', bottom: 'flex-end' };
const nodeById = id => allNodes.find(n => n.id === id);

const minX = Math.min(...allNodes.map(n => n.x)) - 24, minY = Math.min(...allNodes.map(n => n.y)) - 24;
const maxX = Math.max(...allNodes.map(n => n.x + n.width)) + 24, maxY = Math.max(...allNodes.map(n => n.y + n.height)) + 24;
const svgW = maxX - minX, svgH = maxY - minY;

const parts = [];
parts.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${minX} ${minY} ${svgW} ${svgH}" width="${svgW}" height="${svgH}">`);
parts.push(`<metadata>${esc(JSON.stringify(out))}</metadata>`);
parts.push(`<style>${EXPORT_CSS}</style>`);
parts.push(`<rect x="${minX}" y="${minY}" width="${svgW}" height="${svgH}" fill="#f5f5f8"/>`);

const markers = new Map();
function ensureMarker(c) {
  const id = 'arrow-' + c.replace('#', '');
  if (!markers.has(id)) {
    markers.set(id, `<marker id="${id}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`);
  }
  return id;
}
const edgeParts = edges.map(e => {
  const { d } = edgeGeometry(nodeById(e.from), nodeById(e.to), e.style.line);
  let attrs = `d="${d}" fill="none" stroke="${e.style.color}" stroke-width="${e.style.width}"`;
  if (e.style.arrow !== 'none') {
    const id = ensureMarker(e.style.color);
    if (e.style.arrow === 'end' || e.style.arrow === 'both') attrs += ` marker-end="url(#${id})"`;
    if (e.style.arrow === 'start' || e.style.arrow === 'both') attrs += ` marker-start="url(#${id})"`;
  }
  return `<path ${attrs}/>`;
});
parts.push(`<defs>${[...markers.values()].join('')}</defs>`);
parts.push(...edgeParts);

// 形の定義はアプリと同じ src/shapes.js を使う（二重管理をしない）
function shapeBg(n) {
  const { width: w, height: h, style: s } = n;
  return `<path class="shape-bg" d="${Shapes.pathD(n.shape, w, h)}" fill="${s.background}" fill-rule="evenodd" `
       + `stroke="${s.border}" stroke-width="2"/>`;
}
function linkWrap(n, inner) {
  if (!n.link) return inner;
  const badge = `<text class="link-badge" text-anchor="end" x="${n.width - 6}" y="15">🔗</text>`;
  return `<a href="${esc(n.link)}" xlink:href="${esc(n.link)}" target="_blank">${inner.replace('</g>', badge + '</g>')}</a>`;
}
for (const n of allNodes) {
  const s = n.style || {};
  const textStyle = `font-size: ${s.fontSize}px; color: ${s.color}; font-weight: ${s.bold ? 700 : 400}; text-align: ${s.align};`;
  let g;
  if (n.type === 'image') {
    g = `<g class="node image" data-id="${n.id}" transform="translate(${n.x},${n.y})"><image class="image-el" width="${n.width}" height="${n.height}" preserveAspectRatio="none" href="${n.src}" xlink:href="${n.src}"/><rect class="image-frame" width="${n.width}" height="${n.height}" fill="none"/></g>`;
  } else if (n.type === 'sticky') {
    g = `<g class="node sticky" data-id="${n.id}" transform="translate(${n.x},${n.y})"><rect class="sticky-bg" width="${n.width}" height="${n.height}" rx="6" fill="${s.background}"/><foreignObject class="sticky-fo" width="${n.width}" height="${n.height}"><div xmlns="${XHTML}" class="sticky-text-wrap text-valign-wrap" style="align-items: ${VALIGN[s.valign] || 'center'};"><div class="sticky-text" style="${textStyle}">${br(n.content)}</div></div></foreignObject></g>`;
  } else if (n.type === 'shape') {
    g = `<g class="node shape" data-id="${n.id}" transform="translate(${n.x},${n.y})">${shapeBg(n)}<foreignObject class="shape-fo" x="${Shapes.textBox(n.shape, n.width, n.height).x}" y="${Shapes.textBox(n.shape, n.width, n.height).y}" width="${Shapes.textBox(n.shape, n.width, n.height).width}" height="${Shapes.textBox(n.shape, n.width, n.height).height}"><div xmlns="${XHTML}" class="shape-text-wrap text-valign-wrap" style="align-items: ${VALIGN[s.valign] || 'center'};"><div class="shape-text" style="${textStyle}">${br(n.content)}</div></div></foreignObject></g>`;
  } else if (n.type === 'text') {
    g = `<g class="node text-node" data-id="${n.id}" transform="translate(${n.x},${n.y})"><rect class="text-frame" width="${n.width}" height="${n.height}" fill="transparent"/><foreignObject class="text-fo" width="${n.width}" height="${n.height}"><div xmlns="${XHTML}" class="text-content" style="${textStyle}">${br(n.content)}</div></foreignObject></g>`;
  }
  if (g) parts.push(linkWrap(n, g));
}
parts.push('</svg>');

// ---- 書き出し ----
let outPath;
if (spec.output) outPath = resolveFrom(spec.output);
else if (spec.image) { const p = resolveFrom(spec.image); outPath = path.join(path.dirname(p), path.basename(p, path.extname(p)) + '_edited.svg'); }
else outPath = path.join(specDir, path.basename(specPath, '.json') + '.svg');

fs.writeFileSync(outPath, parts.join('\n'));

// 読み戻し検証（アプリの importSVG と同じく <metadata> の JSON を解釈する）
const check = fs.readFileSync(outPath, 'utf8').match(/<metadata>([\s\S]*?)<\/metadata>/)[1]
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const parsed = JSON.parse(check);
const ids = new Set(parsed.nodes.map(n => n.id));
const dangling = parsed.edges.filter(e => !ids.has(e.from) || !ids.has(e.to)).length;

console.log(`書き出し: ${outPath}`);
console.log(`  ノード ${parsed.nodes.length}（付箋 ${nodes.filter(n => n.type === 'sticky').length} / 図形 ${nodes.filter(n => n.type === 'shape').length} / テキスト ${nodes.filter(n => n.type === 'text').length} / ラベル ${labelNodes.length} / 画像 ${nodes.filter(n => n.type === 'image').length + (imageNode ? 1 : 0)}）、コネクタ ${parsed.edges.length}、${(fs.statSync(outPath).size / 1024).toFixed(0)} KB`);
if (imgDims) console.log(`  元画像: ${imgDims.width} x ${imgDims.height}px${imageNode ? '（右隣に埋め込み）' : ''}`);
if (dangling) console.log(`  !! 端点の無いコネクタ: ${dangling}`);
for (const w of warnings) console.log('  注意: ' + w);
