// 视图注册表：app.js 的路由按 id 查这里。

import overview from './overview.js';
import entries from './entries.js';
import series from './series.js';
import tags from './tags.js';
import moments from './moments.js';
import upload from './upload.js';
import qzone from './qzone.js';
import comments from './comments.js';
import rules from './rules.js';
import exportView from './export.js';

export default {
  overview,
  entries,
  series,
  tags,
  moments,
  upload,
  qzone,
  comments,
  rules,
  export: exportView,
};
