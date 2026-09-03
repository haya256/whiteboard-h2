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

  // ---- ボード名（ツールバー表示・クリックで編集・ファイル名/タブ名に反映） ----
  // タイトルは Undo 履歴の対象外（History.push の対象は nodes/edges のみ）。

  const boardNameEl = document.getElementById('board-name');
  const boardNameInput = document.getElementById('board-name-input');

  function renderBoardName() {
    boardNameEl.textContent = Model.getTitle();
    document.title = Model.getTitle() + ' - openboard（仮）';
  }

  // 保存済みデータにタイトルがあれば復元する。旧データは title が固定値 'ボード' なので
  // それは「未設定」とみなし既定のボード名のままにする
  if (typeof saved?.meta?.title === 'string' && saved.meta.title.trim() && saved.meta.title !== 'ボード') {
    Model.setTitle(saved.meta.title);
  }
  renderBoardName();

  function startBoardNameEdit() {
    boardNameInput.value = Model.getTitle();
    boardNameEl.hidden = true;
    boardNameInput.hidden = false;
    boardNameInput.focus();
    boardNameInput.select();
  }

  function finishBoardNameEdit(commitValue) {
    if (commitValue) Model.setTitle(boardNameInput.value);
    boardNameInput.hidden = true;
    boardNameEl.hidden = false;
    renderBoardName();
    if (commitValue) IO.save(); // タイトルは undo 対象外なので commit() ではなく IO.save() のみ
  }

  boardNameEl.addEventListener('click', startBoardNameEdit);

  boardNameInput.addEventListener('keydown', e => {
    // 入力欄内のキー操作がキャンバス側のショートカット（Delete/Ctrl+A等）に
    // 横取りされないよう、常にバブリングを止める
    if (e.key === 'Enter') { e.preventDefault(); finishBoardNameEdit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finishBoardNameEdit(false); }
    e.stopPropagation();
  });

  boardNameInput.addEventListener('blur', () => {
    // Enter/Escapeで既に確定済み（hidden化済み）の場合は二重確定しない
    if (boardNameInput.hidden) return;
    finishBoardNameEdit(true);
  });

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
      closeLinkPopover(); // Undo/Redoでノードの状態が変わるためポップオーバーは閉じる
      refreshTextStylePopover(); // 選択は解除済みのため通常は閉じるだけになる
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

  // ---- リンク（ノードごとに1つ持てるURL） ----
  // ブラウザの prompt ダイアログはサンドボックス環境で無効化されることがあるため使わず、
  // ポップオーバー自身に「表示モード」「編集モード」の2状態を持たせて完結させる。

  const linkPopover = document.getElementById('link-popover');

  // ポップオーバー内でのクリック・キー操作がキャンバスのmousedown（選択解除・パン開始）や
  // ショートカットに伝播しないようにする
  linkPopover.addEventListener('mousedown', e => e.stopPropagation());

  // ポップオーバーを閉じる（表示モード・編集モードどちらでも呼べる）。
  // 他所クリック・Esc・ドラッグ開始・ノード削除・Undo/Redo・パン/ズームなど、
  // 表示位置やリンクの状態がずれうるタイミングで幅広く呼び出す（閉じるだけなので副作用は小さい）
  function closeLinkPopover() {
    linkPopover.classList.remove('open', 'editing');
    linkPopover.innerHTML = '';
  }

  // ポップオーバーをノード直下の画面座標に配置する
  function positionLinkPopover(node) {
    const pos = View.worldToScreen(node.x, node.y + node.height);
    linkPopover.style.left = Math.round(pos.x) + 'px';
    linkPopover.style.top = Math.round(pos.y + 6) + 'px';
  }

  // 指定ノードのリンクURLを表示モードのポップオーバーで表示する（ノード直下に配置）
  function showLinkPopover(nodeId) {
    const node = Model.findById(nodeId);
    const url = node && Model.getLink(nodeId);
    if (!node || !url) return;

    linkPopover.innerHTML = '';
    linkPopover.classList.remove('editing');

    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = url;
    a.textContent = url;

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.textContent = '✎ 編集';
    editBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      Model.select(nodeId);
      View.selectNodes([nodeId]);
      View.selectEdge(null);
      openLinkEditor(nodeId);
    });

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '✕ 解除';
    removeBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      Model.select(nodeId);
      removeLinkFromSelected();
    });

    linkPopover.appendChild(a);
    linkPopover.appendChild(editBtn);
    linkPopover.appendChild(removeBtn);

    positionLinkPopover(node);
    linkPopover.classList.add('open');
  }

  // 指定ノードのリンクを編集モードのポップオーバーで開く（URL入力欄 + 保存/キャンセル/[削除]）。
  // 右クリックメニュー「リンクを設定…/編集…」・Ctrl+K・表示モードの「✎ 編集」ボタンから共通で呼ぶ。
  function openLinkEditor(nodeId) {
    const node = Model.findById(nodeId);
    if (!node) return;
    const current = Model.getLink(nodeId) || '';

    linkPopover.innerHTML = '';
    linkPopover.classList.add('editing');

    const input = document.createElement('input');
    input.type = 'url';
    input.id = 'link-input';
    input.placeholder = 'https://...';
    input.value = current;
    input.autocomplete = 'off';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = '保存';
    saveBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      saveLinkEditor(nodeId, input.value);
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      cancelLinkEditor(nodeId);
    });

    // 入力欄内のキー操作（Delete/Backspace/Ctrl+Z/Ctrl+A/Ctrl+]/[ 等）が
    // キャンバス側のショートカットに横取りされないよう、常にバブリングを止める。
    // Enter で保存、Esc でキャンセル（キャンバス側のEscハンドラより先に処理し、伝播させない）
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); saveLinkEditor(nodeId, input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelLinkEditor(nodeId); }
    });

    linkPopover.appendChild(input);
    linkPopover.appendChild(saveBtn);
    linkPopover.appendChild(cancelBtn);

    // 既にリンクが設定済みの場合のみ「削除」ボタンを追加する
    if (current) {
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.textContent = '削除';
      deleteBtn.addEventListener('click', ev => {
        ev.stopPropagation();
        Model.select(nodeId);
        View.selectNodes([nodeId]);
        View.selectEdge(null);
        removeLinkFromSelected();
      });
      linkPopover.appendChild(deleteBtn);
    }

    positionLinkPopover(node);
    linkPopover.classList.add('open');
    input.focus();
    input.select();
  }

  // 単一選択中のノードに対して編集モードのポップオーバーを開く（右クリックメニュー・Ctrl+K共通）
  function openLinkEditorForSelection() {
    const id = Model.getSelectedId();
    if (!id) return;
    openLinkEditor(id);
  }

  // 編集モードの入力欄の内容を保存する。
  // http(s)://で始まらない入力は先頭にhttps://を補う。空にして保存した場合はリンクを削除する。
  // 元の値から変化がなければ commit しない
  function saveLinkEditor(nodeId, rawValue) {
    const node = Model.findById(nodeId);
    if (!node) { closeLinkPopover(); return; }
    const current = Model.getLink(nodeId) || '';
    const trimmed = (rawValue || '').trim();

    if (trimmed === '') {
      if (!current) { closeLinkPopover(); return; } // 元々未設定のまま→変化なし
      Model.setLink(nodeId, null);
      View.updateLinkBadge(node);
      closeLinkPopover();
      commit();
      return;
    }

    const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed;
    if (normalized === current) { closeLinkPopover(); return; } // 変化なし

    Model.setLink(nodeId, normalized);
    View.updateLinkBadge(node);
    closeLinkPopover();
    commit();
  }

  // 編集モードをキャンセルする。元々リンクがあれば表示モードへ戻し、なければそのまま閉じる
  function cancelLinkEditor(nodeId) {
    if (Model.getLink(nodeId)) showLinkPopover(nodeId);
    else closeLinkPopover();
  }

  // 選択中ノードのリンクを削除する（右クリックメニュー「リンクを削除」・ポップオーバーの削除系ボタン共通）
  function removeLinkFromSelected() {
    const id = Model.getSelectedId();
    if (!id || !Model.getLink(id)) return;
    Model.setLink(id, null);
    View.updateLinkBadge(Model.findById(id));
    closeLinkPopover();
    commit();
  }

  // Ctrl/Cmd+K：単一選択時のみ、リンク編集ポップオーバーを開く
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'k') return;
    if (editing) return; // テキスト編集中は無効
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (Model.getSelectedIds().length !== 1) return;
    e.preventDefault();
    openLinkEditorForSelection();
  });

  // ---- テキストスタイル編集ポップオーバー（文字サイズ・色・太字・横位置） ----
  // ノードを1つだけ選択している間、ノード上部に出す。対象は画像以外（sticky/shape/text）。
  // 生成・配置・イベントは全て refreshTextStylePopover() を起点にする（開閉と再配置を1関数に集約）。

  const textStylePopover = document.getElementById('text-style-popover');
  textStylePopover.addEventListener('mousedown', e => e.stopPropagation());

  const FONT_SIZE_STEPS = [12, 14, 18, 24, 32, 48];
  const TEXT_COLORS = ['#333333', '#757575', '#ffffff', '#e53935', '#fb8c00', '#43a047', '#1e88e5', '#8e24aa'];
  const ALIGN_LABELS = { left: '左揃え', center: '中央揃え', right: '右揃え' };
  // 横位置アイコン（3本の横棒。長さと位置で左/中央/右を表す）
  const ALIGN_ICONS = {
    left: '<svg viewBox="0 0 16 12" width="14" height="14"><rect x="1" y="1" width="14" height="2" fill="currentColor"/><rect x="1" y="5" width="9" height="2" fill="currentColor"/><rect x="1" y="9" width="12" height="2" fill="currentColor"/></svg>',
    center: '<svg viewBox="0 0 16 12" width="14" height="14"><rect x="1" y="1" width="14" height="2" fill="currentColor"/><rect x="3.5" y="5" width="9" height="2" fill="currentColor"/><rect x="2" y="9" width="12" height="2" fill="currentColor"/></svg>',
    right: '<svg viewBox="0 0 16 12" width="14" height="14"><rect x="1" y="1" width="14" height="2" fill="currentColor"/><rect x="6" y="5" width="9" height="2" fill="currentColor"/><rect x="4" y="9" width="12" height="2" fill="currentColor"/></svg>'
  };

  function closeTextStylePopover() {
    textStylePopover.classList.remove('open');
    textStylePopover.innerHTML = '';
  }

  function appendPopoverSeparator() {
    const sep = document.createElement('span');
    sep.className = 'tsp-sep';
    textStylePopover.appendChild(sep);
  }

  // ノードの上、画面上端に収まらない場合はノードの下（リンクポップオーバーと同じ位置）に回す
  function positionTextStylePopover(node) {
    const top = View.worldToScreen(node.x, node.y);
    const height = textStylePopover.offsetHeight;
    let y = top.y - height - 8;
    if (y < 0) {
      const bottom = View.worldToScreen(node.x, node.y + node.height);
      y = bottom.y + 8;
    }
    textStylePopover.style.left = Math.round(top.x) + 'px';
    textStylePopover.style.top = Math.round(y) + 'px';
  }

  // ポップオーバーの中身を生成する（サイズ / 色 / 太字 / 横位置）
  function buildTextStylePopover(node) {
    textStylePopover.innerHTML = '';
    const style = node.style || {};
    const fontSize = style.fontSize || 14;
    const bold = !!style.bold;
    const align = style.align || (node.type === 'shape' ? 'center' : 'left');
    const color = (style.color || '#333333').toLowerCase();

    // ---- 文字サイズ ----
    const sizeGroup = document.createElement('span');
    sizeGroup.className = 'tsp-group';

    const minusBtn = document.createElement('button');
    minusBtn.type = 'button';
    minusBtn.title = '文字を小さく';
    minusBtn.textContent = 'A−';

    const sizeLabel = document.createElement('span');
    sizeLabel.className = 'tsp-size-label';
    sizeLabel.textContent = fontSize;

    const plusBtn = document.createElement('button');
    plusBtn.type = 'button';
    plusBtn.title = '文字を大きく';
    plusBtn.textContent = 'A+';

    // 段階リストに現在値が無い場合：A+は直近の大きい値、A-は直近の小さい値へ移動する
    const idx = FONT_SIZE_STEPS.indexOf(fontSize);
    let smaller, larger;
    if (idx >= 0) {
      smaller = idx > 0 ? FONT_SIZE_STEPS[idx - 1] : null;
      larger = idx < FONT_SIZE_STEPS.length - 1 ? FONT_SIZE_STEPS[idx + 1] : null;
    } else {
      const below = FONT_SIZE_STEPS.filter(v => v < fontSize);
      const above = FONT_SIZE_STEPS.filter(v => v > fontSize);
      smaller = below.length ? below[below.length - 1] : null;
      larger = above.length ? above[0] : null;
    }
    minusBtn.disabled = smaller === null;
    plusBtn.disabled = larger === null;
    minusBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      if (smaller !== null) applyStylePatch(node.id, { fontSize: smaller });
    });
    plusBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      if (larger !== null) applyStylePatch(node.id, { fontSize: larger });
    });

    sizeGroup.appendChild(minusBtn);
    sizeGroup.appendChild(sizeLabel);
    sizeGroup.appendChild(plusBtn);
    textStylePopover.appendChild(sizeGroup);

    appendPopoverSeparator();

    // ---- 文字色（8色パレット） ----
    const colorGroup = document.createElement('span');
    colorGroup.className = 'tsp-group tsp-colors';
    TEXT_COLORS.forEach(c => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'tsp-swatch';
      if (c === '#ffffff') sw.classList.add('tsp-swatch-white');
      if (c.toLowerCase() === color) sw.classList.add('active');
      sw.style.background = c;
      sw.title = c;
      sw.addEventListener('click', ev => {
        ev.stopPropagation();
        applyStylePatch(node.id, { color: c });
      });
      colorGroup.appendChild(sw);
    });
    textStylePopover.appendChild(colorGroup);

    appendPopoverSeparator();

    // ---- 太字 ----
    const boldBtn = document.createElement('button');
    boldBtn.type = 'button';
    boldBtn.className = 'tsp-bold' + (bold ? ' active' : '');
    boldBtn.title = '太字（Ctrl+B）';
    boldBtn.textContent = 'B';
    boldBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      applyStylePatch(node.id, { bold: !bold });
    });
    textStylePopover.appendChild(boldBtn);

    // ---- 横位置（左/中央/右） ----
    const alignGroup = document.createElement('span');
    alignGroup.className = 'tsp-group';
    ['left', 'center', 'right'].forEach(a => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tsp-align' + (align === a ? ' active' : '');
      btn.title = ALIGN_LABELS[a];
      btn.innerHTML = ALIGN_ICONS[a];
      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        applyStylePatch(node.id, { align: a });
      });
      alignGroup.appendChild(btn);
    });
    textStylePopover.appendChild(alignGroup);
  }

  // 選択が「1ノードだけ・画像以外・編集中でない・ドラッグ/リサイズ中でない」なら
  // ポップオーバーを生成・配置して表示、それ以外は閉じる。
  // 選択確定・ズーム・パン終了・移動/リサイズ終了・スタイル変更後など、幅広い箇所から呼ぶ。
  function refreshTextStylePopover() {
    const ids = Model.getSelectedIds();
    if (ids.length !== 1 || editing || drag || resize) { closeTextStylePopover(); return; }
    const node = Model.findById(ids[0]);
    if (!node || node.type === 'image' || !node.style) { closeTextStylePopover(); return; }
    buildTextStylePopover(node);
    textStylePopover.classList.add('open');
    positionTextStylePopover(node);
  }

  // テキストノードの高さを内容に合わせて伸ばす（縮めない）。
  // finishNodeEdit・スタイル変更（サイズ/太字）の両方から使う共通処理
  function growToFitText(id) {
    const node = Model.findById(id);
    if (!node || node.type !== 'text') return;
    const h = View.measureTextHeight(id);
    if (h && h > node.height) {
      Model.updateSize(id, node.width, h);
      View.resizeNode(id, node.width, node.height);
    }
  }

  // ポップオーバーの各ボタン共通の適用処理：Model更新→View反映→（テキストのみ）高さ追従→履歴確定→再表示
  function applyStylePatch(id, patch) {
    const node = Model.findById(id);
    if (!node) return;
    Model.updateStyle(id, patch);
    View.updateNodeStyle(node);
    growToFitText(id);
    commit();
    refreshTextStylePopover();
  }

  // Ctrl/Cmd+B：編集中でなく単一選択（画像以外）のときのみ太字をトグルする
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'b') return;
    if (editing) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const ids = Model.getSelectedIds();
    if (ids.length !== 1) return;
    const node = Model.findById(ids[0]);
    if (!node || node.type === 'image' || !node.style) return;
    e.preventDefault();
    applyStylePatch(node.id, { bold: !node.style.bold });
  });

  // ---- ツールバー ----

  document.getElementById('btn-add-sticky').addEventListener('click', () => {
    const node = Model.addSticky();
    View.addNode(node);
    Model.select(node.id);
    View.selectNode(node.id);
    View.selectEdge(null);
    commit();
    refreshTextStylePopover();
  });

  ['rect', 'ellipse', 'diamond'].forEach(shape => {
    document.getElementById(`btn-add-${shape}`).addEventListener('click', () => {
      const node = Model.addShape(shape);
      View.addNode(node);
      Model.select(node.id);
      View.selectNode(node.id);
      View.selectEdge(null);
      commit();
      refreshTextStylePopover();
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

  // src（dataURL）と自然サイズからノードを追加する共通処理。
  // x, y を指定すると、その点を中心に配置する（ドロップ位置・ペースト位置用）。
  function addImageNode(src, width, height, x, y) {
    const node = Model.addImage(src, width, height, x, y);
    View.addNode(node);
    Model.select(node.id);
    View.selectNode(node.id);
    View.selectEdge(null);
    commit();
    refreshTextStylePopover(); // 画像は対象外だが、前の選択で開いていた場合は閉じる
  }

  // 圧縮に失敗した場合のフォールバック：無圧縮のまま読み込む（従来の挙動）
  function loadImageFileUncompressed(file, x, y) {
    const reader = new FileReader();
    reader.onload = e => {
      const src = e.target.result;
      const img = new Image();
      img.onload = () => {
        addImageNode(src, img.naturalWidth, img.naturalHeight, x, y);
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  }

  // File を ImageUtil.compress で圧縮してノードとして追加する（localStorage 容量節約のため）。
  // 圧縮に失敗した場合は loadImageFileUncompressed にフォールバックする。
  function loadImageFile(file, x, y) {
    if (!file || !file.type || !file.type.startsWith('image/')) return;
    ImageUtil.compress(file).then(({ src, width, height }) => {
      addImageNode(src, width, height, x, y);
    }).catch(() => {
      loadImageFileUncompressed(file, x, y);
    });
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
    IO.importSVG(file, (data, fileName) => {
      Model.setNodes(data.nodes || []);
      Model.setEdges(data.edges || []);
      View.renderAll(Model.getNodes());
      View.selectNode(null);
      View.selectEdge(null);
      View.setViewport(data.viewport || { x: 0, y: 0, zoom: 1 });
      updateZoomLabel();
      // ボード名はファイル名を優先し、なければメタデータのタイトルを使う
      const base = (fileName || '').replace(/\.svg$/i, '').trim();
      Model.setTitle(base || data.meta?.title || '');
      renderBoardName();
      commit();
      refreshTextStylePopover(); // 選択は解除済みのため閉じる
    });
    e.target.value = '';
  });

  // ---- ズームリセット / 全体表示 ----

  document.getElementById('btn-zoom-reset').addEventListener('click', () => {
    View.setViewport({ x: 0, y: 0, zoom: 1 });
    updateZoomLabel();
    IO.save();
    refreshTextStylePopover();
  });

  document.getElementById('btn-zoom-fit').addEventListener('click', () => {
    const nodes = Model.getNodes();
    const r = canvas.getBoundingClientRect();
    if (!nodes.length) {
      View.setViewport({ x: 0, y: 0, zoom: 1 });
      updateZoomLabel();
      IO.save();
      refreshTextStylePopover();
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
    refreshTextStylePopover();
  });

  // ---- ホイールでズーム（カーソル位置を中心に拡大縮小） ----

  const ZOOM_MIN = 0.1;
  const ZOOM_MAX = 5;
  const ZOOM_STEP = 1.1;

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    closeLinkPopover(); // ズームで表示位置がずれるため閉じる
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
    refreshTextStylePopover(); // リンク版と違い、閉じるだけでなく位置を出し直す
  }, { passive: false });

  // ---- パン（空白ドラッグ / Spaceキー押下中のドラッグ / 中ボタンドラッグ） ----

  let pan = null;
  let spacePressed = false;
  let suppressContextMenu = false; // 右ボタンドラッグでパンした直後の contextmenu を抑止する
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
    // 右ボタンドラッグでパンした場合は、mouseup 直後に発火する contextmenu を抑止する
    if (pan && pan.button === 2 && pan.moved) suppressContextMenu = true;
    pan = null;
    canvas.classList.remove('panning');
    document.removeEventListener('mousemove', onPanMove);
    document.removeEventListener('mouseup', onPanUp);
    refreshTextStylePopover(); // パンで表示位置がずれるため出し直す（クリックで選択解除した場合は閉じる）
  }

  function startPan(e, deselectOnClick) {
    e.preventDefault();
    closeTextStylePopover();
    const vp = View.getViewport();
    pan = {
      startX: e.clientX, startY: e.clientY,
      origX: vp.x, origY: vp.y, origZoom: vp.zoom,
      moved: false, deselectOnClick: !!deselectOnClick,
      button: e.button
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
      // 画面座標での移動量がしきい値を超えたら「ドラッグ」とみなす（クリックとの判定に使う）
      if (!drag.moved) {
        const cdx = e.clientX - drag.startClientX;
        const cdy = e.clientY - drag.startClientY;
        if (Math.abs(cdx) > PAN_CLICK_THRESHOLD || Math.abs(cdy) > PAN_CLICK_THRESHOLD) drag.moved = true;
      }
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
    // ドラッグせずクリックだけで終わった単一ノード（Shift/Ctrl修飾なし）なら、
    // リンクポップオーバーの表示対象候補として覚えておく（実際に出すのは commit 後）
    const clickedNodeId = (drag && !drag.moved && !drag.additive && drag.ids.length === 1)
      ? drag.ids[0] : null;
    if (drag || resize) { commit(); drag = null; resize = null; }
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    refreshTextStylePopover();
    if (clickedNodeId && Model.getLink(clickedNodeId)) showLinkPopover(clickedNodeId);
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
    refreshTextStylePopover();
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

    // ---- 右ボタンドラッグ：対象を問わずキャンバスのパンのみ（選択・移動はしない） ----
    if (e.button === 2) {
      startPan(e, false);
      return;
    }

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
      closeTextStylePopover(); // リサイズ開始
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
      refreshTextStylePopover(); // ノード選択が解除されるため閉じる
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
    closeTextStylePopover(); // ドラッグ開始（クリックのみだった場合は onMouseUp で出し直す）
    // moved: マウスアップ時に「クリック」だったか（ドラッグしなかったか）を判定するためのフラグ
    // additive: Shift/Ctrl+クリックだったか（選択操作なのでリンクのポップオーバー表示対象から除外する）
    drag = {
      ids, startX: pt.x, startY: pt.y, origins,
      moved: false, additive,
      startClientX: e.clientX, startClientY: e.clientY
    };

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
      if (node && node.type === 'text') growToFitText(id);
    }
    commit(); // 内容が変わっていなければ History.push() 内の重複判定で履歴には積まれない
    editing = false;
    refreshTextStylePopover();
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
    closeLinkPopover(); // テキスト編集開始時はポップオーバーを閉じる
    closeTextStylePopover();

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
    // Esc：右クリックメニュー表示中はそれを閉じる。次にリンクポップオーバー表示中はそれを閉じる。
    // 次に接続モード中はそちらを優先して解除。それ以外は選択解除
    if (e.key === 'Escape') {
      if (contextMenu.classList.contains('open')) { hideContextMenu(); return; }
      if (linkPopover.classList.contains('open')) { closeLinkPopover(); return; }
      if (connectMode) { setConnectMode(false); return; }
      if (!editing) {
        Model.clearSelection();
        View.selectNodes([]);
        View.selectEdge(null);
        refreshTextStylePopover();
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
      refreshTextStylePopover();
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
    closeLinkPopover(); // 表示中のノードが削除された可能性があるため閉じる
    refreshTextStylePopover();
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

  // リンク関連の項目（設定…/編集…/削除）を選択状態に合わせて出し分ける。
  // 単一選択時のみ表示：リンク未設定なら「設定…」の1つ、設定済みなら「編集…」「削除」の2つ
  const linkSetBtn = contextMenu.querySelector('[data-action="link-set"]');
  const linkEditBtn = contextMenu.querySelector('[data-action="link-edit"]');
  const linkRemoveBtn = contextMenu.querySelector('[data-action="link-remove"]');
  const linkMenuSep = contextMenu.querySelector('.link-menu-sep');

  function updateContextMenuLinkItems() {
    const ids = Model.getSelectedIds();
    const single = ids.length === 1 ? ids[0] : null;
    const hasLink = single ? !!Model.getLink(single) : false;
    const show = el => { el.style.display = ''; };
    const hide = el => { el.style.display = 'none'; };

    if (!single) {
      [linkSetBtn, linkEditBtn, linkRemoveBtn, linkMenuSep].forEach(hide);
      return;
    }
    show(linkMenuSep);
    if (hasLink) { hide(linkSetBtn); show(linkEditBtn); show(linkRemoveBtn); }
    else { show(linkSetBtn); hide(linkEditBtn); hide(linkRemoveBtn); }
  }

  canvas.addEventListener('contextmenu', e => {
    // テキスト編集中はブラウザ標準の右クリックメニュー（コピー/ペースト等）に任せる
    if (editing) return;
    e.preventDefault();
    // 右ボタンドラッグ（パン）の直後はメニューを出さない
    if (suppressContextMenu) { suppressContextMenu = false; return; }
    closeLinkPopover();
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
    refreshTextStylePopover();
    updateContextMenuLinkItems();
    showContextMenu(e.clientX, e.clientY);
  });

  contextMenu.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const action = btn.dataset.action;
    hideContextMenu();

    if (action === 'delete') { deleteSelected(); return; }
    if (action === 'link-set' || action === 'link-edit') { openLinkEditorForSelection(); return; }
    if (action === 'link-remove') { removeLinkFromSelected(); return; }

    const ACTION_MAP = { front: 'bringToFront', forward: 'bringForward', backward: 'sendBackward', back: 'sendToBack' };
    reorderSelection(ACTION_MAP[action]);
  });

  // メニュー外クリック・スクロール・ホイールズームで閉じる
  document.addEventListener('mousedown', e => {
    if (contextMenu.classList.contains('open') && !contextMenu.contains(e.target)) hideContextMenu();
    // リンクポップオーバーの外側をクリック（ドラッグ開始含む）したら閉じる
    if (linkPopover.classList.contains('open') && !linkPopover.contains(e.target)) closeLinkPopover();
    // テキストスタイルポップオーバーの外側をクリックしたら閉じる（保険。各操作開始点でも個別に閉じている）
    if (textStylePopover.classList.contains('open') && !textStylePopover.contains(e.target)) closeTextStylePopover();
  });
  document.addEventListener('scroll', hideContextMenu, true);
  canvas.addEventListener('wheel', hideContextMenu);
})();
