# BIFROST 交接文档 · 未实现功能

> 本文件只记录"设计已定、代码未实现"与"已实现但未验证"的部分，供新会话接手。
> 设计意图读 `docs/design/`，实际行为读代码与测试；本文件不重复定义设计。
> 与设计文档冲突时以设计文档为准，并回来更新本文件。
> 数据快照时间：2026-09-30。

## 缺口总表

| 编号 | 缺口 | 建议接手会话 | 规模 |
|---|---|---|---|
| G1 | 管理员内容管理：封面 / 系列 / 标签 | 管理员会话 | 中 |
| G2 | 评论审核收尾与待审核计数 | 管理员会话 | 小 |
| G3 | 上传文章链路：上传 → 导入任务 → 入库 → 物化 → 发布 | 管理员会话（第二轮） | 大 |
| G5 | Logic 展示页内容与项目条目写入 | Logic 会话 | 中 |
| G6 | 动态置顶 / 精选没有数据通路：前端已实现渲染，物化管线未输出字段 | 管理员会话 | 小 |
| V1 | 管理页评论审核在 `entryId` 改造后未实测 | 管理员会话 | 小 |
| V2 | 每日互动导出任务在换容器后未跑过 | 管理员会话 | 小 |
| V3 | 数据里的遗留脏项：重复系列、未清理标签 | 管理员会话 | 小 |

建议顺序：`G1 → G2 → V1/V2/V3 → G3`，`G6` 随手做，`G5` 单独会话。

## G1 管理员内容管理：封面 / 系列 / 标签

**现状**

- `admin.html` + `core/admin.js` + `core/admin.css` 已有：Microsoft 登录、运行状态、QQ 同步、评论审核、同步规则、内容覆盖项、手动导出。
- 服务端在 `api/src/functions/admin.js`，路由 `manage/{action}/{id?}`，动作有 `status` / `comments` / `settings` / `overrides` / `sync` / `qzone` / `export`。
- 内容侧写入能力为零：`api/src/lib/repository.js` 里没有任何条目或分类法的写入函数。
- 等价能力目前只在本机 CLI：`tools/seed-taxonomy.mjs`（阶段 / 分区 / 系列）、`tools/import-content.mjs --cover N`（只改内容包封面）、`tools/cosmos-push.mjs`。

**缺什么**

1. 封面：按 `entryId` 列出候选图（该篇正文图 + `assets` 里归属于该篇的媒体），点一张写入条目的 `cover` 与 `coverSource`，再触发物化。当前 19 篇里只有 4 篇有手动封面，其余走"正文首图 → 文字封面"兜底。
2. 系列：新建 / 修改系列文档（`label`、`description`、封面、`slug`），给成员设置 `seriesId` 与 `seriesOrder`，并支持调整顺序。
3. 标签：重命名、合并（写 `taxonomy` 的 tag 文档 + 批量改条目的 `tags`）。
4. 三者共用的"写权威库 → 重新物化 → 发布"链路；目前这条链路只能在本机或 CI 触发。

**涉及位置**

- 服务端：`api/src/functions/admin.js`、`api/src/lib/repository.js`、必要时 `api/src/lib/storage.js`。
- 前端：`admin.html`、`core/admin.js`、`core/admin.css`。
- 物化：`tools/materialize-site.mjs`、`tools/search-push.mjs`。

**验收**

- 登录管理页后不碰命令行即可：换一篇文章的封面、新建一个系列并把若干文章挂进去并排序、把两个重复标签合并。
- 改动在发布流程跑完后站点可见，`content-articles` 与 `search-docs` 一致。

**阻塞与风险**

- 点完不会自动上线，物化与发布仍在本机或 CI（见 G3）。本批可以只做到"写库 + 标记待发布"，也可以先复用现有 Pages workflow 触发发布。
- Cosmos 文档 `id` 不能含 `/`；`class` 是保留字（已改成 `assetClass`）。

## G2 评论审核收尾

**现状**：评论已按 `entryId` 归属，`comments` 容器分区键为 `/entryId`；`GET` / `PATCH` / `DELETE /manage/comments/{id}` 已按 `entryId` 改完；库里现有 1 条 `published` 评论。

**缺什么**

- 真登录实测列表、状态筛选、通过 / 隐藏 / 删除四条路径。
- 待审核数量的提示（管理页角标或状态卡片）。
- 确认新评论默认进入 `pending` 还是直接 `published`，并在管理页显示该规则。

**验收**：新评论出现在管理台；审核为 `published` 后前台立即可见；隐藏后前台消失；删除后不再出现。

## G3 上传文章链路

**现状**：导入链路只有本机 CLI，云端没有任何导入入口。

1. `tools/import-content.mjs` 把原件转成内容包（支持 `--cover N`）
2. `tools/blob-push.mjs` 媒体上云
3. `tools/cosmos-push.mjs` 写权威容器
4. `tools/materialize-site.mjs` 物化静态站点
5. `tools/search-push.mjs` 推送检索投影
6. `git push` 触发 Pages

云端只有 QQ 同步用的 Container Apps Job（`qzone-sync`，跑 `sync/` 镜像，`mode` 区分 `sync` / `auth`）。

**缺什么**

1. 上传接口：`POST /api/manage/import`，multipart 收文件，原件存私有 Blob，在 `state` 建导入任务记录，启动导入 Job。
2. 导入 Job：新增 `content-import`（镜像内加 pandoc，复用 `tools/` 的转换与建文档逻辑），或在同一镜像里加 `mode=import`。
3. 任务状态查询、失败原因、重试与幂等（设计文档明确留待后续阶段讨论）。
4. 云端产物回写 GitHub，才能"上传即上线"；`sync/src/github.js` 已有提交能力可复用。
5. CI：新增导入与检索相关 workflow（D-45），旧 Pages 流程保留至切换完成。

