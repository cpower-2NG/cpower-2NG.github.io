# BIFROST 设计文档 · 后端设计

> 本文定义后端服务边界与契约。
> 数据模型与容器见 `10-data-design.md`；前端消费方式见 `30-frontend.md`。

## 目的

定义内容从"上传或书写"到"进入权威库、进入检索、进入静态产物"的服务链路，以及读者侧互动与查询的接口边界。

## 范围

- 覆盖：上传入口、异步导入任务、检索服务、互动接口、鉴权、降级策略。
- 不覆盖：内容模型与容器设计（见 `10-data-design.md`）、页面与交互（见 `30-frontend.md`）、部署与迁移步骤（见 `40-migration-ops.md`）。

## 关键决策

已确定的服务边界：

1. **上传入口**：接收用户文件（Word / txt / Markdown / HTML / PDF 及配图），原文件存入私有 Blob，并创建一个导入任务。
2. **异步导入任务**：转换在任务中完成，不在请求内同步执行，避免大文件（如 60MB PDF）超时。
   - 转换：docx / txt → Markdown 可编辑源。
   - 渲染：由 Markdown 生成正文 HTML。
   - 公式：Markdown 中的 `$…$`、`$$…$$`、`\[…\]` 与 `\begin{env}…\end{env}` 在导入时用 KaTeX 预渲染成 HTML；样式与字体随站点发布（`core/katex/`），阅读页不引入运行时脚本。
   - 媒体：抽取文中图片，作为原件写入 Blob 与 `assets`。
   - 写入：条目、正文、分类登记、路由，以及检索投影。
   - 收尾：触发静态物化。
3. **检索服务**：对外提供统一的查询接口，读 AI Search；支持关键词、组合筛选、分面计数、排序与分页。
   - 端点：`GET /api/search?q=&phase=&section=&type=&from=&tags=&limit=`，返回 `items` 与 `facets`；`from` 为 `YYYY-MM-DD`，按 `publishedAt` 过滤。
   - 索引字段见 `tools/lib/search-config.mjs`；内容发布后由 `tools/search-push.mjs` 推送。
   - 前端在检索服务不可用时自动退回索引内的本地过滤。
4. **互动接口改键**：评论、点赞、阅读从按 `path` 改为按 `entryId`，URL 变化不再影响互动数据归属。
5. **单用户鉴权**：管理操作使用现有 Entra 登录；不做多用户与权限体系。
6. **读降级**：Azure 不可用时，静态产物仍可完整阅读；检索与互动失去能力但不阻塞阅读。
7. **来源不外露**：`origin` 等溯源字段只出现在管理侧响应中，公共接口不返回。
8. **导入任务载体**：复用现有 Container Apps Job 执行转换，转换使用 pandoc（已用真实原件验证，见"转换工具验证结论"），不引入新的队列服务。
9. **docx 保真验收**：以图片无损、列表项一致、文本差异可控为准（第 0 步验证后修订，细则见"转换工具验证结论"）。
10. **检索索引部署**：AI Search 部署在 `japaneast`，从免费层起步；索引器在发布后显式触发，另加每日补偿刷新。
11. **编辑器**：本期只预留写入接口（按 `entryId` 与 `revision` 写入），不做编辑界面。

## 接口与契约

### 服务清单

| 服务 | 职责 | 数据来源 |
|---|---|---|
| 上传接口 | 接收文件、登记导入任务 | Blob + `state` |
| 导入任务 | 转换、抽取媒体、写入权威库与投影 | Blob + `content-articles` + `assets` + `taxonomy` + `routes` + `search-docs` |
| 检索服务 | 关键词、筛选、分面、排序、分页 | `search-docs` → AI Search |
| 互动服务 | 评论、回复、点赞、阅读 | `comments` + `signals` |
| 路径解析 | 旧地址重定向与 404 判定 | `routes` |
| 管理服务 | 内容 CRUD、分类与标签管理、导入任务状态 | 权威容器 + `state` |
| 导出任务 | 定期导出互动数据到私有 Blob | `comments` + `signals` |

### 现状（迁移期）

迁移期继续提供现有接口，直到新架构接管：

| 现有接口 | 说明 |
|---|---|
| `GET /api/interactions` | 按 `entryId` 返回互动摘要与评论 |
| `POST /api/comments` | 提交评论与回复 |
| `POST /api/reactions` | 点赞切换 |
| `POST /api/views` | 阅读计数（按天去重） |
| `GET /api/search` | 检索服务（关键词、组合筛选、分面） |
| `GET/PATCH/DELETE /api/manage/*` | 管理：状态、评论审核、同步规则、覆盖项、同步与导出 |
| 定时任务 `exportDaily` | 每天导出互动数据 |

### 新增接口（内容管理与上传链路，已定案）

管理操作全部挂在既有 `manage/{action}/{id?}` 路由下，鉴权沿用 Entra `requireAdmin`：

