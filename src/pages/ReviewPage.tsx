import { Chess } from 'chess.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get } from '../db/db';
import type { GameRecord } from '../db/types';
import { addMove, branchStart, countBranches, deleteBranch, mainline, pathTo, preferredChild, updateNode, type GameTree } from '../chess/tree';
import type { GameReview, MoveReview } from '../analysis/review';
import { CLASS_INFO, CLASS_ORDER } from '../analysis/classify';
import { formatLine, pvToSan } from '../analysis/explain';
import { analyzeMove } from '../analysis/motifs';
import { materialCount } from '../chess/rules';
import { getEngine } from '../engine/instance';
import { AbortedError, type AnalysisResult } from '../engine/controller';
import { formatScore, winPercentPov, type Score } from '../engine/score';
import { Board, type BoardMove } from '../ui/Board';
import { EvalBar, ClassBadge, PlayerBar, downloadText, Modal } from '../ui/bits';
import { EvalGraph } from '../ui/EvalGraph';
import { TreeView } from '../ui/TreeView';
import { IconFirst, IconFlip, IconLast, IconNext, IconPrev } from '../ui/icons';
import { useApp } from '../ui/context';
import { gamePgn, gameTitle, saveTree } from '../services/games';
import { allowed, type Mode } from '../modes';
import { ensureReview, releaseReview } from '../services/reviews';

