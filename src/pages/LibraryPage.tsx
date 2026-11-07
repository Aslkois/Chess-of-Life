import { useEffect, useMemo, useState } from 'react';
import { all, deleteGame, listGames } from '../db/db';
import type { GameRecord, StoredReview } from '../db/types';
import { gamePgn, gameTitle } from '../services/games';
import { countBranches } from '../chess/tree';
import { downloadText } from '../ui/bits';
import { ConfirmDialog } from '../ui/Dialog';
import { IconDownload, IconReview, IconSearch, IconTrash } from '../ui/icons';
import { useApp } from '../ui/context';

const SOURCES = [['all', 'All'], ['manual', 'Reconstructed'], ['pgn', 'PGN'], ['coach', 'Coach'], ['ranked', 'Ranked']] as const;
const SOURCE_LABEL: Record<string, string> = { manual: 'Reconstructed', pgn: 'PGN', coach: 'Coach', ranked: 'Ranked' };
type SortKey = 'newest' | 'oldest' | 'moves' | 'branches';

export function LibraryPage() {
  const { openChooser, toast } = useApp();
  const [games, setGames] = useState<GameRecord[] | null>(null);
  const [reviews, setReviews] = useState<Map<string, StoredReview>>(new Map());
  const [confirm, setConfirm] = useState<GameRecord | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('newest');
  const load = () => {
    listGames().then(setGames).catch(() => setGames([]));
    all('reviews').then((r) => setReviews(new Map(r.map((x) => [x.gameId, x])))).catch(() => {});
  };
  useEffect(load, []);

  const shown = useMemo(() => {
    if (!games) return [];
    const needle = q.trim().toLowerCase();
    const list = games.filter((g) => (filter === 'all' || g.source === filter) && (!needle || [gameTitle(g), g.headers.Event, g.headers.Date, reviews.get(g.id)?.opening?.name].some((x) => x?.toLowerCase().includes(needle))));
    const by: Record<SortKey, (a: GameRecord, b: GameRecord) => number> = {
      newest: (a, b) => b.createdAt - a.createdAt,
      oldest: (a, b) => a.createdAt - b.createdAt,
      moves: (a, b) => b.moves.length - a.moves.length,
      branches: (a, b) => countBranches(b.tree) - countBranches(a.tree),
    };
    return [...list].sort(by[sort]);
  }, [games, filter, q, sort, reviews]);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Library</h1>
          <div className="lede">{games ? `${games.length} saved game${games.length === 1 ? '' : 's'}: reconstructed, imported, Coach and Ranked.` : 'Loading…'}</div>
        </div>
        <div className="page-head-actions"><button type="button" className="btn btn-primary" onClick={openChooser}><IconReview size={18} /> Review a game</button></div>
      </header>
      {games && games.length === 0 ? (
        <div className="surface empty">
          <h2>No games yet</h2>
          <p style={{ margin: '0 auto' }}>Reconstruct a game you played or import a PGN, and it will be saved here with its review and every branch you explore.</p>
          <div className="row"><button type="button" className="btn btn-primary" onClick={openChooser}>Review a game</button><a className="btn" href="#/coach">Play the Coach</a></div>
        </div>
      ) : (
        <>
          <div className="toolbar">
            <label className="row-nowrap" style={{ position: 'relative', flex: '1 1 220px', maxWidth: 320 }}>
              <span style={{ position: 'absolute', left: 10, color: 'var(--text-3)', display: 'grid' }}><IconSearch size={16} /></span>
              <input className="input" style={{ paddingLeft: 34 }} placeholder="Search players, event or opening" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search games" />
            </label>
            <div className="seg" role="group" aria-label="Filter by source">
              {SOURCES.map(([id, label]) => <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}
            </div>
            <label className="row-nowrap small dim" style={{ marginLeft: 'auto' }}>Sort
              <select className="select" style={{ width: 'auto' }} value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="moves">Longest games</option>
                <option value="branches">Most branches</option>
              </select>
            </label>
          </div>
          <div className="surface">
            <div className="lib-list" role="table" aria-label="Saved games">
              <div className="lib-row lib-head" role="row">
                <span role="columnheader">Game</span><span role="columnheader">Source</span><span role="columnheader">Result</span><span role="columnheader">Moves</span><span role="columnheader">Accuracy, White / Black</span><span role="columnheader">Branches</span><span />
              </div>
              {shown.length === 0 && <div className="ml-empty">No games match. <button type="button" className="btn btn-sm btn-quiet" onClick={() => { setQ(''); setFilter('all'); }}>Clear search and filter</button></div>}
              {shown.map((g) => {
                const r = reviews.get(g.id);
                const acc = r ? `${r.accuracy.w?.toFixed(1) ?? '–'} / ${r.accuracy.b?.toFixed(1) ?? '–'}` : null;
                const branches = countBranches(g.tree);
                return (
                  <div className="lib-row" key={g.id} role="row" data-testid="game-row">
                    <span className="c-title" role="cell" style={{ minWidth: 0 }}>
                      <a className="lib-title ellipsis" href={`#/review/${g.id}`}>{gameTitle(g)}</a>
                      <span className="small faint ellipsis" style={{ display: 'block' }}>{[g.headers.Event && g.headers.Event !== '?' ? g.headers.Event : null, r?.opening?.name, new Date(g.createdAt).toLocaleDateString()].filter(Boolean).join(', ')}</span>
                    </span>
                    <span className="c-meta" role="cell">
                      <span className="tag">{SOURCE_LABEL[g.source]}</span>
                      <span className="num">{g.result === '1/2-1/2' ? '½–½' : g.result}</span>
                      <span className="num">{Math.ceil(g.moves.length / 2)}<span className="show-narrow"> moves</span></span>
                      <span className="num">{acc ? <>{acc}{r!.status !== 'complete' && <span className="faint" title="Analysis not finished"> (in progress)</span>}</> : <span className="faint">Not reviewed</span>}</span>
                      <span className="num">{branches || <span className="faint">0</span>}<span className="show-narrow"> branch{branches === 1 ? '' : 'es'}</span></span>
                    </span>
                    <span className="c-actions lib-actions" role="cell">
                      <a className="btn btn-sm" href={`#/review/${g.id}`}>Open</a>
                      <button type="button" className="btn btn-sm btn-quiet btn-icon" title="Download PGN with branches" aria-label={`Download PGN of ${gameTitle(g)}`} onClick={async () => downloadText(`${gameTitle(g).replace(/\W+/g, '_')}.pgn`, await gamePgn(g), 'application/x-chess-pgn')}><IconDownload size={16} /></button>
                      <button type="button" className="btn btn-sm btn-danger btn-icon" title="Delete game" aria-label={`Delete ${gameTitle(g)}`} onClick={() => setConfirm(g)}><IconTrash size={16} /></button>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
      <ConfirmDialog open={!!confirm} title="Delete this game?" danger testId="delete-game-dialog"
        body={confirm ? `${gameTitle(confirm)} will be removed with its review${countBranches(confirm.tree) ? ` and ${countBranches(confirm.tree)} explored branch${countBranches(confirm.tree) === 1 ? '' : 'es'}` : ''}. This cannot be undone.` : undefined}
        confirmLabel="Delete game" cancelLabel="Keep game" onCancel={() => setConfirm(null)}
        onConfirm={async () => { if (!confirm) return; await deleteGame(confirm.id); toast('Game deleted.'); setConfirm(null); load(); }} />
    </div>
  );
}
