'use strict';

// 画像追加時の圧縮ユーティリティ。localStorage 容量を節約するため、
// 追加時に長辺を MAX_EDGE 以下へ縮小し、JPEG/PNG で再エンコードする。
const ImageUtil = (() => {
  const MAX_EDGE = 1600; // 長辺の上限 px
  const JPEG_QUALITY = 0.85; // JPEG 再エンコード品質

  // FileReader で file を dataURL に変換する
  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.onerror = () => reject(reader.error || new Error('ファイルの読み込みに失敗しました'));
      reader.readAsDataURL(file);
    });
  }

  // dataURL を Image としてロードし、自然サイズを取得する
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
      img.src = src;
    });
  }

  // 縮小後キャンバスの透過有無を判定する（アルファが 255 未満のピクセルが1つでもあれば透過あり）
  function hasTransparency(ctx, width, height) {
    const { data } = ctx.getImageData(0, 0, width, height);
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) return true;
    }
    return false;
  }

  // file (Blob) を圧縮し、{src, width, height} を返す
  function compress(file) {
    return readAsDataURL(file).then(originalSrc => {
      const type = file.type || '';

      // SVG / GIF は圧縮しない（SVG はベクタで元々小さく、GIF はアニメが壊れるため）
      if (type === 'image/svg+xml' || type === 'image/gif') {
        return loadImage(originalSrc).then(img => ({
          src: originalSrc,
          width: img.naturalWidth,
          height: img.naturalHeight
        }));
      }

      return loadImage(originalSrc).then(img => {
        const naturalW = img.naturalWidth;
        const naturalH = img.naturalHeight;
        const scale = Math.min(1, MAX_EDGE / Math.max(naturalW, naturalH));
        const width = Math.max(1, Math.round(naturalW * scale));
        const height = Math.max(1, Math.round(naturalH * scale));

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        const transparent = hasTransparency(ctx, width, height);
        let resultSrc;
        if (transparent) {
          resultSrc = canvas.toDataURL('image/png');
        } else {
          // JPEG は透過を保持できないため、白背景で塗ってから描画し直す
          ctx.globalCompositeOperation = 'destination-over';
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, width, height);
          resultSrc = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
        }

        // 再エンコードした方が元より大きくなる場合は、元データをそのまま採用する
        if (resultSrc.length > originalSrc.length) {
          return { src: originalSrc, width: naturalW, height: naturalH };
        }
        return { src: resultSrc, width, height };
      });
    });
  }

  return { compress };
})();
