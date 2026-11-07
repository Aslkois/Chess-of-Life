import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import {
  bookMoves, continuations, fensOf, isBookMove, isBookPosition, OPENING_COUNT, openingAt, parseOpeningName, trackOpening,
} from '../src/analysis/openings';

/** The dataset rows, read straight from the source files. */
const ROWS = ['a', 'b', 'c', 'd', 'e'].flatMap((f) => readFileSync(`data/openings/${f}.tsv`, 'utf8').trim().split('\n').slice(1).map((r) => {
  const [eco, name, pgn] = r.split('\t');
  return { eco, name, pgn, sans: pgn.replace(/\d+\.(\.\.)?/g, ' ').trim().split(/\s+/) };
}));
const row = (name: string, pgn: string) => {
  const r = ROWS.find((x) => x.name === name && x.pgn === pgn);
  if (!r) throw new Error(`not in the dataset: ${name} | ${pgn}`);
  return r;
};
const finalFen = (sans: string[]) => fensOf(sans).at(-1)!;

describe('opening reference matches the dataset exactly', () => {
  it('names every catalogued line at the position where it ends', () => {
    expect(OPENING_COUNT).toBe(ROWS.length);
    for (const r of ROWS) {
      const o = openingAt(finalFen(r.sans));
      expect(o, r.pgn).not.toBeNull();
      expect([o!.eco, o!.name]).toEqual([r.eco, r.name]);
    }
  });

  it('marks every position along every line as book, with its continuation catalogued', () => {
    for (const r of ROWS.slice(0, 600)) {
      const c = new Chess();
      for (const san of r.sans) {
        const before = c.fen();
        const m = c.move(san);
        expect(isBookPosition(before)).toBe(true);
        expect(isBookMove(before, m.from + m.to + (m.promotion ?? ''))).toBe(true);
      }
      expect(isBookPosition(c.fen())).toBe(true);
    }
  });

  const CASES: [string, string, string, string, string | null, string | null][] = [
    // [name, pgn, eco, family, variation, subvariation]
    ['Sicilian Defense', '1. e4 c5', 'B20', 'Sicilian Defense', null, null],
    ['Sicilian Defense: Najdorf Variation', '1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6', 'B90', 'Sicilian Defense', 'Najdorf Variation', null],
    ['Scandinavian Defense', '1. e4 d5', 'B01', 'Scandinavian Defense', null, null],
    ['Scandinavian Defense: Main Line', '1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5', 'B01', 'Scandinavian Defense', 'Main Line', null],
    ['Italian Game', '1. e4 e5 2. Nf3 Nc6 3. Bc4', 'C50', 'Italian Game', null, null],
    ['Italian Game: Giuoco Piano', '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5', 'C50', 'Italian Game', 'Giuoco Piano', null],
    ["Queen's Gambit", '1. d4 d5 2. c4', 'D06', "Queen's Gambit", null, null],
    ["Queen's Gambit Declined", '1. d4 d5 2. c4 e6', 'D30', "Queen's Gambit Declined", null, null],
    ["Queen's Gambit Accepted", '1. d4 d5 2. c4 dxc4', 'D20', "Queen's Gambit Accepted", null, null],
    ["King's Indian Defense: Normal Variation", '1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6', 'E70', "King's Indian Defense", 'Normal Variation', null],
    ["King's Indian Defense: Orthodox Variation", '1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6 5. Nf3 O-O 6. Be2', 'E91', "King's Indian Defense", 'Orthodox Variation', null],
  ];
  for (const [name, pgn, eco, family, variation, sub] of CASES) {
    it(`${eco} ${name} (${pgn})`, () => {
      const r = row(name, pgn);
      expect(r.eco).toBe(eco);
      const o = openingAt(finalFen(r.sans))!;
      expect(o).toMatchObject({ eco, name, family, variation, subvariation: sub });
    });
  }

  it('splits names into family, variation and sub-variation', () => {
    expect(parseOpeningName('Sicilian Defense: Najdorf Variation, English Attack, Anti-English')).toEqual({ family: 'Sicilian Defense', variation: 'Najdorf Variation', subvariation: 'English Attack, Anti-English' });
    expect(parseOpeningName('Italian Game')).toEqual({ family: 'Italian Game', variation: null, subvariation: null });
    const withSub = ROWS.find((r) => r.name.split(',').length >= 3)!;
    expect(parseOpeningName(withSub.name).subvariation).toContain(',');
  });
});

