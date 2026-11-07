import { useEffect, useState } from 'react';
import { get, getMeta, listGames } from '../db/db';
import { loadRankedProfile } from '../services/ranked';
import { loadCoachProfile } from '../services/coach';
import type { CoachSession, GameRecord, RankedProfile, ReconstructionDraft } from '../db/types';
import type { LearningProfile } from '../coach/profile';
import { gameTitle } from '../services/games';
import { useApp } from '../ui/context';
import { IconCoach, IconLibrary, IconRanked, IconReconstruct, IconReview } from '../ui/icons';
import { MiniBoard, type BoardTheme } from '../ui/Board';
import { ClassIcon } from '../ui/ClassIcon';

const SOURCE_LABEL: Record<string, string> = { manual: 'Reconstructed', pgn: 'PGN', coach: 'Coach', ranked: 'Ranked' };

export function HomePage() {
  const { openChooser, activeRanked, prefs } = useApp();
  const [games, setGames] = useState<GameRecord[] | null>(null);
  const [ranked, setRanked] = useState<RankedProfile | null>(null);
  const [coach, setCoach] = useState<LearningProfile | null>(null);
  const [draft, setDraft] = useState<ReconstructionDraft | null>(null);
  const [coachSession, setCoachSession] = useState<CoachSession | null>(null);
  useEffect(() => {
    listGames().then(setGames).catch(() => setGames([]));
    loadRankedProfile().then(setRanked).catch(() => {});
    loadCoachProfile().then(setCoach).catch(() => {});
    get('drafts', 'current').then((d) => setDraft(d && d.moves.length ? d : null)).catch(() => {});
    getMeta<string>('activeCoach').then(async (id) => {
      if (!id) return;
      const s = await get('coachSessions', id);
      if (s && s.status === 'active') setCoachSession(s);
    }).catch(() => {});
  }, []);

  const latest = games?.[0];
  const continuations: { key: string; href?: string; onClick?: () => void; icon: JSX.Element; title: string; sub: string }[] = [];
  if (activeRanked) continuations.push({ key: 'ranked', href: '#/ranked', icon: <IconRanked />, title: 'Return to your Ranked game', sub: 'The clock keeps running while you are away' });
  if (coachSession) continuations.push({ key: 'coach', href: '#/coach', icon: <IconCoach />, title: 'Resume your Coach game', sub: `${coachSession.moves.length} moves played, you have ${coachSession.playerColor === 'w' ? 'White' : 'Black'}` });
  if (draft) continuations.push({ key: 'draft', href: '#/reconstruct', icon: <IconReconstruct />, title: 'Continue your reconstruction', sub: `${draft.moves.length} move${draft.moves.length === 1 ? '' : 's'} entered${draft.headers.White ? `, ${draft.headers.White} vs ${draft.headers.Black || '?'}` : ''}` });
  if (latest) continuations.push({ key: 'latest', href: `#/review/${latest.id}`, icon: <IconReview />, title: 'Open your latest game', sub: `${gameTitle(latest)}, ${SOURCE_LABEL[latest.source].toLowerCase()}` });

  return (
    <div className="page">
      <div className="home">
        <div className="stack" style={{ gap: 'var(--s-3)' }}>
          <section className="home-lead" aria-labelledby="home-title">
            <div>
              <h1 id="home-title">See where your game turned</h1>
              <p>Reconstruct a game move by move or import a PGN. Stockfish rates every move of both players on this device, and any position can grow a branch of what could have happened.</p>
              <button type="button" className="btn btn-primary btn-lg" onClick={openChooser} data-testid="home-review"><IconReview /> Review a game</button>
            </div>
            <div className="mini-wrap" style={{ position: 'relative' }} aria-hidden="true">
              <MiniBoard theme={(prefs.boardTheme as BoardTheme) ?? 'walnut'} fen="r1bq1rk1/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQ1RK1" />
              <span style={{ position: 'absolute', left: '72%', top: '61%' }}><ClassIcon cls="great" size={30} decorative /></span>
            </div>
          </section>
          <div className="home-modes">
            <a className="mode-tile" href="#/coach" data-testid="home-coach">
              <h2><IconCoach /> Coach</h2>
              <p>Play a real game while every move is rated. Mistakes come with an explanation and a choice to take back; hints point you at what to look for, never the move.</p>
              <span className="faint xs">{coach ? `Coach level ${coach.coachLevel} of 20, adjusted from your results` : ''}</span>
              <span className="btn btn-sm tile-action">{coachSession ? 'Resume Coach game' : 'Play the Coach'}</span>
            </a>
            <a className="mode-tile" href="#/ranked" data-testid="home-ranked">
              <h2><IconRanked /> Ranked Rival</h2>
              <p>Play to win with no help at all. The Rival studies your finished Ranked games and steers toward the positions you handle worst.</p>
              <span className="faint xs">{ranked ? `Internal rating ${Math.round(ranked.rating.r)}, ${ranked.wins + ranked.draws + ranked.losses} games played` : ''}</span>
              <span className="btn btn-sm tile-action">{activeRanked ? 'Return to the game' : 'Play a Ranked game'}</span>
            </a>
          </div>
        </div>

        <div className="stack" style={{ gap: 'var(--s-3)' }}>
          {continuations.length > 0 && (
            <section className="surface" aria-labelledby="continue-title">
              <h2 id="continue-title" className="section-title" style={{ padding: 'var(--s-4) var(--s-4) 0' }}>Pick up where you left off</h2>
              <div className="side-list" data-testid="continue-list">
                {continuations.map((c) => (
                  <a key={c.key} href={c.href}>{c.icon}<span className="title">{c.title}<span className="sub">{c.sub}</span></span></a>
                ))}
              </div>
            </section>
          )}
          <section className="surface" aria-labelledby="recent-title">
            <div className="row" style={{ padding: 'var(--s-4) var(--s-4) var(--s-2)' }}>
              <h2 id="recent-title" className="section-title" style={{ margin: 0 }}>Recent games</h2>
              <span className="spacer" />
              {games && games.length > 0 && <a href="#/library" className="small">All {games.length} games</a>}
            </div>
            {games === null ? <div className="ml-empty">Loading…</div> : games.length === 0 ? (
              <div className="ml-empty">No saved games yet. Reviewed, Coach and Ranked games appear here.</div>
            ) : (
              <div className="side-list">
                {games.slice(0, 5).map((g) => (
                  <a key={g.id} href={`#/review/${g.id}`}>
                    <IconLibrary size={18} />
                    <span className="title ellipsis">{gameTitle(g)}<span className="sub">{SOURCE_LABEL[g.source]}, {Math.ceil(g.moves.length / 2)} moves</span></span>
                    <span className="meta num">{g.result === '1/2-1/2' ? '½–½' : g.result}</span>
                  </a>
                ))}
              </div>
            )}
          </section>
          <a className="mode-tile" href="#/profile" style={{ flexDirection: 'row', alignItems: 'center', gap: 'var(--s-4)' }}>
            <div className="stat"><b>{coach ? coach.movesIndependent : '–'}</b><span>independent Coach decisions</span></div>
            <div className="stat"><b>{ranked ? Math.round(ranked.rating.r) : '–'}</b><span>Ranked rating</span></div>
            <span className="spacer" />
            <span className="small dim">Progress</span>
          </a>
        </div>
      </div>
    </div>
  );
}
