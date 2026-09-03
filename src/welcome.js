'use strict';

// 初回起動時のウェルカム画面。「次回から表示しない」を選ぶと localStorage にフラグを残し、
// 以降は自動表示しない（ツールバーの「？ ヘルプ」からは常に開ける）。
(() => {
  const DISMISS_KEY = 'openboard_welcome_dismissed';

  const overlay = document.getElementById('welcome-overlay');
  const dialog = document.getElementById('welcome-dialog');
  const checkbox = document.getElementById('welcome-dont-show');
  const closeBtn = document.getElementById('welcome-close');
  const helpBtn = document.getElementById('btn-help');

  if (!overlay || !dialog || !checkbox || !closeBtn) return;

  function isDismissed() {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function open() {
    checkbox.checked = isDismissed();
    overlay.hidden = false;
    closeBtn.focus();
  }

  function close() {
    try {
      if (checkbox.checked) {
        localStorage.setItem(DISMISS_KEY, '1');
      } else {
        localStorage.removeItem(DISMISS_KEY);
      }
    } catch (e) {
      // localStorage が使えない環境では無視する
    }
    overlay.hidden = true;
  }

  closeBtn.addEventListener('click', close);

  if (helpBtn) {
    helpBtn.addEventListener('click', open);
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  overlay.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });

  document.addEventListener('keydown', (e) => {
    if (overlay.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    e.stopPropagation();
  }, true);

  if (!isDismissed()) {
    open();
  }
})();
