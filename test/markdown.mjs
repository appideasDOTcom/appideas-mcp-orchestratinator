// The chat panel's markdown renderer, tested away from the browser.
//
// Two different things are being protected here, and only one of them is about
// markdown. The renderer escapes its input once, at the top, and every pattern
// after that point matches inert text — so the assertions that matter most are
// the ones that would still pass if the renderer got markdown wrong and would
// fail if that ordering were ever quietly reversed: a pasted <script> stays
// text, an href only ever holds a scheme we allow, and no '<' in the output
// belongs to anything but a tag this file lists by name. Turn text is whatever
// an agent pasted, which is why that is not a theoretical concern.
//
// The rest guards the false positives that make a hand-written renderer worse
// than no renderer at all: `2 * 3 * 4` is arithmetic, snake_case is an
// identifier, and a '*' inside a code span is a literal asterisk.
//
// md() lives in a browser IIFE with no exports, so this lifts it out of the
// source by its section comments. If that slice ever fails, the section moved —
// the fix is to update the markers below, not to route around the test.
//   npm run test:markdown
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

const SRC = 'src/ui/floor.js';
const OPEN = '  /* ---------- markdown ---------- */';
const CLOSE = '  /* ---------- the chat panel ---------- */';
const TMP = `./data/markdown-${process.pid}.mjs`;

let failures = 0;
const assert = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failures++;
};
const eq = (actual, expected, msg) => {
  const ok = actual === expected;
  console.log(`  ${ok ? '✓' : '✗'} ${msg}${ok ? '' : `\n      got  ${actual}\n      want ${expected}`}`);
  if (!ok) failures++;
};
const has = (hay, needle, msg) => assert(String(hay).includes(needle), msg);
const hasnt = (hay, needle, msg) => assert(!String(hay).includes(needle), msg);

async function loadRenderer() {
  const src = readFileSync(SRC, 'utf8');
  const a = src.indexOf(OPEN);
  const b = src.indexOf(CLOSE);
  if (a < 0 || b < 0 || b < a) throw new Error(`markdown section not found in ${SRC} between its two section comments`);
  // esc() is the IIFE's, copied rather than sliced: it is the hinge the whole
  // safety argument turns on, so the test states the version it is asserting
  // against instead of inheriting whatever the file happens to say.
  const esc = `const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>\n`
    + `  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));\n`;
  writeFileSync(TMP, esc + src.slice(a, b) + '\nexport { md };\n');
  return (await import(new URL(TMP, `file://${process.cwd()}/`))).md;
}

const md = await loadRenderer();

