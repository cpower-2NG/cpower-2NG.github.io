# Azure 与 QQ 云端同步部署

生产站保留 GitHub Pages 静态前端，Azure 只负责互动数据、管理接口、媒体和 QQ 采集。所有示例值都必须替换为你自己的资源信息。

## 当前已配置环境

| 项目 | 当前值 |
|---|---|
| Subscription | `ad9f2682-9ca0-47fe-8290-9848ab17cb9e` |
| Tenant | `0d4d7772-1969-44d1-be14-edfbbb2b69aa` |
| Resource group | `rg-bifrost-prod` |
| Resource region | `japaneast` |
| Admin SPA client ID | `ea698470-98c7-4eb0-a697-2191a7f23270` |
| GitHub OIDC client ID | `b64fb7d3-9826-49e2-9f77-773945ba35d4` |
| GitHub App ID | `5095307` |
| GitHub App installation ID | `165407698` |
| Function App | `func-bifrost-z43zcc` |
| Container Apps Jobs | `qzone-auth`, `qzone-sync` |

这些非敏感标识同时记录在 `infra/generated-entra.json`。Student 订阅的策略不允许 `eastasia`，允许的部署区域为 `malaysiawest`、`indonesiacentral`、`japaneast`、`indiasouthcentral` 和 `koreacentral`；本项目选用 `japaneast`。

## 1. 前置条件

- Azure for Students 或全球版 Azure 订阅。
- Azure CLI，执行 `az login` 后选择目标订阅。
- GitHub 仓库管理员权限。
- 一个可用的手机 QQ，用于首次扫码登录 QQ 空间。

先创建资源组：

```powershell
az group create --name rg-bifrost-prod --location japaneast
```

## 2. Microsoft Entra 管理应用

当前管理应用已经创建并完成 SPA、audience 和 `access_as_user` scope 配置。以下步骤用于迁移或重建环境。

在 Azure Portal 的 Microsoft Entra ID 中创建 **App registration**：

1. 账户类型选择“仅此组织目录中的账户”。
2. 在“身份验证”中添加单页应用平台，并加入：
   - `https://cpower-2ng.github.io/admin.html`
   - `http://localhost:8000/admin.html`
3. 在“公开 API”中设置 Application ID URI，例如 `api://<client-id>`。
4. 添加 scope，例如 `access_as_user`，允许管理员和本人同意。
5. 记录 Tenant ID、Application client ID、完整 scope。
6. 执行 `az ad signed-in-user show --query id -o tsv` 获取管理员对象 ID。

Functions 会同时校验签名、租户、受众和对象 ID，不能只靠前端隐藏管理入口。

### 2.1 账密登录（备用通道）

Microsoft 登录依赖 `login.microsoftonline.com` 与前端 MSAL 库；如果管理员所在网络访问受限，可以在登录界面改用**站点口令**。该通道是独立的单账号登录：`POST /manage/auth/login` 校验 `scrypt` 口令哈希后签发 HMAC 会话令牌（默认 72 小时），管理接口用同一个 `Authorization: Bearer` 头接受两种令牌。

启用步骤（三项配齐才生效）：

1. 本地运行 `node tools/generate-admin-hash.mjs <管理员账号> <口令>`，输出 `ADMIN_USERNAME`、`ADMIN_PASSWORD_HASH`（自带随机盐，不依赖 `HASH_SALT`）、`ADMIN_SESSION_SECRET`。
2. 写入云端 Function App：

   ```powershell
   az functionapp config appsettings set --name <function-app> --resource-group <rg> --settings ...
   ```

   或把三个值配成 GitHub Secrets（`ADMIN_USERNAME` / `ADMIN_PASSWORD_HASH` / `ADMIN_SESSION_SECRET`）后重跑 **Deploy Azure infrastructure**，由 Bicep 经 Key Vault 下发。

