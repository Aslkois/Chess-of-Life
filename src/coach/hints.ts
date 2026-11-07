import { Chess } from 'chess.js';
import {
  castlingRights, doubledFiles, isolatedPawns, kingPressure, looksCastled, materialBalance, NAME, openFiles, other, outposts, parseBoard,
  passedPawns, sqName, undevelopedMinors, type Color, type PieceType,
} from '../analysis/board';
import { analyzeMove, currentThreats } from '../analysis/motifs';
import type { AnalysisResult } from '../engine/controller';
import { winPercentPov } from '../engine/score';

/**
 * Pre-move hints. They tell the player what to investigate, never which move
 * to play: every hint is checked so it does not contain the recommended
 * move's SAN, its destination square, or (for line pieces) its destination
 * file. Hints are unlimited: the position-specific ones come first, then
 * general calculation techniques (labelled as such), then a review of the
 * earlier hints. Nothing is invented to fill the list.
 */
export type HintKind = 'position' | 'technique' | 'review';
export interface Hint {
  id: string;
  kind: HintKind;
  category: string;
  text: string;
}

export interface HintContext {
  /** the opponent's last move, if any */
  lastMove?: { san: string; from: string; to: string };
  /** ply index (0-based) of the decision */
  ply?: number;
}

export const TECHNIQUES: { id: string; text: string }[] = [
  { id: 'cct', text: 'Checks, captures, threats: list every forcing move you have, then every forcing move your opponent would have after it.' },
  { id: 'blunder-check', text: 'Blunder check: for the move you are considering, ask what each enemy piece could attack or capture right afterwards.' },
  { id: 'opponent-view', text: 'Look at the board from your opponent’s side: what would you play next if it were their move?' },
  { id: 'candidates', text: 'Write down two or three candidate moves before calculating any of them, then compare where each leaves your weakest piece and your king.' },
];

