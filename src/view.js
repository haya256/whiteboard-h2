'use strict';

const View = (() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XHTML_NS = 'http://www.w3.org/1999/xhtml';
  let _canvas;

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

    const div = document.createElementNS(XHTML_NS, 'div');
    div.classList.add('sticky-text');
    setTextContent(div, node.content);

    fo.appendChild(div);
    g.appendChild(rect);
    g.appendChild(fo);
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
    wrap.className = 'shape-text-wrap';

    const div = document.createElementNS(XHTML_NS, 'div');
    div.className = 'shape-text';
    setTextContent(div, node.content);

    wrap.appendChild(div);
    fo.appendChild(wrap);
    g.appendChild(fo);

    makeResizeHandles(w, h).forEach(el => g.appendChild(el));
    return g;
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
      div.contentEditable = 'false';
      fo.style.pointerEvents = 'none';
      onSave(getTextContent(div));
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

      _canvas.appendChild(makeEmptyHint());
    },

    svgPoint(e) {
      const r = _canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    },

    renderAll(nodes) {
      _canvas.querySelectorAll('.node').forEach(el => el.remove());
      nodes.forEach(n => {
        if (n.type === 'sticky') _canvas.appendChild(makeStickyEl(n));
        else if (n.type === 'shape') _canvas.appendChild(makeShapeEl(n));
      });
      updateEmptyHint();
    },

    addNode(node) {
      if (node.type === 'sticky') _canvas.appendChild(makeStickyEl(node));
      else if (node.type === 'shape') _canvas.appendChild(makeShapeEl(node));
      updateEmptyHint();
    },

    removeNode(id) {
      _canvas.querySelector(`[data-id="${id}"]`)?.remove();
      updateEmptyHint();
    },

    moveNode(id, x, y) {
      const el = _canvas.querySelector(`[data-id="${id}"]`);
      if (el) el.setAttribute('transform', `translate(${x},${y})`);
    },

    resizeNode(id, w, h) {
      const el = _canvas.querySelector(`[data-id="${id}"]`);
      if (!el) return;
      const node = Model.findById(id);
      if (!node || node.type !== 'shape') return;

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

      repositionHandles(el, w, h);
    },

    selectNode(id) {
      _canvas.querySelectorAll('.node.selected').forEach(el => el.classList.remove('selected'));
      if (id) _canvas.querySelector(`[data-id="${id}"]`)?.classList.add('selected');
    },

    startEditing(id, onSave) {
      const el = _canvas.querySelector(`[data-id="${id}"]`);
      if (!el) return;
      const fo = el.querySelector('.sticky-fo') || el.querySelector('.shape-fo');
      const div = el.querySelector('.sticky-text') || el.querySelector('.shape-text');
      if (!fo || !div) return;
      startEditingEl(fo, div, onSave);
    }
  };
})();
