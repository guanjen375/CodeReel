'use strict';

function imageSize() {
  throw new Error('CodeReel MVP 禁止解析外部圖片；請使用已審核的 raster asset adapter。');
}

module.exports = imageSize;
module.exports.imageSize = imageSize;
