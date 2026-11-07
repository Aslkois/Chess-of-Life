import { exportPgn, parsePgn } from '../src/chess/pgn';
import { addMove, mainline, treeFromMoves } from '../src/chess/tree';

const TWO_GAMES = `[Event "Casual"]
[White "Alice"]
[Black "Bob"]
[WhiteElo "1500"]
[BlackElo "1480"]
[Result "1-0"]
[Date "2024.05.01"]
[TimeControl "300+3"]

1. e4 {King pawn [%clk 0:05:00]} e5 2. Nf3 Nc6 (2... d6 3. d4 $1) 3. Bb5 a6!? 4. Ba4 Nf6 5. O-O 1-0

[Event "Second"]
[White "Carol"]
[Black "Dan"]
[Result "0-1"]

1. f3 e5 2. g4?? Qh4# 0-1
`;

describe('PGN import', () => {
  it('imports multiple games with headers, comments, NAGs, clocks and variations', () => {
    const r = parsePgn(TWO_GAMES);
    expect(r.games).toHaveLength(2);
    const [g1, g2] = r.games;
    expect(g1.headers.White).toBe('Alice');
    expect(g1.headers.WhiteElo).toBe('1500');
    expect(g1.headers.TimeControl).toBe('300+3');
    expect(g1.moves).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O']);
    expect(g1.result).toBe('1-0');
    expect(g1.complete).toBe(true);
    const line = mainline(g1.tree);
    const e4 = g1.tree.nodes[line[1]];
    expect(e4.comment).toBe('King pawn');
    expect(e4.clock).toBe(300);
    const a6 = g1.tree.nodes[line[6]];
    expect(a6.nags).toEqual([5]);
    // variation 2...d6 3.d4! stored as an imported branch from the position after 2.Nf3
    const nf3 = g1.tree.nodes[line[3]];
    expect(nf3.children).toHaveLength(2);
    const d6 = g1.tree.nodes[nf3.children.find((c) => g1.tree.nodes[c].san === 'd6')!];
    expect(d6.source).toBe('imported');
    expect(g1.tree.nodes[d6.children[0]].nags).toEqual([1]);
    expect(g2.moves).toEqual(['f3', 'e5', 'g4', 'Qh4#']);
    expect(g2.result).toBe('0-1');
  });

  it('reports illegal moves clearly and keeps the legal part', () => {
    const r = parsePgn('[Event "x"]\n\n1. e4 e5 2. Ke3 Nc6 *');
    expect(r.games[0].errors[0]).toMatch(/illegal or unreadable move "Ke3" at move 2/);
    expect(r.games[0].moves).toEqual(['e4', 'e5']);
    expect(r.games[0].complete).toBe(false);
  });

  it('warns about incomplete games and handles empty input', () => {
    const r = parsePgn('1. d4 d5 2. c4');
    expect(r.games[0].moves).toEqual(['d4', 'd5', 'c4']);
    expect(r.games[0].warnings.join(' ')).toMatch(/no result/);
    expect(parsePgn('   ').errors[0]).toMatch(/empty/);
    expect(parsePgn('just some words').games[0]?.errors.length ?? 1).toBeGreaterThan(0);
  });

  it('accepts 0-0 castling notation, FEN start positions and move numbers like 1...', () => {
    const r = parsePgn('[FEN "r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1"]\n[SetUp "1"]\n\n1... 0-0-0 2. 0-0 *');
    expect(r.games[0].moves).toEqual(['O-O-O', 'O-O']);
    expect(r.games[0].startFen).toBe('r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1');
  });
});

describe('PGN export', () => {
  it('round-trips nested variations, comments and branch names', () => {
    let tree = treeFromMoves(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
    const line = mainline(tree);
    // branch at move 2 for black, and a nested branch inside it
    let r = addMove(tree, line[3], 'Nf6', 'user');
    tree = r.tree;
    tree.nodes[r.nodeId] = { ...tree.nodes[r.nodeId], branchName: 'Petrov idea', branchNote: 'what if' };
    const nf6 = r.nodeId;
    r = addMove(tree, nf6, 'Nxe5', 'user'); tree = r.tree;
    const nxe5 = r.nodeId;
    r = addMove(tree, nxe5, 'd6', 'engine'); tree = r.tree;
    r = addMove(tree, nf6, 'd3', 'user'); tree = r.tree; // nested alternative
    const pgn = exportPgn({ White: 'A', Black: 'B' }, tree, '*');
    expect(pgn).toContain('[White "A"]');
    expect(pgn.replace(/\n/g, ' ')).toContain('2. Nf3 Nc6 (2... Nf6 {Branch: Petrov idea what if [explored alternative]} 3. Nxe5 (3. d3) 3... d6 {[engine continuation]}) 3. Bb5 *');
    const back = parsePgn(pgn).games[0];
    expect(back.moves).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']);
    const nf3 = back.tree.nodes[mainline(back.tree)[3]];
    expect(nf3.children.map((c) => back.tree.nodes[c].san).sort()).toEqual(['Nc6', 'Nf6']);
  });
});
