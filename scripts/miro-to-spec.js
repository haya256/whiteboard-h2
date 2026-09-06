#!/usr/bin/env node
'use strict';

// Miro REST API (v2) でボードの内容を取得し、scripts/board-from-spec.js 用の仕様 JSON に変換する。
//
// 使い方:
//   node scripts/miro-to-spec.js <boardId または ボードURL> [出力 spec.json] [--dump <生JSONの保存先>] [--images fit|original|preview|none]
//
// 認証: config/miro.json の { "token": "..." } または環境変数 MIRO_TOKEN（読み取り権限 boards:read）。
// v2 が読めない要素（isSupported: false）があるときだけ、補助として旧 v1 API の widgets も引く。
// 出力: 仕様 JSON（省略時はスクラッチパッド相当として ./miro-<boardId>.spec.json）。
//       仕様の output は data/<ボード名>_edited.svg になる。

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const API = 'https://api.miro.com/v2';
const API_V1 = 'https://api.miro.com/v1';

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
const imgIdx = argv.indexOf('--images');
// fit: 原寸を取ってから src/image.js と同じ基準（長辺1600px・JPEG 0.85）で再エンコードする。
// アプリは localStorage にボード全体を JSON で自動保存するため、画像が大きいと保存できなくなる。
let imageMode = imgIdx >= 0 ? argv[imgIdx + 1] : 'fit';
if (!['fit', 'preview', 'original', 'none'].includes(imageMode)) {
  console.error('--images は fit / preview / original / none のいずれかです');
  process.exit(1);
}

// sharp は optionalDependencies。無い環境でも原寸取り込みまでは動くようにする
let sharp = null;
try { sharp = require('sharp'); } catch (e) { /* 未インストール */ }
if (imageMode === 'fit' && !sharp) {
  console.error('警告: sharp が無いため画像を縮小できません。原寸のまま取り込みます。');
  console.error('      `npm install` で sharp が入ると、--images fit で自動保存できるサイズに収まります。');
  imageMode = 'original';
}
const imageFormat = imageMode === 'fit' ? 'original' : imageMode;
const OPTS = ['--dump', '--images'];
const positional = argv.slice(1).filter((a, i, arr) => !OPTS.includes(a) && !OPTS.includes(arr[i - 1]));
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

