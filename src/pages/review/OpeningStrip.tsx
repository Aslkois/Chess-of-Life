import type { OpeningPly } from '../../analysis/openings';
import { pathParam } from '../openings/paths';

/**
 * Opening identity and book status of the selected position in Game Review.
 * Leaving the catalogued theory is reported as a fact, separately from the
 * move's rating: an unusual move is not an inaccuracy because it is unusual.
 */
export function OpeningStrip({ ply, ucis, leftWith, mine, isMove }: { ply: OpeningPly; ucis: string[]; leftWith: string | null; mine: number | null; isMove: boolean }) {
  const o = ply.opening;
  if (ply.index === 0 || (!o && !ply.inBook)) return null;
  const note = !isMove ? null
    : ply.event === 'book' ? 'A catalogued continuation.'
    : ply.event === 'reentered' ? 'Back in catalogued theory by transposition.'
    : ply.event === 'left' ? 'This move leaves the catalogued theory. That is not a mistake in itself; the rating judges the move on its merits.'
    : leftWith ? `Outside the catalogued theory since ${leftWith}.` : null;
  return (
    <div className="opening-strip" data-testid="review-opening">
      <div className="opening-line">
        {o && <span className="op-eco">{o.eco}</span>}
        <span className="ellipsis" style={{ color: 'var(--ivory)', fontWeight: 600 }} title={o?.name}>{o ? o.name : 'Catalogued position'}</span>
        <span className={`op-badge ${ply.inBook ? 'is-book' : 'is-out'}`} data-testid="review-book-status">{ply.inBook ? 'Book' : 'Out of book'}</span>
      </div>
      {note && <div className="xs dim" style={{ marginTop: 2 }}>{note}</div>}
      <div className="opening-line" style={{ marginTop: 2 }}>
        <a href={`#/openings/explore/${pathParam(ucis)}`} data-testid="open-explorer">Open in the Explorer</a>
        {mine !== null && mine > 0 && <span className="faint">You reached this position in {mine} of your games{mine > 1 ? '' : ' (this one)'}.</span>}
      </div>
    </div>
  );
}
