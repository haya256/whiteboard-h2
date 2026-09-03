'use strict';

const IO = (() => {
  const STORAGE_KEY = 'openboard_v01';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // align（left/center/right）から text-anchor と x座標を求める。
  // pad は左揃え/右揃え時の余白（中央揃えでは使わない）
  function alignXAnchor(align, x, width, pad) {
    if (align === 'center') return { anchor: 'middle', x: x + width / 2 };
    if (align === 'right') return { anchor: 'end', x: x + width - pad };
    return { anchor: 'start', x: x + pad };
  }

  function buildData() {
    return {
      version: '0.1',
      meta: {
        title: 'ボード',
        modified: new Date().toISOString()
      },
      viewport: View.getViewport(),
      nodes: Model.getNodes(),
      edges: Model.getEdges()
    };
  }

  // 容量超過の警告は連続して出さないよう、直前が成功したかどうかを覚えておく
  let _quotaWarned = false;

  // window.alert は使わずページ内トーストで通知する（#toast、数秒で自動的に消える）
  let _toastTimer = null;
  function showToast(message) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('open');
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => {
      toast.classList.remove('open');
      _toastTimer = null;
    }, 4000);
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(buildData()));
      _quotaWarned = false;
    } catch (e) {
      console.warn('自動保存に失敗しました:', e);
      if (!_quotaWarned) {
        _quotaWarned = true;
        showToast('画像が大きすぎて自動保存できません。.svg で保存してください');
      }
    }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function exportSVG() {
    const nodes = Model.getNodes();

    // 全ノードを囲むバウンディングボックスを計算
    let minX = 0, minY = 0, maxX = 800, maxY = 600;
    if (nodes.length > 0) {
      minX = Math.min(...nodes.map(n => n.x)) - 24;
      minY = Math.min(...nodes.map(n => n.y)) - 24;
      maxX = Math.max(...nodes.map(n => n.x + n.width)) + 24;
      maxY = Math.max(...nodes.map(n => n.y + n.height)) + 24;
    }
    const w = maxX - minX;
    const h = maxY - minY;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('xmlns', SVG_NS);
    svg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    svg.setAttribute('viewBox', `${minX} ${minY} ${w} ${h}`);
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);

    // JSON メタデータを埋め込む（再インポート用）
    const meta = document.createElementNS(SVG_NS, 'metadata');
    meta.textContent = JSON.stringify(buildData());
    svg.appendChild(meta);

    // 背景
    const bg = document.createElementNS(SVG_NS, 'rect');
    bg.setAttribute('x', minX);
    bg.setAttribute('y', minY);
    bg.setAttribute('width', w);
    bg.setAttribute('height', h);
    bg.setAttribute('fill', '#f5f5f8');
    svg.appendChild(bg);

    // コネクタの矢印マーカー定義（色ごとに用意）
    const defs = document.createElementNS(SVG_NS, 'defs');
    svg.appendChild(defs);
    const markerIds = {};
    function ensureMarker(color) {
      const id = 'arrow-' + color.replace('#', '');
      if (markerIds[id]) return id;
      markerIds[id] = true;
      const marker = document.createElementNS(SVG_NS, 'marker');
      marker.id = id;
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', '8.5');
      marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '7');
      marker.setAttribute('markerHeight', '7');
      marker.setAttribute('orient', 'auto-start-reverse');
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', 'M0,0 L10,5 L0,10 z');
      path.setAttribute('fill', color);
      marker.appendChild(path);
      defs.appendChild(marker);
      return id;
    }

    // コネクタ（エッジ）をノードより先に描画し、ノードの下に配置する
    Model.getEdges().forEach(edge => {
      const from = Model.findById(edge.from);
      const to = Model.findById(edge.to);
      if (!from || !to) return;

      const { a, b } = Model.pickAnchors(from, to);
      const p1 = Model.getAnchors(from)[a];
      const p2 = Model.getAnchors(to)[b];

      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', `M${p1.x},${p1.y} L${p2.x},${p2.y}`);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', edge.style.color);
      path.setAttribute('stroke-width', edge.style.width);

      const mid = ensureMarker(edge.style.color);
      if (edge.style.arrow === 'end' || edge.style.arrow === 'both') {
        path.setAttribute('marker-end', `url(#${mid})`);
      }
      if (edge.style.arrow === 'start' || edge.style.arrow === 'both') {
        path.setAttribute('marker-start', `url(#${mid})`);
      }

      svg.appendChild(path);
    });

    // 各ノードをSVGネイティブ要素で描画（foreignObject不使用でビューア互換性を確保）
    nodes.forEach(node => {
      const g = document.createElementNS(SVG_NS, 'g');

      if (node.type === 'sticky') {
        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('x', node.x);
        rect.setAttribute('y', node.y);
        rect.setAttribute('width', node.width);
        rect.setAttribute('height', node.height);
        rect.setAttribute('rx', '6');
        rect.setAttribute('fill', node.style.background);
        g.appendChild(rect);

        const bold = !!node.style.bold;
        const align = node.style.align || 'left';
        const { anchor, x: textX } = alignXAnchor(align, node.x, node.width, 12);
        const lines = node.content ? node.content.split('\n') : [''];
        const lineH = node.style.fontSize * 1.55;
        lines.forEach((line, i) => {
          const t = document.createElementNS(SVG_NS, 'text');
          t.setAttribute('x', textX);
          t.setAttribute('y', node.y + 14 + node.style.fontSize + i * lineH);
          t.setAttribute('text-anchor', anchor);
          t.setAttribute('font-family', "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif");
          t.setAttribute('font-size', node.style.fontSize);
          if (bold) t.setAttribute('font-weight', '700');
          t.setAttribute('fill', node.style.color);
          t.textContent = line;
          g.appendChild(t);
        });
      } else if (node.type === 'shape') {
        const { x, y, width: w, height: h, style: s } = node;
        let bg;
        if (node.shape === 'rect') {
          bg = document.createElementNS(SVG_NS, 'rect');
          bg.setAttribute('x', x); bg.setAttribute('y', y);
          bg.setAttribute('width', w); bg.setAttribute('height', h);
          bg.setAttribute('rx', '8');
        } else if (node.shape === 'ellipse') {
          bg = document.createElementNS(SVG_NS, 'ellipse');
          bg.setAttribute('cx', x + w / 2); bg.setAttribute('cy', y + h / 2);
          bg.setAttribute('rx', w / 2); bg.setAttribute('ry', h / 2);
        } else {
          bg = document.createElementNS(SVG_NS, 'polygon');
          bg.setAttribute('points', `${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`);
        }
        bg.setAttribute('fill', s.background);
        bg.setAttribute('stroke', s.border);
        bg.setAttribute('stroke-width', '2');
        g.appendChild(bg);

        if (node.content) {
          const bold = !!s.bold;
          const align = s.align || 'center';
          const { anchor, x: textX } = alignXAnchor(align, x, w, 8);
          const lines = node.content.split('\n');
          const lineH = s.fontSize * 1.4;
          const totalH = lines.length * lineH;
          const baseY = y + h / 2 - totalH / 2 + s.fontSize * 0.85;
          lines.forEach((line, i) => {
            const t = document.createElementNS(SVG_NS, 'text');
            t.setAttribute('x', textX);
            t.setAttribute('y', baseY + i * lineH);
            t.setAttribute('text-anchor', anchor);
            t.setAttribute('font-family', "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif");
            t.setAttribute('font-size', s.fontSize);
            if (bold) t.setAttribute('font-weight', '700');
            t.setAttribute('fill', s.color);
            t.textContent = line;
            g.appendChild(t);
          });
        }
      } else if (node.type === 'text') {
        // 背景・枠なし。左上寄せで折り返し済みの行をそのまま出力する
        const bold = !!node.style.bold;
        const align = node.style.align || 'left';
        const padTop = 4, padLeft = 6;
        const { anchor, x: textX } = alignXAnchor(align, node.x, node.width, padLeft);
        const lines = node.content ? node.content.split('\n') : [''];
        const lineH = node.style.fontSize * 1.4;
        lines.forEach((line, i) => {
          const t = document.createElementNS(SVG_NS, 'text');
          t.setAttribute('x', textX);
          t.setAttribute('y', node.y + padTop + node.style.fontSize * 0.9 + i * lineH);
          t.setAttribute('text-anchor', anchor);
          t.setAttribute('font-family', "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif");
          t.setAttribute('font-size', node.style.fontSize);
          if (bold) t.setAttribute('font-weight', '700');
          t.setAttribute('fill', node.style.color);
          t.textContent = line;
          g.appendChild(t);
        });
      } else if (node.type === 'image') {
        const img = document.createElementNS(SVG_NS, 'image');
        img.setAttribute('x', node.x);
        img.setAttribute('y', node.y);
        img.setAttribute('width', node.width);
        img.setAttribute('height', node.height);
        img.setAttribute('preserveAspectRatio', 'none');
        img.setAttribute('href', node.src);
        img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', node.src);
        g.appendChild(img);
      }

      // リンクを持つノードには右上に🔗マークを添える（キャンバス上の表示と揃える）
      if (node.link) {
        const badge = document.createElementNS(SVG_NS, 'text');
        badge.setAttribute('x', node.x + node.width - 6);
        badge.setAttribute('y', node.y + 15);
        badge.setAttribute('text-anchor', 'end');
        badge.setAttribute('font-size', '13');
        badge.textContent = '🔗';
        g.appendChild(badge);

        // リンクがあるノードは <a> で包み、静的SVGをブラウザで開いてもクリックで別タブへ飛べるようにする
        const a = document.createElementNS(SVG_NS, 'a');
        a.setAttribute('href', node.link);
        a.setAttributeNS('http://www.w3.org/1999/xlink', 'href', node.link);
        a.setAttribute('target', '_blank');
        a.appendChild(g);
        svg.appendChild(a);
      } else {
        svg.appendChild(g);
      }
    });

    const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'board.svg';
    a.click();
    URL.revokeObjectURL(url);
  }

  function importSVG(file, onSuccess) {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const doc = new DOMParser().parseFromString(e.target.result, 'image/svg+xml');
        if (doc.querySelector('parsererror')) throw new Error('SVGのパースに失敗しました');
        const meta = doc.querySelector('metadata');
        const text = meta?.textContent?.trim();
        if (!text) throw new Error('openboard形式のメタデータが見つかりません');
        onSuccess(JSON.parse(text));
      } catch (err) {
        showToast('読み込みに失敗しました: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  return { save, load, exportSVG, importSVG, showToast };
})();