安全边界：口令只以 scrypt 哈希存储（盐随哈希保存）；会话令牌无状态、过期即失效，换 `ADMIN_SESSION_SECRET` 可一次性吊销所有账密会话；登录接口按来源 IP 限流（10 分钟内失败 10 次锁定）。注意 Bicep 部署会把不在模板里的应用设置抹掉，走 `az` 直接配置后，建议同步配好 GitHub Secrets。Entra 通道与账密通道互不影响，任一未配置只会在登录界面提示对应按钮不可用。

## 3. GitHub App

当前 GitHub App 已创建并安装，权限仅限于 `cpower-2NG/cpower-2NG.github.io` 的 `Contents: Read and write`。以下步骤用于重建环境。

创建一个仅安装到本仓库的 GitHub App：

1. Repository permissions 中仅开放 `Contents: Read and write`。
2.  Install App 到 `cpower-2NG/cpower-2NG.github.io`。
3. 记录 App ID 与 Installation ID。
4. 生成 private key；私钥只放进 GitHub Secret，之后由 Bicep 写入 Key Vault。

同步器不会保存 GitHub Token。每次同步都使用短期 installation token，并把内容直接提交到 `main`。

## 4. GitHub Actions Secrets

在仓库 Settings → Secrets and variables → Actions 中添加：

| Secret | 用途 |
|---|---|
| `AZURE_CLIENT_ID` | GitHub OIDC 部署身份 |
| `AZURE_TENANT_ID` | Azure 租户 |
| `AZURE_SUBSCRIPTION_ID` | Azure 订阅 |
| `AZURE_RESOURCE_GROUP` | 例如 `rg-bifrost-prod` |
| `AZURE_FUNCTION_APP_NAME` | 部署后的 Functions 名称 |
| `AZURE_SYNC_JOB_NAME` | 默认 `qzone-sync` |
| `AZURE_AUTH_JOB_NAME` | 默认 `qzone-auth` |
| `ENTRA_TENANT_ID` | 管理应用租户 |
| `ENTRA_CLIENT_ID` | 管理应用客户端 ID |
| `ENTRA_API_AUDIENCE` | 管理 API audience |
| `ENTRA_ADMIN_OBJECT_ID` | 管理员对象 ID |
| `GH_APP_ID` | GitHub App ID |
| `GH_APP_INSTALLATION_ID` | GitHub App Installation ID |
| `GH_APP_PRIVATE_KEY` | GitHub App 完整 PEM 私钥 |
| `INTERACTION_HASH_SALT` | 至少 32 字节的随机字符串 |
| `AZURE_BUDGET_EMAIL` | 预算告警邮箱，可留空 |
| `ADMIN_USERNAME` | 可选：账密登录的管理员账号 |
| `ADMIN_PASSWORD_HASH` | 可选：口令 scrypt 哈希，见下文“账密登录” |
| `ADMIN_SESSION_SECRET` | 可选：账密会话签名密钥，随机 ≥32 字节 |

GitHub 部署身份还需要在 Azure 订阅上拥有创建部署和分配角色的权限。建议使用单独的部署服务主体，并为仓库 `main` 分支配置 GitHub OIDC 联合凭据：

```powershell
az ad app create --display-name github-bifrost-deploy
az ad sp create --id <app-client-id>
```

随后在应用注册的 Federated credentials 中新增 GitHub 来源，仓库填写完整名称，分支填写 `main`。部署身份至少需要在目标资源组拥有 Contributor 和 User Access Administrator。

## 5. 部署基础设施

先把仓库 Settings → Pages → Build and deployment 的 Source 改为 **GitHub Actions**，避免和仓库已有的 Jekyll 自动构建重复。

运行 GitHub Actions 中的 **Deploy Azure infrastructure**，填写地区和资源名前缀。Bicep 会创建：

- Cosmos DB NoSQL Free Tier，贡献者设置为 1,000 RU/s；
- Comments、Activity、State、Rate limits 四类容器；
- Functions Consumption Plan 与 Node.js 22；
- Blob Storage 的公开媒体容器与私有归档容器；
- Key Vault；
- 手动 `qzone-auth` Job 与每日 `qzone-sync` Job；
- Log Analytics、Application Insights 与可选月度预算告警。

