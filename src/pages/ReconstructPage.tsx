import { Chess } from 'chess.js';
import { useEffect, useMemo, useState } from 'react';
import { Board, type BoardMove } from '../ui/Board';
import { PlayerStrip, Stage } from '../ui/stage';
import { MoveList } from '../ui/MoveList';
import { MoveStrip } from '../ui/MoveStrip';
import { ReplayControls } from '../ui/Replay';
import { ConfirmDialog } from '../ui/Dialog';
import { IconFlip, IconUndo } from '../ui/icons';
import { del, get, put } from '../db/db';
import type { ReconstructionDraft } from '../db/types';
import { START_FEN } from '../chess/tree';
import { gameStatus, REASON_TEXT, type GameResult } from '../chess/rules';
import { gameFromMoves, saveGame } from '../services/games';
import { navigate } from '../ui/router';
import { useApp } from '../ui/context';
import { useKeys } from '../ui/useKeys';

const EMPTY: ReconstructionDraft = { id: 'current', moves: [], cursor: 0, orientation: 'white', headers: { White: '', Black: '', Event: '', Date: '' }, startFen: START_FEN, updatedAt: 0 };

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
 * Manual reconstruction of a finished game: the user plays both sides' moves
 * in order. Every change is saved immediately; moves after the cursor are kept
 * as redo history until a different move replaces them.
 */
