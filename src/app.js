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

  // ---- Undo/Redo（操作履歴） ----
  // nodes/edges のみを対象にスナップショットを積む。viewport・選択状態は対象外。
  // 読み込み直後の状態（saved があればそれ、なければ空の状態）を必ず基点として記録する。
  History.init(
    () => ({ nodes: Model.getNodes(), edges: Model.getEdges() }),
    state => {
      Model.setNodes(state.nodes);
      Model.setEdges(state.edges);
      View.renderAll(Model.getNodes());
      View.selectNodes([]);
      View.selectEdge(null);
      IO.save();
    }
  );

  const btnUndo = document.getElementById('btn-undo');
  const btnRedo = document.getElementById('btn-redo');

  // 元に戻す/やり直すボタンの活性状態を最新の履歴に合わせて更新する
  function updateHistoryButtons() {
    btnUndo.disabled = !History.canUndo();
    btnRedo.disabled = !History.canRedo();
  }
  updateHistoryButtons();

  // 操作を確定するたびに呼ぶ：履歴に積んでから保存する
  function commit() {
    History.push();
    IO.save();
    updateHistoryButtons();
  }

  function performUndo() {
    if (editing) return; // テキスト編集中はブラウザ標準のundoに任せる（横取りしない）
    if (connectMode) { setConnectMode(false); return; } // 接続モード中はまずモード解除のみ行う
    if (History.undo()) updateHistoryButtons();
  }

  function performRedo() {
    if (editing) return;
    if (connectMode) { setConnectMode(false); return; }
    if (History.redo()) updateHistoryButtons();
  }

  btnUndo.addEventListener('click', performUndo);
  btnRedo.addEventListener('click', performRedo);

  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = e.key.toLowerCase();
    const isUndo = key === 'z' && !e.shiftKey;
    const isRedo = (key === 'z' && e.shiftKey) || key === 'y';
    if (!isUndo && !isRedo) return;

    // 入力欄にフォーカスがある場合はブラウザ標準のundo/redoに任せる
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    e.preventDefault();
    if (isUndo) performUndo();
    else performRedo();
  });

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
    commit();
  });

  ['rect', 'ellipse', 'diamond'].forEach(shape => {
    document.getElementById(`btn-add-${shape}`).addEventListener('click', () => {
      const node = Model.addShape(shape);
      View.addNode(node);
      Model.select(node.id);
      View.selectNode(node.id);
      View.selectEdge(null);
      commit();
    });
  });

  // ---- テキストノードの追加 ----
  // 背景・枠のない空のテキストノードは見えないため、追加直後にそのまま編集モードへ入る。
  // 履歴・保存への反映は編集確定（finishNodeEdit → commit）まで行わない
  // （キャンセルされた場合に空ノードの痕跡を履歴に残さないため）。
  document.getElementById('btn-add-text').addEventListener('click', () => {
    const node = Model.addText();
    View.addNode(node);
    Model.select(node.id);
    View.selectNode(node.id);
    View.selectEdge(null);
    editing = true;
    View.startEditing(node.id, (content, scrollHeight) => finishNodeEdit(node.id, content, scrollHeight));
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
        commit();
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
      commit();
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
  let rubberBand = null; // 矩形選択（Shift+空白ドラッグ）の状態

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
      // 選択中の全ノードを同じ移動量で動かす（グループ移動）。単一選択時は従来どおり1つだけ動く
      const dx = pt.x - drag.startX;
      const dy = pt.y - drag.startY;
      drag.ids.forEach(id => {
        const orig = drag.origins[id];
        if (!orig) return;
        const x = orig.x + dx;
        const y = orig.y + dy;
        Model.updatePosition(id, x, y);
        View.moveNode(id, x, y);
      });
    }
  }

  function onMouseUp() {
    if (drag || resize) { commit(); drag = null; resize = null; }
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }

  // ---- 矩形選択（ラバーバンド） ----

  function rectsIntersect(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  function onRubberMove(e) {
    const pt = View.svgPoint(e);
    const x = Math.min(rubberBand.startX, pt.x);
    const y = Math.min(rubberBand.startY, pt.y);
    const w = Math.abs(pt.x - rubberBand.startX);
    const h = Math.abs(pt.y - rubberBand.startY);
    rubberBand.rect = { x, y, w, h };
    View.updateRubberBand(rubberBand.el, x, y, w, h);
  }

  function onRubberUp() {
    const { x, y, w, h } = rubberBand.rect;
    const ids = Model.getNodes()
      .filter(n => rectsIntersect(x, y, w, h, n.x, n.y, n.width, n.height))
      .map(n => n.id);
    Model.selectMany(ids);
    View.selectNodes(ids);
    View.selectEdge(null);

    View.hideRubberBand(rubberBand.el);
    rubberBand = null;
    document.removeEventListener('mousemove', onRubberMove);
    document.removeEventListener('mouseup', onRubberUp);
  }

  function startRubberBand(e) {
    e.preventDefault();
    const pt = View.svgPoint(e);
    rubberBand = {
      startX: pt.x, startY: pt.y,
      rect: { x: pt.x, y: pt.y, w: 0, h: 0 },
      el: View.showRubberBand(pt.x, pt.y, 0, 0)
    };
    document.addEventListener('mousemove', onRubberMove);
    document.addEventListener('mouseup', onRubberUp);
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
          commit();
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
      // Shift+空白ドラッグ：矩形選択（ラバーバンド）
      if (e.shiftKey) {
        startRubberBand(e);
        return;
      }
      // 空白ドラッグ：そのままパン候補として開始する。
      // 移動量がほぼ0のままマウスアップした場合のみ「クリックで選択解除」を行う（従来の挙動を維持）。
      startPan(e, true);
      return;
    }

    e.preventDefault();
    const id = nodeEl.dataset.id;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;

    if (additive) {
      // Shift/Ctrl+クリック：選択への追加・解除トグル
      Model.toggleSelect(id);
    } else if (!Model.isSelected(id)) {
      // 通常クリック：そのノードのみ選択
      Model.select(id);
    }
    // else: 既に選択済みのノードを通常クリック → グループドラッグのため選択を維持する

    View.selectNodes(Model.getSelectedIds());
    View.selectEdge(null);

    // Shift+クリックで選択解除された（今クリックしたノードが未選択になった）場合はドラッグを開始しない
    if (!Model.isSelected(id)) return;

    const pt = View.svgPoint(e);
    const ids = Model.getSelectedIds();
    const origins = {};
    ids.forEach(nid => {
      const n = Model.findById(nid);
      if (n) origins[nid] = { x: n.x, y: n.y };
    });
    drag = { ids, startX: pt.x, startY: pt.y, origins };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  // ---- テキスト編集の確定処理（sticky / shape / text 共通） ----

  // テキストノードのみ特別扱い：内容が空なら残さず削除し、
  // 内容が入力欄の高さを超えていれば高さを自動で伸ばす。
  function finishNodeEdit(id, content, scrollHeight) {
    const node = Model.findById(id);
    if (node && node.type === 'text' && content.trim() === '') {
      // 空のテキストノードは残さない
      const removed = Model.removeNode(id);
      if (removed) {
        removed.nodeIds.forEach(nid => View.removeNode(nid));
        removed.edgeIds.forEach(eid => View.removeEdge(eid));
        View.selectNodes([]);
        View.selectEdge(null);
      }
    } else {
      Model.updateContent(id, content);
      if (node && node.type === 'text' && scrollHeight && scrollHeight > node.height) {
        Model.updateSize(id, node.width, scrollHeight);
        View.resizeNode(id, node.width, node.height);
      }
    }
    commit(); // 内容が変わっていなければ History.push() 内の重複判定で履歴には積まれない
    editing = false;
  }

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
    const id = nodeEl.dataset.id;
    View.startEditing(id, (content, scrollHeight) => finishNodeEdit(id, content, scrollHeight));
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
    // Esc：右クリックメニュー表示中はそれを閉じる。次に接続モード中はそちらを優先して解除。それ以外は選択解除
    if (e.key === 'Escape') {
      if (contextMenu.classList.contains('open')) { hideContextMenu(); return; }
      if (connectMode) { setConnectMode(false); return; }
      if (!editing) {
        Model.clearSelection();
        View.selectNodes([]);
        View.selectEdge(null);
      }
      return;
    }

    if (editing) return;

    const tag = document.activeElement?.tagName;

    // Ctrl/Cmd+A：全ノード選択
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      const ids = Model.getNodes().map(n => n.id);
      Model.selectMany(ids);
      View.selectNodes(ids);
      View.selectEdge(null);
      return;
    }

    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    e.preventDefault();
    deleteSelected();
  });

  // ---- 選択中のノード/エッジを削除する（Deleteキー・右クリックメニュー共通処理） ----

  function deleteSelected() {
    const removed = Model.removeSelected();
    if (!removed) return;

    removed.nodeIds.forEach(id => View.removeNode(id));
    removed.edgeIds.forEach(id => View.removeEdge(id));
    View.selectNodes([]);
    View.selectEdge(null);
    commit();
  }

  // ---- 重なり順（Z順）の変更 ----
  // Model.bringToFront/sendToBack/bringForward/sendBackward はいずれも
  // 配列順（= 重なり順）を書き換えて変化の有無（true/false）を返す。
  // 変化があった場合のみ View 側の並べ替えと commit（履歴・保存）を行う。

  function reorderSelection(action) {
    const ids = Model.getSelectedIds();
    if (!ids.length) return;
    const changed = Model[action](ids);
    if (changed) {
      View.reorderNodes(Model.getNodes());
      commit();
    }
  }

  // キーボード：Ctrl/Cmd+] 前面へ、Ctrl/Cmd+[ 背面へ、Shift併用で最前面/最背面へ。
  // 日本語キーボードでも動作するよう e.code（物理キー）と e.key（文字。Shift併用時は } / { になる）の両方を見る。
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (editing || connectMode) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    const isRight = e.code === 'BracketRight' || e.key === ']' || e.key === '}';
    const isLeft = e.code === 'BracketLeft' || e.key === '[' || e.key === '{';
    if (!isRight && !isLeft) return;

    e.preventDefault();
    if (isRight) reorderSelection(e.shiftKey ? 'bringToFront' : 'bringForward');
    else reorderSelection(e.shiftKey ? 'sendToBack' : 'sendBackward');
  });

  // ---- 右クリックメニュー（重なり順の変更・削除） ----

  const contextMenu = document.getElementById('context-menu');

  function hideContextMenu() {
    contextMenu.classList.remove('open');
  }

  function showContextMenu(x, y) {
    contextMenu.style.left = x + 'px';
    contextMenu.style.top = y + 'px';
    contextMenu.classList.add('open');
  }

  canvas.addEventListener('contextmenu', e => {
    // テキスト編集中はブラウザ標準の右クリックメニュー（コピー/ペースト等）に任せる
    if (editing) return;
    e.preventDefault();
    if (connectMode) return;

    const nodeEl = e.target.closest('.node');
    if (!nodeEl) { hideContextMenu(); return; } // 空白の右クリックはブラウザ標準メニューを抑止するのみ

    const id = nodeEl.dataset.id;
    // 右クリックしたノードが未選択なら、そのノードのみ選択してからメニューを出す。
    // 既に選択中（複数選択の一部含む）ならそのまま選択状態を維持する。
    if (!Model.isSelected(id)) {
      Model.select(id);
      View.selectNodes(Model.getSelectedIds());
      View.selectEdge(null);
    }
    showContextMenu(e.clientX, e.clientY);
  });

  contextMenu.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const action = btn.dataset.action;
    hideContextMenu();

    if (action === 'delete') { deleteSelected(); return; }

    const ACTION_MAP = { front: 'bringToFront', forward: 'bringForward', backward: 'sendBackward', back: 'sendToBack' };
    reorderSelection(ACTION_MAP[action]);
  });

  // メニュー外クリック・スクロール・ホイールズームで閉じる
  document.addEventListener('mousedown', e => {
    if (contextMenu.classList.contains('open') && !contextMenu.contains(e.target)) hideContextMenu();
  });
  document.addEventListener('scroll', hideContextMenu, true);
  canvas.addEventListener('wheel', hideContextMenu);
})();
