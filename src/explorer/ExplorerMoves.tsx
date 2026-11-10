import { Chess } from 'chess.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { continuations } from '../analysis/openings';
import { getEngine } from '../engine/instance';
import { AbortedError } from '../engine/controller';
import { formatScore, povCp, type Score } from '../engine/score';
import { listGames } from '../db/db';
import type { GameRecord } from '../db/types';
import { useApp } from '../ui/context';
import { IconCpu } from '../ui/icons';
import { DEFAULT_LOCAL, localExplorer, movesNotInDatabase, type LocalFilter } from './local';
import { ExplorerError, fetchLichess, fetchMasters, fetchPlayer, getLichessUser } from './lichess';
import { percentages, RATING_GROUPS, scoreFor, SPEEDS, total, type ExGame, type ExplorerDb, type ExResult, type LichessFilter, type MastersFilter, type PlayerFilter, type Speed } from './types';
import { LichessConnect, useLichessToken } from './LichessConnect';

type Sort = 'games' | 'score' | 'eval';
const DB_LABEL: Record<ExplorerDb, string> = { masters: 'Masters', lichess: 'Online', local: 'My games', player: 'Player', book: 'Book' };
const SPEED_LABEL: Record<Speed, string> = { ultraBullet: 'UltraBullet', bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid', classical: 'Classical', correspondence: 'Corresp.' };
const PREFS = 'col.explorer.prefs';
interface Saved { db: ExplorerDb; masters: MastersFilter; lichess: LichessFilter; player: PlayerFilter; local: LocalFilter; sort: Sort }
const DEFAULTS: Saved = {
  db: 'local', sort: 'games', masters: {}, lichess: { speeds: ['blitz', 'rapid', 'classical'], ratings: [1600, 1800, 2000, 2200, 2500] },
  player: { name: '', color: 'white', speeds: [], modes: ['rated'] }, local: DEFAULT_LOCAL,
};
function loadSaved(): Saved { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS) ?? '{}') }; } catch { return DEFAULTS; } }


export interface ExplorerMovesProps {
  fen: string;
  onPlay: (uci: string) => void;
  /** open a game from the list (load it, or import it into Game Review) */
  onGame?: (g: ExGame, action: 'review' | 'load') => void;
  compact?: boolean;
}

