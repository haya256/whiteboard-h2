'use strict';

const IO = (() => {
  const STORAGE_KEY = 'openboard_v01';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function buildData() {
    return {
      version: '0.1',
      meta: {
        title: 'ボード',
        modified: new Date().toISOString()
      },
      viewport: { x: 0, y: 0, zoom: 1.0 },
      nodes: Model.getNodes(),
      edges: []
    };
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(buildData()));
    } catch (e) {
      console.warn('自動保存に失敗しました:', e);
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

        const lines = node.content ? node.content.split('\n') : [''];
        const lineH = node.style.fontSize * 1.55;
        lines.forEach((line, i) => {
          const t = document.createElementNS(SVG_NS, 'text');
          t.setAttribute('x', node.x + 12);
          t.setAttribute('y', node.y + 14 + node.style.fontSize + i * lineH);
          t.setAttribute('font-family', "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif");
          t.setAttribute('font-size', node.style.fontSize);
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
          const lines = node.content.split('\n');
          const lineH = s.fontSize * 1.4;
          const totalH = lines.length * lineH;
          const baseY = y + h / 2 - totalH / 2 + s.fontSize * 0.85;
          lines.forEach((line, i) => {
            const t = document.createElementNS(SVG_NS, 'text');
            t.setAttribute('x', x + w / 2);
            t.setAttribute('y', baseY + i * lineH);
            t.setAttribute('text-anchor', 'middle');
            t.setAttribute('font-family', "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif");
            t.setAttribute('font-size', s.fontSize);
            t.setAttribute('fill', s.color);
            t.textContent = line;
            g.appendChild(t);
          });
        }
      }

      svg.appendChild(g);
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
        alert('読み込みに失敗しました: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  return { save, load, exportSVG, importSVG };
})();
