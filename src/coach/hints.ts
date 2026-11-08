import { Chess } from 'chess.js';
import { attacks, NAME, parseBoard, sqName, type Color, type PieceType } from '../analysis/board';
import { analyzeMove, currentThreats, type Motif, type MoveFacts } from '../analysis/motifs';
import { formatLine, materialAlongLine, pvToSan } from '../analysis/explain';
import type { AnalysisResult } from '../engine/controller';
import { formatScore, povCp, winPercentPov } from '../engine/score';
import { positionKey } from '../chess/positionKey';

/**
 * Hints in three stages per position, all about the same engine-verified best
 * move (the top line of the analysis the Coach rates moves with):
 *
 *   1. Strategic advice: what to look for, without naming the piece or the
 *      destination.
 *   2. Which piece: the piece to move (highlighted), not where it goes.
 *   3. Best move: the move itself with its squares and why it works.
 *
 * After stage 3 there is nothing more for that position. A new position gets
 * three new stages, so hints are unlimited across the game.
 */
export type HintStage = 1 | 2 | 3;
export const MAX_STAGE: HintStage = 3;
export interface StagedHint {
  stage: HintStage;
  title: string;
  text: string;
  /** squares to highlight on the board */
  squares: string[];
  /** stage 3: the best move as an arrow */
  arrow?: [string, string];
}
export interface HintPlan {
  key: string;
  fen: string;
  bestUci: string;
  bestSan: string;
  stages: [StagedHint, StagedHint, StagedHint];
}

