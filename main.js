'use strict';

const { app, BrowserWindow } = require('electron');
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
