'use strict';

(() => {
  const canvas = document.getElementById('canvas');
  View.init(canvas);

  const saved = IO.load();
  if (saved?.nodes?.length) {
    Model.setNodes(saved.nodes);
    View.renderAll(Model.getNodes());
  }

  // ---- ツールバー ----

  document.getElementById('btn-add-sticky').addEventListener('click', () => {
    const node = Model.addSticky();
    View.addNode(node);
    Model.select(node.id);
    View.selectNode(node.id);
    IO.save();
  });

  ['rect', 'ellipse', 'diamond'].forEach(shape => {
    document.getElementById(`btn-add-${shape}`).addEventListener('click', () => {
      const node = Model.addShape(shape);
      View.addNode(node);
      Model.select(node.id);
      View.selectNode(node.id);
      IO.save();
    });
  });

  document.getElementById('btn-export').addEventListener('click', () => IO.exportSVG());

  document.getElementById('btn-import').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    IO.importSVG(file, data => {
      Model.setNodes(data.nodes || []);
      View.renderAll(Model.getNodes());
      View.selectNode(null);
      IO.save();
    });
    e.target.value = '';
  });

  // ---- ドラッグ & リサイズ ----

  let drag = null;
  let resize = null;
  let editing = false;

  const MIN_SIZE = 40;

  function calcResize(dir, dx, dy, oX, oY, oW, oH) {
    let x = oX, y = oY, w = oW, h = oH;

    if (dir === 'nw' || dir === 'w' || dir === 'sw') {
      const nw = oW - dx;
      if (nw < MIN_SIZE) { x = oX + oW - MIN_SIZE; w = MIN_SIZE; }
      else { x = oX + dx; w = nw; }
    }
    if (dir === 'ne' || dir === 'e' || dir === 'se') {
      w = Math.max(MIN_SIZE, oW + dx);
    }
    if (dir === 'nw' || dir === 'n' || dir === 'ne') {
      const nh = oH - dy;
      if (nh < MIN_SIZE) { y = oY + oH - MIN_SIZE; h = MIN_SIZE; }
      else { y = oY + dy; h = nh; }
    }
    if (dir === 'sw' || dir === 's' || dir === 'se') {
      h = Math.max(MIN_SIZE, oH + dy);
    }

    return { x, y, w, h };
  }

  function onMouseMove(e) {
    const pt = View.svgPoint(e);

    if (resize) {
      const dx = pt.x - resize.startX;
      const dy = pt.y - resize.startY;
      const { x, y, w, h } = calcResize(resize.dir, dx, dy, resize.origX, resize.origY, resize.origW, resize.origH);
      Model.updatePosition(resize.id, x, y);
      Model.updateSize(resize.id, w, h);
      View.moveNode(resize.id, x, y);
      View.resizeNode(resize.id, w, h);
      return;
    }

    if (drag) {
      const x = pt.x - drag.ox;
      const y = pt.y - drag.oy;
      Model.updatePosition(drag.id, x, y);
      View.moveNode(drag.id, x, y);
    }
  }

  function onMouseUp() {
    if (drag || resize) { IO.save(); drag = null; resize = null; }
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }

  canvas.addEventListener('mousedown', e => {
    if (editing) return;

    const handleEl = e.target.closest('.resize-handle');
    if (handleEl) {
      e.preventDefault();
      const nodeEl = handleEl.closest('.node');
      const id = nodeEl.dataset.id;
      const node = Model.findById(id);
      const pt = View.svgPoint(e);
      resize = {
        id, dir: handleEl.dataset.dir,
        startX: pt.x, startY: pt.y,
        origX: node.x, origY: node.y,
        origW: node.width, origH: node.height
      };
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      return;
    }

    const nodeEl = e.target.closest('.node');
    if (!nodeEl) {
      Model.select(null);
      View.selectNode(null);
      return;
    }

    e.preventDefault();
    const id = nodeEl.dataset.id;
    Model.select(id);
    View.selectNode(id);

    const node = Model.findById(id);
    const pt = View.svgPoint(e);
    drag = { id, ox: pt.x - node.x, oy: pt.y - node.y };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  // ---- ダブルクリックでテキスト編集 ----

  canvas.addEventListener('dblclick', e => {
    const nodeEl = e.target.closest('.node');
    if (!nodeEl) return;

    drag = null;
    resize = null;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);

    editing = true;
    View.startEditing(nodeEl.dataset.id, content => {
      Model.updateContent(nodeEl.dataset.id, content);
      IO.save();
      editing = false;
    });
  });

  // ---- Delete / Backspace キーで削除 ----

  document.addEventListener('keydown', e => {
    if (editing) return;
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;

    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    e.preventDefault();
    const id = Model.removeSelected();
    if (id) {
      View.removeNode(id);
      View.selectNode(null);
      IO.save();
    }
  });
})();
