# BIFROST 设计文档 · 数据设计

> 本文定义内容模型、分类体系、数据库组织与检索投影。
> 术语以 `00-overview.md` 为准；后端行为见 `20-backend.md`，前端呈现见 `30-frontend.md`。

## 目的

把"内容如何组织"和"数据如何存储"定成一套正规、可扩展、面向查询性能的方案，使文章与动态在长期增长后依然易于查找、迁移与呈现。

## 范围

- 覆盖：内容模型、分类体系、Cosmos 容器组织、索引与生命周期、检索投影、身份与路由。
- 不覆盖：接口实现细节（见 `20-backend.md`）、页面与交互（见 `30-frontend.md`）、迁移执行步骤（见 `40-migration-ops.md`）。

## 关键决策

### 设计原则

1. **数据库是内容唯一权威**：正文、元数据、分类、媒体元数据、互动全部以数据库为准；Git 只保留工具与前端源码，以及用于灾难恢复的发布快照。
2. **存储与检索分离**：Cosmos 负责权威读写，AI Search 负责列表、筛选、搜索与分面。
3. **写入模型与读模型分离**：列表要用的短字段由检索投影承担，不直接查询权威容器。
4. **身份与地址解耦**：`entryId` 永不变；`slug`/`path` 可变，由 `routes` 解析与重定向。
5. **生命周期分层**：原件永久、派生媒体可重建、限流数据自动过期、动态只分桶不删除。
6. **来源不外露**：内容来源只作为开发者技术溯源字段存在，前端不展示。

### 内容模型

#### 条目（Entry）

所有内容在概念上都是条目，共享同一套身份与核心字段。

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 即 `entryId`，不可变 ULID。 |
| `entryType` | `article` \| `moment` | 条目大类，决定存放容器与阅读形态。 |
| `kind` | `standard` \| `pdf` \| `video` \| `project` \| `page` | 展示形态。算法文档使用 `standard`，靠分区区分。 |
| `phase` | `logic` \| `fantasy` | 所属阶段。 |
| `section` | string | 所属分区 id，引用 `taxonomy` 中的 section 文档。 |
| `tags` | string[] | 自由输入标签；写入时自动登记到 `taxonomy`。 |
| `seriesId` | string \| null | 所属系列 id。 |
| `slug` | string | 可读地址片段，可修改。 |
| `path` | string | 当前访问路径；变更时写入 `routes` 作为旧地址重定向。 |
| `title` | string | 标题。动态可为空。 |
| `subtitle` | string | 副标题，可空。 |
| `summary` | string | 摘要，用于列表与社交卡片。 |
| `publishedAt` | string (ISO 8601) | 发布时间，列表排序依据。 |
| `createdAt` / `updatedAt` | string (ISO 8601) | 记录时间。 |
| `status` | `draft` \| `review` \| `published` \| `archived` \| `deleted` | 发布状态；只有 `published` 进入检索与静态物化。 |
| `visibility` | `public` \| `private` | 可见性。 |
| `author` | string | 展示用作者名，单用户模型下仅作署名。 |
| `counts` | `{ likes, views, comments }` | 去规范化的计数，事实源在 `signals`。 |
| `cover` | `{ assetId }` \| null | 列表与社交卡片封面。 |
| `coverSource` | `manual` \| `auto-first` \| `text` | 封面来源：手动指定、默认取首图、文字封面。 |
| `media` | MediaRef[] | 正文媒体引用，见下节。 |
| `contentHash` | string | 当前正文哈希，用于去重与变更检测。 |
| `currentRevision` | number | 当前正文版本号。 |
| `origin` | object | 开发者技术溯源，不面向读者。见下节。 |
| `schemaVersion` | number | 文档结构版本。 |

#### 正文（Body）

正文与元数据分开存储，保证"翻目录"这类高频操作永远不读正文。

