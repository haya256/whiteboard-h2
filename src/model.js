'use strict';

const Model = (() => {
  const PALETTE = [
    '#FFEB3B', '#FFD54F', '#FFCC80', '#A5D6A7',
    '#90CAF9', '#CE93D8', '#F48FB1', '#80DEEA'
  ];

  let _nodes = [];
  let _selectedId = null;
  let _colorIdx = 0;

  return {
    getNodes: () => _nodes,
    getSelectedId: () => _selectedId,
    findById: id => _nodes.find(n => n.id === id),

    setNodes(nodes) {
      _nodes = nodes;
      _selectedId = null;
    },

    select(id) {
      _selectedId = id;
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

    updatePosition(id, x, y) {
      const n = _nodes.find(n => n.id === id);
      if (n) { n.x = x; n.y = y; }
    },

    updateContent(id, content) {
      const n = _nodes.find(n => n.id === id);
      if (n) n.content = content;
    },

    removeSelected() {
      if (!_selectedId) return null;
      const id = _selectedId;
      _nodes = _nodes.filter(n => n.id !== id);
      _selectedId = null;
      return id;
    }
  };
})();
