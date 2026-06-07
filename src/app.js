'use strict';

(() => {
  const canvas = document.getElementById('canvas');
  View.init(canvas);

  // localStorageから復元
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

  document.getElementById('btn-export').addEventListener('click', () => {
    IO.exportSVG();
  });

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

  // ---- ドラッグ ----

  let drag = null;
  let editing = false;

  function onMouseMove(e) {
    if (!drag) return;
    const pt = View.svgPoint(e);
    const x = pt.x - drag.ox;
    const y = pt.y - drag.oy;
    Model.updatePosition(drag.id, x, y);
    View.moveNode(drag.id, x, y);
  }

  function onMouseUp() {
    if (drag) { IO.save(); drag = null; }
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }

  canvas.addEventListener('mousedown', e => {
    if (editing) return;

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

    // 入力フォーカスがある場合は無視
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
