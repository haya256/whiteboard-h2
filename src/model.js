'use strict';

const Model = (() => {
  const PALETTE = [
    '#FFEB3B', '#FFD54F', '#FFCC80', '#A5D6A7',
    '#90CAF9', '#CE93D8', '#F48FB1', '#80DEEA'
  ];

  let _nodes = [];
  let _edges = [];
  let _selectedId = null;
  let _selectedEdgeId = null;
  let _colorIdx = 0;

  return {
    getNodes: () => _nodes,
    getEdges: () => _edges,
    getSelectedId: () => _selectedId,
    getSelectedEdgeId: () => _selectedEdgeId,
    findById: id => _nodes.find(n => n.id === id),
    findEdgeById: id => _edges.find(e => e.id === id),

    setNodes(nodes) {
      _nodes = nodes;
      _selectedId = null;
      _selectedEdgeId = null;
    },

    setEdges(edges) {
      _edges = edges || [];
      _selectedEdgeId = null;
    },

    select(id) {
      _selectedId = id;
      _selectedEdgeId = null;
    },

    selectEdge(id) {
      _selectedEdgeId = id;
      _selectedId = null;
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

    removeSelected() {
      if (_selectedEdgeId) {
        const id = _selectedEdgeId;
        _edges = _edges.filter(e => e.id !== id);
        _selectedEdgeId = null;
        return { type: 'edge', id };
      }
      if (_selectedId) {
        const id = _selectedId;
        _nodes = _nodes.filter(n => n.id !== id);
        // 削除されたノードに接続されていたエッジも道連れで削除する
        const edgeIds = [];
        _edges = _edges.filter(e => {
          if (e.from === id || e.to === id) { edgeIds.push(e.id); return false; }
          return true;
        });
        _selectedId = null;
        return { type: 'node', id, edgeIds };
      }
      return null;
    }
  };
})();
