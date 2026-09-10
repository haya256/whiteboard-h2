'use strict';

// ツールバーのグループが横幅に収まらないとき、末尾のボタンから「⋯」メニューへ退避させる。
// ボタンは要素ごと動かすので、app.js が addEventListener で付けたハンドラはそのまま生きる
// （ID による参照も変わらない）。
const Ribbon = (() => {
  const toolbar = document.getElementById('toolbar');
  const groupsEl = toolbar && toolbar.querySelector('.ribbon-groups');
  if (!toolbar || !groupsEl) return {};

  // 横幅が足りないときに畳んでいく順。先にあるグループから畳む。
  // その他（設定・ヘルプ）は使う頻度が低いので最初に畳み、編集は Ctrl+Z / Ctrl+Y で代用でき、
  // 挿入はこのアプリの主作業なので最後まで残す。
  const COLLAPSE_ORDER = ['misc', 'edit', 'view', 'file', 'insert'];

  // グループごとの情報。items = 通常時に並ぶ要素（ボタン・ラベル）を元の順で保持したもの
  const groups = new Map();

  groupsEl.querySelectorAll('.ribbon-group').forEach(el => {
    const itemsEl = el.querySelector('.ribbon-group-items');
    const menuEl = el.querySelector('.ribbon-menu');
    const moreBtn = itemsEl.querySelector('.ribbon-more');
    // 「⋯」自身は退避対象に含めない
    const items = Array.from(itemsEl.children).filter(c => c !== moreBtn);
    groups.set(el.dataset.group, { el, itemsEl, menuEl, moreBtn, items });
  });

  // ---- 再配置 ----
  // 幅は定数で見積もらず、実際の DOM の幅を見て判定する
  // （フォントの読み込みタイミングや余白の変更に左右されないようにするため）。
  // 全部戻す → はみ出している間だけ畳む、を同じフレーム内で行うのでちらつきは起きない。

  function isOverflowing() {
    return groupsEl.scrollWidth > groupsEl.clientWidth + 1;
  }

  // そのグループでツールバー上に残っている要素の数
  function visibleCount(g) {
    return g.items.filter(el => el.parentElement === g.itemsEl).length;
  }

  // 末尾の1つをメニューへ送る
  function collapseLast(g) {
    const shown = g.items.filter(el => el.parentElement === g.itemsEl);
    const last = shown[shown.length - 1];
    if (!last) return false;
    if (g.moreBtn) g.moreBtn.hidden = false; // 「⋯」自身の幅も勘定に入れるため先に出す
    g.menuEl.insertBefore(last, g.menuEl.firstChild); // 元の並び順を保って先頭へ積む
    return true;
  }

  // すべてツールバー上へ戻す
  function restoreAll(g) {
    g.items.forEach(el => g.itemsEl.insertBefore(el, g.moreBtn));
    if (g.moreBtn) g.moreBtn.hidden = true;
    closeMenu(g);
  }

  function layout() {
    groups.forEach(restoreAll);
    if (!isOverflowing()) return;

    for (const name of COLLAPSE_ORDER) {
      const g = groups.get(name);
      if (!g) continue;
      // 各グループの左端のボタンは最後まで残す（そのグループが何なのか分かるようにするため）
      while (isOverflowing() && visibleCount(g) > 1) {
        const before = groupsEl.scrollWidth;
        collapseLast(g);
        // 「⋯」のほうが幅を食うなら畳んでも意味がないので、戻してこのグループは打ち切る
        if (groupsEl.scrollWidth >= before) { restoreAll(g); break; }
      }
      if (!isOverflowing()) break;
    }
  }

  // ---- 「⋯」メニューの開閉 ----

  let openGroup = null;

  function closeMenu(g) {
    const target = g || openGroup;
    if (!target) return;
    target.menuEl.hidden = true;
    if (target.moreBtn) target.moreBtn.setAttribute('aria-expanded', 'false');
    if (openGroup === target) openGroup = null;
  }

  function openMenu(g) {
    closeMenu();
    const rect = g.moreBtn.getBoundingClientRect();
    g.menuEl.hidden = false;
    g.menuEl.style.top = Math.round(rect.bottom + 6) + 'px';
    // 右端からはみ出す場合は左へずらす
    const width = g.menuEl.getBoundingClientRect().width;
    const left = Math.min(rect.left, window.innerWidth - width - 8);
    g.menuEl.style.left = Math.round(Math.max(8, left)) + 'px';
    g.moreBtn.setAttribute('aria-expanded', 'true');
    openGroup = g;
  }

  groups.forEach(g => {
    if (!g.moreBtn) return;
    g.moreBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (openGroup === g) closeMenu(g);
      else openMenu(g);
    });
    // メニュー内のボタンを押したら閉じる（ファイル選択用の label も同じ扱いでよい）
    g.menuEl.addEventListener('click', e => {
      if (e.target.closest('button, label')) closeMenu(g);
    });
  });

  document.addEventListener('mousedown', e => {
    if (!openGroup) return;
    if (openGroup.menuEl.contains(e.target) || openGroup.moreBtn.contains(e.target)) return;
    closeMenu();
  });

  document.addEventListener('keydown', e => {
    if (openGroup && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
  }, true);

  // 幅が変わったら組み直す
  new ResizeObserver(() => layout()).observe(groupsEl);

  layout();
  // Web フォントの読み込みでボタン幅が変わることがあるので、確定後にもう一度組み直す
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);

  return { layout };
})();
