'use strict';

// このモジュールには紛らわしい「保存」が3つある。役割は次のとおり。
//   save()       … localStorage への自動保存。操作のたびに呼ばれ、常に最新。ファイルには触らない
//   saveFile()   … 「保存」。開いているファイルへ確認なしで上書きする。結びついたファイルが無ければ saveFileAs() に委譲
//   saveFileAs() … 「名前を付けて保存」。保存ダイアログで保存先とファイル名を決めてから書き出す
const IO = (() => {
  const STORAGE_KEY = 'openboard_v01';
  // 最後に .svg へ書き出した（または .svg から開いた）時点の内容の指紋。
  // localStorage の自動保存は常に最新なので「未保存かどうか」の基準にはならず、
  // .svg への書き出しを基準にするためこのキーを別に持つ。
  // buildData() に含めると書き出した .svg のメタデータにも混入するため、保存先も分けている。
  const EXPORT_MARK_KEY = 'openboard_export_mark_v01';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // File System Access API（Chrome / Edge）用。同じ id を使うと「開く」「保存」で最後に使ったフォルダを
  // ブラウザが記憶して共有してくれる。非対応ブラウザでは従来の input / ダウンロードにフォールバックする。
  const PICKER_ID = 'openboard-svg';
  const SVG_PICKER_TYPES = [{ description: 'SVG ボード', accept: { 'image/svg+xml': ['.svg'] } }];
  function hasFileSystemAccess() {
    return typeof window.showOpenFilePicker === 'function' && typeof window.showSaveFilePicker === 'function';
  }
  function stripSvgExt(name) { return String(name || '').replace(/\.svg$/i, '').trim(); }

  // 「開く」または「名前を付けて保存」で結びついたファイル。「保存」の上書き先になる。
  // ページを離れるまでの寿命で、IndexedDB などへ永続化はしない
  // （リロード後は null に戻り、「保存」は「名前を付けて保存」と同じ動作になる）。
  let _fileHandle = null;

  // 保存 SVG をブラウザで開いたときに画面と同じ見た目になるよう、style.css の該当規則（見た目に関わるものだけ）を転記している。
  // style.css を変更したらここも揃えること。
  const EXPORT_CSS = `
svg { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
.sticky-bg { filter: drop-shadow(2px 3px 6px rgba(0,0,0,0.18)); }
.shape-bg { filter: drop-shadow(2px 3px 6px rgba(0,0,0,0.14)); }
.image-el { filter: drop-shadow(2px 3px 6px rgba(0,0,0,0.14)); }
.sticky-fo, .shape-fo, .text-fo { overflow: visible; }
.sticky-text-wrap {
  width: 100%;
  height: 100%;
  display: flex;
  overflow: hidden;
}
.sticky-text {
  width: 100%;
  max-height: 100%;
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
}
.shape-text {
  width: 100%;
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
.link-badge-hit { fill: none; } /* クリック用の当たり判定。塗らずに透明のままにする */
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

  // ---- 未保存かどうかの判定（.svg への書き出しを基準にする） ----
  // 比較対象は nodes / edges / ボード名。viewport（パン・ズーム）は History の対象外なのでここでも含めない。

  function fingerprint() {
    return JSON.stringify({ title: Model.getTitle(), nodes: Model.getNodes(), edges: Model.getEdges() });
  }

  // 現在の内容を「保存済み」として記録する（.svg の保存・読み込み・新規作成の直後に呼ぶ）
  function markSaved() {
    try {
      localStorage.setItem(EXPORT_MARK_KEY, fingerprint());
    } catch (e) {
      // 容量超過などで記録できない場合は、次回 isDirty() が保守的に true 側へ倒れるだけなので無視する
    }
  }

  // 最後に .svg を保存/読み込みした時点から内容が変わっていれば true。
  // 基準が未記録の場合（この機能より前から残っているボード）は、内容があれば未保存とみなす。
  function isDirty() {
    let mark = null;
    try {
      mark = localStorage.getItem(EXPORT_MARK_KEY);
    } catch (e) {
      mark = null;
    }
    if (mark === null) return Model.getNodes().length > 0 || Model.getEdges().length > 0;
    return mark !== fingerprint();
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

      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', View.edgePathD(edge));
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', edge.style.color);
      path.setAttribute('stroke-width', edge.style.width);

      if (edge.style.arrow !== 'none') {
        const mid = ensureMarker(edge.style.color);
        if (edge.style.arrow === 'end' || edge.style.arrow === 'both') {
          path.setAttribute('marker-end', `url(#${mid})`);
        }
        if (edge.style.arrow === 'start' || edge.style.arrow === 'both') {
          path.setAttribute('marker-start', `url(#${mid})`);
        }
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

  // ハンドルへ実際に書き込む。失敗したら通知して false を返す
  async function writeHandle(handle, text) {
    try {
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return true;
    } catch (err) {
      showToast('保存に失敗しました: ' + err.message);
      return false;
    }
  }

  // 書き込み許可があるか確かめ、無ければユーザーに求める。
  // 「開く」で得たハンドルは読み取り許可しか持たないため、初回の上書き時にブラウザの確認が1回出る。
  async function ensureWritePermission(handle) {
    if (typeof handle.queryPermission !== 'function' || typeof handle.requestPermission !== 'function') return true;
    const opts = { mode: 'readwrite' };
    if (await handle.queryPermission(opts) === 'granted') return true;
    return await handle.requestPermission(opts) === 'granted';
  }

  // 「名前を付けて保存」。保存ダイアログ（File System Access API）で保存先とファイル名を決める。
  // 対応ブラウザでは「開く」と同じ id を使うため、最後に保存/読み込みしたフォルダをブラウザが覚えていて、
  // 次回もそのフォルダが開く。
  // onSaved はダイアログ経由の保存が成功したときのみ呼ばれる（フォールバック時は呼ばない）。
  // 戻り値は保存できたかどうか（true = 保存した / false = キャンセル・失敗）。
  // 「保存して新規作成」のように、保存の成否を見てから次の処理へ進みたい呼び出し側が使う。
  async function saveFileAs(onSaved) {
    if (!hasFileSystemAccess()) {
      // <a download> はブラウザに渡した時点で成否を確認できないため、保存されたものとして扱う。
      // ダウンロードでは書き込み先を掴めないので、以降の「保存」もここへ来る
      downloadSVG(buildSVGString());
      markSaved();
      return true;
    }

    let handle;
    try {
      handle = await window.showSaveFilePicker({
        id: PICKER_ID,
        suggestedName: toFileName(Model.getTitle()),
        types: SVG_PICKER_TYPES
      });
    } catch (err) {
      if (err && err.name === 'AbortError') return false; // キャンセル
      showToast('保存ダイアログを開けませんでした: ' + err.message);
      downloadSVG(buildSVGString());
      markSaved();
      return true;
    }

    // ダイアログで付けたファイル名を先にボード名へ反映してから SVG を組み立てる
    // （SVG 内のメタデータにも新しいタイトルが入るようにする。次回の保存名・タブ名にも使う）
    const name = stripSvgExt(handle.name);
    if (name) Model.setTitle(name);

    if (!await writeHandle(handle, buildSVGString())) return false;

    _fileHandle = handle; // 以降の「保存」はこのファイルを上書きする
    save();
    markSaved();
    if (typeof onSaved === 'function') onSaved();
    return true;
  }

  // 「保存」。結びついたファイルへ確認なしで上書きする。
  // 上書きできない事情（ファイル未確定・改名・許可なし・書き込み失敗）があれば「名前を付けて保存」へ委譲する。
  // 戻り値の意味は saveFileAs と同じ。
  async function saveFile(onSaved) {
    if (!_fileHandle) return saveFileAs(onSaved);

    // ボード名を変えた＝別名で保存したい、とみなす。「ボード名＝ファイル名」を保ちたいので上書きはしない。
    // 比較は toFileName() を通した形で行う（ファイル名に使えない文字は落ちるため、生のボード名とは一致しないことがある）
    if (_fileHandle.name !== toFileName(Model.getTitle())) return saveFileAs(onSaved);

    if (!await ensureWritePermission(_fileHandle)) {
      showToast('書き込みが許可されなかったため、保存先を選び直します');
      return saveFileAs(onSaved);
    }

    // 上書きに失敗するのは主にファイルが移動・削除された場合。保存先を選び直してもらう
    if (!await writeHandle(_fileHandle, buildSVGString())) return saveFileAs(onSaved);

    save();
    markSaved();
    // 上書き保存は画面が何も変わらないので、保存できたことをトーストで知らせる
    showToast('保存しました: ' + _fileHandle.name);
    if (typeof onSaved === 'function') onSaved();
    return true;
  }

  function clearFileHandle() {
    _fileHandle = null;
  }

  // handle は File System Access API で開いた場合のみ渡される（<input type="file"> 経由では undefined）。
  // 読み込みに成功したときだけ「保存」の上書き先として覚える。失敗時はボードが変わらないのでハンドルも触らない。
  function importSVG(file, onSuccess, handle) {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const doc = new DOMParser().parseFromString(e.target.result, 'image/svg+xml');
        if (doc.querySelector('parsererror')) throw new Error('SVGのパースに失敗しました');
        const meta = doc.querySelector('metadata');
        const text = meta?.textContent?.trim();
        if (!text) throw new Error('openboard形式のメタデータが見つかりません');
        _fileHandle = handle || null;
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
      importSVG(file, onSuccess, handle);
    } catch (err) {
      showToast('ファイルを開けませんでした: ' + err.message);
    }
    return true;
  }

  return { save, load, saveFile, saveFileAs, clearFileHandle, importSVG, openSVG, hasFileSystemAccess, showToast, markSaved, isDirty };
})();
