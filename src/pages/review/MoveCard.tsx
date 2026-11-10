import { Chess } from 'chess.js';
import { CLASS_INFO } from '../../analysis/classify';
import { formatLine, pvToSan } from '../../analysis/explain';
import type { MoveReview } from '../../analysis/review';
import type { OpeningInfo } from '../../analysis/openings';
import type { TreeNode } from '../../chess/tree';
import type { AnalysisResult } from '../../engine/controller';
import { formatScore, winLabel, winPercentPov } from '../../engine/score';
import { ClassIcon, PendingIcon } from '../../ui/ClassIcon';
import { IconBranch } from '../../ui/icons';

const ORD = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

/** The engine's better move, from the stored analysis (no commentary: that is what Explain is for). */
function betterMove(mr: MoveReview) {
  if (!mr.bestSan || mr.bestSan === mr.san || mr.epl < 2) return null;
  const item = mr.explanation.find((x) => x.startsWith('Better was'));
  const m = item?.match(/^Better was (\S+) \(([^)]+)\)/);
  return { san: mr.bestSan, score: m ? m[2] : '' };
}

function sansToUci(fen: string, sans: string[]): string[] {
  const c = new Chess(fen);
  const out: string[] = [];
  for (const s of sans) { try { const m = c.move(s); out.push(m.from + m.to + (m.promotion ?? '')); } catch { break; } }
  return out;
}

