import { Chess } from 'chess.js';
import { formatScore, povCp, type Score } from '../engine/score';
import { materialBalance, parseBoard, type Color } from './board';
import { CLASS_INFO, type Classification, type MoveClassification } from './classify';
import { analyzeMove, type Motif, type MotifKind } from './motifs';

/** Convert a UCI line to SAN, stopping at the first illegal move (never shows illegal moves). */
export function pvToSan(fen: string, pv: string[], max = 12): string[] {
  const c = new Chess(fen);
  const out: string[] = [];
  for (const u of pv.slice(0, max)) {
    try {
      const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      out.push(m.san);
    } catch {
      break;
    }
  }
  return out;
}

export function uciToSan(fen: string, uci: string | null): string | null {
  if (!uci) return null;
  return pvToSan(fen, [uci], 1)[0] ?? null;
}

/** Format a SAN line with move numbers starting at the position `fen`. */
export function formatLine(fen: string, sans: string[]): string {
  const parts = fen.split(' ');
  let moveNo = parseInt(parts[5] ?? '1', 10) || 1;
  let white = parts[1] === 'w';
  const out: string[] = [];
  sans.forEach((s, i) => {
    if (white) out.push(`${moveNo}.`);
    else if (i === 0) out.push(`${moveNo}...`);
    out.push(s);
    if (!white) moveNo++;
    white = !white;
  });
  return out.join(' ');
}

/**
 * Material change (pawns, from `color`'s view) after following an engine line
 * until it reaches a quiet point (no capture/check on the last move) or `max` plies.
 * This is how material claims are verified rather than inferred from scores.
 */
/**
 * Material change for `color` along a line, measured at quiet positions (no
 * capture, promotion or check pending) so that exchanges in progress do not
 * count. `plies` is how far into the line that final balance is first reached.
 */
