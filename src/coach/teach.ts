import { Chess } from 'chess.js';
import {
  attackersOf, castlingRights, doubledFiles, hangingPieces, isolatedPawns, looksCastled, NAME, other, parseBoard, passedPawns,
  sqIdx, sqName, undevelopedMinors, VALUE, type Color, type PieceType,
} from '../analysis/board';
import { analyzeMove, currentThreats, type Motif, type MoveFacts } from '../analysis/motifs';
import { formatLine, materialAlongLine, pvToSan } from '../analysis/explain';
import { CLASS_INFO, type Classification, type MoveClassification } from '../analysis/classify';
import { formatScore, isMateScore, povCp, winPercentPov, type Score } from '../engine/score';

/**
 * Post-move teaching. Unlike pre-move hints, this is allowed to be concrete:
 * it names pieces, squares and the opponent's punishing reply. Every claim is
 * derived from the board (attacks, static exchange) or from the engine line;
 * when no concrete reason exists, it says so rather than inventing one.
 *
 * Colours follow the Game Review convention: red = threats and punishments,
 * green = stronger alternatives, orange = the idea being explained, blue =
 * plans and responses.
 */
export type Tone = 'threat' | 'better' | 'concept' | 'plan';
export interface Mark { arrows: [string, string, Tone][]; squares: [string, Tone][] }
export interface TeachPoint { text: string; mark?: Mark }
export interface DemoStep { san: string; uci: string; by: 'you' | 'opponent'; text: string; mark: Mark; fen: string }
export interface DemoLine {
  kind: 'why' | 'best' | 'idea';
  title: string;
  intro: string;
  startFen: string;
  startMark: Mark;
  steps: DemoStep[];
  summary: string;
}
export interface CompareSide { san: string; uci: string; score: Score; win: number; line: string; material: number; plies: number }
export interface Comparison { startFen: string; played: CompareSide; best: CompareSide; epl: number }
export interface Teaching {
  kind: 'tactical' | 'positional' | 'mate' | 'missed' | 'strong' | 'quiet';
  tone: 'bad' | 'warn' | 'info' | 'good';
  headline: string;
  label: string;
  points: TeachPoint[];
  why: DemoLine | null;
  best: DemoLine | null;
  compare: Comparison | null;
  fenBefore: string;
  fenAfter: string;
  /** squares of the move itself */
  from: string;
  to: string;
}

export interface TeachInput {
  fenBefore: string;
  uci: string;
  c: MoveClassification;
  cls: Classification;
  /** engine line after the move (opponent to move) */
  afterPv: string[];
  /** ply index (0-based) of the move */
  ply?: number;
}

const pawns = (n: number) => `${n} pawn${n === 1 ? '' : 's'}`;
const worth = (n: number) => (n >= 9 ? `a queen's worth (${pawns(n)})` : n >= 5 ? `a rook's worth (${pawns(n)})` : n >= 3 ? `a piece's worth (${pawns(n)})` : pawns(n));
const listJoin = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const pieceAt = (fen: string, sq: string) => parseBoard(fen)[sqIdx(sq)];
const mk = (arrows: [string, string, Tone][] = [], squares: [string, Tone][] = []): Mark => ({ arrows: arrows.slice(0, 3), squares });

function sanOf(fen: string, uci: string): string {
  try { return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san; } catch { return uci; }
}

/** The opponent's most profitable legal capture of `square`, if any. */
function bestCaptureOf(fen: string, square: string): { san: string; from: string } | null {
  const c = new Chess(fen);
  const caps = c.moves({ verbose: true }).filter((m) => m.to === square && m.captured);
  if (!caps.length) return null;
  caps.sort((a, b) => VALUE[a.piece as PieceType] - VALUE[b.piece as PieceType]);
  return { san: caps[0].san, from: caps[0].from };
}