export function MoveCard({ node, parentFen, mr, live, opening, showClass, showEngine, onPlayLine, explore, onExplain, explaining, canExplain }: {
  node: TreeNode;
  parentFen?: string;
  mr?: MoveReview;
  live: AnalysisResult | null;
  opening?: OpeningInfo | null;
  showClass: boolean;
  showEngine: boolean;
  onPlayLine: (fen: string, pv: string[], plies: number) => void;
  explore?: boolean;
  /** open or close the explanation of this move (only on request) */
  onExplain?: () => void;
  explaining?: boolean;
  canExplain?: boolean;
}) {
  if (!node.san) {
    return (
      <div className="move-card" data-testid="move-card">
        <div className="move-head"><span className="move-san">Starting position</span></div>
        {opening && <div className="move-sub">{opening.eco} {opening.name}</div>}
        <p className="dim small" style={{ marginTop: 'var(--s-3)' }}>Step through the game with the arrow keys or the buttons below. Each move shows its rating on the board.</p>
        {showEngine && <EngineLines live={live} fen={node.fen} onPlayLine={onPlayLine} />}
      </div>
    );
  }
  const white = node.ply % 2 === 1;
  const moveNo = Math.ceil(node.ply / 2);
  const sanLabel = `${moveNo}${white ? '.' : '…'} ${node.san}`;

  if (!mr || !showClass) {
    // explored or not-yet-reviewed move
    const side = new Chess(node.fen).turn() === 'w' ? 'b' : 'w';
    const score = live?.lines[0]?.score;
    return (
      <div className="move-card" data-testid="move-card">
        <div className="move-head">
          {explore ? <span style={{ color: node.source === 'engine' ? 'var(--engine)' : 'var(--branch)' }}><IconBranch /></span> : <PendingIcon size="md" />}
          <span className="move-san">{sanLabel}</span>
        </div>
        <div className="move-sub">
          {explore ? (node.source === 'engine' ? 'Engine continuation' : node.source === 'imported' ? 'Variation from the PGN' : node.source === 'theory' ? 'Catalogued theory' : 'Your exploration') : 'Waiting for analysis'}
          {score ? `. Evaluation ${formatScore(score)}, ${winPercentPov(score, side).toFixed(0)}% winning chances for ${side === 'w' ? 'White' : 'Black'}.` : ''}
        </div>
        {node.comment && <p className="small" style={{ marginTop: 'var(--s-3)' }}>{node.comment}</p>}
        {showEngine && <EngineLines live={live} fen={node.fen} onPlayLine={onPlayLine} />}
      </div>
    );
  }

  const info = CLASS_INFO[mr.cls];
  const better = betterMove(mr);
  const who = mr.color === 'w' ? 'White' : 'Black';
  return (
    <div className="move-card" data-testid="move-card">
      <div className="move-head">
        <ClassIcon cls={mr.cls} size="md" provisional={mr.provisional} />
        <span className="move-san">{sanLabel}</span>
        <span className="move-verdict" style={{ color: info.color }} data-testid="move-class">{info.label}</span>
      </div>
      <div className="move-sub">
        {who}'s {ORD(moveNo)} move. Winning chances {winLabel(mr.evalBefore, mr.color)} → {winLabel(mr.evalAfter, mr.color)}, evaluation {formatScore(mr.evalAfter)}.
        {mr.provisional && <> <span className="faint">Provisional until the deeper pass finishes.</span></>}
      </div>
      {onExplain && (
        <div className="row" style={{ marginTop: 'var(--s-3)' }}>
          <button type="button" className={explaining ? 'btn btn-sm' : 'btn btn-sm btn-primary'} onClick={onExplain} disabled={!canExplain && !explaining} aria-pressed={!!explaining} data-testid="explain-move"
            title={canExplain || explaining ? 'Explain this move on the board (E)' : 'Available when the analysis of this move is ready'}>
            {explaining ? 'Hide explanation' : 'Explain'}
          </button>
        </div>
      )}
      {better && parentFen && mr.bestLine.length > 0 && !explaining && (
        <div className="best-line" data-testid="best-line">
          <div>Best was <b>{better.san}</b> {better.score && <span className="faint num">({better.score})</span>}</div>
          <div className="small faint" style={{ marginTop: 6 }}>{formatLine(parentFen, mr.bestLine.slice(0, 8))}</div>
          <button type="button" className="btn btn-sm" style={{ marginTop: 'var(--s-2)' }} onClick={() => onPlayLine(parentFen, sansToUci(parentFen, mr.bestLine), 10)} data-testid="explore-best">
            <IconBranch size={16} /> Explore this line
          </button>
        </div>
      )}
      <details className="disclose tech">
        <summary>Numbers behind the rating</summary>
        <dl>
          <dt>Evaluation</dt><dd>{formatScore(mr.evalBefore)} → {formatScore(mr.evalAfter)} (White's view)</dd>
          <dt>Expected points lost</dt><dd>{mr.epl.toFixed(1)} of 100</dd>
          <dt>Centipawn loss</dt><dd>{Math.round(mr.cpLoss)}</dd>
          <dt>Search depth</dt><dd>{mr.depth >= 999 ? 'terminal position' : mr.depth}</dd>
          <dt>Status</dt><dd>{mr.provisional ? 'Provisional (quick pass)' : 'Final (deep pass)'}</dd>
        </dl>
      </details>
      {showEngine && <EngineLines live={live} fen={node.fen} onPlayLine={onPlayLine} />}
    </div>
  );
}

function EngineLines({ live, fen, onPlayLine }: { live: AnalysisResult | null; fen: string; onPlayLine: (fen: string, pv: string[], plies: number) => void }) {
  const side = new Chess(fen).turn();
  return (
    <details className="disclose tech" data-testid="engine-lines">
      <summary>Engine lines from this position {live ? <span className="faint num">depth {live.depth}{live.fromCache ? ', cached' : ''}</span> : <span className="faint">thinking…</span>}</summary>
      {live?.terminal && <p className="small dim">{live.terminal === 'checkmate' ? 'Checkmate.' : 'Stalemate.'}</p>}
      {(live?.lines ?? []).filter((l) => l.pv.length).map((l) => (
        <button key={l.multipv} type="button" className="engine-line" onClick={() => onPlayLine(fen, l.pv, 10)} title="Add this line to the Tree of Life">
          <span className="score" style={{ color: winPercentPov(l.score, side) >= 50 ? 'var(--ivory)' : 'var(--text-2)' }}>{formatScore(l.score)}</span>
          <span>{formatLine(fen, pvToSan(fen, l.pv, 10))}</span>
        </button>
      ))}
      <p className="xs faint" style={{ marginTop: 6 }}>Click a line to explore it as a branch.</p>
    </details>
  );
}
