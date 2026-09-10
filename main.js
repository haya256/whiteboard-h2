'use strict';

const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'whiteboard-h2',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  // 内容のあるボードを閉じる・再読み込みするときの確認。
  // Electron はブラウザと違い、ページの beforeunload がキャンセルを試みても確認ダイアログを出さず、
  // 黙って離脱を拒否する（そのままではウィンドウを閉じられなくなる）。ここで自前の確認を出す。
  win.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['続ける', 'キャンセル'],
      defaultId: 1,
      cancelId: 1,
      title: 'whiteboard-h2',
      message: '保存していない変更が失われる可能性があります',
      detail: 'ウィンドウを閉じる／再読み込みを続けますか？'
    });
    // ここでの preventDefault はブラウザ側と意味が逆で、beforeunload を無視して離脱を許可する
    if (choice === 0) event.preventDefault();
  });

  win.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();

  // macOS: Dock アイコンクリックで再表示
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// macOS 以外: 全ウィンドウを閉じたら終了
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
