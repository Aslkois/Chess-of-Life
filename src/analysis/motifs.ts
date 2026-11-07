import { Chess, type Move } from 'chess.js';
import {
  attackersOf, attacks, hangingPieces, isDefended, kingSquare, legalCapturesFor, mateInOneMoves, NAME, nullMoveFen,
  other, parseBoard, passedPawns, pawnShield, seeMove, sqIdx, sqName, VALUE, type Board, type Color, type PieceType,
} from './board';

export type MotifKind =
  | 'check' | 'capture' | 'fork' | 'pin' | 'skewer' | 'discovered-attack' | 'discovered-check'
  | 'hanging-left' | 'defender-removed' | 'mate-threat' | 'back-rank' | 'king-exposure'
  | 'passed-pawn' | 'promotion' | 'sacrifice' | 'overloaded-defender' | 'wins-hanging' | 'threat-ignored' | 'checkmate' | 'castles';

export interface Motif {
  kind: MotifKind;
  /** human readable, verified statement */
  text: string;
  /** piece/squares involved (for highlighting in review only) */
  squares?: string[];
  /** material involved in pawns (if relevant) */
  value?: number;
}

const LINE_DIRS: Record<string, number[][]> = {
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  q: [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]],
};

function rayPieces(b: Board, from: number, df: number, dr: number): number[] {
  const out: number[] = [];
  let f = from % 8;
  let r = Math.floor(from / 8);
  for (;;) {
    f += df; r += dr;
    if (f < 0 || f > 7 || r < 0 || r > 7) break;
    const s = r * 8 + f;
    if (b[s]) { out.push(s); if (out.length === 2) break; }
  }
  return out;
}

const pn = (t: PieceType) => NAME[t];
const art = (t: PieceType) => (t === 'k' ? 'the king' : `the ${NAME[t]}`);

/** Pins / skewers created by line pieces of `color` (after a move). */
function lineTactics(b: Board, color: Color, onlyFrom?: number): Motif[] {
  const res: Motif[] = [];
  for (let i = 0; i < 64; i++) {
    const p = b[i];
    if (!p || p.c !== color || !LINE_DIRS[p.t]) continue;
    if (onlyFrom !== undefined && i !== onlyFrom) continue;
    for (const [df, dr] of LINE_DIRS[p.t]) {
      const [a, z] = rayPieces(b, i, df, dr);
      if (a === undefined || z === undefined) continue;
      const pa = b[a]!;
      const pz = b[z]!;
      if (pa.c === color || pz.c === color) continue;
      if (pz.t === 'k' || VALUE[pz.t] > VALUE[pa.t] + 1) {
        const absolute = pz.t === 'k';
        if (pa.t !== 'k') {
          res.push({
            kind: 'pin',
            text: `The ${pn(p.t)} on ${sqName(i)} pins the ${pn(pa.t)} on ${sqName(a)} to ${art(pz.t)} on ${sqName(z)}${absolute ? ' (it cannot legally move off the line)' : ''}.`,
            squares: [sqName(i), sqName(a), sqName(z)],
          });
        }
      } else if ((pa.t === 'k' || VALUE[pa.t] > VALUE[pz.t]) && VALUE[pa.t] >= 5 && (VALUE[pz.t] >= 3 || !isDefended(b, z))) {
        res.push({
          kind: 'skewer',
          text: `The ${pn(p.t)} on ${sqName(i)} skewers ${art(pa.t)} on ${sqName(a)}: when it moves, the ${pn(pz.t)} on ${sqName(z)} behind it is exposed.`,
          squares: [sqName(i), sqName(a), sqName(z)],
        });
      }
    }
  }
  return res;
}

export interface MoveFacts {
  move: Move;
  fenAfter: string;
  mover: Color;
  motifs: Motif[];
  /** material balance change for the mover caused directly by the move (captures/promotion), in pawns */
  immediateMaterial: number;
  /** material the opponent can win immediately afterwards by a capture (static exchange), in pawns */
  exposedLoss: number;
  /** size of a sacrifice made by this move (0 if none), in pawns */
  sacrifice: number;
  /**
   * The opponent's legal captures that would actually win the offered
   * material (net static-exchange gain of at least 2 pawns compared with the
   * position before the move), best first. Empty when nothing is offered.
   */
  acceptances: { uci: string; gain: number }[];
}

/**
 * Verified tactical facts about playing `moveUci` (or SAN) in `fen`.
 * Every statement is derived from concrete attack relations on the board
 * before and after the move.
 */
