import { Chess } from 'chess.js';
import { useEffect, useMemo, useState } from 'react';
import { Board, type BoardMove } from '../ui/Board';
import { MoveList } from '../ui/MoveList';
import { PlayerBar, Modal } from '../ui/bits';
import { IconFirst, IconFlip, IconLast, IconNext, IconPrev } from '../ui/icons';
import { del, get, put } from '../db/db';
import type { ReconstructionDraft } from '../db/types';
import { START_FEN } from '../chess/tree';
import { gameStatus, REASON_TEXT, type GameResult } from '../chess/rules';
import { gameFromMoves, saveGame } from '../services/games';
import { navigate } from '../ui/router';
import { useApp } from '../ui/context';

const EMPTY: ReconstructionDraft = { id: 'current', moves: [], cursor: 0, orientation: 'white', headers: { White: '', Black: '', Event: '', Date: '' }, startFen: START_FEN, updatedAt: 0 };

/** Positions after each move of the draft; [0] = start. */
function positions(d: ReconstructionDraft): { fens: string[]; ucis: string[]; valid: number } {
  const c = new Chess(d.startFen);
  const fens = [c.fen()];
  const ucis: string[] = [];
  for (const s of d.moves) {
    try { const m = c.move(s); fens.push(c.fen()); ucis.push(m.from + m.to + (m.promotion ?? '')); } catch { break; }
  }
  return { fens, ucis, valid: fens.length - 1 };
}

/**
 * Manual game reconstruction: the user enters both sides' moves of a game
 * that was already played. Not a game against the engine.
 */
