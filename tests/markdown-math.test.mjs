import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from '../tools/lib/markdown.mjs';

test('公式在物化时渲染成 KaTeX，且不残留原始标记', () => {
  const html = renderMarkdown([
    '行内公式 $a^2+b^2=c^2$ 应该渲染。',
    '',
    '$$',
    '\\sum_{i=1}^N A_i B_j',
    '$$',
    '',
    '\\begin{align*}',
    'S &= \\sum_{i=1}^N A_i \\\\',
    '  &= \\sum_{i=1}^N B_i',
    '\\end{align*}',
    '',
  ].join('\n'));

  assert.ok(html.includes('class="katex"'), '行内公式应渲染为 KaTeX');
  assert.ok(html.includes('katex-display'), '块级公式应使用 display 模式');
  assert.equal((html.match(/math-block/g) || []).length, 2, '$$ 与 align* 各应产生一个块');
  assert.ok(!html.includes('katex-error'), '公式渲染不应报错');
  assert.ok(!/\$\$|\\begin\{|\\end\{/.test(html), '不应残留公式标记');
});

test('代码块与行内代码里的美元符号不当作公式', () => {
  const html = renderMarkdown([
    '```bash',
    'echo $HOME',
    '```',
    '',
    '行内代码 `$A_i$` 保持原样。',
    '',
  ].join('\n'));

  assert.ok(!html.includes('class="katex"'), '代码里的 $ 不应触发公式渲染');
  assert.ok(html.includes('$HOME'));
  assert.ok(html.includes('$A_i$'));
});
