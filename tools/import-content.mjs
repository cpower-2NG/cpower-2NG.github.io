#!/usr/bin/env node
// 把 Word / txt / Markdown 转成一个可编辑的内容包（staging package）。
// 内容包包含：原件副本、正文 Markdown、按文档顺序整理的图片、以及 package.json（元数据与封面选择）。
// 用法：
//   node tools/import-content.mjs <文件> --out <目录> [--cover N] [--phase fantasy --section essay ...]
//   node tools/import-content.mjs --out <目录> --cover 3      # 只改封面
import { execFile } from 'node:child_process';
import { copyFile, readFile, readdir, rm, stat as statFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, parse, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readImageSize } from './lib/image-size.mjs';
import {
  contentHash,
  deriveSummary,
  ensureDir,
  markdownToText,
  readJson,
  sha256,
  slugify,
  ulid,
  writeJson,
} from './lib/content-common.mjs';

const execFileAsync = promisify(execFile);
const PANDOC_FALLBACK = join(
  process.env.LOCALAPPDATA || '',
  'Programs',
  'pandoc',
  'pandoc-3.12',
  'pandoc.exe',
);
const PDFTOPPM_FALLBACK = join(
  process.env.USERPROFILE || '',
  '.cache',
  'codex-runtimes',
  'codex-primary-runtime',
  'dependencies',
  'native',
  'poppler',
  'Library',
  'bin',
  'pdftoppm.exe',
);
const DOCX_EXTENSIONS = new Set(['.docx']);
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown']);
const PDF_EXTENSIONS = new Set(['.pdf']);
const IMAGE_REF = /!\[([^\]]*)\]\(([^)\s]+)([^)]*)\)(\{[^}]*\})?/g;

function argument(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function positional() {
  const values = process.argv.slice(2);
  const result = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value.startsWith('--')) {
      index += 1;
      continue;
    }
    result.push(value);
  }
  return result;
}

async function resolvePandoc(explicit) {
  const candidates = [explicit, 'pandoc', PANDOC_FALLBACK].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate, ['--version']);
      return { command: candidate, version: stdout.split('\n')[0].trim() };
    } catch {
      // 继续尝试下一个候选
    }
  }
  throw new Error('未找到 pandoc。请用 --pandoc 指定路径。');
}

async function resolvePdftoppm(explicit) {
  const candidates = [explicit, 'pdftoppm', PDFTOPPM_FALLBACK].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ['-v']);
      return candidate;
    } catch {
      // pdftoppm -v 会返回非零退出码，能执行即视为可用
      try {
        await statFile(candidate);
        return candidate;
      } catch {
        // 继续尝试下一个候选
      }
    }
  }
  throw new Error('未找到 pdftoppm（poppler）。请用 --pdftoppm 指定路径。');
}

/** 把 PDF 每页渲染成 WebP 派生图，返回页序记录。 */
async function renderPdfPages(pdfPath, workDir, explicitTool) {
  const sharpModule = (await import('sharp')).default;
  const tool = await resolvePdftoppm(explicitTool);
  const pagesDir = join(workDir, 'pages');
  await rm(pagesDir, { recursive: true, force: true });
  await ensureDir(pagesDir);

  const scale = Number(argument('pdf-scale', '1701')) || 1701;
  await execFileAsync(tool, ['-png', '-scale-to', String(scale), pdfPath, join(pagesDir, 'page')], {
    maxBuffer: 512 * 1024 * 1024,
  });

  const rendered = (await readdir(pagesDir))
    .filter((name) => name.toLowerCase().endsWith('.png'))
    .sort((a, b) => Number(a.match(/(\d+)\.png$/)?.[1] || 0) - Number(b.match(/(\d+)\.png$/)?.[1] || 0));

  const pages = [];
  for (const [index, name] of rendered.entries()) {
    const pngPath = join(pagesDir, name);
    const png = await readFile(pngPath);
    const meta = await sharpModule(png).metadata();
    const webp = await sharpModule(png).webp({ quality: 82, effort: 4 }).toBuffer();
    const target = `${String(index + 1).padStart(2, '0')}.webp`;
    await writeFile(join(pagesDir, target), webp);
    await rm(pngPath, { force: true });
    pages.push({
      order: index + 1,
      file: `pages/${target}`,
      width: meta.width || 0,
      height: meta.height || 0,
      bytes: webp.length,
      sha256: sha256(webp),
    });
  }

  return { tool, pages };
}

