import { Chess } from 'chess.js';
import type { AnalysisResult } from '../src/engine/controller';
import type { Score } from '../src/engine/score';

/** Build an AnalysisResult with White-POV scores. Moves given in SAN or UCI. */
export function res(fen: string, lines: [string, Score][], depth = 16): AnalysisResult {
  const c = new Chess(fen);
  const toUci = (m: string) => {
    if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m)) return m;
    const mv = new Chess(fen).move(m);
    return mv.from + mv.to + (mv.promotion ?? '');
  };
  void c;
  return {
    fen, key: fen, depth, bestmove: lines[0] ? toUci(lines[0][0]) : null,
    lines: lines.map(([m, s], i) => ({ multipv: i + 1, depth, score: s, pv: [toUci(m)] })),
  };
}

export function after(fen: string, san: string): string {
  const c = new Chess(fen);
  c.move(san);
  return c.fen();
}

export function uci(fen: string, san: string): string {
  const m = new Chess(fen).move(san);
  return m.from + m.to + (m.promotion ?? '');
}