export function ReconstructPage() {
  const { toast } = useApp();
  const [d, setD] = useState<ReconstructionDraft | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [result, setResult] = useState<GameResult | ''>('');
  const [typed, setTyped] = useState('');
  const [typedError, setTypedError] = useState<string | null>(null);

  useEffect(() => { get('drafts', 'current').then((x) => setD(x ?? EMPTY)).catch(() => setD(EMPTY)); }, []);
  useEffect(() => { if (d && d.updatedAt !== 0) void put('drafts', d); }, [d]);
  const pos = useMemo(() => (d ? positions(d) : { fens: [START_FEN], ucis: [], valid: 0 }), [d]);

  const update = (p: Partial<ReconstructionDraft>) => d && setD({ ...d, ...p, updatedAt: Date.now() });
  const cursor = d?.cursor ?? 0;
  useKeys({
    ArrowLeft: () => cursor > 0 && update({ cursor: cursor - 1 }),
    ArrowRight: () => cursor < pos.valid && update({ cursor: cursor + 1 }),
    Home: () => update({ cursor: 0 }),
    End: () => update({ cursor: pos.valid }),
    f: () => d && update({ orientation: d.orientation === 'white' ? 'black' : 'white' }),
  }, !!d);
  if (!d) return <div className="page"><div className="empty">Loading…</div></div>;

  const fen = pos.fens[d.cursor];
  const status = gameStatus(pos.fens.slice(0, d.cursor + 1));
  const lastUci = d.cursor > 0 ? pos.ucis[d.cursor - 1] : null;

  const play = (m: BoardMove | string): boolean => {
    const c = new Chess(fen);
    let mv;
    try { mv = typeof m === 'string' ? c.move(m) : c.move(m); } catch { return false; }
    if (d.moves[d.cursor] === mv.san) update({ cursor: d.cursor + 1 });
    else update({ moves: [...d.moves.slice(0, d.cursor), mv.san], cursor: d.cursor + 1 });
    return true;
  };
  const submitTyped = () => {
    const t = typed.trim();
    if (!t) return;
    const ok = /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(t) ? play({ from: t.slice(0, 2), to: t.slice(2, 4), promotion: t[4] }) : play(t.replace(/0-0-0/, 'O-O-O').replace(/0-0/, 'O-O'));
    if (ok) { setTyped(''); setTypedError(null); } else setTypedError(`“${t}” is not a legal move for ${status.turn === 'w' ? 'White' : 'Black'} here.`);
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

  const names = { w: d.headers.White || 'White', b: d.headers.Black || 'Black' };
  const top = d.orientation === 'white' ? 'b' : 'w';
  const moves = d.moves.slice(0, pos.valid).map((san) => ({ san }));
  const undo = () => update({ moves: d.moves.slice(0, Math.max(0, d.cursor - 1)), cursor: Math.max(0, d.cursor - 1) });
  const replay = <ReplayControls atStart={d.cursor === 0} atEnd={d.cursor >= pos.valid} onFirst={() => update({ cursor: 0 })} onPrev={() => update({ cursor: d.cursor - 1 })} onNext={() => update({ cursor: d.cursor + 1 })} onLast={() => update({ cursor: pos.valid })} />;
  const statusText = status.over ? REASON_TEXT[status.reason!] : `${status.turn === 'w' ? names.w : names.b} to move${status.inCheck ? ', in check' : ''}`;

  return (
    <div className="page">
      <header className="page-head" style={{ marginBottom: 'var(--s-4)' }}>
        <div>
          <h1>Reconstruct a game</h1>
          <div className="lede small">Play both sides' moves in order, on the board or by typing them. Your progress is saved as you go.</div>
        </div>
      </header>
      <div className="board-layout">
        <Stage orientation={d.orientation}
          top={<PlayerStrip name={names[top]} color={top} fen={fen} isTurn={status.turn === top && !status.over} />}
          bottom={<PlayerStrip name={names[top === 'w' ? 'b' : 'w']} color={top === 'w' ? 'b' : 'w'} fen={fen} isTurn={status.turn !== top && !status.over} />}
          below={<div className="row board-tools"><button type="button" className="btn btn-sm btn-quiet" onClick={() => update({ orientation: d.orientation === 'white' ? 'black' : 'white' })} title="Flip board (F)"><IconFlip size={16} /> Flip</button></div>}>
          {(size) => <Board fen={fen} orientation={d.orientation} size={size} movable="both" onMove={(m) => play(m)} lastMove={lastUci ? [lastUci.slice(0, 2), lastUci.slice(2, 4)] : null} id="reconstruct-board" />}
        </Stage>
        <div className="panel-slot">
          <section className="panel" aria-label="Reconstruction">
            <div className="status-line" style={{ fontWeight: 600 }}><span className="status-dot" style={{ background: status.turn === 'w' ? '#efeadb' : '#191c19', boxShadow: '0 0 0 1px #556' }} /><span data-testid="recon-status">{statusText}</span><span className="spacer" /><span className="small faint num">{pos.valid} move{pos.valid === 1 ? '' : 's'}</span></div>
            <MoveStrip moves={moves} current={d.cursor} onSelect={(n) => update({ cursor: n })} />
            <MoveList moves={moves} current={d.cursor} futureFrom={d.cursor} onSelect={(n) => update({ cursor: n })} empty="Make the first move on the board, or type it below." />
            {d.cursor < pos.valid && (
              <div className="notice is-warn" style={{ margin: 'var(--s-2) var(--s-3)', borderRadius: 'var(--r-sm)' }}>
                Viewing move {d.cursor} of {pos.valid}. Playing a different move here replaces the later ones.{' '}
                <button type="button" className="btn btn-sm btn-quiet" onClick={() => update({ moves: d.moves.slice(0, d.cursor) })}>Delete later moves</button>
              </div>
            )}
            {status.claimable.length > 0 && <div className="notice" style={{ margin: 'var(--s-2) var(--s-3)' }}>A draw could have been claimed here ({status.claimable.map((c) => REASON_TEXT[c].replace(' (claimed)', '')).join(', ')}).</div>}
            <div className="section" style={{ paddingTop: 'var(--s-3)', paddingBottom: 'var(--s-3)' }}>
              <form className="row-nowrap" onSubmit={(e) => { e.preventDefault(); submitTyped(); }}>
                <label className="sr-only" htmlFor="typed-move">Type a move</label>
                <input id="typed-move" className="input" value={typed} onChange={(e) => { setTyped(e.target.value); setTypedError(null); }} placeholder={`Type ${status.turn === 'w' ? "White's" : "Black's"} move, e.g. Nf3`} autoComplete="off" spellCheck={false} disabled={status.over} data-testid="typed-move" />
                <button type="submit" className="btn" disabled={!typed.trim() || status.over}>Add</button>
              </form>
              {typedError && <div className="small" role="alert" style={{ color: '#f0857f', marginTop: 6 }}>{typedError}</div>}
            </div>
            <details className="disclose section" style={{ paddingTop: 'var(--s-2)', paddingBottom: 'var(--s-2)' }}>
              <summary>Game details {d.headers.White || d.headers.Black ? <span className="faint">({names.w} vs {names.b})</span> : <span className="faint">(optional)</span>}</summary>
              <div className="stack" style={{ padding: 'var(--s-2) 0' }}>
                <div className="grid-2" style={{ gap: 'var(--s-2)' }}>
                  <label className="field"><span className="field-label">White</span><input className="input" value={d.headers.White ?? ''} onChange={(e) => update({ headers: { ...d.headers, White: e.target.value } })} placeholder="Player name" /></label>
                  <label className="field"><span className="field-label">Black</span><input className="input" value={d.headers.Black ?? ''} onChange={(e) => update({ headers: { ...d.headers, Black: e.target.value } })} placeholder="Player name" /></label>
                  <label className="field"><span className="field-label">Event</span><input className="input" value={d.headers.Event ?? ''} onChange={(e) => update({ headers: { ...d.headers, Event: e.target.value } })} placeholder="Club night, tournament…" /></label>
                  <label className="field"><span className="field-label">Date</span><input className="input" type="date" value={(d.headers.Date ?? '').replace(/\./g, '-')} onChange={(e) => update({ headers: { ...d.headers, Date: e.target.value.replace(/-/g, '.') } })} /></label>
                </div>
                <label className="field"><span className="field-label">Result</span>
                  {autoResult ? <input className="input" value={`${autoResult}, ${REASON_TEXT[finalStatus.reason!].toLowerCase()}`} disabled /> : (
                    <select className="select" value={result} onChange={(e) => setResult(e.target.value as GameResult)} data-testid="result-select">
                      <option value="">Unfinished or unknown</option>
                      <option value="1-0">White won (1-0)</option>
                      <option value="0-1">Black won (0-1)</option>
                      <option value="1/2-1/2">Draw (½-½)</option>
                    </select>
                  )}
                </label>
              </div>
            </details>
            <div className="panel-foot stack" style={{ gap: 'var(--s-2)' }}>
              <div className="hide-stacked">{replay}</div>
              <div className="row-nowrap">
                <button type="button" className="btn btn-quiet" onClick={undo} disabled={d.cursor === 0} data-testid="undo" title={d.cursor === 0 ? 'No move to undo' : 'Remove the last move'}><IconUndo size={18} /> Undo move</button>
                <span className="spacer" />
                <button type="button" className="btn btn-danger" onClick={() => setConfirmReset(true)} disabled={!d.moves.length} data-testid="reset">Start over</button>
              </div>
              <button type="button" className="btn btn-primary btn-lg btn-block" onClick={review} disabled={pos.valid === 0} data-testid="review-game" title={pos.valid === 0 ? 'Enter at least one move first' : undefined}>Review game</button>
            </div>
          </section>
        </div>
      </div>
      <div className="dock">
        {replay}
        <button type="button" className="replay-btn" style={{ width: 52 }} onClick={undo} disabled={d.cursor === 0} aria-label="Undo move"><IconUndo /></button>
      </div>
      <ConfirmDialog open={confirmReset} title="Start over?" danger testId="reset-dialog"
        body={`All ${d.moves.length} entered moves and the game details will be cleared.`} confirmLabel="Clear the board" cancelLabel="Keep my moves"
        onCancel={() => setConfirmReset(false)} onConfirm={() => { setD({ ...EMPTY, orientation: d.orientation, updatedAt: Date.now() }); setResult(''); setConfirmReset(false); }} />
    </div>
  );
}
