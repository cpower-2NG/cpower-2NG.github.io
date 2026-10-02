# BIFROST 设计文档 · 迁移与运维

> 本文定义从现状迁移到新架构的策略、涉及的云资源与日常操作。
> 数据模型见 `10-data-design.md`；服务边界见 `20-backend.md`；Azure 部署步骤见 `AZURE_SETUP.md`。

## 目的

在不中断现有站点阅读的前提下，把内容迁入新数据库架构，并明确运行所需的云资源、成本边界与回滚路径。

## 范围

- 覆盖：迁移策略与对象、互动数据改键、Azure 资源清单、成本与免费层边界、回滚、本地开发与验证操作。
- 不覆盖：内容模型（见 `10-data-design.md`）、接口设计（见 `20-backend.md`）、页面设计（见 `30-frontend.md`）。

## 关键决策

1. **双轨过渡**：先把现有内容迁入新库，旧静态站继续运行；验证无误后再把前端切到新架构。
2. **迁移不改可读性**：迁移过程中线上阅读始终可用，任何一步失败都不影响旧站。
3. **互动改键**：评论、点赞、阅读数据由 `path` 迁移到 `entryId`；用 `routes` 建立旧路径映射，避免历史互动丢失。
4. **原件保全**：现有 20 个本地原件（约 75MB）上传到私有 Blob 长期保存，不进入公开产物。
5. **发布后可回滚**：静态产物由数据库物化生成，数据库出现问题时回退到仓库中的发布快照。
6. **导入任务载体**：转换与入库复用现有 Container Apps Job，不新建队列服务。
7. **docx 保真验收**：以图片无损、列表项一致、文本差异可控为准，细则见 `20-backend.md` 的"转换工具验证结论"。
8. **AI Search 部署**：与现有资源同区域（`japaneast`），从免费层起步。
9. **CI 调整**：新增导入与检索相关 workflow；旧 Pages 构建流程保留到前端切换完成。

## 接口与契约

### 迁移对象

| 对象 | 数量 | 去向 |
|---|---|---|
| 现有文章 | 18 篇（含 3 篇 Bilibili 活动记录、3 条 QQ 动态、1 份 PDF 出版物） | `content-articles` / `content-moments` |
| 本地原件 | 20 个文件，约 75MB（Word、PDF、txt、PNG） | 私有 Blob + `assets` 元数据 |
| 站点媒体 | `assets/media/*`、`assets/publications/*` | Blob + `assets` 元数据 |
| 旧索引文件 | `data/entries.json`、`data/content-manifest.json`、`data/content-overrides.json` | 迁移期并存，切换后退役 |
| 互动数据 | 现有 `comments` 与 `activity` | `comments` / `signals`，键由 `path` 换成 `entryId` |

### 迁移顺序

1. 建库建容器（见 `10-data-design.md` 容器清单）。
2. 导入分类法初始数据（阶段、分区、标签、系列）。
3. 上传原件到私有 Blob，建立 `assets` 记录。
4. 转换并导入 18 篇内容，生成 `content-articles` / `content-moments` 与 `routes`。
5. 生成检索投影并建立 AI Search 索引。
6. 迁移互动数据：`path` → `entryId`。
7. 由数据库物化静态产物，与旧站产物比对。
8. 验证通过后切换前端；旧流程保留一个版本周期以便回退。

### 迁移工具（本地）

```powershell
# 1. 按清单批量转换与打包（产出 dry-run 文档，不碰云）
node tools/batch-import.mjs

# 2. 增量建容器（控制面，幂等；数据面用 AAD，见下）
node tools/cosmos-setup.mjs

# 3. 媒体上云（必须在入库之前：它会把 blobUrl 回填到 assets.json）
node tools/blob-push.mjs

# 4. 写入权威容器（AAD 数据面）
node tools/cosmos-push.mjs

# 5. 按「主查询映射」逐条验证
node tools/cosmos-verify.mjs

# 6. 物化静态站点（数据库 → 阅读页 / 索引 / feed / sitemap）
node tools/materialize-site.mjs

# 7. 检索层（创建索引 + 推送投影）
node tools/search-setup.mjs
node tools/search-push.mjs

# 8. 动态（QQ 时间流）单独一条线
node tools/import-moments.mjs
node tools/cosmos-push.mjs imports/fantasy/derived/moments
```

两条已知边界，实现时不要再踩：

- **建容器属于控制面操作**，Cosmos 的 SQL 角色（Data Contributor）只管数据面；容器需要用 `az` 或 Bicep 创建。
- **Cosmos 文档 id 不允许含 `/`**，因此路径不能直接当 id；路径放在 `path` 字段（同时是分区键），id 用固定值。

### Azure 资源

| 资源 | 现状 | 新架构中的角色 |
|---|---|---|
| Cosmos DB（`bifrost`） | `comments`、`activity`、`state`、`rate-limits` | 权威内容库，新增 `content-articles`、`content-moments`、`taxonomy`、`assets`、`routes`、`signals`、`search-docs` |
| Blob 存储 | `media`（公开）、`private`（私有） | 原件与媒体二进制；私有容器承载原件与导出 |
| Key Vault | 哈希盐与密钥 | 沿用 |
| Azure Functions | 互动与管理接口 | 新增上传、导入任务、检索服务 |
| Container Apps Job | QQ 登录与同步 | 沿用，并作为导入任务的执行载体 |
| Azure AI Search | 已部署 `search-bifrost-z43zcc` | `japaneast`、免费层；索引 `bifrost-content`，由投影推送填充 |
| Application Insights / Log Analytics | 已存在 | 沿用，需补充导入与检索的可观测性 |

