import { Chess } from 'chess.js';
import {
  attackersOf, attacks, castlingRights, doubledFiles, hangingPieces, isolatedPawns, kingSquare, kingZone, looksCastled, NAME, openFiles,
  other, parseBoard, passedPawns, sqIdx, sqName, VALUE, type Board, type Color, type PieceType,
} from './board';
import { analyzeMove, currentThreats, type Motif, type MoveFacts } from './motifs';
import { formatLine, materialAlongLine, pvToSan } from './explain';
import { CLASS_INFO, type Classification } from './classify';
import { formatScore, isMateScore, povCp, winLabel, winPercentPov, type Score } from '../engine/score';

/**
 * Game Review explanations, produced only when the user asks for one.
 *
 * Every statement is derived from either the board (attacks, static exchange,
 * legal moves) or the engine lines the review already computed (MultiPV in the
 * position before the move, the main line after it). Lines shown on the board
 * are those engine lines replayed move by move, so they are legal and
 * engine-verified; nothing is invented. Both colours are explained in the
 * same way, by side name.
 */
export type XTone = 'threat' | 'better' | 'concept' | 'plan' | 'played' | 'defend';
export interface XArrow { from: string; to: string; tone: XTone; dashed?: boolean; label?: string }
export interface XSquare { sq: string; tone: XTone; style: 'ring' | 'fill' }
export interface XIcon { sq: string; cls: Classification }
export interface XMarks { arrows: XArrow[]; squares: XSquare[]; icons: XIcon[] }
export interface XStep { san: string; uci: string; color: Color; fen: string; text: string; marks: XMarks; moveNo: string }
export interface XLine {
  id: 'played' | 'best' | 'second' | 'exchange';
  label: string;
  /** the position the line starts from (the position before the reviewed move) */
  startFen: string;
  startMarks: XMarks;
  intro: string;
  steps: XStep[];
  /** forcing (checks, captures, recaptures, mate) rather than a possible plan */
  forced: boolean;
  score: Score | null;
  summary: string;
}
export interface XPoint { text: string; fen: string; marks: XMarks; lastMove?: [string, string] }
export interface CompareSide { san: string; uci: string; score: Score | null; win: number; line: string }
export interface Explanation {
  kind: 'blunder' | 'mistake' | 'inaccuracy' | 'miss' | 'tactic' | 'free-material' | 'sacrifice' | 'defence' | 'development' | 'positional' | 'best' | 'equal' | 'forced' | 'book';
  label: string;
  headline: string;
  points: XPoint[];
  lines: XLine[];
  /** played vs best (errors) or best vs second best (good moves) */
  compare: { a: CompareSide; b: CompareSide; approxEqual: boolean; aLine: XLine['id']; bLine: XLine['id'] } | null;
  fenBefore: string;
  fenAfter: string;
  mover: Color;
}

export interface EngineLine { score: Score; pv: string[] }
export interface ExplainInput {
  fenBefore: string;
  uci: string;
  cls: Classification;
  epl: number;
  /** MultiPV lines in the position before the move (White's view scores) */
  before: EngineLine[];
  /** main line(s) in the position after the move */
  after: EngineLine[];
  /** the opponent's move just before, when known */
  prev?: { san: string; uci: string; cls: Classification; epl: number } | null;
}

const SIDE = (c: Color) => (c === 'w' ? 'White' : 'Black');
const pawns = (n: number) => `${n} pawn${n === 1 ? '' : 's'}`;
const worth = (n: number) => (n >= 9 ? `a queen's worth (${pawns(n)})` : n >= 5 ? `a rook's worth (${pawns(n)})` : n >= 3 ? `a piece's worth (${pawns(n)})` : pawns(n));
const listJoin = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const mk = (arrows: XArrow[] = [], squares: XSquare[] = [], icons: XIcon[] = []): XMarks => ({ arrows: arrows.slice(0, 5), squares: squares.slice(0, 6), icons });
const pieceName = (t: PieceType) => (t === 'k' ? 'king' : NAME[t]);
const BAD: Classification[] = ['inaccuracy', 'mistake', 'blunder', 'miss'];
const TACTICS: Motif['kind'][] = ['checkmate', 'fork', 'pin', 'skewer', 'discovered-check', 'discovered-attack', 'wins-hanging', 'mate-threat', 'back-rank', 'promotion'];

/** A pin or skewer only matters when something valuable stands behind (not a pawn pinned to a minor piece). */
function meaningful(m: Motif, b: Board): boolean {
  if (m.kind !== 'pin' && m.kind !== 'skewer') return true;
  const [, mid, back] = m.squares ?? [];
  const pm = mid ? b[sqIdx(mid)] : null;
  const pb = back ? b[sqIdx(back)] : null;
  if (!pm || !pb) return false;
  if (m.kind === 'pin') return pb.t === 'k' || pb.t === 'q' || (pb.t === 'r' && pm.t !== 'p') || (VALUE[pb.t] - VALUE[pm.t] >= 3 && pm.t !== 'p');
  return VALUE[pm.t] >= 5 || pm.t === 'k';
}

/** Which piece the move saves from an existing attack (by moving it, defending it or blocking). */
function savedPiece(fenBefore: string, uci: string): { square: string; piece: PieceType; attackers: string[]; how: 'moves' | 'defends' | 'blocks' } | null {
  const threats = currentThreats(fenBefore).hanging;
  if (!threats.length) return null;
  let f: MoveFacts;
  try { f = analyzeMove(fenBefore, uci); } catch { return null; }
  const after = new Set(hangingPieces(f.fenAfter, f.mover).map((h) => h.square));
  for (const h of threats) {
    const sq = h.square === f.move.from ? f.move.to : h.square;
    if (after.has(sq)) continue;
    const b1 = parseBoard(f.fenAfter);
    const how = h.square === f.move.from ? 'moves' : attackersOf(b1, sqIdx(sq), f.mover).map(sqName).includes(f.move.to) ? 'defends' : 'blocks';
    return { square: h.square, piece: h.piece.t, attackers: h.attackers, how };
  }
  return null;
}

function sanOf(fen: string, uci: string): string {
  try { return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san; } catch { return uci; }
}
function moveNumber(fen: string, i: number): string {
  const p = fen.split(' ');
  const ply = (p[1] === 'b' ? 1 : 0) + i;
  const no = (Number(p[5]) || 1) + Math.floor(ply / 2);
  return ply % 2 === 0 ? `${no}.` : `${no}...`;
}
const piece = (b: Board, sq: string) => b[sqIdx(sq)];
const at = (b: Board, sq: string) => { const p = piece(b, sq); return p ? `${pieceName(p.t)} on ${sq}` : sq; };

