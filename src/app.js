'use strict';

(() => {
  const canvas = document.getElementById('canvas');
  View.init(canvas);

  const saved = IO.load();
  if (saved?.nodes?.length) {
    Model.setNodes(saved.nodes);
    Model.setEdges(saved.edges || []);
    View.renderAll(Model.getNodes());
  }
  if (saved?.viewport) View.setViewport(saved.viewport);

  // ---- 自動保存のデバウンス（パン・ズームなど連続発火するイベント用） ----

  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => IO.save(), 300);
  }

  // ---- ズーム率表示 ----

  const zoomLabel = document.getElementById('zoom-label');
  function updateZoomLabel() {
    zoomLabel.textContent = Math.round(View.getViewport().zoom * 100) + '%';
  }
  updateZoomLabel();

  // ---- ツールバー ----

  document.getElementById('btn-add-sticky').addEventListener('click', () => {
    const node = Model.addSticky();
    View.addNode(node);
    Model.select(node.id);
    View.selectNode(node.id);
    View.selectEdge(null);
    IO.save();
  });

  ['rect', 'ellipse', 'diamond'].forEach(shape => {
    document.getElementById(`btn-add-${shape}`).addEventListener('click', () => {
      const node = Model.addShape(shape);
      View.addNode(node);
      Model.select(node.id);
      View.selectNode(node.id);
      View.selectEdge(null);
      IO.save();
    });
  });

  // ---- 画像の追加（共通処理） ----

  // File を読み込んで Base64 化し、自然サイズを取得した上でノードとして追加する。
  // x, y を指定すると、その点を中心に配置する（ドロップ位置・ペースト位置用）。
  function loadImageFile(file, x, y) {
    if (!file || !file.type || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = e => {
      const src = e.target.result;
      const img = new Image();
      img.onload = () => {
        const node = Model.addImage(src, img.naturalWidth, img.naturalHeight, x, y);
        View.addNode(node);
        Model.select(node.id);
        View.selectNode(node.id);
        View.selectEdge(null);
        IO.save();
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  }

  document.getElementById('btn-image').addEventListener('change', e => {
    Array.from(e.target.files).forEach(file => loadImageFile(file));
    e.target.value = '';
  });

  // ---- 画像のドラッグ&ドロップ ----

  // dragover を preventDefault しないとブラウザがファイルを開いてしまう
  document.addEventListener('dragover', e => e.preventDefault());

  document.addEventListener('drop', e => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files || !files.length) return;
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (!imageFiles.length) return;
    const pt = View.svgPoint(e);
    // 複数ファイルは少しずつ位置をずらして重なりを避ける
    imageFiles.forEach((file, i) => loadImageFile(file, pt.x + i * 24, pt.y + i * 24));
  });

  // ---- 画像のペースト ----

  document.addEventListener('paste', e => {
    if (editing) return; // テキスト編集中はブラウザ標準のペーストに任せる
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = Array.from(items)
      .filter(it => it.type && it.type.startsWith('image/'))
      .map(it => it.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    // キャンバス中央付近（ワールド座標）に配置する
    const center = View.canvasCenter();
    files.forEach((file, i) => loadImageFile(file, center.x + i * 24, center.y + i * 24));
  });

  // ---- コネクタ（接続モード） ----

  const btnConnector = document.getElementById('btn-connector');
  let connectMode = false;
  let connectFrom = null;

  function setConnectMode(on) {
    connectMode = on;
    connectFrom = null;
    btnConnector.classList.toggle('active', on);
    canvas.classList.toggle('connecting', on);
  }

  btnConnector.addEventListener('click', () => setConnectMode(!connectMode));

  document.getElementById('btn-export').addEventListener('click', () => IO.exportSVG());

  document.getElementById('btn-import').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    IO.importSVG(file, data => {
      Model.setNodes(data.nodes || []);
      Model.setEdges(data.edges || []);
      View.renderAll(Model.getNodes());
      View.selectNode(null);
      View.selectEdge(null);
      View.setViewport(data.viewport || { x: 0, y: 0, zoom: 1 });
      updateZoomLabel();
      IO.save();
    });
    e.target.value = '';
  });

  // ---- ズームリセット / 全体表示 ----

  document.getElementById('btn-zoom-reset').addEventListener('click', () => {
    View.setViewport({ x: 0, y: 0, zoom: 1 });
    updateZoomLabel();
    IO.save();
  });

  document.getElementById('btn-zoom-fit').addEventListener('click', () => {
    const nodes = Model.getNodes();
    const r = canvas.getBoundingClientRect();
    if (!nodes.length) {
      View.setViewport({ x: 0, y: 0, zoom: 1 });
      updateZoomLabel();
      IO.save();
      return;
    }
    const PAD = 60;
    const minX = Math.min(...nodes.map(n => n.x)) - PAD;
    const minY = Math.min(...nodes.map(n => n.y)) - PAD;
    const maxX = Math.max(...nodes.map(n => n.x + n.width)) + PAD;
    const maxY = Math.max(...nodes.map(n => n.y + n.height)) + PAD;
    const bw = maxX - minX;
    const bh = maxY - minY;
    let zoom = Math.min(r.width / bw, r.height / bh);
    zoom = Math.min(5, Math.max(0.1, zoom));
    const x = r.width / 2 - (minX + bw / 2) * zoom;
    const y = r.height / 2 - (minY + bh / 2) * zoom;
    View.setViewport({ x, y, zoom });
    updateZoomLabel();
    IO.save();
  });

  // ---- ホイールでズーム（カーソル位置を中心に拡大縮小） ----

  const ZOOM_MIN = 0.1;
  const ZOOM_MAX = 5;
  const ZOOM_STEP = 1.1;

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const vp = View.getViewport();
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, vp.zoom * factor));
    if (newZoom === vp.zoom) return;

    const r = canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    // ズーム前にカーソルがあったワールド座標を求め、ズーム後も同じ画面位置に来るよう
    // translate (x, y) を再計算する
    const wx = (sx - vp.x) / vp.zoom;
    const wy = (sy - vp.y) / vp.zoom;
    const x = sx - wx * newZoom;
    const y = sy - wy * newZoom;

    View.setViewport({ x, y, zoom: newZoom });
    updateZoomLabel();
    scheduleSave();
  }, { passive: false });

  // ---- パン（空白ドラッグ / Spaceキー押下中のドラッグ / 中ボタンドラッグ） ----

  let pan = null;
  let spacePressed = false;
  const PAN_CLICK_THRESHOLD = 3; // これ未満の移動は「クリック」（選択解除）とみなす

  function onPanMove(e) {
    const dx = e.clientX - pan.startX;
    const dy = e.clientY - pan.startY;
    if (Math.abs(dx) > PAN_CLICK_THRESHOLD || Math.abs(dy) > PAN_CLICK_THRESHOLD) pan.moved = true;
    View.setViewport({ x: pan.origX + dx, y: pan.origY + dy, zoom: pan.origZoom });
  }

  function onPanUp() {
    if (pan && pan.deselectOnClick && !pan.moved) {
      Model.select(null);
      View.selectNode(null);
      View.selectEdge(null);
    }
    if (pan && pan.moved) scheduleSave();
    pan = null;
    canvas.classList.remove('panning');
    document.removeEventListener('mousemove', onPanMove);
    document.removeEventListener('mouseup', onPanUp);
  }

  function startPan(e, deselectOnClick) {
    e.preventDefault();
    const vp = View.getViewport();
    pan = {
      startX: e.clientX, startY: e.clientY,
      origX: vp.x, origY: vp.y, origZoom: vp.zoom,
      moved: false, deselectOnClick: !!deselectOnClick
    };
    canvas.classList.add('panning');
    document.addEventListener('mousemove', onPanMove);
    document.addEventListener('mouseup', onPanUp);
  }

  // ---- ドラッグ & リサイズ ----

  let drag = null;
  let resize = null;
  let editing = false;

  const MIN_SIZE = 40;

  function calcResize(dir, dx, dy, oX, oY, oW, oH, keepAspect) {
    let x = oX, y = oY, w = oW, h = oH;

    // Shift 押下時（角ハンドルのみ）: 元の縦横比を保ったままリサイズする
    if (keepAspect && dir.length === 2) {
      const aspect = oW / oH;
      let nw, nh;
      if (Math.abs(dx) > Math.abs(dy)) {
        nw = dir.includes('w') ? oW - dx : oW + dx;
        nw = Math.max(MIN_SIZE, nw);
        nh = nw / aspect;
      } else {
        nh = dir.includes('n') ? oH - dy : oH + dy;
        nh = Math.max(MIN_SIZE, nh);
        nw = nh * aspect;
      }
      x = dir.includes('w') ? oX + oW - nw : oX;
      y = dir.includes('n') ? oY + oH - nh : oY;
      return { x, y, w: nw, h: nh };
    }

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
      const { x, y, w, h } = calcResize(resize.dir, dx, dy, resize.origX, resize.origY, resize.origW, resize.origH, e.shiftKey);
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

    // ---- 接続モード中：ドラッグやリサイズは発生させず、ノードクリックのみ処理 ----
    if (connectMode) {
      const targetEl = e.target.closest('.node');
      if (!targetEl) { setConnectMode(false); return; } // 空白クリックでモード解除
      const id = targetEl.dataset.id;
      if (!connectFrom) {
        connectFrom = id;
      } else if (connectFrom !== id) {
        const edge = Model.addEdge(connectFrom, id);
        if (edge) {
          View.addEdge(edge);
          IO.save();
        }
        setConnectMode(false);
      }
      return;
    }

    // ---- パン：中ボタン、または Space キー押下中は対象を問わずドラッグでパンする ----
    if (e.button === 1 || spacePressed) {
      startPan(e, false);
      return;
    }

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

    // ---- コネクタ（エッジ）のクリック選択 ----
    const edgeEl = e.target.closest('.edge');
    if (edgeEl) {
      e.preventDefault();
      const id = edgeEl.dataset.id;
      Model.selectEdge(id);
      View.selectNode(null);
      View.selectEdge(id);
      return;
    }

    const nodeEl = e.target.closest('.node');
    if (!nodeEl) {
      // 空白ドラッグ：そのままパン候補として開始する。
      // 移動量がほぼ0のままマウスアップした場合のみ「クリックで選択解除」を行う（従来の挙動を維持）。
      startPan(e, true);
      return;
    }

    e.preventDefault();
    const id = nodeEl.dataset.id;
    Model.select(id);
    View.selectNode(id);
    View.selectEdge(null);

    const node = Model.findById(id);
    const pt = View.svgPoint(e);
    drag = { id, ox: pt.x - node.x, oy: pt.y - node.y };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  // ---- ダブルクリックでテキスト編集 ----

  canvas.addEventListener('dblclick', e => {
    if (connectMode) return;
    const nodeEl = e.target.closest('.node');
    if (!nodeEl) return;

    // 画像ノードはテキスト編集を持たないため対象外にする
    const targetNode = Model.findById(nodeEl.dataset.id);
    if (targetNode && targetNode.type === 'image') return;

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

  // ---- Space キー押下中はパン待機状態にする ----

  document.addEventListener('keydown', e => {
    if (e.code !== 'Space' || spacePressed || editing) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    spacePressed = true;
    canvas.classList.add('pan-ready');
    e.preventDefault(); // ページスクロールを防ぐ
  });

  document.addEventListener('keyup', e => {
    if (e.code !== 'Space') return;
    spacePressed = false;
    canvas.classList.remove('pan-ready');
  });

  // ---- Delete / Backspace キーで削除 ----

  document.addEventListener('keydown', e => {
    // Esc で接続モードを解除
    if (e.key === 'Escape' && connectMode) {
      setConnectMode(false);
      return;
    }

    if (editing) return;
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;

    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    e.preventDefault();
    const removed = Model.removeSelected();
    if (!removed) return;

    if (removed.type === 'node') {
      View.removeNode(removed.id);
      removed.edgeIds.forEach(eid => View.removeEdge(eid));
    } else {
      View.removeEdge(removed.id);
    }
    View.selectNode(null);
    View.selectEdge(null);
    IO.save();
  });
})();
