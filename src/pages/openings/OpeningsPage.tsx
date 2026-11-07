import { navigate } from '../../ui/router';
import { ExplorerTab } from './ExplorerTab';
import { RepertoireTab } from './RepertoireTab';
import { PracticeTab } from './PracticeTab';

export type OpeningsTab = 'explore' | 'repertoire' | 'practice';

/**
 * Openings: the Explorer (catalogued theory, your own games, engine on
 * request), your repertoire, and practice against a training opponent.
 * Route: #/openings/<tab>/<uci,uci,...>
 */
export function OpeningsPage({ params }: { params: string[] }) {
  const tab: OpeningsTab = (['explore', 'repertoire', 'practice'] as const).find((t) => t === params[0]) ?? 'explore';
  const arg = params[1] ?? '';
  return (
    <div className="page">
      <header className="page-head" style={{ marginBottom: 'var(--s-4)' }}>
        <div>
          <h1>Openings</h1>
          <div className="lede small">Catalogued theory from the free Lichess opening list, your own results, and practice for the lines you choose.</div>
        </div>
        <div className="page-head-actions">
          <div className="seg" role="tablist" aria-label="Openings section">
            <button type="button" role="tab" aria-selected={tab === 'explore'} onClick={() => tab !== 'explore' && navigate('openings/explore')} data-testid="op-tab-explore">Explorer</button>
            <button type="button" role="tab" aria-selected={tab === 'repertoire'} onClick={() => tab !== 'repertoire' && navigate('openings/repertoire')} data-testid="op-tab-repertoire">Repertoire</button>
            <button type="button" role="tab" aria-selected={tab === 'practice'} onClick={() => tab !== 'practice' && navigate('openings/practice')} data-testid="op-tab-practice">Practice</button>
          </div>
        </div>
      </header>
      {tab === 'explore' && <ExplorerTab key={`explore:${arg}`} pathArg={arg} />}
      {tab === 'repertoire' && <RepertoireTab />}
      {tab === 'practice' && <PracticeTab key={arg} lineArg={arg} />}
    </div>
  );
}