// v2 が読めない要素の補助に旧 v1 API を使う。v1 でしか取れないもの:
//   - リンクプレビューの url / title（v2 は isSupported: false で位置と大きさしか返さない）
//   - 未対応要素の本当の種類（例: v2 が shape と呼ぶものが実は stencil）
// v1 は非推奨で予告なく止まりうるため、失敗しても警告だけ出して続行する。
async function fetchV1Widgets() {
  try {
    const res = await fetch(`${API_V1}/boards/${encodeURIComponent(boardId)}/widgets`, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const j = await res.json();
    return new Map((j.data || []).map(w => [w.id, w]));
  } catch (e) {
    warnings.push(`旧 API (v1) から補助情報を取れませんでした（プレビューは復元できません）: ${e.message}`);
    return new Map();
  }
}

// 画像リソース（?redirect=false）は署名付き URL を返す JSON。それを辿って実体を取る
async function fetchImageBytes(imageUrl, format) {
  const url = imageUrl.replace(/format=[^&]*/, 'format=' + format);
  const meta = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
  if (!meta.ok) throw new Error(`画像メタ ${meta.status}`);
  const { url: signed } = await meta.json();
  if (!signed) throw new Error('署名付き URL がありません');
  const res = await fetch(signed);
  if (!res.ok) throw new Error(`画像本体 ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
// src/image.js の compress と同じ基準で縮小・再エンコードする。
// 長辺 1600px 以下へ縮小し、透過が無ければ白背景で JPEG 0.85、あれば PNG のまま。
// 元より大きくなる場合は元データを使う（アプリ側の判断と同じ）。
const MAX_EDGE = 1600, JPEG_QUALITY = 85;
async function refit(buf) {
  const img = sharp(buf, { failOn: 'none' });
  const meta = await img.metadata();
  // SVG / GIF は圧縮しない（SVG はベクタ、GIF はアニメが壊れる）
  if (meta.format === 'svg' || meta.format === 'gif') return buf;
  const long = Math.max(meta.width || 0, meta.height || 0);
  const pipeline = long > MAX_EDGE ? img.resize({ width: meta.width >= meta.height ? MAX_EDGE : null, height: meta.height > meta.width ? MAX_EDGE : null }) : img;
  // 実際に透明なピクセルがあるかを見る（アルファチャンネルの有無だけでは判断しない）
  const transparent = meta.hasAlpha ? (await pipeline.clone().ensureAlpha().extractChannel('alpha').stats()).channels[0].min < 255 : false;
  const out = transparent
    ? await pipeline.clone().png({ compressionLevel: 9 }).toBuffer()
    : await pipeline.clone().flatten({ background: '#ffffff' }).jpeg({ quality: JPEG_QUALITY }).toBuffer();
  return out.length < buf.length ? out : buf;
}

const extOf = buf =>
  buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG' ? '.png'
  : buf[0] === 0xff && buf[1] === 0xd8 ? '.jpg'
  : buf.toString('ascii', 0, 3) === 'GIF' ? '.gif'
  : buf.toString('ascii', 0, 4) === 'RIFF' ? '.webp' : '.bin';

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
function fitsAt(content, w, h, fs) {
  const perLine = Math.max(1, Math.floor((w - 24) / fs));
  const lines = content.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
  return lines * fs * 1.55 <= h - 20;
}
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
  // v2 が読めない要素があるときだけ v1 を叩く（非推奨 API なので必要最小限にする）
  const needsV1 = items.some(it => it.isSupported === false || it.type === 'preview');
  const v1 = needsV1 ? await fetchV1Widgets() : new Map();
  if (dumpPath) fs.writeFileSync(dumpPath, JSON.stringify({ board, items, connectors, v1: [...v1.values()] }, null, 2));

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
  const pendingImages = [];
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
      // Miro は極小の付箋でも文字を自動縮小して収めるが、アプリの最小文字は 12px。
      // 12px でも収まらない場合は、収まる最小サイズまで付箋を（中心を保って）広げる
      if (node.fontSize === 12 && !fitsAt(content, node.w || node.size, node.h || node.size, 12)) {
        let sz = node.size || node.w;
        while (sz < 400 && !fitsAt(content, sz, node.h ? Math.round(sz / 1.5) : sz, 12)) sz += 4;
        if (node.size) node.size = sz; else { node.w = sz; node.h = Math.round(sz / 1.5); }
        warnings.push(`付箋「${name}」は小さすぎて文字が収まらないため ${sz}px に広げました`);
      }
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
      if (it.isSupported === false) warnings.push(`スタイルを取得できない要素（${v1.get(it.id)?.type || it.type}）を既定の枠で描きました: ${it.id}`);
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
    } else if (it.type === 'image' && imageFormat !== 'none' && d.imageUrl) {
      const name = uniqueName('image-' + it.id);
      const node = { name, type: 'image', src: '', cx: Math.round(c.x), cy: Math.round(c.y), w: Math.round(w), h: Math.round(h) };
      nodes.push(node); nameOfId.set(it.id, name);
      pendingImages.push({ node, url: d.imageUrl, id: it.id });
    } else if (it.type === 'preview') {
      // リンクプレビュー。v2 は位置と大きさしか返さないので、タイトルと URL は v1 から補う
      const w1 = v1.get(it.id) || {};
      if (!w1.url) { warnings.push(`リンクプレビューの URL を取得できずスキップ: ${it.id}`); continue; }
      const title = htmlToText(w1.title) || w1.url;
      const name = uniqueName(title.split('\n')[0]);
      nodes.push({
        name, type: 'shape', shape: 'rect', content: title,
        cx: Math.round(c.x), cy: Math.round(c.y), w: Math.round(w), h: Math.round(h),
        fontSize: fitFontSize(title, w, h),
        bg: '#ffffff', border: '#cccccc', color: '#1a1a1a',
        align: 'center', valign: 'middle', link: w1.url
      });
      nameOfId.set(it.id, name);
    } else {
      const kind = v1.get(it.id)?.type;
      warnings.push(`未対応の要素をスキップ: ${kind && kind !== it.type ? `${it.type} / v1 では ${kind}` : it.type}（${it.id}）`);
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

  // ---- 画像の実体を仕様ファイルの隣に保存し、相対パスで参照させる ----
  if (pendingImages.length) {
    const assetsDir = specOut.replace(/\.json$/, '') + '.assets';
    fs.mkdirSync(assetsDir, { recursive: true });
    let bytes = 0, saved = 0;
    for (const p of pendingImages) {
      try {
        let buf = await fetchImageBytes(p.url, imageFormat);
        if (imageMode === 'fit') {
          const before = buf.length;
          buf = await refit(buf);
          saved += before - buf.length;
        }
        const file = path.join(assetsDir, p.id + extOf(buf));
        fs.writeFileSync(file, buf);
        p.node.src = path.relative(path.dirname(specOut), file);
        bytes += buf.length;
      } catch (e) {
        warnings.push(`画像の取得に失敗（${p.id}）: ${e.message}`);
        const i = spec.nodes.indexOf(p.node);
        if (i >= 0) spec.nodes.splice(i, 1);
      }
    }
    const ok = pendingImages.filter(p => p.node.src).length;
    console.log(`画像: ${ok}/${pendingImages.length} 枚を取得（${imageMode}、計 ${(bytes / 1024).toFixed(0)} KB${saved ? `、${(saved / 1024).toFixed(0)} KB 削減` : ''}）→ ${assetsDir}`);
  }

  fs.writeFileSync(specOut, JSON.stringify(spec, null, 2));

  console.log(`ボード: ${board.name}（${boardId}）`);
  console.log(`要素: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}、コネクタ ${connectors.length}`);
  console.log(`仕様 JSON: ${specOut}（ノード ${nodes.length}、コネクタ ${edges.length}）`);
  for (const w of warnings) console.log('  注意: ' + w);
  console.log(`次: node scripts/board-from-spec.js "${specOut}"`);
})().catch(err => { console.error(err.message || err); process.exit(1); });