try {
  console.log('\nblocks');
  eq(md('hello there'), '<p>hello there</p>', 'a plain message is a paragraph');
  eq(md('one\ntwo'), '<p>one<br>two</p>',
     'a single newline stays a line break — half these turns are not markdown and their line breaks are all the shape they have');
  eq(md('## Two'), '<h2>Two</h2>', 'heading');
  eq(md('a\n\n---\n\nb'), '<p>a</p><hr><p>b</p>', 'rule');
  eq(md('- one\n- two'), '<ul><li>one</li><li>two</li></ul>', 'bullets');
  eq(md('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>', 'ordered list');
  eq(md('3. three\n4. four'), '<ol start="3"><li>three</li><li>four</li></ol>', 'an ordered list that does not start at one says so');
  eq(md('- one\n  - deep\n- two'), '<ul><li><p>one</p><ul><li>deep</li></ul></li><li>two</li></ul>', 'nesting');
  eq(md('> quoted'), '<blockquote><p>quoted</p></blockquote>', 'blockquote, after > has already become &gt;');
  eq(md('```js\nlet a = 1;\n```'), '<pre><code>let a = 1;</code></pre>', 'fenced code');
  eq(md('```\n**not bold**\n```'), '<pre><code>**not bold**</code></pre>', 'markdown inside a fence is text');
  eq(md('```\nhalf a li'), '<pre><code>half a li</code></pre>',
     'an unterminated fence still renders as code — that is also what a half-streamed message looks like');
  eq(md('| a | b |\n|---|--:|\n| 1 | 2 |'),
     '<table><thead><tr><th>a</th><th class="md-r">b</th></tr></thead><tbody><tr><td>1</td><td class="md-r">2</td></tr></tbody></table>',
     'table, alignment and all');
  eq(md('❯ 1. Use this MCP server'), '<p>❯ 1. Use this MCP server</p>',
     'a pasted terminal menu is not a list — a marker only counts at the start of the line');

  console.log('\ninline, and what must not become inline');
  eq(md('a **b** c'), '<p>a <strong>b</strong> c</p>', 'bold');
  eq(md('a *b* c'), '<p>a <em>b</em> c</p>', 'italic');
  eq(md('a ~~b~~ c'), '<p>a <del>b</del> c</p>', 'strikethrough');
  eq(md('run `npm test` now'), '<p>run <code>npm test</code> now</p>', 'code span');
  eq(md('2 * 3 * 4'), '<p>2 * 3 * 4</p>', 'arithmetic is not emphasis');
  eq(md('call some_var_name here'), '<p>call some_var_name here</p>', 'snake_case is an identifier, so _ is not an emphasis marker at all');
  eq(md('`a * b * c`'), '<p><code>a * b * c</code></p>', 'a star inside a code span is a star');
  eq(md('`**x**`'), '<p><code>**x**</code></p>', 'so are two of them');
  eq(md('a * b'), '<p>a * b</p>', 'a lone star is a lone star');

  console.log('\nlinks');
  has(md('see [docs](https://example.com/x)'),
      '<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">docs</a>', 'an http link is a link');
  has(md('at https://example.com/a?b=1 now'), '<a href="https://example.com/a?b=1"', 'so is a bare one');
  eq(md('[host/window.js](host/window.js)'), '<p><code>host/window.js</code></p>',
     'a repo-relative path keeps its label as code: clickable in an editor, a 404 on this board');
  hasnt(md('[x](javascript:alert(1))'), '<a ', 'javascript: never becomes an anchor');
  hasnt(md('[x](data:text/html,hi)'), '<a ', 'nor does data:');

  console.log('\nthe input is inert before any of the above runs');
  eq(md('use <b>bold</b>'), '<p>use &lt;b&gt;bold&lt;/b&gt;</p>', 'a tag in the message is text');
  hasnt(md('<img src=x onerror=alert(1)>'), '<img', 'an img does not survive');
  hasnt(md('<script>alert(1)</script>'), '<script', 'nor does a script');
  eq(md('takes `--url <board>`'), '<p>takes <code>--url &lt;board&gt;</code></p>',
     'and a placeholder in backticks survives, which the other order would swallow as an unknown tag');
  has(md('[x](https://e.com/"onmouseover="alert(1))'), '&quot;onmouseover=&quot;', 'a quote cannot close an href');
  eq(md('literal <7> here'), '<p>literal &lt;7&gt; here</p>',
     'the slot marker mdInline() uses is <n>, and escaping is what makes it impossible to counterfeit');

  console.log('\nno "<" in the output belongs to anything else');
  // The allowlist is the point: a renderer that started emitting a tag not on
  // this list would be emitting something nobody reviewed.
  const TAG = /^<\/?(p|br|hr|strong|em|del|code|pre|a|ul|ol|li|blockquote|h[1-6]|table|thead|tbody|tr|th|td)( [^<>]*)?>/;
  const corpus = [
    '<svg onload=alert(1)>', '<<script>>', '[a](vbscript:x)', '`<b>`', '<a href=x>y</a>',
    '**<i>**', '> <div>', '- <span>', '| <td> | x |\n|---|---|\n| a | b |', '```\n</code></pre>\n```',
    '<0>', '<9999>', 'a <1> b `c` [d](https://e.f)', '&lt;script&gt;', '<img\nsrc=x>',
  ];
  let stray = 0;
  for (const s of corpus) {
    const html = md(s);
    for (let i = html.indexOf('<'); i >= 0; i = html.indexOf('<', i + 1)) {
      if (!TAG.test(html.slice(i))) { stray++; console.log(`      ${JSON.stringify(s)} produced ${JSON.stringify(html.slice(i, i + 40))}`); }
    }
  }
  assert(stray === 0, `${corpus.length} hostile inputs produced no tag outside the allowlist`);

  console.log('\nand it always finishes');
  // Every block branch has to consume a line. One that does not would spin
  // forever on a message nobody has written yet, in a browser, with no stack.
  const alphabet = ['#', '-', '*', '1.', '>', '`', '```', '~~', '|', '---', '[', '](', ')', '\n', ' ', 'x', '<', '&', '"'];
  const rand = (n) => Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  const began = Date.now();
  let crashed = 0;
  for (let i = 0; i < 3000; i++) {
    try { md(rand(40)); } catch (err) { crashed++; if (crashed === 1) console.log(`      ${err.message}`); }
  }
  const took = Date.now() - began;
  assert(crashed === 0, '3000 random markdown-shaped strings, no throw');
  assert(took < 5000, `and no runaway loop (${took}ms)`);
} catch (err) {
  failures++;
  console.error(`\n  ✗ ${err.stack ?? err}`);
} finally {
  try { rmSync(TMP); } catch { /* ignore */ }
}

console.log(failures ? `\nFAIL ❌ — ${failures} failure(s)` : '\nPASS ✅ — 0 failure(s)');
process.exit(failures ? 1 : 0);