| 字段 | 说明 |
|---|---|
| `id` | 固定为 `body`，与所属条目同分区。 |
| `entryId` | 所属条目。 |
| `format` | 固定为 `markdown`。 |
| `markdown` | 可编辑的源文，Markdown 格式。 |
| `html` | 渲染后的 HTML，前端直接使用。 |
| `text` | 纯文本，供检索投影与摘要使用。 |
| `wordCount` / `readingMinutes` | 字数与预计阅读时长。 |
| `revision` | 当前版本号，与条目的 `currentRevision` 一致。 |
| `contentHash` | 正文哈希。 |
| `updatedAt` | 更新时间。 |

历史版本存为同分区的 `revision:<n>` 文档，包含同样的 `markdown` / `html` / `text` / `contentHash` / `createdAt`。写入新版本时，先把当前 `body` 复制成 `revision:<n>`，再覆盖 `body`。

#### 媒体（Asset）

媒体独立建库，条目只引用 `assetId` 与少量展示字段。

媒体分两类：

- `original`：用户上传的原件或原图，永久保存，不可再生。
- `derived`：缩略图、多尺寸变体、视频封面等派生品，可随时重建。

| 字段 | 说明 |
|---|---|
| `id` | `assetId`。 |
| `assetClass` | `original` \| `derived`。字段名避开 Cosmos 的保留字 `class`。 |
| `kind` | `image` \| `video` \| `pdf` \| `document`。 |
| `blobPath` / `blobUrl` | Blob 中的位置与访问地址。 |
| `mime` / `bytes` / `sha256` | 类型、体积与哈希，哈希用于查重。 |
| `width` / `height` / `duration` | 图/视频尺寸与时长的展示信息。 |
| `variants` | 派生尺寸列表（宽、格式、地址）。 |
| `derivedFrom` | 派生来源：原始 assetId，或视频引用。 |
| `ownerEntryIds` | 引用此媒体的条目列表。 |
| `alt` / `caption` | 无障碍文本与图注。 |
| `status` | `active` \| `missing` \| `archived`。 |

视频只存引用，不存文件：

```jsonc
{
  "kind": "video",
  "role": "inline",
  "platform": "bilibili",
  "videoId": "BV1xx...",
  "watchUrl": "https://www.bilibili.com/video/BV1xx...",
  "coverAssetId": "ast_...",
  "title": "视频标题",
  "duration": 0
}
```

##### MediaRef（条目内的媒体引用）

| 字段 | 说明 |
|---|---|
| `assetId` | 指向 `assets` 记录；视频条目可为空。 |
| `role` | `cover` \| `inline` \| `attachment`。 |
| `kind` | `image` \| `video` \| `pdf`。 |
| `order` | 展示顺序。 |
| `caption` | 图注。 |
| `video` | 视频引用对象（仅 `kind: "video"`）。 |

#### 封面兜底

条目封面按三级兜底，保证列表不会出现空缺：

1. 条目显式指定 `cover`。
2. 取正文首图作为封面（导入时识别并写入 `cover`）。
3. 无任何图片时使用"文字封面"，由前端按标题排版生成。

文字封面不占用媒体库，也不参与检索，仅由前端按标题与阶段样式生成。

#### 动态（Moment）

动态是纯时间流内容，只有三种来源形态：QQ 空间同步、网页手写、转发的视频链接。不存在"手记 / 短篇"等额外分支。

动态自包含：正文直接存在动态文档内，不再拆出独立 body 文档（内容极短）。历史版本同样以 `revision:<n>` 文档保存在同一分区。

动态支持 `pinned`（置顶）与 `featured`（精选）两个布尔字段，供时间流与列表排序使用。

#### 展示页（Logic 首页）

Logic 的首页是工作展示页，作为 `kind: "page"` 的条目存放于 `content-articles`，是 Logic 侧栏的第一个入口。

展示页字段：