export function revealsMove(text: string, bestUci: string, bestSan: string, pieceT?: PieceType): boolean {
  const to = bestUci.slice(2, 4);
  const sanCore = bestSan.replace(/[+#!?]/g, '');
  if (new RegExp(`\\b${to}\\b`).test(text)) return true;
  if (sanCore.length >= 2 && text.includes(sanCore)) return true;
  if (pieceT && ['r', 'q'].includes(pieceT) && new RegExp(`\\b${to[0]}-file\\b`).test(text)) return true;
  return false;
}
/** @deprecated name kept for existing callers */
export const hintRevealsMove = (text: string, bestUci: string, bestSan: string) => revealsMove(text, bestUci, bestSan);

const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** Position-specific hints, most useful first. */
export function buildHints(fen: string, analysis: AnalysisResult, hctx: HintContext = {}): Hint[] {
  const c = new Chess(fen);
  const me = c.turn() as Color;
  const best = analysis.bestmove ?? analysis.lines[0]?.pv[0];
  if (!best) return [{ id: 'none', kind: 'position', category: 'none', text: 'There are no moves to make in this position.' }];
  const facts = analyzeMove(fen, best);
  const kinds = new Set(facts.motifs.map((m) => m.kind));
  const pieceT = facts.move.piece as PieceType;
  const b = parseBoard(fen);
  const threats = currentThreats(fen);
  const bestWin = analysis.lines[0] ? winPercentPov(analysis.lines[0].score, me) : 50;
  const secondWin = analysis.lines[1] ? winPercentPov(analysis.lines[1].score, me) : undefined;
  const critical = secondWin !== undefined && bestWin - secondWin >= 15;
  const forcing = !!facts.move.captured || kinds.has('check') || kinds.has('discovered-check') || kinds.has('checkmate');
  const out: Hint[] = [];
  const add = (id: string, category: string, text: string) => out.push({ id, kind: 'position', category, text });

  // 1. threats against you
  if (threats.mateThreat) add('mate-threat', 'threats', 'Check your opponent’s threats first: your king is in danger. What is your opponent threatening to play next?');
  else if (threats.hanging.length) {
    const h = threats.hanging[0];
    add('hanging', 'threats', `Before anything else, look at what your opponent is attacking. Your ${NAME[h.piece.t]} on ${h.square} is not safe: count its attackers and defenders.`);
  }

  // 2. where to look
  if (kinds.has('checkmate') || kinds.has('mate-threat') || kinds.has('back-rank')) add('enemy-king', 'king', 'Look at the enemy king. How many safe squares does it have?');
  else if (forcing || kinds.has('fork') || kinds.has('pin') || kinds.has('skewer') || kinds.has('discovered-attack')) add('forcing', 'tactics', critical ? 'This is a critical moment. Look at forcing moves first: checks, captures and direct threats.' : 'Look at forcing moves: checks, captures and direct threats.');
  else if (kinds.has('castles')) add('own-king', 'king', 'Think about your own king’s safety and connecting your rooks.');
  else add('quiet', 'plan', 'There is no need to rush. Which of your pieces is doing the least, and where would it be more active?');

  // 3. the opponent's last move
  if (hctx.lastMove) add('last-move', 'opponent', `Your opponent just played ${hctx.lastMove.san}. What does that piece attack now, and what did it stop defending on ${hctx.lastMove.from}?`);

  // 4. which piece
  const sameType = c.board().flat().filter((s) => s && s.color === me && s.type === pieceT).length;
  add('piece', 'piece', sameType > 1 ? `Consider what your ${NAME[pieceT]}s can do from where they stand.` : `Consider what your ${NAME[pieceT]} can do from where it stands.`);

  // 5. counts of forcing moves (verified by enumeration)
  const moves = c.moves({ verbose: true });
  const checks = moves.filter((m) => m.san.includes('+') || m.san.includes('#')).length;
  const captures = moves.filter((m) => m.captured).length;
  add('counts', 'calculation', `You have ${checks} check${checks === 1 ? '' : 's'} and ${captures} capture${captures === 1 ? '' : 's'} available. Have you looked at every one of them?`);

  // 6. the idea
  const idea = (() => {
    if (kinds.has('checkmate')) return 'There is a way to end the game right now. Go through every check you have.';
    if (kinds.has('fork')) return `Look for a square where your ${NAME[pieceT]} would attack two important targets at once.`;
    if (kinds.has('discovered-check') || kinds.has('discovered-attack')) return 'One of your long-range pieces is hidden behind another of your pieces. What happens if the front piece moves with a threat?';
    if (kinds.has('pin')) return 'An enemy piece stands in front of a more valuable one on the same line. Can you exploit that line?';
    if (kinds.has('skewer')) return 'A valuable enemy piece stands on a line with another piece behind it.';
    if (kinds.has('wins-hanging')) return 'Not every enemy piece is adequately defended. Count attackers and defenders on each enemy piece.';
    if (kinds.has('mate-threat') || kinds.has('back-rank')) return 'The enemy king’s escape squares are limited. Can you add a threat against it?';
    if (kinds.has('sacrifice')) return 'The strongest idea may involve giving up material. Think about what you would get in return.';
    if (kinds.has('promotion') || kinds.has('passed-pawn')) return 'Pawns become very strong as they approach promotion. What can your most advanced pawn do?';
    if (kinds.has('castles')) return 'Getting your king to safety may be more important than anything else right now.';
    return null;
  })();
  if (idea) add('idea', 'tactics', idea);

  // 7. king safety
  const onMine = kingPressure(b, me);
  const onTheirs = kingPressure(b, other(me));
  if (onMine.length >= 2) add('king-pressure', 'king', `${onMine.length} enemy pieces (on ${list(onMine)}) aim at the squares around your king. Is it safe enough?`);
  if (onTheirs.length >= 2) add('attack', 'king', `${onTheirs.length} of your pieces (on ${list(onTheirs)}) already aim at the squares around the enemy king.`);

  // 8. development
  if ((hctx.ply ?? 99) <= 24) {
    const undev = undevelopedMinors(b, me);
    const castled = looksCastled(b, me);
    if (undev.length || (!castled && castlingRights(fen, me))) {
      add('development', 'development', `${undev.length ? `Your ${list(undev.map((sq) => `${NAME[b[(sq.charCodeAt(0) - 97) + (Number(sq[1]) - 1) * 8]!.t]} on ${sq}`))} ${undev.length === 1 ? 'has' : 'have'} not moved yet` : 'Your pieces are developed'}${!castled && castlingRights(fen, me) ? ', and your king has not castled' : ''}. Development and king safety come before adventures.`);
    }
  }

  // 9. pawn structure
  const myPassed = passedPawns(b, me).map(sqName);
  const theirPassed = passedPawns(b, other(me)).map(sqName);
  if (myPassed.length) add('passed', 'pawns', `You have a passed pawn on ${list(myPassed)}. No enemy pawn can stop it.`);
  if (theirPassed.length) add('their-passed', 'pawns', `Your opponent has a passed pawn on ${list(theirPassed)}. Keep an eye on the squares in front of it.`);
  const iso = isolatedPawns(b, me);
  const dbl = doubledFiles(b, me);
  if (iso.length || dbl.length) add('weak-pawns', 'pawns', `Your pawn structure has weaknesses${iso.length ? `: isolated pawn${iso.length > 1 ? 's' : ''} on ${list(iso)}` : ''}${dbl.length ? `${iso.length ? ';' : ':'} doubled pawns on the ${list(dbl)}-file` : ''}. Avoid creating more, and keep them defended.`);

  // 10. files and squares
  const files = openFiles(b, me);
  if (files.open.length) add('open-files', 'files', `The ${list(files.open.map((f) => `${f}-file`))} ${files.open.length === 1 ? 'is' : 'are'} open: no pawns block ${files.open.length === 1 ? 'it' : 'them'}. Open files are highways for rooks and queens.`);
  const posts = outposts(b, me);
  if (posts.length) add('outposts', 'squares', `${list(posts)} ${posts.length === 1 ? 'is an outpost' : 'are outposts'} for you: no enemy pawn can ever attack ${posts.length === 1 ? 'it' : 'them'}, and your pawn supports ${posts.length === 1 ? 'it' : 'them'}. Knights love such squares.`);

  // 11. material and the state of the game
  const mat = materialBalance(b) * (me === 'w' ? 1 : -1);
  if (mat >= 2) add('material', 'plan', `You are ahead by ${mat} pawns of material. Trading pieces (not pawns) usually helps the side that is ahead.`);
  else if (mat <= -2) add('material', 'plan', `You are behind by ${-mat} pawns of material. Look for activity and threats rather than waiting.`);
  if (bestWin < 35) add('defend', 'defense', 'Your position is difficult. Look for the move that stops your opponent’s main idea, or creates the most problems for them.');

  return out.filter((h) => !revealsMove(h.text, best, facts.move.san, pieceT));
}

/**
 * The hint for the n-th request (0-based): position hints first, then
 * techniques, then a review cycling through the earlier position hints.
 */
export function hintAt(position: Hint[], n: number): Hint {
  if (n < position.length) return position[n];
  const t = n - position.length;
  if (t < TECHNIQUES.length) return { id: `technique-${TECHNIQUES[t].id}`, kind: 'technique', category: 'technique', text: TECHNIQUES[t].text };
  const r = (t - TECHNIQUES.length) % Math.max(1, position.length);
  const again = position[r];
  return {
    id: `review-${t}`,
    kind: 'review',
    category: 'review',
    text: again ? `That is everything I can say about this position without giving the move away. Look again at hint ${r + 1}: ${again.text}` : 'That is everything I can say about this position without giving the move away.',
  };
}