async function listFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...await listFiles(path));
    } else if (entry.isFile()) {
      found.push(path);
    }
  }
  return found;
}

function normalizeMarkdown(markdown) {
  return String(markdown || '')
    .replace(/\r\n/g, '\n')
    .replace(/\\[ \t]*$/gm, '') // pandoc 的硬换行标记，站点渲染器用单换行即可
    // pandoc 把图片尺寸写成 {width="…" height="…"}；尺寸已记入媒体元数据，这里去掉
    .replace(/\{(?=[^}\n]*\b(?:width|height)=)[^}\n]*\}/g, '')
    // 解开 pandoc 为防歧义加的转义，交给站点渲染器重新转义
    .replace(/\\([\\`*_{}\[\]()#+\-.!><])/g, '$1')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

/** 取第一段真正的正文作摘要：跳过标题行、作者行与空段。 */
function summarize(text, title) {
  const paragraphs = String(text || '')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const looksLikeHeading = (paragraph) => (
    paragraph === title
    || /^作者[：:]/.test(paragraph)
    || (paragraph.length <= 40 && !/[。！？!?…]$/.test(paragraph))
  );
  const candidate = paragraphs.find((paragraph) => !looksLikeHeading(paragraph)) || paragraphs[0] || '';
  return deriveSummary(candidate.replace(/^【[^】]{0,12}】\s*/, ''), 120);
}

function findOrderedListLines(markdown) {
  return markdown
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => /^\s{0,3}\d+[.)]\s/.test(line))
    .map(({ line, number }) => ({ number, text: line.trim().slice(0, 40) }));
}

async function convertDocx(sourcePath, workDir, pandocCommand) {
  const rawDir = join(workDir, '.pandoc-raw');
  await rm(rawDir, { recursive: true, force: true });
  await ensureDir(rawDir);

  const markdownPath = join(rawDir, 'converted.md');
  await execFileAsync(pandocCommand, [
    sourcePath,
    '-t', 'markdown-smart',
    '--wrap=none',
    `--extract-media=${join(rawDir, 'media')}`,
    '-o', markdownPath,
  ], { maxBuffer: 64 * 1024 * 1024 });

  return {
    markdown: await readFile(markdownPath, 'utf8'),
    markdownDir: rawDir,
  };
}

async function convertText(sourcePath) {
  const buffer = await readFile(sourcePath, 'utf8');
  const normalized = buffer.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  // 已有 Markdown 可能带 front-matter；元数据由内容包的 package.json 负责，这里剥掉
  const withoutFrontMatter = normalized.replace(/^---\n[\s\S]*?\n---\n?/, '');
  return {
    markdown: withoutFrontMatter,
    markdownDir: dirname(sourcePath),
  };
}

/** 按文档顺序整理图片：复制为 media/NN.ext，并把正文里的引用改写为相对路径。 */
async function collectMedia(markdown, markdownDir, workDir) {
  const mediaDir = join(workDir, 'media');
  await rm(mediaDir, { recursive: true, force: true });
  await ensureDir(mediaDir);

  const candidates = [];
  let output = '';
  let cursor = 0;
  let index = 0;

  for (const match of markdown.matchAll(IMAGE_REF)) {
    const [raw, alt, ref, title = '', attributes = ''] = match;
    const sourceFile = markdownDir ? resolve(markdownDir, ref) : resolve(markdownDir || '.', ref);
    let buffer;
    try {
      buffer = await readFile(sourceFile);
    } catch {
      output += markdown.slice(cursor, match.index + raw.length);
      cursor = match.index + raw.length;
      continue;
    }

    index += 1;
    const extension = (extname(sourceFile) || '.png').toLowerCase();
    const fileName = `${String(index).padStart(2, '0')}${extension}`;
    const targetPath = join(mediaDir, fileName);
    await copyFile(sourceFile, targetPath);

    const size = readImageSize(buffer) || { width: 0, height: 0 };
    candidates.push({
      order: index,
      file: `media/${fileName}`,
      sourceName: basename(sourceFile),
      width: size.width,
      height: size.height,
      bytes: buffer.length,
      sha256: sha256(buffer),
    });

    output += markdown.slice(cursor, match.index);
    output += `![${alt}](media/${fileName}${title})${attributes}`;
    cursor = match.index + raw.length;
  }

  output += markdown.slice(cursor);
  return { markdown: output, candidates };
}

function resolveCover(value, candidates) {
  if (!value || !candidates.length) {
    return candidates.length ? candidates[0].file : '';
  }

  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= candidates.length) {
    return candidates[numeric - 1].file;
  }

  const wanted = String(value).replaceAll('\\', '/');
  const match = candidates.find((candidate) => (
    candidate.file === wanted
    || candidate.sourceName === wanted
    || basename(candidate.file) === wanted
    || candidate.file === `media/${wanted}`
  ));
  if (!match) {
    throw new Error(`找不到封面 ${value}。可用：${candidates.map((c, i) => `${i + 1}=${c.file}`).join('，')}`);
  }
  return match.file;
}

function printMedia(pool, cover, coverSource) {
  if (!pool.length) {
    console.log('媒体：无（将使用文字封面）');
    return;
  }
  console.log(`封面候选 ${pool.length} 个（--cover 用这里的序号）：`);
  for (const [index, item] of pool.entries()) {
    const marker = item.file === cover ? ' ← 封面' : '';
    console.log(`  ${String(index + 1).padStart(2)}. ${item.file}  ${item.width}×${item.height}  ${(item.bytes / 1024).toFixed(0)} KB${marker}`);
  }
  console.log(`封面来源：${coverSource === 'manual' ? '手动指定' : coverSource === 'text' ? '文字封面' : '默认取首图'}`);
}

async function updateCoverOnly(workDir, coverValue) {
  const packagePath = join(workDir, 'package.json');
  const existing = await readJson(packagePath);
  if (!existing) {
    throw new Error(`${workDir} 下没有 package.json，无法只更新封面。`);
  }
  const candidates = existing.coverCandidates || [];
  const pool = [...candidates, ...(existing.publication?.pages || [])];
  const cover = resolveCover(coverValue, pool);
  existing.cover = cover;
  existing.coverSource = cover ? 'manual' : 'text';
  existing.updatedAt = new Date().toISOString();
  await writeJson(packagePath, existing);
  console.log(`封面已更新为 ${cover || '（文字封面）'}`);
  printMedia(pool, existing.cover, existing.coverSource);
}

async function main() {
  const workDir = resolve(argument('out', ''));
  const coverValue = argument('cover');
  const files = positional();

  if (!workDir) {
    throw new Error('必须用 --out 指定输出的内容包目录。');
  }

  if (!files.length) {
    if (!coverValue) {
      throw new Error('只给 --out 时需要同时用 --cover 指定封面。');
    }
    await updateCoverOnly(workDir, coverValue);
    return;
  }

  const sourcePath = resolve(files[0]);
  const info = await statFile(sourcePath);
  if (!info.isFile()) {
    throw new Error('输入必须是单个文件。');
  }

  const extension = extname(sourcePath).toLowerCase();
  const isDocx = DOCX_EXTENSIONS.has(extension);
  const isText = TEXT_EXTENSIONS.has(extension);
  const isPdf = PDF_EXTENSIONS.has(extension);
  if (!isDocx && !isText && !isPdf) {
    throw new Error(`暂不支持的文件格式：${extension || '无扩展名'}（当前支持 .docx / .txt / .md / .pdf）`);
  }

  const existing = await readJson(join(workDir, 'package.json'));
  if (existing && !flag('force')) {
    throw new Error(`${workDir} 已存在内容包。加 --force 重新生成，或用 --cover 只改封面。`);
  }
  // --force 表示"按原件重做"：除稳定标识外，不沿用旧包里的派生内容
  const reuse = flag('force') ? {} : (existing || {});

  const phase = argument('phase', reuse.phase || 'fantasy');
  const section = argument('section', reuse.section || 'essay');
  const kind = argument('kind', reuse.kind || 'standard');
  const entryType = argument('type', reuse.entryType || 'article');
  const title = argument('title') || reuse.title || parse(basename(sourcePath)).name;
  const date = argument('date') || new Date().toISOString().slice(0, 10);
  const tags = argument('tags') ? argument('tags').split(',').map((t) => t.trim()).filter(Boolean) : (reuse.tags || []);
  const author = argument('author', reuse.author || '');

  await ensureDir(workDir);
  await ensureDir(join(workDir, 'source'));
  const sourceCopy = join(workDir, 'source', basename(sourcePath));
  await copyFile(sourcePath, sourceCopy);

  let converter = { command: '', version: '' };
  let converted;
  if (isDocx) {
    converter = await resolvePandoc(argument('pandoc'));
    converted = await convertDocx(sourcePath, workDir, converter.command);
  } else if (isPdf) {
    // PDF 没有可提取的正文，正文留空；文字可从同名 docx 单独导入
    converted = { markdown: '', markdownDir: null };
  } else {
    converted = await convertText(sourcePath);
  }

  const collected = await collectMedia(converted.markdown, converted.markdownDir, workDir);
  const markdown = normalizeMarkdown(collected.markdown);
  await writeFile(join(workDir, 'content.md'), `${markdown}\n`, 'utf8');

  const candidates = collected.candidates;

  // 出版物：来源本身就是 PDF，或额外用 --pdf 附带一份排版稿
  const attachedPdf = argument('pdf') ? resolve(argument('pdf')) : '';
  const publicationPdf = isPdf ? sourcePath : attachedPdf;
  let publication = null;
  if (publicationPdf) {
    if (!isPdf) {
      await copyFile(publicationPdf, join(workDir, 'source', basename(publicationPdf)));
    }
    const rendered = await renderPdfPages(publicationPdf, workDir, argument('pdftoppm'));
    const pdfBuffer = await readFile(publicationPdf);
    publication = {
      pdfFile: `source/${basename(publicationPdf)}`,
      pdfBytes: pdfBuffer.length,
      pdfSha256: sha256(pdfBuffer),
      pageCount: rendered.pages.length,
      pages: rendered.pages,
      renderer: rendered.tool,
    };
    console.log(`PDF 渲染：${rendered.pages.length} 页 → pages/（WebP）`);
  }

  // 封面候选：正文内嵌图优先，出版物页面兜底
  const pageCandidates = publication ? publication.pages : [];
  const coverPool = [...candidates, ...pageCandidates];
  // 即使 --force 重做，只要原来选的封面还在，就继续沿用
  const previousCover = existing?.cover && coverPool.some((candidate) => candidate.file === existing.cover) ? existing.cover : '';
  const effectiveCover = coverValue || previousCover;
  const cover = resolveCover(effectiveCover, coverPool);
  const coverSource = !coverPool.length ? 'text' : (effectiveCover ? 'manual' : 'auto-first');

  const text = markdownToText(markdown);
  const entryId = existing?.entryId || ulid();
  const slug = reuse.slug || slugify(title);
  // 网址不含阶段与分区：重新分类时链接不变；保留 .html 后缀以保证静态托管直链可靠
  const path = reuse.path || `/content/${slug}.html`;

  const pkg = {
    schemaVersion: 1,
    entryId,
    entryType,
    kind,
    phase,
    section,
    tags,
    seriesId: argument('series') ? `series:${slugify(argument('series'))}` : (reuse.seriesId || null),
    seriesOrder: Number(argument('series-order', reuse.seriesOrder || 0)) || null,
    slug,
    path,
    title,
    subtitle: reuse.subtitle || '',
    summary: argument('summary') || summarize(text, title),
    date,
    author,
    status: argument('status', reuse.status || 'draft'),
    cover,
    coverSource,
    coverCandidates: candidates,
    publication,
    contentHash: contentHash(markdown),
    source: {
      file: `source/${basename(sourcePath)}`,
      format: extension.replace('.', ''),
      converter: converter.command ? `${converter.version} (${basename(converter.command)})` : 'none',
      importedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  };
  await writeJson(join(workDir, 'package.json'), pkg);
  await rm(join(workDir, '.pandoc-raw'), { recursive: true, force: true });

  const suspicious = findOrderedListLines(markdown);
  console.log(`\n内容包已生成：${workDir}`);
  console.log(`标题：${title}`);
  console.log(`路径：${path}`);
  console.log(`正文字符：${text.length}（去空白）`);
  console.log(`转换器：${pkg.source.converter}`);
  printMedia(coverPool, cover, coverSource);
  if (!isDocx) {
    console.log('提示：非 docx 来源，未做格式转换，正文即原文。');
  }
  if (suspicious.length) {
    console.log(`\n需人工确认：正文里有 ${suspicious.length} 处有序列表，可能来自“1.”开头的普通段落：`);
    for (const item of suspicious.slice(0, 8)) {
      console.log(`  第 ${item.number} 行：${item.text}`);
    }
  }
  console.log('\n下一步：编辑 package.json 与 content.md（含改封面：--cover N 或直接改 cover 字段），然后运行');
  console.log(`  node tools/build-documents.mjs ${workDir}`);
}

main().catch((error) => {
  console.error(`[import-content] ${error.message}`);
  process.exitCode = 1;
});