export function ReviewPage({ gameId }: { gameId?: string }) {
  const { prefs, toast } = useApp();
  const [game, setGame] = useState<GameRecord | null | undefined>(undefined);
  const [tree, setTree] = useState<GameTree | null>(null);
  const [review, setReview] = useState<GameReview | null>(null);
  const [cur, setCur] = useState<string>('');
  const [orientation, setOrientation] = useState<'white' | 'black'>('white');
  const [tab, setTab] = useState<'review' | 'tree'>('review');
  const [live, setLive] = useState<AnalysisResult | null>(null);
  const [nodeEval, setNodeEval] = useState<Record<string, Score>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [showArrow, setShowArrow] = useState(true);
  const [deleteAsk, setDeleteAsk] = useState<string | null>(null);
  const mode: Mode = game?.source === 'ranked' ? 'ranked-finished' : 'review';

  // ---------- load ----------
  useEffect(() => {
    if (!gameId) { setGame(null); return; }
    let alive = true;
    (async () => {
      const g = await get('games', gameId);
      if (!alive) return;
      setGame(g ?? null);
      if (!g) return;
      setTree(g.tree);
      const line = mainline(g.tree);
      setCur(line[0]);
      if (g.source === 'ranked' || g.source === 'coach') {
        const youBlack = g.headers.Black === 'You';
        setOrientation(youBlack ? 'black' : 'white');
      }
      const r = await get('reviews', gameId);
      if (!alive) return;
      if (r) setReview(r);
      if (!r || r.status !== 'complete' || r.deepDepth < prefs.deepDepth) startReview(g, r ?? null);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId]);

  const unsub = useRef<(() => void) | null>(null);
  const startReview = useCallback((g: GameRecord, prev: GameReview | null) => {
    unsub.current?.();
    unsub.current = ensureReview(g, { quickDepth: prefs.quickDepth, deepDepth: Math.max(prefs.deepDepth, prev?.deepDepth ?? 0) }, (r) => {
      setReview(r);
      if (r.status === 'complete' && g.rankedMatchId) toast('Analysis complete — the Rival is learning from this game.');
    });
  }, [prefs.quickDepth, prefs.deepDepth, toast]);
  useEffect(() => () => { unsub.current?.(); if (game) releaseReview(game); }, [game]);

  // ---------- derived ----------
  const line = useMemo(() => (tree ? mainline(tree) : []), [tree]);
  const byNode = useMemo(() => new Map((review?.moves ?? []).filter(Boolean).map((m) => [m.nodeId, m])), [review]);
  const posEval = useMemo(() => new Map((review?.positions ?? []).filter((p) => p.depth > 0).map((p) => [p.nodeId, p])), [review]);
  const node = tree && cur ? tree.nodes[cur] : null;
  const onMainline = !!node && line.includes(node.id);
  const moveReview: MoveReview | undefined = node ? byNode.get(node.id) : undefined;

  // ---------- live analysis of the current node ----------
  useEffect(() => {
    if (!node || !allowed(mode, 'engineLines')) return;
    const ac = new AbortController();
    setLive(null);
    const run = async () => {
      try {
        const r = await getEngine().analyze({ fen: node.fen, depth: prefs.liveDepth + 2, multipv: 3, priority: 2, signal: ac.signal, onProgress: (p) => { if (p.depth >= 6) setLive(p); } });
        setLive(r);
        if (r.lines[0]) setNodeEval((m) => ({ ...m, [node.id]: r.lines[0].score }));
      } catch (e) { if (!(e instanceof AbortedError)) setLive(null); }
    };
    const t = setTimeout(run, 120);
    return () => { clearTimeout(t); ac.abort(); };
  }, [node?.id, node?.fen, mode, prefs.liveDepth]);

  // ---------- persistence of explored branches ----------
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const commitTree = (t: GameTree) => {
    setTree(t);
    clearTimeout(saveTimer.current);
    if (game) saveTimer.current = setTimeout(() => { void saveTree(game.id, t); }, 300);
  };

  // ---------- navigation ----------
  const goPrev = () => { if (node?.parentId) setCur(node.parentId); };
  const goNext = () => { if (tree && node) { const c = preferredChild(tree, node.id); if (c) setCur(c); } };
  const goFirst = () => tree && setCur(tree.rootId);
  const goLast = () => { if (!tree || !node) return; let c = node.id; for (;;) { const n = preferredChild(tree, c); if (!n) break; c = n; } setCur(c); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft') goPrev();
      else if (e.key === 'ArrowRight') goNext();
      else if (e.key === 'Home') goFirst();
      else if (e.key === 'End') goLast();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (game === undefined) return <div className="empty">Loading…</div>;
  if (game === null || !tree || !node) return <div className="card empty">Game not found. <a href="#/library">Back to the library</a></div>;

  // ---------- exploration ----------
  const onBoardMove = (m: BoardMove) => {
    if (!allowed(mode, 'branches')) return false;
    try {
      const r = addMove(tree, node.id, m, 'user');
      if (!r.existed) commitTree(r.tree);
      setCur(r.nodeId);
      if (!r.existed) setTab('tree');
      return true;
    } catch { return false; }
  };

  const playEngineLine = (pv: string[], maxPlies = 8) => {
    let t = tree;
    let at = node.id;
    for (const u of pv.slice(0, maxPlies)) {
      try { const r = addMove(t, at, u, 'engine'); t = r.tree; at = r.nodeId; } catch { break; }
    }
    commitTree(t);
    setCur(at);
    setTab('tree');
  };

  const engineContinue = async (plies: number) => {
    setBusy(`Stockfish is playing ${plies} moves…`);
    let t = tree;
    let at = node.id;
    try {
      for (let i = 0; i < plies; i++) {
        const fen = t.nodes[at].fen;
        if (new Chess(fen).isGameOver()) break;
        const r = await getEngine().analyze({ fen, depth: prefs.liveDepth, multipv: 1, priority: 2 });
        if (!r.bestmove) break;
        const a = addMove(t, at, r.bestmove, 'engine');
        t = a.tree; at = a.nodeId;
        if (r.lines[0]) setNodeEval((m) => ({ ...m, [a.nodeId]: r.lines[0].score }));
      }
      commitTree(t);
      setCur(at);
      setTab('tree');
    } finally { setBusy(null); }
  };

  const evalOf = (id: string): Score | undefined => nodeEval[id] ?? posEval.get(id)?.score;
  const curScore = live?.lines[0]?.score ?? evalOf(node.id);
  const lastUci = node.uci;
  const arrows: [string, string, string][] = [];
  if (allowed(mode, 'bestMoveArrows') && showArrow) {
    const best = live?.lines[0]?.pv[0];
    if (best) arrows.push([best.slice(0, 2), best.slice(2, 4), 'rgba(143,193,122,0.85)']);
  }
  const whiteName = game.headers.White && game.headers.White !== '?' ? game.headers.White : 'White';
  const blackName = game.headers.Black && game.headers.Black !== '?' ? game.headers.Black : 'Black';
  const top = orientation === 'white' ? 'b' : 'w';
  const scores = line.map((id) => posEval.get(id)?.score);
  const mainIdx = line.indexOf(node.id);
  const bStart = branchStart(tree, node.id);
  const progress = review ? Math.round((review.progress.done / Math.max(1, review.progress.total)) * 100) : 0;

  return (
    <div>
      <div className="row between" style={{ marginBottom: 10 }}>
        <div>
          <h1 style={{ marginBottom: 2 }}>{gameTitle(game)}</h1>
          <div className="faint small">{[game.headers.Event, game.headers.Date, game.headers.TimeControl ? `TC ${game.headers.TimeControl}` : '', game.result].filter((x) => x && x !== '?' && x !== '????.??.??').join(' · ')}{review?.opening ? ` · ${review.opening.eco} ${review.opening.name}` : ''}</div>
        </div>
        <div className="row">
          {review && review.status !== 'complete' && (
            <span className="pill warn" data-testid="review-progress">{review.status === 'cancelled' ? 'paused' : `${review.progress.pass === 'quick' ? 'Quick pass' : 'Deep pass'} ${progress}%`}</span>
          )}
          {review?.status === 'complete' && <span className="pill accent" data-testid="review-complete">Analysed · depth {review.deepDepth}</span>}
          {review && (review.status === 'cancelled' || review.status === 'error') && <button className="btn sm" onClick={() => startReview(game, review)}>Resume analysis</button>}
          <button className="btn sm" onClick={async () => downloadText(`${gameTitle(game).replace(/\W+/g, '_')}.pgn`, await gamePgn({ ...game, tree }), 'application/x-chess-pgn')} data-testid="export-pgn">Export PGN</button>
        </div>
      </div>
      <div className="play">
        <div className="board-col">
          <PlayerBar name={top === 'w' ? whiteName : blackName} color={top} fen={node.fen} sub={top === 'w' ? game.headers.WhiteElo : game.headers.BlackElo} />
          <div className="board-wrap">
            {allowed(mode, 'evalBar') && <EvalBar score={curScore} orientation={orientation} />}
            <Board fen={node.fen} orientation={orientation} movable={allowed(mode, 'branches') ? 'both' : 'none'} onMove={onBoardMove} lastMove={lastUci ? [lastUci.slice(0, 2), lastUci.slice(2, 4)] : null} arrows={arrows} id="review-board" />
          </div>
          <PlayerBar name={top === 'w' ? blackName : whiteName} color={top === 'w' ? 'b' : 'w'} fen={node.fen} sub={top === 'w' ? game.headers.BlackElo : game.headers.WhiteElo} />
          <div className="controls">
            <div className="btn-group">
              <button className="btn icon" onClick={goFirst} aria-label="First"><IconFirst /></button>
              <button className="btn icon" onClick={goPrev} aria-label="Previous" data-testid="prev"><IconPrev /></button>
              <button className="btn icon" onClick={goNext} aria-label="Next" data-testid="next"><IconNext /></button>
              <button className="btn icon" onClick={goLast} aria-label="Last"><IconLast /></button>
            </div>
            <button className="btn icon" onClick={() => setOrientation(orientation === 'white' ? 'black' : 'white')} aria-label="Flip board"><IconFlip /></button>
            <label className="check small"><input type="checkbox" checked={showArrow} onChange={(e) => setShowArrow(e.target.checked)} /> best-move arrow</label>
            <span className="spacer" />
            {bStart ? <span className="pill branch">exploring a branch</span> : <span className="pill">original game</span>}
          </div>
          {allowed(mode, 'evalGraph') && review && (
            <div className="card tight">
              <EvalGraph scores={scores} current={mainIdx >= 0 ? mainIdx : -1} onSelect={(i) => setCur(line[i])} marks={line.slice(1).map((id) => byNode.get(id)?.cls)} />
            </div>
          )}
        </div>

        <div className="side-col">
          <div className="tabs">
            <button className={tab === 'review' ? 'on' : ''} onClick={() => setTab('review')} data-testid="tab-review">Review</button>
            <button className={tab === 'tree' ? 'on' : ''} onClick={() => setTab('tree')} data-testid="tab-tree">Tree of Life <span className="pill" style={{ marginLeft: 4 }}>{countBranches(tree)}</span></button>
          </div>

          {tab === 'review' && (
            <>
              {!review ? <div className="card muted">Starting analysis…</div> : (
                <div className="card" data-testid="review-summary">
                  <AccuracyHeader review={review} whiteName={whiteName} blackName={blackName} />
                  <div style={{ marginTop: 10 }}>
                    <div className="class-row faint small"><span /><span className="n">W</span><span className="n">B</span></div>
                    {CLASS_ORDER.map((c) => (
                      <div className="class-row" key={c}>
                        <span className="row" style={{ gap: 6 }}><ClassBadge cls={c} />{CLASS_INFO[c].label}</span>
                        <span className="n">{review.counts.w[c]}</span>
                        <span className="n">{review.counts.b[c]}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <MovePanel tree={tree} nodeId={node.id} mr={moveReview} onMainline={onMainline} live={live} mode={mode} onPlayLine={playEngineLine} onGoto={setCur} />
              {review && (
                <div className="card">
                  <h3>Game summary</h3>
                  <ul style={{ margin: 0, paddingLeft: 18 }} className="small">{review.summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
                  {review.turningPoints.length > 0 && (
                    <div className="row" style={{ marginTop: 8 }}>
                      <span className="faint small">Jump to turning point:</span>
                      {review.turningPoints.map((i) => { const m = review.moves[i]; return m ? <button key={i} className="btn sm" onClick={() => setCur(m.nodeId)}>{Math.ceil(m.ply / 2)}{m.color === 'w' ? '.' : '…'} {m.san}</button> : null; })}
                    </div>
                  )}
                </div>
              )}
              <div className="card">
                <h3>Moves</h3>
                <div className="moves" style={{ maxHeight: 260 }}>
                  {line.slice(1).map((id, i) => {
                    const n = tree.nodes[id];
                    const m = byNode.get(id);
                    const white = n.ply % 2 === 1;
                    return [
                      (white || i === 0) ? <span className="num" key={`n${id}`}>{Math.ceil(n.ply / 2)}.</span> : null,
                      (!white && i === 0) ? <span key="pad" /> : null,
                      <button key={id} className={`mv${id === cur ? ' cur' : ''}`} onClick={() => setCur(id)} data-ply={i + 1}>
                        <span>{n.san}</span>{allowed(mode, 'classifications') && m && <ClassBadge cls={m.cls} provisional={m.provisional} />}
                      </button>,
                    ];
                  })}
                </div>
              </div>
            </>
          )}

          {tab === 'tree' && (
            <>
              <div className="card">
                <div className="row between"><h3 style={{ margin: 0 }}>Variation tree</h3>
                  <span className="small faint"><span style={{ color: '#dfe3dc' }}>●</span> played · <span style={{ color: 'var(--branch)' }}>●</span> explored · <span style={{ color: 'var(--engine)' }}>●</span> engine · <span style={{ color: '#cfc79e' }}>●</span> from PGN</span>
                </div>
                <p className="faint small" style={{ margin: '4px 0 8px' }}>Play any move on the board to branch from the current position. The original game is never changed.</p>
                <TreeView tree={tree} current={cur} onSelect={setCur} classOf={(id) => { const m = byNode.get(id); return m && allowed(mode, 'classifications') ? { cls: m.cls, provisional: m.provisional } : undefined; }} />
              </div>
              <div className="card stack">
                <h3 style={{ margin: 0 }}>Explore from here</h3>
                <div className="row">
                  <button className="btn sm" disabled={!!busy || !live?.lines[0]} onClick={() => live?.lines[0] && playEngineLine(live.lines[0].pv, 1)} data-testid="engine-move">Engine move</button>
                  <button className="btn sm" disabled={!!busy} onClick={() => engineContinue(6)} data-testid="engine-continue">Stockfish plays 6 moves</button>
                  <button className="btn sm" disabled={!!busy || !live?.lines[0]} onClick={() => live?.lines[0] && playEngineLine(live.lines[0].pv, 10)}>Add best line</button>
                </div>
                {busy && <span className="small muted">{busy}</span>}
                <span className="faint small">Engine continuations show strong play, not what a human opponent would necessarily have done.</span>
              </div>
              {bStart && <BranchPanel tree={tree} nodeId={node.id} branchId={bStart} evalOf={evalOf} onChange={commitTree} onDelete={() => setDeleteAsk(bStart)} onGoto={setCur} />}
            </>
          )}
        </div>
      </div>
      {deleteAsk && (
        <Modal onClose={() => setDeleteAsk(null)}>
          <h2>Delete this branch?</h2>
          <p className="muted">The variation starting with {tree.nodes[deleteAsk].san} and everything after it will be removed. The original game is not affected.</p>
          <div className="row"><span className="spacer" /><button className="btn" onClick={() => setDeleteAsk(null)}>Cancel</button>
            <button className="btn danger" data-testid="confirm-delete-branch" onClick={() => { const p = tree.nodes[deleteAsk].parentId!; commitTree(deleteBranch(tree, deleteAsk)); setCur(p); setDeleteAsk(null); }}>Delete branch</button></div>
        </Modal>
      )}
    </div>
  );
}

function AccuracyHeader({ review, whiteName, blackName }: { review: GameReview; whiteName: string; blackName: string }) {
  const box = (name: string, acc: number | null, color: 'w' | 'b') => (
    <div style={{ flex: 1, padding: 10, borderRadius: 8, background: color === 'w' ? '#e8ebe6' : '#1a1f23', color: color === 'w' ? '#111' : '#eee', border: '1px solid var(--border)' }}>
      <div className="small" style={{ opacity: 0.7 }}>{name}</div>
      <div style={{ fontSize: 24, fontWeight: 700 }} data-testid={`accuracy-${color}`}>{acc === null ? '—' : acc.toFixed(1)}</div>
      <div className="small" style={{ opacity: 0.7 }}>accuracy</div>
    </div>
  );
  return (
    <div>
      <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>{box(whiteName, review.accuracy.w, 'w')}{box(blackName, review.accuracy.b, 'b')}</div>
      {review.status !== 'complete' && <div className="faint small" style={{ marginTop: 6 }}>Values are provisional until the deep pass finishes.</div>}
    </div>
  );
}

function MovePanel({ tree, nodeId, mr, onMainline, live, mode, onPlayLine, onGoto }: {
  tree: GameTree; nodeId: string; mr?: MoveReview; onMainline: boolean; live: AnalysisResult | null; mode: Mode; onPlayLine: (pv: string[], n?: number) => void; onGoto: (id: string) => void;
}) {
  const node = tree.nodes[nodeId];
  const side = new Chess(node.fen).turn();
  return (
    <div className="card" data-testid="move-panel">
      {node.san ? (
        <div className="row" style={{ marginBottom: 6 }}>
          <b style={{ fontSize: 16 }}>{Math.ceil(node.ply / 2)}{node.ply % 2 ? '.' : '…'} {node.san}</b>
          {mr && allowed(mode, 'classifications') && <><ClassBadge cls={mr.cls} provisional={mr.provisional} /><span style={{ color: CLASS_INFO[mr.cls].color, fontWeight: 600 }} data-testid="move-class">{CLASS_INFO[mr.cls].label}</span>{mr.provisional && <span className="pill">provisional</span>}</>}
          {!onMainline && <span className={`pill ${node.source === 'engine' ? 'engine' : 'branch'}`}>{node.source === 'engine' ? 'engine continuation' : node.source === 'imported' ? 'PGN variation' : 'your exploration'}</span>}
          <span className="spacer" />
          {mr && ['inaccuracy', 'mistake', 'miss', 'blunder'].includes(mr.cls) && node.parentId && (
            <button className="btn sm" onClick={() => onGoto(node.parentId!)} data-testid="try-alternative">Try another move here</button>
          )}
        </div>
      ) : <div className="muted" style={{ marginBottom: 6 }}>Starting position</div>}
      {mr && allowed(mode, 'explanations') && (
        <>
          <div className="small muted" style={{ marginBottom: 6 }}>Winning chances {mr.winBefore.toFixed(0)}% → {mr.winAfter.toFixed(0)}% for {mr.color === 'w' ? 'White' : 'Black'} · centipawn loss {Math.round(mr.cpLoss)} · depth {mr.depth}</div>
          <ul className="small" style={{ margin: '0 0 8px', paddingLeft: 18 }} data-testid="explanation">{mr.explanation.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </>
      )}
      {node.comment && <div className="notice small" style={{ marginBottom: 8 }}>{node.comment}</div>}
      {allowed(mode, 'engineLines') && (
        <div>
          <div className="row between"><h3 style={{ margin: 0 }}>Engine lines</h3><span className="faint small">{live ? `depth ${live.depth}${live.fromCache ? ' (cached)' : ''}` : 'thinking…'}</span></div>
          {live?.terminal && <div className="muted small">{live.terminal === 'checkmate' ? 'Checkmate.' : 'Stalemate.'}</div>}
          {(live?.lines ?? []).filter((l) => l.pv.length).map((l) => (
            <div key={l.multipv} className="row small" style={{ flexWrap: 'nowrap', margin: '4px 0' }}>
              <span className="mono" style={{ minWidth: 52, color: winPercentPov(l.score, side) >= 50 ? 'var(--accent)' : '#f08a8d' }}>{formatScore(l.score)}</span>
              <button className="btn ghost sm" style={{ textAlign: 'left', whiteSpace: 'normal', justifyContent: 'flex-start' }} onClick={() => onPlayLine(l.pv, 10)} title="Add this line to the tree">{formatLine(node.fen, pvToSan(node.fen, l.pv, 10))}</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BranchPanel({ tree, nodeId, branchId, evalOf, onChange, onDelete, onGoto }: {
  tree: GameTree; nodeId: string; branchId: string; evalOf: (id: string) => Score | undefined; onChange: (t: GameTree) => void; onDelete: () => void; onGoto: (id: string) => void;
}) {
  const b = tree.nodes[branchId];
  const [name, setName] = useState(b.branchName ?? '');
  const [note, setNote] = useState(b.branchNote ?? '');
  useEffect(() => { setName(b.branchName ?? ''); setNote(b.branchNote ?? ''); }, [branchId, b.branchName, b.branchNote]);
  const node = tree.nodes[nodeId];
  // where this line of play left the original game
  const pathIds = pathTo(tree, nodeId);
  const leaveId = pathIds.find((id) => tree.nodes[id].source !== 'historical' && tree.nodes[id].source !== 'root')!;
  const leave = tree.nodes[leaveId];
  const leaveParent = tree.nodes[leave.parentId!];
  const origId = leaveParent.children.find((c) => tree.nodes[c].source === 'historical');
  const origMove = origId ? tree.nodes[origId] : null;
  const main = mainline(tree);
  const origAtPly = main.find((id) => tree.nodes[id].ply === node.ply);
  const mover = new Chess(leaveParent.fen).turn();
  const evB = evalOf(nodeId);
  const evO = origAtPly ? evalOf(origAtPly) : undefined;
  const matB = materialCount(node.fen).diff;
  const matO = origAtPly ? materialCount(tree.nodes[origAtPly].fen).diff : null;
  let facts: string[] = [];
  try { facts = analyzeMove(leaveParent.fen, leave.uci!).motifs.filter((m) => m.kind !== 'capture').slice(0, 3).map((m) => m.text); } catch { /* ignore */ }
  const firstEval = evalOf(leaveId);
  const origEval = origMove ? evalOf(origMove.id) : undefined;
  const nested = leaveId !== branchId;
  const parentBranch = nested ? tree.nodes[b.parentId!] : null;
  const fmtMat = (d: number) => (d === 0 ? 'equal material' : `${d > 0 ? 'White' : 'Black'} +${Math.abs(d)}`);
  return (
    <div className="card stack" data-testid="branch-panel">
      <div className="row between"><h3 style={{ margin: 0 }}>This branch</h3><button className="btn sm danger" onClick={onDelete}>Delete branch</button></div>
      <div className="small muted">
        {nested
          ? <>Starts at {Math.ceil(b.ply / 2)}{b.ply % 2 ? '.' : '…'} {b.san}, a branch inside your exploration after {parentBranch?.san}. </>
          : <>Starts at {Math.ceil(b.ply / 2)}{b.ply % 2 ? '.' : '…'} {b.san}. </>}
        This line left the original game at {Math.ceil(leave.ply / 2)}{leave.ply % 2 ? '.' : '…'} {leave.san}
        {origMove ? <> instead of <button className="btn ghost sm" onClick={() => onGoto(origMove.id)}>{origMove.san}</button></> : ' (after the game had ended)'}.
      </div>
      <div className="grid2" style={{ gap: 8 }}>
        <label className="field">Name<input type="text" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => onChange(updateNode(tree, branchId, { branchName: name || undefined }))} placeholder="e.g. Keeping the knight" data-testid="branch-name" /></label>
        <label className="field">Notes<input type="text" value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => onChange(updateNode(tree, branchId, { branchNote: note || undefined }))} placeholder="What were you testing?" /></label>
      </div>
      <div>
        <h3>Compared with the original game</h3>
        <table className="list small" data-testid="branch-compare">
          <thead><tr><th /><th>This branch</th><th>Original game</th></tr></thead>
          <tbody>
            <tr><td>Move where the paths split</td><td>{leave.san} ({formatScore(firstEval)})</td><td>{origMove ? `${origMove.san} (${formatScore(origEval)})` : '— game ended'}</td></tr>
            <tr><td>Winning chances for {mover === 'w' ? 'White' : 'Black'} after it</td><td>{firstEval ? `${winPercentPov(firstEval, mover).toFixed(0)}%` : '…'}</td><td>{origEval ? `${winPercentPov(origEval, mover).toFixed(0)}%` : '…'}</td></tr>
            <tr><td>At move {Math.ceil(node.ply / 2)} (current)</td><td>{formatScore(evB)} · {fmtMat(matB)}</td><td>{origAtPly ? `${formatScore(evO)} · ${fmtMat(matO!)}` : '— game ended'}</td></tr>
          </tbody>
        </table>
      </div>
      {facts.length > 0 && <div><h3>Verified consequences of {leave.san}</h3><ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{facts.map((f, i) => <li key={i}>{f}</li>)}</ul></div>}
    </div>
  );
}