/** Position statistics from the selected database, with filters, sorting and optional engine evaluations. */
export function ExplorerMoves({ fen, onPlay, onGame, compact }: ExplorerMovesProps) {
  const { prefs } = useApp();
  const [s, setS] = useState<Saved>(loadSaved);
  const save = (p: Partial<Saved>) => setS((x) => { const n = { ...x, ...p }; try { localStorage.setItem(PREFS, JSON.stringify(n)); } catch { /* ignore */ } return n; });
  const token = useLichessToken();
  const [games, setGames] = useState<GameRecord[] | null>(null);
  const [res, setRes] = useState<ExResult | null>(null);
  const [err, setErr] = useState<ExplorerError | null>(null);
  const [loading, setLoading] = useState(false);
  const [engineOn, setEngineOn] = useState(false);
  const [evals, setEvals] = useState<{ fen: string; scores: Record<string, Score>; depth: number } | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const reqId = useRef(0);
  const side = new Chess(fen).turn();
  useEffect(() => { listGames().then(setGames).catch(() => setGames([])); }, []);

  const online = s.db === 'masters' || s.db === 'lichess' || s.db === 'player';
  // load statistics for this position and filters (debounced, latest request wins)
  useEffect(() => {
    if (s.db === 'book') { setRes(null); setErr(null); return; }
    if (s.db === 'local') {
      reqId.current++;
      setLoading(false);
      if (!games) return;
      setErr(null);
      setRes(localExplorer(games, fen, s.local, prefs.playerNames));
      return;
    }
    if (!token) { setRes(null); setErr(new ExplorerError('auth', 'Connect a Lichess account to use this database.')); return; }
    const id = ++reqId.current;
    // never show numbers from another database, filter or position while loading
    setRes(null); setErr(null);
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = s.db === 'masters' ? await fetchMasters(fen, s.masters) : s.db === 'lichess' ? await fetchLichess(fen, s.lichess) : await fetchPlayer(fen, s.player);
        if (id === reqId.current) { setRes(r); setErr(null); }
      } catch (e) {
        if (id === reqId.current) { setRes(null); setErr(e instanceof ExplorerError ? e : new ExplorerError('http', String(e))); }
      } finally { if (id === reqId.current) setLoading(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [fen, s.db, s.masters, s.lichess, s.player, s.local, games, token, prefs.playerNames]);

  // engine evaluations of the listed moves (only when asked for)
  const listed = useMemo(() => (res?.moves ?? []).slice(0, 10).map((m) => m.uci), [res]);
  useEffect(() => {
    if (!engineOn || !listed.length) { setEvals(null); return; }
    const ac = new AbortController();
    getEngine().analyze({ fen, depth: prefs.liveDepth, multipv: listed.length, searchmoves: listed, priority: 2, signal: ac.signal })
      .then((r) => { const scores: Record<string, Score> = {}; for (const l of r.lines) if (l.pv[0]) scores[l.pv[0]] = l.score; setEvals({ fen, scores, depth: r.depth }); })
      .catch((e) => { if (!(e instanceof AbortedError)) setEvals(null); });
    return () => ac.abort();
  }, [engineOn, fen, listed.join(','), prefs.liveDepth]); // eslint-disable-line react-hooks/exhaustive-deps

  const moves = useMemo(() => {
    const ms = [...(res?.moves ?? [])];
    if (s.sort === 'score') ms.sort((a, b) => (scoreFor(b, side) ?? -1) - (scoreFor(a, side) ?? -1));
    else if (s.sort === 'eval' && evals?.fen === fen) ms.sort((a, b) => (evals.scores[b.uci] ? povCp(evals.scores[b.uci], side) : -1e9) - (evals.scores[a.uci] ? povCp(evals.scores[a.uci], side) : -1e9));
    else ms.sort((a, b) => total(b) - total(a));
    return ms;
  }, [res, s.sort, evals, fen, side]);
  const posTotal = res ? total(res) : 0;
  const listedTotal = moves.reduce((n, m) => n + total(m), 0);
  const missing = res ? movesNotInDatabase(fen, moves.map((m) => m.uci)) : [];
  const gamesList = res ? [...res.topGames, ...res.recentGames] : [];

  return (
    <div className={`xp${compact ? ' is-compact' : ''}`} data-testid="explorer-db">
      <div className="xp-bar">
        <div className="seg seg-sm" role="tablist" aria-label="Database">
          {(['masters', 'lichess', 'local', 'player', ...(compact ? [] : ['book'])] as ExplorerDb[]).map((d) => (
            <button key={d} type="button" role="tab" aria-selected={s.db === d} onClick={() => save({ db: d })} data-testid={`db-${d}`}>{DB_LABEL[d]}</button>
          ))}
        </div>
        <span className="spacer" />
        {s.db !== 'book' && <button type="button" className="btn btn-sm btn-quiet" aria-pressed={showFilters} onClick={() => setShowFilters(!showFilters)} data-testid="xp-filters-toggle">Filters</button>}
        {s.db !== 'book' && <button type="button" className="btn btn-sm btn-quiet" aria-pressed={engineOn} onClick={() => setEngineOn(!engineOn)} title="Engine evaluation of each move (popularity is not quality)" data-testid="xp-engine"><IconCpu size={14} /> Eval</button>}
      </div>
      {showFilters && s.db !== 'book' && <Filters s={s} save={save} />}

      {s.db === 'book' && <BookMoves fen={fen} onPlay={onPlay} />}
      {online && !token && <LichessConnect reason={s.db === 'masters' ? 'Master games come from the Lichess masters database (over-the-board games since 1952).' : s.db === 'player' ? 'Player statistics come from Lichess.' : 'Online games come from the Lichess database of rated games.'} />}
      {online && token && err && <div className={`notice ${err.kind === 'rate' ? '' : 'is-error'}`} role="status" data-testid="xp-error">{err.message}{err.kind === 'auth' && <> <LichessConnect inline /></>}</div>}
      {s.db === 'player' && token && !s.player.name && <p className="small dim">Enter a Lichess username in the filters{getLichessUser() ? <> or <button type="button" className="link-btn" onClick={() => save({ player: { ...s.player, name: getLichessUser()! } })}>use {getLichessUser()}</button></> : ''}.</p>}
      {res?.queuePosition ? <p className="small dim" role="status">Lichess is still indexing this player's games (queue position {res.queuePosition}). The numbers grow as it does.</p> : null}

      {res && s.db !== 'book' && (
        <>
          <table className="xp-table" data-testid="xp-table">
            <thead>
              <tr>
                <th><button type="button" className="th-sort" aria-pressed={s.sort === 'games'} onClick={() => save({ sort: 'games' })}>Move</button></th>
                <th className="num"><button type="button" className="th-sort" aria-pressed={s.sort === 'games'} onClick={() => save({ sort: 'games' })} data-testid="sort-games">Games</button></th>
                <th className="xp-bar-col"><button type="button" className="th-sort" aria-pressed={s.sort === 'score'} onClick={() => save({ sort: 'score' })} data-testid="sort-score">White / Draw / Black</button></th>
                {engineOn && <th className="num"><button type="button" className="th-sort" aria-pressed={s.sort === 'eval'} onClick={() => save({ sort: 'eval' })} data-testid="sort-eval">Eval</button></th>}
              </tr>
            </thead>
            <tbody>
              {moves.map((m) => {
                const t = total(m);
                return (
                  <tr key={m.uci} onClick={() => onPlay(m.uci)} className="xp-row" data-testid="xp-move" data-uci={m.uci}>
                    <td><button type="button" className="xp-san" onClick={(e) => { e.stopPropagation(); onPlay(m.uci); }}>{m.san}</button>{m.averageRating ? <span className="xs faint"> {m.averageRating}</span> : null}</td>
                    <td className="num"><span>{t.toLocaleString()}</span> <span className="xs faint">{posTotal ? `${((t / posTotal) * 100).toFixed(t / posTotal < 0.1 ? 1 : 0)}%` : ''}</span></td>
                    <td className="xp-bar-col"><WdlBar m={m} /></td>
                    {engineOn && <td className="num small">{evals?.fen === fen && evals.scores[m.uci] ? formatScore(evals.scores[m.uci]) : '…'}</td>}
                  </tr>
                );
              })}
              {moves.length > 0 && (
                <tr className="xp-sum"><td className="faint">Σ</td><td className="num">{posTotal.toLocaleString()}</td><td className="xp-bar-col"><WdlBar m={res} /></td>{engineOn && <td />}</tr>
              )}
            </tbody>
          </table>
          {moves.length === 0 && <p className="small dim" data-testid="xp-empty">{s.db === 'local' ? 'None of your saved games reached this position with these filters.' : `No games in this database reached this position${res.db === 'lichess' ? ' with these filters' : ''}.`}</p>}
          {engineOn && <p className="xs faint" style={{ margin: '4px 0 0' }}>Evaluations{evals ? ` (depth ${evals.depth})` : ''} are the engine's view of each move; how often a move is played says nothing about its quality.</p>}
          {missing.length > 0 && (
            <details className="disclose xp-missing">
              <summary>{res.truncated || listedTotal < posTotal ? `Other legal moves (${missing.length}): not among the most common in this database` : `Legal moves not in this database (${missing.length})`}</summary>
              <div className="row" style={{ gap: 4, marginTop: 6 }}>{missing.map((m) => <button key={m.uci} type="button" className="btn btn-sm btn-quiet" onClick={() => onPlay(m.uci)}>{m.san}</button>)}</div>
            </details>
          )}
          {res.fromCache && <p className="xs faint" style={{ margin: '4px 0 0' }}>Saved answer from Lichess{loading ? ', refreshing…' : ''}.</p>}
          {gamesList.length > 0 && !compact && <GamesList games={gamesList} fen={fen} onGame={onGame} />}
        </>
      )}
      {loading && !res && <p className="small dim" role="status">Loading…</p>}
    </div>
  );
}

function WdlBar({ m }: { m: { white: number; draws: number; black: number } }) {
  const p = percentages(m);
  const lab = (v: number) => (v >= 12 ? <>{v.toFixed(0)}<small>%</small></> : null);
  return (
    <span className="xp-wdl" title={`White ${p.white.toFixed(1)}%, draws ${p.draws.toFixed(1)}%, Black ${p.black.toFixed(1)}%`} aria-label={`White wins ${p.white.toFixed(0)}%, draws ${p.draws.toFixed(0)}%, Black wins ${p.black.toFixed(0)}%`}>
      <i className="w" style={{ width: `${p.white}%` }}>{lab(p.white)}</i>
      <i className="d" style={{ width: `${p.draws}%` }}>{lab(p.draws)}</i>
      <i className="b" style={{ width: `${p.black}%` }}>{lab(p.black)}</i>
    </span>
  );
}

function BookMoves({ fen, onPlay }: { fen: string; onPlay: (u: string) => void }) {
  const cs = continuations(fen);
  if (!cs.length) return <p className="small dim">No catalogued opening lines continue from here. That does not make a move bad.</p>;
  return (
    <table className="xp-table" data-testid="xp-book">
      <thead><tr><th>Move</th><th>Opening</th><th className="num" title="Catalogued lines through the move (not games)">Lines</th></tr></thead>
      <tbody>{cs.map((c) => <tr key={c.uci} className="xp-row" onClick={() => onPlay(c.uci)}><td><button type="button" className="xp-san">{c.san}</button></td><td className="small dim ellipsis">{c.opening?.name ?? '—'}</td><td className="num">{c.lines}</td></tr>)}</tbody>
    </table>
  );
}

function GamesList({ games, fen, onGame }: { games: ExGame[]; fen: string; onGame?: (g: ExGame, a: 'review' | 'load') => void }) {
  const res = (g: ExGame) => (g.winner === 'white' ? '1-0' : g.winner === 'black' ? '0-1' : '½-½');
  const san = (u?: string) => { if (!u) return ''; try { return new Chess(fen).move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san; } catch { return ''; } };
  const seen = new Set<string>();
  return (
    <div className="xp-games" data-testid="xp-games">
      <h3 className="section-title">Games</h3>
      <ul>
        {games.filter((g) => (seen.has(g.id) ? false : (seen.add(g.id), true))).map((g) => (
          <li key={`${g.source}${g.id}`} data-testid="xp-game">
            <div className="xp-game-main">
              <span className="ellipsis"><b>{g.white.name}</b>{g.white.rating ? ` ${g.white.rating}` : ''} – <b>{g.black.name}</b>{g.black.rating ? ` ${g.black.rating}` : ''}</span>
              <span className="xs faint">{res(g)} · {g.date ?? g.month ?? g.year ?? ''}{g.speed ? ` · ${g.speed}` : ''}{g.uci ? ` · played ${san(g.uci)}` : ''}</span>
            </div>
            {onGame && <div className="row-nowrap" style={{ gap: 4 }}>
              <button type="button" className="btn btn-sm btn-quiet" onClick={() => onGame(g, 'load')} title="Replay this game in the Explorer">Load</button>
              <button type="button" className="btn btn-sm btn-quiet" onClick={() => onGame(g, 'review')} title={g.source === 'local' ? 'Open it in Game Review' : 'Import it into Game Review'} data-testid="xp-game-review">Review</button>
            </div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Filters({ s, save }: { s: Saved; save: (p: Partial<Saved>) => void }) {
  const year = new Date().getFullYear();
  if (s.db === 'masters') {
    return (
      <div className="xp-filters" data-testid="xp-filters">
        <label className="field">Since <input className="input input-sm" type="number" min={1952} max={year} value={s.masters.since ?? ''} placeholder="1952" onChange={(e) => save({ masters: { ...s.masters, since: e.target.value ? Number(e.target.value) : undefined } })} data-testid="f-since" /></label>
        <label className="field">Until <input className="input input-sm" type="number" min={1952} max={year} value={s.masters.until ?? ''} placeholder={String(year)} onChange={(e) => save({ masters: { ...s.masters, until: e.target.value ? Number(e.target.value) : undefined } })} /></label>
      </div>
    );
  }
  if (s.db === 'lichess' || s.db === 'player') {
    const f = s.db === 'lichess' ? s.lichess : s.player;
    const set = (p: Partial<LichessFilter & PlayerFilter>) => (s.db === 'lichess' ? save({ lichess: { ...s.lichess, ...p } as LichessFilter }) : save({ player: { ...s.player, ...p } as PlayerFilter }));
    const toggle = <T,>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
    return (
      <div className="xp-filters" data-testid="xp-filters">
        {s.db === 'player' && (
          <>
            <label className="field">Player <input className="input input-sm" value={s.player.name} onChange={(e) => save({ player: { ...s.player, name: e.target.value.trim() } })} placeholder="Lichess username" data-testid="f-player" /></label>
            <div className="seg seg-sm" role="group" aria-label="Playing as">
              {(['white', 'black'] as const).map((c) => <button key={c} type="button" aria-pressed={s.player.color === c} onClick={() => save({ player: { ...s.player, color: c } })}>As {c}</button>)}
            </div>
          </>
        )}
        <div className="xp-chips" role="group" aria-label="Time controls">
          {SPEEDS.map((sp) => <button key={sp} type="button" className="chip" aria-pressed={f.speeds.includes(sp)} onClick={() => set({ speeds: toggle(f.speeds, sp) })} data-testid={`f-speed-${sp}`}>{SPEED_LABEL[sp]}</button>)}
        </div>
        {s.db === 'lichess' && (
          <div className="xp-chips" role="group" aria-label="Average rating">
            {RATING_GROUPS.map((r) => <button key={r} type="button" className="chip" aria-pressed={s.lichess.ratings.includes(r)} onClick={() => set({ ratings: toggle(s.lichess.ratings, r) })} data-testid={`f-rating-${r}`}>{r === 0 ? '<1000' : r === 2500 ? '2500+' : r}</button>)}
          </div>
        )}
        {s.db === 'player' && (
          <div className="xp-chips" role="group" aria-label="Game mode">
            {(['rated', 'casual'] as const).map((m) => <button key={m} type="button" className="chip" aria-pressed={s.player.modes.includes(m)} onClick={() => save({ player: { ...s.player, modes: toggle(s.player.modes, m) } })}>{m === 'rated' ? 'Rated' : 'Casual'}</button>)}
          </div>
        )}
        <label className="field">Since <input className="input input-sm" type="month" value={f.since ?? ''} onChange={(e) => set({ since: e.target.value || undefined })} /></label>
        <label className="field">Until <input className="input input-sm" type="month" value={f.until ?? ''} onChange={(e) => set({ until: e.target.value || undefined })} /></label>
      </div>
    );
  }
  // local
  return (
    <div className="xp-filters" data-testid="xp-filters">
      <select className="input input-sm" value={s.local.source} onChange={(e) => save({ local: { ...s.local, source: e.target.value as LocalFilter['source'] } })} aria-label="Which games">
        <option value="all">All saved games</option><option value="ranked">Ranked</option><option value="coach">Coach</option><option value="pgn">Imported</option><option value="manual">Reconstructed</option>
      </select>
      <div className="seg seg-sm" role="group" aria-label="You played">
        {(['any', 'w', 'b'] as const).map((c) => <button key={c} type="button" aria-pressed={s.local.as === c} onClick={() => save({ local: { ...s.local, as: c } })} data-testid={`f-as-${c}`}>{c === 'any' ? 'Any side' : c === 'w' ? 'I was White' : 'I was Black'}</button>)}
      </div>
      <label className="field">Player <input className="input input-sm" value={s.local.player ?? ''} onChange={(e) => save({ local: { ...s.local, player: e.target.value } })} placeholder="Name in imported PGNs" data-testid="f-local-player" /></label>
      <label className="field">From <input className="input input-sm" type="date" onChange={(e) => save({ local: { ...s.local, from: e.target.value ? Date.parse(e.target.value) : undefined } })} /></label>
      <label className="field">To <input className="input input-sm" type="date" onChange={(e) => save({ local: { ...s.local, to: e.target.value ? Date.parse(e.target.value) + 86399_999 : undefined } })} /></label>
    </div>
  );
}
