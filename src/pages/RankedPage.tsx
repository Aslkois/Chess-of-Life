import { Chess } from 'chess.js';
import { useEffect, useRef, useState } from 'react';
import { Board, type BoardMove } from '../ui/Board';
import { MoveList } from '../ui/MoveList';
import { MoveStrip } from '../ui/MoveStrip';
import { PlayerStrip, Stage } from '../ui/stage';
import { ConfirmDialog } from '../ui/Dialog';
import { IconFlag, IconFlip, IconHandshake, IconLock, IconReview } from '../ui/icons';
import { listMatches } from '../services/ranked';
import { playerScore } from '../rival/ranked';
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
  const { activeRanked, rankedLoaded, setActiveRanked, prefs } = useApp();
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
  const [recent, setRecent] = useState<RankedMatch[]>([]);
  useEffect(() => { listMatches().then((m) => setRecent(m.filter((x) => x.status === 'finished').slice(0, 5))).catch(() => {}); }, [finished]);
  const finishing = useRef<string | null>(null);

  useEffect(() => { loadRankedProfile().then(setProfile); }, []);
  // resume a match in progress (the active id is read asynchronously at start-up)
  useEffect(() => {
    if (!rankedLoaded || rsRef.current) return;
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
  }, [rankedLoaded, activeRanked]);

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

  if (!rankedLoaded || (activeRanked && !rs)) return <div className="empty">Loading match…</div>;

  // ---------- setup ----------
  if (!rs || (rs.match.status !== 'active' && !finished)) {
    const level = profile ? rivalLevelFor(profile) : 6;
    return (
      <div className="page page-narrow">
        <header className="page-head">
          <div>
            <h1>Ranked Rival</h1>
            <div className="lede">Play to win against an opponent that studies your finished Ranked games. There is no help of any kind during the game: no hints, takebacks, evaluations or move ratings. Analysis opens when the game ends.</div>
          </div>
        </header>
        <div className="grid-2" style={{ alignItems: 'start' }}>
          <section className="surface surface-pad stack" aria-labelledby="ranked-setup">
            <h2 id="ranked-setup">New Ranked game</h2>
            <div className="stats">
              <div className="stat"><b data-testid="ranked-rating">{profile ? Math.round(profile.rating.r) : '–'}</b><span>your rating, ±{profile ? Math.round(profile.rating.rd * 2) : '–'}</span></div>
              <div className="stat"><b>{level}</b><span>Rival level (rated {levelRating(level)})</span></div>
              <div className="stat"><b className="num">{profile ? `${profile.wins}–${profile.draws}–${profile.losses}` : '–'}</b><span>wins, draws, losses</span></div>
            </div>
            <div className="field">
              <span className="field-label">Time control</span>
              <div className="seg" role="group" aria-label="Time control" style={{ flexWrap: 'wrap' }} data-testid="time-control">
                {TIME_CONTROLS.map((t) => <button key={t.id} type="button" aria-pressed={tcId === t.id} onClick={() => setTcId(t.id)} data-tc={t.id}>{t.id === 'untimed' ? 'Untimed' : t.id.replace('+', ' + ')}</button>)}
              </div>
              <span className="field-hint">{TIME_CONTROLS.find((t) => t.id === tcId)?.label}. Minutes per side plus seconds added after each move.</span>
            </div>
            <div className="field">
              <span className="field-label">Your colour</span>
              <div className="seg" role="group" aria-label="Your colour">
                {(['w', 'b', 'random'] as const).map((c) => <button key={c} type="button" aria-pressed={color === c} onClick={() => setColor(c)}>{c === 'w' ? 'White' : c === 'b' ? 'Black' : 'Random'}</button>)}
              </div>
            </div>
            <p className="xs faint" style={{ margin: 0 }}>The rating is Chess of Life's own Glicko-2 scale against fixed Rival levels, not a FIDE or online-site rating. The Rival's level is fixed for the whole game.</p>
            <div><button type="button" className="btn btn-primary btn-lg" onClick={start} data-testid="start-ranked">Start Ranked game</button></div>
          </section>
          <section className="surface" aria-labelledby="ranked-recent">
            <h2 id="ranked-recent" className="section-title" style={{ padding: 'var(--s-4) var(--s-4) 0' }}>Recent Ranked games</h2>
            {recent.length === 0 ? <div className="ml-empty">No Ranked games yet. Your first result sets your rating in motion.</div> : (
              <div className="side-list">
                {recent.map((m) => {
                  const sc = playerScore(m);
                  const d = m.ratingAfter && m.ratingBefore ? m.ratingAfter.r - m.ratingBefore.r : null;
                  return (
                    <a key={m.id} href={m.gameId ? `#/review/${m.gameId}` : '#/profile'}>
                      <span className="title">{sc === 1 ? 'Win' : sc === 0 ? 'Loss' : 'Draw'} as {m.playerColor === 'w' ? 'White' : 'Black'}<span className="sub">Rival level {m.rivalLevel}{m.reason ? `, ${REASON_TEXT[m.reason].toLowerCase()}` : ''}</span></span>
                      <span className="meta num" style={{ color: d === null ? undefined : d >= 0 ? 'var(--ok)' : '#f0857f' }}>{d === null ? '' : `${d >= 0 ? '+' : ''}${d.toFixed(0)}`}</span>
                    </a>
                  );
                })}
              </div>
            )}
          </section>
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
  const names: Record<'w' | 'b', string> = { [player]: 'You', [rival]: `Rival, level ${m.rivalLevel}` } as Record<'w' | 'b', string>;
  const clockOf = (c: 'w' | 'b') => (isTimed(rs.clock) ? remainingMs(rs.clock, c, now) : undefined);
  const turn = new Chess(fen).turn();
  const delta = finished?.match.ratingAfter && finished.match.ratingBefore ? finished.match.ratingAfter.r - finished.match.ratingBefore.r : null;
  const sc = playerScore(m);
  const tcText = m.timeControl.initial ? `${m.timeControl.initial / 60} + ${m.timeControl.increment}` : 'Untimed';
  const moves = m.moves.map((san) => ({ san }));
  const strip = (c: 'w' | 'b') => <PlayerStrip name={names[c]} color={c} fen={fen} clockMs={clockOf(c)} running={active && rs.clock.running === c} isTurn={active && turn === c} />;
  const askResign = () => (prefs.confirmResign ? setConfirmResign(true) : resign());

  return (
    <div className="page">
      <header className="page-head" style={{ marginBottom: 'var(--s-4)' }}>
        <div>
          <h1>{active ? 'Ranked game' : 'Ranked game finished'}</h1>
          <div className="lede small row-nowrap">{active ? <><IconLock size={15} /> Assistance off. {tcText}.</> : `${tcText}.`}</div>
        </div>
        {active && <span className="sr-only" data-testid="ranked-live">Ranked game in progress</span>}
      </header>
      <div className="board-layout">
        <Stage orientation={orientation} top={strip(top)} bottom={strip(top === 'w' ? 'b' : 'w')}
          below={<div className="row board-tools hide-mobile"><button type="button" className="btn btn-sm btn-quiet" onClick={() => setOrientation(orientation === 'white' ? 'black' : 'white')}><IconFlip size={16} /> Flip</button></div>}>
          {(size) => <Board fen={fen} orientation={orientation} size={size} movable={active ? player : 'none'} onMove={onMove} lastMove={lastUci ? [lastUci.slice(0, 2), lastUci.slice(2, 4)] : null} id="ranked-board" />}
        </Stage>
        <div className="panel-slot">
          <section className="panel" aria-label="Match">
            {finished && (
              <div className="result" data-testid="ranked-result">
                <div className={`result-title tone-${sc === 1 ? 'win' : sc === 0 ? 'loss' : 'draw'}`}>{sc === 1 ? 'You won' : sc === 0 ? 'You lost' : 'Draw'}</div>
                <div className="dim">{m.result === '1/2-1/2' ? '½–½' : m.result}{m.reason ? `, ${REASON_TEXT[m.reason].toLowerCase()}` : ''}</div>
                {delta !== null && (
                  <div className="result-rating">
                    <span className="num">{Math.round(finished.match.ratingBefore!.r)}</span>
                    <span className="faint">→</span>
                    <b className="num">{Math.round(finished.match.ratingAfter!.r)}</b>
                    <span className={`num delta ${delta >= 0 ? 'up' : 'down'}`}>{delta >= 0 ? '+' : ''}{delta.toFixed(1)}</span>
                  </div>
                )}
                <p className="small dim" style={{ margin: 0 }}>Rating {Math.round(finished.match.ratingAfter?.r ?? 0)} ± {Math.round((finished.match.ratingAfter?.rd ?? 0) * 2)}. {review ? (review.status === 'complete' ? 'Analysis complete; the Rival has updated its model of your play.' : `Analysing the game: ${Math.round((review.progress.done / Math.max(1, review.progress.total)) * 100)}%.`) : 'Analysis starting.'}</p>
                <div className="row">
                  <button type="button" className="btn btn-primary" onClick={() => navigate(`review/${finished.gameId}`)} data-testid="ranked-review"><IconReview size={18} /> Review this game</button>
                  <button type="button" className="btn" onClick={() => { setRsRaw(null); rsRef.current = null; setFinished(null); }}>New Ranked game</button>
                </div>
                {(m.strategy.notes.length > 0 || m.rivalNotes.some((n) => n.reasons.some((r) => r !== 'strongest practical move at this level'))) && (
                  <details className="disclose">
                    <summary>The Rival's plan this game</summary>
                    <ul className="move-explain">
                      {m.strategy.notes.map((n, i) => <li key={`s${i}`}>{n}</li>)}
                      {m.rivalNotes.filter((n) => n.reasons.some((r) => r !== 'strongest practical move at this level')).slice(0, 8).map((n) => <li key={n.ply}>{Math.ceil((n.ply + 1) / 2)}{n.ply % 2 === 0 ? '.' : '…'} {n.san}: {n.reasons.join(', ')}</li>)}
                    </ul>
                  </details>
                )}
              </div>
            )}
            {active && (
              <div className={`status-line${turn === player ? '' : ' is-wait'}`} role="status" aria-live="polite">
                <span className="status-dot" />
                <span>{status.inCheck && turn === player ? 'Your move. You are in check.' : turn === player ? 'Your move' : 'The Rival is thinking'}</span>
              </div>
            )}
            {message && <div className="notice" style={{ margin: 'var(--s-3) var(--s-4) 0' }} role="status">{message}</div>}
            <MoveStrip moves={moves} current={moves.length} />
            <MoveList moves={moves} current={moves.length} empty={active ? (player === 'w' ? 'You move first.' : 'The Rival moves first.') : 'No moves were played.'} />
            {active && (
              <div className="panel-foot hide-stacked">
                <div className="row-nowrap">
                  <button type="button" className="btn" onClick={offerDraw} data-testid="offer-draw" title="The Rival accepts only if it is not better"><IconHandshake size={18} /> Offer draw</button>
                  {status.claimable.map((c) => <button key={c} type="button" className="btn" onClick={() => claim(c)}>Claim draw ({c === 'fifty-move' ? '50 moves' : 'repetition'})</button>)}
                  <span className="spacer" />
                  <button type="button" className="btn btn-danger" onClick={askResign} data-testid="resign"><IconFlag size={18} /> Resign</button>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
      {active && (
        <div className="dock">
          <button type="button" className="btn btn-lg" style={{ flex: 1 }} onClick={offerDraw} data-testid="offer-draw-mobile"><IconHandshake size={18} /> Draw</button>
          {status.claimable.map((c) => <button key={c} type="button" className="btn btn-lg" style={{ flex: 1 }} onClick={() => claim(c)}>Claim</button>)}
          <button type="button" className="btn btn-lg btn-icon" onClick={() => setOrientation(orientation === 'white' ? 'black' : 'white')} aria-label="Flip board"><IconFlip /></button>
          <button type="button" className="btn btn-lg btn-danger" style={{ flex: 1 }} onClick={askResign} data-testid="resign-mobile"><IconFlag size={18} /> Resign</button>
        </div>
      )}
      <ConfirmDialog open={confirmResign} title="Resign this game?" body="It counts as a loss for your Ranked rating." danger testId="confirm-resign-dialog"
        confirmLabel="Resign game" cancelLabel="Keep playing" onCancel={() => setConfirmResign(false)} onConfirm={resign} />
    </div>
  );
}