export function materialAlongLine(fen: string, pv: string[], color: Color, max = 10): { delta: number; plies: number } {
  const c = new Chess(fen);
  const start = materialBalance(parseBoard(fen));
  const pov = (d: number) => (color === 'w' ? d : -d);
  let plies = 0;
  const quiet: { delta: number; plies: number }[] = [];
  for (const u of pv.slice(0, max)) {
    let m;
    try { m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch { break; }
    plies++;
    if (!m.captured && !m.promotion && !c.inCheck()) quiet.push({ delta: pov(materialBalance(parseBoard(c.fen())) - start), plies });
  }
  if (!quiet.length) return plies ? { delta: pov(materialBalance(parseBoard(c.fen())) - start), plies } : { delta: 0, plies: 0 };
  const final = quiet[quiet.length - 1];
  let i = quiet.length - 1;
  while (i > 0 && quiet[i - 1].delta === final.delta) i--;
  // a level line has not "reached" anything: report its full length
  return final.delta === 0 ? final : { delta: final.delta, plies: quiet[i].plies };
}

const IMPORTANT: MotifKind[] = ['checkmate', 'fork', 'pin', 'skewer', 'discovered-check', 'discovered-attack', 'mate-threat', 'back-rank', 'wins-hanging', 'sacrifice', 'defender-removed', 'hanging-left', 'threat-ignored', 'overloaded-defender', 'promotion', 'passed-pawn', 'king-exposure', 'castles'];

function rankMotifs(m: Motif[]): Motif[] {
  return [...m].filter((x) => IMPORTANT.includes(x.kind)).sort((a, b) => IMPORTANT.indexOf(a.kind) - IMPORTANT.indexOf(b.kind));
}

const pawnsText = (n: number) => `${n} pawn${Math.abs(n) === 1 ? '' : 's'}`;

/** Full explanation for Game Review (may reveal best moves and lines). */
export function explainForReview(fenBefore: string, uci: string, color: Color, c: MoveClassification, cls: Classification, afterPv: string[]): string[] {
  const out: string[] = [];
  const san = uciToSan(fenBefore, uci) ?? uci;
  const info = CLASS_INFO[cls];
  out.push(`${san} is ${/^[AEIOU]/.test(info.label) ? 'an' : 'a'} ${info.label.toLowerCase()} move. Evaluation ${formatScore(c.scoreBest)} → ${formatScore(c.scoreAfter)} (White's view), expected points lost: ${c.epl.toFixed(1)}.`);
  if (c.forced) { out.push('It was the only legal move.'); return out; }
  for (const n of c.notes) out.push(n);

  const played = rankMotifs(c.motifs).slice(0, 3);
  for (const m of played) out.push(m.text);

  let fenAfter: string;
  try { fenAfter = analyzeMove(fenBefore, uci).fenAfter; } catch { return out; }

  let explained = played.length > 0;
  const mateAgainst = (c.scoreAfter.mate !== undefined || c.scoreAfter.mated !== undefined) && povCp(c.scoreAfter, color) < 0;
  if (c.epl >= 5 && afterPv.length) {
    // what does the opponent get?
    const replySan = uciToSan(fenAfter, afterPv[0]);
    try {
      const reply = analyzeMove(fenAfter, afterPv[0]);
      const rm = rankMotifs(reply.motifs).filter((m) => m.kind !== 'castles' && m.kind !== 'passed-pawn').slice(0, 2);
      if (replySan && rm.length) {
        explained = true;
        out.push(rm[0].kind === 'checkmate' ? `It allows ${replySan}, which is checkmate.` : `The strongest reply is ${replySan}: ${rm.map((m) => m.text).join(' ')}`);
      }
    } catch { /* ignore */ }
    if (mateAgainst && c.scoreAfter.mate !== undefined && Math.abs(c.scoreAfter.mate) > 1) {
      explained = true;
      out.push(`It allows a forced mate in ${Math.abs(c.scoreAfter.mate)}.`);
    } else if (!mateAgainst) {
      const mat = materialAlongLine(fenAfter, afterPv, color);
      if (mat.delta <= -1) { explained = true; out.push(`Following the engine's best line, you would be down about ${pawnsText(-mat.delta)} of material after ${mat.plies} plies.`); }
    }
  }

  if (c.bestUci && c.bestUci !== uci && c.epl >= 2) {
    const bestSan = uciToSan(fenBefore, c.bestUci);
    const line = formatLine(fenBefore, pvToSan(fenBefore, c.bestPv, 8));
    try {
      const bf = analyzeMove(fenBefore, c.bestUci);
      const bm = rankMotifs(bf.motifs).slice(0, 2);
      out.push(`Better was ${bestSan} (${formatScore(c.scoreBest)}).${bm.length ? ' ' + bm.map((m) => m.text).join(' ') : ''}`);
      const mat = materialAlongLine(fenBefore, c.bestPv, color);
      if (mat.delta >= 1 && !bm.some((m) => m.kind === 'wins-hanging')) out.push(`The engine line gains about ${pawnsText(mat.delta)} of material within ${mat.plies} plies.`);
    } catch { /* ignore */ }
    out.push(`Engine line: ${line}`);
    if (!explained && c.epl >= 10) out.push('No single tactical motif explains the difference; compare the two lines to see how the position changes.');
  }
  return out;
}

export interface CoachFeedback {
  headline: string;
  lines: string[];
  severity: 'info' | 'warn' | 'bad';
}

/**
 * Coaching feedback after the player's move. It names what went wrong in
 * concepts, never the better move or the opponent's exact refutation.
 */
export function coachFeedback(fenBefore: string, uci: string, color: Color, c: MoveClassification, cls: Classification, afterPv: string[]): CoachFeedback {
  const san = uciToSan(fenBefore, uci) ?? uci;
  const label = CLASS_INFO[cls].label;
  const lines: string[] = [];
  let facts;
  try { facts = analyzeMove(fenBefore, uci); } catch { return { headline: `${san} — ${label}`, lines, severity: 'info' }; }
  const kinds = new Set(facts.motifs.map((m) => m.kind));
  if (facts.immediateMaterial > 0 && facts.move.captured) lines.push(`You won ${facts.immediateMaterial >= 3 ? 'material' : 'a pawn'}${kinds.has('defender-removed') || kinds.has('hanging-left') ? ', but' : '.'}`);
  if (kinds.has('defender-removed')) lines.push('The piece you moved was an important defender — something it protected is now loose.');
  else if (kinds.has('hanging-left')) lines.push('One of your pieces is no longer adequately protected after this move.');
  if (kinds.has('threat-ignored')) lines.push('Your opponent already had a threat against one of your pieces, and this move does not deal with it.');
  if (kinds.has('king-exposure')) lines.push('This pawn move weakens the shelter around your king.');

  if (afterPv.length) {
    try {
      const reply = analyzeMove(facts.fenAfter, afterPv[0]);
      const rk = new Set(reply.motifs.map((m) => m.kind));
      if (rk.has('checkmate')) lines.push('Your king can now be checkmated immediately. Look at every check your opponent has.');
      else if (rk.has('mate-threat') || rk.has('back-rank')) lines.push('Your opponent can now build a direct attack on your king. Check your king’s escape squares.');
      else if (rk.has('fork')) lines.push('Your opponent now has a double attack available. Look at which of your pieces can be attacked at the same time.');
      else if (rk.has('pin') || rk.has('skewer')) lines.push('Watch the lines (files, ranks and diagonals) your opponent’s long-range pieces can use against your pieces.');
      else if (rk.has('wins-hanging') || rk.has('discovered-attack')) lines.push('Consider what your opponent can attack or capture now — count attackers and defenders.');
    } catch { /* ignore */ }
    const mat = materialAlongLine(facts.fenAfter, afterPv, color);
    if (mat.delta <= -2 && lines.length < 3) lines.push(`With best play your opponent comes out about ${pawnsText(-mat.delta)} ahead in material.`);
  }
  if (cls === 'miss') lines.push('Your opponent’s last move gave you a chance. Before moving, ask: what did their move leave undefended?');
  if (!lines.length) {
    const swing = Math.round((povCp(c.scoreBest, color) - povCp(c.scoreAfter, color)) / 10) / 10;
    lines.push(`This lets the evaluation drop by about ${swing > 50 ? 'a decisive amount' : `${swing} pawns`}. Look for a more purposeful move.`);
  }
  return { headline: `${san} — ${label}`, lines, severity: cls === 'blunder' || cls === 'miss' ? 'bad' : cls === 'mistake' ? 'warn' : 'info' };
}

export function scoreSummary(s: Score | undefined): string {
  return formatScore(s);
}
