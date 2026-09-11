'use strict';

(() => {
  const canvas = document.getElementById('canvas');
  View.init(canvas);

  // ポップオーバーがツールバーの裏に潜り込まないための上限。
  // ツールバーの高さは CSS（--toolbar-h）で変わるので、都度その実測値から求める
  function topLimit() {
    const toolbar = document.getElementById('toolbar');
    return (toolbar ? toolbar.offsetHeight : 0) + 4;
  }

  // ---- 選択の描画（グループ枠を含む） ----
  // 選択状態を変えたあとは必ず renderSelection() を呼ぶ。Model の選択状態から View の表示を組み立て直す。
  // グループ全体を選択しているときは、個々のノードの選択枠は出さず破線のグループ枠だけを出す。
  // グループの中の1つを選んでいるとき（グループに入っている状態）は、そのノードの選択枠と
  // リサイズハンドルを出したうえで、グループ枠も残して「まだグループの中にいる」ことを示す。

  const GROUP_FRAME_PAD = 8; // グループ枠とメンバーの間の余白（ワールド座標）

  // ids のノードをまとめて囲む矩形（+余白）。該当ノードが1つもなければ null
  function nodesBBox(ids, pad) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ids.forEach(id => {
      const n = Model.findById(id);
      if (!n) return;
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.width);
      maxY = Math.max(maxY, n.y + n.height);
    });
    if (minX === Infinity) return null;
    return { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
  }

  // グループ枠だけを出し直す。ドラッグ・リサイズ中に枠を追従させる用（選択自体は変わらないため）
  function updateGroupFrame() {
    const gid = Model.getSelectedGroupId() || Model.getInsideGroupId();
    const box = gid ? nodesBBox(Model.getGroupMemberIds(gid), GROUP_FRAME_PAD) : null;
    if (box) View.showGroupFrame(box.x, box.y, box.w, box.h);
    else View.hideGroupFrame();
  }

  function renderSelection() {
    // グループ全体を選択中は個々の選択枠を出さない（破線のグループ枠だけで表す）
    View.selectNodes(Model.getSelectedGroupId() ? [] : Model.getSelectedIds());
    View.selectEdge(Model.getSelectedEdgeId());
    updateGroupFrame();
  }

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
      renderSelection();
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
    // 接続・手書きモード中はまずモード解除のみ行う
    if (connectMode) { setConnectMode(false); return; }
    if (drawMode) { setDrawMode(false); return; }
    if (History.undo()) updateHistoryButtons();
  }

  function performRedo() {
    if (editing) return;
    if (connectMode) { setConnectMode(false); return; }
    if (drawMode) { setDrawMode(false); return; }
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
    // 外部で作られた .svg 由来の危険なスキーム（javascript: など）はリンクにせず文字として見せるだけにする
    if (isOpenableUrl(url)) {
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    a.title = url;
    a.textContent = url;

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.textContent = '✎ 編集';
    editBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      Model.select(nodeId);
      renderSelection();
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
        renderSelection();
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

  // ---- リンクバッジ（ノード右上の🔗）を直接クリックしてリンクを開く ----

  // 保存時に https:// を補っているので通常は http(s) だが、外部で作られた .svg を読み込んだ場合は
  // javascript: のような危険なスキームが混ざりうるため、開く直前にも確認する
  function isOpenableUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
  }

  // バッジのクリックで別タブに開く（ノードの選択・ドラッグは行わない）
  function openNodeLink(nodeId) {
    const url = Model.getLink(nodeId);
    if (!isOpenableUrl(url)) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  // ---- リンクバッジのツールチップ（ホバー中に URL を表示する） ----

  const linkTooltip = document.getElementById('link-tooltip');

  function hideLinkTooltip() {
    linkTooltip.classList.remove('open');
    linkTooltip.textContent = '';
  }

  // バッジ（ノード右上）の少し下に出す。画面からはみ出す場合は左右を画面内に収める
  function showLinkTooltip(nodeId) {
    const node = Model.findById(nodeId);
    const url = node && Model.getLink(nodeId);
    if (!url) return;

    linkTooltip.textContent = url;
    linkTooltip.classList.add('open');

    const pos = View.worldToScreen(node.x + node.width, node.y);
    const width = linkTooltip.getBoundingClientRect().width;
    const left = Math.min(Math.max(8, pos.x - width), window.innerWidth - width - 8);
    linkTooltip.style.left = Math.round(left) + 'px';
    linkTooltip.style.top = Math.round(pos.y + 24) + 'px';
  }

  canvas.addEventListener('mouseover', e => {
    const badge = e.target.closest('.link-badge');
    if (!badge) return;
    const nodeEl = badge.closest('.node');
    if (nodeEl) showLinkTooltip(nodeEl.dataset.id);
  });

  canvas.addEventListener('mouseout', e => {
    const badge = e.target.closest('.link-badge');
    if (!badge) return;
    // 当たり判定の矩形と絵文字の間を移動しただけのときは消さない（ちらつき防止）
    if (e.relatedTarget && badge.contains(e.relatedTarget)) return;
    hideLinkTooltip();
  });

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

  const STICKY_ASPECTS = [{ label: '1:1', ratio: 1 }, { label: '3:2', ratio: 1.5 }]; // 付箋の縦横比（横/縦）
  const FONT_SIZE_STEPS = [12, 14, 18, 24, 32, 48];
  // 色のパレット（付箋・文字・コネクタ）は設定「新規ノードの色」のセットが持つ（src/theme.js）。
  // ポップオーバーは開くたびに組み立て直すので、そこで Theme.get() を読めば切り替えが反映される。
  const ALIGN_LABELS = { left: '左揃え', center: '中央揃え', right: '右揃え' };
  // 横位置アイコン（3本の横棒。長さと位置で左/中央/右を表す）
  const ALIGN_ICONS = {
    left: '<svg viewBox="0 0 16 12" width="14" height="14"><rect x="1" y="1" width="14" height="2" fill="currentColor"/><rect x="1" y="5" width="9" height="2" fill="currentColor"/><rect x="1" y="9" width="12" height="2" fill="currentColor"/></svg>',
    center: '<svg viewBox="0 0 16 12" width="14" height="14"><rect x="1" y="1" width="14" height="2" fill="currentColor"/><rect x="3.5" y="5" width="9" height="2" fill="currentColor"/><rect x="2" y="9" width="12" height="2" fill="currentColor"/></svg>',
    right: '<svg viewBox="0 0 16 12" width="14" height="14"><rect x="1" y="1" width="14" height="2" fill="currentColor"/><rect x="6" y="5" width="9" height="2" fill="currentColor"/><rect x="4" y="9" width="12" height="2" fill="currentColor"/></svg>'
  };
  const VALIGN_LABELS = { top: '上揃え', middle: '上下中央', bottom: '下揃え' };
  // 縦位置アイコン（薄い外枠＋上/中/下に太い横棒）
  const VALIGN_ICONS = {
    top: '<svg viewBox="0 0 14 14" width="14" height="14"><rect x="2" y="2" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="4" y="3.5" width="6" height="2.5" fill="currentColor" stroke="none"/></svg>',
    middle: '<svg viewBox="0 0 14 14" width="14" height="14"><rect x="2" y="2" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="4" y="5.75" width="6" height="2.5" fill="currentColor" stroke="none"/></svg>',
    bottom: '<svg viewBox="0 0 14 14" width="14" height="14"><rect x="2" y="2" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="4" y="8" width="6" height="2.5" fill="currentColor" stroke="none"/></svg>'
  };

  // ---- コネクタ（エッジ）用スタイル定数 ----
  const EDGE_LINE_TYPES = ['straight', 'curved', 'elbow'];
  const EDGE_LINE_LABELS = { straight: '直線', curved: '曲線', elbow: '直角' };
  const EDGE_LINE_ICONS = {
    straight: '<svg viewBox="0 0 14 14" width="14" height="14"><path d="M2,12 L12,2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    curved: '<svg viewBox="0 0 14 14" width="14" height="14"><path d="M2,12 C6,12 8,2 12,2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    elbow: '<svg viewBox="0 0 14 14" width="14" height="14"><polyline points="2,12 7,12 7,2 12,2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };

  const EDGE_ARROWS = ['none', 'end', 'start', 'both'];
  const EDGE_ARROW_LABELS = { none: '矢印なし', end: '終点に矢印', start: '始点に矢印', both: '両端に矢印' };
  const EDGE_ARROW_ICONS = {
    none: '<svg viewBox="0 0 14 14" width="14" height="14"><line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    end: '<svg viewBox="0 0 14 14" width="14" height="14"><line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><polyline points="9,4 12,7 9,10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    start: '<svg viewBox="0 0 14 14" width="14" height="14"><line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><polyline points="5,4 2,7 5,10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    both: '<svg viewBox="0 0 14 14" width="14" height="14"><line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><polyline points="9,4 12,7 9,10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><polyline points="5,4 2,7 5,10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };

  const EDGE_WIDTHS = [{ label: '細', value: 1 }, { label: '中', value: 2 }, { label: '太', value: 4 }];
  // 手書きの線はコネクタより太めが使いやすいので、別の段階を用意する
  const DRAW_WIDTHS = [{ label: '細', value: 2 }, { label: '中', value: 4 }, { label: '太', value: 8 }];

  function closeTextStylePopover() {
    textStylePopover.classList.remove('open');
    textStylePopover.innerHTML = '';
  }

  function appendPopoverSeparator(container) {
    const sep = document.createElement('span');
    sep.className = 'tsp-sep';
    container.appendChild(sep);
  }

  // ポップオーバーの1行（行頭にラベルを付ける）。付箋の色と文字設定を別の行に分けて見分けやすくする
  function appendPopoverRow(labelText) {
    const row = document.createElement('div');
    row.className = 'tsp-row';
    const label = document.createElement('span');
    label.className = 'tsp-row-label';
    label.textContent = labelText;
    row.appendChild(label);
    textStylePopover.appendChild(row);
    return row;
  }

  // ノードの上、画面上端に収まらない場合はノードの下（リンクポップオーバーと同じ位置）に回す
  function positionTextStylePopover(node) {
    const top = View.worldToScreen(node.x, node.y);
    const height = textStylePopover.offsetHeight;
    let y = top.y - height - 8;
    if (y < topLimit()) {
      // 上に置くとツールバーに隠れてしまうのでノードの下へ回す
      const bottom = View.worldToScreen(node.x, node.y + node.height);
      y = bottom.y + 8;
    }
    textStylePopover.style.left = Math.round(top.x) + 'px';
    textStylePopover.style.top = Math.round(y) + 'px';
  }

  // ノード用ポップオーバーの中身を生成する（サイズ / 色 / 太字 / 横位置）
  function buildTextStylePopover(node) {
    textStylePopover.innerHTML = '';
    const style = node.style || {};
    const fontSize = style.fontSize || 14;
    const bold = !!style.bold;
    const align = style.align || (node.type === 'shape' ? 'center' : 'left');
    const color = (style.color || '#333333').toLowerCase();

    // ---- 付箋の色（付箋のみ、1行目）。文字色（丸）と区別するため角丸四角のスウォッチにする ----
    if (node.type === 'sticky') {
      const stickyRow = appendPopoverRow('付箋');
      const bgGroup = document.createElement('span');
      bgGroup.className = 'tsp-group tsp-bg-colors';
      const currentBg = (style.background || '').toLowerCase();
      Theme.get().stickyColors.forEach(c => {
        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'tsp-swatch tsp-swatch-bg';
        if (c.toLowerCase() === currentBg) sw.classList.add('active');
        sw.style.background = c;
        sw.title = '付箋の色';
        sw.addEventListener('click', ev => {
          ev.stopPropagation();
          applyStylePatch(node.id, { background: c });
        });
        bgGroup.appendChild(sw);
      });
      stickyRow.appendChild(bgGroup);

      // ---- 縦横比（1:1 / 3:2）。保存項目は増やさず、現在の幅/高さから判定する ----
      appendPopoverSeparator(stickyRow);
      const aspectGroup = document.createElement('span');
      aspectGroup.className = 'tsp-group';
      const currentRatio = node.width / node.height;
      STICKY_ASPECTS.forEach(({ label, ratio }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tsp-aspect' + (Math.abs(currentRatio - ratio) < 0.02 ? ' active' : '');
        btn.title = '縦横比 ' + label;
        btn.textContent = label;
        btn.addEventListener('click', ev => { ev.stopPropagation(); applyStickyAspect(node.id, ratio); });
        aspectGroup.appendChild(btn);
      });
      stickyRow.appendChild(aspectGroup);
    }

    // ---- 文字設定の行（サイズ・色・太字・横位置） ----
    const textRow = appendPopoverRow('文字');

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
    textRow.appendChild(sizeGroup);

    appendPopoverSeparator(textRow);

    // ---- 文字色（8色パレット） ----
    const colorGroup = document.createElement('span');
    colorGroup.className = 'tsp-group tsp-colors';
    Theme.get().textColors.forEach(c => {
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
    textRow.appendChild(colorGroup);

    appendPopoverSeparator(textRow);

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
    textRow.appendChild(boldBtn);

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
    textRow.appendChild(alignGroup);

    // ---- 縦位置（上/中/下）。付箋・図形のみ（テキストノードは高さが文字に追従するため対象外） ----
    if (node.type !== 'text') {
      appendPopoverSeparator(textRow);
      const valign = style.valign || (node.type === 'sticky' ? 'top' : 'middle');
      const valignGroup = document.createElement('span');
      valignGroup.className = 'tsp-group';
      ['top', 'middle', 'bottom'].forEach(v => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tsp-align tsp-valign' + (valign === v ? ' active' : '');
        btn.title = VALIGN_LABELS[v];
        btn.innerHTML = VALIGN_ICONS[v];
        btn.addEventListener('click', ev => {
          ev.stopPropagation();
          applyStylePatch(node.id, { valign: v });
        });
        valignGroup.appendChild(btn);
      });
      textRow.appendChild(valignGroup);
    }
  }

  // コネクタ用ポップオーバーを、線（外接矩形 bbox。ワールド座標）と重ならない位置に配置する。
  // 横長のコネクタは矩形の上（上に収まらなければ下）、縦長のコネクタは矩形の右（右に収まらなければ左）に置く。
  function positionPopoverBesideEdge(bbox) {
    const tl = View.worldToScreen(bbox.x, bbox.y);
    const br = View.worldToScreen(bbox.x + bbox.width, bbox.y + bbox.height);
    const w = textStylePopover.offsetWidth;
    const h = textStylePopover.offsetHeight;
    const GAP = 12;
    const TOP_LIMIT = topLimit(); // ツールバーの下に収める
    let x, y;
    if (br.y - tl.y > br.x - tl.x) {
      // 縦長：右側に縦中央揃え
      x = br.x + GAP;
      y = (tl.y + br.y) / 2 - h / 2;
      if (x + w > window.innerWidth - 4) x = tl.x - w - GAP;
    } else {
      // 横長：上側に水平中央揃え
      x = (tl.x + br.x) / 2 - w / 2;
      y = tl.y - h - GAP;
      if (y < TOP_LIMIT) y = br.y + GAP;
    }
    x = Math.min(Math.max(x, 4), window.innerWidth - w - 4);
    y = Math.min(Math.max(y, TOP_LIMIT), window.innerHeight - h - 4);
    textStylePopover.style.left = Math.round(x) + 'px';
    textStylePopover.style.top = Math.round(y) + 'px';
  }

  // コネクタ用ポップオーバーの中身を生成する（線種・矢印・太さ / 色）
  function buildEdgeStylePopover(edge) {
    textStylePopover.innerHTML = '';
    const s = edge.style || {};
    const currentLine = s.line || 'straight';
    const currentColor = (s.color || '#333333').toLowerCase();

    // ---- 行「線」：線種 / 矢印の向き / 太さ ----
    const lineRow = appendPopoverRow('線');

    const lineGroup = document.createElement('span');
    lineGroup.className = 'tsp-group';
    EDGE_LINE_TYPES.forEach(t => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tsp-line' + (currentLine === t ? ' active' : '');
      btn.title = EDGE_LINE_LABELS[t];
      btn.innerHTML = EDGE_LINE_ICONS[t];
      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        applyEdgeStylePatch(edge.id, { line: t });
      });
      lineGroup.appendChild(btn);
    });
    lineRow.appendChild(lineGroup);

    appendPopoverSeparator(lineRow);

    const arrowGroup = document.createElement('span');
    arrowGroup.className = 'tsp-group';
    EDGE_ARROWS.forEach(a => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tsp-arrow' + (s.arrow === a ? ' active' : '');
      btn.title = EDGE_ARROW_LABELS[a];
      btn.innerHTML = EDGE_ARROW_ICONS[a];
      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        applyEdgeStylePatch(edge.id, { arrow: a });
      });
      arrowGroup.appendChild(btn);
    });
    lineRow.appendChild(arrowGroup);

    appendPopoverSeparator(lineRow);

    const widthGroup = document.createElement('span');
    widthGroup.className = 'tsp-group';
    EDGE_WIDTHS.forEach(({ label, value }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tsp-width' + (s.width === value ? ' active' : '');
      btn.title = '太さ ' + value;
      btn.textContent = label;
      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        applyEdgeStylePatch(edge.id, { width: value });
      });
      widthGroup.appendChild(btn);
    });
    lineRow.appendChild(widthGroup);

    // ---- 行「色」 ----
    const colorRow = appendPopoverRow('色');
    const colorGroup = document.createElement('span');
    colorGroup.className = 'tsp-group tsp-colors';
    Theme.get().edgeColors.forEach(c => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'tsp-swatch';
      if (c.toLowerCase() === currentColor) sw.classList.add('active');
      sw.style.background = c;
      sw.title = c;
      sw.addEventListener('click', ev => {
        ev.stopPropagation();
        applyEdgeStylePatch(edge.id, { color: c });
      });
      colorGroup.appendChild(sw);
    });
    colorRow.appendChild(colorGroup);
  }

  // 手書きの線用ポップオーバーの中身を生成する（太さ / 色）。
  // 文字を持たないノードなので、コネクタ用の「線」の行から線種と矢印を除いた形にしている
  function buildDrawStylePopover(node) {
    textStylePopover.innerHTML = '';
    const s = node.style || {};
    const currentColor = (s.color || '#333333').toLowerCase();

    const lineRow = appendPopoverRow('線');
    const widthGroup = document.createElement('span');
    widthGroup.className = 'tsp-group';
    DRAW_WIDTHS.forEach(({ label, value }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tsp-width' + (s.width === value ? ' active' : '');
      btn.title = '太さ ' + value;
      btn.textContent = label;
      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        applyDrawStylePatch(node.id, { width: value });
      });
      widthGroup.appendChild(btn);
    });
    lineRow.appendChild(widthGroup);

    const colorRow = appendPopoverRow('色');
    const colorGroup = document.createElement('span');
    colorGroup.className = 'tsp-group tsp-colors';
    Theme.get().edgeColors.forEach(c => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'tsp-swatch';
      if (c.toLowerCase() === currentColor) sw.classList.add('active');
      sw.style.background = c;
      sw.title = c;
      sw.addEventListener('click', ev => {
        ev.stopPropagation();
        applyDrawStylePatch(node.id, { color: c });
      });
      colorGroup.appendChild(sw);
    });
    colorRow.appendChild(colorGroup);
  }

  // 手書きの線のポップオーバー共通の適用処理（applyEdgeStylePatch のノード版）
  function applyDrawStylePatch(id, patch) {
    const node = Model.findById(id);
    if (!node) return;
    Model.updateStyle(id, patch);
    View.updateNodeStyle(node);
    commit();
    refreshTextStylePopover();
  }

  // コネクタのポップオーバーの各ボタン共通の適用処理：Model更新→View反映→履歴確定→再表示
  function applyEdgeStylePatch(id, patch) {
    const edge = Model.findEdgeById(id);
    if (!edge) return;
    Model.updateEdgeStyle(id, patch);
    View.updateEdgeStyle(edge);
    commit();
    refreshTextStylePopover();
  }

  // 選択が「1ノードだけ・画像以外・編集中でない・ドラッグ/リサイズ中でない」なら
  // ノード用ポップオーバー（手書きの線は太さと色だけの専用の内容）を生成・配置して表示、
  // コネクタが選択中ならコネクタ用ポップオーバーを表示、
  // それ以外は閉じる（ノードとコネクタのスタイル編集を1つのポップオーバー要素で兼用する）。
  // 選択確定・ズーム・パン終了・移動/リサイズ終了・スタイル変更後など、幅広い箇所から呼ぶ。
  function refreshTextStylePopover() {
    // コネクタ選択中はコネクタ用の内容を出す（ノードとコネクタの選択は排他）
    const edgeId = Model.getSelectedEdgeId();
    if (edgeId && !editing && !drag && !resize) {
      const edge = Model.findEdgeById(edgeId);
      if (edge) {
        buildEdgeStylePopover(edge);
        textStylePopover.classList.add('open');
        const bbox = View.edgeBBox(edge);
        if (bbox) positionPopoverBesideEdge(bbox); else closeTextStylePopover();
        return;
      }
    }

    const ids = Model.getSelectedIds();
    if (ids.length !== 1 || editing || drag || resize) { closeTextStylePopover(); return; }
    const node = Model.findById(ids[0]);
    if (!node || node.type === 'image' || !node.style) { closeTextStylePopover(); return; }
    // 手書きの線は文字を持たないので、太さと色だけの専用の内容にする
    if (node.type === 'draw') buildDrawStylePopover(node);
    else buildTextStylePopover(node);
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

  // 付箋の縦横比を変更する（幅を保ち高さを比率から決める）。ratio は 横/縦
  function applyStickyAspect(id, ratio) {
    const node = Model.findById(id);
    if (!node || node.type !== 'sticky') return;
    Model.updateSize(id, node.width, Math.round(node.width / ratio));
    View.resizeNode(id, node.width, node.height);
    commit();
    refreshTextStylePopover();
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

  // ---- 挿入位置 ----
  // 新しいノードは「今表示されている画面の中央」に置く。ただし同じ場所へ続けて挿入すると
  // ぴったり重なってしまうため、2個目以降は右下へ 24px ずつずらす（10段で折り返し、
  // 画面外まで流れていかないようにする）。パン・ズームで中央が変わったとき、または
  // 直前に挿入したノード以外を選択したときは中央からやり直す。
  const CASCADE_STEP = 24;
  const CASCADE_WRAP = 10;
  let cascadeOrigin = null; // 前回の挿入で使ったキャンバス中央（ワールド座標）
  let cascadeCount = 0;
  let lastInsertedId = null;

  function nextInsertPoint() {
    const c = View.canvasCenter();
    const movedView = !cascadeOrigin
      || Math.abs(c.x - cascadeOrigin.x) > 0.5
      || Math.abs(c.y - cascadeOrigin.y) > 0.5;
    const sel = Model.getSelectedIds();
    const keptSelection = lastInsertedId && sel.length === 1 && sel[0] === lastInsertedId;
    cascadeCount = movedView || !keptSelection ? 0 : (cascadeCount + 1) % CASCADE_WRAP;
    cascadeOrigin = c;
    const d = cascadeCount * CASCADE_STEP;
    return { x: c.x + d, y: c.y + d };
  }

  document.getElementById('btn-add-sticky').addEventListener('click', () => {
    const p = nextInsertPoint();
    const node = Model.addSticky(p.x, p.y);
    View.addNode(node);
    lastInsertedId = node.id;
    Model.select(node.id);
    renderSelection();
    commit();
    refreshTextStylePopover();
  });

  // ---- 図形の追加 ----
  // 形の一覧は src/shapes.js のカタログが持ち、UI は左の図形パレットに集約している

  function insertShape(shapeId) {
    const p = nextInsertPoint();
    const node = Model.addShape(shapeId, p.x, p.y);
    View.addNode(node);
    lastInsertedId = node.id;
    Model.select(node.id);
    renderSelection();
    commit();
    refreshTextStylePopover();
  }

  // ---- 図形パレット（部品置き場） ----
  // 「挿入」の「◇ 図形」で開閉する左のサイドパネル。開くと #canvas がその分だけ狭まるが、
  // 座標変換は #canvas の実寸を見ているので位置合わせの処理は要らない。

  const shapePalette = document.getElementById('shape-palette');
  const shapePaletteBtn = document.getElementById('btn-shapes');
  const PALETTE_KEY = 'openboard.palette';

  // サムネイルは実際の描画と同じ Shapes.pathD() で作るので、形の定義とズレようがない
  function buildShapePalette() {
    const body = document.getElementById('palette-body');
    const W = 30, H = 24;
    Shapes.CATEGORIES.forEach(cat => {
      const items = Shapes.CATALOG.filter(sh => sh.category === cat.key);
      if (!items.length) return;

      const head = document.createElement('div');
      head.className = 'palette-category';
      head.textContent = cat.label;
      body.appendChild(head);

      const grid = document.createElement('div');
      grid.className = 'palette-grid';
      items.forEach(shape => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'palette-item';
        btn.title = shape.label;

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', `-1 -1 ${W + 2} ${H + 2}`);
        svg.setAttribute('width', W + 2);
        svg.setAttribute('height', H + 2);
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', Shapes.pathD(shape.id, W, H));
        svg.appendChild(path);
        btn.appendChild(svg);

        const label = document.createElement('span');
        label.className = 'palette-item-label';
        label.textContent = shape.label;
        btn.appendChild(label);

        // 続けて置けるよう、挿入してもパレットは開いたままにする
        btn.addEventListener('click', () => insertShape(shape.id));
        grid.appendChild(btn);
      });
      body.appendChild(grid);
    });
  }

  function setPaletteOpen(open) {
    document.body.classList.toggle('palette-open', open);
    shapePalette.hidden = !open;
    shapePaletteBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
    try {
      localStorage.setItem(PALETTE_KEY, open ? '1' : '0');
    } catch (e) {
      // localStorage が使えない環境では開閉状態を覚えないだけで、動作には影響しない
    }
  }

  buildShapePalette();
  shapePaletteBtn.addEventListener('click', () => setPaletteOpen(shapePalette.hidden));
  document.getElementById('palette-close').addEventListener('click', () => setPaletteOpen(false));

  // 初回は開いた状態にする（図形の入口がここしかないため）
  let paletteInitial = '1';
  try {
    const stored = localStorage.getItem(PALETTE_KEY);
    if (stored !== null) paletteInitial = stored;
  } catch (e) {
    // 読めない場合は既定（開く）のまま
  }
  setPaletteOpen(paletteInitial === '1');

  // ---- テキストノードの追加 ----
  // 背景・枠のない空のテキストノードは見えないため、追加直後にそのまま編集モードへ入る。
  // 履歴・保存への反映は編集確定（finishNodeEdit → commit）まで行わない
  // （キャンセルされた場合に空ノードの痕跡を履歴に残さないため）。
  document.getElementById('btn-add-text').addEventListener('click', () => {
    const p = nextInsertPoint();
    const node = Model.addText(p.x, p.y);
    View.addNode(node);
    lastInsertedId = node.id;
    Model.select(node.id);
    renderSelection();
    editing = true;
    View.startEditing(node.id, (content, scrollHeight) => finishNodeEdit(node.id, content, scrollHeight));
  });

  // ---- 画像の追加（共通処理） ----

  // src（dataURL）と自然サイズからノードを追加する共通処理。
  // x, y はワールド座標で、その点を画像の中心として配置する
  //（ツールバーからの挿入は nextInsertPoint、ドロップ・ペーストはその位置を渡す）。
  function addImageNode(src, width, height, x, y) {
    const node = Model.addImage(src, width, height, x, y);
    View.addNode(node);
    lastInsertedId = node.id;
    Model.select(node.id);
    renderSelection();
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
    const files = Array.from(e.target.files);
    e.target.value = '';
    if (!files.length) return;
    // 画像の読み込みは非同期なので、選択したファイルぶんの位置をここでまとめて決める
    const p = nextInsertPoint();
    files.forEach((file, i) => loadImageFile(file, p.x + i * CASCADE_STEP, p.y + i * CASCADE_STEP));
    cascadeCount = (cascadeCount + files.length - 1) % CASCADE_WRAP; // 次の挿入は最後の画像の続きから
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
    if (on) setDrawMode(false); // モードは同時に1つだけ
  }

  btnConnector.addEventListener('click', () => setConnectMode(!connectMode));

  // ---- 手書き（ペン）モード ----
  // 接続モードと違い、1本描いてもモードは続く（Esc かボタン再クリックで抜ける）。
  // 描いている間は stroke に軌跡（ワールド座標）を貯め、マウスを離した時点で
  // Model.addDrawing() が外接矩形と正規化点列にまとめてノード1件にする。

  const btnDraw = document.getElementById('btn-draw');
  let drawMode = false;
  let stroke = null;
  const STROKE_WIDTH = Model.getDefaultStrokeWidth(); // 描くときの太さ（描いたあとはスタイル編集で変えられる）

  function setDrawMode(on) {
    drawMode = on;
    btnDraw.classList.toggle('active', on);
    canvas.classList.toggle('drawing', on);
    if (on) {
      setConnectMode(false); // モードは同時に1つだけ
      // 描き始めたときに選択枠やポップオーバーが残っていると邪魔になるので先に片付ける
      Model.clearSelection();
      renderSelection();
      closeTextStylePopover();
      closeLinkPopover();
    }
  }

  btnDraw.addEventListener('click', () => setDrawMode(!drawMode));

  // 直前の点からこれ以上離れたときだけ点を足す（画面上の距離。ズームに依らず一定の細かさになる）
  const STROKE_SAMPLE_PX = 2;
  // 点列の間引き（Ramer–Douglas–Peucker）の許容誤差。同じく画面上の距離で効かせる
  const STROKE_SIMPLIFY_PX = 0.8;

  function strokeStyle() {
    return { color: Theme.get().edge.color, width: STROKE_WIDTH };
  }

  function startStroke(e) {
    e.preventDefault();
    const pt = View.svgPoint(e);
    stroke = { points: [[pt.x, pt.y]] };
    View.updateTempStroke(stroke.points, strokeStyle());
    document.addEventListener('mousemove', onStrokeMove);
    document.addEventListener('mouseup', onStrokeUp);
  }

  function onStrokeMove(e) {
    if (!stroke) return;
    const pt = View.svgPoint(e);
    const last = stroke.points[stroke.points.length - 1];
    const min = STROKE_SAMPLE_PX / View.getViewport().zoom;
    if (Math.hypot(pt.x - last[0], pt.y - last[1]) < min) return;
    stroke.points.push([pt.x, pt.y]);
    View.updateTempStroke(stroke.points, strokeStyle());
  }

  function onStrokeUp() {
    document.removeEventListener('mousemove', onStrokeMove);
    document.removeEventListener('mouseup', onStrokeUp);
    View.endTempStroke();
    if (!stroke) return;

    const points = Draw.simplify(stroke.points, STROKE_SIMPLIFY_PX / View.getViewport().zoom);
    stroke = null;

    // 描いた線は選択しない。連続で描くツールなので、毎回選択枠とスタイル編集が
    // 開いては消えると手元がちらつくため（色・太さを変えるときはモードを抜けて選び直す）
    const node = Model.addDrawing(points);
    if (!node) return;
    View.addNode(node);
    commit();
  }

  // SVGファイル（.svg）読み込み後の共通処理。File System Access API 経由・
  // 従来の <input type="file"> 経由のどちらの「開く」からも呼ぶ
  function loadBoardData(data, fileName) {
    Model.setNodes(data.nodes || []);
    Model.setEdges(data.edges || []);
    View.renderAll(Model.getNodes());
    renderSelection();
    View.setViewport(data.viewport || { x: 0, y: 0, zoom: 1 });
    updateZoomLabel();
    // ボード名はファイル名を優先し、なければメタデータのタイトルを使う
    const base = (fileName || '').replace(/\.svg$/i, '').trim();
    Model.setTitle(base || data.meta?.title || '');
    renderBoardName();
    commit();
    IO.markSaved(); // 開いた直後はファイルの内容と一致しているので「保存済み」とする
    refreshTextStylePopover(); // 選択は解除済みのため閉じる
  }

  // ---- 新規作成 ----
  // ボードを空にしてボード名を既定に戻す。未保存の変更がある場合は呼び出し側で確認してから呼ぶ。
  function newBoard() {
    setConnectMode(false);
    setDrawMode(false);
    closeLinkPopover();
    Model.setNodes([]);
    Model.setEdges([]);
    Model.setTitle(''); // 空文字を渡すと既定のボード名（無題のボード）に戻る
    View.renderAll([]);
    renderSelection();
    View.setViewport({ x: 0, y: 0, zoom: 1 });
    updateZoomLabel();
    renderBoardName();
    // 新規作成は履歴の起点にする（Ctrl+Z で前のボードが戻ってこないようにする）
    History.clear();
    updateHistoryButtons();
    IO.save();
    IO.markSaved(); // 空の新規ボードは保存すべき内容がないので「保存済み」とする
    IO.clearFileHandle(); // 別のボードになったので、直前まで開いていたファイルへは上書きしない
    refreshTextStylePopover();
  }

  document.getElementById('btn-new').addEventListener('click', async () => {
    if (!IO.isDirty()) { newBoard(); return; }

    const answer = await Dialog.confirmDiscard(Model.getTitle(), '新規作成');
    if (answer === 'cancel') return;
    // 保存を選んだのに保存できなかった（ダイアログをキャンセルした等）場合は新規作成しない
    if (answer === 'save' && !(await IO.saveFile(renderBoardName))) return;
    newBoard();
  });

  // 「保存」は結びついたファイルへ上書き（無ければ「名前を付けて保存」と同じ動作になる）
  document.getElementById('btn-export').addEventListener('click', () => IO.saveFile(renderBoardName));
  document.getElementById('btn-export-as').addEventListener('click', () => IO.saveFileAs(renderBoardName));

  // Ctrl/Cmd+S で保存、Shift併用で名前を付けて保存。
  // 編集中の内容を取りこぼさないよう、保存の前にフォーカスを外して確定させる
  // （テキスト編集もボード名の入力欄も blur で確定する）。
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return;
    e.preventDefault(); // ブラウザの「ページを保存」を止める
    document.activeElement?.blur();
    if (e.shiftKey) IO.saveFileAs(renderBoardName);
    else IO.saveFile(renderBoardName);
  });

  // 「開く」も現在のボードを捨てるため、未保存の変更があれば新規作成と同じ確認を出す。
  // 確認して「保存せずに開く」「保存して開く」が選ばれた場合だけ読み込みへ進む。
  // 戻り値は読み込んでよいかどうか。
  async function confirmBeforeOpen() {
    if (!IO.isDirty()) return true;
    const answer = await Dialog.confirmDiscard(Model.getTitle(), '開く');
    if (answer === 'cancel') return false;
    // 保存を選んだのに保存できなかった（ダイアログをキャンセルした等）場合は開かない
    if (answer === 'save' && !(await IO.saveFile(renderBoardName))) return false;
    return true;
  }

  // Chrome / Edge では File System Access API のダイアログで開く（フォルダを記憶してくれる）。
  // 非対応ブラウザでは preventDefault しないので label の既定動作で <input type="file"> が開く。
  //
  // 確認を出すタイミングが2つの経路で異なる：
  //   File System Access API 側 … ファイル選択を開く前（ダイアログのボタン押下がそのまま
  //     ユーザー操作として引き継がれるため、確認のあとでも showOpenFilePicker を開ける）
  //   非対応ブラウザ側 … ファイル選択のあと（change）。label の既定動作を止めてしまうと
  //     ファイル選択を開き直す手段がユーザー操作の有効期限に依存するため、それを避けている
  const importInput = document.getElementById('btn-import');

  document.getElementById('btn-import-label').addEventListener('click', async e => {
    if (!IO.hasFileSystemAccess()) return; // label の既定動作にまかせ、確認は change 側で行う
    e.preventDefault();
    if (await confirmBeforeOpen()) IO.openSVG(loadBoardData);
  });

  importInput.addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = ''; // 同じファイルを選び直しても change が発火するようにここで空にしておく
    if (!file) return;
    if (await confirmBeforeOpen()) IO.importSVG(file, loadBoardData);
  });

  // ---- 再読み込み・タブを閉じる前の確認 ----
  // ボードの内容は localStorage から復元されるが、Undo 履歴と「保存」の上書き先（ファイルの結びつき）は
  // 再読み込みで失われるため、中身のあるボードでは確認する。
  // ダイアログの文言と選択肢はブラウザが決めるものでこちらからは指定できない。
  // また、ページを一度も操作していない場合はブラウザの仕様でダイアログ自体が出ない。
  window.addEventListener('beforeunload', e => {
    if (!Model.getNodes().length && !Model.getEdges().length) return;
    e.preventDefault();
    e.returnValue = ''; // 仕様上は preventDefault だけでよいが、古いブラウザはこちらを見る
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
  const PAN_CLICK_THRESHOLD = 3; // これ未満の移動は「クリック」とみなす（右ボタンのメニュー抑止の判定に使う）

  function onPanMove(e) {
    const dx = e.clientX - pan.startX;
    const dy = e.clientY - pan.startY;
    if (Math.abs(dx) > PAN_CLICK_THRESHOLD || Math.abs(dy) > PAN_CLICK_THRESHOLD) pan.moved = true;
    View.setViewport({ x: pan.origX + dx, y: pan.origY + dy, zoom: pan.origZoom });
  }

  function onPanUp() {
    if (pan && pan.moved) scheduleSave();
    // 右ボタンドラッグでパンした場合は、mouseup 直後に発火する contextmenu を抑止する
    if (pan && pan.button === 2 && pan.moved) suppressContextMenu = true;
    pan = null;
    canvas.classList.remove('panning');
    document.removeEventListener('mousemove', onPanMove);
    document.removeEventListener('mouseup', onPanUp);
    refreshTextStylePopover(); // パンで表示位置がずれるため出し直す
  }

  function startPan(e) {
    e.preventDefault();
    closeTextStylePopover();
    const vp = View.getViewport();
    pan = {
      startX: e.clientX, startY: e.clientY,
      origX: vp.x, origY: vp.y, origZoom: vp.zoom,
      moved: false,
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
  let rubberBand = null; // 矩形選択（空白部分の左ドラッグ）の状態

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
      // 従属側が最小サイズを下回る場合は従属側を最小にして主側を比率から再計算する（比率を崩さない）
      if (nh < MIN_SIZE) { nh = MIN_SIZE; nw = nh * aspect; }
      if (nw < MIN_SIZE) { nw = MIN_SIZE; nh = nw / aspect; }
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
      const { x, y, w, h } = calcResize(resize.dir, dx, dy, resize.origX, resize.origY, resize.origW, resize.origH, e.shiftKey || resize.lockAspect);
      Model.updatePosition(resize.id, x, y);
      Model.updateSize(resize.id, w, h);
      View.moveNode(resize.id, x, y);
      View.resizeNode(resize.id, w, h);
      updateGroupFrame(); // グループ内のノードをリサイズしている場合は枠を追従させる
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
      updateGroupFrame(); // グループ枠を移動に追従させる
    }
  }

  function onMouseUp() {
    // グループ全体を選択している状態でメンバーをクリックした（ドラッグはしなかった）ときは、
    // そのメンバー単体の選択へ降りる。mousedown ではなくここで判定するのは、押した時点で選択を
    // 狭めてしまうとグループ全体のドラッグができなくなるため
    if (drag && !drag.moved && !drag.additive && drag.wasWholeGroup) {
      Model.select(drag.hitId);
      renderSelection();
    }
    // ドラッグせずクリックだけで終わった単一ノード（Shift/Ctrl修飾なし）なら、
    // リンクポップオーバーの表示対象候補として覚えておく（実際に出すのは commit 後）。
    // 上でグループ内の単体選択へ降りた場合もここに含まれる
    const clickedNodeId = (drag && !drag.moved && !drag.additive && Model.getSelectedId() === drag.hitId)
      ? drag.hitId : null;
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
    const hit = Model.getNodes()
      .filter(n => rectsIntersect(x, y, w, h, n.x, n.y, n.width, n.height))
      .map(n => n.id);
    // Shift/Ctrl+ドラッグ：既存の選択を残したまま、囲んだノードを追加する。
    // メンバーが1つでも矩形にかかったグループは、まとめてグループ全体を選択する
    const ids = Model.expandToGroups(rubberBand.additive
      ? Array.from(new Set([...rubberBand.baseIds, ...hit]))
      : hit);
    Model.selectMany(ids);
    renderSelection();

    View.hideRubberBand(rubberBand.el);
    rubberBand = null;
    document.removeEventListener('mousemove', onRubberMove);
    document.removeEventListener('mouseup', onRubberUp);
    refreshTextStylePopover();
  }

  function startRubberBand(e, additive) {
    e.preventDefault();
    closeTextStylePopover();
    const pt = View.svgPoint(e);
    rubberBand = {
      startX: pt.x, startY: pt.y,
      rect: { x: pt.x, y: pt.y, w: 0, h: 0 },
      additive: !!additive,
      baseIds: additive ? Model.getSelectedIds() : [],
      el: View.showRubberBand(pt.x, pt.y, 0, 0)
    };
    document.addEventListener('mousemove', onRubberMove);
    document.addEventListener('mouseup', onRubberUp);
  }

  canvas.addEventListener('mousedown', e => {
    if (editing) return;

    // ---- 右ボタンドラッグ：対象を問わずキャンバスのパンのみ（選択・移動はしない） ----
    if (e.button === 2) {
      startPan(e);
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
      startPan(e);
      return;
    }

    // ---- 手書きモード中：対象を問わずドラッグの軌跡を線にする ----
    // （右ボタン・中ボタン・Space のパンは上で先に処理しているので、ペン中でも移動できる）
    if (drawMode) {
      startStroke(e);
      return;
    }

    // ---- リンクバッジ：選択もドラッグもせず、mouseup（click）でリンクを開くだけにする ----
    if (e.target.closest('.link-badge')) {
      e.preventDefault();
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
        origW: node.width, origH: node.height,
        lockAspect: node.type === 'sticky' // 付箋は常に縦横比固定
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
      renderSelection();
      // ここ（mousedown）で開くと、直後に document 側の「外側クリックで閉じる」mousedown 処理に閉じられて
      // しまうため、ノードと同様に mouseup のタイミングでコネクタ用ポップオーバーを開く
      closeTextStylePopover();
      document.addEventListener('mouseup', () => refreshTextStylePopover(), { once: true });
      return;
    }

    const nodeEl = e.target.closest('.node');
    if (!nodeEl) {
      // 空白の左ドラッグ：矩形選択（ラバーバンド）。パンは右ボタン / 中ボタン / Space+ドラッグで行う。
      // 移動せずにマウスアップした場合は空の矩形になるため、従来どおり「クリックで選択解除」になる。
      startRubberBand(e, e.shiftKey || e.ctrlKey || e.metaKey);
      return;
    }

    e.preventDefault();
    const id = nodeEl.dataset.id;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const gid = Model.getGroupId(id);
    // このクリックの直前に、このノードのグループ全体を選択していたか。
    // このときだけ、ドラッグせずに離すとグループの中の1つへ降りる（判定は onMouseUp）
    const wasWholeGroup = !!gid && Model.getSelectedGroupId() === gid;

    if (additive) {
      // Shift/Ctrl+クリック：選択への追加・解除トグル。グループはメンバーごとまとめてトグルする
      if (gid) {
        const members = Model.getGroupMemberIds(gid);
        const current = Model.getSelectedIds();
        Model.selectMany(Model.isSelected(id)
          ? current.filter(sid => !members.includes(sid))
          : current.concat(members));
      } else {
        Model.toggleSelect(id);
      }
    } else if (gid && Model.getInsideGroupId() === gid) {
      // グループの中にいる状態で（同じグループの）ノードをクリック：そのノード単体の選択へ移る
      Model.select(id);
    } else if (!Model.isSelected(id)) {
      // 通常クリック：グループに属していればグループ全体、属していなければそのノードのみ選択
      if (gid) Model.selectMany(Model.getGroupMemberIds(gid));
      else Model.select(id);
    }
    // else: 既に選択済みのノードを通常クリック → グループドラッグのため選択を維持する

    renderSelection();

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
    // hitId: 実際にクリックしたノード（グループ全体を選択中はドラッグ対象と一致しない）
    // wasWholeGroup: クリック前にそのグループ全体を選択していたか（単体選択へ降りるかの判定に使う）
    drag = {
      ids, startX: pt.x, startY: pt.y, origins,
      moved: false, additive, hitId: id, wasWholeGroup,
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
        renderSelection();
      }
    } else {
      Model.updateContent(id, content);
      if (node && node.type === 'text') growToFitText(id);
    }
    commit(); // 内容が変わっていなければ History.push() 内の重複判定で履歴には積まれない
    editing = false;
    refreshTextStylePopover();
  }

  // ---- リンクバッジのクリックでリンクを開く ----
  // mousedown 側で選択・ドラッグを止めているので、ここはリンクを開くだけでよい。
  // 接続モード中はコネクタ作成を優先し、リンクは開かない。
  canvas.addEventListener('click', e => {
    const badge = e.target.closest('.link-badge');
    if (!badge || connectMode) return;
    const nodeEl = badge.closest('.node');
    if (!nodeEl) return;
    hideLinkTooltip();
    openNodeLink(nodeEl.dataset.id);
  });

  // ---- ダブルクリックでテキスト編集 ----

  canvas.addEventListener('dblclick', e => {
    if (connectMode) return;
    // リンクバッジのダブルクリックでテキスト編集に入らないようにする
    if (e.target.closest('.link-badge')) return;
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
    // 次に接続モード・手書きモード中はそちらを優先して解除。それ以外は選択解除
    if (e.key === 'Escape') {
      if (contextMenu.classList.contains('open')) { hideContextMenu(); return; }
      if (linkPopover.classList.contains('open')) { closeLinkPopover(); return; }
      if (connectMode) { setConnectMode(false); return; }
      if (drawMode) { setDrawMode(false); return; }
      if (!editing) {
        Model.clearSelection();
        renderSelection();
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
      renderSelection();
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
    renderSelection();
    closeLinkPopover(); // 表示中のノードが削除された可能性があるため閉じる
    refreshTextStylePopover();
    commit();
  }

  // ---- 選択中のノードを複製する（Ctrl+D・右クリックメニュー共通処理） ----

  const DUPLICATE_OFFSET = 24; // 複製したノードを元からずらす量（px。挿入時のカスケードと同じ）

  function duplicateSelected() {
    const ids = Model.getSelectedIds();
    if (!ids.length) return;

    const { nodes, edges } = Model.duplicateNodes(ids, DUPLICATE_OFFSET, DUPLICATE_OFFSET);
    if (!nodes.length) return;

    nodes.forEach(n => View.addNode(n));
    edges.forEach(e => View.addEdge(e));
    // 複製直後は複製側を選択する（そのまま続けて複製すると階段状に増える）
    Model.selectMany(nodes.map(n => n.id));
    renderSelection();
    closeLinkPopover(); // 元ノードに対して開いていた場合は閉じる
    refreshTextStylePopover();
    commit();
  }

  // Ctrl/Cmd+D：選択中のノードを複製する（ブラウザのブックマーク登録は抑止する）
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'd') return;
    if (editing || connectMode || drawMode) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (!Model.getSelectedIds().length) return;
    e.preventDefault();
    duplicateSelected();
  });

  // ---- グループ化 / グループ解除（Ctrl+G・Ctrl+Shift+G / 右クリックメニュー共通処理） ----
  // グループの情報はノードの groupId フィールドとして持つため、履歴・保存は commit() だけで足りる。

  function groupSelection() {
    if (!Model.groupSelected()) return; // 2件未満の選択では何もしない
    closeLinkPopover();
    closeTextStylePopover(); // 単一選択ではなくなるため閉じる
    renderSelection();
    commit();
  }

  function ungroupSelection() {
    if (!Model.ungroupSelected()) return; // グループ所属のノードが選択にない
    renderSelection();
    refreshTextStylePopover();
    commit();
  }

  // Ctrl/Cmd+G：グループ化、Ctrl/Cmd+Shift+G：グループ解除
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'g') return;
    if (editing || connectMode || drawMode) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (!Model.getSelectedIds().length) return;
    e.preventDefault();
    if (e.shiftKey) ungroupSelection();
    else groupSelection();
  });

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
      updateGroupFrame(); // 並べ替えでノードが前面に移るため、グループ枠を出し直して最前面に戻す
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
  // グループ関連の項目を選択状態に合わせて出し分ける。
  // 「グループ化」は2件以上選択しているとき、「グループ解除」は選択にグループ所属ノードがあるときだけ出す
  const groupBtn = contextMenu.querySelector('[data-action="group"]');
  const ungroupBtn = contextMenu.querySelector('[data-action="ungroup"]');

  function updateContextMenuGroupItems() {
    groupBtn.style.display = Model.getSelectedIds().length >= 2 ? '' : 'none';
    ungroupBtn.style.display = Model.hasGroupedSelection() ? '' : 'none';
  }

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
    if (connectMode || drawMode) return;

    const nodeEl = e.target.closest('.node');
    if (!nodeEl) { hideContextMenu(); return; } // 空白の右クリックはブラウザ標準メニューを抑止するのみ

    const id = nodeEl.dataset.id;
    // 右クリックしたノードが未選択なら、そのノードのみ選択してからメニューを出す。
    // 既に選択中（複数選択の一部含む）ならそのまま選択状態を維持する。
    if (!Model.isSelected(id)) {
      const gid = Model.getGroupId(id);
      // グループに属するノードなら、右クリックでもグループ全体を選択する
      if (gid) Model.selectMany(Model.getGroupMemberIds(gid));
      else Model.select(id);
      renderSelection();
    }
    refreshTextStylePopover();
    updateContextMenuGroupItems();
    updateContextMenuLinkItems();
    showContextMenu(e.clientX, e.clientY);
  });

  contextMenu.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const action = btn.dataset.action;
    hideContextMenu();

    if (action === 'duplicate') { duplicateSelected(); return; }
    if (action === 'group') { groupSelection(); return; }
    if (action === 'ungroup') { ungroupSelection(); return; }
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
    // ドラッグ・パンが始まるとバッジの位置がずれるため、リンクのツールチップは閉じる
    if (!e.target.closest('.link-badge')) hideLinkTooltip();
  });
  document.addEventListener('scroll', () => { hideContextMenu(); hideLinkTooltip(); }, true);
  canvas.addEventListener('wheel', () => { hideContextMenu(); hideLinkTooltip(); });

  // 色セットを切り替えたとき、開いたままのポップオーバーが古いパレットを出さないよう組み直す。
  // src/theme.js のほうが先に購読しているので、現在のセットの更新はこれより先に走る。
  // subscribe は登録時にも呼ばれるため、refreshTextStylePopover が参照する状態
  // （drag / resize / editing）が初期化済みになるここまで下げている
  Settings.subscribe('theme', () => refreshTextStylePopover());
})();