| 接口 | 说明 |
|---|---|
| `GET /manage/entries` | 条目列表（`phase` / `section` / `q` / `status` 过滤） |
| `GET /manage/entries/{id}` | 条目详情 + 封面候选（正文图与归属媒体） |
| `PATCH /manage/entries/{id}` | 更新封面 / 标签 / 系列归属（单一职责字段） |
| `GET/POST /manage/series`、`PATCH/DELETE /manage/series/{id}` | 系列 CRUD；`PATCH` 接受有序 `memberIds` 完成成员排序；删除仅限无成员引用 |
| `GET /manage/tags`、`POST /manage/tags/rename` | 标签清单（含使用计数）与重命名/合并（同一落地路径） |
| `GET/PATCH /manage/moments[/{id}]` | 动态列表与置顶（`pinned`）/精选（`featured`）开关 |
| `POST /manage/import` | multipart 上传（字段 `file` + `title` / `phase` / `section` / `tags` / `coverIndex`），建导入任务并启动 `content-import` Job |
| `GET /manage/import[/{id}]` | 导入任务列表（最近 20 条）与详情（状态、阶段、失败原因、条目 id） |
| `POST /manage/publish` | 触发 `content-publish` Job：物化 → 回写 GitHub → 推送检索 |

发布模式采用"统一发布按钮"：内容改动只写权威库并置 `publish-state.dirty`，管理页点击发布才执行物化与上线；导入完成同样只标脏。

### 上传与导入规则（定案）

- 允许扩展名：`docx` / `doc` / `pdf` / `txt` / `md` / `markdown` / `html` / `htm`；配图仅支持文档内嵌。
- 体积上限：100MB（`MAX_UPLOAD_BYTES` 可调）。上传校验见 `api/src/lib/import-validate.js`。
- 导入任务幂等最简实现：任务置 `running` 后不被重复拾取，崩溃残留超过 2 小时回收回队列；失败不自动重试，重新上传即生成新任务。重试与幂等的完整设计、请求与响应结构、缓存策略仍留待后续阶段讨论。
- 云端任务的转换与入库复用 `tools/` 的同一套脚本（见 `40-migration-ops.md`），D-44 四项计数验收仍由本机 `verify-imports` 承担，云端任务记录图片数与字数。

### 转换工具验证结论（第 0 步实验）

用真实原件 `冬滚滚.docx`（51 段、0 个样式标题、4 个列表项、7 张内嵌图、正文 4175 字）对比三条转换路径：

| 对比项 | pandoc 3.12 → Markdown | Word COM → HTML | mammoth → HTML |
|---|---|---|---|
| 列表项 | 4 个真实项 + 1 个误判 | 4 | 4 |
| 图片数量 | 7 | 7 | 7 |
| 图片保真 | 无损，合计 6.32MB，与原文一致 | 降采样重压缩：980×551 → 554×311，合计 6.32MB → 1.53MB | 无损 |
| 正文字符 | 4198 | 6507（含 HTML 残渣） | 4180 |
| 输出形态 | 可编辑 Markdown + 独立图片文件 | Word 专有 HTML + 被压缩图片 | HTML，图片内联 base64（单文件 8.4MB） |
| 云端可运行 | 是（Linux 容器） | 否（仅 Windows 且需装 Word） | 是 |

结论：

- **采用 pandoc**：图片字节级无损、文本完整、输出可编辑，且能在 Linux 容器中运行。
- **排除 Word COM 导出**：它会降采样并重压缩图片，总体积损失约 76%，对以内容为核心的站点不可接受。
- **mammoth 作为备选**：文本最干净（4180 字，最接近原文），但必须自定义图片处理器把 base64 换成独立文件。
- **验收细则修订**：图片数量一致且无损；列表项数量一致；正文字符数差异 ≤ 1%；文本块数差异 ≤ 5%；源文档使用样式标题时要求标题数一致，未使用样式标题时标记为"需人工或规则处理"。
- **已知边界问题**：正文中以 `1.` 开头的普通段落会被 pandoc 误判为有序列表，导入时需要规范化处理。

### 留待后续阶段讨论

> 留待后续阶段讨论：新接口清单与路径命名。
> 留待后续阶段讨论：请求与响应结构（字段、分页游标、分面返回格式）。
> 留待后续阶段讨论：错误码与错误响应约定。
> 留待后续阶段讨论：导入任务的重试、幂等与失败恢复策略。
> 留待后续阶段讨论：缓存策略（静态产物、检索结果、互动摘要）。
> 留待后续阶段讨论：上传体积上限、允许的扩展名与安全校验规则。

## 开放问题

- 本轮开放问题已全部关闭：导入任务载体、编辑器范围、索引器刷新方式均已确定（见上文 8–11）。
- 后续阶段新增的未决项记入此处。
