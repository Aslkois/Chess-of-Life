import { Chess } from 'chess.js';
import { useEffect, useRef, useState } from 'react';
import { Board, type BoardMove } from '../ui/Board';
import { MoveList } from '../ui/MoveList';
import { Modal, PlayerBar } from '../ui/bits';
import { IconFlip } from '../ui/icons';
import { useApp } from '../ui/context';
import { navigate } from '../ui/router';
import { get } from '../db/db';
import type { RankedMatch, RankedProfile } from '../db/types';
import { TIME_CONTROLS, remainingMs, isTimed } from '../chess/clock';
import { gameStatus, REASON_TEXT } from '../chess/rules';
import {
  agreeDraw, checkFlag, claimDraw, createMatch, playRankedMove, rankedFen, resignRanked, restoreRanked, rivalAcceptsDraw, rivalLevelFor, type RankedState,
} from '../rival/ranked';
import { applyStrategy, deriveStrategy, withOpeningCandidates } from '../rival/policy';
import { pickMove, strengthFor, levelRating } from '../engine/strength';
import { getEngine } from '../engine/instance';
import { winPercentPov } from '../engine/score';
import { mulberry32, seedFrom } from '../util/rng';
import { loadRankedProfile, loadRivalModel, recordRankedResult, saveMatch } from '../services/ranked';
import { gameFromMoves, saveGame } from '../services/games';
import { ensureReview } from '../services/reviews';
import type { GameReview } from '../analysis/review';

/**
 * Ranked match against the Rival. No hints, takebacks, evaluations,
 * classifications, engine lines, predictions, feedback or analysis are
 * reachable while the game is in progress.
 */
