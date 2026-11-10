import { navigate } from '../../ui/router';
import { ExplorerTab } from './ExplorerTab';
import { RepertoireTab } from './RepertoireTab';
import { PracticeTab } from './PracticeTab';

export type OpeningsTab = 'explore' | 'repertoire' | 'practice';

/**
 * Explorer: any position with statistics from the Lichess masters and online
 * databases, your own games or a player's games, the opening book and the
 * engine on request; plus your repertoire and practice.
 * Route: #/openings/explore/<uci,uci,...>/<start FEN, URL-encoded>
 */
export function OpeningsPage({ params }: { params: string[] }) {
  const tab: OpeningsTab = (['explore', 'repertoire', 'practice'] as const).find((t) => t === params[0]) ?? 'explore';
  const arg = params[1] ?? '';
  return (
    <div className="page">
      <header className="page-head" style={{ marginBottom: 'var(--s-4)' }}>
        <div>
          <h1>Explorer</h1>
          <div className="lede small">Any position: what masters, online players, you or a chosen player played from it, how it turned out, and what the engine thinks. Plus your repertoire and practice.</div>
        </div>
        <div className="page-head-actions">
          <div className="seg" role="tablist" aria-label="Openings section">
            <button type="button" role="tab" aria-selected={tab === 'explore'} onClick={() => tab !== 'explore' && navigate('openings/explore')} data-testid="op-tab-explore">Explorer</button>
            <button type="button" role="tab" aria-selected={tab === 'repertoire'} onClick={() => tab !== 'repertoire' && navigate('openings/repertoire')} data-testid="op-tab-repertoire">Repertoire</button>
            <button type="button" role="tab" aria-selected={tab === 'practice'} onClick={() => tab !== 'practice' && navigate('openings/practice')} data-testid="op-tab-practice">Practice</button>
          </div>
        </div>
      </header>
      {tab === 'explore' && <ExplorerTab key={`explore:${arg}:${params[2] ?? ''}`} pathArg={arg === '-' ? '' : arg} fenArg={params[2]} />}
      {tab === 'repertoire' && <RepertoireTab />}
      {tab === 'practice' && <PracticeTab key={arg} lineArg={arg} />}
    </div>
  );
}