**验收**

- 在管理页上传 `冬滚滚.docx`，任务跑完后站点出现新文章，图片正常、封面可用、评论可发。
- docx 保真按 D-44：段落数、标题数、列表项数、图片数四项计数一致。
- 失败时任务记录里能看到原因，不是静默失败。

**阻塞与风险**

- 需要 pandoc 进入镜像、GitHub token 具备写权限、Container Apps Job 部署。
- 上传体积上限、允许的扩展名与安全校验规则尚未定（见 `20-backend.md` 留待后续阶段讨论）。
- VPN 不稳定时 `git push` 会 connection reset，重试 2–4 次可过。

## G5 Logic 展示页内容

**现状**：Logic 首页结构已落地（简介、技术栈、项目列表），数据是空占位（`data/site-index.json` 的 `showcase`）。

**缺什么**

- 创建 `kind: page` 的展示页条目与 `kind: project` 的项目条目；先脚本或 CLI 也可以，管理界面后置。
- 工作记录（GitHub 关联）的刷新方式未定。

**建议**：单独会话做。Logic 与 Fantasy 的内容管理基本不共用逻辑，混在一起会让两边都变慢。

## G6 动态置顶 / 精选的数据通路

**现状**：D-38 要求动态带置顶（`pinned`）与精选（`featured`）。前端已落地：`core/engine.js` 的 `renderDailyFeed` 把置顶排在最前并加「置顶」徽标，`renderMoment` 给精选加描边与「精选」徽标。Cosmos 侧的字段也存在，`tools/import-moments.mjs` 写入时会带上这两个布尔值。

**缺什么**

1. `tools/materialize-site.mjs` 物化 `moments` 时没有带出 `pinned` / `featured`，因此 `data/site-index.json` 里没有这两个字段，前端读不到，置顶与精选实际不生效。
2. 目前所有动态的 `pinned` / `featured` 都是 `false`，即使补上字段也没有可验证的样本。

**验收**：物化产物里带上两个字段；在库里把一条动态设为 `pinned`、另一条设为 `featured` 并重新物化后，时间流顶部出现置顶条目并带徽标，精选条目带描边。

## V1 / V2 未验证项

- **V1 管理页评论审核**：`entryId` 改造后没有实际登录跑过，见 G2。
- **V2 每日互动导出任务**：`export-daily` 在 `signals` 替换 `activity` 容器后没跑过，需要手动触发一次并确认导出的 Blob 内容正确。

## V3 数据遗留脏项

在 Cosmos 里实际查到的遗留问题，建议随 G1 的标签 / 系列管理一起清掉：

- `taxonomy` 里有两条同名系列：`series:paper-magician` 与 `series:纸上魔法使`。条目实际引用的是 `series:纸上魔法使`，`series:paper-magician` 无人引用，应删除或合并。
- 标签 `漫评` 与分区同名，按"和分区重复的标签去掉"应删除（当前 6 篇仍带此标签）。
- 标签 `反乌托邦` 应删除（当前 1 篇仍带）。
- 标签 `冬滚滚` 与 `冬暮川滚滚` 应合并（当前各 1 篇）。

以上四项在数据库与物化产物里都还存在，说明当时的清理决定没有落到数据上。

## 已知陷阱

- Cosmos 文档 `id` 不能含 `/`；`class` 是保留字，字段用 `assetClass`。
- Cosmos 的 `IS_DEFINED` 对 `null` 也为真，判断非空要配 `IS_NOT_NULL`。
- 版式属性不能漏，CSS 里 106 条规则依赖它们：`html[data-reading-layout]`、`html[data-image-layout]`、`.content-viewer[data-entry-type]`、`[data-entry-layout]`。
- `.entry-meta` 必须是 `.content-viewer` 的直接子元素（`≥1200px` 被隐藏，信息移到右侧阅读栏）。
- 位面用 `sessionStorage`：刷新保持、新会话回到 Logic。
- Pages 产物清单必须包含 `moment` 与 `series` 目录（曾漏 `series` 导致 404）。
- pandoc 用 `-t markdown-smart`（保住中文破折号），并剥离 `{width=...}` 尺寸属性。
- 端到端测试断言失败时必须在 `finally` 里关浏览器，否则 CI 挂死。
- 建 Cosmos 容器属于控制面操作，数据面 AAD 做不到，必须走 `az` / Bicep（容器定义在 `infra/main.bicep`）。

## 验证命令

```powershell
./preview.cmd                              # 本地预览，默认 http://localhost:8000/
node --test tests/*.test.mjs
node tests/e2e/site-navigation.mjs          # 需要先起 8125 端口的静态服务
npm ci --prefix api; npm test --prefix api
npm ci --prefix sync; npm test --prefix sync
```

## 现状快照（2026-09-30）

| 项目 | 数值 |
|---|---|
| 条目（文章 / 项目 / 页面） | 19 |
| 动态 | 3 |
| `content-articles` 文档 | 38（条目 + 正文） |
| `taxonomy` 文档 | 35（2 阶段、9 分区、22 标签、2 系列） |
| `assets` | 31 |
| `routes` | 44 |
| `search-docs` | 22 |
| `comments` | 1（published） |
| `signals` | 25 |
| 有手动封面的条目 | 4 |
| 静态产物目录 | `content/`、`moment/`、`series/`、`assets/`、`data/`、`core/` |

线上站点：<https://cpower-2ng.github.io>
