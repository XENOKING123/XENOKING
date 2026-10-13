#!/usr/bin/env node
/*
 * XENO STORE — web/build.mjs (Node 18+, no dependencies)
 *
 * Bundles web/src/** into ONE self-contained file: web/dist/index.html.
 *   - css/*.css and js/*.js are concatenated in filename order (00- … 90-)
 *   - vendor/qrcode.js is inlined (global `qrcode` function)
 *   - every i18n/*.json is inlined as window.XS_I18N = { code: {...} }
 *   - src/logo.jpg is inlined as a data URI for the header badge
 *   - block comments are stripped (a tiny scanner keeps strings/regex intact)
 *   - the bundle is checked for syntax the PS5 WebKit does not understand
 *     (optional chaining, nullish coalescing, class fields, ES modules)
 *
 * Usage: node web/build.mjs [--out PATH] [--quiet]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, 'src');
const VENDOR = join(here, 'vendor');
const args = process.argv.slice(2);
const argValue = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const OUT = resolve(argValue('--out') || join(here, 'dist', 'index.html'));
const quiet = args.includes('--quiet');
const log = (...m) => { if (!quiet) console.log(...m); };

function listSorted(dir, ext) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(ext)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((f) => join(dir, f));
}

/* ---------- comment stripping ----------
 * JS: a linear scanner that knows about '…', "…", `…` strings, // and /* comments and
 * regex literals (a `/` is a regex when the previous significant token cannot end an
 * expression). Only comments are removed; every other byte is copied verbatim. */
function stripJs(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let lastSig = '';          // last significant (non-space, non-comment) character written
  let lastWord = '';         // last identifier/keyword written (for `return /re/`)
  const regexAfterWord = /^(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;
  const isWordChar = (c) => /[A-Za-z0-9_$]/.test(c);
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '*') {                         // block comment
      const end = src.indexOf('*/', i + 2);
      const body = end < 0 ? src.slice(i) : src.slice(i, end + 2);
      // keep a newline so line-based constructs (ASI) are untouched
      if (body.indexOf('\n') >= 0) out += '\n';
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '/' && d === '/') {                         // line comment
      const end = src.indexOf('\n', i);
      i = end < 0 ? n : end;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') {           // string / template literal
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      out += src.slice(i, j + 1); lastSig = c; lastWord = ''; i = j + 1;
      continue;
    }
    if (c === '/') {                                      // division or regex?
      const regexOk = lastSig === '' || '(,=:[!&|?{};+-*%<>~^'.indexOf(lastSig) >= 0 || (lastWord && regexAfterWord.test(lastWord));
      if (regexOk) {
        let j = i + 1, inClass = false;
        while (j < n) {
          const x = src[j];
          if (x === '\\') { j += 2; continue; }
          if (x === '[') inClass = true; else if (x === ']') inClass = false;
          else if (x === '/' && !inClass) break;
          else if (x === '\n') break;                     // not a regex after all; bail out safely
          j++;
        }
        while (j + 1 < n && /[a-z]/.test(src[j + 1])) j++;  // flags
        out += src.slice(i, j + 1); lastSig = '/'; lastWord = ''; i = j + 1;
        continue;
      }
    }
    out += c;
    if (!/\s/.test(c)) {
      lastSig = c;
      if (isWordChar(c)) lastWord = (isWordChar(src[i - 1] || '') ? lastWord : '') + c; else lastWord = '';
    }
    i++;
  }
  // drop indentation and blank lines (never inside strings: ES5 strings cannot span lines)
  return out.split('\n').map((l) => l.replace(/^\s+/, '')).filter((l) => l.length).join('\n');
}
function stripCss(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/^\s+/, '')).filter((l) => l.length).join('\n');
}

