'use strict';

const Model = (() => {
  const PALETTE = [
    '#FFEB3B', '#FFD54F', '#FFCC80', '#A5D6A7',
    '#90CAF9', '#CE93D8', '#F48FB1', '#80DEEA'
  ];

  let _nodes = [];
  let _edges = [];
  let _selectedIds = new Set(); // 複数選択中のノードID集合
  let _selectedEdgeId = null;
  let _colorIdx = 0;

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

    setNodes(nodes) {
      _nodes = nodes;
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

    addSticky() {
      const node = {
        id: crypto.randomUUID(),
        type: 'sticky',
        x: 80 + Math.random() * 320,
        y: 80 + Math.random() * 160,
        width: 200,
        height: 200,
        content: '',
        style: {
          background: PALETTE[_colorIdx % PALETTE.length],
          fontSize: 14,
          color: '#333333'
        }
      };
      _colorIdx++;
      _nodes.push(node);
      return node;
    },

    // 背景・枠のないテキストのみのノードを追加する。
    // x, y を指定した場合はその点を配置座標とする（未指定なら addSticky と同じランダム配置）。
    addText(x, y) {
      const node = {
        id: crypto.randomUUID(),
        type: 'text',
        x: x != null ? x : 80 + Math.random() * 320,
        y: y != null ? y : 80 + Math.random() * 160,
        width: 240,
        height: 40,
        content: '',
        style: {
          fontSize: 18,
          color: '#333333'
        }
      };
      _nodes.push(node);
      return node;
    },

    addShape(shape) {
      const node = {
        id: crypto.randomUUID(),
        type: 'shape',
        shape,
        x: 80 + Math.random() * 320,
        y: 80 + Math.random() * 160,
        width: 160,
        height: 120,
        content: '',
        style: {
          background: '#ffffff',
          border: '#4a90e2',
          fontSize: 14,
          color: '#333333'
        }
      };
      _nodes.push(node);
      return node;
    },

    // 画像ノードを追加する。naturalW/H は画像の自然サイズ。
    // 縦横比を保ったまま最大 IMAGE_MAX_SIZE に収まるよう縮小する。
    // x, y を指定した場合はその点を画像の中心として配置する（未指定なら他ノードと同様ランダム配置）。
    addImage(src, naturalW, naturalH, x, y) {
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
        x: x != null ? x - w / 2 : 80 + Math.random() * 320,
        y: y != null ? y - h / 2 : 80 + Math.random() * 160,
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
      return { type: 'node', nodeIds: [id], edgeIds };
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
        style: { line: 'straight', arrow: 'end', color: '#333333', width: 2 }
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
        return { type: 'node', nodeIds, edgeIds };
      }
      return null;
    }
  };
})();
