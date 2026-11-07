import { useEffect, useMemo, useState } from 'react';
import { listGames, all } from '../../db/db';
import type { GameRecord, StoredReview } from '../../db/types';
import { useApp } from '../../ui/context';
import { byMonth, gameLine, openingStats, type GameFilter, type OpeningNode } from '../../services/openings';
import { gameTitle } from '../../services/games';
import { pathParam } from '../openings/paths';

const PERIODS = [{ id: 'all', label: 'All time', days: 0 }, { id: '30', label: 'Last 30 days', days: 30 }, { id: '90', label: 'Last 90 days', days: 90 }, { id: '365', label: 'Last year', days: 365 }];

/** Personal opening statistics, computed from the user's own saved games only. */
export function OpeningStats() {
  const { prefs } = useApp();
  const [games, setGames] = useState<GameRecord[] | null>(null);
  const [reviews, setReviews] = useState<Map<string, StoredReview>>(new Map());
  const [filter, setFilter] = useState<GameFilter>({ source: 'competitive', color: 'both', timeControl: 'any' });
  const [period, setPeriod] = useState('all');
  const [sel, setSel] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    (async () => {
      const [gs, rs] = await Promise.all([listGames(), all('reviews')]);
      setGames(gs);
      setReviews(new Map(rs.map((r) => [r.gameId, r])));
    })();
  }, []);
  const days = PERIODS.find((p) => p.id === period)!.days;
  const f: GameFilter = { ...filter, from: days ? Date.now() - days * 86400_000 : undefined };
  const res = useMemo(() => (games ? openingStats(games, reviews, prefs.playerNames, f, gameTitle) : null), [games, reviews, prefs.playerNames, filter, period]); // eslint-disable-line react-hooks/exhaustive-deps
  const tcs = useMemo(() => [...new Set((games ?? []).map((g) => g.headers.TimeControl).filter((t): t is string => !!t && t !== '-' && t !== '?'))].sort(), [games]);
  const byId = useMemo(() => new Map((games ?? []).map((g) => [g.id, g])), [games]);
  if (!games || !res) return <div className="empty">Loading…</div>;

  const flat: OpeningNode[] = [];
  const walk = (ns: OpeningNode[]) => { for (const n of ns) { flat.push(n); walk(n.children); } };
  walk(res.tree);
  const selected = flat.find((n) => n.key === sel) ?? res.tree[0] ?? null;

  return (
    <div className="stack" style={{ gap: 'var(--s-5)' }} data-testid="opening-stats">
      <div className="row" style={{ gap: 'var(--s-2)' }}>
        <select className="input input-sm" value={filter.source} onChange={(e) => setFilter({ ...filter, source: e.target.value as GameFilter['source'] })} aria-label="Which games" data-testid="stats-source">
          <option value="competitive">Ranked, imported and reconstructed</option>
          <option value="ranked">Ranked only</option>
          <option value="pgn">Imported only</option>
          <option value="manual">Reconstructed only</option>
          <option value="coach">Coach games (assisted, kept apart)</option>
        </select>
        <div className="seg" role="group" aria-label="Your side">
          {(['both', 'w', 'b'] as const).map((c) => <button key={c} type="button" aria-pressed={filter.color === c} onClick={() => setFilter({ ...filter, color: c })}>{c === 'both' ? 'Both colours' : c === 'w' ? 'White' : 'Black'}</button>)}
        </div>
        <select className="input input-sm" value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Period">{PERIODS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
        <select className="input input-sm" value={filter.timeControl ?? 'any'} onChange={(e) => setFilter({ ...filter, timeControl: e.target.value })} aria-label="Time control">
          <option value="any">Any time control</option>
          <option value="untimed">Untimed or unknown</option>
          {tcs.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <p className="small dim" style={{ margin: 0 }} data-testid="stats-counted">
        {res.counted.length} game{res.counted.length === 1 ? '' : 's'} counted, each once, under the deepest opening name it reached.
        {res.unknownSide > 0 && <> {res.unknownSide} game{res.unknownSide === 1 ? ' is' : 's are'} not counted because your side is not known (add your PGN names in <a href="#/settings">Settings</a> or set the side in the game’s review).</>}
        {res.noOpening > 0 && <> {res.noOpening} did not reach a named opening.</>}
        {filter.source === 'coach' && ' Coach games include takebacks and hints, so they are never mixed into the competitive record.'}
      </p>
      {res.tree.length === 0 ? (
        <div className="surface surface-pad"><p className="small dim" style={{ margin: 0 }}>No games match these filters yet.</p></div>
      ) : (
        <div className="grid-2" style={{ alignItems: 'start' }}>
          <section className="surface surface-pad" aria-label="Openings you play">
            <div className="row-nowrap xs faint" style={{ padding: '0 var(--s-2) var(--s-2)' }}><span style={{ flex: 1 }}>Opening</span><span>Games</span><span style={{ width: 72 }} className="c-hide-narrow">W / D / L</span><span style={{ width: 40, textAlign: 'right' }}>Score</span></div>
            <TreeList nodes={res.tree} open={open} setOpen={setOpen} sel={selected?.key ?? null} onSelect={setSel} />
          </section>
          {selected && <Detail node={selected} byId={byId} />}
        </div>
      )}
    </div>
  );
}

function Wdl({ n }: { n: OpeningNode }) {
  const t = n.w + n.d + n.l;
  if (!t) return <span className="wdl" />;
  return <span className="wdl" title={`${n.w} won, ${n.d} drawn, ${n.l} lost`}><i className="w" style={{ width: `${(n.w / t) * 100}%` }} /><i className="d" style={{ width: `${(n.d / t) * 100}%` }} /><i className="l" style={{ width: `${(n.l / t) * 100}%` }} /></span>;
}

