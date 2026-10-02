# BIFROST 交接文档 · 未实现功能

> 本文件只记录"设计已定、代码未实现"与"已实现但未验证"的部分，供新会话接手。
> 设计意图读 `docs/design/`，实际行为读代码与测试；本文件不重复定义设计。
> 与设计文档冲突时以设计文档为准，并回来更新本文件。
> 数据快照时间：2026-09-30；G1/G2/G3/G6 于 2026-10-02 落地（见文末"本轮完成"）。

## 缺口总表

| 编号 | 缺口 | 建议接手会话 | 规模 |
|---|---|---|---|
| ~~G1~~ | ~~管理员内容管理：封面 / 系列 / 标签~~ | 已完成，见文末 | — |
| G2 | 评论审核收尾：真登录实测仍待做 | 管理员会话 | 小 |
| ~~G3~~ | ~~上传文章链路~~ | 代码已落地，云端部署与实测待做，见文末 | — |
| G5 | Logic 展示页内容与项目条目写入 | Logic 会话 | 中 |
| ~~G6~~ | ~~动态置顶 / 精选数据通路~~ | 已完成，见文末 | — |
| V1 | 管理页评论审核在 `entryId` 改造后未实测 | 管理员会话 | 小 |
| V2 | 每日互动导出任务在换容器后未跑过 | 管理员会话 | 小 |
| V3 | 数据里的遗留脏项：重复系列、未清理标签 | 管理员会话（现在可以直接在管理台标签面板处理） | 小 |
| D1 | 云端链路首次部署：bicep、镜像、真实上传实测 | 部署会话（需 Azure 登录） | 中 |

建议顺序：`D1 → V1/V2 → V3`（V3 用管理台标签面板即可），`G5` 单独会话。

## G1 管理员内容管理：封面 / 系列 / 标签（已完成，2026-10-02）

服务端新增 `manage/entries|series|tags|moments` 动作（`api/src/functions/admin.js`），内容读写函数在 `api/src/lib/repository.js`，纯函数校验在 `api/src/lib/content-admin.js`（配单测）。管理页新增条目/系列/标签/动态四个面板。改动只写权威库并置 `publish-state.dirty`，上线走"发布"按钮（云端物化 + 回写 + 检索推送）。云端部署与真登录实测见 D1。

## G2 评论审核收尾（代码已完成，实测待做）

待审核计数已进 `status` 动作并渲染为状态卡；审核规则（干净评论直接发布、含链接转待审核、蜜罐/过快拒绝，见 `api/src/lib/moderation.js`）已在评论面板顶部展示。剩余：V1 真登录实测四条路径。

## G3 上传文章链路（代码已落地，云端部署与实测待做 → 见 D1）

已落地：`POST /manage/import`（multipart，校验在 `api/src/lib/import-validate.js`）→ 原件入私有 Blob `originals/` → 导入任务文档（`state`，分区 `imports`）→ `content-import` Job 复用 `tools/` 管线完成转换与入库 → 管理台上传面板轮询任务状态。发布走 `content-publish` Job（统一发布按钮）。镜像已加 pandoc 与 poppler-utils，`deploy-sync-image.yml` 构建上下文改为仓库根并同步更新两个新 Job。云端首次部署（bicep + 镜像 + 真实上传 `冬滚滚.docx` 验收）待做。

## G5 Logic 展示页内容

**现状**：Logic 首页结构已落地（简介、技术栈、项目列表），数据是空占位（`data/site-index.json` 的 `showcase`）。

**缺什么**

- 创建 `kind: page` 的展示页条目与 `kind: project` 的项目条目；先脚本或 CLI 也可以，管理界面后置。
- 工作记录（GitHub 关联）的刷新方式未定。

**建议**：单独会话做。Logic 与 Fantasy 的内容管理基本不共用逻辑，混在一起会让两边都变慢。

## G6 动态置顶 / 精选的数据通路（已完成，2026-10-02）

`tools/materialize-site.mjs` 已输出 `pinned` / `featured`；`tools/moment-flags.mjs` 可直接设置样本并同步检索投影；管理台"动态置顶与精选"面板提供开关。剩余：部署后设一条置顶、一条精选并发布，在前台验收徽标与描边。

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

## 本轮完成（2026-10-02：G1 / G2 / G3 / G6 代码落地）

- **服务端**：`manage/entries|series|tags|moments|import|publish` 全套动作；`repository.js` 内容读写；`content-admin.js` 与 `import-validate.js` 纯函数（含单测）；`storage.js` 新增 `uploadPrivateBlob`。
- **管理台**：发布、条目管理、系列管理、标签管理、动态置顶/精选、上传文章六个新面板（`admin.html` / `core/admin.js` / `core/admin.css`）。
- **云端任务**：`tools/cloud-import.mjs`（导入）与 `tools/cloud-publish.mjs`（投影全量重建 → 物化 → 回写 GitHub → 推送 AI Search）；`sync/src/github.js` 抽出通用 `commitFiles` 与 `listBlobPaths`。
- **基础设施**：`infra/main.bicep` 新增 `content-import` / `content-publish` Job 与对应角色（含 Search Index Data Contributor）；镜像加 pandoc + poppler-utils，构建上下文改仓库根（根 `.dockerignore` 白名单）。
- **G6**：物化输出 `pinned`/`featured`；`tools/moment-flags.mjs` 设置样本。

### D1 首次部署清单（需 Azure 登录，单独会话执行）

1. `az deployment sub/group create` 部署 `infra/main.bicep`（新 Job、角色、函数应用设置）。
2. push 到 main 触发 `deploy-sync-image.yml` 构建新镜像并更新四个 Job（VPN 不稳时 git push 重试 2–4 次）。
3. 部署 Function App 代码（`deploy-api.yml` 自动）。
4. 管理台实测：改一篇封面 → 发布 → 前台可见；上传 `冬滚滚.docx` → 任务 succeeded → 发布 → 前台出现新文章（D-44 四项计数由本机 `verify-imports` 复核）。
5. `node tools/moment-flags.mjs` 设一条置顶、一条精选 → 发布 → 前台验收徽标与描边；随后 V1/V2 实测。
