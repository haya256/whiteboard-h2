'use strict';

const Model = (() => {
  const DEFAULT_TITLE = '無題のボード';

  let _nodes = [];
  let _edges = [];
  let _selectedIds = new Set(); // 複数選択中のノードID集合
  let _selectedEdgeId = null;
  // ボード名。ファイル名・タブ名に使う。Undo 履歴の対象外。
  let _title = DEFAULT_TITLE;

  // ---- 重なり順（Z順）ヘルパー ----
  // 重なり順は _nodes の配列順そのもので表現する（末尾＝最前面、先頭＝最背面）。
  // z フィールドは持たせず、配列順が保存・復元される。

  // 2つのノード配列がID順まで完全一致するか（変化なし判定用）
  function sameOrder(a, b) {
    if (a.length !== b.length) return false;
    return a.every((n, i) => n.id === b[i].id);
  }

  // 選択ノード（ids）を dir 方向へ1段ずつ動かす。
  // 各選択ノードは、移動方向に隣接する「非選択」ノードとだけ swap する
  // （隣が選択ノードなら飛び越えない＝選択ノード同士の相対順序は保たれる）。
  // dir = +1 で前面へ（配列の末尾側）、dir = -1 で背面へ（配列の先頭側）。
  function stepReorder(ids, dir) {
    const idSet = new Set(ids || []);
    if (idSet.size === 0) return false;

    const indices = [];
    _nodes.forEach((n, i) => { if (idSet.has(n.id)) indices.push(i); });
    if (indices.length === 0) return false;
    // 前面側から順に処理することで、隣り合う選択ノード同士が互いを追い越さずまとまって動く
    if (dir > 0) indices.reverse();

    let changed = false;
    indices.forEach(i => {
      const j = i + dir;
      if (j < 0 || j >= _nodes.length) return; // 配列の端＝これ以上動けない
      if (idSet.has(_nodes[j].id)) return; // 隣も選択ノードなら飛び越えない
      const tmp = _nodes[i]; _nodes[i] = _nodes[j]; _nodes[j] = tmp;
      changed = true;
    });
    return changed;
  }

  // ---- グループ ----
  // グループ用の配列は持たず、ノードの groupId フィールドだけで表す（link と同じく、
  // どこにも属さないノードは groupId フィールド自体を持たない）。こうしておくと保存（io.js の
  // buildData）・未保存判定・Undo（history.js の cloneNode）はノードを丸ごと扱っているため、
  // それぞれに追加の対応をしなくてもグループが載る。
  // 入れ子は作らない（1つのノードは高々1つのグループにしか属さない）。

  // gid のメンバーID配列を返す（_nodes の順＝重なり順を保つ）
  function memberIds(gid) {
    return gid ? _nodes.filter(n => n.groupId === gid).map(n => n.id) : [];
  }

  // メンバーが1件以下になったグループを解体する。
  // ノード削除・グループ解除・グループの統合など、メンバーが減りうる操作の後始末として呼ぶ。
  function sanitizeGroups() {
    const count = new Map();
    _nodes.forEach(n => { if (n.groupId) count.set(n.groupId, (count.get(n.groupId) || 0) + 1); });
    _nodes.forEach(n => { if (n.groupId && count.get(n.groupId) < 2) delete n.groupId; });
  }

  // 選択中のノードが全員そろって同じグループに属していればその gid、そうでなければ null。
  // 「グループ全体を選択中」と「グループの中の一部を選択中」の判定に使う
  function selectionGroupId() {
    if (_selectedIds.size === 0) return null;
    let gid = null;
    for (const id of _selectedIds) {
      const n = _nodes.find(nn => nn.id === id);
      if (!n || !n.groupId) return null;
      if (gid === null) gid = n.groupId;
      else if (gid !== n.groupId) return null;
    }
    return gid;
  }

  return {
    getNodes: () => _nodes,
    getEdges: () => _edges,
    // 後方互換：単一選択時のみIDを返す。複数選択・未選択時は null
    getSelectedId: () => (_selectedIds.size === 1 ? Array.from(_selectedIds)[0] : null),
    getSelectedIds: () => Array.from(_selectedIds),
    isSelected: id => _selectedIds.has(id),
    getSelectedEdgeId: () => _selectedEdgeId,
    findById: id => _nodes.find(n => n.id === id),
    findEdgeById: id => _edges.find(e => e.id === id),

    // ---- ボード名 ----
    getTitle: () => _title,
    getDefaultTitle: () => DEFAULT_TITLE,
    // title を trim して設定する。空になった場合は既定のボード名に戻す
    setTitle(title) {
      const trimmed = String(title == null ? '' : title).trim();
      _title = trimmed || DEFAULT_TITLE;
    },

    setNodes(nodes) {
      _nodes = nodes;
      // 読み込んだデータにメンバーが1件しかないグループが残っていても正常な状態に直す
      sanitizeGroups();
      _selectedIds = new Set();
      _selectedEdgeId = null;
    },

    setEdges(edges) {
      _edges = edges || [];
      _selectedEdgeId = null;
    },

    // 単一選択。id が falsy なら選択解除
    select(id) {
      _selectedIds = id ? new Set([id]) : new Set();
      _selectedEdgeId = null;
    },

    // id の選択状態をトグル（Shift/Ctrl+クリック用）
    toggleSelect(id) {
      if (!id) return;
      if (_selectedIds.has(id)) _selectedIds.delete(id);
      else _selectedIds.add(id);
      _selectedEdgeId = null;
    },

    // 複数選択をまとめて設定（矩形選択・全選択用）
    selectMany(ids) {
      _selectedIds = new Set(ids || []);
      _selectedEdgeId = null;
    },

    // ノード選択・エッジ選択の両方を解除する
    clearSelection() {
      _selectedIds = new Set();
      _selectedEdgeId = null;
    },

    selectEdge(id) {
      _selectedEdgeId = id;
      _selectedIds = new Set();
    },

    // cx, cy（ワールド座標）を中心として付箋を配置する
    addSticky(cx, cy) {
      const W = 200, H = 200;
      const node = {
        id: crypto.randomUUID(),
        type: 'sticky',
        x: cx - W / 2,
        y: cy - H / 2,
        width: W,
        height: H,
        content: '',
        // 色は設定「新規ノードの色」のセットから取る（作成時にコピーするだけで、以後は各ノードが持つ）
        style: {
          ...Theme.get().sticky,
          fontSize: 32,
          bold: false,
          align: 'center',
          valign: 'middle'
        }
      };
      _nodes.push(node);
      return node;
    },

    // 背景・枠のないテキストのみのノードを、cx, cy（ワールド座標）を中心として追加する。
    addText(cx, cy) {
      const W = 240;
      const H = 56; // 既定フォント32px × 行高1.4 + 上下余白8px が収まる高さ
      const node = {
        id: crypto.randomUUID(),
        type: 'text',
        x: cx - W / 2,
        y: cy - H / 2,
        width: W,
        height: H,
        content: '',
        style: {
          ...Theme.get().text,
          fontSize: 32,
          bold: false,
          align: 'left'
        }
      };
      _nodes.push(node);
      return node;
    },

    // cx, cy（ワールド座標）を中心として図形を配置する。
    // 既定サイズは図形ごと（src/shapes.js のカタログ。指定がなければ 160×120）
    addShape(shape, cx, cy) {
      const size = Shapes.defaultSize(shape);
      const W = size.w, H = size.h;
      const node = {
        id: crypto.randomUUID(),
        type: 'shape',
        shape,
        x: cx - W / 2,
        y: cy - H / 2,
        width: W,
        height: H,
        content: '',
        style: {
          ...Theme.get().shape,
          fontSize: 32,
          bold: false,
          align: 'center',
          valign: 'middle'
        }
      };
      _nodes.push(node);
      return node;
    },

    // 画像ノードを追加する。naturalW/H は画像の自然サイズ（src/image.js で圧縮済みのサイズが渡される）。
    // 縦横比を保ったまま最大 400px（定数 MAX）に収まるよう表示サイズを縮小する。
    // cx, cy（ワールド座標）を画像の中心として配置する。
    addImage(src, naturalW, naturalH, cx, cy) {
      const MAX = 400;
      let w = naturalW || MAX;
      let h = naturalH || MAX;
      if (w > MAX || h > MAX) {
        const scale = Math.min(MAX / w, MAX / h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }
      const node = {
        id: crypto.randomUUID(),
        type: 'image',
        x: cx - w / 2,
        y: cy - h / 2,
        width: w,
        height: h,
        src
      };
      _nodes.push(node);
      return node;
    },

    updatePosition(id, x, y) {
      const n = _nodes.find(n => n.id === id);
      if (n) { n.x = x; n.y = y; }
    },

    updateSize(id, w, h) {
      const n = _nodes.find(n => n.id === id);
      if (n) { n.width = Math.max(40, w); n.height = Math.max(40, h); }
    },

    updateContent(id, content) {
      const n = _nodes.find(n => n.id === id);
      if (n) n.content = content;
    },

    // 文字スタイル（fontSize / color / bold / align）の一部を更新する。
    // style を持たないノード（画像など）は無視する
    updateStyle(id, patch) {
      const n = _nodes.find(n => n.id === id);
      if (n && n.style) Object.assign(n.style, patch);
    },

    // コネクタのスタイル（line / arrow / color / width）の一部を更新する
    updateEdgeStyle(id, patch) {
      const e = _edges.find(e => e.id === id);
      if (e && e.style) Object.assign(e.style, patch);
    },

    // ---- リンク（ノードごとに任意でひとつだけ持てるURL） ----
    // 未設定のノードは link フィールド自体を持たない（JSON出力・比較を単純にするため）。

    // 指定ノードの現在のリンクURLを返す。未設定なら null
    getLink(id) {
      const n = _nodes.find(n => n.id === id);
      return (n && n.link) ? n.link : null;
    },

    // リンクURLを設定する。url が空文字/null/undefined ならフィールドごと削除する
    setLink(id, url) {
      const n = _nodes.find(n => n.id === id);
      if (!n) return;
      if (url) n.link = url;
      else delete n.link;
    },

    // 指定IDのノード1件を削除する（選択状態には影響しない）。
    // 空のテキストノードを編集確定時に自動削除する用途などで使う。
    // 戻り値は removeSelected と同じ形（{ type, nodeIds, edgeIds }）。見つからなければ null。
    removeNode(id) {
      const idx = _nodes.findIndex(n => n.id === id);
      if (idx === -1) return null;
      _nodes.splice(idx, 1);
      const edgeIds = [];
      _edges = _edges.filter(e => {
        if (e.from === id || e.to === id) { edgeIds.push(e.id); return false; }
        return true;
      });
      _selectedIds.delete(id);
      sanitizeGroups(); // 削除でメンバーが1件になったグループは解体する
      return { type: 'node', nodeIds: [id], edgeIds };
    },

    // ids のノードを複製し、dx, dy だけずらした位置に新しいIDで追加する。
    // 両端とも ids に含まれるコネクタも一緒に複製して、複製後のノード同士をつなぎ直す
    // （片側だけが対象のコネクタは複製しない）。
    // 複製したノード・エッジは配列末尾（＝最前面）へ、元の重なり順を保ったまま積む。
    // 選択状態は変更しない（呼び出し側で selectMany する）。戻り値は { nodes, edges }。
    duplicateNodes(ids, dx, dy) {
      const idSet = new Set(ids || []);
      if (idSet.size === 0) return { nodes: [], edges: [] };

      // style はネストしたオブジェクトなので個別にコピーする（History.cloneNode と同じ方針。
      // 画像の src のような長い文字列は不変なので参照を共有したままでよい）
      const idMap = new Map(); // 元ID → 複製後のID
      const groupMap = new Map(); // 元のグループID → 複製後のグループID
      const nodes = _nodes.filter(n => idSet.has(n.id)).map(n => {
        const copy = Object.assign({}, n, { id: crypto.randomUUID(), x: n.x + dx, y: n.y + dy });
        if (n.style) copy.style = Object.assign({}, n.style);
        // グループも一緒に複製する。複製側には新しいグループIDを振り、元のグループへ合流させない
        if (n.groupId) {
          if (!groupMap.has(n.groupId)) groupMap.set(n.groupId, crypto.randomUUID());
          copy.groupId = groupMap.get(n.groupId);
        }
        idMap.set(n.id, copy.id);
        return copy;
      });

      const edges = _edges.filter(e => idMap.has(e.from) && idMap.has(e.to)).map(e => {
        const copy = Object.assign({}, e, {
          id: crypto.randomUUID(),
          from: idMap.get(e.from),
          to: idMap.get(e.to)
        });
        if (e.style) copy.style = Object.assign({}, e.style);
        return copy;
      });

      _nodes.push(...nodes);
      _edges.push(...edges);
      // グループの一部だけを複製した場合、複製側が1件だけのグループにならないようにする
      sanitizeGroups();
      return { nodes, edges };
    },

    // ---- グループ ----

    // ノードが属するグループのID。どこにも属していなければ null
    getGroupId(id) {
      const n = _nodes.find(n => n.id === id);
      return (n && n.groupId) ? n.groupId : null;
    },

    // グループのメンバーID配列（重なり順）
    getGroupMemberIds: gid => memberIds(gid),

    // ids を「所属グループごと」に広げたID配列を返す（重複なし）。
    // グループのメンバーが1つでも含まれていれば、そのグループ全体が選ばれるようにする用途
    expandToGroups(ids) {
      const out = new Set();
      (ids || []).forEach(id => {
        const n = _nodes.find(nn => nn.id === id);
        if (!n) return;
        if (n.groupId) memberIds(n.groupId).forEach(mid => out.add(mid));
        else out.add(id);
      });
      return Array.from(out);
    },

    // 現在の選択があるグループの「全メンバーとちょうど一致」するときだけその gid を返す
    // （＝グループ全体を選択中）。それ以外は null
    getSelectedGroupId() {
      const gid = selectionGroupId();
      if (!gid) return null;
      return memberIds(gid).length === _selectedIds.size ? gid : null;
    },

    // 現在の選択があるグループの「一部だけ」のときその gid を返す（＝グループの中に入っている状態）。
    // それ以外は null
    getInsideGroupId() {
      const gid = selectionGroupId();
      if (!gid) return null;
      return memberIds(gid).length > _selectedIds.size ? gid : null;
    },

    // 選択中にグループ所属のノードが含まれるか（「グループ解除」を出すかの判定に使う）
    hasGroupedSelection() {
      return _nodes.some(n => _selectedIds.has(n.id) && !!n.groupId);
    },

    // 選択中のノード（2件以上）を1つのグループにまとめ、そのグループIDを返す。2件未満なら null。
    // 既にグループに属しているノードを含む場合、元のグループは解体して1つの新グループへ統合する
    // （入れ子は作らないため）。統合で1件だけ取り残された元グループも解体される
    groupSelected() {
      if (_selectedIds.size < 2) return null;
      const gid = crypto.randomUUID();
      _nodes.forEach(n => { if (_selectedIds.has(n.id)) n.groupId = gid; });
      sanitizeGroups();
      return gid;
    },

    // 選択中のノードが属するグループを解体する。メンバーの一部しか選択していなくても
    // そのグループ全体を解体する（「グループ解除」は選択からの離脱ではなくグループの解散）。
    // 変化があれば true
    ungroupSelected() {
      const gids = new Set();
      _nodes.forEach(n => { if (_selectedIds.has(n.id) && n.groupId) gids.add(n.groupId); });
      if (gids.size === 0) return false;
      _nodes.forEach(n => { if (n.groupId && gids.has(n.groupId)) delete n.groupId; });
      return true;
    },

    // ---- 重なり順（Z順）の変更 ----
    // いずれも ids（配列）を受け取り、選択ノード同士の相対順序を維持したまま並べ替える。
    // 変化があれば true、既に最前面/最背面などで変化がなければ false を返す。

    // 選択ノードをまとめて最前面（配列の末尾）へ移動する
    bringToFront(ids) {
      const idSet = new Set(ids || []);
      if (idSet.size === 0) return false;
      const selected = _nodes.filter(n => idSet.has(n.id));
      if (selected.length === 0) return false;
      const rest = _nodes.filter(n => !idSet.has(n.id));
      const newOrder = rest.concat(selected);
      if (sameOrder(newOrder, _nodes)) return false;
      _nodes = newOrder;
      return true;
    },

    // 選択ノードをまとめて最背面（配列の先頭）へ移動する
    sendToBack(ids) {
      const idSet = new Set(ids || []);
      if (idSet.size === 0) return false;
      const selected = _nodes.filter(n => idSet.has(n.id));
      if (selected.length === 0) return false;
      const rest = _nodes.filter(n => !idSet.has(n.id));
      const newOrder = selected.concat(rest);
      if (sameOrder(newOrder, _nodes)) return false;
      _nodes = newOrder;
      return true;
    },

    // 選択ノードを1段前面へ（直近の非選択ノードを1つ飛び越える）
    bringForward(ids) {
      return stepReorder(ids, 1);
    },

    // 選択ノードを1段背面へ（直近の非選択ノードを1つ飛び越える）
    sendBackward(ids) {
      return stepReorder(ids, -1);
    },

    // ---- コネクタ（エッジ） ----

    addEdge(from, to) {
      if (!from || !to || from === to) return null;
      // 同一ノード間の重複接続（向き問わず）は無視する
      const exists = _edges.some(e =>
        (e.from === from && e.to === to) || (e.from === to && e.to === from));
      if (exists) return null;

      const edge = {
        id: crypto.randomUUID(),
        type: 'connector',
        from, to,
        style: { line: 'curved', arrow: 'end', ...Theme.get().edge, width: 2 }
      };
      _edges.push(edge);
      return edge;
    },

    removeEdge(id) {
      _edges = _edges.filter(e => e.id !== id);
      if (_selectedEdgeId === id) _selectedEdgeId = null;
    },

    // ノードのバウンディングボックス上のアンカー点（上下左右＋中央）
    getAnchors(node) {
      const cx = node.x + node.width / 2;
      const cy = node.y + node.height / 2;
      return {
        top: { x: cx, y: node.y },
        bottom: { x: cx, y: node.y + node.height },
        left: { x: node.x, y: cy },
        right: { x: node.x + node.width, y: cy },
        center: { x: cx, y: cy }
      };
    },

    // 2ノードの中心を結ぶ線に最も近いアンカー同士を選ぶ
    // （from/to のアンカー指定はデータに保存せず、都度計算する）
    pickAnchors(nodeA, nodeB) {
      const ca = this.getAnchors(nodeA).center;
      const cb = this.getAnchors(nodeB).center;
      const dx = cb.x - ca.x;
      const dy = cb.y - ca.y;

      let a, b;
      if (Math.abs(dx) >= Math.abs(dy)) {
        a = dx >= 0 ? 'right' : 'left';
        b = dx >= 0 ? 'left' : 'right';
      } else {
        a = dy >= 0 ? 'bottom' : 'top';
        b = dy >= 0 ? 'top' : 'bottom';
      }
      return { a, b };
    },

    // 選択中のノード（複数可）またはエッジを削除する。
    // 戻り値は常に { type, nodeIds, edgeIds } の形（削除したノードID配列とエッジID配列）
    removeSelected() {
      if (_selectedEdgeId) {
        const id = _selectedEdgeId;
        _edges = _edges.filter(e => e.id !== id);
        _selectedEdgeId = null;
        return { type: 'edge', nodeIds: [], edgeIds: [id] };
      }
      if (_selectedIds.size > 0) {
        const nodeIds = Array.from(_selectedIds);
        const idSet = new Set(nodeIds);
        _nodes = _nodes.filter(n => !idSet.has(n.id));
        // 削除されたノードに接続されていたエッジも道連れで削除する
        const edgeIds = [];
        _edges = _edges.filter(e => {
          if (idSet.has(e.from) || idSet.has(e.to)) { edgeIds.push(e.id); return false; }
          return true;
        });
        _selectedIds = new Set();
        sanitizeGroups(); // 削除でメンバーが1件になったグループは解体する
        return { type: 'node', nodeIds, edgeIds };
      }
      return null;
    }
  };
})();
