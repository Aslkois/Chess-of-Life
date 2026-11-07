import { Chess } from 'chess.js';
import { canCheckmate, gameStatus, timeoutResult, capturedPieces } from '../src/chess/rules';
import { positionKey } from '../src/chess/positionKey';
import { applyMove, START_FEN } from '../src/chess/tree';

function fensOf(sans: string[], start = START_FEN) {
  const c = new Chess(start);
  const fens = [c.fen()];
  for (const s of sans) { c.move(s); fens.push(c.fen()); }
  return fens;
}

describe('chess rules', () => {
  it('plays a complete legal game to checkmate (Opera game)', () => {
    const moves = 'e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#'.split(' ');
    const fens = fensOf(moves);
    const st = gameStatus(fens);
    expect(st.over).toBe(true);
    expect(st.reason).toBe('checkmate');
    expect(st.result).toBe('1-0');
  });

  it('handles castling both sides, en passant and promotion', () => {
    let { fen } = applyMove(START_FEN, 'e4');
    ({ fen } = applyMove(fen, 'a6'));
    ({ fen } = applyMove(fen, 'e5'));
    ({ fen } = applyMove(fen, 'd5'));
    const ep = applyMove(fen, 'exd6');
    expect(ep.move.flags).toContain('e');
    const castle = applyMove('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'O-O-O');
    expect(castle.move.flags).toContain('q');
    const castle2 = applyMove('r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1', 'O-O');
    expect(castle2.move.flags).toContain('k');
    const promo = applyMove('8/P7/8/8/8/8/8/k6K w - - 0 1', 'a8=N');
    expect(promo.move.promotion).toBe('n');
    expect(() => applyMove(START_FEN, 'e5')).toThrow();
  });

  it('detects stalemate and insufficient material', () => {
    expect(gameStatus(['7k/5Q2/6K1/8/8/8/8/8 b - - 0 1']).reason).toBe('stalemate');
    expect(gameStatus(['8/8/8/4k3/8/8/2B5/4K3 w - - 0 1']).reason).toBe('insufficient-material');
  });

  it('makes threefold claimable and ends the game at fivefold', () => {
    const shuffle = ['Nf3', 'Nf6', 'Ng1', 'Ng8'];
    let moves: string[] = [];
    for (let i = 0; i < 2; i++) moves = moves.concat(shuffle);
    let st = gameStatus(fensOf(moves));
    expect(st.repetitionCount).toBe(3);
    expect(st.over).toBe(false);
    expect(st.claimable).toContain('threefold-repetition');
    for (let i = 0; i < 2; i++) moves = moves.concat(shuffle);
    st = gameStatus(fensOf(moves));
    expect(st.over).toBe(true);
    expect(st.reason).toBe('fivefold-repetition');
  });

  it('applies the 50-move claim and the 75-move automatic rule', () => {
    const st50 = gameStatus(['8/8/8/4k3/8/8/2R5/4K3 w - - 100 80']);
    expect(st50.claimable).toContain('fifty-move');
    expect(st50.over).toBe(false);
    const st75 = gameStatus(['8/8/8/4k3/8/8/2R5/4K3 w - - 150 100']);
    expect(st75.over).toBe(true);
    expect(st75.reason).toBe('seventy-five-move');
  });

  it('ignores an en-passant square that cannot be used in repetition keys', () => {
    const a = positionKey('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1');
    const b = positionKey('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    expect(a).toBe(b);
    const c = positionKey('rnbqkbnr/ppp1pppp/8/8/3pP3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 3');
    expect(c.endsWith('e3')).toBe(true);
  });

  it('time forfeit is a draw when the opponent cannot checkmate', () => {
    expect(canCheckmate('8/8/8/4k3/8/8/8/4K3 w - - 0 1', 'w')).toBe(false);
    // Black (queen) flags, White has a lone king: draw
    expect(timeoutResult('8/8/8/4k3/8/8/8/q3K3 b - - 0 1', 'b')).toEqual({ result: '1/2-1/2', reason: 'timeout-vs-insufficient' });
    // knight vs rook: a helpmate exists, so flagging against the knight still loses
    expect(timeoutResult('8/8/8/4k3/8/8/2N5/4K2r w - - 0 1', 'b')).toEqual({ result: '1-0', reason: 'timeout' });
    expect(timeoutResult('8/8/8/4k3/8/8/2N5/4K2r w - - 0 1', 'w')).toEqual({ result: '0-1', reason: 'timeout' });
    expect(timeoutResult(START_FEN, 'w')).toEqual({ result: '0-1', reason: 'timeout' });
  });

  it('reports captured pieces', () => {
    const fens = fensOf(['e4', 'd5', 'exd5', 'Qxd5']);
    const cap = capturedPieces(fens[fens.length - 1]);
    expect(cap.byWhite).toEqual(['p']);
    expect(cap.byBlack).toEqual(['p']);
  });
});