export function RankedPage() {
  const { activeRanked, setActiveRanked, prefs } = useApp();
  const [rs, setRsRaw] = useState<RankedState | null>(null);
  const rsRef = useRef<RankedState | null>(null);
  const setRs = (s: RankedState | null) => { rsRef.current = s; setRsRaw(s); if (s) void saveMatch(s.match); };
  const [profile, setProfile] = useState<RankedProfile | null>(null);
  const [tcId, setTcId] = useState('10+5');
  const [color, setColor] = useState<'w' | 'b' | 'random'>('random');
  const [orientation, setOrientation] = useState<'white' | 'black'>('white');
  const [now, setNow] = useState(Date.now());
  const [message, setMessage] = useState<string | null>(null);
  const [confirmResign, setConfirmResign] = useState(false);
  const [finished, setFinished] = useState<{ match: RankedMatch; gameId: string } | null>(null);
  const [review, setReview] = useState<GameReview | null>(null);
  const thinking = useRef<number>(-1);
  const finishing = useRef<string | null>(null);

  useEffect(() => {
    loadRankedProfile().then(setProfile);
    if (activeRanked) {
      get('rankedMatches', activeRanked).then((m) => {
        if (m && m.status === 'active') {
          const s = restoreRanked(m);
          rsRef.current = s; setRsRaw(s);
          setOrientation(m.playerColor === 'w' ? 'white' : 'black');
        } else setActiveRanked(null);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // clock tick + flag
  useEffect(() => {
    if (!rs || rs.match.status !== 'active') return;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      const cur = rsRef.current;
      if (cur && cur.match.status === 'active') {
        const f = checkFlag(cur, n);
        if (f.match.status !== 'active') { setRs(f); void finish(f); }
      }
    }, 200);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rs?.match.id, rs?.match.status]);

  // Rival's turn
  useEffect(() => {
    const s = rsRef.current;
    if (!s || s.match.status !== 'active') return;
    const turn = new Chess(rankedFen(s)).turn();
    if (turn === s.match.playerColor) return;
    const ply = s.match.moves.length;
    if (thinking.current === ply) return;
    thinking.current = ply;
    void rivalMove(s, ply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rs?.match.moves.length, rs?.match.id]);

  const rivalMove = async (s: RankedState, ply: number) => {
    const m = s.match;
    const rivalColor = m.playerColor === 'w' ? 'b' : 'w';
    const prof = strengthFor(m.rivalLevel); // fixed for the whole game
    const rand = mulberry32(seedFrom(m.seed, ply));
    const fen = rankedFen(s);
    const ctx = { fen, history: m.ucis, rivalColor: rivalColor as 'w' | 'b', playerClockFraction: isTimed(s.clock) ? remainingMs(s.clock, m.playerColor, Date.now()) / (m.timeControl.initial * 1000) : 1 };
    try {
      const { move } = await pickMove(getEngine(), fen, prof, rand, async (cands) => applyStrategy(await withOpeningCandidates(getEngine(), cands, m.strategy, ctx, prof), m.strategy, ctx));
      const cur = rsRef.current;
      if (!cur || cur.match.status !== 'active' || cur.match.moves.length !== ply) return;
      const next = playRankedMove(cur, move.uci, Date.now(), move.reasons.length ? move.reasons : ['strongest practical move at this level']);
      setRs(next);
      if (next.match.status !== 'active') void finish(next);
    } catch {
      thinking.current = -1; // allow a retry on the next render
      setTimeout(() => setNow(Date.now()), 500);
    }
  };

  const start = async () => {
    const p = await loadRankedProfile();
    const model = await loadRivalModel();
    const playerColor = color === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : color;
    const level = rivalLevelFor(p);
    const tc = TIME_CONTROLS.find((t) => t.id === tcId)!.tc;
    const s = createMatch({ playerColor, rivalLevel: level, timeControl: tc, strategy: deriveStrategy(model, playerColor === 'w' ? 'b' : 'w') });
    thinking.current = -1;
    setFinished(null); setReview(null); setMessage(null);
    setOrientation(playerColor === 'w' ? 'white' : 'black');
    setRs(s);
    setActiveRanked(s.match.id);
  };

  const onMove = (mv: BoardMove) => {
    const s = rsRef.current;
    if (!s || s.match.status !== 'active') return false;
    if (new Chess(rankedFen(s)).turn() !== s.match.playerColor) return false;
    let next: RankedState;
    try { next = playRankedMove(s, mv, Date.now()); } catch { return false; }
    setMessage(null);
    setRs(next);
    if (next.match.status !== 'active') void finish(next);
    return true;
  };

  const finish = async (s: RankedState) => {
    if (finishing.current === s.match.id) return;
    finishing.current = s.match.id;
    setActiveRanked(null);
    const { match, profile: p } = await recordRankedResult(s.match);
    setProfile(p);
    const g = gameFromMoves('ranked', match.moves, {
      Event: 'Chess of Life Ranked', Date: new Date(match.createdAt).toISOString().slice(0, 10).replace(/-/g, '.'),
      White: match.playerColor === 'w' ? 'You' : `Rival (level ${match.rivalLevel})`, Black: match.playerColor === 'b' ? 'You' : `Rival (level ${match.rivalLevel})`,
      Result: match.result, TimeControl: match.timeControl.initial ? `${match.timeControl.initial}+${match.timeControl.increment}` : '-', Termination: match.reason ? REASON_TEXT[match.reason] : '',
    }, match.result, match.startFen);
    g.rankedMatchId = match.id;
    // clocks into the tree for the PGN
    let id = g.tree.rootId;
    match.clockAfter.forEach((c) => { const child = g.tree.nodes[id].children[0]; if (!child) return; if (c >= 0) g.tree.nodes[child] = { ...g.tree.nodes[child], clock: c / 1000 }; id = child; });
    await saveGame(g);
    const m2 = { ...match, gameId: g.id };
    await saveMatch(m2);
    rsRef.current = { ...s, match: m2 }; setRsRaw(rsRef.current);
    setFinished({ match: m2, gameId: g.id });
    // post-game analysis: only now does any engine evaluation of this game happen
    ensureReview(g, { quickDepth: prefs.quickDepth, deepDepth: prefs.deepDepth }, setReview);
  };

  const offerDraw = async () => {
    const s = rsRef.current;
    if (!s || s.match.status !== 'active') return;
    if (s.match.drawOfferedByPlayerAtPly !== undefined && s.match.moves.length - s.match.drawOfferedByPlayerAtPly < 10) { setMessage('You offered a draw recently. Play on a little first.'); return; }
    const ply = s.match.moves.length;
    setRs({ ...s, match: { ...s.match, drawOfferedByPlayerAtPly: ply } });
    setMessage('Draw offered…');
    try {
      const r = await getEngine().analyze({ fen: rankedFen(s), depth: strengthFor(s.match.rivalLevel).depth, multipv: 1, priority: 2 });
      const rivalWin = r.lines[0] ? winPercentPov(r.lines[0].score, s.match.playerColor === 'w' ? 'b' : 'w') : 50;
      const cur = rsRef.current!;
      if (cur.match.status !== 'active') return;
      if (rivalAcceptsDraw(rivalWin, ply)) { const d = agreeDraw(cur, Date.now()); setRs(d); setMessage('The Rival accepted the draw.'); void finish(d); }
      else setMessage('The Rival declines the draw offer.');
    } catch { setMessage('The Rival did not respond to the offer.'); }
  };

  const claim = (c: 'threefold-repetition' | 'fifty-move') => {
    const s = rsRef.current;
    if (!s) return;
    try { const d = claimDraw(s, c, Date.now()); setRs(d); void finish(d); } catch (e) { setMessage(String((e as Error).message)); }
  };

  const resign = () => {
    setConfirmResign(false);
    const s = rsRef.current;
    if (!s) return;
    const d = resignRanked(s, Date.now());
    setRs(d);
    void finish(d);
  };

  // ---------- setup ----------
  if (!rs || (rs.match.status !== 'active' && !finished)) {
    const level = profile ? rivalLevelFor(profile) : 6;
    return (
      <div style={{ maxWidth: 720 }}>
        <h1>Ranked Rival</h1>
        <p className="muted">A competitive game against an opponent that plays to win. The Rival studies your completed Ranked games — only your own, unassisted decisions — and steers toward the positions you handle worst. During the game there is no help of any kind: no hints, takebacks, evaluations or move ratings. Analysis unlocks when the game ends.</p>
        <div className="card stack">
          <div className="row" style={{ gap: 28 }}>
            <div className="stat"><b data-testid="ranked-rating">{profile ? Math.round(profile.rating.r) : '—'}</b><span>internal rating ± {profile ? Math.round(profile.rating.rd * 2) : '—'}</span></div>
            <div className="stat"><b>{level}</b><span>Rival level (rated {levelRating(level)})</span></div>
            <div className="stat"><b>{profile ? `${profile.wins}/${profile.draws}/${profile.losses}` : '—'}</b><span>W / D / L</span></div>
          </div>
          <label className="field">Time control
            <select value={tcId} onChange={(e) => setTcId(e.target.value)} data-testid="time-control">{TIME_CONTROLS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
          </label>
          <div className="row"><span style={{ width: 120 }}>Your colour</span>
            <div className="segmented">{(['w', 'b', 'random'] as const).map((c) => <button key={c} className={color === c ? 'on' : ''} onClick={() => setColor(c)}>{c === 'w' ? 'White' : c === 'b' ? 'Black' : 'Random'}</button>)}</div>
          </div>
          <div className="faint small">The rating is Chess of Life’s own internal Glicko-2 rating against fixed Rival levels. It is not a FIDE or online-site rating. The Rival’s level is fixed when the game starts and never changes mid-game.</div>
          <div><button className="btn primary" onClick={start} data-testid="start-ranked">Start Ranked game</button></div>
        </div>
      </div>
    );
  }

  const m = rs.match;
  const fen = rankedFen(rs);
  const player = m.playerColor;
  const rival = player === 'w' ? 'b' : 'w';
  const active = m.status === 'active';
  const status = gameStatus(rs.fens);
  const lastUci = m.ucis[m.ucis.length - 1];
  const top = orientation === 'white' ? 'b' : 'w';
  const names: Record<'w' | 'b', string> = { [player]: 'You', [rival]: `Rival · level ${m.rivalLevel}` } as Record<'w' | 'b', string>;
  const clockOf = (c: 'w' | 'b') => (isTimed(rs.clock) ? remainingMs(rs.clock, c, now) : undefined);
  const delta = finished?.match.ratingAfter && finished.match.ratingBefore ? finished.match.ratingAfter.r - finished.match.ratingBefore.r : null;

  return (
    <div className={active ? 'ranked-focus' : ''}>
      <div className="row between" style={{ marginBottom: 10 }}>
        <h1 style={{ margin: 0 }}>{active ? 'Ranked game' : 'Ranked game — finished'}</h1>
        {active && <span className="pill warn" data-testid="ranked-live">No assistance · {m.timeControl.initial ? `${m.timeControl.initial / 60}+${m.timeControl.increment}` : 'untimed'}</span>}
      </div>
      <div className="play">
        <div className="board-col">
          <PlayerBar name={names[top]} color={top} fen={fen} clockMs={clockOf(top)} running={active && rs.clock.running === top} />
          <Board fen={fen} orientation={orientation} movable={active ? player : 'none'} onMove={onMove} lastMove={lastUci ? [lastUci.slice(0, 2), lastUci.slice(2, 4)] : null} id="ranked-board" />
          <PlayerBar name={names[top === 'w' ? 'b' : 'w']} color={top === 'w' ? 'b' : 'w'} fen={fen} clockMs={clockOf(top === 'w' ? 'b' : 'w')} running={active && rs.clock.running === (top === 'w' ? 'b' : 'w')} />
          <div className="controls">
            <button className="btn icon" onClick={() => setOrientation(orientation === 'white' ? 'black' : 'white')} aria-label="Flip board"><IconFlip /></button>
            {active && <>
              <button className="btn" onClick={offerDraw} data-testid="offer-draw">Offer draw</button>
              {status.claimable.map((c) => <button key={c} className="btn" onClick={() => claim(c)}>Claim draw ({c === 'fifty-move' ? '50-move rule' : 'threefold'})</button>)}
              <span className="spacer" />
              <button className="btn danger" onClick={() => (prefs.confirmResign ? setConfirmResign(true) : resign())} data-testid="resign">Resign</button>
            </>}
          </div>
          {message && <div className="notice small">{message}</div>}
        </div>
        <div className="side-col">
          {finished && (
            <div className="card stack" data-testid="ranked-result">
              <h2 style={{ margin: 0 }}>{m.result === '1/2-1/2' ? 'Draw' : (m.result === '1-0') === (player === 'w') ? 'You won' : 'You lost'} · {m.result}</h2>
              <div className="muted">{m.reason ? REASON_TEXT[m.reason] : ''}</div>
              {delta !== null && <div>Rating {Math.round(finished.match.ratingBefore!.r)} → <b>{Math.round(finished.match.ratingAfter!.r)}</b> ({delta >= 0 ? '+' : ''}{delta.toFixed(1)}) · uncertainty ±{Math.round(finished.match.ratingAfter!.rd * 2)}</div>}
              <div className="small muted">{review ? (review.status === 'complete' ? 'Post-game analysis complete. The Rival has updated its model of your play.' : `Post-game analysis ${Math.round((review.progress.done / Math.max(1, review.progress.total)) * 100)}%…`) : 'Post-game analysis starting…'}</div>
              <div className="row">
                <button className="btn primary" onClick={() => navigate(`review/${finished.gameId}`)} data-testid="ranked-review">Review & explore this game</button>
                <button className="btn" onClick={() => { setRsRaw(null); rsRef.current = null; setFinished(null); }}>New Ranked game</button>
              </div>
              {m.strategy.notes.length > 0 && (
                <div><h3>The Rival’s plan this game</h3><ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{m.strategy.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></div>
              )}
              {m.rivalNotes.some((n) => n.reasons.some((r) => r !== 'strongest practical move at this level')) && (
                <div><h3>Where it showed</h3><ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{m.rivalNotes.filter((n) => n.reasons.some((r) => r !== 'strongest practical move at this level')).slice(0, 8).map((n) => <li key={n.ply}>{Math.ceil((n.ply + 1) / 2)}{n.ply % 2 === 0 ? '.' : '…'} {n.san}: {n.reasons.join(', ')}</li>)}</ul></div>
              )}
            </div>
          )}
          <div className="card">
            <div className="row between"><h3 style={{ margin: 0 }}>Moves</h3><span className="faint small">{active ? (status.inCheck ? 'Check' : new Chess(fen).turn() === player ? 'Your move' : 'Rival to move') : ''}</span></div>
            <MoveList moves={m.moves.map((san) => ({ san }))} current={m.moves.length} />
          </div>
          {active && <div className="card small muted">Ranked rules: no hints, no takebacks, no evaluation bar, no move ratings, no engine lines, no prediction exercises, no coaching and no analysis until the game is over. Leaving this page does not pause the clock.</div>}
        </div>
      </div>
      {confirmResign && (
        <Modal onClose={() => setConfirmResign(false)}>
          <h2>Resign this Ranked game?</h2>
          <p className="muted">It counts as a loss for your rating.</p>
          <div className="row"><span className="spacer" /><button className="btn" onClick={() => setConfirmResign(false)}>Cancel</button><button className="btn danger" onClick={resign} data-testid="confirm-resign">Resign</button></div>
        </Modal>
      )}
    </div>
  );
}
