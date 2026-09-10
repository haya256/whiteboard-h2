'use strict';

// アプリ全体の設定。値は localStorage に持ち、ボードの内容（自動保存・.svg）とは分けて扱う。
// 設定項目を増やすときは DEFAULTS に1行足し、設定ダイアログに行を1つ足し、
// 反映したいモジュールから subscribe() する。
const Settings = (() => {
  const STORAGE_KEY = 'openboard_settings_v01';

  // 設定項目の一覧と既定値。保存済みの値のうちここに無いキーは読み捨てる
  // （古いバージョンで消した項目が残り続けないようにするため）。
  const DEFAULTS = {
    background: 'dots' // キャンバスの背景。値は src/view.js の BACKGROUNDS のキー
  };

  let _values = { ...DEFAULTS };
  const _listeners = new Map(); // key -> 値が変わったときに呼ぶ関数の配列

  function load() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return; // localStorage が使えない環境では既定値のまま動かす
    }
    if (!raw) return;
    try {
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== 'object') return;
      Object.keys(DEFAULTS).forEach(key => {
        if (key in saved) _values[key] = saved[key];
      });
    } catch (e) {
      // 壊れた値は既定値で上書きされるので無視する
    }
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(_values));
    } catch (e) {
      // 保存できなくてもこのセッションの表示には効いているので続行する
    }
  }

  function get(key) {
    return _values[key];
  }

  function set(key, value) {
    if (!(key in DEFAULTS) || _values[key] === value) return;
    _values[key] = value;
    persist();
    (_listeners.get(key) || []).forEach(fn => fn(value));
  }

  // 値が変わったときに fn(value) を呼ぶ。登録時にも現在値で1回呼ぶので、
  // 購読側は「初期適用」と「変更時の再適用」を1か所に書ける。
  function subscribe(key, fn) {
    if (!_listeners.has(key)) _listeners.set(key, []);
    _listeners.get(key).push(fn);
    fn(_values[key]);
  }

  load();

  // ---- 設定ダイアログ ----
  // 開閉とキー操作の扱いは src/dialog.js / src/welcome.js に揃える。

  const overlay = document.getElementById('settings-overlay');
  const openBtn = document.getElementById('btn-settings');
  const closeBtn = document.getElementById('settings-close');

  function open() {
    if (!overlay) return;
    overlay.hidden = false;
    if (closeBtn) closeBtn.focus();
  }

  function close() {
    if (!overlay) return;
    overlay.hidden = true;
  }

  // ラジオボタンの並びを作る。items は [{ value, label }] の配列。
  // 選択肢は各モジュールのカタログ（背景なら View.getBackgrounds()）から渡してもらうので、
  // 項目を増やしても index.html は触らなくてよい。
  function buildRadioRow(containerId, key, items) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';
    items.forEach(item => {
      const label = document.createElement('label');
      label.className = 'settings-choice';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'setting-' + key;
      input.value = item.value;
      input.checked = get(key) === item.value;
      input.addEventListener('change', () => { if (input.checked) set(key, item.value); });
      label.appendChild(input);
      label.appendChild(document.createTextNode(' ' + item.label));
      container.appendChild(label);
    });
  }

  if (overlay) {
    if (openBtn) openBtn.addEventListener('click', open);
    if (closeBtn) closeBtn.addEventListener('click', close);

    // オーバーレイの外側（暗い部分）のクリックで閉じる
    overlay.addEventListener('click', e => {
      if (e.target === overlay) close();
    });

    // 背面のキャンバスがドラッグ・選択解除を拾わないようにする
    overlay.addEventListener('mousedown', e => e.stopPropagation());

    // 表示中のキー操作がキャンバス側のショートカット（Delete / Ctrl+A など）に
    // 横取りされないよう、capture 段階で止める
    document.addEventListener('keydown', e => {
      if (overlay.hidden) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      e.stopPropagation();
    }, true);
  }

  return { get, set, subscribe, open, buildRadioRow };
})();
