import { Chess } from 'chess.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Board, PlanToggle, TONE_COLOR, type BoardMove } from '../../ui/Board';
import { PlayerStrip, Stage } from '../../ui/stage';
import { MoveList } from '../../ui/MoveList';
import { ReplayControls } from '../../ui/Replay';
import { Dialog } from '../../ui/Dialog';
import { IconCpu, IconFlip, IconStar } from '../../ui/icons';
import { useApp } from '../../ui/context';
import { useKeys } from '../../ui/useKeys';
import { continuations, fensOf, trackOpening } from '../../analysis/openings';
import { formatLine, pvToSan } from '../../analysis/explain';
import { listGames } from '../../db/db';
import type { GameRecord } from '../../db/types';
import { gamesAtPosition, type GameFilter } from '../../services/openings';
import { gameTitle } from '../../services/games';
import { addLine } from '../../services/repertoire';
import { getEngine } from '../../engine/instance';
import type { AnalysisResult } from '../../engine/controller';
import { formatScore } from '../../engine/score';
import { prettyDate } from '../../util/format';
import { OpeningHeader } from './OpeningHeader';
import { parsePathParam, pathParam } from './paths';

type Pane = 'theory' | 'mine' | 'masters' | 'engine';

/** The part of a name that is new relative to the current one ("English Attack" under "…: Najdorf Variation"). */
export function relativeName(name: string, current?: string | null): string {
  if (!current || name === current) return name;
  if (name.startsWith(current)) return name.slice(current.length).replace(/^[:,]\s*/, '') || name;
  const fam = current.split(':')[0];
  if (name.startsWith(`${fam}: `)) return name.slice(fam.length + 2);
  return name;
}

/** A sensible default side for a new repertoire line (the user can change it). */
function defaultSide(family: string | undefined, lastMover: 'w' | 'b'): 'w' | 'b' {
  if (family && /Defen[cs]e|Declined|Accepted|Countergambit|Counter-Gambit/.test(family)) return 'b';
  if (family && /Opening|Game|Attack|Gambit|System/.test(family)) return 'w';
  return lastMover;
}
const moveNo = (ply: number) => `${Math.floor(ply / 2) + 1}${ply % 2 === 0 ? '.' : '...'}`;