function describeHanging(fenAfter: string, mover: Color, square: string, removedBy?: { piece: PieceType; from: string }, movedHere = false): TeachPoint | null {
  const h = hangingPieces(fenAfter, mover).find((x) => x.square === square);
  if (!h) return null;
  const b = parseBoard(fenAfter);
  const idx = sqIdx(square);
  const attackers = attackersOf(b, idx, other(mover)).map((a) => `the ${NAME[b[a]!.t]} on ${sqName(a)}`);
  const defenders = attackersOf(b, idx, mover).length;
  // with the opponent to move, find the actual capture
  const cap = bestCaptureOf(fenAfter, square);
  const piece = NAME[h.piece.t];
  const prefix = removedBy ? `Moving your ${NAME[removedBy.piece]} away from ${removedBy.from} left your ${piece} on ${square} without enough protection: `
    : movedHere ? `On ${square} your ${piece} ` : `Your ${piece} on ${square} `;
  const body = `${removedBy ? 'it is' : 'is'} attacked by ${listJoin(attackers)} and ${defenders ? `defended only ${defenders === 1 ? 'once' : `${defenders} times`}` : 'not defended at all'}`;
  const gain = h.loss >= VALUE[h.piece.t] ? `wins it for nothing` : `wins ${worth(h.loss)} in the exchange`;
  return {
    text: `${prefix}${body}${cap ? `: ${cap.san} ${gain}.` : '.'}`,
    mark: mk(cap ? [[cap.from, square, 'threat']] : h.attackers.map((a) => [a, square, 'threat'] as [string, string, Tone]), [[square, 'threat']]),
  };
}

function replyPoint(fenAfter: string, replyUci: string, f: MoveFacts): TeachPoint | null {
  const san = f.move.san;
  const arrow: [string, string, Tone] = [f.move.from, f.move.to, 'threat'];
  const pick = (k: Motif['kind']) => f.motifs.find((m) => m.kind === k);
  const fork = pick('fork');
  if (pick('checkmate')) return { text: `It allows ${san}, which is checkmate.`, mark: mk([arrow], [[f.move.to, 'threat']]) };
  if (fork) {
    const targets = (fork.squares ?? []).slice(1);
    const names = targets.map((sq) => { const p = pieceAt(f.fenAfter, sq); return p ? `${p.t === 'k' ? 'king' : NAME[p.t]} on ${sq}` : sq; });
    return { text: `${san} attacks your ${listJoin(names)} at the same time (a fork).`, mark: mk([arrow], targets.map((sq) => [sq, 'concept'] as [string, Tone])) };
  }
  for (const k of ['pin', 'skewer', 'discovered-check', 'discovered-attack'] as const) {
    const m = pick(k);
    if (m) return { text: `${san}: ${m.text}`, mark: mk([arrow], (m.squares ?? []).map((sq) => [sq, 'concept'] as [string, Tone])) };
  }
  const mate = pick('mate-threat') ?? pick('back-rank');
  if (mate) return { text: `${san} ${mate.kind === 'back-rank' ? 'threatens mate on your back rank' : 'threatens mate'}.`, mark: mk([arrow], (mate.squares ?? []).map((sq) => [sq, 'threat'] as [string, Tone])) };
  if (f.move.captured) {
    const cap = NAME[f.move.captured as PieceType];
    return { text: `${san} takes your ${cap} on ${f.move.to}.`, mark: mk([arrow], [[f.move.to, 'threat']]) };
  }
  void fenAfter; void replyUci;
  return null;
}