export function analyzeMove(fen: string, moveInput: string): MoveFacts {
  const c = new Chess(fen);
  const mv = /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(moveInput)
    ? c.move({ from: moveInput.slice(0, 2), to: moveInput.slice(2, 4), promotion: moveInput[4] })
    : c.move(moveInput);
  const fenAfter = c.fen();
  const mover = mv.color as Color;
  const opp = other(mover);
  const before = parseBoard(fen);
  const after = parseBoard(fenAfter);
  const to = sqIdx(mv.to);
  const from = sqIdx(mv.from);
  const motifs: Motif[] = [];
  const pieceT = (mv.promotion ?? mv.piece) as PieceType;

  if (c.isCheckmate()) motifs.push({ kind: 'checkmate', text: `${mv.san} is checkmate.`, squares: [mv.to] });
  if (mv.flags.includes('k') || mv.flags.includes('q')) motifs.push({ kind: 'castles', text: 'Castling tucks the king away and connects the rooks.' });

  let immediateMaterial = 0;
  if (mv.captured) immediateMaterial += VALUE[mv.captured as PieceType];
  if (mv.promotion) {
    immediateMaterial += VALUE[mv.promotion as PieceType] - 1;
    motifs.push({ kind: 'promotion', text: `The pawn promotes to a ${pn(mv.promotion as PieceType)}.`, squares: [mv.to] });
  }

  // capture of a hanging piece
  if (mv.captured) {
    const see = seeMove(before, from, to);
    if (see >= 2) motifs.push({ kind: 'wins-hanging', text: `${mv.san} wins material: the ${pn(mv.captured as PieceType)} on ${mv.to} was not adequately defended (static exchange: +${see}).`, squares: [mv.to], value: see });
    else motifs.push({ kind: 'capture', text: `${mv.san} captures a ${pn(mv.captured as PieceType)}.`, squares: [mv.to] });
  }

  // checks and discovered checks
  if (c.inCheck()) {
    const k = kingSquare(after, opp);
    const checkers = attackersOf(after, k, mover);
    const disc = checkers.filter((s) => s !== to);
    if (disc.length) motifs.push({ kind: 'discovered-check', text: `Discovered check from the ${pn(after[disc[0]]!.t)} on ${sqName(disc[0])}.`, squares: disc.map(sqName) });
    else motifs.push({ kind: 'check', text: `${mv.san} gives check.`, squares: [mv.to] });
  }

  // fork: the moved piece attacks two or more valuable targets
  {
    const targets = attacks(after, to).filter((s) => after[s] && after[s]!.c === opp);
    const valuable = targets.filter((s) => {
      const t = after[s]!;
      if (t.t === 'k') return true;
      if (VALUE[t.t] > VALUE[pieceT]) return true;
      return !isDefended(after, s) && VALUE[t.t] >= 3;
    });
    const movedSafe = seeMoveSafe(after, to, opp);
    if (valuable.length >= 2 && movedSafe) {
      const names = valuable.map((s) => `${art(after[s]!.t)} on ${sqName(s)}`);
      motifs.push({ kind: 'fork', text: `Fork: the ${pn(pieceT)} on ${mv.to} attacks ${names.join(' and ')} at the same time.`, squares: [mv.to, ...valuable.map(sqName)] });
    }
  }

  // discovered attacks (non-check): another piece now attacks something new
  {
    for (let i = 0; i < 64; i++) {
      const p = after[i];
      if (!p || p.c !== mover || i === to || !LINE_DIRS[p.t]) continue;
      const nowA = attacks(after, i);
      const beforeA = new Set(attacks(before, i));
      for (const s of nowA) {
        const t = after[s];
        if (!t || t.c !== opp || t.t === 'k' || beforeA.has(s)) continue;
        if (VALUE[t.t] >= 3 && (VALUE[t.t] > VALUE[p.t] || !isDefended(after, s))) {
          motifs.push({ kind: 'discovered-attack', text: `Moving the ${pn(mv.piece as PieceType)} uncovers an attack by the ${pn(p.t)} on ${sqName(i)} against ${art(t.t)} on ${sqName(s)}.`, squares: [sqName(i), sqName(s)] });
        }
      }
    }
  }

  // pins & skewers newly created by the moved piece
  {
    const beforeKeys = new Set(lineTactics(before, mover).map((m) => m.text));
    for (const m of lineTactics(after, mover, to)) if (!beforeKeys.has(m.text)) motifs.push(m);
  }

  // mate threat: if the opponent passed, could the mover mate in one?
  if (!c.isCheckmate()) {
    const nm = nullMoveFen(fenAfter);
    if (nm) {
      const mates = mateInOneMoves(nm);
      if (mates.length) {
        const k = kingSquare(after, opp);
        const backRank = Math.floor(k / 8) === (opp === 'w' ? 0 : 7);
        motifs.push({ kind: backRank ? 'back-rank' : 'mate-threat', text: backRank ? 'This threatens a back-rank checkmate.' : 'This creates a direct checkmate threat.', squares: [sqName(k)] });
      }
    }
  }

  // own pieces left hanging by the move / defenders removed
  const hangBefore = new Map(hangingPieces(fen.replace(/ [wb] /, ` ${mover} `), mover).map((h) => [h.square, h]));
  const hangAfter = hangingPieces(fenAfter, mover);
  let exposedLoss = 0;
  for (const h of hangAfter) {
    exposedLoss = Math.max(exposedLoss, h.loss);
    if (h.square === mv.to) continue; // handled as sacrifice below
    if (!hangBefore.has(h.square)) {
      const fromDefended = attacks(before, from).includes(sqIdx(h.square)) && !attacks(after, to).includes(sqIdx(h.square));
      motifs.push({
        kind: fromDefended ? 'defender-removed' : 'hanging-left',
        text: fromDefended
          ? `The ${pn(mv.piece as PieceType)} was defending the ${pn(h.piece.t)} on ${h.square}; after it moves that ${pn(h.piece.t)} can be won.`
          : `This leaves the ${pn(h.piece.t)} on ${h.square} insufficiently protected.`,
        squares: [h.square],
        value: h.loss,
      });
    }
  }

  // threats that existed before the move and are still there (ignored)
  for (const [sq, h] of hangBefore) {
    if (sq === mv.from) continue;
    const still = hangAfter.find((x) => x.square === sq);
    if (still && h.loss >= 2 && !mv.captured) motifs.push({ kind: 'threat-ignored', text: `The ${pn(h.piece.t)} on ${sq} was already under attack and is still not safe.`, squares: [sq], value: still.loss });
  }

  // sacrifice: material the opponent can really win by a legal capture
  // sequence (corrected static exchange), created by this move
  let sacrifice = 0;
  const acceptances: { uci: string; gain: number }[] = [];
  {
    const legal = legalCapturesFor(fenAfter, opp);
    const promo = (from: number, target: number) => (after[from]?.t === 'p' && (Math.floor(target / 8) === 0 || Math.floor(target / 8) === 7) ? 'q' : '');
    const consider = (target: number, already: number) => {
      for (const a of attackersOf(after, target, opp)) {
        if (legal !== null && !legal.has(sqName(a) + sqName(target))) continue;
        // value lost if the opponent takes, minus what we already gained by capturing
        const net = seeMove(after, a, target) - already;
        if (net >= 2) acceptances.push({ uci: sqName(a) + sqName(target) + promo(a, target), gain: net });
      }
    };
    consider(to, immediateMaterial);
    for (const h of hangAfter) if (h.square !== mv.to && !hangBefore.has(h.square)) consider(sqIdx(h.square), 0);
    acceptances.sort((x, y) => y.gain - x.gain);
    sacrifice = acceptances[0]?.gain ?? 0;
    if (sacrifice >= 2) motifs.push({ kind: 'sacrifice', text: `This offers material: the opponent can capture and come out about ${sacrifice} pawn${sacrifice === 1 ? '' : 's'} ahead by static count.`, squares: [sqName(sqIdx(acceptances[0].uci.slice(2, 4)))], value: sacrifice });
  }

  // passed pawns
  {
    const pb = passedPawns(before, mover).length;
    const pa = passedPawns(after, mover);
    if (pa.length > pb) motifs.push({ kind: 'passed-pawn', text: `This creates a passed pawn on ${sqName(pa[pa.length - 1])}.`, squares: pa.map(sqName) });
  }

  // king exposure (own king)
  if (mv.piece === 'p') {
    const sb = pawnShield(before, mover);
    const sa = pawnShield(after, mover);
    if (sa.shield < sb.shield && sb.shield >= 2) motifs.push({ kind: 'king-exposure', text: `The pawn move weakens the shelter in front of your king on ${sqName(sa.kingSq)}.`, squares: [sqName(sa.kingSq)] });
  }

  // overloaded defenders of the opponent (after the move)
  motifs.push(...overloaded(after, opp));

  return { move: mv, fenAfter, mover, motifs, immediateMaterial, exposedLoss, sacrifice, acceptances };
}

