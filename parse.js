// streammark — a dependency-free Markdown -> HTML renderer.
//
// Single-pass streaming design: one cursor walks the source; at every block
// boundary the upcoming characters decide which construct is consumed next,
// and each construct is eaten in place. Blockquotes and list items recurse on
// their stripped sub-source only. Inline rendering is a streaming scanner
// whose emphasis resolution works on delimiter runs (flanking + rule of 3).

import { decodeEntityBody } from './entities.js';

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

const PUNCT_RE = /[!-\/:-@\[-`{-~]/;
const UNI_PUNCT_RE = /[\p{P}\p{S}]/u;

function isUniPunct(ch) {
  return ch !== undefined && ch !== '' && UNI_PUNCT_RE.test(ch);
}

function isPunct(ch) {
  return ch !== undefined && ch !== '' && PUNCT_RE.test(ch);
}

function isSpaceCh(ch) {
  return ch === undefined || ch === '' || /\s/.test(ch);
}

// Escape for element text: ampersands that do not begin an entity-shaped
// reference are escaped; angle brackets always are.
export function escapeText(s) {
  return s
    .replace(/&(?!(?:#\d+|#[xX][0-9a-fA-F]+|\w+);)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Escape for code content: every special char is escaped.
function escapeCode(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Escape for double-quoted attribute values (same rules as text).
function escapeAttr(s) {
  return escapeText(s);
}

// Decode character references and backslash escapes inside link
// destinations / titles, the way a renderer must before re-escaping.
function unescapeEntities(s) {
  return s.replace(
    /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g,
    (m, dec, hex, name) => {
      const body =
        dec !== undefined ? '#' + dec : hex !== undefined ? '#x' + hex : name;
      const decoded = decodeEntityBody(body);
      return decoded === undefined ? m : decoded;
    },
  );
}

function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/\\/g, '%5C').replace(/%25/g, '%');
  } catch {
    return href;
  }
}

/* ------------------------------------------------------------------ */
/* line / indentation utilities (tabs advance to the next multiple of 4)*/
/* ------------------------------------------------------------------ */

// Number of columns of indentation at the start of a line, and the index
// just past the whitespace that makes up `limit` of those columns.
function indentInfo(line, limit) {
  let col = 0;
  let pos = 0;
  let full = 0;
  let p2 = 0;
  while (p2 < line.length) {
    const ch = line[p2];
    if (ch === ' ') { full += 1; p2 += 1; }
    else if (ch === '\t') { full += 4 - (full % 4); p2 += 1; }
    else break;
  }
  while (pos < line.length && col < limit) {
    const ch = line[pos];
    if (ch === ' ') {
      col += 1;
      pos += 1;
    } else if (ch === '\t') {
      col += 4 - (col % 4);
      pos += 1;
    } else {
      break;
    }
  }
  return { cols: full, pos };
}

// Remove up to `cols` columns of indentation. Absolute tab stops are
// honoured by expanding any remaining leading whitespace run into spaces,
// so a tab that straddles the cut keeps its true remaining width.
function stripIndent(line, cols) {
  if (cols <= 0) return line;
  let col = 0;
  let pos = 0;
  while (pos < line.length && col < cols) {
    const ch = line[pos];
    if (ch === ' ') {
      col += 1;
      pos += 1;
    } else if (ch === '\t') {
      const width = 4 - (col % 4);
      if (col + width <= cols) {
        col += width;
        pos += 1;
      } else {
        let abs = col + width;
        let out = ' '.repeat(abs - cols);
        pos += 1;
        while (pos < line.length && (line[pos] === ' ' || line[pos] === '\t')) {
          if (line[pos] === ' ') { out += ' '; abs += 1; pos += 1; }
          else { const w2 = 4 - (abs % 4); out += ' '.repeat(w2); abs += w2; pos += 1; }
        }
        return out + line.slice(pos);
      }
    } else {
      break;
    }
  }
  return line.slice(pos);
}

// Strip a blockquote marker ('>' plus one optional space) from a line,
// expanding leading tabs against absolute column positions.
function stripQuoteMarker(line) {
  const ind = indentInfo(line, 4);
  let pos = ind.pos;
  let abs = ind.cols;
  pos += 1; // the '>' itself
  abs += 1;
  let virt = abs;
  if (line[pos] === ' ') {
    pos += 1;
    abs += 1;
    virt += 1;
  } else if (line[pos] === '\t') {
    pos += 1;
    abs += 4 - (abs % 4);
    virt += 1;
  }
  let a = abs;
  let p = pos;
  let hasRun = false;
  while (p < line.length && (line[p] === ' ' || line[p] === '\t')) {
    hasRun = true;
    if (line[p] === ' ') { a += 1; p += 1; }
    else { a += 4 - (a % 4); p += 1; }
  }
  const spaces = 0;
  return ' '.repeat(hasRun ? Math.max(0, a - virt) : 0) + line.slice(p);
}

function isBlank(line) {
  return /^[ \t]*$/.test(line);
}

/* ------------------------------------------------------------------ */
/* link reference definitions                                          */
/* ------------------------------------------------------------------ */

function normalizeLabel(label) {
  return label
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/ß/g, 'ss');
}

// Parse a destination starting at src[pos]: <angle> or bare-with-parens.
// Returns { href, next } or null.
function parseDestAt(src, pos) {
  if (src[pos] === '<') {
    let out = '';
    let i = pos + 1;
    while (i < src.length) {
      const ch = src[i];
      if (ch === '\\' && i + 1 < src.length) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (ch === '>') return { href: out, next: i + 1 };
      if (ch === '\n' || ch === '<') return null;
      out += ch;
      i += 1;
    }
    return null;
  }
  let out = '';
  let depth = 0;
  let i = pos;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length && isPunct(src[i + 1])) {
      out += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch < ' ') break;
    if (ch === '(') depth += 1;
    if (ch === ')') {
      if (depth === 0) break;
      depth -= 1;
    }
    out += ch;
    i += 1;
  }
  if (i === pos) return null;
  return { href: out, next: i };
}

// Parse a title starting at src[pos]; returns { title, next } or null.
function parseTitleAt(src, pos) {
  const open = src[pos];
  if (open !== '"' && open !== "'" && open !== '(') return null;
  const close = open === '(' ? ')' : open;
  let out = '';
  let i = pos + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length && isPunct(src[i + 1])) {
      out += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === close) return { title: out, next: i + 1 };
    if (open === '(' && ch === '(') return null;
    out += ch;
    i += 1;
  }
  return null;
}

function skipInlineWs(src, pos) {
  let i = pos;
  while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n')) i += 1;
  return i;
}

// Try to read one reference definition beginning at lines[i].
// Returns { label, href, title, lines } (lines consumed) or null.
function tryParseDef(lines, i) {
  const first = lines[i];
  const ind = indentInfo(first, 4);
  if (ind.cols >= 4) return null;
  const rest0 = first.slice(ind.pos);
  if (rest0[0] !== '[') return null;
  // Work over the first line joined with up to eleven followers: labels,
  // destinations and titles may each live on their own line, and titles
  // may span several lines.
  let text = rest0;
  let joined = 0;
  while (joined < 11 && i + joined + 1 < lines.length) {
    joined += 1;
    text += '\n' + lines[i + joined];
  }
  // Label: up to the first unescaped ']', which must be followed by ':'.
  let pos = 1;
  let label = '';
  let labelClosed = false;
  while (pos < text.length) {
    const c = text[pos];
    if (c === '\\' && pos + 1 < text.length) {
      label += c + text[pos + 1];
      pos += 2;
      continue;
    }
    if (c === '[') return null;
    if (c === ']') { labelClosed = true; break; }
    label += c;
    pos += 1;
  }
  if (!labelClosed || !label.trim()) return null;
  if (/\n[ \t]*\n/.test(label)) return null;
  if (text[pos + 1] !== ':') return null;
  pos += 2;
  const destWsEnd = skipInlineWs(text, pos);
  if (/\n[ \t]*\n/.test(text.slice(pos, destWsEnd))) return null;
  pos = destWsEnd;
  const dest = parseDestAt(text, pos);
  if (!dest) return null;
  pos = dest.next;
  // Optional title, separated from the destination by whitespace
  // (possibly just the newline before a title-only line).
  let title = null;
  const wsEnd = skipInlineWs(text, pos);
  if (
    wsEnd > pos &&
    !/\n[ \t]*\n/.test(text.slice(pos, wsEnd)) &&
    wsEnd < text.length &&
    (text[wsEnd] === '"' || text[wsEnd] === "'" || text[wsEnd] === '(')
  ) {
    const t = parseTitleAt(text, wsEnd);
    if (t && !/\n[ \t]*\n/.test(text.slice(wsEnd, t.next))) {
      title = t.title;
      pos = t.next;
    }
  }
  // Only blanks may follow on the definition's final line. If junk follows
  // a speculative title, drop the title and re-check at the destination.
  let end = pos;
  while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end += 1;
  if (end < text.length && text[end] !== '\n') {
    if (title === null) return null;
    title = null;
    end = dest.next;
    while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end += 1;
    if (end < text.length && text[end] !== '\n') return null;
  }
  const consumed = text.slice(0, end).split('\n').length;
  if (consumed > joined + 1) return null;
  return { label, href: dest.href, title, lines: consumed };
}

function registerDef(refs, def) {
  const key = normalizeLabel(def.label);
  if (key && !refs.has(key)) {
    refs.set(key, { href: def.href, title: def.title });
  }
}

// Strip every layer of blockquote markers from a line (used by the
// definition pre-scan to see inside quotes).
function quoteStripAll(line) {
  let cur = line;
  for (let depth = 0; depth < 8; depth++) {
    const ind = indentInfo(cur, 4);
    if (ind.cols >= 4 || cur[ind.pos] !== '>') return cur;
    cur = stripQuoteMarker(cur);
  }
  return cur;
}

// Fence detection for the pre-scan: tolerant of fences nested inside
// blockquotes and list items, which the scan does not otherwise track.
function fenceOf(line) {
  const s = quoteStripAll(line);
  const ind = indentInfo(s, 4);
  if (ind.cols >= 4) return null;
  const rest = s.slice(ind.pos);
  const mk = matchListMarker(s);
  const cand = mk ? mk.contentStr : rest;
  const m = FENCE_RE.exec(cand);
  if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
    return { ch: m[1][0], len: m[1].length };
  }
  return null;
}

// Pre-scan: definitions are visible to links that precede them, so gather
// top-level definitions up front (skipping fenced code regions). A
// definition-shaped line that merely continues a paragraph does not
// count, so paragraph state is tracked while scanning.
function prescanDefs(lines, refs) {
  let inFence = null;
  let prevPara = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line)) { prevPara = false; continue; }
    const ind = indentInfo(line, 4);
    const rest = ind.cols < 4 ? line.slice(ind.pos) : '';
    const fm = fenceOf(line);
    if (inFence) {
      if (fm && fm.ch === inFence.ch && fm.len >= inFence.len) inFence = null;
      prevPara = false;
      continue;
    }
    if (fm) {
      inFence = fm;
      prevPara = false;
      continue;
    }
    if (!prevPara && rest.startsWith('[')) {
      const def = tryParseDef(lines, i);
      if (def) {
        registerDef(refs, def);
        i += def.lines - 1;
        prevPara = false;
        continue;
      }
    }
    if (!prevPara && rest.startsWith('>')) {
      // definitions nested in a blockquote are visible document-wide
      const synth = [];
      for (let k = 0; k < 12 && i + k < lines.length; k++) {
        synth.push(quoteStripAll(lines[i + k]));
      }
      if (synth[0].startsWith('[')) {
        const def = tryParseDef(synth, 0);
        if (def) {
          registerDef(refs, def);
          prevPara = false;
          continue;
        }
      }
    }
    prevPara = !(
      ind.cols >= 4 ||
      ATX_RE.test(rest) ||
      HR_RE.test(rest) ||
      rest.startsWith('>') ||
      htmlBlockType(rest) >= 1 ||
      matchListMarker(line) !== null ||
      SETEXT_RE.test(rest)
    );
  }
}

/* ------------------------------------------------------------------ */
/* inline rendering                                                    */
/* ------------------------------------------------------------------ */

const ENTITY_AT = /^&(?:#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/;
const SCHEME_AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*)>/;
const EMAIL_AUTOLINK =
  /^<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+)>/;
const HTML_TAG_AT =
  /^(?:<[a-zA-Z][a-zA-Z0-9-]*(?:[ \t\n]+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:[ \t\n]*=[ \t\n]*(?:[^ \t\n"'=<>\`]+|'[^']*'|"[^"]*"))?)*[ \t\n]*\/?>|<\/[a-zA-Z][a-zA-Z0-9-]*[ \t\n]*>)/;
const BARE_URL_AT = /^(?:https?:\/\/|www\.)[^\s<]+/i;
const BARE_EMAIL_AT =
  /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)+/;

// Trim a bare URL the GFM way: drop trailing punctuation and unbalanced
// closing brackets; a trailing entity reference is excluded as well.
function trimBareUrl(url) {
  let u = url;
  for (;;) {
    const before = u;
    u = u.replace(/[?!,.:*_~]+$/, '');
    u = u.replace(/&(?:#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);$/, '');
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      while (u.endsWith(close)) {
        const opens = u.split(open).length - 1;
        const closes = u.split(close).length - 1;
        if (closes > opens) u = u.slice(0, -1);
        else break;
      }
    }
    if (u === before) return u;
  }
}

// Find the ']' matching the '[' at src[start], honouring escapes and code
// spans. Returns its index or -1.
function findCloseBracket(src, start) {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length) {
      i += 2;
      continue;
    }
    if (ch === '`') {
      let run = 0;
      while (src[i] === '`') { run += 1; i += 1; }
      // skip a code span if it closes
      let j = i;
      let closed = false;
      while (j < src.length) {
        if (src[j] === '`') {
          let r2 = 0;
          while (src[j] === '`') { r2 += 1; j += 1; }
          if (r2 === run) { closed = true; break; }
        } else j += 1;
      }
      if (closed) { i = j; continue; }
      continue;
    }
    if (ch === '<') {
      // skip tags / autolinks: a ']' inside one is not a bracket
      let j = i + 1;
      let quote = null;
      let closed = false;
      while (j < src.length) {
        const cj = src[j];
        if (quote) {
          if (cj === quote) quote = null;
        } else if (cj === '"' || cj === "'") quote = cj;
        else if (cj === '>') { closed = true; break; }
        else if (cj === '<') break;
        j += 1;
      }
      if (closed) { i = j + 1; continue; }
      i += 1;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

// Parse "(dest title)" beginning at src[pos] === '('.
// Returns { href, title, next } or null.
function parseInlineLinkTail(src, pos) {
  let i = skipInlineWs(src, pos + 1);
  if (src[i] === ')') return { href: '', title: null, next: i + 1 };
  const dest = parseDestAt(src, i);
  if (!dest) {
    // empty destination with just a title: [a]( "t")
    if (src[i] === '"' || src[i] === "'" || src[i] === '(') {
      const t = parseTitleAt(src, i);
      if (t) {
        const j = skipInlineWs(src, t.next);
        if (src[j] === ')') return { href: '', title: t.title, next: j + 1 };
      }
    }
    return null;
  }
  i = dest.next;
  const afterDest = i;
  i = skipInlineWs(src, i);
  let title = null;
  if (i > afterDest && i < src.length && src[i] !== ')') {
    const t = parseTitleAt(src, i);
    if (!t) return null;
    title = t.title;
    i = skipInlineWs(src, t.next);
  }
  if (src[i] !== ')') return null;
  return { href: dest.href, title, next: i + 1 };
}

function linkOpenTag(href, title) {
  let s = '<a href="' + escapeAttr(cleanUrl(href)) + '"';
  if (title !== null && title !== undefined) {
    s += ' title="' + escapeAttr(title) + '"';
  }
  return s + '>';
}

function plainTextOf(html) {
  return html
    .replace(/<img[^>]*? alt="([^"]*)"[^>]*>/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

// Does this label itself contain a complete link? If so the outer link
// must not form (links may not nest); images are exempt.
function labelHasLink(labelSrc, ctx) {
  for (let k = 0; k < labelSrc.length; k++) {
    const c = labelSrc[k];
    if (c === '\\') { k += 1; continue; }
    if (c === '`') {
      let run = 0;
      while (labelSrc[k] === '`') { run += 1; k += 1; }
      let j = k;
      while (j < labelSrc.length) {
        if (labelSrc[j] === '`') {
          let r2 = 0;
          while (labelSrc[j] === '`') { r2 += 1; j += 1; }
          if (r2 === run) break;
        } else j += 1;
      }
      k = j - 1;
      continue;
    }
    if (c === '!' && labelSrc[k + 1] === '[') {
      // an image inside the label is fine; skip over it
      const img = tryLink(labelSrc, k, ctx, true, true);
      if (img) { k = img.next - 1; continue; }
    }
    if (c === '[') {
      if (tryLink(labelSrc, k, ctx, false, true)) return true;
    }
  }
  return false;
}

// Try to build a link or image whose '[' sits at src[start] (for images,
// start points at '!'). Returns { html, next } or null.
function tryLink(src, start, ctx, isImage, probe) {
  const bracketAt = isImage ? start + 1 : start;
  const close = findCloseBracket(src, bracketAt);
  if (close < 0) return null;
  const labelSrc = src.slice(bracketAt + 1, close);
  if (!probe && !isImage && labelHasLink(labelSrc, ctx)) return null;
  let href = null;
  let title = null;
  let next = -1;
  const after = close + 1;
  if (src[after] === '(') {
    const tail = parseInlineLinkTail(src, after);
    if (tail) {
      href = tail.href;
      title = tail.title;
      next = tail.next;
    }
  }
  if (next < 0 && src[after] === '[') {
    const close2 = findCloseBracket(src, after);
    if (close2 >= 0) {
      const refLabel = src.slice(after + 1, close2);
      const key = normalizeLabel(refLabel === '' ? labelSrc : refLabel);
      const def = ctx.refs.get(key);
      if (def) {
        href = def.href;
        title = def.title;
        next = close2 + 1;
      } else {
        // a following label rules out the shortcut interpretation
        return null;
      }
    }
  }
  if (next < 0) {
    const key = normalizeLabel(labelSrc);
    const def = key ? ctx.refs.get(key) : undefined;
    if (def) {
      href = def.href;
      title = def.title;
      next = after;
    }
  }
  if (next < 0) return null;
  if (isImage) {
    const altHtml = renderInline(labelSrc, { refs: ctx.refs, inLink: false, noAutolink: true });
    let s =
      '<img src="' + escapeAttr(cleanUrl(href)) +
      '" alt="' + escapeAttr(plainTextOf(altHtml)) + '"';
    if (title !== null && title !== undefined) {
      s += ' title="' + escapeAttr(title) + '"';
    }
    return { html: s + '>', next };
  }
  const inner = renderInline(labelSrc, { refs: ctx.refs, inLink: true, noAutolink: ctx.noAutolink });
  return { html: linkOpenTag(href, title) + inner + '</a>', next };
}

// Render one run of inline source to HTML.
function renderInline(src, ctx) {
  const nodes = []; // {k:'text'|'raw'|'delim', ...}
  let buf = '';
  const flush = () => {
    if (buf) {
      nodes.push({ k: 'text', s: buf });
      buf = '';
    }
  };
  const pushRaw = (html) => {
    flush();
    nodes.push({ k: 'raw', s: html });
  };

  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const prev = i > 0 ? src[i - 1] : undefined;

    if (ch === '\\') {
      const nx = src[i + 1];
      if (nx === '\n') {
        flush();
        nodes.push({ k: 'raw', s: '<br>' });
        i += 2;
        while (src[i] === ' ' || src[i] === '\t') i += 1;
        continue;
      }
      if (nx !== undefined && isPunct(nx)) {
        // escaped punctuation is literal text, never markup or an entity
        flush();
        nodes.push({ k: 'raw', s: escapeText(nx) });
        i += 2;
        continue;
      }
      buf += '\\';
      i += 1;
      continue;
    }

    if (ch === '\n') {
      // hard break: two or more trailing spaces on the current text run
      const m = / {2,}$/.exec(buf);
      if (m) {
        buf = buf.slice(0, buf.length - m[0].length);
        flush();
        nodes.push({ k: 'raw', s: '<br>' });
        i += 1;
        while (src[i] === ' ' || src[i] === '\t') i += 1;
        continue;
      } else {
        buf += '\n';
      }
      i += 1;
      continue;
    }

    if (ch === '`') {
      let run = 0;
      while (src[i] === '`') { run += 1; i += 1; }
      // find the closing run
      let j = i;
      let found = -1;
      let foundEnd = -1;
      while (j < n) {
        if (src[j] === '`') {
          let r2 = 0;
          const s2 = j;
          while (src[j] === '`') { r2 += 1; j += 1; }
          if (r2 === run) { found = s2; foundEnd = j; break; }
        } else j += 1;
      }
      if (found < 0) {
        buf += '`'.repeat(run);
        continue;
      }
      let code = src.slice(i, found).replace(/\n/g, ' ');
      if (code.length >= 2 && code[0] === ' ' && code[code.length - 1] === ' ' && /[^ ]/.test(code)) {
        code = code.slice(1, -1);
      }
      pushRaw('<code>' + escapeCode(code) + '</code>');
      i = foundEnd;
      continue;
    }

    if (ch === '&') {
      const m = /^&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(\w+));/.exec(src.slice(i, i + 40));
      if (m) {
        if (m[3] !== undefined) {
          buf += m[0]; // named references pass through untouched
          i += m[0].length;
          continue;
        }
        const cp = m[1] !== undefined ? parseInt(m[1], 10) : parseInt(m[2], 16);
        if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff)) {
          flush();
          nodes.push({ k: 'raw', s: '�' });
        } else if (cp <= 0x10ffff) {
          flush();
          nodes.push({ k: 'raw', s: escapeText(String.fromCodePoint(cp)) });
        } else {
          flush();
          nodes.push({ k: 'raw', s: '&amp;' + m[0].slice(1) });
        }
        i += m[0].length;
        continue;
      }
      buf += '&';
      i += 1;
      continue;
    }

    if (ch === '<') {
      const rest = src.slice(i);
      let m = SCHEME_AUTOLINK.exec(rest);
      if (m) {
        const uri = m[1];
        pushRaw('<a href="' + escapeAttr(cleanUrl(uri)) + '">' + escapeText(uri) + '</a>');
        i += m[0].length;
        continue;
      }
      m = EMAIL_AUTOLINK.exec(rest);
      if (m) {
        const addr = m[1];
        pushRaw('<a href="mailto:' + escapeAttr(addr) + '">' + escapeText(addr) + '</a>');
        i += m[0].length;
        continue;
      }
      if (rest.startsWith('<!--')) {
        const end = rest.indexOf('-->', 2);
        if (end >= 0) {
          pushRaw(rest.slice(0, end + 3));
          i += end + 3;
          continue;
        }
      }
      if (rest.startsWith('<?')) {
        const end = rest.indexOf('?>', 2);
        if (end >= 0) { pushRaw(rest.slice(0, end + 2)); i += end + 2; continue; }
      }
      if (rest.startsWith('<![CDATA[')) {
        const end = rest.indexOf(']]>', 9);
        if (end >= 0) { pushRaw(rest.slice(0, end + 3)); i += end + 3; continue; }
      }
      if (/^<![A-Za-z]/.test(rest)) {
        const end = rest.indexOf('>');
        if (end >= 0) { pushRaw(rest.slice(0, end + 1)); i += end + 1; continue; }
      }
      m = HTML_TAG_AT.exec(rest);
      if (m) {
        pushRaw(m[0]);
        i += m[0].length;
        continue;
      }
      buf += '<';
      i += 1;
      continue;
    }

    if (ch === '!' && src[i + 1] === '[') {
      const link = tryLink(src, i, ctx, true);
      if (link) {
        pushRaw(link.html);
        i = link.next;
        continue;
      }
      buf += '!';
      i += 1;
      continue;
    }

    if (ch === '[') {
      if (!ctx.inLink) {
        const link = tryLink(src, i, ctx, false);
        if (link) {
          pushRaw(link.html);
          i = link.next;
          continue;
        }
      }
      buf += '[';
      i += 1;
      continue;
    }

    if (ch === '*' || ch === '_' || ch === '~') {
      let run = 0;
      while (src[i] === ch) { run += 1; i += 1; }
      if (ch === '~' && run >= 3) {
        buf += '~'.repeat(run);
        continue;
      }
      const nextCh = i < n ? src[i] : undefined;
      const leftFlank = !isSpaceCh(nextCh) && (!isUniPunct(nextCh) || isSpaceCh(prev) || isUniPunct(prev));
      const rightFlank = !isSpaceCh(prev) && (!isUniPunct(prev) || isSpaceCh(nextCh) || isUniPunct(nextCh));
      let canOpen;
      let canClose;
      if (ch === '_') {
        canOpen = leftFlank && (!rightFlank || isUniPunct(prev));
        canClose = rightFlank && (!leftFlank || isUniPunct(nextCh));
      } else {
        canOpen = leftFlank;
        canClose = rightFlank;
      }
      if (!canOpen && !canClose) {
        buf += ch.repeat(run);
        continue;
      }
      flush();
      nodes.push({ k: 'delim', ch, n: run, canOpen, canClose });
      continue;
    }

    // GFM extended autolinks in plain text
    if (!ctx.noAutolink && !ctx.inLink) {
      const rest = src.slice(i);
      const boundary = prev === undefined || /[\s(\[{*"'`<]/.test(prev) || prev === '\n';
      if (boundary && (/^https?:\/\//i.test(rest) || rest.startsWith('www.'))) {
        const m = BARE_URL_AT.exec(rest);
        if (m) {
          const url = trimBareUrl(m[0]);
          if (url.length > 0) {
            const href = url.startsWith('www.') ? 'http://' + url : url;
            pushRaw('<a href="' + escapeAttr(cleanUrl(href)) + '">' + escapeText(url) + '</a>');
            i += url.length;
            continue;
          }
        }
      }
      if (
        prev === undefined ||
        !/[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~.@\/-]/.test(prev)
      ) {
        if (/[a-zA-Z0-9]/.test(ch)) {
          const rest2 = rest;
          const pm = /^(?:mailto|xmpp):/.exec(rest2);
          if (pm) {
            const em = BARE_EMAIL_AT.exec(rest2.slice(pm[0].length));
            if (em) {
              let full = pm[0] + em[0];
              let endAt = full.length;
              if (pm[0] === 'xmpp:' && rest2[endAt] === '/') {
                const rm = /^\/[a-zA-Z0-9@._~+-]+/.exec(rest2.slice(endAt));
                if (rm) { full += rm[0]; endAt += rm[0].length; }
              }
              const after = rest2[endAt];
              if (after !== '-' && after !== '_') {
                pushRaw('<a href="' + escapeAttr(cleanUrl(full)) + '">' + escapeText(full) + '</a>');
                i += endAt;
                continue;
              }
            }
          }
          const m = BARE_EMAIL_AT.exec(rest);
          if (m && m[0].length > 3) {
            const after = rest[m[0].length];
            if (after !== '-' && after !== '_') {
              pushRaw('<a href="mailto:' + escapeAttr(m[0]) + '">' + escapeText(m[0]) + '</a>');
              i += m[0].length;
              continue;
            }
          }
        }
      }
    }

    buf += ch;
    i += 1;
  }
  flush();
  processDelims(nodes);
  return nodes.map(renderNode).join('');
}

function renderNode(nd) {
  if (nd.k === 'text') return escapeText(nd.s);
  if (nd.k === 'raw') return nd.s;
  if (nd.k === 'delim') return nd.ch.repeat(nd.n);
  if (nd.k === 'wrap') {
    return '<' + nd.tag + '>' + nd.children.map(renderNode).join('') + '</' + nd.tag + '>';
  }
  return '';
}

// CommonMark delimiter-run processing (with GFM strikethrough riding the
// same machinery on '~').
function processDelims(nodes) {
  for (let ci = 0; ci < nodes.length; ci++) {
    const closer = nodes[ci];
    if (closer.k !== 'delim' || !closer.canClose) continue;
    while (closer.n > 0) {
      // find nearest matching opener
      let oi = -1;
      for (let j = ci - 1; j >= 0; j--) {
        const cand = nodes[j];
        if (cand.k !== 'delim' || cand.ch !== closer.ch || !cand.canOpen || cand.n === 0) continue;
        // rule of three
        if (
          (closer.canOpen || cand.canClose) &&
          (cand.n + closer.n) % 3 === 0 &&
          !(cand.n % 3 === 0 && closer.n % 3 === 0)
        ) {
          continue;
        }
        oi = j;
        break;
      }
      if (oi < 0) break;
      const opener = nodes[oi];
      let use;
      let tag;
      if (closer.ch === '~') {
        use = opener.n >= 2 && closer.n >= 2 ? 2 : 1;
        tag = 'del';
      } else if (opener.n >= 2 && closer.n >= 2) {
        use = 2;
        tag = 'strong';
      } else {
        use = 1;
        tag = 'em';
      }
      opener.n -= use;
      closer.n -= use;
      const inner = nodes.splice(oi + 1, ci - oi - 1);
      const wrap = { k: 'wrap', tag, children: inner };
      let insertAt = oi + 1;
      if (opener.n === 0) {
        nodes.splice(oi, 1);
        insertAt = oi;
      }
      nodes.splice(insertAt, 0, wrap);
      ci = nodes.indexOf(closer);
      if (ci < 0) break;
    }
  }
  // Any delimiter that never matched renders literally — handled by
  // renderNode via the delim branch.
}

/* ------------------------------------------------------------------ */
/* block rendering                                                     */
/* ------------------------------------------------------------------ */

const BLOCK_TAGS = new Set(
  ('address article aside base basefont blockquote body caption center col ' +
    'colgroup dd details dialog dir div dl dt fieldset figcaption figure ' +
    'footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe ' +
    'legend li link main menu menuitem nav noframes ol optgroup option p ' +
    'param search section summary table tbody td tfoot th thead title tr ' +
    'track ul').split(' '),
);

// Classify an HTML block start on an indent-stripped line; 0 = none.
function htmlBlockType(rest) {
  if (!rest.startsWith('<')) return 0;
  if (/^<(script|pre|style|textarea)(?=[\s>]|$)/i.test(rest)) return 1;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (/^<![A-Z]/.test(rest)) return 4;
  if (rest.startsWith('<![CDATA[')) return 5;
  const m = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)(?=[\s>]|\/>|$)/.exec(rest);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return 6;
  if (rest.startsWith('</')) {
    const mc = /^<\/([a-zA-Z][a-zA-Z0-9-]*)[ \t]*>[ \t]*$/.exec(rest);
    return mc ? 7 : 0;
  }
  const m7 = /^<([a-zA-Z][a-zA-Z0-9-]*)(?:[ \t]+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t"'=<>\`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>[ \t]*$/.exec(rest);
  if (m7) return 7;
  return 0;
}

const FENCE_RE = /^(`{3,}|~{3,})(.*)$/;
const ATX_RE = /^(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/;
const HR_RE = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT_RE = /^(=+|-+)[ \t]*$/;

function matchListMarker(line) {
  const ind = indentInfo(line, 4);
  if (ind.cols >= 4) return null;
  const rest = line.slice(ind.pos);
  let ordered = false;
  let bullet = null;
  let delim = null;
  let start = null;
  let markerW = 0;
  let m = /^([-+*])(?=[ \t]|$)/.exec(rest);
  if (m) {
    bullet = m[1];
    markerW = 1;
  } else {
    m = /^(\d{1,9})([.)])(?=[ \t]|$)/.exec(rest);
    if (!m) return null;
    ordered = true;
    delim = m[2];
    start = parseInt(m[1], 10);
    markerW = m[1].length + 1;
  }
  const markerCols = ind.cols + markerW;
  const afterPos = ind.pos + markerW;
  // Scan the whitespace run after the marker using absolute tab stops.
  let abs = markerCols;
  let p = afterPos;
  while (p < line.length && (line[p] === ' ' || line[p] === '\t')) {
    abs += line[p] === ' ' ? 1 : 4 - (abs % 4);
    p += 1;
  }
  const width = abs - markerCols;
  const blank = p >= line.length;
  let contentCols;
  let contentStr;
  if (blank) {
    contentCols = markerCols + 1;
    contentStr = '';
  } else if (width >= 1 && width <= 4) {
    contentCols = abs;
    contentStr = line.slice(p);
  } else {
    // Five or more columns of space: the content indent is marker + 1 and
    // the leftover whitespace becomes content indentation.
    contentCols = markerCols + 1;
    let a = markerCols;
    let q = afterPos;
    if (q < line.length && (line[q] === ' ' || line[q] === '\t')) {
      a += line[q] === ' ' ? 1 : 4 - (a % 4);
      q += 1;
    }
    let aEnd = a;
    let r = q;
    while (r < line.length && (line[r] === ' ' || line[r] === '\t')) {
      aEnd += line[r] === ' ' ? 1 : 4 - (aEnd % 4);
      r += 1;
    }
    contentStr = ' '.repeat(Math.max(0, aEnd - contentCols)) + line.slice(r);
  }
  return {
    ordered, bullet, delim, start, markerCols, contentCols, contentStr,
    empty: blank, indentCols: ind.cols,
  };
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i += 2;
      continue;
    }
    if (ch === '`') {
      // a backtick run only shields pipes when it actually closes here
      let run = 0;
      let j = i;
      while (s[j] === '`') { run += 1; j += 1; }
      let closeAt = -1;
      for (let k = j; k < s.length; k++) {
        if (s[k] === '`') {
          let r2 = 0;
          let k2 = k;
          while (s[k2] === '`') { r2 += 1; k2 += 1; }
          if (r2 === run) { closeAt = k; break; }
          k = k2 - 1;
        }
      }
      if (closeAt < 0) {
        cur += '`'.repeat(run);
        i = j;
        continue;
      }
      cur += s.slice(i, closeAt).replace(/\\\|/g, '|');
      let r2 = 0;
      let e = closeAt;
      while (s[e] === '`') { r2 += 1; e += 1; }
      cur += '`'.repeat(r2);
      i = e;
      continue;
    }
    if (ch === '|') {
      cells.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function parseDelimRow(line) {
  const cells = splitRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const c of cells) {
    if (!/^:?-+:?$/.test(c)) return null;
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  return aligns;
}

// Does lines[j] begin a construct that may interrupt a paragraph?
function interruptsParagraph(lines, j, ctx) {
  const line = lines[j];
  const ind = indentInfo(line, 4);
  if (ind.cols >= 4) return false;
  const rest = line.slice(ind.pos);
  if (FENCE_RE.test(rest) && !(rest[0] === '`' && rest.slice(/^`+/.exec(rest)[0].length).includes('`'))) return true;
  if (ATX_RE.test(rest)) return true;
  if (HR_RE.test(rest)) return true;
  if (rest.startsWith('>')) return true;
  const t = htmlBlockType(rest);
  if (t >= 1 && t <= 6) return true;
  const lm = matchListMarker(line);
  if (lm && !lm.empty && (!lm.ordered || lm.start === 1)) return true;
  return false;
}

function renderBlocks(lines, ctx) {
  let html = '';
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i += 1; continue; }
    const ind = indentInfo(line, 4);
    const rest = ind.cols < 4 ? line.slice(ind.pos) : null;

    // link reference definitions (emit nothing)
    if (rest !== null && rest.startsWith('[')) {
      const def = tryParseDef(lines, i);
      if (def) {
        registerDef(ctx.refs, def);
        i += def.lines;
        continue;
      }
    }

    // fenced code
    if (rest !== null) {
      const fm = FENCE_RE.exec(rest);
      if (fm && !(fm[1][0] === '`' && fm[2].includes('`'))) {
        const fenceCh = fm[1][0];
        const fenceLen = fm[1].length;
        const info = fm[2].trim();
        const lang = info === '' ? '' : info.split(/\s+/)[0].replace(/\\([!-\/:-@\[-`{-~])/g, '$1');
        const content = [];
        i += 1;
        while (i < n) {
          const l2 = lines[i];
          const ind2 = indentInfo(l2, 4);
          const r2 = ind2.cols < 4 ? l2.slice(ind2.pos) : null;
          if (r2 !== null) {
            const cm = FENCE_RE.exec(r2);
            if (cm && cm[1][0] === fenceCh && cm[1].length >= fenceLen && /^[ \t]*$/.test(cm[2])) {
              i += 1;
              break;
            }
          }
          content.push(stripIndent(l2, ind.cols));
          i += 1;
        }
        // One trailing blank line of fence content is dropped.
        if (content.length && content[content.length - 1] === '') content.pop();
        const codeText = content.length ? content.join('\n') + '\n' : '';
        html += '<pre><code' +
          (lang ? ' class="language-' + escapeAttr(lang) + '"' : '') +
          '>' + escapeCode(codeText) + '</code></pre>\n';
        continue;
      }
    }

    // indented code block
    if (ind.cols >= 4) {
      const content = [];
      while (i < n) {
        const l2 = lines[i];
        if (isBlank(l2)) {
          // blank lines belong if more indented content follows
          let j = i;
          while (j < n && isBlank(lines[j])) j += 1;
          if (j < n && indentInfo(lines[j], 4).cols >= 4) {
            for (let k = i; k < j; k++) content.push(stripIndent(lines[k], 4));
            i = j;
            continue;
          }
          break;
        }
        if (indentInfo(l2, 4).cols < 4) break;
        content.push(stripIndent(l2, 4));
        i += 1;
      }
      while (content.length && /^[ \t]*$/.test(content[content.length - 1])) content.pop();
      html += '<pre><code>' + escapeCode(content.join('\n') + '\n') + '</code></pre>\n';
      continue;
    }

    // ATX heading
    const am = ATX_RE.exec(rest);
    if (am) {
      let content = am[2] || '';
      content = content.replace(/[ \t]+$/, '');
      if (/^#+$/.test(content)) content = '';
      else content = content.replace(/[ \t]#+$/, '').replace(/[ \t]+$/, '');
      html += '<h' + am[1].length + '>' +
        renderInline(content, { refs: ctx.refs }) +
        '</h' + am[1].length + '>\n';
      i += 1;
      continue;
    }

    // thematic break
    if (HR_RE.test(rest)) {
      html += '<hr>\n';
      i += 1;
      continue;
    }

    // blockquote
    if (rest.startsWith('>')) {
      const inner = [];
      while (i < n) {
        const l2 = lines[i];
        if (isBlank(l2)) break;
        const ind2 = indentInfo(l2, 4);
        const r2 = ind2.cols < 4 ? l2.slice(ind2.pos) : '';
        if (ind2.cols < 4 && r2.startsWith('>')) {
          inner.push(stripQuoteMarker(l2));
          i += 1;
          continue;
        }
        // lazy continuation: previous inner line is paragraph-ish text and
        // the line could actually continue a paragraph
        const lastInner = inner[inner.length - 1];
        if (
          lastInner !== undefined && !isBlank(lastInner) && inner.length > 0 &&
          indentInfo(lastInner, 4).cols < 4 &&
          !interruptsParagraph(lines, i, ctx)
        ) {
          inner.push(stripIndent(l2, Math.min(indentInfo(l2, 4).cols, 4)));
          i += 1;
          continue;
        }
        break;
      }
      html += '<blockquote>\n' + renderBlocks(inner, { refs: ctx.refs, tight: false, top: false }) + '</blockquote>\n';
      continue;
    }

    // list
    const lm = matchListMarker(line);
    if (lm) {
      const res = renderList(lines, i, ctx);
      html += res.html;
      i = res.next;
      continue;
    }

    // HTML block
    const ht = htmlBlockType(rest);
    if (ht >= 1) {
      const buf = [];
      let hitBlank = false;
      if (ht === 1) {
        const tag = /^<([a-zA-Z]+)/.exec(rest)[1].toLowerCase();
        const closeRe = new RegExp('</' + tag + '\\s*>', 'i');
        while (i < n) {
          buf.push(lines[i]);
          const done = closeRe.test(lines[i]);
          i += 1;
          if (done) break;
        }
      } else if (ht === 2) {
        while (i < n) { buf.push(lines[i]); const d = lines[i].includes('-->'); i += 1; if (d) break; }
      } else if (ht === 3) {
        while (i < n) { buf.push(lines[i]); const d = lines[i].includes('?>'); i += 1; if (d) break; }
      } else if (ht === 4) {
        while (i < n) { buf.push(lines[i]); const d = lines[i].includes('>'); i += 1; if (d) break; }
      } else if (ht === 5) {
        while (i < n) { buf.push(lines[i]); const d = lines[i].includes(']]>'); i += 1; if (d) break; }
      } else {
        while (i < n && !isBlank(lines[i])) { buf.push(lines[i]); i += 1; }
        hitBlank = i < n;
      }
      // Blocks closed by their own terminator keep the newline of their
      // last line, unless a blank line follows. Blank-line-closed blocks
      // only gain one at the very end of the top-level document.
      const nextBlank = i < n && isBlank(lines[i]);
      const addNl = ht <= 5
        ? !nextBlank && (i < n || ctx.eofNewline)
        : ctx.top && !hitBlank && i >= n && ctx.eofNewline;
      html += buf.join('\n') + (addNl ? '\n' : '');
      continue;
    }

    // table / setext / paragraph — paragraph lines keep their raw text
    const paraLines = [line];
    i += 1;
    let headingLevel = 0;
    let tableAligns = null;
    while (i < n) {
      const l2 = lines[i];
      if (isBlank(l2)) break;
      const ind2 = indentInfo(l2, 4);
      const r2 = ind2.cols < 4 ? l2.slice(ind2.pos) : null;
      if (r2 !== null) {
        const sm = SETEXT_RE.exec(r2);
        if (sm) {
          headingLevel = sm[1][0] === '=' ? 1 : 2;
          i += 1;
          break;
        }
        if (paraLines.length === 1) {
          const aligns = parseDelimRow(r2);
          if (aligns && paraLines[0].includes('|')) {
            const headerCells = splitRow(paraLines[0]);
            if (headerCells.length === aligns.length) {
              tableAligns = aligns;
              i += 1;
              break;
            }
          }
        }
      }
      if (interruptsParagraph(lines, i, ctx)) break;
      paraLines.push(l2);
      i += 1;
    }

    if (tableAligns) {
      const headerCells = splitRow(paraLines[0]);
      const rows = [];
      while (i < n) {
        const l2 = lines[i];
        if (isBlank(l2)) break;
        if (interruptsParagraph(lines, i, ctx)) break;
        rows.push(splitRow(l2));
        i += 1;
      }
      html += renderTable(headerCells, tableAligns, rows, ctx);
      continue;
    }

    const text = paraLines.join('\n');
    if (headingLevel) {
      const htext = paraLines
        .map((l) => stripIndent(l, Math.min(indentInfo(l, 4).cols, 3)).replace(/[ \t]+$/, ''))
        .join('\n');
      html += '<h' + headingLevel + '>' +
        renderInline(htext, { refs: ctx.refs }) +
        '</h' + headingLevel + '>\n';
    } else if (ctx.tight) {
      html += renderInline(text, { refs: ctx.refs });
    } else {
      html += '<p>' + renderInline(text, { refs: ctx.refs }) + '</p>\n';
    }
  }
  return html;
}

function renderTable(headerCells, aligns, rows, ctx) {
  const cellHtml = (tag, content, align) =>
    '<' + tag + (align ? ' align="' + align + '"' : '') + '>' +
    renderInline(content, { refs: ctx.refs }) + '</' + tag + '>\n';
  let html = '<table>\n<thead>\n<tr>\n';
  headerCells.forEach((c, k) => { html += cellHtml('th', c, aligns[k]); });
  html += '</tr>\n</thead>\n';
  if (rows.length) {
    html += '<tbody>';
    for (const row of rows) {
      html += '<tr>\n';
      for (let k = 0; k < headerCells.length; k++) {
        html += cellHtml('td', row[k] !== undefined ? row[k] : '', aligns[k]);
      }
      html += '</tr>\n';
    }
    html += '</tbody></table>\n';
  } else {
    html += '</table>\n';
  }
  return html;
}

const BLOCK_CLOSE_RE = /\/(?:ul|ol|blockquote|pre|table|p|h[1-6]|li)>$|<hr>$/;

// Decide whether one list item is internally loose: a blank line inside
// it separates two of its own blocks. Blank lines that merely sit inside
// a nested list item or blockquote do not count.
function itemLoose(itemLines) {
  const stack = []; // content indents of open nested containers
  let seenBlank = false;
  let seenContent = false;
  let fenceCh = null;
  let fenceLen = 0;
  for (const l of itemLines) {
    if (fenceCh !== null) {
      const ind = indentInfo(l, 4);
      const rest = ind.cols < 4 ? l.slice(ind.pos) : '';
      const cm = FENCE_RE.exec(rest);
      if (cm && cm[1][0] === fenceCh && cm[1].length >= fenceLen) fenceCh = null;
      continue;
    }
    if (isBlank(l)) {
      if (seenContent) seenBlank = true;
      continue;
    }
    seenContent = true;
    const ind = indentInfo(l, 4);
    const rest = ind.cols < 4 ? l.slice(ind.pos) : '';
    const fm = FENCE_RE.exec(rest);
    if (fm && !(fm[1][0] === '`' && fm[2].includes('`'))) {
      fenceCh = fm[1][0];
      fenceLen = fm[1].length;
    }
    if (seenBlank) {
      if (!(stack.length && ind.cols >= stack[stack.length - 1])) return true;
      seenBlank = false;
    }
    while (stack.length && ind.cols < stack[stack.length - 1]) stack.pop();
    const base = stack.length ? stack[stack.length - 1] : 0;
    const rel = stripIndent(l, base);
    const mk = matchListMarker(rel);
    if (mk) stack.push(base + mk.contentCols);
    else if (rel.startsWith('>')) stack.push(base + 2);
  }
  return false;
}

function isHrLine(line) {
  const ind = indentInfo(line, 4);
  if (ind.cols >= 4) return false;
  return HR_RE.test(line.slice(ind.pos));
}

function renderList(lines, start, ctx) {
  const first = matchListMarker(lines[start]);
  const ordered = first.ordered;
  const bullet = first.bullet;
  const delim = first.delim;
  const startNum = first.start;
  const items = [];
  let looseBetween = false;
  let i = start;

  const sameMarker = (mk) =>
    mk && mk.ordered === ordered &&
    (ordered ? mk.delim === delim : mk.bullet === bullet);
  // A sibling marker may wander at most three columns from the first
  // item's marker; anything deeper is content, not a new item.
  const siblingOk = (mk) => sameMarker(mk) && mk.indentCols <= first.indentCols + 3;

  while (i < lines.length) {
    if (items.length > 0 && isHrLine(lines[i])) break;
    const mk = matchListMarker(lines[i]);
    if (!siblingOk(mk)) break;
    const contentCols = mk.contentCols;
    const itemLines = [];
    // first line: content after the marker
    itemLines.push(mk.contentStr);
    i += 1;
    let itemBlankSeen = false;
    let endedByBlankRun = false;
    let stopAfterItem = false;
    // An item whose first line is empty ends at once if a blank line
    // follows and no further item of this list comes after the blank:
    // content after that blank belongs to a new block.
    if (mk.empty && i < lines.length && isBlank(lines[i])) {
      let j = i;
      while (j < lines.length && isBlank(lines[j])) j += 1;
      const nmk = j < lines.length && !isHrLine(lines[j]) ? matchListMarker(lines[j]) : null;
      if (!siblingOk(nmk)) {
        items.push(itemLines);
        break;
      }
    }
    while (i < lines.length) {
      const l2 = lines[i];
      if (isBlank(l2)) {
        // look ahead: what follows the blank run?
        let j = i;
        while (j < lines.length && isBlank(lines[j])) j += 1;
        const blanks = j - i;
        if (j >= lines.length) { i = j; endedByBlankRun = true; break; }
        const nextMk = isHrLine(lines[j]) ? null : matchListMarker(lines[j]);
        const nextInd = indentInfo(lines[j], 4);
        if (siblingOk(nextMk) && nextMk.indentCols < contentCols) {
          if (blanks >= 1) looseBetween = true;
          i = j;
          itemBlankSeen = true;
          break; // item ends, outer loop starts next item
        }
        if (nextInd.cols >= contentCols) {
          // blank line inside the item, more item content follows
          for (let k = 0; k < blanks; k++) itemLines.push('');
          itemBlankSeen = true;
          i = j;
          continue;
        }
        if (blanks >= 2) { i = j; endedByBlankRun = true; break; }
        // single blank then a non-indented non-marker line: list ends
        // unless the line is a lazy continuation — but a blank line kills
        // laziness, so the list is over.
        i = j;
        endedByBlankRun = true;
        break;
      }
      const ind2 = indentInfo(l2, 4);
      const mk2 = isHrLine(l2) ? null : matchListMarker(l2);
      if (siblingOk(mk2) && mk2.indentCols < contentCols && ind2.cols < contentCols) {
        break; // next item
      }
      if (ind2.cols >= contentCols) {
        itemLines.push(stripIndent(l2, contentCols));
        i += 1;
        continue;
      }
      // lazy continuation of the item's paragraph — but a line that could
      // start a list of its own (marker at a plausible position) ends the
      // item instead of joining its paragraph
      const lastItem = itemLines[itemLines.length - 1];
      const lazyMarker = matchListMarker(l2);
      if (
        lastItem !== undefined && !isBlank(lastItem) && !itemBlankSeen &&
        !interruptsParagraph(lines, i, ctx) &&
        !(lazyMarker && indentInfo(l2, 4).cols <= 3)
      ) {
        itemLines.push(stripIndent(l2, Math.min(indentInfo(l2, 4).cols, 4)));
        i += 1;
        continue;
      }
      break;
    }
    items.push(itemLines);
    if (endedByBlankRun) break;
    // continue while next line is another item marker
    if (i < lines.length) {
      if (isHrLine(lines[i])) break;
      const nmk = matchListMarker(lines[i]);
      if (!siblingOk(nmk)) break;
    }
  }

  const loose = looseBetween || items.some((it) => itemLoose(it));
  const tag = ordered ? 'ol' : 'ul';
  let html = '<' + tag + (ordered && startNum !== 1 ? ' start="' + startNum + '"' : '') + '>\n';
  for (const itemLines of items) {
    let checkbox = null;
    if (itemLines.length) {
      const cm = /^\[([ xX])\](?:[ \t]+|$)/.exec(itemLines[0]);
      if (cm) {
        checkbox = cm[1].toLowerCase() === 'x'
          ? '<input checked="" disabled="" type="checkbox">'
          : '<input disabled="" type="checkbox">';
        itemLines[0] = itemLines[0].slice(cm[0].length);
      }
    }
    let body = renderBlocks(itemLines, { refs: ctx.refs, tight: !loose, top: false });
    if (checkbox) {
      if (body.startsWith('<p>')) body = '<p>' + checkbox + ' ' + body.slice(3);
      else body = checkbox + ' ' + body;
    }
    let trimmed = body.endsWith('\n') ? body.slice(0, -1) : body;
    if (trimmed === '') {
      html += '<li></li>\n';
    } else if (BLOCK_CLOSE_RE.test(trimmed)) {
      html += '<li>' + trimmed + '\n</li>\n';
    } else {
      html += '<li>' + trimmed + '</li>\n';
    }
  }
  html += '</' + tag + '>\n';
  return { html, next: i };
}

/* ------------------------------------------------------------------ */
/* entry point                                                         */
/* ------------------------------------------------------------------ */

export function parse(markdown) {
  const src = String(markdown)
    .replace(/ /g, '�')
        .replace(/ /g, '�')
    .replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  // A trailing newline produces a phantom empty final line; drop it so it
  // cannot be mistaken for content, but remember that it was there.
  const eofNewline = lines.length > 0 && lines[lines.length - 1] === '';
  if (eofNewline) lines.pop();
  const refs = new Map();
  prescanDefs(lines, refs);
  return renderBlocks(lines, { refs, tight: false, top: true, eofNewline });
}