/** Is the line forcing: its first two plies are checks, captures or replies to check, or it ends in mate? */
export function isForcing(startFen: string, pv: string[], plies = 4): boolean {
  const c = new Chess(startFen);
  let lead = 0, n = 0, broken = false;
  for (const u of pv.slice(0, plies)) {
    const wasCheck = c.inCheck();
    let m;
    try { m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch { break; }
    n++;
    if (c.isCheckmate()) return true;
    if (!broken && (m.captured || m.san.includes('+') || wasCheck)) lead++; else broken = true;
  }
  return n > 0 && lead >= Math.min(2, n);
}

/** Replay an engine line with a mark and a verified note per move. */
function buildSteps(startFen: string, pv: string[], max: number, tone: (c: Color) => XTone): XStep[] {
  const steps: XStep[] = [];
  let fen = startFen;
  pv.slice(0, max).forEach((u, i) => {
    let f: MoveFacts;
    try { f = analyzeMove(fen, u); } catch { return; }
    if (steps.length !== i) return; // stop at the first illegal move
    const key = f.motifs.find((m) => TACTICS.includes(m.kind) || m.kind === 'sacrifice' || m.kind === 'castles')
      ?? f.motifs.find((m) => m.kind === 'check' || m.kind === 'capture');
    steps.push({
      san: f.move.san, uci: u, color: f.mover, fen: f.fenAfter, text: key?.text ?? '', moveNo: moveNumber(startFen, i),
      marks: mk([{ from: f.move.from, to: f.move.to, tone: tone(f.mover) }], (key?.squares ?? []).filter((s) => s !== f.move.to).map((s) => ({ sq: s, tone: 'concept' as XTone, style: 'ring' as const }))),
    });
    fen = f.fenAfter;
  });
  return steps;
}

/** How far to play a line: through the material swing, at least 3 and at most 8 plies. */
const lineLength = (fen: string, pv: string[], mover: Color) => Math.max(Math.min(3, pv.length), Math.min(8, pv.length, materialAlongLine(fen, pv, mover, 8).plies + 1));

/**
 * The exchange on a square after a capture: the engine line while it keeps
 * recapturing there, otherwise the least-valuable-attacker sequence, cut where
 * a side would rather stop (static exchange).
 */
export function exchangeLine(fenBefore: string, uci: string, enginePv: string[]): string[] {
  const sq = uci.slice(2, 4);
  const seq = [uci];
  for (const u of enginePv) { if (u.slice(2, 4) !== sq) break; seq.push(u); }
  if (seq.length > 1) return seq;
  const c = new Chess(fenBefore);
  try { c.move({ from: uci.slice(0, 2), to: sq, promotion: uci[4] }); } catch { return [uci]; }
  const caps: { u: string; val: number }[] = [];
  for (let k = 0; k < 6; k++) {
    const ms = c.moves({ verbose: true }).filter((m) => m.to === sq && m.captured);
    if (!ms.length) break;
    ms.sort((a, b) => VALUE[a.piece as PieceType] - VALUE[b.piece as PieceType]);
    const m = ms[0];
    caps.push({ u: m.from + m.to + (m.promotion ?? ''), val: VALUE[m.captured as PieceType] });
    c.move(m);
  }
  // backward induction: capture only while it pays
  const n = caps.length;
  const net = new Array(n + 1).fill(0);
  for (let d = n - 1; d >= 0; d--) net[d] = Math.max(0, caps[d].val - net[d + 1]);
  for (let d = 0; d < n; d++) { if (caps[d].val - net[d + 1] <= 0) break; seq.push(caps[d].u); }
  return seq;
}

function materialSwing(fen: string, line: string[], mover: Color): number {
  const c = new Chess(fen);
  let s = 0;
  for (const u of line) {
    let m;
    try { m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch { break; }
    const v = (m.captured ? VALUE[m.captured as PieceType] : 0) + (m.promotion ? VALUE[m.promotion as PieceType] - 1 : 0);
    s += m.color === mover ? v : -v;
  }
  return s;
}

/** A piece left en prise: attackers, defenders and the capture that wins it. */
function hangingPoint(fenAfter: string, mover: Color, sq: string, intro: string): XPoint | null {
  const h = hangingPieces(fenAfter, mover).find((x) => x.square === sq);
  if (!h) return null;
  const b = parseBoard(fenAfter);
  const atk = attackersOf(b, sqIdx(sq), other(mover));
  const def = attackersOf(b, sqIdx(sq), mover);
  const c = new Chess(fenAfter);
  const caps = c.moves({ verbose: true }).filter((m) => m.to === sq && m.captured).sort((a, x) => VALUE[a.piece as PieceType] - VALUE[x.piece as PieceType]);
  const name = pieceName(h.piece.t);
  const text = `${intro}the ${name} on ${sq} is attacked by ${listJoin(atk.map((a) => `the ${pieceName(b[a]!.t)} on ${sqName(a)}`))} and ${def.length ? `defended only ${def.length === 1 ? 'once' : `${def.length} times`}` : 'not defended at all'}${caps[0] ? `: ${caps[0].san} ${h.loss >= VALUE[h.piece.t] ? 'wins it' : `wins ${worth(h.loss)}`}` : ''}.`;
  return {
    text, fen: fenAfter,
    marks: mk(atk.map((a) => ({ from: sqName(a), to: sq, tone: 'threat' as XTone })), [{ sq, tone: 'threat', style: 'ring' }, ...def.map((d) => ({ sq: sqName(d), tone: 'defend' as XTone, style: 'ring' as const }))]),
  };
}

/** Relationship marks for a tactical motif. */
function motifMarks(m: Motif, from: string, to: string, tone: XTone, oppKing?: string): XMarks {
  const sqs = m.squares ?? [];
  switch (m.kind) {
    case 'fork': return mk(sqs.slice(1).map((t) => ({ from: sqs[0], to: t, tone })), sqs.slice(1).map((t) => ({ sq: t, tone: 'threat' as XTone, style: 'ring' as const })));
    case 'pin': case 'skewer': return mk([{ from: sqs[0], to: sqs[2] ?? sqs[1], tone }], [{ sq: sqs[1], tone: 'threat', style: 'ring' }, ...(sqs[2] ? [{ sq: sqs[2], tone: 'concept' as XTone, style: 'ring' as const }] : [])]);
    case 'discovered-attack': return mk([{ from, to, tone: 'concept' }, { from: sqs[0], to: sqs[1], tone }], [{ sq: sqs[1], tone: 'threat', style: 'ring' }]);
    case 'discovered-check': return mk([{ from, to, tone: 'concept' }, ...(oppKing ? sqs.map((s) => ({ from: s, to: oppKing, tone })) : [])], [...sqs.map((s) => ({ sq: s, tone: 'concept' as XTone, style: 'ring' as const })), ...(oppKing ? [{ sq: oppKing, tone: 'threat' as XTone, style: 'ring' as const }] : [])]);
    case 'wins-hanging': return mk([{ from, to, tone }], [{ sq: to, tone: 'better', style: 'ring' }]);
    default: return mk([{ from, to, tone }], sqs.filter((s) => s !== to).map((s) => ({ sq: s, tone: 'threat' as XTone, style: 'ring' as const })));
  }
}

// ---------------- positional facts of a quiet move ----------------

const CENTRE = ['d4', 'e4', 'd5', 'e5'];
const WIDE = ['c4', 'c5', 'f4', 'f5', 'c3', 'f3', 'c6', 'f6', 'd3', 'e3', 'd6', 'e6'];
const DIAG_DIRS: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

/** The squares at both ends of the diagonal through `sq` in direction (df, dr): "a2–g8". */
function diagonalName(sq: string, df: number, dr: number): string {
  let f = sq.charCodeAt(0) - 97, r = Number(sq[1]) - 1;
  while (f - df >= 0 && f - df < 8 && r - dr >= 0 && r - dr < 8) { f -= df; r -= dr; }
  const a = 'abcdefgh'[f] + (r + 1);
  while (f + df >= 0 && f + df < 8 && r + dr >= 0 && r + dr < 8) { f += df; r += dr; }
  const z = 'abcdefgh'[f] + (r + 1);
  return a < z ? `${a}–${z}` : `${z}–${a}`;
}

function activityPoint(f: MoveFacts, fenAfter: string): XPoint | null {
  const b = parseBoard(fenAfter);
  const me = f.mover, opp = other(me);
  const to = f.move.to, from = f.move.from;
  const t = (f.move.promotion ?? f.move.piece) as PieceType;
  if (t === 'k' || t === 'p') return null;
  const att = attacks(b, sqIdx(to)).map(sqName);
  const enemies = att.filter((s) => piece(b, s)?.c === opp && piece(b, s)!.t !== 'k');
  const kz = new Set(kingZone(b, opp).map(sqName));
  const nearKing = att.filter((s) => kz.has(s));
  const centre = att.filter((s) => CENTRE.includes(s));
  const home = me === 'w' ? '1' : '8';
  const developing = (t === 'n' || t === 'b') && from[1] === home;
  const parts: string[] = [];
  const arrows: XArrow[] = [];
  const squares: XSquare[] = [];
  if (t === 'b' || t === 'q') {
    // the most useful diagonal: the one reaching an enemy piece or the king zone
    let bestDir: [number, number] | null = null; let bestScore = 0; let far = '';
    for (const [df, dr] of DIAG_DIRS) {
      let f0 = to.charCodeAt(0) - 97 + df, r0 = Number(to[1]) - 1 + dr; let score = 0; let last = '';
      while (f0 >= 0 && f0 < 8 && r0 >= 0 && r0 < 8) {
        const s = 'abcdefgh'[f0] + (r0 + 1); last = s;
        if (kz.has(s)) score += 2; if (CENTRE.includes(s)) score += 1;
        const p = piece(b, s); if (p) { if (p.c === opp) score += 2; break; }
        f0 += df; r0 += dr;
      }
      if (score > bestScore) { bestScore = score; bestDir = [df, dr]; far = last; }
    }
    if (bestDir && bestScore >= 2) {
      const aim = nearKing.filter((s) => att.includes(s) && !enemies.includes(s) && !piece(b, s)).slice(0, 2);
      parts.push(`it controls the ${diagonalName(to, bestDir[0], bestDir[1])} diagonal${aim.length ? `, aiming at ${listJoin(aim)} next to the ${SIDE(opp).toLowerCase()} king` : ''}`);
      arrows.push({ from: to, to: far, tone: 'concept' });
    }
  }
  if (t === 'r' || t === 'q') {
    const files = openFiles(parseBoard(fenAfter), me);
    const file = to[0];
    if (from[0] !== file || t === 'r') {
      if (files.open.includes(file)) parts.push(`it takes the open ${file}-file`);
      else if (files.halfOpen.includes(file)) parts.push(`it puts pressure along the half-open ${file}-file`);
    }
  }
  if (enemies.length) {
    const desc = enemies.slice(0, 2).map((s) => {
      const defs = attackersOf(b, sqIdx(s), opp);
      const onlyKing = defs.length === 1 && b[defs[0]]?.t === 'k';
      return `the ${at(b, s)}${onlyKing ? ' (defended only by the king)' : defs.length === 0 ? ' (undefended)' : ''}`;
    });
    parts.push(`it attacks ${listJoin(desc)}`);
    for (const s of enemies.slice(0, 2)) {
      if (!arrows.some((a) => a.to === s)) arrows.push({ from: to, to: s, tone: 'threat' });
      squares.push({ sq: s, tone: 'threat', style: 'ring' });
    }
  }
  if (centre.length && t === 'n') { parts.push(`it controls ${listJoin(centre)} in the centre`); for (const s of centre) squares.push({ sq: s, tone: 'concept', style: 'ring' }); }
  if (!parts.length) return null;
  const lead = developing ? `${f.move.san} develops the ${NAME[t]} from ${from}: ` : `On ${to} the ${NAME[t]} is more active: `;
  return { text: `${lead}${parts.join('; ')}.`, fen: fenAfter, marks: mk(arrows, [{ sq: to, tone: 'better', style: 'ring' }, ...squares]), lastMove: [from, to] };
}

function pawnPoint(f: MoveFacts, fenBefore: string, fenAfter: string): XPoint | null {
  if (f.move.piece !== 'p' || f.move.captured) return null;
  const me = f.mover;
  const b0 = parseBoard(fenBefore), b1 = parseBoard(fenAfter);
  const ctl = (b: Board) => { const s = new Set<string>(); b.forEach((p, i) => { if (p && p.c === me) for (const t of attacks(b, i)) s.add(sqName(t)); }); return s; };
  const c0 = ctl(b0), c1 = ctl(b1);
  const newly = [...CENTRE, ...WIDE].filter((s) => c1.has(s) && !c0.has(s));
  const gained = newly.filter((s) => !b1[sqIdx(s)]);
  const defends = newly.filter((s) => b1[sqIdx(s)]?.c === me);
  const hits = attacks(b1, sqIdx(f.move.to)).map(sqName).filter((s) => b1[sqIdx(s)] && b1[sqIdx(s)]!.c !== me && b1[sqIdx(s)]!.t !== 'p');
  // lines opened for own long-range pieces
  let opened: { sq: string; t: PieceType; gain: number } | null = null;
  b1.forEach((p, i) => {
    if (!p || p.c !== me || !['b', 'q', 'r'].includes(p.t) || !b0[i]) return;
    const g = attacks(b1, i).length - attacks(b0, i).length;
    if (g >= 2 && (!opened || g > opened.gain)) opened = { sq: sqName(i), t: p.t, gain: g };
  });
  const passedNew = passedPawns(b1, me).map(sqName).filter((s) => s === f.move.to && !passedPawns(b0, me).map(sqName).includes(f.move.from));
  const parts: string[] = [];
  const squares: XSquare[] = gained.slice(0, 3).map((s) => ({ sq: s, tone: 'concept' as XTone, style: 'ring' as const }));
  const arrows: XArrow[] = [];
  if (hits.length) parts.push(`it attacks the ${listJoin(hits.map((s) => at(b1, s)))}`);
  if (gained.length) parts.push(`it takes control of ${listJoin(gained.slice(0, 3))}`);
  if (defends.length) parts.push(`it defends the ${listJoin(defends.slice(0, 2).map((s) => at(b1, s)))}`);
  for (const s of hits) arrows.push({ from: f.move.to, to: s, tone: 'threat' });
  const op = opened as { sq: string; t: PieceType; gain: number } | null;
  if (op) { parts.push(`it opens a line for the ${NAME[op.t]} on ${op.sq}`); squares.push({ sq: op.sq, tone: 'plan', style: 'ring' }); }
  if (passedNew.length) parts.push('it creates a passed pawn');
  if (!parts.length) return null;
  return { text: `${f.move.san}: ${parts.join('; ')}.`, fen: fenAfter, marks: mk(arrows, [{ sq: f.move.to, tone: 'better', style: 'ring' }, ...squares]), lastMove: [f.move.from, f.move.to] };
}

function positionalDamage(fenBefore: string, f: MoveFacts): XPoint[] {
  const out: XPoint[] = [];
  const me = f.mover;
  const b0 = parseBoard(fenBefore), b1 = parseBoard(f.fenAfter);
  const S = SIDE(me);
  if (castlingRights(fenBefore, me) && !castlingRights(f.fenAfter, me) && !looksCastled(b1, me)) {
    out.push({ text: `${f.move.san} gives up ${S}'s right to castle, so the king may have to stay in the centre.`, fen: f.fenAfter, marks: mk([], [{ sq: sqName(kingSquare(b1, me)), tone: 'threat', style: 'ring' }]) });
  }
  const dbl = doubledFiles(b1, me).filter((x) => !doubledFiles(b0, me).includes(x));
  if (dbl.length) out.push({ text: `It leaves ${S} with doubled pawns on the ${listJoin(dbl)}-file.`, fen: f.fenAfter, marks: mk() });
  const iso = isolatedPawns(b1, me).filter((x) => !isolatedPawns(b0, me).includes(x));
  if (iso.length) out.push({ text: `It leaves ${iso.length === 1 ? 'an isolated pawn' : 'isolated pawns'} on ${listJoin(iso)}: no neighbouring pawn can defend ${iso.length === 1 ? 'it' : 'them'}.`, fen: f.fenAfter, marks: mk([], iso.map((s) => ({ sq: s, tone: 'threat' as XTone, style: 'ring' as const }))) });
  const exp = f.motifs.find((m) => m.kind === 'king-exposure');
  if (exp) out.push({ text: `${f.move.san} weakens the pawn shelter in front of ${S}'s king.`, fen: f.fenAfter, marks: mk([], (exp.squares ?? []).map((s) => ({ sq: s, tone: 'threat' as XTone, style: 'ring' as const }))) });
  const oppPassed = passedPawns(b1, other(me)).map(sqName);
  if (oppPassed.length > passedPawns(b0, other(me)).length) out.push({ text: `${SIDE(other(me))} now has a passed pawn on ${listJoin(oppPassed)}.`, fen: f.fenAfter, marks: mk([], oppPassed.map((s) => ({ sq: s, tone: 'threat' as XTone, style: 'ring' as const }))) });
  return out;
}

// ---------------- the explanation ----------------

export function explainMove(inp: ExplainInput): Explanation {
  const { fenBefore, uci, cls } = inp;
  const f = analyzeMove(fenBefore, uci);
  const me = f.mover, opp = other(me);
  const S = SIDE(me), O = SIDE(opp);
  const san = f.move.san;
  const fenAfter = f.fenAfter;
  const from = f.move.from, to = f.move.to;
  const kinds = new Set(f.motifs.map((m) => m.kind));
  const top = inp.before[0] ?? null;
  const bestUci = top?.pv[0] ?? null;
  const bestSan = bestUci ? sanOf(fenBefore, bestUci) : null;
  const terminal = new Chess(fenAfter).isGameOver();
  const afterLine = inp.after[0] ?? null;
  const scoreAfter: Score | null = afterLine?.score ?? (new Chess(fenAfter).isCheckmate() ? (me === 'w' ? { mate: 0, mated: 'b' } as unknown as Score : { mate: 0, mated: 'w' } as unknown as Score) : null);
  const win = (s: Score | null | undefined) => (s ? winPercentPov(s, me) : 50);
  const bad = BAD.includes(cls);
  const label = CLASS_INFO[cls].label;
  const afterPv = afterLine?.pv ?? [];
  const playedPv = [uci, ...afterPv];
  const points: XPoint[] = [];
  const lines: XLine[] = [];
  let kind: Explanation['kind'] = bad ? (cls as Explanation['kind']) : 'equal';
  const PRIORITY: Explanation['kind'][] = ['sacrifice', 'tactic', 'free-material', 'defence', 'development', 'positional', 'best', 'equal'];
  const setKind = (k: Explanation['kind']) => { if (bad) return; if (PRIORITY.indexOf(k) < PRIORITY.indexOf(kind) || kind === 'equal') kind = k; };
  const iconPlayed: XIcon = { sq: to, cls };
  const b0 = parseBoard(fenBefore);
  const b1 = parseBoard(fenAfter);

  // ---- lines (all start from the position before the move) ----
  const tonesErr = (c: Color): XTone => (c === me ? 'played' : 'threat');
  const tonesGood = (c: Color): XTone => (c === me ? 'better' : 'plan');
  if (!terminal || playedPv.length) {
    const steps = buildSteps(fenBefore, playedPv, lineLength(fenBefore, playedPv, me), bad ? tonesErr : tonesGood);
    if (steps.length > 1) {
      const mat = materialAlongLine(fenBefore, playedPv.slice(0, steps.length), me, steps.length);
      lines.push({
        id: 'played', label: bad ? `After ${san}` : `${san} and the follow-up`, startFen: fenBefore, startMarks: mk([{ from, to, tone: bad ? 'played' : 'better' }]),
        intro: bad ? `${san}, then the engine's best play for both sides.` : `${san}, then the engine's continuation.`,
        steps, forced: isForcing(fenAfter, afterPv), score: scoreAfter,
        summary: mat.delta ? `${S} ${mat.delta > 0 ? 'wins' : 'loses'} ${worth(Math.abs(mat.delta))} in this line.` : `Material stays level in this line; the evaluation is ${formatScore(scoreAfter ?? undefined)}.`,
      });
    }
  }
  if (bestUci && bestUci !== uci && top) {
    const steps = buildSteps(fenBefore, top.pv, lineLength(fenBefore, top.pv, me), tonesGood);
    const mat = materialAlongLine(fenBefore, top.pv.slice(0, steps.length), me, steps.length);
    lines.push({
      id: 'best', label: `Best: ${bestSan}`, startFen: fenBefore, startMarks: mk([{ from: bestUci.slice(0, 2), to: bestUci.slice(2, 4), tone: 'better' }], [], [{ sq: bestUci.slice(2, 4), cls: 'best' }]),
      intro: `${bestSan}, the engine's choice, and its continuation.`, steps, forced: isForcing(fenBefore, top.pv.slice(1)), score: top.score,
      summary: mat.delta ? `${S} ${mat.delta > 0 ? 'wins' : 'loses'} ${worth(Math.abs(mat.delta))} in this line.` : `Material stays level; the evaluation is ${formatScore(top.score)}.`,
    });
  }
  const second = bestUci === uci ? inp.before.find((l) => l.pv[0] && l.pv[0] !== uci) : undefined;
  if (!bad && second) {
    const steps = buildSteps(fenBefore, second.pv, lineLength(fenBefore, second.pv, me), tonesGood);
    lines.push({
      id: 'second', label: `Second best: ${sanOf(fenBefore, second.pv[0])}`, startFen: fenBefore, startMarks: mk([{ from: second.pv[0].slice(0, 2), to: second.pv[0].slice(2, 4), tone: 'plan' }]),
      intro: `The engine's second choice, ${sanOf(fenBefore, second.pv[0])}, and its continuation.`, steps, forced: isForcing(fenBefore, second.pv.slice(1)), score: second.score,
      summary: `The evaluation is ${formatScore(second.score)} after this line's first move.`,
    });
  }

  // ---- exchanges on the destination square ----
  let exchangeNet: number | null = null;
  if (f.move.captured) {
    const ex = exchangeLine(fenBefore, uci, afterPv);
    exchangeNet = materialSwing(fenBefore, ex, me);
    if (ex.length > 1) {
      const steps = buildSteps(fenBefore, ex, ex.length, (c) => (c === me ? (bad ? 'played' : 'better') : 'threat'));
      lines.push({
        id: 'exchange', label: !bad && exchangeNet < 0 ? `If ${O} takes on ${to}` : `The exchange on ${to}`, startFen: fenBefore,
        startMarks: mk([], [...attackersOf(b0, sqIdx(to), me).map((a) => ({ sq: sqName(a), tone: 'concept' as XTone, style: 'ring' as const })), ...attackersOf(b0, sqIdx(to), opp).map((a) => ({ sq: sqName(a), tone: 'threat' as XTone, style: 'ring' as const })), { sq: to, tone: 'concept', style: 'fill' }]),
        intro: `The pieces that can take on ${to}, captured in order of value.`, steps, forced: true, score: null,
        summary: exchangeNet === 0 ? 'The exchange is even.' : `${S} ${exchangeNet > 0 ? 'gains' : 'loses'} ${worth(Math.abs(exchangeNet))} in the exchange.`,
      });
    }
  }

  const winBest = Math.max(win(top?.score), win(scoreAfter));
  const winPlayed = win(scoreAfter);
  const bestMarks = (): XMarks => mk(
    [{ from, to, tone: 'played' }, ...(bestUci && bestUci !== uci ? [{ from: bestUci.slice(0, 2), to: bestUci.slice(2, 4), tone: 'better' as XTone }] : [])],
    [], [iconPlayed, ...(bestUci && bestUci !== uci ? [{ sq: bestUci.slice(2, 4), cls: 'best' as Classification }] : [])],
  );

  if (bad) {
    // ---- what went wrong ----
    const explained = new Set<string>();
    if (f.move.captured && exchangeNet !== null && exchangeNet < 0) {
      const atk = attackersOf(b1, sqIdx(to), opp);
      const def = attackersOf(b1, sqIdx(to), me);
      points.push({
        text: `A bad trade: ${san} wins a ${NAME[f.move.captured as PieceType]}, but the ${pieceName(f.move.piece as PieceType)} on ${to} is attacked by ${listJoin(atk.map((a) => `the ${pieceName(b1[a]!.t)} on ${sqName(a)}`))} and ${def.length ? `defended only ${def.length === 1 ? 'once' : `${def.length} times`}` : 'not defended'}. After the exchange ${S} is ${worth(-exchangeNet)} down. Step through the exchange to see it.`,
        fen: fenAfter, lastMove: [from, to],
        marks: mk(atk.map((a) => ({ from: sqName(a), to, tone: 'threat' as XTone })), [{ sq: to, tone: 'threat', style: 'ring' }, ...def.map((d) => ({ sq: sqName(d), tone: 'defend' as XTone, style: 'ring' as const }))], [iconPlayed]),
      });
      explained.add(to);
    }
    if (f.sacrifice >= 2 && f.acceptances[0]?.uci.slice(2, 4) === to && !explained.has(to)) {
      const p = hangingPoint(fenAfter, me, to, `After ${san}, `);
      if (p) { points.push({ ...p, marks: { ...p.marks, icons: [iconPlayed] }, lastMove: [from, to] }); explained.add(to); }
    }
    for (const m of f.motifs) {
      if ((m.kind === 'hanging-left' || m.kind === 'defender-removed' || m.kind === 'threat-ignored') && m.squares?.[0] && !explained.has(m.squares[0])) {
        const intro = m.kind === 'defender-removed' ? `The ${pieceName(f.move.piece as PieceType)} on ${from} was defending; after ${san} ` : m.kind === 'threat-ignored' ? `${san} ignores a threat: ` : `After ${san}, `;
        const p = hangingPoint(fenAfter, me, m.squares[0], intro);
        if (p) { points.push({ ...p, lastMove: [from, to] }); explained.add(m.squares[0]); }
      }
    }
    // a threat that already existed and is ignored
    {
      const pre = currentThreats(fenBefore).hanging;
      const reply0 = afterPv[0];
      const hit = reply0 ? pre.find((h) => h.square === reply0.slice(2, 4) && h.square !== from) : undefined;
      if (hit && !explained.has(hit.square)) {
        const capSan = sanOf(fenAfter, reply0);
        const mates = capSan.includes('#');
        points.push({
          text: `The ${pieceName(hit.piece.t)} on ${hit.square} was already attacked by ${listJoin(hit.attackers.map((a) => `the ${pieceName(b0[sqIdx(a)]!.t)} on ${a}`))}, and ${san} does nothing about it: ${capSan} ${mates ? 'takes it with checkmate' : 'takes it'}.`,
          fen: fenAfter, lastMove: [from, to], marks: mk(hit.attackers.map((a) => ({ from: a, to: hit.square, tone: 'threat' as XTone })), [{ sq: hit.square, tone: 'threat', style: 'ring' }], [iconPlayed]),
        });
        explained.add(hit.square);
      }
    }
    // the opponent's punishment
    const reply = afterPv[0];
    let rf: MoveFacts | null = null;
    try { if (reply) rf = analyzeMove(fenAfter, reply); } catch { rf = null; }
    const mateAgainst = scoreAfter && isMateScore(scoreAfter) && povCp(scoreAfter, me) < 0;
    const lineMat = materialAlongLine(fenBefore, playedPv, me, 9);
    if (rf) {
      const rb = parseBoard(rf.fenAfter);
      const rm = rf.motifs.find((m) => TACTICS.includes(m.kind) && meaningful(m, rb) && (m.kind === 'checkmate' || m.kind === 'mate-threat' || m.kind === 'back-rank' || lineMat.delta <= -1));
      if (rm && !(rf.move.captured && explained.has(rf.move.to))) {
        points.push({ text: rm.kind === 'checkmate' ? `It allows ${rf.move.san}, which is checkmate.` : `It allows ${rf.move.san}. ${rm.text}`, fen: rf.fenAfter, marks: { ...motifMarks(rm, rf.move.from, rf.move.to, 'threat', sqName(kingSquare(parseBoard(rf.fenAfter), me))), icons: [iconPlayed] }, lastMove: [rf.move.from, rf.move.to] });
      }
    }
    // a double attack by the reply (two loose or more valuable targets)
    if (rf && !points.some((p) => p.text.startsWith('It allows'))) {
      const rb = parseBoard(rf.fenAfter);
      const pt = (rf.move.promotion ?? rf.move.piece) as PieceType;
      const targets = attacks(rb, sqIdx(rf.move.to)).filter((t) => rb[t] && rb[t]!.c === me && rb[t]!.t !== 'k' && (VALUE[rb[t]!.t] > VALUE[pt] || attackersOf(rb, t, me).length === 0)).map(sqName);
      if (targets.length >= 2 && lineMat.delta <= -1) {
        points.push({ text: `It allows ${rf.move.san}, a double attack on ${listJoin(targets.map((t) => `the ${at(rb, t)}`))}: both cannot be saved.`, fen: rf.fenAfter, lastMove: [rf.move.from, rf.move.to], marks: mk(targets.map((t) => ({ from: rf!.move.to, to: t, tone: 'threat' as XTone })), targets.map((t) => ({ sq: t, tone: 'threat' as XTone, style: 'ring' as const })), [iconPlayed]) });
      }
    }
    if (mateAgainst && scoreAfter && Math.abs(povCp(scoreAfter, opp)) > 0 && (scoreAfter as { mate?: number }).mate !== undefined) {
      const n = Math.abs((scoreAfter as { mate: number }).mate);
      if (n >= 2) points.push({ text: `${O} now has a forced mate in ${n}: ${formatLine(fenAfter, pvToSan(fenAfter, afterPv, n * 2))}.`, fen: fenAfter, marks: mk(reply ? [{ from: reply.slice(0, 2), to: reply.slice(2, 4), tone: 'threat' }] : [], [], [iconPlayed]), lastMove: [from, to] });
    }
    if (!mateAgainst && lineMat.delta <= -1 && !points.some((p) => /bad trade/.test(p.text))) {
      points.push({ text: `With best play ${O} comes out ${worth(-lineMat.delta)} ahead compared with before ${san}: ${formatLine(fenBefore, pvToSan(fenBefore, playedPv, Math.max(2, lineMat.plies)))}.`, fen: fenAfter, marks: mk([], [], [iconPlayed]), lastMove: [from, to] });
    }
    // the most serious consequence first: a mate it allows
    const mi = points.findIndex((p) => /checkmate|forced mate/.test(p.text));
    if (mi > 0) points.unshift(...points.splice(mi, 1));
    if (!points.length) {
      const pos = positionalDamage(fenBefore, f);
      points.push(...pos);
      if (!pos.length) points.push({ text: `No tactic punishes ${san} directly. The engine's evaluation drops from ${formatScore(top?.score)} to ${formatScore(scoreAfter ?? undefined)}: compare the two lines to see where the difference comes from.`, fen: fenAfter, marks: mk([], [], [iconPlayed]), lastMove: [from, to] });
    }
    // missed opportunity
    if ((cls === 'miss' || (inp.prev && inp.prev.epl >= 10)) && bestUci && bestUci !== uci) {
      let bf: MoveFacts | null = null;
      try { bf = analyzeMove(fenBefore, bestUci); } catch { bf = null; }
      const bm = bf?.motifs.find((m) => TACTICS.includes(m.kind));
      const gain = top ? materialAlongLine(fenBefore, top.pv, me, 8).delta : 0;
      const what = bm ? bm.text : top && isMateScore(top.score) && povCp(top.score, me) > 0 ? `It forces mate in ${Math.abs((top.score as { mate: number }).mate)}.` : gain >= 1 ? `The engine line wins ${worth(gain)}.` : `It keeps ${S} at ${winBest.toFixed(0)}% winning chances.`;
      if (inp.prev && inp.prev.epl >= 10) {
        points.unshift({ text: `${O}'s previous move ${inp.prev.san} was a ${CLASS_INFO[inp.prev.cls].label.toLowerCase()}, and ${bestSan} would have taken advantage of it. ${what}`, fen: fenBefore, marks: bestMarks() });
        kind = 'miss';
      }
    }
    // the better move
    if (bestUci && bestUci !== uci && top) {
      let bf: MoveFacts | null = null;
      try { bf = analyzeMove(fenBefore, bestUci); } catch { bf = null; }
      const bm = bf?.motifs.find((m) => (TACTICS.includes(m.kind) && meaningful(m, parseBoard(bf!.fenAfter))) || m.kind === 'castles');
      const sv = savedPiece(fenBefore, bestUci);
      const savesText = sv ? ` It ${sv.how === 'moves' ? 'moves' : sv.how === 'defends' ? 'defends' : 'shields'} the ${pieceName(sv.piece)} on ${sv.square}, which the ${listJoin(sv.attackers.map((a) => `${pieceName(b0[sqIdx(a)]!.t)} on ${a}`))} attacks.` : '';
      const ap = bf ? activityPoint(bf, bf.fenAfter) ?? pawnPoint(bf, fenBefore, bf.fenAfter) : null;
      const why = bm ? ` ${bm.text}${savesText}` : `${ap && /attacks/.test(ap.text) ? ` ${ap.text}` : ''}${savesText}` || (ap ? ` ${ap.text}` : '');
      if (!points.some((p) => p.text.includes(`${bestSan} would have`))) {
        points.push({ text: `Better was ${bestSan} (${formatScore(top.score)}, ${win(top.score).toFixed(0)}% winning chances for ${S} instead of ${winPlayed.toFixed(0)}%).${why}`, fen: fenBefore, marks: bestMarks() });
      }
    }
  } else {
    // ---- why it works ----
    const pre = new Chess(fenBefore);
    if (pre.moves().length === 1) {
      kind = 'forced';
      points.push({ text: `${san} was the only legal move.`, fen: fenAfter, marks: mk([{ from, to, tone: 'better' }]), lastMove: [from, to] });
    }
    if (cls === 'book') {
      kind = 'book';
      points.push({ text: `${san} is a catalogued opening move.`, fen: fenAfter, marks: mk([{ from, to, tone: 'better' }]), lastMove: [from, to] });
    }
    // defence: check
    if (pre.inCheck()) {
      const k = kingSquare(b0, me);
      const checkers = attackersOf(b0, k, opp);
      const how = f.move.piece === 'k' ? `the king steps out of the check to ${to}` : checkers.some((c) => sqName(c) === to) ? `it captures the checking ${pieceName(b0[sqIdx(to)]!.t)}` : `it blocks the check by putting the ${pieceName(f.move.piece as PieceType)} on ${to}`;
      setKind('defence');
      points.push({
        text: `${S} was in check from the ${listJoin(checkers.map((c) => `${pieceName(b0[c]!.t)} on ${sqName(c)}`))}: ${how}.${f.move.piece !== 'k' && !checkers.some((c) => sqName(c) === to) && attackersOf(b1, sqIdx(to), me).length ? ` The ${pieceName(f.move.piece as PieceType)} on ${to} is defended, so the block holds.` : ''}`,
        fen: fenBefore, marks: mk([...checkers.map((c) => ({ from: sqName(c), to: sqName(k), tone: 'threat' as XTone })), { from, to, tone: 'better' }], [{ sq: sqName(k), tone: 'threat', style: 'ring' }, { sq: to, tone: 'better', style: 'ring' }]),
      });
    }
    // defence: threats dealt with
    const threats = currentThreats(fenBefore);
    if (!pre.inCheck()) {
      const stillHanging = new Set(hangingPieces(fenAfter, me).map((h) => h.square));
      // only when the move really protects it: moving it, adding a defender, or blocking/removing an attacker
      const saved = threats.hanging.filter((h) => {
        if (h.loss < 2 || stillHanging.has(h.square === from ? to : h.square)) return false;
        if (h.square === from) return true;
        const sqi = sqIdx(h.square);
        return attackersOf(b1, sqi, me).length > attackersOf(b0, sqi, me).length || attackersOf(b1, sqi, opp).length < attackersOf(b0, sqi, opp).length;
      });
      if (saved.length && !f.move.captured) {
        const h = saved[0];
        const moved = h.square === from;
        const defenders = moved ? [] : attackersOf(b1, sqIdx(h.square), me).map(sqName).filter((d) => !attackersOf(b0, sqIdx(h.square), me).map(sqName).includes(d));
        setKind('defence');
        points.push({
          text: `The ${pieceName(h.piece.t)} on ${h.square} was attacked by ${listJoin(h.attackers.map((a) => `the ${pieceName(b0[sqIdx(a)]!.t)} on ${a}`))} and not safe. ${moved ? `${san} moves it to safety.` : defenders.length ? `${san} defends it from ${defenders[0]}.` : `${san} deals with the threat.`}`,
          fen: fenBefore, marks: mk([...h.attackers.map((a) => ({ from: a, to: h.square, tone: 'threat' as XTone })), { from, to, tone: 'better' }], [{ sq: h.square, tone: 'threat', style: 'ring' }]),
        });
      }
      if (threats.mateThreat && !currentThreats(new Chess(fenAfter).fen()).mateThreat) {
        points.push({ text: `${O} was threatening checkmate; ${san} stops it.`, fen: fenBefore, marks: mk([{ from, to, tone: 'better' }]) });
      }
    }
    // tactics
    for (const m of f.motifs.filter((x) => TACTICS.includes(x.kind) && meaningful(x, b1)).slice(0, 2)) {
      if (m.kind === 'wins-hanging') {
        setKind('free-material');
        const ex = exchangeLine(fenBefore, uci, afterPv);
        const canTake = attackersOf(b1, sqIdx(to), opp).length > 0;
        const recapt = !canTake ? `Nothing of ${O}'s can take back on ${to}.` : ex.length > 1 ? `${O} can recapture, but the exchange still wins ${worth(Math.max(1, exchangeNet ?? 0))}.` : `${O} could take back on ${to}, but would lose more than it gains.`;
        const def = attackersOf(b0, sqIdx(to), opp).length;
        points.push({ text: `Free material: the ${NAME[f.move.captured as PieceType]} on ${to} was ${def ? `defended only ${def === 1 ? 'once' : `${def} times`} and attacked more often` : 'not defended'}. ${recapt}`, fen: fenBefore, marks: mk([{ from, to, tone: 'better' }, ...attackersOf(b0, sqIdx(to), me).filter((a) => sqName(a) !== from).map((a) => ({ from: sqName(a), to, tone: 'concept' as XTone, dashed: true }))], [{ sq: to, tone: 'better', style: 'ring' }]) });
      } else {
        setKind('tactic');
        points.push({ text: m.text, fen: fenAfter, marks: { ...motifMarks(m, from, to, 'better', sqName(kingSquare(b1, opp))), icons: [iconPlayed] }, lastMove: [from, to] });
      }
    }
    // removing the defender / deflection along the engine line
    if (afterPv.length >= 2) {
      const r1 = afterPv[0], m2 = afterPv[1];
      try {
        const c = new Chess(fenAfter);
        const rr = c.move({ from: r1.slice(0, 2), to: r1.slice(2, 4), promotion: r1[4] });
        const mid = parseBoard(c.fen());
        const mm = c.move({ from: m2.slice(0, 2), to: m2.slice(2, 4), promotion: m2[4] });
        const gain = materialAlongLine(fenBefore, playedPv, me, 6).delta;
        if (mm.captured && gain >= 2) {
          const t = mm.to;
          const guardedBefore = attackersOf(b1, sqIdx(t), opp).map(sqName);
          if (guardedBefore.includes(rr.from) && !attackersOf(mid, sqIdx(t), opp).length && rr.from !== t) {
            setKind('tactic');
            points.push({ text: `Deflection: after ${san}, ${O}'s ${pieceName(rr.piece as PieceType)} has to leave ${rr.from} (${rr.san}), and it was the piece guarding ${t}. ${mm.san} then wins it.`, fen: fenAfter, marks: mk([{ from: rr.from, to: t, tone: 'defend', dashed: true }, { from: mm.from, to: t, tone: 'better' }], [{ sq: t, tone: 'threat', style: 'ring' }], [iconPlayed]), lastMove: [from, to] });
          }
        }
      } catch { /* not a legal continuation */ }
    }
    if (f.move.captured && f.move.captured !== 'p') {
      const loose = hangingPieces(fenAfter, opp).filter((h) => attackersOf(b0, sqIdx(h.square), opp).map(sqName).includes(to) && !hangingPieces(fenBefore.replace(/ [wb] /, ` ${opp} `), opp).some((x) => x.square === h.square));
      const takenNext = loose.length && afterPv[1] && afterPv[1].slice(2, 4) === loose[0].square;
      if (loose.length && takenNext && materialAlongLine(fenAfter, afterPv, me, 6).delta >= 0) {
        setKind('tactic');
        points.push({ text: `Removing the defender: the ${NAME[f.move.captured as PieceType]} on ${to} was guarding the ${pieceName(loose[0].piece.t)} on ${loose[0].square}, which is now loose.`, fen: fenAfter, marks: mk([{ from: to, to: loose[0].square, tone: 'concept', dashed: true }], [{ sq: loose[0].square, tone: 'threat', style: 'ring' }], [iconPlayed]), lastMove: [from, to] });
      }
    }
    // sacrifices and trades that look bad but are justified
    if ((f.sacrifice >= 2 || (exchangeNet !== null && exchangeNet <= -2)) && pre.moves().length > 1) {
      const acc = f.acceptances[0]?.uci ?? null;
      const accept = acc ? sanOf(fenAfter, acc) : null;
      const accepted = !!acc && afterPv[0] === acc;
      const replies = new Chess(fenAfter).moves().length;
      const ksq = kingSquare(b1, opp);
      const checkers = ksq >= 0 ? attackersOf(b1, ksq, me) : [];
      const offeredSq = acc ? acc.slice(2, 4) : to;
      const offered = b1[sqIdx(offeredSq)];
      const offeredName = offered ? `${pieceName(offered.t)} on ${offeredSq}` : 'material';
      const mating = !!scoreAfter && isMateScore(scoreAfter) && povCp(scoreAfter, me) > 0;
      // mate counted from the position before the move, including the sacrifice itself
      const mateN = mating ? Math.abs((scoreAfter as { mate?: number }).mate ?? 0) + 1 : 0;
      const lineText = formatLine(fenAfter, pvToSan(fenAfter, afterPv, 8));
      const forcedNote = checkers.length >= 2 ? ` It is a double check (${listJoin(checkers.map((c) => `the ${pieceName(b1[c]!.t)} on ${sqName(c)}`))}), so only the king can move.` : '';
      const acceptNote = accept ? (replies === 1 ? ` ${accept} is ${O}'s only legal reply.` : accepted ? ` ${O}'s best reply is to take it: ${accept}.` : '') : '';
      const why = mating ? `after ${lineText} it is mate (mate in ${mateN} counting ${san})`
        : accepted ? (() => { const d = materialAlongLine(fenBefore, playedPv, me, 9).delta; return d >= 0 ? `after ${lineText} the material comes back` : `after ${lineText} ${S} stays ${worth(-d)} down, but the engine still rates the position at ${formatScore(scoreAfter ?? undefined)}`; })()
        : `in the engine's main line ${O} does not take it (${lineText}), and ${S} keeps ${winPlayed.toFixed(0)}% winning chances; taking it is no better for ${O}`;
      const alt = inp.before.find((l) => l.pv[0] && l.pv[0] !== uci);
      const altText = alt ? ` Without the sacrifice the best option, ${sanOf(fenBefore, alt.pv[0])}, gives ${formatScore(alt.score)}${isMateScore(alt.score) ? '' : ': a large advantage, but no forced win'}.` : '';
      kind = 'sacrifice';
      const lead = cls === 'brilliant'
        ? `Brilliant: ${san} sacrifices the ${offeredName} (${worth(Math.max(f.sacrifice, exchangeNet !== null ? -exchangeNet : 0))}).${forcedNote}${acceptNote} It is justified because ${why}.${mating && alt && !isMateScore(alt.score) ? altText : ''}`
        : `${san} offers the ${offeredName}${accept ? ` (${accept} would take it)` : ''}, and it is justified: ${why}.${forcedNote}`;
      points.unshift({ text: lead, fen: fenAfter, marks: mk([{ from, to, tone: 'better' }, ...(acc ? [{ from: acc.slice(0, 2), to: acc.slice(2, 4), tone: 'threat' as XTone, dashed: true }] : []), ...checkers.filter((c) => sqName(c) !== to).map((c) => ({ from: sqName(c), to: sqName(ksq), tone: 'concept' as XTone }))], [{ sq: offeredSq, tone: 'concept', style: 'ring' }], [iconPlayed]), lastMove: [from, to] });
    }
    // castling, development, pawn play
    if (kinds.has('castles')) {
      const k = kingSquare(b1, me);
      const shield = [-1, 0, 1].map((df) => sqName(k + (me === 'w' ? 8 : -8) + df)).filter((s) => piece(b1, s)?.t === 'p' && piece(b1, s)?.c === me);
      setKind('development');
      points.push({ text: `${S} castles: the king on ${sqName(k)} is sheltered${shield.length ? ` behind the pawns on ${listJoin(shield)}` : ''}, and the rook comes into play.`, fen: fenAfter, marks: mk([], [{ sq: sqName(k), tone: 'better', style: 'ring' }, ...shield.map((s) => ({ sq: s, tone: 'concept' as XTone, style: 'ring' as const }))]), lastMove: [from, to] });
    }
    if (!points.some((p) => p.fen === fenAfter && /attacks|controls|diagonal/.test(p.text)) && !kinds.has('check') && !kinds.has('discovered-check') && kind !== 'sacrifice') {
      const ap = activityPoint(f, fenAfter) ?? pawnPoint(f, fenBefore, fenAfter);
      if (ap) { points.push({ ...ap, marks: { ...ap.marks, icons: [iconPlayed] } }); setKind(/develops/.test(ap.text) ? 'development' : 'positional'); }
    }
    // punishing the opponent's mistake
    if (inp.prev && inp.prev.epl >= 10 && !['inaccuracy', 'mistake', 'blunder', 'miss'].includes(cls)) {
      points.unshift({ text: `${O}'s ${inp.prev.san} was a ${CLASS_INFO[inp.prev.cls].label.toLowerCase()}, and ${san} takes advantage of it.`, fen: fenAfter, marks: mk([{ from, to, tone: 'better' }], [], [iconPlayed]), lastMove: [from, to] });
    }
    // what it prepares (a plan, not a forced line)
    const forcing = isForcing(fenAfter, afterPv);
    const plan = [afterPv[1], afterPv[3]].filter(Boolean) as string[];
    if (!forcing && plan.length && !terminal) {
      const c = new Chess(fenAfter);
      const ok: { san: string; from: string; to: string }[] = [];
      for (const [i, u] of afterPv.slice(0, 4).entries()) {
        let m; try { m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch { break; }
        if (i % 2 === 1 && !m.captured) ok.push({ san: m.san, from: m.from, to: m.to });
      }
      if (ok.length) {
        points.push({
          text: `What it prepares: in the engine's continuation ${S} follows up with ${listJoin(ok.map((o) => o.san))}. This is a possible plan, not a forced line: ${O} has other replies.`,
          fen: fenAfter, marks: mk(ok.map((o, i) => ({ from: o.from, to: o.to, tone: 'plan' as XTone, dashed: true, label: String(i + 1) }))), lastMove: [from, to],
        });
      }
    }
    // honest when there is nothing particular to say
    if (!points.length) {
      kind = 'equal';
      points.push({ text: `${san} keeps the balance (${formatScore(scoreAfter ?? top?.score)}). There is no particular tactic or plan behind it to point to.`, fen: fenAfter, marks: mk([{ from, to, tone: 'better' }], [], [iconPlayed]), lastMove: [from, to] });
    }
    if (kind === 'equal' && (cls === 'best' || cls === 'great' || cls === 'brilliant')) kind = 'best';
  }

  // ---- comparison ----
  let compare: Explanation['compare'] = null;
  const fmtLine = (pv: string[]) => formatLine(fenBefore, pvToSan(fenBefore, pv, 6));
  if (bad && bestUci && bestUci !== uci && top) {
    compare = {
      a: { san, uci, score: scoreAfter, win: winPlayed, line: fmtLine(playedPv) },
      b: { san: bestSan!, uci: bestUci, score: top.score, win: win(top.score), line: fmtLine(top.pv) },
      approxEqual: Math.abs(win(top.score) - winPlayed) < 2, aLine: 'played', bLine: 'best',
    };
  } else if (!bad && bestUci && bestUci !== uci && top) {
    const a = { san, uci, score: scoreAfter, win: winPlayed, line: fmtLine(playedPv) };
    const b = { san: bestSan!, uci: bestUci, score: top.score, win: win(top.score), line: fmtLine(top.pv) };
    const approxEqual = Math.abs(a.win - b.win) < 2;
    compare = { a, b, approxEqual, aLine: 'played', bLine: 'best' };
    points.push({
      text: approxEqual
        ? `The engine's first choice was ${b.san} (${formatScore(top.score)}), but the difference is negligible (${winLabel(a.score ?? undefined, me)} against ${winLabel(b.score ?? undefined, me)}).`
        : `The engine's first choice was ${b.san} (${formatScore(top.score)}): ${winLabel(b.score ?? undefined, me)} against ${winLabel(a.score ?? undefined, me)}. Compare the two lines to see what it adds.`,
      fen: fenBefore, marks: bestMarks(),
    });
  } else if (!bad && second) {
    const playedScore = bestUci === uci && top ? top.score : scoreAfter;
    const a = { san, uci, score: playedScore, win: win(playedScore), line: fmtLine(bestUci === uci && top ? top.pv : playedPv) };
    const b = { san: sanOf(fenBefore, second.pv[0]), uci: second.pv[0], score: second.score, win: win(second.score), line: fmtLine(second.pv) };
    const approxEqual = Math.abs(a.win - b.win) < 2;
    compare = { a, b, approxEqual, aLine: 'played', bLine: 'second' };
    if (cls === 'best' || cls === 'great' || cls === 'brilliant' || cls === 'excellent') {
      const diffCp = (povCp(playedScore ?? { cp: 0 }, me) - povCp(second.score, me)) / 100;
      points.push({
        text: approxEqual
          ? `${b.san} (${formatScore(second.score)}) is about as good: the engine sees no meaningful difference between the two.`
          : `The next best move, ${b.san} (${formatScore(second.score)}), is clearly weaker: ${winLabel(a.score ?? undefined, me)} against ${winLabel(b.score ?? undefined, me)}${Math.abs(diffCp) < 50 ? ` (${Math.abs(diffCp).toFixed(1)} pawns)` : ''}. Compare the two lines to see why.`,
        fen: fenBefore,
        marks: mk([{ from, to, tone: 'better' }, { from: b.uci.slice(0, 2), to: b.uci.slice(2, 4), tone: 'plan' }], [], [{ sq: to, cls }]),
      });
    }
  }

  const KIND_LABEL: Record<Explanation['kind'], string> = {
    blunder: 'Blunder', mistake: 'Mistake', inaccuracy: 'Inaccuracy', miss: 'Missed opportunity', tactic: 'Tactic', 'free-material': 'Free material', sacrifice: 'Justified sacrifice',
    defence: 'Defence', development: 'Development', positional: 'Positional', best: 'Best move', equal: 'Balanced', forced: 'Forced', book: 'Book',
  };
  return {
    kind, label: KIND_LABEL[kind], headline: `${moveNumber(fenBefore, 0)} ${san}: ${label}`,
    points: points.slice(0, 5), lines, compare, fenBefore, fenAfter, mover: me,
  };
}
