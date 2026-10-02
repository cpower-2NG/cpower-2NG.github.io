// 站点使用的 Markdown 渲染器。
// 支持范围见 docs/design/20-backend.md：标题、加粗、斜体、行内代码、链接、图片、
// 引用、列表（一层嵌套）、表格、分隔线、围栏代码块与数学公式；段内单换行渲染为 <br>，
// Markdown 里的原生 HTML 一律转义。
// 公式在物化（导入）时用 KaTeX 预渲染成 HTML，样式与字体随站点发布（core/katex/），
// 阅读页不需要任何运行时脚本。

import katex from 'katex';

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** 数学公式：KaTeX 预渲染；渲染失败时退回原文，避免整篇渲染失败。 */
export function renderMath(tex, displayMode) {
  try {
    return katex.renderToString(String(tex ?? '').trim(), {
      displayMode: Boolean(displayMode),
      throwOnError: false,
      strict: false,
      output: 'html',
    });
  } catch {
    return `<code>${escapeHtml(tex)}</code>`;
  }
}

function renderInline(text) {
  const codes = [];
  const maths = [];

  // 代码与公式都要在转义前取出：LaTeX 里的 < > & \ 不能被当成 Markdown 或 HTML 处理
  let out = String(text ?? '');
  out = out.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out.replace(/\$([^$\n]+?)\$/g, (_, tex) => {
    maths.push(tex);
    return `\u0001${maths.length - 1}\u0001`;
  });
  out = escapeHtml(out);
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy">');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_\w])_([^_\n]+)_(?![\w_])/g, '$1<em>$2</em>');
  out = out.replace(/\u0000(\d+)\u0000/g, (_, index) => `<code>${codes[Number(index)]}</code>`);
  out = out.replace(/\u0001(\d+)\u0001/g, (_, index) => renderMath(maths[Number(index)], false));

  return out;
}

/** 块级公式：$$…$$、\[…\] 与 \begin{env}…\end{env}（env 如 align*）。 */
function readMathBlock(lines, start) {
  const line = lines[start].trim();
  let first = '';
  let closing = '';

  if (line.startsWith('$$')) {
    if (line.length > 4 && line.endsWith('$$')) {
      return { tex: line.slice(2, -2), next: start + 1 };
    }
    first = line.slice(2);
    closing = '$$';
  } else if (line.startsWith('\\[')) {
    if (line.length > 4 && line.endsWith('\\]')) {
      return { tex: line.slice(2, -2), next: start + 1 };
    }
    first = line.slice(2);
    closing = '\\]';
  } else {
    const environment = line.match(/^\\begin\{([A-Za-z*]+)\}/);
    if (!environment) {
      return null;
    }
    first = line;
    closing = `\\end{${environment[1]}}`;
  }

  const buffer = [first];
  let index = start + 1;
  while (index < lines.length) {
    const current = lines[index];
    const at = current.indexOf(closing);
    if (at >= 0) {
      // $$ 与 \[ 的结束符不进入公式；\end{env} 必须保留，否则环境不闭合
      buffer.push(closing.startsWith('\\end{') ? current.slice(at) : current.slice(0, at));
      return { tex: buffer.join('\n'), next: index + 1 };
    }
    buffer.push(current);
    index += 1;
  }
  return { tex: buffer.join('\n'), next: lines.length };
}

function isTableStart(lines, index) {
  const line = lines[index];
  const next = lines[index + 1] || '';
  if (!line.includes('|')) {
    return false;
  }
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(next) && next.includes('-');
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function renderTable(header, rows) {
  const head = `<thead><tr>${header.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead>`;
  const body = `<tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`)
    .join('')}</tbody>`;
  return `<table>${head}${body}</table>`;
}

function parseList(lines, start) {
  const first = lines[start].match(/^(\s*)([-*]|\d+[.)])\s+(.*)$/);
  const baseIndent = first[1].length;
  const ordered = /^\d/.test(first[2]);
  const items = [];
  let i = start;

  while (i < lines.length && lines[i].trim()) {
    const m = lines[i].match(/^(\s*)([-*]|\d+[.)])\s+(.*)$/);
    if (!m || m[1].length < baseIndent || m[1].length >= baseIndent + 2) {
      break;
    }
    items.push({ text: m[3], children: [] });
    i += 1;

    while (i < lines.length && lines[i].trim()) {
      const nested = lines[i].match(/^(\s*)([-*]|\d+[.)])\s+(.*)$/);
      if (!nested || nested[1].length < baseIndent + 2) {
        break;
      }
      items[items.length - 1].children.push(nested[3]);
      i += 1;
    }
  }

  const tag = ordered ? 'ol' : 'ul';
  const html = `<${tag}>${items
    .map((item) => {
      const nested = item.children.length
        ? `<${tag}>${item.children.map((child) => `<li>${renderInline(child)}</li>`).join('')}</${tag}>`
        : '';
      return `<li>${renderInline(item.text)}${nested}</li>`;
    })
    .join('')}</${tag}>`;

  return { html, next: i };
}

export function renderMarkdown(md) {
  const lines = String(md || '').split('\n');
  const out = [];
  let paragraph = [];
  let i = 0;

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
      paragraph = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^```([\w-]*)\s*$/);
    if (fence) {
      flushParagraph();
      const buffer = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buffer.push(lines[i]);
        i += 1;
      }
      i += 1;
      const lang = fence[1] ? ` class="language-${fence[1]}"` : '';
      out.push(`<pre><code${lang}>${escapeHtml(buffer.join('\n'))}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      i += 1;
      continue;
    }

    const mathBlock = readMathBlock(lines, i);
    if (mathBlock) {
      flushParagraph();
      out.push(`<div class="math-block">${renderMath(mathBlock.tex, true)}</div>`);
      i = mathBlock.next;
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) {
      flushParagraph();
      out.push('<hr>');
      i += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      const buffer = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buffer.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote><p>${buffer.map(renderInline).join('<br>')}</p></blockquote>`);
      continue;
    }

    if (isTableStart(lines, i)) {
      flushParagraph();
      const header = splitTableRow(lines[i]);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      out.push(renderTable(header, rows));
      continue;
    }

    if (/^(\s*)([-*]|\d+[.)])\s+/.test(line)) {
      flushParagraph();
      const list = parseList(lines, i);
      out.push(list.html);
      i = list.next;
      continue;
    }

    paragraph.push(line.trim());
    i += 1;
  }

  flushParagraph();
  return out.join('\n');
}