首次部署若提示 Cosmos Free Tier 不可用，确认订阅从未创建过启用免费层的 Cosmos 账户，或检查区域支持情况。

## 6. 配置前端

部署完成后取得 Functions 的基础地址，更新 `data/site.json`：

```json
{
  "interactions": {
    "provider": "azure",
    "enabled": true,
    "apiBaseUrl": "https://<function-app>.azurewebsites.net/api",
    "commentsEnabled": true,
    "reactionsEnabled": true,
    "viewsEnabled": true,
    "admin": {
      "tenantId": "<tenant-id>",
      "clientId": "<client-id>",
      "apiScope": "api://<client-id>/access_as_user"
    }
  }
}
```

提交并推送后，Pages workflow 会重新构建静态站，API workflow 会部署 Functions。

## 7. 构建同步镜像

运行 **Build and deploy QQ sync image**。workflow 会：

1. 构建 `sync/Dockerfile`；
2. 推送 `ghcr.io/cpower-2ng/bifrost-qzone-sync`；
3. 更新 `qzone-auth` 与 `qzone-sync` 两个 Job 的镜像。

如果 GHCR 镜像仍是私有的，请在 GitHub Packages 中将该包设为 Public；否则 Container Apps 无法匿名拉取。也可以改为配置 ACR 与托管身份拉取。

## 8. 首次 QQ 登录与验收

1. 打开 `https://cpower-2ng.github.io/admin.html`。
2. 在登录界面选择 Microsoft（Entra ID）或站点口令登录。
3. 点击“重新连接 QQ”，扫描受保护页面中的临时二维码。
4. 点击“验收同步”，只生成候选和隔离报告，不提交公开内容。
5. 检查图片清晰度、视频封面、筛选规则和历史互动匿名化结果。
6. 在“同步规则”中确认 `autoPublish`；如果 QQ 接口没有返回可靠可见性字段，还要明确决定是否把 `safety.quarantineUnknownVisibility` 改为 `false`。默认值 `true` 会继续把可见性未知的内容留在隔离区。
7. 点击“增量同步”，确认 GitHub 自动产生 `sync(qzone)` 提交并触发 Pages 部署。

需要逐条放行时，在“人工覆盖”中按 QQ 动态 ID 添加：

```json
{
  "id:123456789": {
    "publishStatus": "published",
    "phase": "fantasy"
  }
}
```

覆盖只影响站点归档，不会修改 QQ 空间原内容。

旧会话失效时，管理页会显示 `auth_required`。重新扫码即可，不需要登录服务器或修改本地文件。

如果云端二维码截图链路延迟导致扫码失效，可以在项目 `sync/` 目录运行一次本地有头浏览器认证：

```powershell
az login --tenant <TENANT_ID>
$env:KEY_VAULT_URI = "https://kv-bifrost-z43zcc.vault.azure.net/"
npm run auth:local
```

脚本会打开真实浏览器显示 QQ 二维码。扫码成功后，会话直接加密写入 Key Vault；这只用于首次登录或会话失效后的重新认证，日常同步仍在云端运行。

## 9. 数据导出与迁移

每日定时函数会在私有容器生成：

- `exports/interactions/YYYY-MM-DD/*.ndjson.gz`
- `exports/interactions/YYYY-MM-DD/*.csv`

导出时移除 IP、访客与 User-Agent 哈希，只保留内容、状态、聚合值和稳定 ID。迁移到 Azure SQL、阿里云或自建服务时，以该格式导入，不需要读取 Cosmos 私有格式。

## 10. 成本与安全边界

- Cosmos 账户启用 Free Tier 后，常规个人站互动量预计留在 1,000 RU/s 与 25 GB 内。
- Functions 每月前 100 万次请求处于免费范围；Container Apps Job 每日运行时间也会计入学生账户免费额度。
- 预算设置按实际消费在 50%、80%、100% 时告警。
- QQ Cookie、qzone token 和 GitHub App 私钥只存 Key Vault；浏览器永远拿不到这些值。
- 原始 QQ 归档在私有 Blob；公开仓库只保存经过筛选与匿名化的规范化内容。