export function ExplorerTab({ pathArg }: { pathArg: string }) {
  const { prefs, toast } = useApp();
  const initial = useMemo(() => { const p = parsePathParam(pathArg); return p.slice(0, fensOf(p).length - 1); }, [pathArg]);
  const [path, setPath] = useState<string[]>(initial);
  const [cursor, setCursor] = useState(initial.length);
  const [orientation, setOrientation] = useState<'white' | 'black'>('white');
  const [pane, setPane] = useState<Pane>('theory');
  const [games, setGames] = useState<GameRecord[] | null>(null);
  const [filter, setFilter] = useState<GameFilter>({ source: 'competitive', color: 'both', timeControl: 'any' });
  const [engine, setEngine] = useState<{ fen: string; r: AnalysisResult | null; busy: boolean; error?: string } | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => { listGames().then(setGames).catch(() => setGames([])); }, []);
  useEffect(() => () => abort.current?.abort(), []);

  const fens = useMemo(() => fensOf(path), [path]);
  const sans = useMemo(() => { const c = new Chess(); return path.map((u) => c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san); }, [path]);
  const fen = fens[cursor];
  const track = useMemo(() => trackOpening(fens.slice(0, cursor + 1)), [fens, cursor]);
  const ply = track.plies[cursor];
  const leftWith = !ply.inBook && ply.lastBookIndex >= 0 && ply.lastBookIndex < cursor ? `${moveNo(ply.lastBookIndex)}${sans[ply.lastBookIndex]}` : null;
  const conts = useMemo(() => continuations(fen), [fen]);
  const maxLines = Math.max(1, ...conts.map((c) => c.lines));
  const mine = useMemo(() => (games ? gamesAtPosition(games, fen, prefs.playerNames, filter) : null), [games, fen, prefs.playerNames, filter]);

  // keep the address in step with the position, without a navigation
  useEffect(() => {
    try { history.replaceState(null, '', `#/openings/explore/${pathParam(path.slice(0, cursor))}`); } catch { /* ignore */ }
  }, [path, cursor]);
  useEffect(() => { if (engine && engine.fen !== fen) { abort.current?.abort(); setEngine(null); } }, [fen]); // eslint-disable-line react-hooks/exhaustive-deps

  const play = (uci: string) => {
    if (path[cursor] === uci) { setCursor(cursor + 1); return; }
    setPath([...path.slice(0, cursor), uci]);
    setCursor(cursor + 1);
  };
  const onMove = (m: BoardMove) => {
    try { const mv = new Chess(fen).move(m); play(mv.from + mv.to + (mv.promotion ?? '')); return true; } catch { return false; }
  };
  const analyse = async () => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setEngine({ fen, r: null, busy: true });
    try {
      const r = await getEngine().analyze({ fen, depth: prefs.deepDepth, multipv: 3, priority: 2, signal: ac.signal });
      if (!ac.signal.aborted) setEngine({ fen, r, busy: false });
    } catch (e) {
      if (!ac.signal.aborted) setEngine({ fen, r: null, busy: false, error: (e as Error).message });
    }
  };

  useKeys({
    ArrowLeft: () => setCursor((c) => Math.max(0, c - 1)),
    ArrowRight: () => setCursor((c) => Math.min(path.length, c + 1)),
    Home: () => setCursor(0),
    End: () => setCursor(path.length),
    f: () => setOrientation((o) => (o === 'white' ? 'black' : 'white')),
  });

  const turn = new Chess(fen).turn();
  const top = orientation === 'white' ? 'b' : 'w';
  const arrows: [string, string, string][] = pane === 'theory' ? conts.slice(0, 3).map((c) => [c.uci.slice(0, 2), c.uci.slice(2, 4), TONE_COLOR.plan]) : [];
  const lastUci = cursor > 0 ? path[cursor - 1] : null;
  const defaultName = ply.opening?.name ?? (cursor ? sans.slice(0, cursor).join(' ') : 'New line');

  return (
    <div className="board-layout">
      <Stage orientation={orientation}
        top={<PlayerStrip name={top === 'w' ? 'White' : 'Black'} color={top} fen={fen} isTurn={turn === top} />}
        bottom={<PlayerStrip name={top === 'w' ? 'Black' : 'White'} color={top === 'w' ? 'b' : 'w'} fen={fen} isTurn={turn !== top} />}
        below={<div className="row board-tools">
          <button type="button" className="btn btn-sm btn-quiet" onClick={() => setOrientation(orientation === 'white' ? 'black' : 'white')} title="Flip board (F)"><IconFlip size={16} /> Flip</button>
          <PlanToggle />
          <span className="spacer" />
          <ReplayControls atStart={cursor === 0} atEnd={cursor === path.length} onFirst={() => setCursor(0)} onPrev={() => setCursor(Math.max(0, cursor - 1))} onNext={() => setCursor(Math.min(path.length, cursor + 1))} onLast={() => setCursor(path.length)} />
        </div>}>
        {(size) => <Board fen={fen} orientation={orientation} size={size} movable="both" onMove={onMove} lastMove={lastUci ? [lastUci.slice(0, 2), lastUci.slice(2, 4)] : null} arrows={arrows} frame="explore" id="explorer-board" />}
      </Stage>
      <div className="panel-slot">
        <section className="panel" aria-label="Opening explorer" data-testid="opening-explorer">
          <div className="section" style={{ paddingBottom: 'var(--s-3)' }}>
            <OpeningHeader ply={ply} leftWith={leftWith} />
            {track.reentered && ply.inBook && <p className="xs faint" style={{ margin: 'var(--s-2) 0 0' }}>This path left the catalogued theory and came back into it by transposition.</p>}
          </div>
          <div className="panel-tabs" role="tablist">
            <button type="button" role="tab" className="panel-tab" aria-selected={pane === 'theory'} onClick={() => setPane('theory')} data-testid="pane-theory">Theory <span className="count">{conts.length || ''}</span></button>
            <button type="button" role="tab" className="panel-tab" aria-selected={pane === 'mine'} onClick={() => setPane('mine')} data-testid="pane-mine">My games <span className="count">{mine?.games.length || ''}</span></button>
            <button type="button" role="tab" className="panel-tab" aria-selected={pane === 'masters'} onClick={() => setPane('masters')} data-testid="pane-masters">Masters</button>
            <button type="button" role="tab" className="panel-tab" aria-selected={pane === 'engine'} onClick={() => setPane('engine')} data-testid="pane-engine"><IconCpu size={16} />Engine</button>
          </div>
          <div className="panel-body">
            {pane === 'theory' && (
              <div className="section" data-testid="theory">
                {conts.length === 0 ? (
                  <p className="small dim" style={{ margin: 0 }}>{ply.inBook ? 'The catalogued lines end here. Play on to keep exploring.' : 'No catalogued lines continue from this position. That does not make a move bad: theory is simply not recorded here.'}</p>
                ) : (
                  <>
                    <p className="xs faint" style={{ marginTop: 0 }}>Moves on named lines in the reference, with how many catalogued lines pass through each. These are counts of lines in the list, not games.</p>
                    <ul className="cont-list">
                      {conts.map((c) => (
                        <li key={c.uci}>
                          <button type="button" className="cont-row" onClick={() => play(c.uci)} data-testid="continuation">
                            <b className="cont-san">{moveNo(cursor)}{c.san}</b>
                            <span className="cont-name ellipsis" title={c.opening?.name}>{c.opening ? relativeName(c.opening.name, ply.opening?.name) : <span className="faint">no name of its own</span>}</span>
                            <span className="cont-count num">{c.lines}</span>
                            <span className="cont-bar" aria-hidden="true"><i style={{ width: `${(c.lines / maxLines) * 100}%` }} /></span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
            {pane === 'mine' && <MyGames stats={mine} filter={filter} setFilter={setFilter} cursor={cursor} hasNames={prefs.playerNames.length > 0} />}
            {pane === 'masters' && (
              <div className="section" data-testid="masters-unavailable">
                <h3 className="section-title">Master games are not included</h3>
                <p className="small dim">Chess of Life works offline and only ships data it is free to redistribute. There is no openly licensed master-game database bundled with it, so no master statistics are shown rather than numbers that cannot be backed up.</p>
                <p className="small dim" style={{ marginBottom: 0 }}>The Theory tab uses the Lichess opening list (public domain, CC0). Your own results are in My games.</p>
              </div>
            )}
            {pane === 'engine' && (
              <div className="section" data-testid="engine-pane">
                {!engine && <><p className="small dim" style={{ marginTop: 0 }}>The engine is not consulted until you ask. It shows strong moves, which are not always the theory a person would play.</p><button type="button" className="btn btn-sm" onClick={analyse} data-testid="analyse-position" disabled={new Chess(fen).isGameOver()}><IconCpu size={16} /> Analyse this position</button></>}
                {engine?.busy && <p className="small dim">Analysing to depth {prefs.deepDepth}…</p>}
                {engine?.error && <p className="small">The engine could not analyse this position: {engine.error}</p>}
                {engine?.r && (
                  <ol className="engine-lines" data-testid="engine-lines-explorer">
                    {engine.r.lines.map((l) => (
                      <li key={l.multipv}><b className="num">{formatScore(l.score)}</b> <span className="small">{formatLine(fen, pvToSan(fen, l.pv, 8))}</span></li>
                    ))}
                    <li className="xs faint">Depth {engine.r.depth}. Evaluations are from White’s point of view.</li>
                  </ol>
                )}
              </div>
            )}
            <div className="section">
              <MoveList moves={sans.map((san) => ({ san }))} current={cursor} onSelect={setCursor} futureFrom={cursor} empty="Play a move on the board or pick a catalogued continuation." style={{ maxHeight: 180 }} testId="explorer-moves" />
            </div>
          </div>
          <div className="panel-foot">
            <div className="row-nowrap">
              <button type="button" className="btn" onClick={() => setSaveOpen(true)} disabled={cursor === 0} data-testid="add-to-repertoire"><IconStar size={16} /> Add to repertoire</button>
              <span className="spacer" />
              <button type="button" className="btn btn-quiet" onClick={() => { setPath([]); setCursor(0); }} disabled={path.length === 0}>Start position</button>
            </div>
          </div>
        </section>
      </div>
      <SaveLineDialog open={saveOpen} onClose={() => setSaveOpen(false)} defaultName={defaultName} defaultColor={defaultSide(ply.opening?.family, cursor % 2 === 1 ? 'w' : 'b')} sans={sans.slice(0, cursor)}
        onSave={async (name, color) => { await addLine(name, color, path.slice(0, cursor)); setSaveOpen(false); toast(`Saved “${name}” to your ${color === 'w' ? 'White' : 'Black'} repertoire.`); }} />
    </div>
  );
}

function MyGames({ stats, filter, setFilter, cursor, hasNames }: { stats: ReturnType<typeof gamesAtPosition> | null; filter: GameFilter; setFilter: (f: GameFilter) => void; cursor: number; hasNames: boolean }) {
  if (!stats) return <div className="section small dim">Loading your games…</div>;
  const pct = (m: { w: number; d: number; l: number }) => { const n = m.w + m.d + m.l; return n ? `${(((m.w + m.d / 2) / n) * 100).toFixed(0)}%` : '–'; };
  return (
    <div className="section stack" data-testid="my-games">
      <div className="row" style={{ gap: 'var(--s-2)' }}>
        <div className="seg" role="group" aria-label="Your side">
          {(['both', 'w', 'b'] as const).map((c) => <button key={c} type="button" aria-pressed={filter.color === c} onClick={() => setFilter({ ...filter, color: c })}>{c === 'both' ? 'Both' : c === 'w' ? 'As White' : 'As Black'}</button>)}
        </div>
        <select className="input input-sm" value={filter.source} onChange={(e) => setFilter({ ...filter, source: e.target.value as GameFilter['source'] })} aria-label="Which games">
          <option value="competitive">Ranked, imported and reconstructed</option>
          <option value="ranked">Ranked only</option>
          <option value="pgn">Imported only</option>
          <option value="manual">Reconstructed only</option>
          <option value="coach">Coach games (assisted)</option>
        </select>
      </div>
      {stats.games.length === 0 ? (
        <p className="small dim" style={{ margin: 0 }}>None of your {filter.source === 'coach' ? 'Coach ' : ''}games{filter.color !== 'both' ? ` as ${filter.color === 'w' ? 'White' : 'Black'}` : ''} reached this position.</p>
      ) : (
        <>
          <table className="op-table">
            <thead><tr><th>Next move</th><th className="num">Games</th><th className="num" title="wins / draws / losses for you">W / D / L</th><th className="num">Score</th></tr></thead>
            <tbody>
              {stats.moves.map((m) => (
                <tr key={m.uci}><td><b>{moveNo(cursor)}{m.san}</b></td><td className="num">{m.games}</td><td className="num">{m.w} / {m.d} / {m.l}{m.unfinished ? <span className="faint"> (+{m.unfinished} unfinished)</span> : null}</td><td className="num">{pct(m)}</td></tr>
              ))}
              {stats.games.some((g) => !g.next) && <tr><td className="faint">game ended here</td><td className="num">{stats.games.filter((g) => !g.next).length}</td><td /><td /></tr>}
            </tbody>
          </table>
          <h3 className="section-title" style={{ margin: 'var(--s-2) 0 0' }}>Games that reached this position</h3>
          <ul className="op-games">
            {stats.games.slice(0, 30).map((g) => (
              <li key={g.game.id}>
                <a href={`#/review/${g.game.id}/${g.ply}`} data-testid="my-game">
                  <span className="ellipsis">{gameTitle(g.game)}</span>
                  <span className="faint xs">{prettyDate(g.game.headers.Date) || new Date(g.game.createdAt).toLocaleDateString()} · you {g.side === 'w' ? 'White' : 'Black'} · {g.score === null ? 'unfinished' : g.score === 1 ? 'won' : g.score === 0 ? 'lost' : 'drawn'}</span>
                </a>
              </li>
            ))}
          </ul>
          {stats.games.length > 30 && <p className="xs faint" style={{ margin: 0 }}>Showing the 30 most recent of {stats.games.length}.</p>}
        </>
      )}
      {stats.unknownSide > 0 && <p className="xs faint" style={{ margin: 0 }} data-testid="unknown-side">{stats.unknownSide} more game{stats.unknownSide === 1 ? '' : 's'} reach this position but {stats.unknownSide === 1 ? 'is' : 'are'} not counted because your side is not known. {hasNames ? 'Set it in the game’s review.' : 'Add the names you play under in Settings, or set your side in the game’s review.'}</p>}
    </div>
  );
}

function SaveLineDialog({ open, onClose, defaultName, defaultColor, sans, onSave }: { open: boolean; onClose: () => void; defaultName: string; defaultColor: 'w' | 'b'; sans: string[]; onSave: (name: string, color: 'w' | 'b') => void }) {
  const [name, setName] = useState(defaultName);
  const [color, setColor] = useState<'w' | 'b'>(defaultColor);
  useEffect(() => { if (open) { setName(defaultName); setColor(defaultColor); } }, [open, defaultName, defaultColor]);
  return (
    <Dialog open={open} onClose={onClose} title="Add this line to your repertoire" description={formatLine(new Chess().fen(), sans)} testId="save-line"
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={() => onSave(name, color)} data-testid="save-line-confirm">Save line</button></>}>
      <div className="stack">
        <label className="field"><span className="field-label">Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} data-autofocus /></label>
        <div className="field">
          <span className="field-label">You play</span>
          <div className="seg" role="group" aria-label="Your side in this line">
            <button type="button" aria-pressed={color === 'w'} onClick={() => setColor('w')}>White</button>
            <button type="button" aria-pressed={color === 'b'} onClick={() => setColor('b')}>Black</button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
