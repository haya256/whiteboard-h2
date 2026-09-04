'use strict';

const View = (() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XHTML_NS = 'http://www.w3.org/1999/xhtml';
  let _canvas;
  let _viewport; // <g id="viewport"> パン・ズーム対象レイヤー（ノード・コネクタをまとめる）
  let _vp = { x: 0, y: 0, zoom: 1 }; // 現在のビューポート状態

  // ビューポートのtransform属性を現在の状態から再設定する
  function applyViewportTransform() {
    _viewport.setAttribute('transform', `translate(${_vp.x},${_vp.y}) scale(${_vp.zoom})`);
  }

  // 画面座標（キャンバス左上からのpx）をワールド座標（ビューポート変換前）に変換する
  function toWorld(sx, sy) {
    return { x: (sx - _vp.x) / _vp.zoom, y: (sy - _vp.y) / _vp.zoom };
  }

  // ---- テキストのDOM操作 ----

  function setTextContent(div, text) {
    div.innerHTML = '';
    text.split('\n').forEach((line, i) => {
      if (i > 0) div.appendChild(document.createElement('br'));
      div.appendChild(document.createTextNode(line));
    });
  }

  function getTextContent(div) {
    let text = '';
    for (const node of div.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
      else if (node.nodeName === 'BR') text += '\n';
      else text += node.textContent;
    }
    return text;
  }

  // 縦位置（valign）→ flexラッパーの align-items 値への変換
  const VALIGN_TO_FLEX = { top: 'flex-start', middle: 'center', bottom: 'flex-end' };

  // ---- 文字の見た目（サイズ・色・太字・横位置・縦位置）をインラインで適用する共通ヘルパー ----
  // 旧データ（bold / align / valign を持たない）はここで既定値にフォールバックする。
  // defaultAlign はノード種別ごとの既定横位置（text・sticky は 'left'、shape は 'center'）
  // defaultValign はノード種別ごとの既定縦位置（sticky は 'top'、shape は 'middle'）
  function applyTextStyle(div, style, defaultAlign, defaultValign) {
    const s = style || {};
    div.style.fontSize = (s.fontSize || 14) + 'px';
    div.style.color = s.color || '#333333';
    div.style.fontWeight = s.bold ? '700' : '';
    div.style.textAlign = s.align || defaultAlign || 'left';

    // 縦位置：文字divを包む flex ラッパー（.text-valign-wrap）の align-items で制御する。
    // ラッパーが無いテキストノードでは何もしない。
    const wrap = div.parentElement;
    if (wrap && wrap.classList && wrap.classList.contains('text-valign-wrap')) {
      wrap.style.alignItems = VALIGN_TO_FLEX[s.valign] || VALIGN_TO_FLEX[defaultValign] || 'flex-start';
    }
  }

  // ---- リサイズハンドル ----

  const HANDLE_DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const HANDLE_CURSORS = {
    nw: 'nwse-resize', n: 'ns-resize', ne: 'nesw-resize',
    e: 'ew-resize', se: 'nwse-resize', s: 'ns-resize',
    sw: 'nesw-resize', w: 'ew-resize'
  };

  function handlePos(dir, w, h) {
    const map = {
      nw: [0, 0], n: [w / 2, 0], ne: [w, 0],
      e: [w, h / 2], se: [w, h], s: [w / 2, h],
      sw: [0, h], w: [0, h / 2]
    };
    return map[dir];
  }

  function makeResizeHandles(w, h) {
    return HANDLE_DIRS.map(dir => {
      const [hx, hy] = handlePos(dir, w, h);
      const el = document.createElementNS(SVG_NS, 'rect');
      el.classList.add('resize-handle');
      el.dataset.dir = dir;
      el.setAttribute('x', hx - 4);
      el.setAttribute('y', hy - 4);
      el.setAttribute('width', '8');
      el.setAttribute('height', '8');
      el.setAttribute('rx', '2');
      el.style.cursor = HANDLE_CURSORS[dir];
      return el;
    });
  }

  function repositionHandles(el, w, h) {
    el.querySelectorAll('.resize-handle').forEach(handle => {
      const [hx, hy] = handlePos(handle.dataset.dir, w, h);
      handle.setAttribute('x', hx - 4);
      handle.setAttribute('y', hy - 4);
    });
  }

  // ---- リンクアイコン（ノード右上の小さなマーク） ----
  // node.link が設定されているノードにだけ表示する。位置はノード幅に応じて右寄せする。

  function makeLinkBadge(node) {
    const el = document.createElementNS(SVG_NS, 'text');
    el.classList.add('link-badge');
    el.setAttribute('text-anchor', 'end');
    el.setAttribute('x', node.width - 6);
    el.setAttribute('y', 15);
    el.textContent = '🔗';
    return el;
  }

  // 生成済みの<g>要素にリンクバッジが必要なら付与する（各 make*El 共通処理）
  function appendLinkBadgeIfNeeded(g, node) {
    if (node.link) g.appendChild(makeLinkBadge(node));
  }

  // ---- 付箋のSVG要素を生成 ----

  function makeStickyEl(node) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.classList.add('node', 'sticky');
    g.dataset.id = node.id;
    g.setAttribute('transform', `translate(${node.x},${node.y})`);

    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.classList.add('sticky-bg');
    rect.setAttribute('width', node.width);
    rect.setAttribute('height', node.height);
    rect.setAttribute('rx', '6');
    rect.setAttribute('fill', node.style.background);

    const fo = document.createElementNS(SVG_NS, 'foreignObject');
    fo.classList.add('sticky-fo');
    fo.setAttribute('width', node.width);
    fo.setAttribute('height', node.height);

    const wrap = document.createElementNS(XHTML_NS, 'div');
    wrap.className = 'sticky-text-wrap text-valign-wrap';

    const div = document.createElementNS(XHTML_NS, 'div');
    div.classList.add('sticky-text');
    setTextContent(div, node.content);

    wrap.appendChild(div);
    applyTextStyle(div, node.style, 'left', 'top');

    fo.appendChild(wrap);
    g.appendChild(rect);
    g.appendChild(fo);
    appendLinkBadgeIfNeeded(g, node);
    return g;
  }

  // ---- 図形のSVG要素を生成 ----

  function makeShapeBg(shape, w, h, style) {
    let el;
    if (shape === 'rect') {
      el = document.createElementNS(SVG_NS, 'rect');
      el.setAttribute('width', w);
      el.setAttribute('height', h);
      el.setAttribute('rx', '8');
    } else if (shape === 'ellipse') {
      el = document.createElementNS(SVG_NS, 'ellipse');
      el.setAttribute('cx', w / 2);
      el.setAttribute('cy', h / 2);
      el.setAttribute('rx', w / 2);
      el.setAttribute('ry', h / 2);
    } else {
      // diamond
      el = document.createElementNS(SVG_NS, 'polygon');
      el.setAttribute('points', `${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`);
    }
    el.setAttribute('fill', style.background);
    el.setAttribute('stroke', style.border);
    el.setAttribute('stroke-width', '2');
    return el;
  }

  function makeShapeEl(node) {
    const { width: w, height: h } = node;
    const g = document.createElementNS(SVG_NS, 'g');
    g.classList.add('node', 'shape');
    g.dataset.id = node.id;
    g.setAttribute('transform', `translate(${node.x},${node.y})`);

    const bg = makeShapeBg(node.shape, w, h, node.style);
    bg.classList.add('shape-bg');
    g.appendChild(bg);

    const fo = document.createElementNS(SVG_NS, 'foreignObject');
    fo.classList.add('shape-fo');
    fo.setAttribute('width', w);
    fo.setAttribute('height', h);

    const wrap = document.createElementNS(XHTML_NS, 'div');
    wrap.className = 'shape-text-wrap text-valign-wrap';

    const div = document.createElementNS(XHTML_NS, 'div');
    div.className = 'shape-text';
    setTextContent(div, node.content);

    wrap.appendChild(div);
    applyTextStyle(div, node.style, 'center', 'middle');
    fo.appendChild(wrap);
    g.appendChild(fo);

    makeResizeHandles(w, h).forEach(el => g.appendChild(el));
    appendLinkBadgeIfNeeded(g, node);
    return g;
  }

  // ---- テキストノードのSVG要素を生成（背景・枠なし） ----

  function makeTextEl(node) {
    const { width: w, height: h } = node;
    const g = document.createElementNS(SVG_NS, 'g');
    g.classList.add('node', 'text-node');
    g.dataset.id = node.id;
    g.setAttribute('transform', `translate(${node.x},${node.y})`);

    // 背景・枠を持たないため、選択枠・ホバー枠の表示とドラッグ当たり判定を兼ねた透明な矩形を敷く
    const frame = document.createElementNS(SVG_NS, 'rect');
    frame.classList.add('text-frame');
    frame.setAttribute('width', w);
    frame.setAttribute('height', h);
    frame.setAttribute('fill', 'transparent');
    g.appendChild(frame);

    const fo = document.createElementNS(SVG_NS, 'foreignObject');
    fo.classList.add('text-fo');
    fo.setAttribute('width', w);
    fo.setAttribute('height', h);

    const div = document.createElementNS(XHTML_NS, 'div');
    div.className = 'text-content';
    setTextContent(div, node.content);
    applyTextStyle(div, node.style, 'left');

    fo.appendChild(div);
    g.appendChild(fo);

    makeResizeHandles(w, h).forEach(el => g.appendChild(el));
    appendLinkBadgeIfNeeded(g, node);
    return g;
  }

  // ---- 画像のSVG要素を生成 ----

  function makeImageEl(node) {
    const { width: w, height: h } = node;
    const g = document.createElementNS(SVG_NS, 'g');
    g.classList.add('node', 'image');
    g.dataset.id = node.id;
    g.setAttribute('transform', `translate(${node.x},${node.y})`);

    const img = document.createElementNS(SVG_NS, 'image');
    img.classList.add('image-el');
    img.setAttribute('width', w);
    img.setAttribute('height', h);
    img.setAttribute('preserveAspectRatio', 'none');
    // href / xlink:href の両方をセットして古いビューアとの互換性を確保する
    img.setAttribute('href', node.src);
    img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', node.src);
    g.appendChild(img);

    // 選択枠表示用（image要素は stroke が効かないので透明な矩形を重ねる）
    const frame = document.createElementNS(SVG_NS, 'rect');
    frame.classList.add('image-frame');
    frame.setAttribute('width', w);
    frame.setAttribute('height', h);
    frame.setAttribute('fill', 'none');
    g.appendChild(frame);

    makeResizeHandles(w, h).forEach(el => g.appendChild(el));
    appendLinkBadgeIfNeeded(g, node);
    return g;
  }

  // node.type に応じて対応する make*El を呼び分ける（renderAll / addNode / IO.exportSVG 共通）
  function makeNodeEl(node) {
    if (node.type === 'sticky') return makeStickyEl(node);
    if (node.type === 'shape') return makeShapeEl(node);
    if (node.type === 'image') return makeImageEl(node);
    if (node.type === 'text') return makeTextEl(node);
    return null;
  }

  // ---- コネクタ（エッジ）のSVG要素を生成 ----

  function markerId(color) {
    return 'arrow-' + color.replace('#', '');
  }

  // 指定色の矢印マーカーを defs に用意する（既にあれば使い回す）
  function ensureMarker(color) {
    const defs = _canvas.querySelector('defs');
    const id = markerId(color);
    if (defs.querySelector(`#${id}`)) return id;

    const marker = document.createElementNS(SVG_NS, 'marker');
    marker.id = id;
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '8.5');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '7');
    marker.setAttribute('markerHeight', '7');
    // auto-start-reverse: marker-start で使われた時だけ180度回転してくれる
    marker.setAttribute('orient', 'auto-start-reverse');

    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M0,0 L10,5 L0,10 z');
    path.setAttribute('fill', color);
    marker.appendChild(path);

    defs.appendChild(marker);
    return id;
  }

  // 2ノードから、アンカー自動選択済みの端点座標を計算する
  function edgeEndpoints(edge) {
    const from = Model.findById(edge.from);
    const to = Model.findById(edge.to);
    if (!from || !to) return null;

    const { a, b } = Model.pickAnchors(from, to);
    const p1 = Model.getAnchors(from)[a];
    const p2 = Model.getAnchors(to)[b];
    return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
  }

  function pathD(pts) {
    return `M${pts.x1},${pts.y1} L${pts.x2},${pts.y2}`;
  }

  function makeEdgeEl(edge) {
    const pts = edgeEndpoints(edge);
    if (!pts) return null;

    const g = document.createElementNS(SVG_NS, 'g');
    g.classList.add('edge');
    g.dataset.id = edge.id;

    // クリック判定用の透明な太い線（見た目には出ない）
    const hit = document.createElementNS(SVG_NS, 'path');
    hit.classList.add('edge-hit');
    hit.setAttribute('d', pathD(pts));

    // 実際に見える線
    const line = document.createElementNS(SVG_NS, 'path');
    line.classList.add('edge-line');
    line.setAttribute('d', pathD(pts));
    line.setAttribute('stroke', edge.style.color);
    line.setAttribute('stroke-width', edge.style.width);

    const mid = ensureMarker(edge.style.color);
    if (edge.style.arrow === 'end' || edge.style.arrow === 'both') {
      line.setAttribute('marker-end', `url(#${mid})`);
    }
    if (edge.style.arrow === 'start' || edge.style.arrow === 'both') {
      line.setAttribute('marker-start', `url(#${mid})`);
    }

    g.appendChild(hit);
    g.appendChild(line);
    return g;
  }

  function renderEdges(edges) {
    const layer = _canvas.querySelector('#edges-layer');
    layer.querySelectorAll('.edge').forEach(el => el.remove());
    edges.forEach(edge => {
      const el = makeEdgeEl(edge);
      if (el) layer.appendChild(el);
    });
  }

  function updateEdgesFor(nodeId) {
    const layer = _canvas.querySelector('#edges-layer');
    Model.getEdges().forEach(edge => {
      if (edge.from !== nodeId && edge.to !== nodeId) return;
      const el = layer.querySelector(`[data-id="${edge.id}"]`);
      if (!el) return;
      const pts = edgeEndpoints(edge);
      if (!pts) return;
      const d = pathD(pts);
      el.querySelector('.edge-hit').setAttribute('d', d);
      el.querySelector('.edge-line').setAttribute('d', d);
    });
  }

  // ---- 空状態のヒント ----

  function makeEmptyHint() {
    const g = document.createElementNS(SVG_NS, 'g');
    g.id = 'empty-hint';

    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', '50%');
    text.setAttribute('y', '50%');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'middle');
    text.setAttribute('font-family', "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif");
    text.setAttribute('font-size', '16');
    text.setAttribute('fill', '#888');
    text.textContent = 'ツールバーから要素を追加できます';

    g.appendChild(text);
    return g;
  }

  function updateEmptyHint() {
    const hint = _canvas.querySelector('#empty-hint');
    if (hint) hint.style.display = Model.getNodes().length === 0 ? '' : 'none';
  }

  // ---- テキスト編集（sticky / shape 共通） ----

  function startEditingEl(fo, div, onSave) {
    fo.style.pointerEvents = 'auto';
    div.contentEditable = 'true';
    div.focus();

    const range = document.createRange();
    range.selectNodeContents(div);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    const finish = () => {
      // contentEditable を外す前に scrollHeight を測っておく（テキストノードの高さ自動調整用）
      const text = getTextContent(div);
      const scrollHeight = div.scrollHeight;
      div.contentEditable = 'false';
      fo.style.pointerEvents = 'none';
      onSave(text, scrollHeight);
      div.removeEventListener('blur', finish);
      div.removeEventListener('keydown', onKey);
    };

    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); div.blur(); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        const s = window.getSelection();
        if (!s.rangeCount) return;
        const r = s.getRangeAt(0);
        r.deleteContents();
        const br = document.createElement('br');
        r.insertNode(br);
        r.setStartAfter(br);
        r.collapse(true);
        s.removeAllRanges();
        s.addRange(r);
      }
    };

    div.addEventListener('blur', finish);
    div.addEventListener('keydown', onKey);
  }

  // ---- 公開API ----

  return {
    init(canvasEl) {
      _canvas = canvasEl;

      const defs = document.createElementNS(SVG_NS, 'defs');
      const pat = document.createElementNS(SVG_NS, 'pattern');
      pat.id = 'dot-grid';
      pat.setAttribute('x', '0');
      pat.setAttribute('y', '0');
      pat.setAttribute('width', '28');
      pat.setAttribute('height', '28');
      pat.setAttribute('patternUnits', 'userSpaceOnUse');
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', '1');
      dot.setAttribute('cy', '1');
      dot.setAttribute('r', '1');
      dot.setAttribute('fill', '#c4c4cc');
      pat.appendChild(dot);
      defs.appendChild(pat);
      _canvas.appendChild(defs);

      const bg = document.createElementNS(SVG_NS, 'rect');
      bg.setAttribute('width', '100%');
      bg.setAttribute('height', '100%');
      bg.setAttribute('fill', 'url(#dot-grid)');
      bg.style.pointerEvents = 'none';
      _canvas.appendChild(bg);

      // ビューポート層：パン・ズームの対象となる描画要素（コネクタ・ノード）をまとめて入れる。
      // 背景の点グリッドと空状態ヒントはこの外＝画面固定のまま表示する。
      _viewport = document.createElementNS(SVG_NS, 'g');
      _viewport.id = 'viewport';
      _canvas.appendChild(_viewport);
      applyViewportTransform();

      // コネクタ描画用レイヤー。ノードより先に追加しておくことで常に下に描画される
      const edgesLayer = document.createElementNS(SVG_NS, 'g');
      edgesLayer.id = 'edges-layer';
      _viewport.appendChild(edgesLayer);

      _canvas.appendChild(makeEmptyHint());
    },

    svgPoint(e) {
      const r = _canvas.getBoundingClientRect();
      return toWorld(e.clientX - r.left, e.clientY - r.top);
    },

    // 現在キャンバスの中央に表示されているワールド座標を返す（ペースト位置決め用）
    canvasCenter() {
      const r = _canvas.getBoundingClientRect();
      return toWorld(r.width / 2, r.height / 2);
    },

    // ワールド座標を画面座標（clientX/clientY基準。position:fixed要素の配置に使う）に変換する
    worldToScreen(x, y) {
      const r = _canvas.getBoundingClientRect();
      return { x: r.left + x * _vp.zoom + _vp.x, y: r.top + y * _vp.zoom + _vp.y };
    },

    getViewport() {
      return { x: _vp.x, y: _vp.y, zoom: _vp.zoom };
    },

    setViewport(vp) {
      _vp = {
        x: typeof vp.x === 'number' ? vp.x : 0,
        y: typeof vp.y === 'number' ? vp.y : 0,
        zoom: typeof vp.zoom === 'number' && vp.zoom > 0 ? vp.zoom : 1
      };
      applyViewportTransform();
    },

    renderAll(nodes) {
      _canvas.querySelectorAll('.node').forEach(el => el.remove());
      nodes.forEach(n => {
        const el = makeNodeEl(n);
        if (el) _viewport.appendChild(el);
      });
      renderEdges(Model.getEdges());
      updateEmptyHint();
    },

    // Model の配列順（= 重なり順）に合わせて、既存のノード<g>要素をDOM上で並べ替える。
    // 全再描画はせず appendChild で順序だけ変更するため、選択状態やハンドル表示はそのまま維持される。
    // （appendChildは既存要素であればDOM内の元の位置から末尾へ移動する仕様を利用している）
    reorderNodes(nodes) {
      nodes.forEach(n => {
        const el = _canvas.querySelector(`[data-id="${n.id}"]`);
        if (el) _viewport.appendChild(el);
      });
    },

    addNode(node) {
      const el = makeNodeEl(node);
      if (el) _viewport.appendChild(el);
      updateEmptyHint();
    },

    removeNode(id) {
      _canvas.querySelector(`[data-id="${id}"]`)?.remove();
      updateEmptyHint();
    },

    moveNode(id, x, y) {
      const el = _canvas.querySelector(`[data-id="${id}"]`);
      if (el) el.setAttribute('transform', `translate(${x},${y})`);
      updateEdgesFor(id);
    },

    resizeNode(id, w, h) {
      const el = _canvas.querySelector(`[data-id="${id}"]`);
      if (!el) return;
      const node = Model.findById(id);
      if (!node) return;

      // リンクバッジは幅に応じて右寄せしているため、リサイズのたびに位置を合わせ直す
      const badge = el.querySelector('.link-badge');
      if (badge) badge.setAttribute('x', w - 6);

      if (node.type === 'shape') {
        const bg = el.querySelector('.shape-bg');
        if (node.shape === 'rect') {
          bg.setAttribute('width', w);
          bg.setAttribute('height', h);
        } else if (node.shape === 'ellipse') {
          bg.setAttribute('cx', w / 2);
          bg.setAttribute('cy', h / 2);
          bg.setAttribute('rx', w / 2);
          bg.setAttribute('ry', h / 2);
        } else {
          bg.setAttribute('points', `${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`);
        }

        const fo = el.querySelector('.shape-fo');
        if (fo) { fo.setAttribute('width', w); fo.setAttribute('height', h); }
      } else if (node.type === 'image') {
        const img = el.querySelector('.image-el');
        const frame = el.querySelector('.image-frame');
        if (img) { img.setAttribute('width', w); img.setAttribute('height', h); }
        if (frame) { frame.setAttribute('width', w); frame.setAttribute('height', h); }
      } else if (node.type === 'text') {
        const frame = el.querySelector('.text-frame');
        const fo = el.querySelector('.text-fo');
        if (frame) { frame.setAttribute('width', w); frame.setAttribute('height', h); }
        if (fo) { fo.setAttribute('width', w); fo.setAttribute('height', h); }
      } else {
        return; // 付箋はリサイズ非対応
      }

      repositionHandles(el, w, h);
      updateEdgesFor(id);
    },

    // 複数選択対応：選択枠(.selected)は選択中の全ノードに付与する。
    // リサイズハンドル(.solo-selected)は単一選択時のみ表示させる。
    selectNodes(ids) {
      const idSet = new Set(ids || []);
      const solo = idSet.size === 1 ? Array.from(idSet)[0] : null;
      _canvas.querySelectorAll('.node').forEach(el => {
        const id = el.dataset.id;
        el.classList.toggle('selected', idSet.has(id));
        el.classList.toggle('solo-selected', id === solo);
      });
    },

    // 後方互換：単一ノード選択（id が null/undefined なら選択解除）
    selectNode(id) {
      this.selectNodes(id ? [id] : []);
    },

    // ---- 矩形選択（ラバーバンド） ----

    showRubberBand(x, y, w, h) {
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.classList.add('rubber-band');
      rect.setAttribute('x', x);
      rect.setAttribute('y', y);
      rect.setAttribute('width', w);
      rect.setAttribute('height', h);
      _viewport.appendChild(rect);
      return rect;
    },

    updateRubberBand(el, x, y, w, h) {
      el.setAttribute('x', x);
      el.setAttribute('y', y);
      el.setAttribute('width', w);
      el.setAttribute('height', h);
    },

    hideRubberBand(el) {
      el?.remove();
    },

    // ---- コネクタ（エッジ） 公開API ----

    addEdge(edge) {
      const layer = _canvas.querySelector('#edges-layer');
      const el = makeEdgeEl(edge);
      if (el) layer.appendChild(el);
    },

    removeEdge(id) {
      _canvas.querySelector(`.edge[data-id="${id}"]`)?.remove();
    },

    selectEdge(id) {
      _canvas.querySelectorAll('.edge.selected').forEach(el => el.classList.remove('selected'));
      if (id) _canvas.querySelector(`.edge[data-id="${id}"]`)?.classList.add('selected');
    },

    updateEdgesFor(id) {
      updateEdgesFor(id);
    },

    // node.link の有無に合わせてリンクバッジ（右上の🔗マーク）を追加/更新/削除する
    updateLinkBadge(node) {
      if (!node) return;
      const el = _canvas.querySelector(`[data-id="${node.id}"]`);
      if (!el) return;
      let badge = el.querySelector('.link-badge');
      if (node.link) {
        if (!badge) el.appendChild(makeLinkBadge(node));
        else badge.setAttribute('x', node.width - 6);
      } else if (badge) {
        badge.remove();
      }
    },

    // node.style（fontSize / color / bold / align / 背景色）の変更を既存要素へ反映する
    // （テキストスタイル編集ポップオーバーの各ボタンから呼ばれる。
    //  付箋の背景・図形の塗り/枠線も反映する）
    updateNodeStyle(node) {
      if (!node) return;
      const el = _canvas.querySelector(`[data-id="${node.id}"]`);
      if (!el) return;

      if (node.type === 'sticky') {
        const bg = el.querySelector('.sticky-bg');
        if (bg && node.style.background) bg.setAttribute('fill', node.style.background);
      } else if (node.type === 'shape') {
        const bg = el.querySelector('.shape-bg');
        if (bg) {
          if (node.style.background) bg.setAttribute('fill', node.style.background);
          if (node.style.border) bg.setAttribute('stroke', node.style.border);
        }
      }

      const div = el.querySelector('.sticky-text') || el.querySelector('.shape-text') || el.querySelector('.text-content');
      if (!div) return;
      const defaultAlign = node.type === 'shape' ? 'center' : 'left';
      const defaultValign = node.type === 'shape' ? 'middle' : 'top';
      applyTextStyle(div, node.style, defaultAlign, defaultValign);
    },

    // テキストノードの文字divの実測高さを返す（サイズ変更後の自動高さ調整用）
    measureTextHeight(id) {
      const el = _canvas.querySelector(`[data-id="${id}"]`);
      const div = el && el.querySelector('.text-content');
      return div ? div.scrollHeight : 0;
    },

    startEditing(id, onSave) {
      const el = _canvas.querySelector(`[data-id="${id}"]`);
      if (!el) return;
      const fo = el.querySelector('.sticky-fo') || el.querySelector('.shape-fo') || el.querySelector('.text-fo');
      const div = el.querySelector('.sticky-text') || el.querySelector('.shape-text') || el.querySelector('.text-content');
      if (!fo || !div) return;
      startEditingEl(fo, div, onSave);
    },

    // IO.exportSVG から使う：保存するSVGがキャンバスと同じDOM（foreignObject等）になるよう公開する
    makeNodeEl(node) { return makeNodeEl(node); }
  };
})();