function TreeList({ nodes, open, setOpen, sel, onSelect }: { nodes: OpeningNode[]; open: Set<string>; setOpen: (s: Set<string>) => void; sel: string | null; onSelect: (k: string) => void }) {
  return (
    <ul className="op-tree">
      {nodes.map((n) => {
        const isOpen = open.has(n.key);
        return (
          <li key={n.key}>
            <button type="button" className="op-node" aria-pressed={sel === n.key} aria-expanded={n.children.length ? isOpen : undefined} data-testid="op-node"
              onClick={() => { onSelect(n.key); if (n.children.length) { const s = new Set(open); if (isOpen) s.delete(n.key); else s.add(n.key); setOpen(s); } }}>
              <span className="ellipsis">{n.children.length ? (isOpen ? '▾ ' : '▸ ') : ''}<span style={{ color: 'var(--ivory)', fontWeight: n.level === 'family' ? 650 : 500 }}>{n.label}</span> <span className="xs faint">{n.ecos.join(', ')}</span></span>
              <span className="num">{n.games.length}</span>
              <Wdl n={n} />
              <span className="num" style={{ width: 40, textAlign: 'right' }}>{n.scorePct === null ? '–' : `${n.scorePct.toFixed(0)}%`}</span>
            </button>
            {isOpen && n.children.length > 0 && <TreeList nodes={n.children} open={open} setOpen={setOpen} sel={sel} onSelect={onSelect} />}
          </li>
        );
      })}
    </ul>
  );
}

function Detail({ node, byId }: { node: OpeningNode; byId: Map<string, GameRecord> }) {
  const months = byMonth(node.games);
  const first = node.games[0];
  const g0 = first ? byId.get(first.gameId) : undefined;
  const explorerPath = g0 ? pathParam(gameLine(g0).line.ucis.slice(0, first.namedAt)) : '';
  const finished = node.w + node.d + node.l;
  return (
    <section className="surface surface-pad stack" aria-label={`${node.key} details`} data-testid="op-detail">
      <div>
        <h2 style={{ margin: 0 }}>{node.label}</h2>
        {node.level !== 'family' && <div className="small dim">{node.key}</div>}
        <div className="xs faint">{node.ecos.join(', ')}</div>
      </div>
      <div className="stats" style={{ margin: 0 }}>
        <div className="stat"><b>{node.games.length}</b><span>games</span></div>
        <div className="stat"><b>{node.scorePct === null ? '–' : `${node.scorePct.toFixed(0)}%`}</b><span>score ({node.w}–{node.d}–{node.l}{node.unfinished ? `, ${node.unfinished} unfinished` : ''})</span></div>
        <div className="stat"><b>{node.openingAccuracy === null ? '–' : node.openingAccuracy.toFixed(0)}</b><span>opening accuracy{node.reviewedGames < node.games.length ? ` (${node.reviewedGames} reviewed)` : ''}</span></div>
        <div className="stat"><b>{node.reviewedGames ? (node.earlyErrors / node.reviewedGames).toFixed(1) : '–'}</b><span>early errors per game</span></div>
      </div>
      <p className="xs faint" style={{ margin: 0 }}>Opening accuracy and early errors cover your own moves in the first 12 moves, from reviewed games only{finished < 5 ? '. With so few games these numbers say little yet' : ''}.</p>
      {node.exits.length > 0 && (
        <div>
          <h3 className="section-title">Where the games left the catalogued theory</h3>
          <ul className="op-games">
            {node.exits.slice(0, 6).map((e) => <li key={e.san}><span><b>{e.san}</b> <span className="faint xs">{e.byUser ? 'your move' : 'your opponent’s move'}</span></span><span className="num small">{e.games}</span></li>)}
          </ul>
          <p className="xs faint" style={{ margin: 'var(--s-1) 0 0' }}>Leaving the catalogued lines is not a mistake in itself; the review rates each move on its merits.</p>
        </div>
      )}
      {months.length > 1 && (
        <div>
          <h3 className="section-title">Over time</h3>
          <div className="month-bars" aria-label="Score by month">
            {months.map((m) => <span key={m.month} title={`${m.month}: ${m.games} game${m.games === 1 ? '' : 's'}, ${m.scorePct === null ? 'no finished games' : `${m.scorePct.toFixed(0)}% score`}`} style={{ height: `${Math.max(6, m.scorePct ?? 0)}%`, opacity: m.scorePct === null ? 0.3 : 1 }} />)}
          </div>
          <div className="row-nowrap xs faint"><span>{months[0].month}</span><span className="spacer" /><span>{months[months.length - 1].month}</span></div>
        </div>
      )}
      <div>
        <h3 className="section-title">Games</h3>
        <ul className="op-games">
          {node.games.slice(0, 12).map((s) => (
            <li key={s.gameId}>
              <a href={`#/review/${s.gameId}${s.exit ? `/${s.exit.ply + 1}` : ''}`} data-testid="stats-game"><span className="ellipsis">{s.title}</span><span className="xs faint">{new Date(s.date).toLocaleDateString()} · {s.side === 'w' ? 'White' : 'Black'} · {s.score === null ? 'unfinished' : s.score === 1 ? 'won' : s.score === 0 ? 'lost' : 'drawn'}{s.opening.name !== node.key ? ` · ${s.opening.name}` : ''}</span></a>
            </li>
          ))}
        </ul>
        {node.games.length > 12 && <p className="xs faint" style={{ margin: 0 }}>And {node.games.length - 12} more.</p>}
      </div>
      {g0 && <div><a className="btn btn-sm" href={`#/openings/explore/${explorerPath}`}>Open in the Explorer</a></div>}
    </section>
  );
}
