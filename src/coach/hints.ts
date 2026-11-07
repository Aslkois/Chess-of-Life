import { Chess } from 'chess.js';
import { NAME, type PieceType } from '../analysis/board';
import { analyzeMove, currentThreats } from '../analysis/motifs';
import type { AnalysisResult } from '../engine/controller';
import { winPercentPov } from '../engine/score';

/**
 * Progressive, conceptual hints. A hint tells the player what to investigate,
 * never which move to play: hint text is checked so it never contains the
 * recommended move, its destination square or its SAN.
 */
export interface Hint {
  level: number;
  category: 'threats' | 'forcing' | 'piece' | 'motif' | 'king' | 'quiet' | 'defense' | 'done';
  text: string;
}

export const MAX_HINT_LEVEL = 3;

export function buildHints(fen: string, analysis: AnalysisResult): Hint[] {
  const c = new Chess(fen);
  const me = c.turn();
  const best = analysis.bestmove ?? analysis.lines[0]?.pv[0];
  if (!best) return [{ level: 1, category: 'done', text: 'There are no moves to make in this position.' }];
  const facts = analyzeMove(fen, best);
  const kinds = new Set(facts.motifs.map((m) => m.kind));
  const pieceT = facts.move.piece as PieceType;
  const threats = currentThreats(fen);
  const hints: Hint[] = [];
  const bestWin = analysis.lines[0] ? winPercentPov(analysis.lines[0].score, me) : 50;
  const secondWin = analysis.lines[1] ? winPercentPov(analysis.lines[1].score, me) : undefined;
  const critical = secondWin !== undefined && bestWin - secondWin >= 15;
  const forcing = facts.move.captured || kinds.has('check') || kinds.has('discovered-check') || kinds.has('checkmate');
  const threatHandled = threats.hanging.length > 0 && !hangingAfter(facts.fenAfter, threats.hanging.map((h) => h.square));

  // Level 1: where to look
  if (threats.mateThreat) hints.push({ level: 1, category: 'defense', text: 'Check your opponent’s threats first: your king is in danger. What is your opponent threatening to do next move?' });
  else if (threatHandled) hints.push({ level: 1, category: 'threats', text: 'Before anything else, look at what your opponent is attacking. Is every one of your pieces safe?' });
  else if (kinds.has('checkmate') || kinds.has('mate-threat') || kinds.has('back-rank')) hints.push({ level: 1, category: 'king', text: 'Look at the enemy king. How many safe squares does it have?' });
  else if (forcing || kinds.has('fork') || kinds.has('pin') || kinds.has('skewer') || kinds.has('discovered-attack')) hints.push({ level: 1, category: 'forcing', text: critical ? 'This is a critical moment. Look at forcing moves first: checks, captures and threats.' : 'Look at forcing moves: checks, captures and direct threats.' });
  else if (kinds.has('castles')) hints.push({ level: 1, category: 'king', text: 'Think about your own king’s safety and the coordination of your rooks.' });
  else hints.push({ level: 1, category: 'quiet', text: 'There is no need to rush. Which of your pieces is doing the least, and where would it be more active?' });

  // Level 2: which piece / which enemy weakness
  const pieceName = NAME[pieceT];
  const sameType = c.board().flat().filter((s) => s && s.color === me && s.type === pieceT).length;
  if (threatHandled) {
    hints.push({ level: 2, category: 'threats', text: `Your ${NAME[threats.hanging[0].piece.t]} on ${threats.hanging[0].square} is not safe. Count its attackers and defenders — then decide whether to protect, move, or counter-attack.` });
  } else {
    hints.push({ level: 2, category: 'piece', text: sameType > 1 ? `Consider what your ${pieceName}s can do from where they stand.` : `Consider what your ${pieceName} can do from where it stands.` });
  }

  // Level 3: the idea (motif) without the move
  const motifText = (() => {
    if (kinds.has('checkmate')) return 'There is a way to end the game right now. Check every check you have.';
    if (kinds.has('fork')) return `Look for a square where your ${pieceName} would attack two important targets at once.`;
    if (kinds.has('discovered-check') || kinds.has('discovered-attack')) return 'One of your long-range pieces is hidden behind another of your pieces. What happens if the front piece moves with a threat?';
    if (kinds.has('pin')) return 'An enemy piece stands in front of a more valuable one on the same line. Can you exploit that line?';
    if (kinds.has('skewer')) return 'A valuable enemy piece stands on a line with another piece behind it.';
    if (kinds.has('wins-hanging')) return 'Not every enemy piece is adequately defended. Count attackers and defenders on each enemy piece.';
    if (kinds.has('mate-threat') || kinds.has('back-rank')) return 'The enemy king’s escape squares are limited. Can you add a threat against it?';
    if (kinds.has('sacrifice')) return 'The strongest idea may involve giving up material for something more valuable — think about what you would get in return.';
    if (kinds.has('promotion') || kinds.has('passed-pawn')) return 'Pawns become very strong as they approach promotion. What can your most advanced pawn do?';
    if (kinds.has('castles')) return 'Getting your king to safety may be more important than anything else right now.';
    if (threatHandled) return 'Sometimes the best defence also improves your position or creates a threat of its own.';
    return 'Look for a move that improves your position while limiting your opponent’s most active piece.';
  })();
  hints.push({ level: 3, category: 'motif', text: motifText });
  return hints.map((h) => ({ ...h, text: sanitize(h.text, fen, best, facts.move.san) }));
}

function hangingAfter(fenAfter: string, squares: string[]): boolean {
  // after our move it is the opponent's turn; check whether our previously hanging pieces are still hanging
  try {
    const t = currentThreatsForMover(fenAfter);
    return squares.some((s) => t.includes(s));
  } catch {
    return true;
  }
}

function currentThreatsForMover(fenAfter: string): string[] {
  // the side that just moved is "not to move" in fenAfter
  const parts = fenAfter.split(' ');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-';
  return currentThreats(parts.join(' ')).hanging.map((h) => h.square);
}

/** Remove anything that would reveal the move (destination square, SAN). */
export function sanitize(text: string, _fen: string, bestUci: string, bestSan: string): string {
  let t = text;
  const to = bestUci.slice(2, 4);
  const sanCore = bestSan.replace(/[+#]/g, '');
  if (sanCore.length >= 2) t = t.split(sanCore).join('a strong move');
  t = t.replace(new RegExp(`\\b${to}\\b`, 'g'), 'a key square');
  return t;
}

export function hintRevealsMove(text: string, bestUci: string, bestSan: string): boolean {
  const to = bestUci.slice(2, 4);
  const sanCore = bestSan.replace(/[+#]/g, '');
  return new RegExp(`\\b${to}\\b`).test(text) || text.includes(sanCore);
}
