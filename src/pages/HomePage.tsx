import { useEffect, useState } from 'react';
import { listGames } from '../db/db';
import { loadRankedProfile, listMatches } from '../services/ranked';
import { loadCoachProfile } from '../services/coach';
import { IconBoard, IconCoach, IconImport, IconSword, IconTree } from '../ui/icons';
import type { GameRecord, RankedProfile } from '../db/types';
import type { LearningProfile } from '../coach/profile';
import { countBranches } from '../chess/tree';
import { gameTitle } from '../services/games';

export function HomePage() {
  const [games, setGames] = useState<GameRecord[] | null>(null);
  const [ranked, setRanked] = useState<RankedProfile | null>(null);
  const [coach, setCoach] = useState<LearningProfile | null>(null);
  const [matches, setMatches] = useState(0);
  useEffect(() => {
    listGames().then(setGames).catch(() => setGames([]));
    loadRankedProfile().then(setRanked).catch(() => {});
    loadCoachProfile().then(setCoach).catch(() => {});
    listMatches().then((m) => setMatches(m.filter((x) => x.status === 'finished').length)).catch(() => {});
  }, []);
  const branches = games?.reduce((n, g) => n + countBranches(g.tree), 0) ?? 0;
  return (
    <div>
      <div className="hero">
        <h1>Chess of Life</h1>
        <p className="muted" style={{ maxWidth: 680 }}>Every decision opens another possible future. Review what happened, explore what could have happened, learn with a Coach that teaches instead of telling, and prove it against a Rival that studies how you play. Everything runs locally with Stockfish — no accounts, no limits.</p>
      </div>
      <div className="modes">
        <a className="card mode-card" href="#/reconstruct"><div className="ic"><IconBoard /></div><b>Reconstruct a game</b><span className="muted small">Enter both sides’ moves of a game you played, then review it.</span></a>
        <a className="card mode-card" href="#/import"><div className="ic"><IconImport /></div><b>Import PGN</b><span className="muted small">Paste or upload one or many games.</span></a>
        <a className="card mode-card" href="#/library"><div className="ic"><IconTree /></div><b>Review & explore</b><span className="muted small">Accuracy, move classifications and a branching tree of alternatives.</span></a>
        <a className="card mode-card" href="#/coach"><div className="ic"><IconCoach /></div><b>Train with the Coach</b><span className="muted small">Live feedback, conceptual hints, takebacks and prediction exercises.</span></a>
        <a className="card mode-card" href="#/ranked"><div className="ic"><IconSword /></div><b>Face the Rival</b><span className="muted small">Ranked games with no assistance against an opponent that adapts to you.</span></a>
      </div>
      <div className="card" style={{ marginTop: 14 }}>
        <h3>Your local data</h3>
        <div className="row" style={{ gap: 28 }}>
          <div className="stat"><b>{games?.length ?? '—'}</b><span>saved games</span></div>
          <div className="stat"><b>{branches}</b><span>explored branches</span></div>
          <div className="stat"><b>{coach ? coach.movesIndependent : '—'}</b><span>independent Coach decisions</span></div>
          <div className="stat"><b>{matches}</b><span>Ranked games</span></div>
          <div className="stat"><b>{ranked ? Math.round(ranked.rating.r) : '—'}</b><span>internal Ranked rating ± {ranked ? Math.round(ranked.rating.rd * 2) : '—'}</span></div>
        </div>
      </div>
      {games && games.length > 0 && (
        <div className="card">
          <h3>Recent games</h3>
          <table className="list"><tbody>
            {games.slice(0, 5).map((g) => (
              <tr key={g.id}><td><a href={`#/review/${g.id}`}>{gameTitle(g)}</a></td><td className="muted">{g.source}</td><td className="mono">{g.result}</td><td className="faint">{g.moves.length} plies</td></tr>
            ))}
          </tbody></table>
        </div>
      )}
    </div>
  );
}
