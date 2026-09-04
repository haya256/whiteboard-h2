'use strict';

const IO = (() => {
  const STORAGE_KEY = 'openboard_v01';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // File System Access API（Chrome / Edge）用。同じ id を使うと「開く」「保存」で最後に使ったフォルダを
  // ブラウザが記憶して共有してくれる。非対応ブラウザでは従来の input / ダウンロードにフォールバックする。
  const PICKER_ID = 'openboard-svg';
  const SVG_PICKER_TYPES = [{ description: 'SVG ボード', accept: { 'image/svg+xml': ['.svg'] } }];
  function hasFileSystemAccess() {
    return typeof window.showOpenFilePicker === 'function' && typeof window.showSaveFilePicker === 'function';
  }
  function stripSvgExt(name) { return String(name || '').replace(/\.svg$/i, '').trim(); }

  // 保存 SVG をブラウザで開いたときに画面と同じ見た目になるよう、style.css の該当規則（見た目に関わるものだけ）を転記している。
  // style.css を変更したらここも揃えること。
  const EXPORT_CSS = `
svg { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.sticky-bg { filter: drop-shadow(2px 3px 6px rgba(0,0,0,0.18)); }
.shape-bg { filter: drop-shadow(2px 3px 6px rgba(0,0,0,0.14)); }
.image-el { filter: drop-shadow(2px 3px 6px rgba(0,0,0,0.14)); }
.sticky-fo, .shape-fo, .text-fo { overflow: visible; }
.sticky-text {
  width: 100%;
  height: 100%;
  padding: 10px 12px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 14px;
  line-height: 1.55;
  color: #333;
  word-break: break-word;
  overflow: hidden;
}
.shape-text-wrap {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.shape-text {
  text-align: center;
  padding: 6px 10px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 14px;
  line-height: 1.4;
  color: #333;
  word-break: break-word;
  min-width: 4px;
}
.text-content {
  width: 100%;
  height: 100%;
  padding: 4px 6px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  line-height: 1.4;
  text-align: left;
  word-break: break-word;
  overflow: hidden;
}
.link-badge { font-size: 13px; }
.resize-handle { display: none; }
`;

  function buildData() {
    return {
      version: '0.1',
      meta: {
        title: Model.getTitle(),
        modified: new Date().toISOString()
      },
      viewport: View.getViewport(),
      nodes: Model.getNodes(),
      edges: Model.getEdges()
    };
  }

  // ボード名をファイル名として使えるよう、OSで使えない文字を取り除いて整形する（拡張子込みで返す）
  function toFileName(title) {
    const cleaned = String(title || '')
      .replace(/[/\\:*?"<>|\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return (cleaned || Model.getDefaultTitle()) + '.svg';
  }

  // 容量超過の警告は連続して出さないよう、直前が成功したかどうかを覚えておく
  let _quotaWarned = false;

  // window.alert は使わずページ内トーストで通知する（#toast、数秒で自動的に消える）
  let _toastTimer = null;
  function showToast(message) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('open');
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => {
      toast.classList.remove('open');
      _toastTimer = null;
    }, 4000);
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(buildData()));
      _quotaWarned = false;
    } catch (e) {
      console.warn('自動保存に失敗しました:', e);
      if (!_quotaWarned) {
        _quotaWarned = true;
        showToast('画像が大きすぎて自動保存できません。.svg で保存してください');
      }
    }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function buildSVGString() {
    const nodes = Model.getNodes();

    // 全ノードを囲むバウンディングボックスを計算
    let minX = 0, minY = 0, maxX = 800, maxY = 600;
    if (nodes.length > 0) {
      minX = Math.min(...nodes.map(n => n.x)) - 24;
      minY = Math.min(...nodes.map(n => n.y)) - 24;
      maxX = Math.max(...nodes.map(n => n.x + n.width)) + 24;
      maxY = Math.max(...nodes.map(n => n.y + n.height)) + 24;
    }
    const w = maxX - minX;
    const h = maxY - minY;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('xmlns', SVG_NS);
    svg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    svg.setAttribute('viewBox', `${minX} ${minY} ${w} ${h}`);
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);

    // JSON メタデータを埋め込む（再インポート用）
    const meta = document.createElementNS(SVG_NS, 'metadata');
    meta.textContent = JSON.stringify(buildData());
    svg.appendChild(meta);

    // 画面と同じ見た目にするための最小限のCSSを埋め込む
    const style = document.createElementNS(SVG_NS, 'style');
    style.textContent = EXPORT_CSS;
    svg.appendChild(style);

    // 背景
    const bg = document.createElementNS(SVG_NS, 'rect');
    bg.setAttribute('x', minX);
    bg.setAttribute('y', minY);
    bg.setAttribute('width', w);
    bg.setAttribute('height', h);
    bg.setAttribute('fill', '#f5f5f8');
    svg.appendChild(bg);

    // コネクタの矢印マーカー定義（色ごとに用意）
    const defs = document.createElementNS(SVG_NS, 'defs');
    svg.appendChild(defs);
    const markerIds = {};
    function ensureMarker(color) {
      const id = 'arrow-' + color.replace('#', '');
      if (markerIds[id]) return id;
      markerIds[id] = true;
      const marker = document.createElementNS(SVG_NS, 'marker');
      marker.id = id;
      marker.setAttribute('viewBox', '0 0 10 10');
      marker.setAttribute('refX', '8.5');
      marker.setAttribute('refY', '5');
      marker.setAttribute('markerWidth', '7');
      marker.setAttribute('markerHeight', '7');
      marker.setAttribute('orient', 'auto-start-reverse');
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', 'M0,0 L10,5 L0,10 z');
      path.setAttribute('fill', color);
      marker.appendChild(path);
      defs.appendChild(marker);
      return id;
    }

    // コネクタ（エッジ）をノードより先に描画し、ノードの下に配置する
    Model.getEdges().forEach(edge => {
      const from = Model.findById(edge.from);
      const to = Model.findById(edge.to);
      if (!from || !to) return;

      const { a, b } = Model.pickAnchors(from, to);
      const p1 = Model.getAnchors(from)[a];
      const p2 = Model.getAnchors(to)[b];

      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', `M${p1.x},${p1.y} L${p2.x},${p2.y}`);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', edge.style.color);
      path.setAttribute('stroke-width', edge.style.width);

      const mid = ensureMarker(edge.style.color);
      if (edge.style.arrow === 'end' || edge.style.arrow === 'both') {
        path.setAttribute('marker-end', `url(#${mid})`);
      }
      if (edge.style.arrow === 'start' || edge.style.arrow === 'both') {
        path.setAttribute('marker-start', `url(#${mid})`);
      }

      svg.appendChild(path);
    });

    // 各ノードはキャンバスと同じ生成関数で作り、編集用のリサイズハンドルだけ取り除く。
    // foreignObject + HTML をそのまま埋め込むので、文字の折り返し・余白・行間は画面と一致する
    // （foreignObject 非対応のツールでは文字が出ないが、ブラウザ表示を優先する）。
    nodes.forEach(node => {
      const g = View.makeNodeEl(node);
      if (!g) return;
      g.querySelectorAll('.resize-handle').forEach(el => el.remove());
      if (node.link) {
        // リンクがあるノードは <a> で包み、静的SVGをブラウザで開いてもクリックで別タブへ飛べるようにする
        const a = document.createElementNS(SVG_NS, 'a');
        a.setAttribute('href', node.link);
        a.setAttributeNS('http://www.w3.org/1999/xlink', 'href', node.link);
        a.setAttribute('target', '_blank');
        a.appendChild(g);
        svg.appendChild(a);
      } else {
        svg.appendChild(g);
      }
    });

    return new XMLSerializer().serializeToString(svg);
  }

  // 従来どおり <a download> でブラウザにダウンロードさせる（File System Access API 非対応時のフォールバック）
  function downloadSVG(text) {
    const blob = new Blob([text], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = toFileName(Model.getTitle());
    a.click();
    URL.revokeObjectURL(url);
  }

  // 保存ダイアログ（File System Access API）で保存する。対応ブラウザでは「開く」と同じ id を使うため
  // 最後に保存/読み込みしたフォルダをブラウザが覚えていて、次回もそのフォルダが開く。
  // onSaved はダイアログ経由の保存が成功したときのみ呼ばれる（フォールバック時は呼ばない）。
  async function exportSVG(onSaved) {
    if (!hasFileSystemAccess()) { downloadSVG(buildSVGString()); return; }

    let handle;
    try {
      handle = await window.showSaveFilePicker({
        id: PICKER_ID,
        suggestedName: toFileName(Model.getTitle()),
        types: SVG_PICKER_TYPES
      });
    } catch (err) {
      if (err && err.name === 'AbortError') return; // キャンセル
      showToast('保存ダイアログを開けませんでした: ' + err.message);
      downloadSVG(buildSVGString());
      return;
    }

    // ダイアログで付けたファイル名を先にボード名へ反映してから SVG を組み立てる
    // （SVG 内のメタデータにも新しいタイトルが入るようにする。次回の保存名・タブ名にも使う）
    const name = stripSvgExt(handle.name);
    if (name) Model.setTitle(name);
    const text = buildSVGString();

    try {
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
    } catch (err) {
      showToast('保存に失敗しました: ' + err.message);
      return;
    }

    save();
    if (typeof onSaved === 'function') onSaved();
  }

  function importSVG(file, onSuccess) {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const doc = new DOMParser().parseFromString(e.target.result, 'image/svg+xml');
        if (doc.querySelector('parsererror')) throw new Error('SVGのパースに失敗しました');
        const meta = doc.querySelector('metadata');
        const text = meta?.textContent?.trim();
        if (!text) throw new Error('openboard形式のメタデータが見つかりません');
        onSuccess(JSON.parse(text), file.name);
      } catch (err) {
        showToast('読み込みに失敗しました: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  // 開くダイアログ（File System Access API）でSVGファイルを開く。
  // 非対応ブラウザでは何もせず false を返す（呼び出し側で <input type="file"> にフォールバックする）。
  // 対応ブラウザではダイアログを表示した時点（キャンセル含む）で true を返す。
  async function openSVG(onSuccess) {
    if (!hasFileSystemAccess()) return false;

    let handle;
    try {
      [handle] = await window.showOpenFilePicker({ id: PICKER_ID, multiple: false, types: SVG_PICKER_TYPES });
    } catch (err) {
      if (err && err.name === 'AbortError') return true; // キャンセル
      showToast('ファイルを開けませんでした: ' + err.message);
      return true;
    }

    try {
      const file = await handle.getFile();
      importSVG(file, onSuccess);
    } catch (err) {
      showToast('ファイルを開けませんでした: ' + err.message);
    }
    return true;
  }

  return { save, load, exportSVG, importSVG, openSVG, hasFileSystemAccess, showToast };
})();