function positionalPoints(fenBefore: string, f: MoveFacts, ply: number): TeachPoint[] {
  const out: TeachPoint[] = [];
  const b0 = parseBoard(fenBefore);
  const b1 = parseBoard(f.fenAfter);
  const me = f.mover;
  const san = f.move.san;
  if (castlingRights(fenBefore, me) && !castlingRights(f.fenAfter, me) && !looksCastled(b1, me)) {
    out.push({ text: `${san} gives up your right to castle, so your king may have to stay in the centre.`, mark: mk([], [[sqName(b1.findIndex((p) => p?.t === 'k' && p.c === me)), 'concept']]) });
  }
  const dblNew = doubledFiles(b1, me).filter((x) => !doubledFiles(b0, me).includes(x));
  const isoNew = isolatedPawns(b1, me).filter((x) => !isolatedPawns(b0, me).includes(x));
  if (dblNew.length) out.push({ text: `It leaves you with doubled pawns on the ${listJoin(dblNew)}-file.` });
  if (isoNew.length) out.push({ text: `It leaves ${isoNew.length === 1 ? 'an isolated pawn' : 'isolated pawns'} on ${listJoin(isoNew)}: no neighbouring pawn can defend ${isoNew.length === 1 ? 'it' : 'them'}.`, mark: mk([], isoNew.map((sq) => [sq, 'concept'] as [string, Tone])) });
  const exp = f.motifs.find((m) => m.kind === 'king-exposure');
  if (exp) out.push({ text: exp.text.replace('The pawn move', `${san}`), mark: mk([], (exp.squares ?? []).map((sq) => [sq, 'concept'] as [string, Tone])) });
  const theirPassedBefore = passedPawns(b0, other(me)).length;
  const theirPassed = passedPawns(b1, other(me)).map(sqName);
  if (theirPassed.length > theirPassedBefore) out.push({ text: `Your opponent now has a passed pawn on ${listJoin(theirPassed)}.`, mark: mk([], theirPassed.map((sq) => [sq, 'concept'] as [string, Tone])) });
  if (ply <= 20) {
    const undev = undevelopedMinors(b1, me);
    const moved = f.move.piece as PieceType;
    const home = me === 'w' ? ['b1', 'g1', 'c1', 'f1', 'd1'] : ['b8', 'g8', 'c8', 'f8', 'd8'];
    if (undev.length >= 2 && ['n', 'b', 'q'].includes(moved) && !home.includes(f.move.from)) {
      out.push({ text: `This moves your ${NAME[moved]} again while ${listJoin(undev.map((sq) => `the ${NAME[b1[sqIdx(sq)]!.t]} on ${sq}`))} ${undev.length === 1 ? 'is' : 'are'} still undeveloped.`, mark: mk([], undev.map((sq) => [sq, 'concept'] as [string, Tone])) });
    }
  }
  return out;
}

function buildLine(kind: DemoLine['kind'], startFen: string, pv: string[], firstBy: 'you' | 'opponent', maxPlies: number): DemoStep[] {
  const steps: DemoStep[] = [];
  let fen = startFen;
  for (const u of pv.slice(0, maxPlies)) {
    let f: MoveFacts;
    try { f = analyzeMove(fen, u); } catch { break; }
    const by = (steps.length % 2 === 0) === (firstBy === 'you') ? 'you' : 'opponent';
    const tone: Tone = by === 'opponent' ? (kind === 'why' ? 'threat' : 'plan') : kind === 'best' ? 'better' : 'plan';
    const key = f.motifs.find((m) => ['checkmate', 'fork', 'pin', 'skewer', 'discovered-check', 'discovered-attack', 'wins-hanging', 'mate-threat', 'back-rank', 'promotion', 'sacrifice'].includes(m.kind))
      ?? f.motifs.find((m) => m.kind === 'check' || m.kind === 'capture');
    steps.push({
      san: f.move.san, uci: u, by, text: key ? key.text : '', fen: f.fenAfter,
      mark: mk([[f.move.from, f.move.to, tone]], (key?.squares ?? []).filter((sq) => sq !== f.move.to).map((sq) => [sq, 'concept'] as [string, Tone])),
    });
    fen = f.fenAfter;
    if (new Chess(fen).isGameOver()) break;
  }
  return steps;
}

/** How many plies of a line to demonstrate: through the material swing, at most `max`. */
function demoLength(fen: string, pv: string[], mover: Color, max = 6): number {
  const m = materialAlongLine(fen, pv, mover, max);
  return Math.max(2, Math.min(max, m.plies || max, pv.length));
}

