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

  // ---- 空状態のヒント ----

  function makeEmptyHint(canvasEl) {
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
    text.textContent = '「+ 付箋」ボタンで付箋を追加できます';

    g.appendChild(text);
    return g;
  }

  function updateEmptyHint() {
    const hint = _canvas.getElementById ? _canvas.querySelector('#empty-hint') : null;
    if (hint) hint.style.display = Model.getNodes().length === 0 ? '' : 'none';
  }

  // ---- 公開API ----

  return {
    init(canvasEl) {
      _canvas = canvasEl;

      // ドットグリッド背景
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

      _canvas.appendChild(makeEmptyHint(_canvas));
    },

    svgPoint(e) {
      const r = _canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    },

    renderAll(nodes) {
      _canvas.querySelectorAll('.node').forEach(el => el.remove());
      nodes.forEach(n => { if (n.type === 'sticky') _canvas.appendChild(makeStickyEl(n)); });
      updateEmptyHint();
    },

    addNode(node) {
      if (node.type === 'sticky') _canvas.appendChild(makeStickyEl(node));
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

    selectNode(id) {
      _canvas.querySelectorAll('.node.selected').forEach(el => el.classList.remove('selected'));
      if (id) _canvas.querySelector(`[data-id="${id}"]`)?.classList.add('selected');
    },

    startEditing(id, onSave) {
      const el = _canvas.querySelector(`[data-id="${id}"]`);
      if (!el) return;
      const fo = el.querySelector('.sticky-fo');
      const div = el.querySelector('.sticky-text');

      fo.style.pointerEvents = 'auto';
      div.contentEditable = 'true';
      div.focus();

      // カーソルを末尾へ
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
        if (e.key === 'Escape') {
          e.preventDefault();
          div.blur();
        }
        // Enter: <br>を挿入して改行（<div>生成を防ぐ）
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
  };
})();
