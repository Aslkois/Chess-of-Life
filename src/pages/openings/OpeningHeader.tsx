import type { OpeningPly } from '../../analysis/openings';

/** Name, ECO and book status of a position, with the last known identity when outside theory. */
export function OpeningHeader({ ply, leftWith, compact }: { ply: OpeningPly; leftWith?: string | null; compact?: boolean }) {
  const o = ply.opening;
  const here = ply.namedHere;
  return (
    <div className={`op-head${compact ? ' is-compact' : ''}`} data-testid="opening-name">
      <div className="op-title">
        {o ? <><b>{o.family}</b>{o.variation && <span className="op-var">{o.variation}{o.subvariation ? `, ${o.subvariation}` : ''}</span>}</> : <b className="dim">{ply.index === 0 ? 'Starting position' : 'Unnamed position'}</b>}
      </div>
      <div className="op-meta">
        {o && <span className="op-eco" title="Encyclopaedia of Chess Openings code">{o.eco}</span>}
        {ply.inBook
          ? <span className="op-badge is-book" data-testid="book-status">{here ? 'Catalogued position' : 'In catalogued theory'}</span>
          : <span className="op-badge is-out" data-testid="book-status">Outside the catalogued theory{leftWith ? ` since ${leftWith}` : ''}</span>}
        {o && !here && <span className="xs faint">{ply.inBook ? 'Named after the last catalogued name on this path.' : 'Last known opening on this path.'}</span>}
      </div>
    </div>
  );
}
