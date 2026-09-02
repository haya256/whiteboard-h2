'use strict';

// ロリポップ Deploy Now (Next.js standalone) で静的アプリを配信するための設定。
// アプリ本体は public/ (ビルド時に index.html, style.css, src/ をコピー) から配信する。
module.exports = {
  output: 'standalone',
  async rewrites() {
    return {
      beforeFiles: [{ source: '/', destination: '/index.html' }],
    };
  },
};