export function ReconstructPage() {
  const { toast } = useApp();
  const [d, setD] = useState<ReconstructionDraft | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [result, setResult] = useState<GameResult | ''>('');

  useEffect(() => { get('drafts', 'current').then((x) => setD(x ?? EMPTY)).catch(() => setD(EMPTY)); }, []);
  // save every change immediately: a reconstruction must never be lost
  useEffect(() => {
    if (!d || d.updatedAt === 0) return;
    void put('drafts', d);
  }, [d]);

  const pos = useMemo(() => (d ? positions(d) : { fens: [START_FEN], ucis: [], valid: 0 }), [d]);
  if (!d) return <div className="empty">Loading…</div>;
  const update = (p: Partial<ReconstructionDraft>) => setD({ ...d, ...p, updatedAt: Date.now() });
  const fen = pos.fens[d.cursor];
  const status = gameStatus(pos.fens.slice(0, d.cursor + 1));
  const lastUci = d.cursor > 0 ? pos.ucis[d.cursor - 1] : null;

  const onMove = (m: BoardMove) => {
    const c = new Chess(fen);
    let mv;
    try { mv = c.move(m); } catch { return false; }
    // same move as the redo history: just step forward; otherwise replace the future
    if (d.moves[d.cursor] === mv.san) update({ cursor: d.cursor + 1 });
    else update({ moves: [...d.moves.slice(0, d.cursor), mv.san], cursor: d.cursor + 1 });
    return true;
  };

  const finalStatus = gameStatus(pos.fens);
  const autoResult = finalStatus.over ? finalStatus.result : '';
  const review = async () => {
    const moves = d.moves.slice(0, pos.valid);
    if (!moves.length) { toast('Enter at least one move first.'); return; }
    const r = (autoResult || result || '*') as GameResult;
    const headers: Record<string, string> = { Event: d.headers.Event || 'Reconstructed game', Site: 'Over the board', Date: d.headers.Date || '????.??.??', White: d.headers.White || '?', Black: d.headers.Black || '?', Result: r };
    if (finalStatus.reason) headers.Termination = REASON_TEXT[finalStatus.reason];
    const g = gameFromMoves('manual', moves, headers, r, d.startFen);
    await saveGame(g);
    await del('drafts', 'current');
    navigate(`review/${g.id}`);
  };

  const white = d.headers.White || 'White';
  const black = d.headers.Black || 'Black';
  const top = d.orientation === 'white' ? 'b' : 'w';
  return (
    <div>
      <div className="row between" style={{ marginBottom: 12 }}>
        <div><h1>Reconstruct a game</h1><p className="muted small" style={{ margin: 0 }}>Play the moves of both sides in order. Every move is checked for legality. Your progress is saved automatically.</p></div>
      </div>
      <div className="play">
        <div className="board-col">
          <PlayerBar name={top === 'w' ? white : black} color={top} fen={fen} />
          <Board fen={fen} orientation={d.orientation} movable="both" onMove={onMove} lastMove={lastUci ? [lastUci.slice(0, 2), lastUci.slice(2, 4)] : null} id="reconstruct-board" />
          <PlayerBar name={top === 'w' ? black : white} color={top === 'w' ? 'b' : 'w'} fen={fen} />
          <div className="controls">
            <div className="btn-group">
              <button className="btn icon" onClick={() => update({ cursor: 0 })} disabled={d.cursor === 0} aria-label="First"><IconFirst /></button>
              <button className="btn icon" onClick={() => update({ cursor: d.cursor - 1 })} disabled={d.cursor === 0} aria-label="Back" data-testid="back"><IconPrev /></button>
              <button className="btn icon" onClick={() => update({ cursor: d.cursor + 1 })} disabled={d.cursor >= pos.valid} aria-label="Forward" data-testid="forward"><IconNext /></button>
              <button className="btn icon" onClick={() => update({ cursor: pos.valid })} disabled={d.cursor >= pos.valid} aria-label="Last"><IconLast /></button>
            </div>
            <button className="btn" onClick={() => update({ moves: d.moves.slice(0, Math.max(0, d.cursor - 1)), cursor: Math.max(0, d.cursor - 1) })} disabled={d.cursor === 0} data-testid="undo">Undo move</button>
            <button className="btn icon" onClick={() => update({ orientation: d.orientation === 'white' ? 'black' : 'white' })} aria-label="Flip board"><IconFlip /></button>
            <span className="spacer" />
            <button className="btn danger" onClick={() => setConfirmReset(true)} data-testid="reset">Reset</button>
          </div>
        </div>
        <div className="side-col">
          <div className="card">
            <div className="row between"><h3>Moves</h3><span className="faint small">{status.over ? REASON_TEXT[status.reason!] : status.inCheck ? 'Check' : `${status.turn === 'w' ? 'White' : 'Black'} to move`}</span></div>
            <MoveList moves={d.moves.slice(0, pos.valid).map((san) => ({ san }))} current={d.cursor} futureFrom={d.cursor} onSelect={(n) => update({ cursor: n })} />
            {d.cursor < pos.valid && (
              <div className="notice small" style={{ marginTop: 8 }}>
                Viewing move {d.cursor}. Moves after this are kept until you play a different move here.{' '}
                <button className="btn sm" onClick={() => update({ moves: d.moves.slice(0, d.cursor) })}>Delete later moves</button>
              </div>
            )}
            {status.claimable.length > 0 && <div className="notice small" style={{ marginTop: 8 }}>A draw could be claimed here ({status.claimable.map((c) => REASON_TEXT[c]).join(', ')}).</div>}
          </div>
          <div className="card stack">
            <h3>Game details</h3>
            <div className="grid2" style={{ gap: 8 }}>
              <label className="field">White<input type="text" value={d.headers.White ?? ''} onChange={(e) => update({ headers: { ...d.headers, White: e.target.value } })} placeholder="Name" /></label>
              <label className="field">Black<input type="text" value={d.headers.Black ?? ''} onChange={(e) => update({ headers: { ...d.headers, Black: e.target.value } })} placeholder="Name" /></label>
              <label className="field">Event<input type="text" value={d.headers.Event ?? ''} onChange={(e) => update({ headers: { ...d.headers, Event: e.target.value } })} /></label>
              <label className="field">Date<input type="text" value={d.headers.Date ?? ''} onChange={(e) => update({ headers: { ...d.headers, Date: e.target.value } })} placeholder="2024.05.01" /></label>
              <label className="field">Result
                {autoResult ? <input type="text" value={`${autoResult} (${REASON_TEXT[finalStatus.reason!]})`} disabled /> : (
                  <select value={result} onChange={(e) => setResult(e.target.value as GameResult)} data-testid="result-select">
                    <option value="">Unfinished / unknown (*)</option>
                    <option value="1-0">1-0 White won</option>
                    <option value="0-1">0-1 Black won</option>
                    <option value="1/2-1/2">½-½ Draw</option>
                  </select>
                )}
              </label>
            </div>
            <button className="btn primary" onClick={review} disabled={pos.valid === 0} data-testid="review-game">Review Game</button>
            <span className="faint small">Review analyses every move of both players with Stockfish on this device.</span>
          </div>
        </div>
      </div>
      {confirmReset && (
        <Modal onClose={() => setConfirmReset(false)}>
          <h2>Reset the board?</h2>
          <p className="muted">All {d.moves.length} entered moves will be removed.</p>
          <div className="row"><span className="spacer" /><button className="btn" onClick={() => setConfirmReset(false)}>Cancel</button><button className="btn danger" data-testid="confirm-reset" onClick={() => { setD({ ...EMPTY, orientation: d.orientation, updatedAt: Date.now() }); setResult(''); setConfirmReset(false); }}>Reset</button></div>
        </Modal>
      )}
    </div>
  );
}