export function teachMove(input: TeachInput): Teaching {
  const { fenBefore, uci, c, cls, afterPv } = input;
  const ply = input.ply ?? 30;
  const f = analyzeMove(fenBefore, uci);
  const me = f.mover;
  const fenAfter = f.fenAfter;
  const san = f.move.san;
  const label = CLASS_INFO[cls].label;
  const bad = ['inaccuracy', 'mistake', 'miss', 'blunder'].includes(cls);
  const points: TeachPoint[] = [];
  const kinds = new Set(f.motifs.map((m) => m.kind));
  let tactical = false;

  // --- the opponent's best reply and the engine line ---
  const replyUci = afterPv[0];
  let reply: MoveFacts | null = null;
  try { if (replyUci) reply = analyzeMove(fenAfter, replyUci); } catch { reply = null; }
  const mateAgainst = isMateScore(c.scoreAfter) && povCp(c.scoreAfter, me) < 0;
  const lineMat = afterPv.length ? materialAlongLine(fenAfter, afterPv, me, 8) : { delta: 0, plies: 0 };

  let teachingKind: Teaching['kind'] = 'quiet';
  if (bad) {
    if (f.move.captured) points.push({ text: `${san} wins ${f.move.captured === 'p' ? 'a pawn' : `a ${NAME[f.move.captured as PieceType]}`}${kinds.has('hanging-left') || kinds.has('defender-removed') || lineMat.delta < 0 ? ', but it costs more than it gains' : ''}.`, mark: mk([[f.move.from, f.move.to, 'concept']]) });
    const explained = new Set<string>();
    // the moved piece itself is left en prise (a bad move, so this is not a sacrifice)
    if (f.sacrifice >= 2 && f.acceptances[0]?.uci.slice(2, 4) === f.move.to) {
      const p = describeHanging(fenAfter, me, f.move.to, undefined, true);
      if (p) { points.push(p); explained.add(f.move.to); tactical = true; }
    }
    // pieces left loose by this move
    for (const m of f.motifs) {
      if (m.kind !== 'hanging-left' && m.kind !== 'defender-removed') continue;
      const sq = m.squares?.[0];
      if (!sq) continue;
      const p = describeHanging(fenAfter, me, sq, m.kind === 'defender-removed' ? { piece: f.move.piece as PieceType, from: f.move.from } : undefined);
      if (p) { points.push(p); explained.add(sq); tactical = true; }
    }
    for (const m of f.motifs) {
      if (m.kind !== 'threat-ignored' || !m.squares?.[0]) continue;
      const sq = m.squares[0];
      const p = pieceAt(fenAfter, sq);
      const cap = bestCaptureOf(fenAfter, sq);
      if (p) { points.push({ text: `Your ${NAME[p.t]} on ${sq} was already under attack, and this move does not save it${cap ? `: ${cap.san} still wins it` : ''}.`, mark: mk(cap ? [[cap.from, sq, 'threat']] : [], [[sq, 'threat']]) }); explained.add(sq); tactical = true; }
    }
    // the punishment
    if (mateAgainst && c.scoreAfter.mate !== undefined && Math.abs(c.scoreAfter.mate) >= 2) {
      const n = Math.abs(c.scoreAfter.mate);
      points.push({ text: `It allows a forced mate in ${n}: ${formatLine(fenAfter, pvToSan(fenAfter, afterPv, n * 2))}.`, mark: reply ? mk([[reply.move.from, reply.move.to, 'threat']]) : undefined });
      teachingKind = 'mate';
      tactical = true;
    } else if (reply) {
      const rp = reply.move.captured && explained.has(reply.move.to) && !reply.motifs.some((m) => m.kind === 'checkmate') ? null : replyPoint(fenAfter, replyUci, reply);
      if (rp) { points.push(rp); if (!/^\S+ takes your pawn/.test(rp.text)) tactical = true; teachingKind = reply.motifs.some((m) => m.kind === 'checkmate') ? 'mate' : teachingKind; }
    }
    if (lineMat.delta <= -1 && !mateAgainst) {
      points.push({ text: `With best play your opponent comes out ${worth(-lineMat.delta)} ahead within ${Math.ceil(lineMat.plies / 2)} move${lineMat.plies > 2 ? 's' : ''}: ${formatLine(fenAfter, pvToSan(fenAfter, afterPv, lineMat.plies))}.` });
      if (lineMat.delta <= -2) tactical = true;
    }
    if (cls === 'miss') {
      points.unshift({ text: c.notes.find((n) => /forced mate/.test(n)) ?? 'Your opponent’s previous move was a mistake, and this move did not take advantage of it. Look again at what their last move left undefended or allowed.' });
      teachingKind = 'missed';
    }
    if (!tactical && cls !== 'miss') {
      const pos = positionalPoints(fenBefore, f, ply);
      points.push(...pos);
      if (!pos.length) {
        points.push({ text: `No tactic punishes ${san} directly. The engine prefers a different plan: the evaluation goes from ${formatScore(c.scoreBest)} to ${formatScore(c.scoreAfter)} (White's view). Show Why plays out the engine's continuation.` });
      }
    }
    if (teachingKind === 'quiet') teachingKind = tactical ? 'tactical' : 'positional';
  } else {
    // strong or ordinary move: only specific, notable facts
    for (const n of c.notes) if (/Sacrifices|only move|Turns a/.test(n)) points.push({ text: n });
    const notable = f.motifs.filter((m) => ['checkmate', 'fork', 'pin', 'skewer', 'discovered-check', 'discovered-attack', 'wins-hanging', 'mate-threat', 'back-rank', 'promotion'].includes(m.kind)).slice(0, 2);
    for (const m of notable) points.push({ text: m.text, mark: mk([[f.move.from, f.move.to, 'concept']], (m.squares ?? []).filter((sq) => sq !== f.move.to).map((sq) => [sq, 'concept'] as [string, Tone])) });
    const threatsBefore = currentThreats(fenBefore);
    const stillHanging = new Set(hangingPieces(fenAfter, me).map((h) => h.square));
    const saved = threatsBefore.hanging.filter((h) => h.loss >= 2 && !stillHanging.has(h.square) && h.square !== f.move.to);
    if (saved.length && ['best', 'excellent', 'great', 'brilliant'].includes(cls)) points.push({ text: `It deals with the threat to your ${NAME[saved[0].piece.t]} on ${saved[0].square}.`, mark: mk([], [[saved[0].square, 'better']]) });
    if (threatsBefore.mateThreat && !mateAgainst && ['best', 'excellent', 'great', 'brilliant'].includes(cls)) points.push({ text: 'It stops your opponent’s mating threat.' });
    teachingKind = points.length ? 'strong' : 'quiet';
  }

  // --- demonstrations ---
  const whyPlies = mateAgainst && c.scoreAfter.mate ? Math.min(10, Math.abs(c.scoreAfter.mate) * 2) : demoLength(fenAfter, afterPv, me);
  const whySteps = afterPv.length ? buildLine(bad ? 'why' : 'idea', fenAfter, afterPv, 'opponent', whyPlies) : [];
  const why: DemoLine | null = whySteps.length ? {
    kind: bad ? 'why' : 'idea',
    title: bad ? `Why ${san} is ${/^[AEIOU]/.test(label) ? 'an' : 'a'} ${label.toLowerCase()}` : `How ${san} works`,
    intro: bad
      ? (tactical ? `Here is how your opponent can punish ${san}.` : `No forcing tactic punishes ${san}. This is the engine's continuation, showing the plan it prefers.`)
      : `The engine's continuation after ${san}.`,
    startFen: fenAfter,
    startMark: mk([[f.move.from, f.move.to, 'concept'], ...(whySteps[0] ? [[whySteps[0].uci.slice(0, 2), whySteps[0].uci.slice(2, 4), bad ? 'threat' : 'plan'] as [string, string, Tone]] : [])]),
    steps: whySteps,
    summary: (() => {
      const m = materialAlongLine(fenAfter, whySteps.map((s) => s.uci), me, whySteps.length);
      const end = new Chess(whySteps[whySteps.length - 1].fen);
      if (end.isCheckmate()) return end.turn() === me ? 'The line ends in checkmate against you.' : 'The line ends in checkmate.';
      if (m.delta <= -1) return `At the end of the line you are ${worth(-m.delta)} down compared with before your move.`;
      if (m.delta >= 1) return `At the end of the line you are ${worth(m.delta)} up.`;
      return `Material stays level; the engine's evaluation after ${san} is ${formatScore(c.scoreAfter)} (White's view).`;
    })(),
  } : null;

  let best: DemoLine | null = null;
  let compare: Comparison | null = null;
  if (bad && c.bestUci && c.bestUci !== uci && c.bestPv.length) {
    const bestSan = sanOf(fenBefore, c.bestUci);
    let bf: MoveFacts | null = null;
    try { bf = analyzeMove(fenBefore, c.bestUci); } catch { bf = null; }
    const bestKey = bf?.motifs.find((m) => ['checkmate', 'fork', 'pin', 'skewer', 'discovered-check', 'discovered-attack', 'wins-hanging', 'mate-threat', 'back-rank', 'promotion', 'castles'].includes(m.kind));
    const steps = buildLine('best', fenBefore, c.bestPv, 'you', demoLength(fenBefore, c.bestPv, me));
    const bm = materialAlongLine(fenBefore, c.bestPv, me, 8);
    best = {
      kind: 'best',
      title: `Better was ${bestSan}`,
      intro: `${bestSan} keeps ${c.winBest.toFixed(0)}% winning chances (${formatScore(c.scoreBest)}), against ${c.winAfter.toFixed(0)}% after ${san}.${bestKey ? ` ${bestKey.text}` : ''}`,
      startFen: fenBefore,
      startMark: mk([[c.bestUci.slice(0, 2), c.bestUci.slice(2, 4), 'better']], (bestKey?.squares ?? []).filter((sq) => sq !== c.bestUci!.slice(2, 4)).map((sq) => [sq, 'concept'] as [string, Tone])),
      steps,
      summary: bm.delta >= 1 ? `This line wins ${worth(bm.delta)} within ${Math.ceil(bm.plies / 2)} moves.` : `The difference is ${c.epl.toFixed(0)} expected points out of 100.`,
    };
    const playedMat = materialAlongLine(fenAfter, afterPv, me, 8);
    compare = {
      startFen: fenBefore,
      epl: c.epl,
      played: { san, uci, score: c.scoreAfter, win: c.winAfter, line: formatLine(fenAfter, pvToSan(fenAfter, afterPv, 6)), material: playedMat.delta + (f.move.captured ? VALUE[f.move.captured as PieceType] : 0), plies: playedMat.plies },
      best: { san: bestSan, uci: c.bestUci, score: c.scoreBest, win: winPercentPov(c.scoreBest, me), line: formatLine(fenBefore, pvToSan(fenBefore, c.bestPv, 6)), material: bm.delta, plies: bm.plies },
    };
  }

  return {
    kind: teachingKind,
    tone: cls === 'blunder' || cls === 'miss' ? 'bad' : cls === 'mistake' ? 'warn' : bad ? 'info' : 'good',
    headline: `${san}: ${label}`,
    label,
    points: points.slice(0, 5),
    why, best, compare,
    fenBefore, fenAfter, from: f.move.from, to: f.move.to,
  };
}

/** Should a good move get a short word of praise? Only for genuinely notable decisions. */
export function isNotable(t: Teaching, cls: Classification): boolean {
  return cls === 'brilliant' || cls === 'great' || (t.kind === 'strong' && ['best', 'excellent'].includes(cls));
}