### 成本与免费层边界

- Cosmos DB 现有账户启用免费层，共享吞吐 1000 RU/s；新增容器不额外增加固定费用，但会增加 RU 消耗。
- Azure AI Search 已按免费层部署（50 MB / 3 索引额度内）；数据量增长后再评估升级。
- 原件约 75MB，Blob 存储成本可忽略。

### 回滚

- 内容层面：数据库为权威，但仓库保留发布快照；数据库异常时用快照重建静态产物。
- 切换层面：前端切换前，旧站点与旧构建流程保持可用，随时可切回。
- 互动层面：改键迁移前先做一次全量导出，保留按 `path` 记录的原始数据。

## 内容来源（切换后）

- **文章**：原件（Word / txt / PDF）经 `tools/import-content.mjs` 转成内容包，清单见 `imports/fantasy/batch-manifest.json`。
- **动态**：`sync/` 独立容器把 QQ 空间动态输出为 JSON，再由 `tools/import-moments.mjs` 转成动态文档。
- **媒体**：二进制上传到 Blob，数据库只保存元数据与地址。
- **写入与物化**：`tools/blob-push.mjs` → `tools/cosmos-push.mjs` → `tools/materialize-site.mjs`。

原始文档的保全与处理判断记录在 `imports/fantasy/README.md`；原始大文件保存在 `imports/fantasy/raw/`（Git 忽略）。

> 原先基于 `build.mjs` 的 Git 写作工作流已随切换退役。

## 云端任务（管理台链路）

除 QQ 同步（`qzone-sync` / `qzone-auth`）外，另有三个手工触发的 Container Apps Job，共用同一镜像（`sync/Dockerfile`，内含 pandoc 与 poppler-utils，`tools/` 随镜像发布）：

| Job | 入口 | 职责 |
|---|---|---|
| `content-import` | `tools/cloud-import.mjs` | 取 `state` 里最旧的 `queued` 导入任务：下载原件 → `import-content` 转换 → `build-documents` → `blob-push` → `cosmos-push` 入库，任务文档记录结果与失败原因 |
| `content-publish` | `tools/cloud-publish.mjs` | 全量重建 `search-docs` 投影 → `materialize-site` 物化 → 产物以单个 commit 回写 GitHub（push 到 main 自动触发 Pages）→ `search-push` 推送 AI Search → 写 `last-publish` 并清除脏标记 |
| 定时 `qzone-sync` | `sync/src/index.js` | QQ 空间动态同步（既有） |

操作闭环（发布模式 = 统一发布按钮）：管理台上传或改动封面/系列/标签 → 只写权威库并置 `publish-state.dirty` → 管理台点"发布" → `content-publish` 上线。

镜像由 `deploy-sync-image.yml` 构建（构建上下文为仓库根），push 到 main 的 `sync/**` 或 `tools/**` 变更都会触发，并更新全部 Job 的镜像。首次启用需先 `az deployment` 部署 `infra/main.bicep`（新 Job、角色与函数应用设置 `IMPORT_JOB_NAME` / `PUBLISH_JOB_NAME`），再推送镜像。

本地设置动态置顶/精选样本（需 Azure 登录）：

```powershell
node tools/moment-flags.mjs --id <momentId> --month <YYYY-MM> --pinned on
```

## 本地开发与验证

### 本地预览

Windows 下双击根目录的 `preview.cmd`，会先启动预览服务，确认就绪后再打开浏览器：

```text
http://localhost:8000/
```

也可以指定端口：

```powershell
./preview.cmd 8080
```

无浏览器窗口的启动方式（自动化或排查问题）：

```powershell
node preview-server.mjs 8000 --no-open
```

```powershell
./preview-server.ps1 -Port 8000 -NoBrowser
```

端口与重复启动规则：

- 若该端口已有 BIFROST 预览服务，脚本只打开浏览器，不重复启动。
- 通过 `/.bifrost-ping` 探测点确认端口上是 BIFROST；被别的程序占用时自动向后寻找空闲端口（最多 10 个）。
- 两个服务实现（Node 与 PowerShell 回退）都监听 `127.0.0.1` 与 `::1`，都把未知路径交给 `404.html`。

脚本编码约束：`preview.cmd`、`preview-server.ps1`、`preview-port.ps1` 必须保持 ASCII 内容。Windows PowerShell 5.1 会按系统 ANSI 代码页读取无 BOM 的 `.ps1`，cmd 按 OEM 代码页读取批处理，出现中文会导致脚本解析失败。

### 本地验证

```powershell
node --test tests/*.test.mjs
node tests/e2e/site-navigation.mjs

npm ci --prefix api
npm test --prefix api

npm ci --prefix sync
npm test --prefix sync
```

线上只读检查：

```powershell
node tools/live-readonly-check.mjs
```

真实写入检查会使用不会出现在公开文章中的专用测试路径，验证评论、回复、点赞与阅读去重，随后清理测试文档；必须显式确认：

```powershell
node tools/interaction-live-check.mjs --confirm=WRITE
```

### 留待后续阶段讨论

> 留待后续阶段讨论：迁移的具体脚本与命令。
> 留待后续阶段讨论：迁移时间表与阶段验收点。
> 留待后续阶段讨论：监控与告警项（导入任务失败、检索索引延迟、互动错误率）。
> 留待后续阶段讨论：备份与保留策略（发布快照保留周期、导出保留周期）。

## 开放问题

- Azure AI Search 免费层的实际限额需要在正式购买前核实。
- 备份与保留策略的具体周期（发布快照、互动导出）。
- 新架构切换后，旧 Pages 构建流程的退役时点。
