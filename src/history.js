'use strict';

// 操作履歴（Undo/Redo）を管理するモジュール。
// nodes / edges のスナップショットをスタックに積む「スナップショット方式」で実装する。
// viewport（パン・ズーム位置）と選択状態は履歴の対象外（nodes/edges のみを記録する）。
const History = (() => {
  const MAX_STACK = 100; // 履歴スタックの上限。超えたら古いものから捨てる

  let _getState = null;   // () => { nodes, edges } を返す関数（Model から現在の状態を取得する）
  let _applyState = null; // (state) => undo/redo 適用処理を行う関数（Model/View/IO へ反映する）
  let _undoStack = [];    // 末尾が最新の状態。先頭（[0]）は必ず「初期状態（基点）」になる
  let _redoStack = [];

  // ノード1件をコピーする。style はネストしたオブジェクトなので個別にコピーする。
  // src（画像のBase64データURL）のような長い文字列は不変（immutable）なので
  // ディープコピーせず参照をそのまま共有してよい（structuredClone のような文字列複製コストを避ける）。
  function cloneNode(node) {
    const copy = Object.assign({}, node);
    if (node.style) copy.style = Object.assign({}, node.style);
    return copy;
  }

  function cloneEdge(edge) {
    const copy = Object.assign({}, edge);
    if (edge.style) copy.style = Object.assign({}, edge.style);
    return copy;
  }

  function cloneNodes(nodes) { return (nodes || []).map(cloneNode); }
  function cloneEdges(edges) { return (edges || []).map(cloneEdge); }

  // 現在の状態のスナップショットを作る。
  // 比較用にJSON文字列もキャッシュしておき、以降の重複判定で再シリアライズしなくて済むようにする。
  function snapshot() {
    const state = _getState();
    const nodes = cloneNodes(state.nodes);
    const edges = cloneEdges(state.edges);
    return { nodes, edges, json: JSON.stringify({ nodes, edges }) };
  }

  return {
    // getState: () => { nodes, edges } を返す関数
    // applyState: (state) => undo/redo 適用（Model反映・再描画・保存など）を行う関数
    // 初期状態を必ず基点としてスタックに積んでおく（これより前へは undo できない）
    init(getState, applyState) {
      _getState = getState;
      _applyState = applyState;
      _undoStack = [snapshot()];
      _redoStack = [];
    },

    // 現在の状態を「操作後の状態」として履歴に積む。
    // 直前に積んだ状態とJSONが完全一致する場合は無視する（移動量ゼロのクリック等の重複防止）。
    push() {
      if (!_getState) return;
      const snap = snapshot();
      const last = _undoStack[_undoStack.length - 1];
      if (last && last.json === snap.json) return; // 実質変化なし
      _undoStack.push(snap);
      if (_undoStack.length > MAX_STACK) _undoStack.shift(); // 上限超過分は古いものから捨てる
      _redoStack = []; // 新しい操作が積まれたら、それ以前のredo分岐は破棄する
    },

    // 1つ前の状態に戻す。戻せた場合 true、戻せない（基点に到達済み）場合 false
    undo() {
      if (!_applyState || _undoStack.length <= 1) return false;
      const cur = _undoStack.pop();
      _redoStack.push(cur);
      const prev = _undoStack[_undoStack.length - 1];
      _applyState({ nodes: cloneNodes(prev.nodes), edges: cloneEdges(prev.edges) });
      return true;
    },

    // undoで戻した操作をやり直す。適用できた場合 true、redo可能な履歴がない場合 false
    redo() {
      if (!_applyState || _redoStack.length === 0) return false;
      const next = _redoStack.pop();
      _undoStack.push(next);
      _applyState({ nodes: cloneNodes(next.nodes), edges: cloneEdges(next.edges) });
      return true;
    },

    canUndo() { return _undoStack.length > 1; },
    canRedo() { return _redoStack.length > 0; },

    // 履歴を初期化する（現在の状態を新たな基点にする）
    clear() {
      _undoStack = _getState ? [snapshot()] : [];
      _redoStack = [];
    }
  };
})();