| 字段 | 说明 |
|---|---|
| `intro` | 个人简介，一句话或一段。 |
| `cardImage` | 名片图（assetId），可空。 |
| `techStack` | 技术栈分组：`[{ group, items[] }]`。 |
| `workLog` | 工作记录时间线：`[{ at, title, description, link }]`，先手工维护。 |
| `projects` | 项目条目 id 列表，按展示顺序。 |

项目是 `kind: "project"` 的条目，可被搜索、列表与展示页引用，字段为标准集：

| 字段 | 说明 |
|---|---|
| 名称 / 简介 | 复用条目的 `title` 与 `summary`。 |
| 封面 | 复用 `cover`。 |
| 技术标签 | 复用 `tags`。 |
| 链接 | 仓库地址与演示地址。 |
| 状态 | `进行中` \| `已完成` \| `搁置`。 |
| 起止时间 | `startedAt` / `endedAt`，允许只填开始。 |

工作记录本期先手工维护；GitHub 接入方式留待后续阶段讨论。

#### 开发者技术溯源（origin）

用于定位内容来源与排查问题，不面向读者展示。

| 字段 | 说明 |
|---|---|
| `provider` | `upload` \| `web` \| `qq` \| `bilibili`。 |
| `ref` | 外部标识，如 QQ 动态 id、Bilibili 稿件 id、上传批次 id。 |
| `importedAt` | 进入数据库的时间。 |
| `sourceHash` | 原件哈希，便于追回原始文件。 |

### 分类体系

分类分四层，职责互不重叠。

| 层 | 作用 | 数量 | 是否稳定 |
|---|---|---|---|
| phase 阶段 | 身份与视觉，内容的一级归属 | 2 | 稳定 |
| section 分区 | 侧栏骨架与主要浏览入口 | 每阶段 4–5 个 | 长期稳定 |
| tag 标签 | 主题与作品名细分 | 无限增长 | 灵活 |
| series 系列 | 有顺序的合集 | 少 | 按需新增 |

分区定名：

| 阶段 | 分区 |
|---|---|
| Fantasy | 日常（时间流）、漫评、活动纪录、杂记、档案馆 |
| Logic | 展示（首页）、技术文档、心得、算法 |

标签规则：

- 自由输入，类似社交媒体的 hashtag；提交后自动登记进分类表。
- 支持在管理页重命名与合并，避免"冬滚滚 / 冬滾滾"这类重复。
- 标签只出现在搜索面板中，作为筛选与分面维度，不占用侧栏，也不生成独立页面（见 D-49）。

系列规则：

- 系列是独立实体，持有标题、简介、封面与有序成员列表。
- 系列带自己的 `slug` 与 `path`，在列表中表现为一张卡片；点开显示成员并默认第一篇。
- `routes` 同时支持指向系列，旧地址可重定向到系列或成员。

### 存储组织

#### 容器清单

数据库：`bifrost`（沿用现有 Cosmos 账户与库名）。

| 容器 | 分区键 | 主要文档 | 默认 TTL | 职责 |
|---|---|---|---|---|
| `content-articles` | `/entryId` | `entry`、`body`、`revision:<n>` | 永久 | 文章、项目、页面的元数据与正文 |
| `content-moments` | `/month` | `moment`、`revision:<n>` | 永久 | 动态，按月分桶 |
| `taxonomy` | `/kind` | `phase`、`section`、`tag`、`series`、`kind` | 永久 | 分类体系 |
| `assets` | `/assetId` | `asset` | 永久 | 媒体元数据（二进制在 Blob） |
| `routes` | `/path` | `route` | 永久 | 路径与旧地址重定向 |
| `comments` | `/entryId` | `comment` | 永久 | 评论与回复 |
| `signals` | `/entryId` | `metric`、`reaction`、`view` | 永久（view 180 天） | 计数、点赞与阅读去重 |
| `state` | `/scope` | 状态与配置文档 | 永久 | 同步状态、规则、导入任务 |
| `rate-limits` | `/key` | 限流计数 | 86400 秒 | 评论限流 |
| `search-docs` | `/entryId` | `search-doc` | 永久 | 检索投影（AI Search 唯一数据源） |