/** Does `text` give away the destination of the move (square, SAN, or the file of a rook/queen move)? */
export function revealsMove(text: string, bestUci: string, bestSan: string, pieceT?: PieceType): boolean {
  const to = bestUci.slice(2, 4);
  const sanCore = bestSan.replace(/[+#!?]/g, '');
  if (new RegExp(`\\b${to}\\b`).test(text)) return true;
  if (sanCore.length >= 2 && text.includes(sanCore)) return true;
  if (pieceT && ['r', 'q'].includes(pieceT) && new RegExp(`\\b${to[0]}-file\\b`).test(text)) return true;
  return false;
}

/** Does `text` name the piece that moves or the square it starts from? */
export function revealsPiece(text: string, bestUci: string, pieceT: PieceType): boolean {
  const from = bestUci.slice(0, 2);
  if (new RegExp(`\\b${from}\\b`).test(text)) return true;
  const n = NAME[pieceT];
  return new RegExp(`\\b${n}s?\\b`, 'i').test(text) || (pieceT === 'k' && /\bking\b/i.test(text));
}

const plyOf = (fen: string) => { const p = fen.split(' '); return (Number(p[5] ?? 1) - 1) * 2 + (p[1] === 'b' ? 1 : 0); };

const CENTRE = ['d4', 'e4', 'd5', 'e5', 'c4', 'c5', 'f4', 'f5'];

/** Concrete, board-verified effects of a quiet move: development, central control, lines opened. */
function quietEffects(fen: string, facts: MoveFacts, me: Color): { develops: boolean; centre: string[]; opens: { piece: PieceType; sq: string } | null } {
  const b0 = parseBoard(fen);
  const b1 = parseBoard(facts.fenAfter);
  const pieceT = facts.move.piece as PieceType;
  const home = me === 'w' ? '1' : '8';
  const develops = (pieceT === 'n' || pieceT === 'b') && facts.move.from[1] === home;
  const controlled = (b: typeof b0) => {
    const set = new Set<string>();
    b.forEach((p, i) => { if (p && p.c === me) for (const t of attacks(b, i)) set.add(sqName(t)); });
    return set;
  };
  const before = controlled(b0);
  const after = controlled(b1);
  const centre = CENTRE.filter((sq) => after.has(sq) && !before.has(sq));
  let opens: { piece: PieceType; sq: string } | null = null;
  let gain = 1;
  b1.forEach((p, i) => {
    if (!p || p.c !== me || !['b', 'r', 'q'].includes(p.t) || sqName(i) === facts.move.to) return;
    const was = b0[i] && b0[i]!.t === p.t ? attacks(b0, i).length : 0;
    const now = attacks(b1, i).length;
    if (now - was > gain) { gain = now - was; opens = { piece: p.t, sq: sqName(i) }; }
  });
  return { develops, centre, opens };
}

const IMPORTANT: Motif['kind'][] = ['checkmate', 'fork', 'pin', 'skewer', 'discovered-check', 'discovered-attack', 'wins-hanging', 'mate-threat', 'back-rank', 'sacrifice', 'promotion', 'castles', 'passed-pawn'];

/** Stage 1: one conceptual cue grounded in the best move's verified features. */
function strategic(fen: string, facts: MoveFacts, analysis: AnalysisResult, me: Color): string {
  const kinds = new Set(facts.motifs.map((m) => m.kind));
  const top = analysis.lines[0];
  const second = analysis.lines[1];
  const winBest = top ? winPercentPov(top.score, me) : 50;
  const gap = top && second ? winBest - winPercentPov(second.score, me) : 0;
  const mateIn = top?.score.mate !== undefined && top.score.mate !== 0 && (me === 'w' ? top.score.mate > 0 : top.score.mate < 0) ? Math.abs(top.score.mate) : null;
  const threats = currentThreats(fen);
  const moved = facts.move.from;
  let cue: string;
  if (kinds.has('checkmate')) cue = 'You can end the game with this move. Go through every check you have and ask which one leaves the enemy king no escape.';
  else if (mateIn !== null && mateIn <= 5) cue = `There is a forced checkmate in ${mateIn}. Start with the most forcing moves: checks first, then captures.`;
  else if (threats.mateThreat && !kinds.has('check')) cue = 'Your opponent is threatening checkmate. Before anything else, find the move that stops it.';
  else if (threats.hanging.some((h) => h.square === moved) && !facts.move.captured) cue = 'One of your pieces is attacked and not defended well enough. Find it and deal with the threat before looking for anything else.';
  else if (threats.hanging.length && !facts.move.captured && !kinds.has('check')) cue = 'Your opponent is attacking something of yours. Check what is under attack, and whether you can defend it or answer with a stronger threat.';
  else if (kinds.has('fork')) cue = 'One move can attack two important targets at the same time. Look for a square from which you would hit two enemy pieces, or a piece and the king, at once.';
  else if (kinds.has('discovered-check') || kinds.has('discovered-attack')) cue = 'One of your long-range pieces is hidden behind another of your pieces. Moving the front piece with a threat of its own can uncover a second attack.';
  else if (kinds.has('pin')) cue = 'An enemy piece stands in front of a more valuable one on the same line. Use that line.';
  else if (kinds.has('skewer')) cue = 'A valuable enemy piece stands on a line with another piece behind it. Attack along that line.';
  else if (kinds.has('wins-hanging')) cue = 'Not every enemy piece is properly defended. Count attackers and defenders on each enemy piece: one of them can be won.';
  else if (kinds.has('mate-threat') || kinds.has('back-rank')) cue = 'The enemy king is short of escape squares. Look for a move that creates a direct threat against it.';
  else if (kinds.has('sacrifice')) cue = 'The strongest idea gives up material for something more valuable: an attack, or a decisive follow-up. Calculate what you get in return.';
  else if (kinds.has('promotion') || kinds.has('passed-pawn')) cue = 'Promotion decides this position. Think about the race to the last rank and what can stop it.';
  else if (kinds.has('castles')) cue = 'King safety comes first here: your king is still in the centre and your rooks are not connected.';
  else if (facts.move.captured) cue = 'Material is at stake. Look carefully at the captures available and what each one leaves behind.';
  else {
    const fx = quietEffects(fen, facts, me);
    if (fx.develops) cue = 'Development comes first: bring a piece that has not moved yet into play, towards the centre.';
    else if (fx.centre.length >= 1 && plyOf(fen) <= 24) cue = 'Fight for the centre: look for the move that gives you control of more central squares.';
    else if (fx.opens) cue = 'One of your long-range pieces is boxed in. Look for the move that opens a line for it.';
    else cue = 'No forcing tactic is needed. Improve your least active piece or take control of an important square, and check that the move leaves nothing undefended.';
  }
  const context = gap >= 15 ? ' This is a critical moment: the best move is clearly better than the alternatives.'
    : winBest >= 80 ? ' You are clearly better; keep it simple and safe.'
    : winBest <= 25 ? ' Your position is difficult; look for the most resilient move.' : '';
  return cue + context;
}

export function buildHintPlan(fen: string, analysis: AnalysisResult): HintPlan | null {
  const c = new Chess(fen);
  const me = c.turn() as Color;
  const best = analysis.lines[0]?.pv[0] ?? analysis.bestmove;
  if (!best) return null;
  let facts: MoveFacts;
  try { facts = analyzeMove(fen, best); } catch { return null; }
  const pieceT = facts.move.piece as PieceType;
  const from = facts.move.from;
  const to = facts.move.to;
  const san = facts.move.san;

  let s1 = strategic(fen, facts, analysis, me);
  if (revealsMove(s1, best, san, pieceT) || revealsPiece(s1, best, pieceT)) s1 = 'Look at checks, captures and threats for both sides, then compare your two or three best candidate moves.';

  const pieceName = pieceT === 'k' ? 'king' : NAME[pieceT];
  const s2 = `Move your ${pieceName} on ${from}. Where can it go to carry out the idea from the first hint?`;

  const key = facts.motifs.filter((m) => IMPORTANT.includes(m.kind)).sort((a, b) => IMPORTANT.indexOf(a.kind) - IMPORTANT.indexOf(b.kind)).slice(0, 2).map((m) => m.text);
  const top = analysis.lines[0];
  const pv = top?.pv.length ? top.pv : [best];
  const mat = materialAlongLine(fen, pv, me, 8);
  const why: string[] = [...key];
  if (top?.score.mate !== undefined && top.score.mate !== 0) why.push(`It forces checkmate in ${Math.abs(top.score.mate)}.`);
  else if (mat.delta >= 1 && !key.some((k) => /wins material/.test(k))) why.push(`The engine line wins about ${mat.delta} pawn${mat.delta === 1 ? '' : 's'} of material.`);
  if (!why.length) {
    const fx = quietEffects(fen, facts, me);
    if (fx.develops) why.push(`It develops your ${NAME[pieceT]} towards the centre.`);
    if (fx.centre.length) why.push(`It takes control of ${fx.centre.slice(0, 3).join(', ')}.`);
    if (fx.opens) why.push(`It opens a line for your ${NAME[fx.opens.piece]} on ${fx.opens.sq}.`);
    const second = analysis.lines.find((l) => l.pv[0] && l.pv[0] !== best);
    if (top && second) {
      const diff = (povCp(top.score, me) - povCp(second.score, me)) / 100;
      const san2 = pvToSan(fen, [second.pv[0]], 1)[0];
      if (diff >= 0.15 && san2) why.push(`The engine's next choice, ${san2}, is ${diff.toFixed(diff >= 1 ? 1 : 2)} pawns worse.`);
      else if (san2) why.push(`It is a small edge: ${san2} is almost as good.`);
    }
    if (!why.length) why.push('It is the engine’s first choice; no single tactic decides it.');
  }
  const line = formatLine(fen, pvToSan(fen, pv, 6));
  const s3 = `${san}. ${why.join(' ')} Engine line: ${line}${top ? ` (${formatScore(top.score)}, White's view).` : '.'}`;

  return {
    key: positionKey(fen),
    fen,
    bestUci: best,
    bestSan: san,
    stages: [
      { stage: 1, title: 'Strategic advice', text: s1, squares: [] },
      { stage: 2, title: 'Which piece?', text: s2, squares: [from] },
      { stage: 3, title: 'Best move', text: s3, squares: [from, to], arrow: [from, to] },
    ],
  };
}

/** Per-position hint progress: resets when the position changes. */
export interface HintProgress { key: string; stage: 0 | HintStage }
export function progressFor(p: HintProgress | null, fen: string): HintProgress {
  const key = positionKey(fen);
  return p && p.key === key ? p : { key, stage: 0 };
}
export function nextStage(p: HintProgress): HintProgress {
  return p.stage >= MAX_STAGE ? p : { ...p, stage: (p.stage + 1) as HintStage };
}
