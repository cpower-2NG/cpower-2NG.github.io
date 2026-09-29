# BIFROST 个人网页

BIFROST 是一个面向 GitHub Pages 的个人内容站点，以**文章与动态**为中心，在 Logic 与 Fantasy 两个位面之间承载阅读、记录与展示。

站点目前是"静态内容 + Azure 服务"的混合形态：阅读走静态产物，查找与互动走云端服务。内容数据库架构正在重新设计，目标是把内容集中到数据库，使查找与迁移都更容易。

## 快速开始

本地预览：

```powershell
./preview.cmd            # 默认 http://localhost:8000/
./preview.cmd 8080       # 指定端口
```

本地验证：

```powershell
node --test tests/*.test.mjs
node tests/e2e/site-navigation.mjs

npm ci --prefix api
npm test --prefix api

npm ci --prefix sync
npm test --prefix sync
```

内容管线（从数据库物化静态站点；需要 Azure 登录）见 [40-migration-ops.md](docs/design/40-migration-ops.md)：

```powershell
node tools/batch-import.mjs      # 原件 → 内容包 → 文档
node tools/blob-push.mjs         # 媒体上云
node tools/cosmos-push.mjs       # 写入权威容器
node tools/materialize-site.mjs  # 数据库 → 静态站点
node tools/search-setup.mjs      # 创建检索索引
node tools/search-push.mjs       # 推送检索投影
```

端口占用规则、脚本编码约束与线上检查命令见 [40-migration-ops.md](docs/design/40-migration-ops.md)。

## 文档索引

设计文档按职责拆分，推荐从上往下阅读：

| 文档 | 内容 |
|---|---|
| [docs/design/00-overview.md](docs/design/00-overview.md) | 总览、术语表、模块地图与决策记录 |
| [docs/design/10-data-design.md](docs/design/10-data-design.md) | 内容模型、分类体系、数据库组织与检索投影 |
| [docs/design/20-backend.md](docs/design/20-backend.md) | 后端服务边界与契约 |
| [docs/design/30-frontend.md](docs/design/30-frontend.md) | 前端呈现契约与交互结构 |
| [docs/design/40-migration-ops.md](docs/design/40-migration-ops.md) | 迁移策略、云资源、本地开发与验证 |
| [docs/AZURE_SETUP.md](docs/AZURE_SETUP.md) | Azure 资源创建、Entra 登录与 QQ 同步部署 |
| [imports/fantasy/README.md](imports/fantasy/README.md) | Fantasy 原始文档的保全与处理判断 |

## 目录结构

```text
.
├── index.html          站点壳层（唯一入口）
├── core/               前端引擎、样式与交互脚本
├── content/            构建产出的内容文档
├── content-src/        内容源（Markdown 与导入数据）
├── data/               站点配置与内容索引
├── assets/             图片、出版物等静态资源
├── docs/               文档（设计集合与部署说明）
├── api/                Azure Functions 互动与管理接口
├── sync/               QQ 云端同步器
├── infra/              Bicep 基础设施模板
├── tools/              导入、校验与检查脚本
├── tests/              单元与浏览器测试
└── imports/            原始文档保全目录
```

## 项目状态

静态内容基建、Azure 互动接口、管理页、基础设施模板、QQ 云端同步与自动部署 workflow 均已落地。

内容数据库架构处于重新设计阶段：设计文档已建立，实现尚未开始。
