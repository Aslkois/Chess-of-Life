import { Chess } from 'chess.js';
import { addMove, createTree, preferredChild, START_FEN, type GameTree, type MoveSource } from './tree';

export interface ParsedGame {
  headers: Record<string, string>;
  tree: GameTree;
  /** SAN of the historical mainline */
  moves: string[];
  startFen: string;
  result: string;
  /** Problems that prevented the full game from being read. */
  errors: string[];
  /** Non-fatal issues (missing result, unknown tokens...). */
  warnings: string[];
  /** True when the movetext parsed completely and ended in a result token. */
  complete: boolean;
}

const NAG_SYMBOLS: Record<string, number> = { '!': 1, '?': 2, '!!': 3, '??': 4, '!?': 5, '?!': 6 };
export const NAG_TEXT: Record<number, string> = { 1: '!', 2: '?', 3: '!!', 4: '??', 5: '!?', 6: '?!' };

type Token =
  | { t: 'header'; key: string; value: string }
  | { t: 'comment'; text: string }
  | { t: 'open' }
  | { t: 'close' }
  | { t: 'nag'; n: number }
  | { t: 'result'; value: string }
  | { t: 'san'; text: string; line: number };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '\n') { line++; i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '%' && (i === 0 || text[i - 1] === '\n')) { // escape line
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '[') {
      const end = text.indexOf(']', i);
      const raw = end === -1 ? text.slice(i + 1) : text.slice(i + 1, end);
      const m = raw.match(/^\s*([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\s*$/);
      if (m) tokens.push({ t: 'header', key: m[1], value: m[2].replace(/\\(["\\])/g, '$1') });
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (ch === '{') {
      const end = text.indexOf('}', i);
      const body = end === -1 ? text.slice(i + 1) : text.slice(i + 1, end);
      line += (body.match(/\n/g) ?? []).length;
      tokens.push({ t: 'comment', text: body.trim() });
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (ch === ';') {
      const end = text.indexOf('\n', i);
      tokens.push({ t: 'comment', text: text.slice(i + 1, end === -1 ? n : end).trim() });
      i = end === -1 ? n : end;
      continue;
    }
    if (ch === '(') { tokens.push({ t: 'open' }); i++; continue; }
    if (ch === ')') { tokens.push({ t: 'close' }); i++; continue; }
    if (ch === '$') {
      let j = i + 1;
      while (j < n && /\d/.test(text[j])) j++;
      tokens.push({ t: 'nag', n: parseInt(text.slice(i + 1, j), 10) });
      i = j;
      continue;
    }
    // generic word
    let j = i;
    while (j < n && !/[\s{}()\[\];$]/.test(text[j])) j++;
    let word = text.slice(i, j);
    i = j;
    if (/^(1-0|0-1|1\/2-1\/2|½-½|\*)$/.test(word)) {
      tokens.push({ t: 'result', value: word === '½-½' ? '1/2-1/2' : word });
      continue;
    }
    // strip move numbers like "12." "12..." "12...e5"
    if (/^\d+$/.test(word)) continue; // bare move number
    const num = word.match(/^\d+\.+(.*)$/);
    if (num) {
      word = num[1];
      if (!word) continue;
    }
    if (/^\.+$/.test(word)) continue;
    // suffix annotations
    const suf = word.match(/^(.*?)(!!|\?\?|!\?|\?!|!|\?)$/);
    if (suf && suf[1]) {
      tokens.push({ t: 'san', text: suf[1], line });
      tokens.push({ t: 'nag', n: NAG_SYMBOLS[suf[2]] });
      continue;
    }
    tokens.push({ t: 'san', text: word, line });
  }
  return tokens;
}

function normalizeSan(san: string): string {
  return san.replace(/0-0-0/g, 'O-O-O').replace(/0-0/g, 'O-O').replace(/[\u2013\u2014]/g, '-').replace(/e\.p\.$/, '');
}

function parseClock(comment: string): number | undefined {
  const m = comment.match(/\[%clk\s+(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)\]/);
  if (!m) return undefined;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
}

function stripCommands(comment: string): string {
  return comment.replace(/\[%[^\]]*\]/g, '').trim();
}

/** Split a token stream into games. */
function splitGames(tokens: Token[]): Token[][] {
  const games: Token[][] = [];
  let cur: Token[] = [];
  let inMoves = false;
  let depth = 0;
  for (const tok of tokens) {
    if (tok.t === 'header' && inMoves) {
      games.push(cur);
      cur = [];
      inMoves = false;
      depth = 0;
    }
    cur.push(tok);
    if (tok.t === 'open') depth++;
    if (tok.t === 'close') depth = Math.max(0, depth - 1);
    if (tok.t === 'san' || tok.t === 'open') inMoves = true;
    if (tok.t === 'result' && depth === 0) {
      games.push(cur);
      cur = [];
      inMoves = false;
    }
  }
  if (cur.some((t) => t.t !== 'comment')) games.push(cur);
  return games;
}

function parseGame(tokens: Token[], gameNo: number): ParsedGame {
  const headers: Record<string, string> = {};
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const t of tokens) if (t.t === 'header') headers[t.key] = t.value;

  let startFen = START_FEN;
  if (headers.FEN) {
    try {
      new Chess(headers.FEN);
      startFen = headers.FEN;
    } catch (e) {
      errors.push(`Game ${gameNo}: invalid FEN header "${headers.FEN}".`);
      return { headers, tree: createTree(), moves: [], startFen: START_FEN, result: '*', errors, warnings, complete: false };
    }
  }
  let tree = createTree(startFen);
  let cur = tree.rootId; // node after last move in current line
  let lastMove: string | null = null; // last move node in current line
  const stack: { cur: string; lastMove: string | null; skip: boolean }[] = [];
  let depth = 0;
  let result = '*';
  let sawResult = false;
  let fatal = false;
  let skipping = false; // inside a broken variation
  const pendingComment: string[] = [];

  for (const tok of tokens) {
    if (fatal) break;
    if (tok.t === 'header') continue;
    if (tok.t === 'comment') {
      if (skipping) continue;
      const target = lastMove ?? null;
      if (target) {
        const node = tree.nodes[target];
        const clk = parseClock(tok.text);
        const text = stripCommands(tok.text);
        tree.nodes[target] = {
          ...node,
          comment: text ? (node.comment ? `${node.comment} ${text}` : text) : node.comment,
          clock: clk ?? node.clock,
        };
      } else {
        const text = stripCommands(tok.text);
        if (text) pendingComment.push(text);
      }
      continue;
    }
    if (tok.t === 'nag') {
      if (skipping || !lastMove) continue;
      const node = tree.nodes[lastMove];
      tree.nodes[lastMove] = { ...node, nags: [...(node.nags ?? []), tok.n] };
      continue;
    }
    if (tok.t === 'open') {
      stack.push({ cur, lastMove, skip: skipping });
      depth++;
      if (!lastMove) {
        warnings.push(`Game ${gameNo}: variation before any move was ignored.`);
        skipping = true;
        continue;
      }
      cur = tree.nodes[lastMove].parentId!;
      lastMove = null;
      continue;
    }
    if (tok.t === 'close') {
      const s = stack.pop();
      if (!s) { warnings.push(`Game ${gameNo}: unmatched ")" ignored.`); continue; }
      depth--;
      cur = s.cur;
      lastMove = s.lastMove;
      skipping = s.skip;
      continue;
    }
    if (tok.t === 'result') {
      if (depth === 0) { result = tok.value; sawResult = true; }
      continue;
    }
    if (tok.t === 'san') {
      if (skipping) continue;
      const source: MoveSource = depth === 0 ? 'historical' : 'imported';
      try {
        const r = addMove(tree, cur, normalizeSan(tok.text), source);
        tree = r.tree;
        if (pendingComment.length && depth === 0 && !r.existed) {
          // comment before the first move – attach to it
          tree.nodes[r.nodeId] = { ...tree.nodes[r.nodeId], comment: pendingComment.join(' ') };
          pendingComment.length = 0;
        }
        cur = r.nodeId;
        lastMove = r.nodeId;
      } catch {
        const moveNo = Math.floor(tree.nodes[cur].ply / 2) + 1;
        const side = tree.nodes[cur].ply % 2 === 0 ? 'White' : 'Black';
        if (depth === 0) {
          errors.push(`Game ${gameNo}: illegal or unreadable move "${tok.text}" at move ${moveNo} (${side} to move, line ${tok.line}). The game was read up to that point.`);
          fatal = true;
        } else {
          warnings.push(`Game ${gameNo}: illegal move "${tok.text}" inside a variation at move ${moveNo}; that variation was skipped.`);
          skipping = true;
        }
      }
    }
  }
  if (depth > 0 && !fatal) warnings.push(`Game ${gameNo}: unclosed variation.`);
  if (!sawResult && !fatal) warnings.push(`Game ${gameNo}: movetext has no result token – the game may be incomplete.`);
  if (headers.Result && sawResult && headers.Result !== result) warnings.push(`Game ${gameNo}: Result header (${headers.Result}) does not match movetext result (${result}).`);
  if (!sawResult && headers.Result) result = headers.Result;

  // historical moves
  const moves: string[] = [];
  let node = tree.nodes[tree.rootId];
  for (;;) {
    const next = node.children.find((c) => tree.nodes[c].source === 'historical');
    if (!next) break;
    node = tree.nodes[next];
    moves.push(node.san!);
  }
  if (moves.length === 0 && !fatal) warnings.push(`Game ${gameNo}: no moves found.`);
  return { headers, tree, moves, startFen, result, errors, warnings, complete: !fatal && sawResult && result !== '*' };
}

export interface PgnImportResult {
  games: ParsedGame[];
  /** Errors not attributable to a single game (e.g. no games at all). */
  errors: string[];
}

export function parsePgn(text: string): PgnImportResult {
  const cleaned = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!cleaned.trim()) return { games: [], errors: ['The PGN is empty.'] };
  const tokens = tokenize(cleaned);
  const chunks = splitGames(tokens);
  const games = chunks.map((c, i) => parseGame(c, i + 1)).filter((g) => g.moves.length > 0 || Object.keys(g.headers).length > 0 || g.errors.length > 0);
  if (!games.length) return { games: [], errors: ['No games were found in the PGN text.'] };
  return { games, errors: [] };
}

// ---------------- export ----------------

function escapeComment(s: string) {
  return s.replace(/}/g, ')');
}

function fmtClock(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export interface ExportOptions {
  variations?: boolean;
  comments?: boolean;
  /** extra per-node comment provider (e.g. classification + eval) */
  annotate?: (nodeId: string) => string | undefined;
  /** extra per-node NAGs (e.g. derived from classification) */
  nags?: (nodeId: string) => number[] | undefined;
}

const SEVEN_TAGS = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'];

export function exportPgn(headers: Record<string, string>, tree: GameTree, result: string, opts: ExportOptions = {}): string {
  const { variations = true, comments = true } = opts;
  const h: Record<string, string> = {
    Event: '?', Site: '?', Date: '????.??.??', Round: '?', White: '?', Black: '?', ...headers, Result: result,
  };
  const root = tree.nodes[tree.rootId];
  if (root.fen !== START_FEN) { h.SetUp = '1'; h.FEN = root.fen; }
  const lines: string[] = [];
  for (const k of SEVEN_TAGS) lines.push(`[${k} "${h[k].replace(/(["\\])/g, '\\$1')}"]`);
  for (const [k, v] of Object.entries(h)) if (!SEVEN_TAGS.includes(k)) lines.push(`[${k} "${String(v).replace(/(["\\])/g, '\\$1')}"]`);

  const out: string[] = [];
  const moveText = (nodeId: string, forceNumber: boolean) => {
    const n = tree.nodes[nodeId];
    const white = n.ply % 2 === 1;
    const num = Math.ceil(n.ply / 2);
    let s = '';
    if (white) s += `${num}. `;
    else if (forceNumber) s += `${num}... `;
    s += n.san;
    const nags = [...(n.nags ?? []), ...(opts.nags?.(nodeId) ?? [])];
    const uniq = [...new Set(nags)];
    for (const g of uniq) s += ` $${g}`;
    const parts: string[] = [];
    if (comments) {
      if (n.branchName) parts.push(`Branch: ${n.branchName}`);
      if (n.branchNote) parts.push(n.branchNote);
      if (n.source === 'engine') parts.push('[engine continuation]');
      if (n.source === 'user' && n.parentId && tree.nodes[n.parentId].source !== 'user' && tree.nodes[n.parentId].source !== 'engine') parts.push('[explored alternative]');
      if (n.comment) parts.push(n.comment);
      const a = opts.annotate?.(nodeId);
      if (a) parts.push(a);
    }
    if (n.clock !== undefined) parts.push(`[%clk ${fmtClock(n.clock)}]`);
    if (parts.length) s += ` {${escapeComment(parts.join(' '))}}`;
    return { s, hadComment: parts.length > 0 };
  };

  const writeFrom = (parentId: string, forceNumber: boolean) => {
    let curParent = parentId;
    let force = forceNumber;
    for (;;) {
      const parent = tree.nodes[curParent];
      if (!parent.children.length) return;
      const main = preferredChild(tree, curParent)!;
      const alts = variations ? parent.children.filter((c) => c !== main) : [];
      const m = moveText(main, force);
      out.push(m.s);
      for (const alt of alts) {
        out.push('(');
        const a = moveText(alt, true);
        out.push(a.s);
        writeFrom(alt, a.hadComment);
        out.push(')');
      }
      force = alts.length > 0 || m.hadComment;
      curParent = main;
    }
  };
  writeFrom(tree.rootId, true);
  out.push(result);
  // join, fixing "( " and " )"
  const body = out.join(' ').replace(/\( /g, '(').replace(/ \)/g, ')');
  // wrap at ~80 chars
  const wrapped: string[] = [];
  let line = '';
  for (const word of body.split(' ')) {
    if ((line + ' ' + word).trim().length > 79) { wrapped.push(line.trim()); line = word; } else line += ' ' + word;
  }
  if (line.trim()) wrapped.push(line.trim());
  return `${lines.join('\n')}\n\n${wrapped.join('\n')}\n`;
}