/* ---------- PS5 WebKit compatibility check (ES2017) ---------- */
function checkEs2017(js, label) {
  const problems = [];
  // scan outside strings/regex: reuse stripJs output (comments gone) and blank out string bodies
  const masked = js.replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, (m) => m[0] + ' '.repeat(m.length - 2) + m[0]);
  const tests = [
    [/\?\.[A-Za-z_$\[(]/, 'optional chaining (?.)'],
    [/[^?]\?\?[^?]/, 'nullish coalescing (??)'],
    [/\bimport\s*[{'"*]|\bexport\s+(default|const|function|class|let|var|\{)/, 'ES module syntax'],
    [/\bclass\s+[A-Za-z_$][\w$]*\s*(extends\s+[\w$.]+\s*)?\{[^}]*\n\s*(static\s+|#)?[A-Za-z_$][\w$]*\s*=/, 'class fields'],
    [/\basync\s+function|\bawait\s/, 'async/await (allowed in ES2017 but avoided for older WebKit)'],
    [/\*\*=?/, 'exponent operator (**)']
  ];
  tests.forEach(([re, what]) => { const m = re.exec(masked); if (m) problems.push(`${label}: ${what} near "${masked.slice(Math.max(0, m.index - 30), m.index + 30).replace(/\s+/g, ' ')}"`); });
  return problems;
}

/* ---------- inputs ---------- */
const shell = readFileSync(join(SRC, 'index.html'), 'utf8');
const cssFiles = listSorted(join(SRC, 'css'), '.css');
const jsFiles = listSorted(join(SRC, 'js'), '.js');
const i18nFiles = listSorted(join(SRC, 'i18n'), '.json');
if (!cssFiles.length || !jsFiles.length) { console.error('build: no css/js sources found under ' + SRC); process.exit(1); }
if (!i18nFiles.some((f) => f.endsWith('/en.json'))) { console.error('build: src/i18n/en.json is required (canonical locale)'); process.exit(1); }

const css = cssFiles.map((f) => `/* ${f.split('/').pop()} */\n` + stripCss(readFileSync(f, 'utf8'))).join('\n');
const jsParts = jsFiles.map((f) => ({ name: f.split('/').pop(), code: stripJs(readFileSync(f, 'utf8')) }));
const js = jsParts.map((p) => p.code).join('\n');
const vendorPath = join(VENDOR, 'qrcode.js');
const vendor = existsSync(vendorPath) ? stripJs(readFileSync(vendorPath, 'utf8')) : '';
if (!vendor) console.warn('build: web/vendor/qrcode.js missing — pairing QR will fall back to plain text');

/* i18n: validate JSON, make sure every locale is an object, report keys missing vs en.json */
const flatten = (o, p = '', out = {}) => { for (const k of Object.keys(o)) { const key = p ? p + '.' + k : k; if (o[k] && typeof o[k] === 'object') flatten(o[k], key, out); else out[key] = String(o[k]); } return out; };
const i18n = {};
let enKeys = null;
for (const f of i18nFiles) {
  const code = f.split('/').pop().replace(/\.json$/, '');
  let obj;
  try { obj = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { console.error(`build: ${f} is not valid JSON: ${e.message}`); process.exit(1); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { console.error(`build: ${f} must contain an object`); process.exit(1); }
  i18n[code] = obj;
}
enKeys = Object.keys(flatten(i18n.en));
for (const code of Object.keys(i18n)) {
  if (code === 'en') continue;
  const keys = flatten(i18n[code]);
  const missing = enKeys.filter((k) => !(k in keys));
  if (missing.length) log(`build: i18n/${code}.json is missing ${missing.length} of ${enKeys.length} keys (English is used for those)`);
}

/* keys used by the JS that en.json does not define → hard error (no raw keys in the UI) */
const used = new Set();
for (const m of js.matchAll(/\bt\('([a-zA-Z0-9_.]+)'\s*[,)]/g)) used.add(m[1]);
for (const m of js.matchAll(/'(legend\.[a-z]+)'/g)) used.add(m[1]);
const enFlat = flatten(i18n.en);
const undefinedKeys = [...used].filter((k) => !(k in enFlat));
if (undefinedKeys.length) { console.error('build: i18n keys used in JS but missing from en.json:\n  ' + undefinedKeys.join('\n  ')); process.exit(1); }

/* logo */
const logoPath = join(SRC, 'logo.jpg');
const logoUri = existsSync(logoPath) ? 'data:image/jpeg;base64,' + readFileSync(logoPath).toString('base64') : '/logo.jpg';

/* ---------- ES2017 check ---------- */
const problems = [];
for (const p of jsParts) problems.push(...checkEs2017(p.code, p.name));
if (problems.length) { console.error('build: the bundle uses syntax the PS5 browser may reject:\n  ' + problems.join('\n  ')); process.exit(1); }

/* ---------- assemble ---------- */
const scriptSafe = (s) => s.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const i18nScript = 'window.XS_I18N=' + scriptSafe(JSON.stringify(i18n)) + ';';
const version = (() => { try { return readFileSync(join(here, '..', 'VERSION'), 'utf8').trim(); } catch (e) { return '0.0.0'; } })();
const sourceHash = createHash('sha256').update(css + js + vendor + i18nScript + version).digest('hex').slice(0, 12);
const buildInfo = `window.XS_BUILD={version:${JSON.stringify(version)},hash:${JSON.stringify(sourceHash)},builtAt:${JSON.stringify(new Date().toISOString())}};`;

let html = shell;
const slots = { '<!--XS:CSS-->': css, '<!--XS:LOGO-->': logoUri, '<!--XS:VENDOR-->': scriptSafe(vendor), '<!--XS:I18N-->': buildInfo + '\n' + i18nScript, '<!--XS:JS-->': scriptSafe(js) };
for (const key of Object.keys(slots)) {
  if (html.indexOf(key) < 0) { console.error(`build: src/index.html lacks the ${key} slot`); process.exit(1); }
  html = html.split(key).join(slots[key]);
}
html = html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta name="xs-build" content="${version}+${sourceHash}">`);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
const size = statSync(OUT).size;
const kb = (n) => (n / 1024).toFixed(1) + ' KiB';
log(`build: ${OUT}`);
log(`       ${kb(size)} total — css ${kb(Buffer.byteLength(css))}, js ${kb(Buffer.byteLength(js))}, vendor ${kb(Buffer.byteLength(vendor))}, i18n ${kb(Buffer.byteLength(i18nScript))} (${Object.keys(i18n).length} locale${Object.keys(i18n).length === 1 ? '' : 's'}, ${enKeys.length} keys), logo ${kb(logoUri.length)}`);
log(`       build ${version}+${sourceHash}`);
