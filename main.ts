// mend: one patch tool for every AI edit format.
//
// Applies an edit written as a unified diff, SEARCH/REPLACE blocks, a V4A
// patch, or JSON editor calls, to the tree in the working directory.
// The whole behaviour is SPEC.md. Node 22+, standard library only, run as
// `node main.ts [options] [PATCH]`.
//
// When MAKEFUN_ENV_URL is set, the trial runner takes over instead (see the
// last lines): it runs this file on each check the trial env hands out.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A patch the reader cannot read: `error: parse <line>`. */
class ParseFault {
  readonly line: number;
  constructor(line: number) {
    this.line = line;
  }
}

/** One edit that failed: `error: <code> <path>`. */
class EditFault {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` off each, and the empty
 * piece after a final `\n` dropped. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** A file as lines plus its own line break and whether it ends with one. */
interface Doc {
  lines: string[];
  br: string;
  eol: boolean;
}

function parseDoc(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', eol: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const eol = text.endsWith(br);
  if (eol) parts.pop();
  return { lines: parts, br, eol };
}

function renderDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.eol ? d.br : '');
}

function isCrlf(text: string): boolean {
  const nl = text.indexOf('\n');
  return nl > 0 && text[nl - 1] === '\r';
}

/**
 * The tree as the edits leave it. `get` reads the current text (null: no
 * file); `orig` the text before the patch; `set` stages a change. Nothing
 * touches the disk until the end, so the whole patch stays all-or-nothing.
 */
class Tree {
  private before = new Map<string, string | null>();
  private current = new Map<string, string | null>();

  private load(p: string): string | null {
    if (!this.before.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.before.set(p, v);
    }
    return this.before.get(p)!;
  }

  orig(p: string): string | null {
    return this.load(p);
  }

  get(p: string): string | null {
    return this.current.has(p) ? this.current.get(p)! : this.load(p);
  }

  set(p: string, v: string | null): void {
    this.current.set(p, v);
  }

  staged(): Array<[string, string | null]> {
    return [...this.current.entries()];
  }

  snapshot(): Map<string, string | null> {
    return new Map(this.current);
  }

  restore(s: Map<string, string | null>): void {
    this.current = new Map(s);
  }
}

type EditFn = (tree: Tree, moves: Array<[string, string]>) => void;

/* ------------------------------------------------------------------ */
/* Matching lines (SPEC section 5)                                     */
/* ------------------------------------------------------------------ */

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const stripEdgeWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const stripTrailWs = (s: string): string => s.replace(/[ \t]+$/, '');

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailWs(a) === stripTrailWs(b);
  return stripEdgeWs(a) === stripEdgeWs(b);
}

/** Every 0-based position where `pat` occurs in `lines` at this tier. */
function occurrences(lines: string[], pat: string[], tier: number): number[] {
  const out: number[] = [];
  if (pat.length === 0) return out;
  for (let i = 0; i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < pat.length; k++) {
      if (!lineEq(lines[i + k], pat[k], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which `pat` occurs at least once, with its positions. */
function findTier(lines: string[], pat: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, pat, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One replacement: old lines plus the new lines in order. A new line marked
 * `ctx` is a context line, written as the file's own matched line. */
interface Change {
  oldLines: string[];
  pieces: Array<{ ctx: boolean; oldIdx: number; text: string }>;
}

/**
 * The lines that replace a match at `pos`. Context lines come from the file;
 * at tier 2 every other new line is re-indented from the old lines' leading
 * whitespace to the file's.
 */
function buildNew(lines: string[], pos: number, ch: Change, tier: number): string[] {
  const out: string[] = [];
  const oldFirst = ch.oldLines.length > 0 ? ch.oldLines[0] : '';
  const fileFirst = ch.oldLines.length > 0 ? lines[pos] : '';
  const pfxOld = leadingWs(oldFirst);
  const pfxFile = leadingWs(fileFirst);
  for (const pc of ch.pieces) {
    if (pc.ctx) {
      out.push(lines[pos + pc.oldIdx]);
      continue;
    }
    let s = pc.text;
    if (tier === 2 && s !== '' && s.trim() !== '' && s.startsWith(pfxOld)) {
      s = pfxFile + s.slice(pfxOld.length);
    }
    out.push(s);
  }
  return out;
}

/**
 * Read a hunk/chunk body into its change. A body line is ` ` (context),
 * `-` (old), `+` (new), `\` (a marker for the line before it) or empty
 * (a context line whose text is empty). Returns whether a `\` line follows
 * the body's last context or `+` line, for the no-final-break rule.
 */
function readBody(body: string[]): { ch: Change; noNl: boolean } {
  const oldLines: string[] = [];
  const pieces: Change['pieces'] = [];
  let lastNew = -1;
  for (let i = 0; i < body.length; i++) {
    const l = body[i];
    if (l === '' || l[0] === ' ' || l[0] === '+') lastNew = i;
  }
  for (const l of body) {
    if (l === '') {
      const oi = oldLines.length;
      oldLines.push('');
      pieces.push({ ctx: true, oldIdx: oi, text: '' });
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      const oi = oldLines.length;
      oldLines.push(t);
      pieces.push({ ctx: true, oldIdx: oi, text: t });
    } else if (l[0] === '-') {
      oldLines.push(l.slice(1));
    } else if (l[0] === '+') {
      pieces.push({ ctx: false, oldIdx: -1, text: l.slice(1) });
    }
    // `\` lines are markers only; they carry no text of their own.
  }
  const noNl =
    lastNew >= 0 && body[lastNew + 1] !== undefined && body[lastNew + 1][0] === '\\';
  return { ch: { oldLines, pieces }, noNl };
}

/* ------------------------------------------------------------------ */
/* Format detection (SPEC section 4)                                   */
/* ------------------------------------------------------------------ */

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC section 6)                                      */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  body: string[];
}

interface UniSection {
  /** 1-based line number where the section starts, for parse faults. */
  startLine: number;
  dashOld: string | null;
  dashNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  hasDash: boolean;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** The path on a `--- `/`+++ ` line: after the four characters, to the first
 * tab, surrounding spaces off, one leading `a/` or `b/` off. */
function dashPath(line: string): string {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t.startsWith('a/')) return t.slice(2);
  if (t.startsWith('b/')) return t.slice(2);
  return t;
}

function parseUnified(lines: string[], strict: boolean): EditFn[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  const openSection = (dOld: string | null, dNew: string | null, startIdx: number): UniSection => {
    const s: UniSection = {
      startLine: startIdx + 1,
      dashOld: null,
      dashNew: null,
      renameFrom: null,
      renameTo: null,
      diffOld: dOld,
      diffNew: dNew,
      hasDash: false,
      newFile: false,
      delFile: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };

  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line.startsWith('diff --git')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      openSection(m[1], m[2], i);
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const paired = (lines[i + 1] ?? '').startsWith('+++ ');
      if (inHeader && cur !== null && !cur.hasDash) {
        if (!paired) throw new ParseFault(i + 2);
        cur.dashOld = dashPath(line);
        cur.dashNew = dashPath(lines[i + 1]);
        cur.hasDash = true;
        i += 2;
        continue;
      }
      if (paired) {
        const s = openSection(null, null, i);
        s.dashOld = dashPath(line);
        s.dashNew = dashPath(lines[i + 1]);
        s.hasDash = true;
        i += 2;
        continue;
      }
      if (inHeader) throw new ParseFault(i + 2);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new ParseFault(i + 1);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      inHeader = false;
      const body: string[] = [];
      let j = i + 1;
      while (j < n) {
        const l = lines[j];
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
          body.push(l);
          j++;
        } else {
          break;
        }
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      i = j;
      continue;
    }
    if (inHeader && cur !== null) {
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        cur.newFile = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.delFile = true;
      }
      // `index`, `old mode`, `new mode`, `similarity index`,
      // `dissimilarity index`, `Index:` and any other line: ignored.
      i++;
      continue;
    }
    i++;
  }
  // A section always names both paths (from `diff --git`, a `---`/`+++`
  // pair, or `rename from`/`rename to`). If one is somehow missing, that
  // is a fault in the patch, reported at the section's first line rather
  // than a crash when the edit runs.
  for (const s of sections) {
    if (
      (s.dashOld ?? s.renameFrom ?? s.diffOld) === null ||
      (s.dashNew ?? s.renameTo ?? s.diffNew) === null
    ) {
      throw new ParseFault(s.startLine);
    }
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Apply a section's hunks in order to a document. */
function applyHunks(doc: Doc, hunks: Hunk[], strict: boolean, path: string): Doc {
  let cur = doc;
  let d = 0;
  for (const h of hunks) {
    const { ch, noNl } = readBody(h.body);
    const lines = cur.lines.slice();
    if (ch.oldLines.length === 0) {
      let at = h.a + d;
      if (at < 0) at = 0;
      if (at > lines.length) at = lines.length;
      const atEnd = at === lines.length;
      const ins = ch.pieces.map((p) => p.text);
      lines.splice(at, 0, ...ins);
      cur = { lines, br: cur.br, eol: atEnd ? !noNl : cur.eol };
    } else {
      const found = findTier(lines, ch.oldLines, strict);
      if (found === null) throw new EditFault('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const runsToEnd = best + ch.oldLines.length === lines.length;
      const rep = buildNew(lines, best, ch, found.tier);
      lines.splice(best, ch.oldLines.length, ...rep);
      cur = { lines, br: cur.br, eol: runsToEnd ? !noNl : cur.eol };
    }
    d += ch.pieces.length - ch.oldLines.length;
  }
  return cur;
}

/** The file a creation section makes: the `+` lines of all its hunks. */
function creationText(hunks: Hunk[]): string {
  const plus: string[] = [];
  let lastPlusHunk: Hunk | null = null;
  let lastPlusIdx = -1;
  for (const h of hunks) {
    for (let k = 0; k < h.body.length; k++) {
      const l = h.body[k];
      if (l[0] === '+') {
        plus.push(l.slice(1));
        lastPlusHunk = h;
        lastPlusIdx = k;
      }
    }
  }
  if (plus.length === 0) return '';
  const noNl =
    lastPlusHunk !== null &&
    lastPlusHunk.body[lastPlusIdx + 1] !== undefined &&
    lastPlusHunk.body[lastPlusIdx + 1][0] === '\\';
  return plus.join('\n') + (noNl ? '' : '\n');
}

function unifiedEdit(s: UniSection, strict: boolean): EditFn {
  const oldPath = (s.dashOld ?? s.renameFrom ?? s.diffOld) as string;
  const newPath = (s.dashNew ?? s.renameTo ?? s.diffNew) as string;
  return (tree, moves) => {
    const isCreate = oldPath === '/dev/null' || s.newFile;
    const isDelete = !isCreate && (newPath === '/dev/null' || s.delFile);
    if (isCreate) {
      if (!isSafePath(newPath)) throw new EditFault('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new EditFault('exists', newPath);
      tree.set(newPath, creationText(s.hunks));
      return;
    }
    if (isDelete) {
      if (!isSafePath(oldPath)) throw new EditFault('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new EditFault('missing', oldPath);
      tree.set(oldPath, null);
      return;
    }
    if (oldPath !== newPath) {
      if (!isSafePath(oldPath)) throw new EditFault('unsafe', oldPath);
      if (!isSafePath(newPath)) throw new EditFault('unsafe', newPath);
      const cur = tree.get(oldPath);
      if (cur === null) throw new EditFault('missing', oldPath);
      if (tree.get(newPath) !== null) throw new EditFault('exists', newPath);
      const doc = applyHunks(parseDoc(cur), s.hunks, strict, oldPath);
      tree.set(oldPath, null);
      tree.set(newPath, renderDoc(doc));
      moves.push([oldPath, newPath]);
      return;
    }
    if (!isSafePath(oldPath)) throw new EditFault('unsafe', oldPath);
    const cur = tree.get(oldPath);
    if (cur === null) throw new EditFault('missing', oldPath);
    const doc = applyHunks(parseDoc(cur), s.hunks, strict, oldPath);
    tree.set(oldPath, renderDoc(doc));
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC section 7)                              */
/* ------------------------------------------------------------------ */

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): EditFn[] {
  const blocks: SrBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseFault(i + 1);
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j].trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new ParseFault(i + 1);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new ParseFault(i + 1);
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return blocks.map((b) => searchReplaceEdit(b, strict));
}

function searchReplaceEdit(b: SrBlock, strict: boolean): EditFn {
  return (tree) => {
    if (!isSafePath(b.path)) throw new EditFault('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new EditFault('exists', b.path);
      tree.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new EditFault('missing', b.path);
    const doc = parseDoc(cur);
    const found = findTier(doc.lines, b.oldLines, strict);
    if (found === null) throw new EditFault('no-match', b.path);
    if (found.occ.length > 1) throw new EditFault('ambiguous', b.path);
    const pos = found.occ[0];
    const ch: Change = {
      oldLines: b.oldLines,
      pieces: b.newLines.map((t) => ({ ctx: false, oldIdx: -1, text: t })),
    };
    const rep = buildNew(doc.lines, pos, ch, found.tier);
    const lines = doc.lines.slice();
    lines.splice(pos, b.oldLines.length, ...rep);
    tree.set(b.path, renderDoc({ lines, br: doc.br, eol: doc.eol }));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC section 8)                                        */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

/**
 * A section's content lines: from `start` to the next section start or to
 * `last` (the `*** End Patch` line), with blank lines at the end dropped.
 * Returns the lines and the index the next section starts at (or `last`).
 */
function sectionContent(lines: string[], start: number, last: number): [string[], number] {
  let end = last;
  for (let k = start; k < last; k++) {
    const l = lines[k];
    if (
      l.startsWith('*** Add File: ') ||
      l.startsWith('*** Delete File: ') ||
      l.startsWith('*** Update File: ')
    ) {
      end = k;
      break;
    }
  }
  const content = lines.slice(start, end);
  while (content.length > 0 && isBlank(content[content.length - 1])) content.pop();
  return [content, end];
}

function parseV4a(lines: string[], strict: boolean): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k])) {
      last = k;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);
  const edits: EditFn[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const [content, next] = sectionContent(lines, i + 1, last);
      const base = i + 1;
      const addLines: string[] = [];
      for (let k = 0; k < content.length; k++) {
        const l = content[k];
        if (l.startsWith('+')) addLines.push(l.slice(1));
        else if (l === '') addLines.push('');
        else throw new ParseFault(base + k + 1);
      }
      edits.push((tree) => {
        if (!isSafePath(path)) throw new EditFault('unsafe', path);
        if (tree.get(path) !== null) throw new EditFault('exists', path);
        tree.set(path, addLines.length === 0 ? '' : addLines.join('\n') + '\n');
      });
      i = next;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      const [content, next] = sectionContent(lines, i + 1, last);
      if (content.length > 0) throw new ParseFault(i + 2);
      edits.push((tree) => {
        if (!isSafePath(path)) throw new EditFault('unsafe', path);
        if (tree.get(path) === null) throw new EditFault('missing', path);
        tree.set(path, null);
      });
      i = next;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const [content, next] = sectionContent(lines, i + 1, last);
      edits.push(v4aUpdateEdit(path, content, i + 1, strict));
      i = next;
      continue;
    }
    throw new ParseFault(i + 1);
  }
  return edits;
}

/** Parse an Update File section's content into a move target and chunks. */
function v4aUpdateEdit(path: string, content: string[], base: number, strict: boolean): EditFn {
  let moveTo: string | null = null;
  let j = 0;
  if (j < content.length && content[j].startsWith('*** Move to: ')) {
    moveTo = content[j].slice('*** Move to: '.length).trim();
    j++;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let closed = false;
  for (; j < content.length; j++) {
    const l = content[j];
    const ln = base + j + 1;
    if (l.startsWith('@@')) {
      cur = { anchor: l.slice(2).trim(), body: [], eof: false };
      chunks.push(cur);
      closed = false;
    } else if (l.trimEnd() === '*** End of File') {
      if (cur === null) throw new ParseFault(ln);
      cur.eof = true;
      closed = true;
    } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        cur = { anchor: null, body: [], eof: false };
        chunks.push(cur);
        closed = false;
      } else if (closed) {
        throw new ParseFault(ln);
      }
      cur.body.push(l);
    } else {
      throw new ParseFault(ln);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new ParseFault(base);
  return (tree, moves) => {
    if (!isSafePath(path)) throw new EditFault('unsafe', path);
    if (moveTo !== null && !isSafePath(moveTo)) throw new EditFault('unsafe', moveTo);
    const curText = tree.get(path);
    if (curText === null) throw new EditFault('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFault('exists', moveTo);
    const doc = parseDoc(curText);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const at = findAnchor(doc.lines, ch.anchor, cursor, strict);
        if (at === null) throw new EditFault('no-match', path);
        cursor = at + 1;
      }
      const { ch: change } = readBody(ch.body);
      if (change.oldLines.length === 0) {
        const at = ch.eof ? doc.lines.length : cursor;
        const ins = change.pieces.map((p) => p.text);
        doc.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
      } else {
        const found = findFrom(doc.lines, change.oldLines, cursor, strict, ch.eof);
        if (found === null) throw new EditFault('no-match', path);
        const rep = buildNew(doc.lines, found.pos, change, found.tier);
        doc.lines.splice(found.pos, change.oldLines.length, ...rep);
        cursor = found.pos + rep.length;
      }
    }
    const out = renderDoc(doc);
    if (moveTo !== null) {
      tree.set(path, null);
      tree.set(moveTo, out);
      moves.push([path, moveTo]);
    } else {
      tree.set(path, out);
    }
  };
}

/** First line at or after `from` equal to `anchor` at the first tier with one. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i], anchor, t)) return i;
    }
  }
  return null;
}

/**
 * First occurrence of `pat` at or after `from` at the first tier with one;
 * an end-of-file chunk only takes an occurrence ending at the last line.
 */
function findFrom(
  lines: string[],
  pat: string[],
  from: number,
  strict: boolean,
  eofOnly: boolean,
): { pos: number; tier: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, pat, t).filter(
      (p) => p >= from && (!eofOnly || p + pat.length === lines.length),
    );
    if (occ.length > 0) return { pos: occ[0], tier: t };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC section 9)                                         */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when the value is not one. */
function jsonEditValue(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      if (tree.get(p) !== null) throw new EditFault('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldS = o.old_str;
    const newS = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFault('missing', p);
      const crlf = isCrlf(before);
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = norm(before);
      const oldN = norm(oldS);
      let count = 0;
      for (let k = text.indexOf(oldN); k >= 0; k = text.indexOf(oldN, k + 1)) count++;
      if (count === 0) throw new EditFault('no-match', p);
      if (count > 1) throw new EditFault('ambiguous', p);
      const at = text.indexOf(oldN);
      const out = text.slice(0, at) + norm(newS) + text.slice(at + oldN.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const lineNo = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      if (!isSafePath(p)) throw new EditFault('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFault('missing', p);
      const doc = parseDoc(before);
      if (lineNo < 0 || lineNo > doc.lines.length) throw new EditFault('no-match', p);
      doc.lines.splice(lineNo, 0, ...add);
      tree.set(p, renderDoc(doc));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  const edits: EditFn[] = [];
  if (lines[first].trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseFault(first + 1);
    for (const x of v) {
      const e = jsonEditValue(x);
      if (e === null) throw new ParseFault(first + 1);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonEditValue(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFault(i + 1);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Running the patch (SPEC sections 1, 2, 10)                          */
/* ------------------------------------------------------------------ */

function parsePatch(kind: string, text: string, lines: string[], strict: boolean): EditFn[] {
  if (kind === 'json') return parseJson(text, lines);
  if (kind === 'unified') return parseUnified(lines, strict);
  if (kind === 'search-replace') return parseSearchReplace(lines, strict);
  return parseV4a(lines, strict);
}

function usageResult(): { code: number; out: string[] } {
  return { code: 2, out: ['error: usage'] };
}

/** The output rows for a finished patch: one line per changed path. */
function outputRows(tree: Tree, moves: Array<[string, string]>): string[] {
  const changed = new Map<string, string | null>();
  for (const [p, v] of tree.staged()) {
    if (tree.orig(p) !== v) changed.set(p, v);
  }
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  const rows: Array<{ key: string; text: string }> = [];
  for (const [o, n] of moves) {
    if (tree.orig(o) !== null && tree.get(o) === null && tree.orig(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      usedOld.add(o);
      usedNew.add(n);
    }
  }
  for (const [p, v] of changed) {
    if (usedOld.has(p) || usedNew.has(p)) continue;
    const was = tree.orig(p);
    rows.push({ key: p, text: `${was === null ? 'A' : v === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return rows.map((r) => r.text);
}

/** Write every staged change to disk: deletions first, then writes. */
function writeChanges(tree: Tree): void {
  const staged = tree.staged();
  for (const [p, v] of staged) {
    if (v === null && tree.orig(p) !== null) rmSync(p, { force: true });
  }
  for (const [p, v] of staged) {
    if (v === null) continue;
    if (tree.orig(p) === v) continue;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, v);
  }
}

function runCli(argv: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return usageResult();
        const v = a.slice('--format='.length);
        if (!FORMAT_NAMES.includes(v)) return usageResult();
        format = v;
      } else if (a === '--check') {
        if (check) return usageResult();
        check = true;
      } else if (a === '--strict') {
        if (strict) return usageResult();
        strict = true;
      } else {
        return usageResult();
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return usageResult();
  const patchArg = pos.length === 0 ? null : pos[0];
  let text = '';
  if (patchArg === null || patchArg === '-') {
    try {
      text = readFileSync(0, 'utf8');
    } catch {
      text = '';
    }
  } else {
    try {
      text = readFileSync(patchArg, 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    edits = parsePatch(kind, text, lines, strict);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  if (edits.length === 0) return { code: 2, out: ['error: parse 1'] };
  const tree = new Tree();
  const moves: Array<[string, string]> = [];
  const fails: EditFault[] = [];
  for (const edit of edits) {
    const snap = tree.snapshot();
    const mlen = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.restore(snap);
      moves.length = mlen;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }
  const rows = outputRows(tree, moves);
  if (!check) writeChanges(tree);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this
  // file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = runCli(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