describe('tracking an opening through a game', () => {
  it('does not name a variation before it is reached', () => {
    const t = trackOpening(fensOf(['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6']));
    expect(t.plies[0].opening).toBeNull(); // the start position has no name
    expect(t.plies[2].opening!.name).toBe('Sicilian Defense');
    expect(t.plies[8].opening!.name).not.toMatch(/Najdorf/); // 5.Nc3: not yet
    expect(t.plies[10].opening!.name).toBe('Sicilian Defense: Najdorf Variation');
    expect(t.opening!.eco).toBe('B90');
    expect(t.bookPlies).toBe(10);
    expect(t.leftAt).toBeNull();
  });

  it('recognises transpositions: the same position by a different move order gets the same name', () => {
    const kid = row("King's Indian Defense: Normal Variation", '1. d4 Nf6 2. c4 g6 3. Nc3 Bg7 4. e4 d6');
    const viaEnglish = trackOpening(fensOf(['c4', 'g6', 'Nc3', 'Bg7', 'd4', 'Nf6', 'e4', 'd6']));
    expect(viaEnglish.opening!.name).toBe(kid.name);
    expect(viaEnglish.plies.at(-1)!.namedHere!.name).toBe(kid.name);
    const qgd = trackOpening(fensOf(['Nf3', 'd5', 'd4', 'Nf6', 'c4', 'e6', 'Nc3', 'Be7', 'Bg5']));
    expect(qgd.opening!).toMatchObject({ eco: 'D53', family: "Queen's Gambit Declined" });
    expect(qgd.bookPlies).toBe(9);
  });

  it('records leaving theory and keeps the last known identity', () => {
    const t = trackOpening(fensOf(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'Kf1', 'Nf6']));
    expect(t.bookPlies).toBe(6);
    expect(t.leftAt).toBe(6); // 4.Kf1 (ply index 6) leaves the catalogued lines
    expect(t.plies[7]).toMatchObject({ inBook: false, event: 'left', lastBookIndex: 6 });
    expect(t.plies[8].event).toBe('out');
    expect(t.plies[8].opening!.name).toBe('Italian Game: Giuoco Piano'); // identity is kept, book status is not
    expect(t.reentered).toBe(false);
  });

  it('records coming back into theory', () => {
    const t = trackOpening(fensOf(['d4', 'Nf6', 'Bg5', 'e6', 'c4', 'd5', 'Nc3', 'Be7']));
    expect(t.leftAt).not.toBeNull();
    expect(t.reentered).toBe(true);
    expect(t.plies.some((p) => p.event === 'reentered')).toBe(true);
    expect(t.plies.at(-1)!.inBook).toBe(true);
    expect(t.opening!.family).toBe("Queen's Gambit Declined");
    // the initial book run ends where theory was first left
    expect(t.bookPlies).toBe(t.leftAt);
  });

  it('the Scandinavian 3...Qc6 line: the queen move itself is outside the catalogued theory', () => {
    const t = trackOpening(fensOf(['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qc6', 'Bb5']));
    expect(t.plies[4].namedHere!.name).toBe(row('Scandinavian Defense: Mieses-Kotrč Variation', '1. e4 d5 2. exd5 Qxd5').name);
    expect(t.plies[5]).toMatchObject({ inBook: true, namedHere: null }); // 3.Nc3: catalogued, but no name of its own
    expect(t.leftAt).toBe(5); // 3...Qc6
    expect(t.plies[7].opening!.name).toBe('Scandinavian Defense: Mieses-Kotrč Variation');
  });

  it('lists catalogued continuations with dataset line counts, most common first', () => {
    const start = new Chess().fen();
    const cs = continuations(start);
    expect(cs.map((c) => c.san).slice(0, 2)).toEqual(['e4', 'd4']);
    // the count is the number of dataset lines through the move
    const throughE4 = ROWS.filter((r) => r.sans[0] === 'e4').length;
    expect(cs[0].lines).toBe(throughE4);
    expect(cs.reduce((n, c) => n + c.lines, 0)).toBe(ROWS.length);
    expect(cs[0].opening!.name).toBe("King's Pawn Game");
    expect(bookMoves(start)).toEqual(cs.map((c) => c.uci));
    // outside theory there is nothing to list
    expect(continuations(finalFen(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'Kf1']))).toEqual([]);
  });
});