#### 组织规则

1. **一个容器一个职责**，不把不同访问模式的数据混在一起。
2. **分区键跟随主访问路径**：文章按 `entryId`、动态按 `month`、互动按 `entryId`。
3. **一起读写的数据放同一分区**：文章元数据、正文、历史版本同属一个 `entryId`，可在单分区内完成读取与事务写入。
4. **列表、筛选、搜索、分面一律走检索层**，不让 Cosmos 承担它不擅长的查询。
5. **索引只覆盖查询字段**；正文（`markdown` / `html` / `text`）与媒体长字段排除索引。
6. **ID 与网址解耦**：`entryId` 永不变，`slug`/`path` 变更时写 `routes`。
7. **生命周期分层**：原件永久、派生媒体可重建、阅读去重 180 天过期、限流 1 天过期、动态只分桶不删除。

#### 索引策略

| 容器 | 包含 | 排除 |
|---|---|---|
| `content-articles` | `/entryId`、`/phase`、`/section`、`/status`、`/publishedAt`、`/tags/*`、`/seriesId`、`/kind` | `/markdown/?`、`/html/?`、`/text/?` |
| `content-moments` | `/month`、`/publishedAt`、`/tags/*`、`/phase`、`/section`、`/status` | `/html/?`、`/text/?` |
| `taxonomy` | `/kind`、`/parentId`、`/order`、`/status` | 其余 |
| `assets` | `/ownerEntryIds/*`、`/sha256`、`/class`、`/kind`、`/status` | `/variants/*` 中非查询字段 |
| `routes` | `/entryId` | 其余 |
| `comments` | `/type`、`/status`、`/entryId`、`/createdAt` | `/content/?` |
| `signals` | `/type` | 其余 |
| `state` | `/scope` | 其余 |
| `rate-limits` | 最小索引 | 其余 |
| `search-docs` | 最小索引（由 AI Search 承担检索） | 其余 |

`comments` 需为"按状态与时间列出评论"建立复合索引：`(status ASC, createdAt DESC)`。

### 检索投影

检索层由 Cosmos + Azure AI Search 组成：Cosmos 中的 `search-docs` 是投影表，是检索的权威来源。

投影到索引采用**推送**而非索引器：与发布流程一致，且不必把 Cosmos 密钥交给搜索服务
（索引器方案可在需要自动同步时替换，索引字段不变）。

检索文档字段：

| 字段 | AI Search 用途 |
|---|---|
| `entryId` | 主键 |
| `entryType` | 可筛选 / 可分面（article / moment） |
| `title` | 可搜索、可排序 |
| `summary` | 可搜索 |
| `bodyText` | 可搜索（正文纯文本） |
| `phase` | 可筛选 / 可分面 |
| `section` | 可筛选 / 可分面 |
| `tags` | 可搜索 / 可筛选 / 可分面（集合） |
| `seriesId` | 可筛选 |
| `kind` | 可筛选 / 可分面 |
| `publishedAt` | 可筛选 / 可排序 |
| `updatedAt` | 可排序 |
| `counts` | 可排序（热度） |
| `path` / `slug` | 仅返回，用于生成链接 |
| `wordCount` | 可排序 |
| `hasMedia` / `hasVideo` | 可筛选 |
| `pinned` | 可排序（置顶优先） |
| `featured` | 可筛选 / 可排序 |
| `coverUrl` | 仅返回，不参与检索 |
| `status` | 可筛选（只索引 `published`） |

投影由写入流程生成，属于派生数据，可随时全量重建。其内容不得成为权威，任何字段修改必须回到权威容器。

### 身份与路由

