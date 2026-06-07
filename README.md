# whiteboard-h2

SVGベースの軽量ホワイトボードツール。ブラウザとElectronデスクトップアプリの両方で動作します。

## 特徴

- ゼロ依存（バニラJS + SVG）
- ブラウザ・Electronどちらでも動作
- ボードを `.svg` ファイルとして保存（SVG + 埋め込みJSONで再編集可能）

## 起動

```bash
npm install      # 初回のみ
npm start        # Electron デスクトップアプリ
npm run serve    # ブラウザ版（http://localhost:8080）
```

## 使い方

| 操作 | 方法 |
|------|------|
| 付箋を追加 | 「+ 付箋」ボタン |
| 移動 | ドラッグ |
| テキスト編集 | ダブルクリック |
| 削除 | クリックで選択 → Delete キー |
| 保存 | 「保存 (.svg)」ボタン |
| 読み込み | 「開く (.svg)」ボタン |

## データ形式

`.svg` ファイルとして保存されます。SVGとして任意のビューアで表示でき、openboardで再度読み込んで編集することもできます。

## WSL2 での注意

初回のみ以下のライブラリが必要です：

```bash
sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 libasound2t64 libgtk-3-0 libxss1 libxtst6 libxrandr2
```
