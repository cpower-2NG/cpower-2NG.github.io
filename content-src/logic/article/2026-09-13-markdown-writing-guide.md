---
title: Markdown 写作指南
date: 2026-09-13
phase: logic
type: article
section: log
tags: workflow, markdown
summary: front-matter 字段说明、支持的语法范围，以及长文粘贴 HTML 的工作流。
featured: true
---

## 文件放哪里

在 `content-src/<相位>/<类型>/` 下新建 `.md` 文件即可，文件名建议带日期前缀（`YYYY-MM-DD-标题.md`），构建时会自动识别为发布日期。

- `content-src/logic/diary/` 逻辑位面 · 日志
- `content-src/logic/article/` 逻辑位面 · 长文
- `content-src/fantasy/diary/` 幻想位面 · 手记
- `content-src/fantasy/article/` 幻想位面 · 长文

## front-matter 字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `title` | 建议 | 标题；省略时取正文第一个一级标题或文件名 |
| `date` | 建议 | `YYYY-MM-DD`；省略时取文件名日期或当天 |
| `phase` | 可选 | `logic` / `fantasy`；省略时按目录名判断 |
| `type` | 可选 | `diary`（短内容）或 `article`（长文）；省略时按目录名判断 |
| `tags` | 可选 | 逗号分隔或 YAML 列表 |
| `summary` | 可选 | 摘要；省略时自动截取首段 |
| `featured` | 可选 | `true` 时进入仪表盘精选位 |

## 支持的语法

标题（二级起写，一级留给 `title` 字段）、**加粗**、*斜体*、`行内代码`、[链接](https://github.com/)、图片、引用、有序/无序列表（支持一层嵌套）、表格、分隔线和围栏代码块：

```js
// 围栏代码块会原样转义，安全可靠
console.log('hello bifrost');
```

段落内的单个换行会渲染成 `<br>`，适合日记体随手断行；需要正式排版的长文请保持段间空行。

## 长文粘贴 / 上传怎么办

从别处粘贴的现成 HTML 长文，不走 Markdown：直接在 `content/` 对应目录新建 HTML 片段，并在文件开头内嵌一段 meta 块即可入索引：

```html
<script type="application/x-bifrost-meta">
{"title":"文章标题","date":"2026-09-13","tags":["随笔"],"summary":"一句话摘要","type":"article"}
</script>
```

写完任一种内容，双击 `build.cmd`（或运行 `node build.mjs`），仪表盘、目录、命令面板和文章页导航会自动更新。

## 当前限制

- 表格、引用内不支持再嵌套列表等复杂结构
- Markdown 源内的原生 HTML 标签会被转义显示（需要 HTML 就走片段工作流）
- 代码块内的 ``` 需独占一行收尾
