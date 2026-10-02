FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

# pandoc: docx → markdown 转换；poppler-utils: PDF 逐页转图（pdftoppm）。
RUN apt-get update \
  && apt-get install -y --no-install-recommends pandoc poppler-utils \
  && rm -rf /var/lib/apt/lists/*

# QQ 同步依赖（playwright 浏览器已在基础镜像内）
COPY sync/package.json sync/package-lock.json ./sync/
RUN npm ci --prefix sync --omit=dev

# 导入与物化工具依赖
COPY tools/package.json tools/package-lock.json ./tools/
RUN npm ci --prefix tools

COPY sync/src ./sync/src
COPY tools ./tools

ENV NODE_ENV=production
# 工作目录固定为 /app：QQ 同步入口是 sync/src/index.js，
# 导入与发布任务入口是 tools/cloud-import.mjs / tools/cloud-publish.mjs。
CMD ["node", "sync/src/index.js"]
