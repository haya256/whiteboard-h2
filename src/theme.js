'use strict';

// 新しく作るノード・コネクタの既定色と、スタイル編集に並ぶ色パレットのカタログ。
// 設定「新規ノードの色」で切り替える。
//
// ここが持つのは「作成時にコピーされる既定値」だけで、既存の要素の色は変えない
// （色は各ノード・各コネクタが自分の style に持っていて、.svg にもその値が保存される）。
//
// 既定色とパレットを同じセットに入れているのは、スタイル編集で「選択中」のスウォッチが
// 光るかどうかが色の完全一致で決まるため。既定色がパレットに無いと選択中に見えなくなる。
const Theme = (() => {
  // 明るい色ばかりだと暗い背景で沈むので、セットごとにパレットの並びも変える。
  // 先頭が既定色になるよう揃えてある。
  const THEMES = {
    light: {
      label: 'ライト',
      sticky: { background: '#FFF275', color: '#333333' },
      shape: { background: '#ffffff', border: '#4a90e2', color: '#333333' },
      text: { color: '#333333' },
      edge: { color: '#333333' },
      // 付箋の背景色の選択肢（黄・ピンク・水色・緑・紫の定番5色）
      stickyColors: ['#FFF275', '#FF7EB9', '#7AFCFF', '#A7F3D0', '#E2B0FF'],
      textColors: ['#333333', '#757575', '#ffffff', '#e53935', '#fb8c00', '#43a047', '#1e88e5', '#8e24aa'],
      // コネクタは明るい背景の上に引くので白は入れない
      edgeColors: ['#333333', '#757575', '#e53935', '#fb8c00', '#43a047', '#1e88e5', '#8e24aa']
    },
    dark: {
      label: 'ダーク',
      // 付箋は暗い背景でもよく映えるので、ライトと同じ明るい色のまま濃いグレーの文字で使う
      sticky: { background: '#FFF275', color: '#333333' },
      shape: { background: '#2a2b3d', border: '#6aa9f0', color: '#ffffff' },
      text: { color: '#ffffff' },
      // 白のままだと線が主張しすぎるので少し落とす
      edge: { color: '#c8c8d4' },
      stickyColors: ['#FFF275', '#FF7EB9', '#7AFCFF', '#A7F3D0', '#E2B0FF'],
      // #333333 は明るい付箋の上に置く文字用に残す
      textColors: ['#ffffff', '#c8c8d4', '#333333', '#ff8a80', '#ffcc80', '#a5d6a7', '#90caf9', '#ce93d8'],
      edgeColors: ['#c8c8d4', '#ffffff', '#757575', '#ff8a80', '#ffcc80', '#a5d6a7', '#90caf9', '#ce93d8']
    }
  };

  let _current = THEMES.light;

  // 未知の名前（古い設定が残っている等）が来たらライトに戻す
  Settings.subscribe('theme', name => { _current = THEMES[name] || THEMES.light; });

  Settings.buildRadioRow('setting-theme', 'theme',
    Object.keys(THEMES).map(value => ({ value, label: THEMES[value].label })));

  return {
    get() { return _current; }
  };
})();