- `entryId` 采用 ULID，单调、可排序、不可变。
- 网址结构以可读 slug 为准，形如 `/content/<slug>`；**网址不含阶段与分区**，因此重新分类不会改变链接。
- `slug` 全局唯一，承担"人可读地址"的职责；`entryId` 承担"永不变的身份"。
- 路径变更时写入 `routes`：`{ path, entryId, canonical, redirect }`。
- 路径解析失败时由 `routes` 判定是"旧地址重定向"还是"确实不存在"。

### 生命周期

| 数据 | 策略 |
|---|---|
| 上传原件（Word / PDF / txt） | 永久保存于私有 Blob |
| 派生媒体（封面、缩略图、变体） | 可重建，允许过期重算 |
| 正文历史版本 | 永久保留 |
| 阅读去重记录 | 180 天后过期 |
| 限流计数 | 1 天后过期 |
| 动态 | 永久保留，按月分桶，不删除 |
| 检索投影 | 可全量重建 |

## 接口与契约

### 主查询映射

每条主查询都必须能定位到明确的容器与字段。

| 查询 | 数据来源 | 依据 |
|---|---|---|
| 打开一篇文章 | `content-articles` 点读 | 分区 `/entryId`，取 `entry` 与 `body` |
| 打开一条动态 | `content-moments` | 分区 `/month` + 文档 id |
| 分区列表（文章） | AI Search | `search-docs` 过滤 `phase` + `section` |
| 动态时间流 | `content-moments` 范围查询 | 分区 `/month` 按月范围 |
| 关键词搜索 | AI Search | `title` / `summary` / `bodyText` / `tags` |
| 组合筛选 + 分面 | AI Search facets | `entryType` / `phase` / `section` / `tags` / `kind` |
| 按标签筛选 | AI Search | 过滤 `tags`（由搜索面板消费） |
| 系列页 | `taxonomy` + AI Search | 系列成员列表 + 过滤 `seriesId` |
| 按时间筛选 | AI Search | 过滤 `publishedAt` 范围（由搜索面板消费） |
| 侧栏导航 | 静态物化产物 | 由分类法与条目计数生成 |
| 评论列表 | `comments` | 分区 `/entryId`，按状态与时间 |
| 点赞与阅读 | `signals` | 分区 `/entryId` |
| 路径解析 | `routes` | 分区 `/path` |
| 媒体读取 | `assets` | 分区 `/assetId` |

### 配置数据文件

站点级配置仍是数据源的一部分：

| 文件 | 内容 |
|---|---|
| `data/site.json` | 站点地址与互动服务配置（`siteUrl`、`interactions`）。 |
| `data/publications/<id>.json` | 出版物页面清单（页序、图片、PDF 地址）。 |
| `data/sync-rules.default.json` | 同步规则默认值。 |

切换完成时已退役的旧索引文件（保留记录，便于回溯）：

| 文件 | 取代者 | 状态 |
|---|---|---|
| `data/entries.json` | `data/site-index.json`（由 `content-articles` + `content-moments` 物化） | 已删除 |
| `data/content-manifest.json` | `routes` 与检索层 | 已删除 |
| `data/content-overrides.json` | `taxonomy` 与条目自身字段 | 已删除 |
| `assets/media/*`、`assets/publications/*` | Blob + `assets` 容器 | 已删除 |
| `build.mjs` / `build.cmd` | `tools/` 下的导入与物化工具 | 已删除 |

### 与现有实现的对应关系

| 现状 | 新架构 |
|---|---|
| `content-src/*.md` + `content/*.html` | `content-articles` 的 `body` 与条目元数据 |
| `data/entries.json` | 检索投影 + 分类法 |
| `assets/media/*`、`assets/publications/*` | Blob + `assets` 容器 |
| Cosmos `comments`（按 `path`） | `comments`（按 `entryId`） |
| Cosmos `activity` | `signals` |
| Cosmos `state`、`rate-limits` | 沿用，状态文档增加 `schemaVersion` |

## 开放问题

- Logic 展示页的 GitHub 工作记录接入方式与刷新频率，决定 `workLog` 是手工字段还是外部同步。
