import { Chess } from 'chess.js';
import { hangingPieces, parseBoard, seeMove, sqIdx } from '../src/analysis/board';
import { analyzeMove } from '../src/analysis/motifs';

const SCANDI = 'rnb1kbnr/ppp1pppp/2q5/8/8/2N5/PPPP1PPP/R1BQKBNR w KQkq - 2 4';
const after = (fen: string, san: string) => { const c = new Chess(fen); c.move(san); return c.fen(); };
const see = (fen: string, from: string, to: string) => seeMove(parseBoard(fen), sqIdx(from), sqIdx(to));

describe('static exchange evaluation', () => {
  it('scores a capture that loses to a recapture as a loss (Scandinavian 4.Bb5 Qxb5? Nxb5)', () => {
    const fen = after(SCANDI, 'Bb5');
    // Black queen takes the bishop (+3), the knight takes the queen (-9): net -6 for Black
    expect(see(fen, 'c6', 'b5')).toBe(-6);
  });

  it('handles single captures, even trades and deeper sequences', () => {
    // free queen
    expect(see('4k3/8/8/3q4/8/8/3R4/4K3 w - - 0 1', 'd2', 'd5')).toBe(9);
    // pawn takes pawn defended by a pawn: 1 - 1 = 0
    expect(see('4k3/8/4p3/3p4/4P3/8/8/4K3 w - - 0 1', 'e4', 'd5')).toBe(0);
    // rook takes pawn defended by a pawn: 1 - 5 = -4
    expect(see('4k3/8/4p3/3p4/8/8/8/3RK3 w - - 0 1', 'd1', 'd5')).toBe(-4);
    // knight takes a knight defended by a pawn, rook recaptures last: +3 -3 +1 = 1
    expect(see('4k3/8/2p5/3n4/8/4N3/8/3RK3 w - - 0 1', 'e3', 'd5')).toBe(1);
    // rook takes a pawn defended by the queen and nothing recaptures the queen: 1 - 5 = -4
    expect(see('3qk3/8/8/3p4/8/8/8/3RK3 w - - 0 1', 'd1', 'd5')).toBe(-4);
  });

  it('counts x-ray attackers behind the first capturer', () => {
    // doubled rooks vs one defender: Rxd5 Rxd5 Rxd5 -> +1 (pawn) -5 +5 = 1
    expect(see('3rk3/8/8/3p4/8/8/3R4/3RK3 w - - 0 1', 'd2', 'd5')).toBe(1);
  });

  it('does not treat a pinned queen as winning the bishop', () => {
    const fen = after(SCANDI, 'Bb5');
    const hang = hangingPieces(fen, 'w').map((h) => h.square);
    expect(hang).not.toContain('b5');
    const facts = analyzeMove(SCANDI, 'Bb5');
    expect(facts.sacrifice).toBe(0);
    expect(facts.motifs.some((m) => m.kind === 'pin')).toBe(true);
  });
});
