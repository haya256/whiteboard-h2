#!/usr/bin/env node
'use strict';

// Miro REST API (v2) でボードの内容を取得し、scripts/board-from-spec.js 用の仕様 JSON に変換する。
//
// 使い方:
//   node scripts/miro-to-spec.js <boardId または ボードURL> [出力 spec.json] [--dump <生JSONの保存先>]
//
// 認証: config/miro.json の { "token": "..." } または環境変数 MIRO_TOKEN（読み取り権限 boards:read）。
// 出力: 仕様 JSON（省略時はスクラッチパッド相当として ./miro-<boardId>.spec.json）。
//       仕様の output は data/<ボード名>_edited.svg になる。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const API = 'https://api.miro.com/v2';

// ---- 引数 ----
const argv = process.argv.slice(2);
if (!argv[0]) {
  console.error('使い方: node scripts/miro-to-spec.js <boardId|boardURL> [spec.json] [--dump <file>]');
  process.exit(1);
}
let boardId = argv[0];
const urlMatch = boardId.match(/miro\.com\/app\/board\/([^/?#]+)/);
if (urlMatch) boardId = decodeURIComponent(urlMatch[1]);
const dumpIdx = argv.indexOf('--dump');
const dumpPath = dumpIdx >= 0 ? argv[dumpIdx + 1] : null;
const positional = argv.slice(1).filter((a, i, arr) => a !== '--dump' && arr[i - 1] !== '--dump');
let specOut = positional[0];

// ---- トークン ----
let token = process.env.MIRO_TOKEN;
const cfgPath = path.join(ROOT, 'config', 'miro.json');
if (!token && fs.existsSync(cfgPath)) token = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).token;
if (!token) {
  console.error('Miro のトークンがありません。config/miro.json に {"token":"..."} を置くか MIRO_TOKEN を設定してください');
  process.exit(1);
}

async function api(pathname) {
  const res = await fetch(API + pathname, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Miro API ${res.status} ${res.statusText}: ${pathname}\n${await res.text()}`);
  return res.json();
}
async function paged(pathname) {
  const out = [];
  let cursor = null;
  do {
    const sep = pathname.includes('?') ? '&' : '?';
    const page = await api(pathname + sep + 'limit=50' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    out.push(...(page.data || []));
    cursor = page.cursor || null;
  } while (cursor);
  return out;
}

// ---- 変換ヘルパー ----
const warnings = [];

// Miro の付箋色名 → openboard パレット
const STICKY_COLOR_MAP = {
  light_yellow: 'yellow', yellow: 'yellow', orange: 'yellow', gray: 'yellow', black: 'yellow',
  light_pink: 'pink', pink: 'pink', red: 'pink',
  cyan: 'blue', light_blue: 'blue', blue: 'blue', dark_blue: 'blue',
  light_green: 'green', green: 'green', dark_green: 'green',
  violet: 'purple', purple: 'purple'
};

// Miro の HTML 本文 → プレーンテキスト（<p>/<br> を改行に）
function htmlToText(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p[^>]*>/gi, '\n').replace(/<\/?p[^>]*>/gi, '').replace(/<\/?(ul|ol|li)[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
       .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)));
  s = s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}
const isBold = html => /^\s*(<p[^>]*>)?\s*<strong>[\s\S]*<\/strong>\s*(<\/p>)?\s*$/i.test(html || '');

// 付箋に収まる最大の文字サイズを段階から選ぶ（アプリの余白・行高で推定）
const FONT_STEPS = [48, 32, 24, 18, 14, 12];
function fitFontSize(content, w, h) {
  for (const fs of FONT_STEPS) {
    const perLine = Math.max(1, Math.floor((w - 24) / fs));
    const lines = content.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
    if (lines * fs * 1.55 <= h - 20) return fs;
  }
  return 12;
}

const VALIGN_MAP = { top: 'top', middle: 'middle', bottom: 'bottom' };
const SHAPE_MAP = {
  rectangle: 'rect', round_rectangle: 'rect', circle: 'ellipse', rhombus: 'diamond',
  triangle: 'diamond', wedge_round_rectangle_callout: 'rect', flow_chart_process: 'rect',
  flow_chart_decision: 'diamond', flow_chart_terminator: 'ellipse', flow_chart_connector: 'ellipse'
};
const arrowOf = cap => cap && cap !== 'none';

// ---- メイン ----
(async () => {
  const enc = encodeURIComponent(boardId);
  const board = await api(`/boards/${enc}`);
  const items = await paged(`/boards/${enc}/items`);
  const connectors = await paged(`/boards/${enc}/connectors`);
  if (dumpPath) fs.writeFileSync(dumpPath, JSON.stringify({ board, items, connectors }, null, 2));

  const byId = new Map(items.map(it => [it.id, it]));

  // 絶対座標（中心）を求める。フレーム内の要素は親の左上からの相対座標で返るので補正する
  function absCenter(it) {
    const p = it.position || {};
    let x = p.x || 0, y = p.y || 0;
    if (it.parent && it.parent.id && p.relativeTo === 'parent_top_left') {
      const parent = byId.get(it.parent.id);
      if (parent) {
        const pc = absCenter(parent);
        x += pc.x - (parent.geometry?.width || 0) / 2;
        y += pc.y - (parent.geometry?.height || 0) / 2;
      }
    }
    return { x, y };
  }

  const nodes = [];
  const nameOfId = new Map();
  const counts = {};
  const uniqueName = base => {
    let name = base || 'item';
    let i = 2;
    while (nodes.some(n => n.name === name)) name = `${base}#${i++}`;
    return name;
  };

  for (const it of items) {
    counts[it.type] = (counts[it.type] || 0) + 1;
    const c = absCenter(it);
    const w = it.geometry?.width || 200, h = it.geometry?.height || 200;
    const d = it.data || {}, s = it.style || {};

    if (it.type === 'sticky_note') {
      const content = htmlToText(d.content);
      const name = uniqueName(content.split('\n')[0] || it.id);
      // 付箋はアプリの制約に合わせて正方形か 3:2 に丸める
      const ratio = w / h;
      const size = Math.round(w);
      const node = {
        name, type: 'sticky', content, cx: Math.round(c.x), cy: Math.round(c.y),
        fontSize: fitFontSize(content, w, h),
        bg: STICKY_COLOR_MAP[s.fillColor] || 'yellow',
        align: s.textAlign || 'center', valign: VALIGN_MAP[s.textAlignVertical] || 'middle'
      };
      if (Math.abs(ratio - 1.5) < 0.15) { node.w = size; node.h = Math.round(size / 1.5); }
      else node.size = Math.round((w + h) / 2);
      if (isBold(d.content)) node.bold = true;
      nodes.push(node); nameOfId.set(it.id, name);
    } else if (it.type === 'shape') {
      const content = htmlToText(d.content);
      const name = uniqueName(content.split('\n')[0] || ('shape-' + it.id));
      const node = {
        name, type: 'shape', shape: SHAPE_MAP[d.shape] || 'rect', content,
        cx: Math.round(c.x), cy: Math.round(c.y), w: Math.round(w), h: Math.round(h),
        fontSize: Number(s.fontSize) || fitFontSize(content || ' ', w, h),
        bg: s.fillColor && s.fillColor !== 'transparent' ? s.fillColor : '#ffffff',
        border: s.borderColor || '#4a90e2', color: s.color || '#333333',
        align: s.textAlign || 'center', valign: VALIGN_MAP[s.textAlignVertical] || 'middle'
      };
      if (isBold(d.content)) node.bold = true;
      nodes.push(node); nameOfId.set(it.id, name);
    } else if (it.type === 'text') {
      const content = htmlToText(d.content);
      if (!content) continue;
      const name = uniqueName(content.split('\n')[0]);
      const node = {
        name, type: 'text', content, cx: Math.round(c.x), cy: Math.round(c.y), w: Math.round(w),
        fontSize: Number(s.fontSize) || 14, color: s.color || '#333333', align: s.textAlign || 'left'
      };
      if (isBold(d.content)) node.bold = true;
      nodes.push(node); nameOfId.set(it.id, name);
    } else if (it.type === 'frame') {
      // フレームは白い矩形として枠だけ再現する（中身は個別の要素として入る）
      const title = d.title || '';
      const name = uniqueName('frame:' + (title || it.id));
      nodes.push({ name, type: 'shape', shape: 'rect', content: '', cx: Math.round(c.x), cy: Math.round(c.y), w: Math.round(w), h: Math.round(h), bg: '#ffffff', border: '#cccccc' });
      nameOfId.set(it.id, name);
      if (title) nodes.push({ name: uniqueName('frame-title:' + title), type: 'text', content: title, cx: Math.round(c.x - w / 2 + 8 + title.length * 8), cy: Math.round(c.y - h / 2 - 16), fontSize: 16, color: '#757575', align: 'left' });
    } else {
      warnings.push(`未対応の要素をスキップ: ${it.type}（${it.id}）`);
    }
  }
  // フレームは他の要素の下に来るよう先頭へ
  nodes.sort((a, b) => (a.name.startsWith('frame:') ? -1 : 0) - (b.name.startsWith('frame:') ? -1 : 0));

  // ---- コネクタ ----
  const edges = [];
  const pairIndex = new Map();
  for (const cn of connectors) {
    const from = nameOfId.get(cn.startItem?.id), to = nameOfId.get(cn.endItem?.id);
    if (!from || !to) { warnings.push(`端点が要素に紐付いていないコネクタをスキップ: ${cn.id}`); continue; }
    const st = cn.style || {};
    const arrowStart = arrowOf(st.startStrokeCap), arrowEnd = arrowOf(st.endStrokeCap);
    const labels = (cn.captions || []).map(cap => htmlToText(cap.content)).filter(Boolean);
    const key = [from, to].sort().join('|');
    if (pairIndex.has(key)) {
      // 同じ2要素間の2本目以降は1本にまとめる（アプリは1本しか持てない）
      const e = edges[pairIndex.get(key)];
      e.arrow = 'both';
      e.label = [].concat(e.label || [], labels);
      warnings.push(`同じ2要素間のコネクタをまとめました: ${from} - ${to}`);
      continue;
    }
    const edge = {
      from, to,
      arrow: arrowStart && arrowEnd ? 'both' : arrowStart ? 'start' : arrowEnd ? 'end' : 'none',
      line: cn.shape === 'elbowed' ? 'elbow' : cn.shape === 'curved' ? 'curved' : 'straight',
      color: st.strokeColor || '#333333',
      width: Math.max(1, Math.round(Number(st.strokeWidth) || 2))
    };
    if (labels.length) edge.label = labels.length === 1 ? labels[0] : labels;
    pairIndex.set(key, edges.length);
    edges.push(edge);
  }

  // ---- 座標を左上原点へ寄せ、ビューポートを内容に合わせる ----
  const minX = Math.min(...nodes.map(n => n.cx - (n.w || n.size || 0) / 2)), minY = Math.min(...nodes.map(n => n.cy - (n.h || n.size || 0) / 2));
  for (const n of nodes) { n.cx = Math.round(n.cx - minX + 40); n.cy = Math.round(n.cy - minY + 40); }

  const safeName = (board.name || boardId).replace(/[/\\:*?"<>|\x00-\x1f]/g, '').trim() || 'miro-board';
  const spec = {
    title: safeName + '_edited',
    source: `miro:${boardId}`,
    includeImage: false,
    output: path.join(ROOT, 'data', safeName + '_edited.svg'),
    viewport: { x: 20, y: 20, zoom: 0.5 },
    nodes, edges
  };
  if (!specOut) specOut = path.join(process.cwd(), `miro-${safeName}.spec.json`);
  fs.writeFileSync(specOut, JSON.stringify(spec, null, 2));

  console.log(`ボード: ${board.name}（${boardId}）`);
  console.log(`要素: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}、コネクタ ${connectors.length}`);
  console.log(`仕様 JSON: ${specOut}（ノード ${nodes.length}、コネクタ ${edges.length}）`);
  for (const w of warnings) console.log('  注意: ' + w);
  console.log(`次: node scripts/board-from-spec.js "${specOut}"`);
})().catch(err => { console.error(err.message || err); process.exit(1); });
