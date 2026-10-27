'use strict';
/**
 * 站点强制深色样式。
 *
 * 配色参考 PI-Desktop 的深色令牌（取自其 index.css 的 --ds-* / --gray-*）：
 *   --gray-900 #181818  主背景      --gray-800 #212121  次级/elevated
 *   --gray-750 #282828  三级        --gray-1000 #0d0d0d 内嵌/底层
 *   --gray-100 #ededed  主文字      --gray-300 #afafaf  次文字
 * 夸克网页本身没有深色主题，这里用「整页反色 + 色相旋转」实现；
 * 再用 contrast(.9) 把反色后的纯黑抬到 ≈#0d0d0d，贴近 PI-Desktop 的中性灰底。
 */
const DARK_CSS = `
html { filter: invert(1) hue-rotate(180deg) contrast(.9) !important; }

/* 图片/视频/画布/图标再反色回来，并用相反的 contrast 抵消父级压缩 */
img, video, canvas, svg, picture, [style*="background-image"], iframe {
  filter: invert(1) hue-rotate(180deg) contrast(1.111) !important;
}

/* 滚动条也换成 PI-Desktop 的深色轨道 */
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: #303030; border-radius: 6px; }
::-webkit-scrollbar-track { background: #0d0d0d; }
::selection { background: rgba(237,237,237,.22) !important; }
`;

module.exports = { DARK_CSS };
