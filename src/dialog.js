'use strict';

// 確認ダイアログ。window.confirm は使わず、#toast や #welcome-overlay と同じくページ内 UI で確認する。
// 呼び出し側は Promise を await して、ユーザーが選んだ結果で処理を分岐する。
const Dialog = (() => {
  const overlay = document.getElementById('confirm-overlay');
  const messageEl = document.getElementById('confirm-message');
  const saveBtn = document.getElementById('confirm-save');
  const discardBtn = document.getElementById('confirm-discard');
  const cancelBtn = document.getElementById('confirm-cancel');

  // 表示中のみ設定される解決関数。二重に解決しないよう、閉じるときに null に戻す
  let _resolve = null;

  function close(answer) {
    if (!_resolve) return;
    const resolve = _resolve;
    _resolve = null;
    overlay.hidden = true;
    resolve(answer);
  }

  if (overlay) {
    saveBtn.addEventListener('click', () => close('save'));
    discardBtn.addEventListener('click', () => close('discard'));
    cancelBtn.addEventListener('click', () => close('cancel'));

    // オーバーレイの外側（暗い部分）のクリックはキャンセル扱い
    overlay.addEventListener('click', e => {
      if (e.target === overlay) close('cancel');
    });

    // ダイアログ表示中のキー操作がキャンバス側のショートカット（Delete / Ctrl+A など）に
    // 横取りされないよう、welcome.js と同様に capture 段階で止める
    document.addEventListener('keydown', e => {
      if (overlay.hidden) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close('cancel');
        return;
      }
      e.stopPropagation();
    }, true);

    // 背面のキャンバスがドラッグ・選択解除を拾わないようにする
    overlay.addEventListener('mousedown', e => e.stopPropagation());
  }

  return {
    // 未保存の変更を捨ててよいか尋ねる。
    // actionLabel は「新規作成」「開く」など、これから行う操作の名前（ボタンの文言に使う）。
    // 戻り値は Promise<'save' | 'discard' | 'cancel'>。
    // overlay が無い場合（マークアップ未読み込み）は 'discard' として素通しする。
    confirmDiscard(boardTitle, actionLabel) {
      if (!overlay) return Promise.resolve('discard');
      close('cancel'); // 既に開いていれば先に閉じる（多重表示の保険）

      const label = actionLabel || '続行';
      messageEl.textContent = `「${boardTitle}」の内容は .svg に保存されていません。このまま続けると変更は失われます。`;
      saveBtn.textContent = '保存して' + label;
      discardBtn.textContent = '保存せずに' + label;
      overlay.hidden = false;
      saveBtn.focus();

      return new Promise(resolve => { _resolve = resolve; });
    }
  };
})();
