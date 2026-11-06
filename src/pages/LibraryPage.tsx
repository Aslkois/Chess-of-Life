import { useEffect, useState } from 'react';
import { all, deleteGame, listGames } from '../db/db';
import type { GameRecord, StoredReview } from '../db/types';
import { gamePgn, gameTitle } from '../services/games';
import { countBranches } from '../chess/tree';
import { downloadText, Modal } from '../ui/bits';

export function LibraryPage() {
  const [games, setGames] = useState<GameRecord[] | null>(null);
  const [reviews, setReviews] = useState<Map<string, StoredReview>>(new Map());
  const [confirm, setConfirm] = useState<GameRecord | null>(null);
  const [filter, setFilter] = useState('all');
  const load = () => {
    listGames().then(setGames).catch(() => setGames([]));
    all('reviews').then((r) => setReviews(new Map(r.map((x) => [x.gameId, x])))).catch(() => {});
  };
  useEffect(load, []);
  if (!games) return <div className="empty">Loading…</div>;
  const shown = games.filter((g) => filter === 'all' || g.source === filter);
  return (
    <div>
      <div className="row between"><h1>Library</h1>
        <div className="segmented">{['all', 'manual', 'pgn', 'coach', 'ranked'].map((f) => <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{f === 'manual' ? 'reconstructed' : f}</button>)}</div>
      </div>
      {shown.length === 0 ? (
        <div className="card empty">No games yet. <a href="#/reconstruct">Reconstruct a game</a> or <a href="#/import">import a PGN</a>.</div>
      ) : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="list">
            <thead><tr><th>Game</th><th>Source</th><th>Result</th><th>Moves</th><th>Accuracy W / B</th><th>Branches</th><th /></tr></thead>
            <tbody>
              {shown.map((g) => {
                const r = reviews.get(g.id);
                return (
                  <tr key={g.id} data-testid="game-row">
                    <td><a href={`#/review/${g.id}`}>{gameTitle(g)}</a><div className="faint small">{g.headers.Event && g.headers.Event !== '?' ? g.headers.Event : ''} {new Date(g.createdAt).toLocaleDateString()}</div></td>
                    <td><span className="pill">{g.source === 'manual' ? 'reconstructed' : g.source}</span></td>
                    <td className="mono">{g.result}</td>
                    <td className="mono">{Math.ceil(g.moves.length / 2)}</td>
                    <td className="mono">{r ? `${r.accuracy.w?.toFixed(1) ?? '—'} / ${r.accuracy.b?.toFixed(1) ?? '—'}${r.status !== 'complete' ? ' *' : ''}` : <span className="faint">not reviewed</span>}</td>
                    <td className="mono">{countBranches(g.tree)}</td>
                    <td><div className="row" style={{ justifyContent: 'flex-end' }}>
                      <a className="btn sm" href={`#/review/${g.id}`}>Open</a>
                      <button className="btn sm" onClick={async () => downloadText(`${gameTitle(g).replace(/\W+/g, '_')}.pgn`, await gamePgn(g), 'application/x-chess-pgn')}>PGN</button>
                      <button className="btn sm danger" onClick={() => setConfirm(g)} aria-label="Delete game">Delete</button>
                    </div></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="faint small" style={{ marginTop: 6 }}>* review still provisional (deep analysis not finished)</div>
        </div>
      )}
      {confirm && (
        <Modal onClose={() => setConfirm(null)}>
          <h2>Delete this game?</h2>
          <p className="muted">{gameTitle(confirm)} — its review and all {countBranches(confirm.tree)} explored branches will be removed.</p>
          <div className="row"><span className="spacer" /><button className="btn" onClick={() => setConfirm(null)}>Cancel</button><button className="btn danger" onClick={async () => { await deleteGame(confirm.id); setConfirm(null); load(); }}>Delete</button></div>
        </Modal>
      )}
    </div>
  );
}