function seeMoveSafe(b: Board, sq: number, attackerSide: Color): boolean {
  const atk = attackersOf(b, sq, attackerSide);
  for (const a of atk) if (seeMove(b, a, sq) > 0) return false;
  return true;
}

/** Enemy pieces that are the sole defender of two attacked pieces. */
function overloaded(b: Board, side: Color): Motif[] {
  const res: Motif[] = [];
  const attacker = other(side);
  const duty = new Map<number, number[]>();
  for (let i = 0; i < 64; i++) {
    const p = b[i];
    if (!p || p.c !== side || p.t === 'k' || VALUE[p.t] < 3) continue;
    if (!attackersOf(b, i, attacker).length) continue;
    const defs = attackersOf(b, i, side);
    if (defs.length === 1) duty.set(defs[0], [...(duty.get(defs[0]) ?? []), i]);
  }
  for (const [d, list] of duty) {
    if (list.length >= 2) {
      res.push({ kind: 'overloaded-defender', text: `The ${NAME[b[d]!.t]} on ${sqName(d)} is the only defender of both ${list.map((s) => `the ${NAME[b[s]!.t]} on ${sqName(s)}`).join(' and ')} – it is overloaded.`, squares: [sqName(d), ...list.map(sqName)] });
    }
  }
  return res;
}

/** Opponent threats in a position (what the side NOT to move threatens if it could move again). */
export function currentThreats(fen: string): { hanging: ReturnType<typeof hangingPieces>; mateThreat: boolean } {
  const c = new Chess(fen);
  const me = c.turn() as Color;
  const hanging = hangingPieces(fen, me);
  const nm = nullMoveFen(fen);
  const mateThreat = nm ? mateInOneMoves(nm).length > 0 : false;
  return { hanging, mateThreat };
}
