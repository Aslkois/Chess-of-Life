import { Chess } from 'chess.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get, listGames } from '../../db/db';
import type { GameRecord } from '../../db/types';
import { addMove, branchStart, countBranches, deleteBranch, mainline, pathTo, preferredChild, type GameTree } from '../../chess/tree';
import type { GameReview, MoveReview } from '../../analysis/review';
import type { Classification } from '../../analysis/classify';
import { getEngine } from '../../engine/instance';
import { AbortedError, type AnalysisResult } from '../../engine/controller';
import type { Score } from '../../engine/score';
import { Board, PlanToggle, type BoardAnnotation, type BoardMove } from '../../ui/Board';
import { PlayerStrip, Stage } from '../../ui/stage';
import { EvalGraph } from '../../ui/EvalGraph';
import { MoveList } from '../../ui/MoveList';
import { MoveStrip } from '../../ui/MoveStrip';
import { ReplayControls } from '../../ui/Replay';
import { ConfirmDialog, Dialog } from '../../ui/Dialog';
import { downloadText } from '../../ui/bits';
import { IconBranch, IconDownload, IconEye, IconFlip, IconKeyboard } from '../../ui/icons';
import { useApp } from '../../ui/context';
import { useKeys } from '../../ui/useKeys';
import { gamePgn, gameTitle, queueTreeSave } from '../../services/games';
import { ensureReview, needsReReview, releaseReview } from '../../services/reviews';
import { REVIEW_VERSION } from '../../analysis/review';
import { allowed, type Mode } from '../../modes';
import { MoveCard } from './MoveCard';
import { prettyDate } from '../../util/format';
import { ExplorePanel } from './ExplorePanel';
import { SummaryPanel } from './SummaryPanel';
import { OpeningStrip } from './OpeningStrip';
import { ExplainPanel, explainBoard, toBoardMarks, type ExplainView } from './ExplainPanel';
import { explainMove, type Explanation } from '../../analysis/explainMove';
import { trackOpening } from '../../analysis/openings';
import { gamesAtPosition, playerColorOf } from '../../services/openings';
import { saveGame } from '../../services/games';

type Tab = 'review' | 'explore' | 'summary';
const KEY_CLASSES: Classification[] = ['brilliant', 'great', 'miss', 'mistake', 'blunder'];


export function ReviewPage({ gameId, ply }: { gameId?: string; ply?: string }) {
  const plyRef = useRef(ply);
  plyRef.current = ply;
  const { prefs, updatePrefs, toast } = useApp();
  const [game, setGame] = useState<GameRecord | null | undefined>(undefined);
  const [tree, setTree] = useState<GameTree | null>(null);
  const [review, setReview] = useState<GameReview | null>(null);
  const [cur, setCur] = useState('');
  const [navMode, setNavMode] = useState<BoardAnnotation['mode']>('animate');
  const lastNav = useRef(0);
  const [orientation, setOrientation] = useState<'white' | 'black'>('white');
  const [tab, setTabState] = useState<Tab>(prefs.reviewTab ?? 'review');
  const [live, setLive] = useState<AnalysisResult | null>(null);
  const [nodeEval, setNodeEval] = useState<Record<string, Score>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [deleteAsk, setDeleteAsk] = useState<string | null>(null);
  const [showKeys, setShowKeys] = useState(false);
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
      const target = plyRef.current !== undefined ? mainline(g.tree)[Number(plyRef.current)] : undefined;
      if (target) appliedPly.current = `${g.id}:${plyRef.current}`;
      setCur(target ?? g.tree.rootId);
      if (playerColorOf(g, prefs.playerNames) === 'b') setOrientation('black');
      const r = await get('reviews', gameId);
      if (!alive) return;
      if (r) setReview(r);
      if (needsReReview(r, prefs.deepDepth)) startReview(g, r && (r.version ?? 1) >= REVIEW_VERSION ? r : null);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId]);

  // a deep link to a ply (e.g. from the Opening Explorer): applied once per (game, ply),
  // whichever arrives first, the link or the loaded game
  const appliedPly = useRef<string | null>(null);
  useEffect(() => {
    if (ply === undefined || !tree || !game) return;
    const k = `${game.id}:${ply}`;
    if (appliedPly.current === k) return;
    const id = mainline(tree)[Number(ply)];
    if (!id) return;
    appliedPly.current = k;
    setCur(id);
  }, [ply, tree, game]); // eslint-disable-line react-hooks/exhaustive-deps
  /** an explanation, shown only when the user asks for it; any change of position dismisses it */
  const [explainState, setExplain] = useState<{ nodeId: string; x: Explanation; view: ExplainView } | null>(null);
  useEffect(() => { setExplain((e) => (e && e.nodeId !== cur ? null : e)); }, [cur]);
  // derived during render, so navigating away hides it in the same frame
  const explain = explainState && explainState.nodeId === cur ? explainState : null;
  const [allGames, setAllGames] = useState<GameRecord[] | null>(null);
  useEffect(() => { listGames().then(setAllGames).catch(() => setAllGames([])); }, [gameId]);
  const setSide = async (v: string) => {
    if (!game) return;
    const playerColor = v === '' ? undefined : v === 'none' ? null : (v as 'w' | 'b');
    const fresh = (await get('games', game.id)) ?? game;
    const next = { ...fresh, playerColor };
    if (playerColor === undefined) delete next.playerColor;
    await saveGame(next);
    setGame(next);
    setAllGames((gs) => gs?.map((x) => (x.id === next.id ? next : x)) ?? null);
    toast(playerColor ? `Marked as your game with ${playerColor === 'w' ? 'White' : 'Black'}.` : playerColor === null ? 'Marked as someone else’s game.' : 'Side cleared.');
  };

  const unsub = useRef<(() => void) | null>(null);
  const startReview = useCallback((g: GameRecord, prev: GameReview | null) => {
    unsub.current?.();
    unsub.current = ensureReview(g, { quickDepth: prefs.quickDepth, deepDepth: Math.max(prefs.deepDepth, prev?.deepDepth ?? 0) }, (r) => {
      setReview(r);
      if (r.status === 'complete' && g.rankedMatchId) toast('Analysis complete. The Rival is learning from this game.');
    });
  }, [prefs.quickDepth, prefs.deepDepth, toast]);
  // Unsubscribe only on unmount (a cleanup keyed on `game` could drop a fresh subscription).
  const gameRef = useRef<GameRecord | null>(null);
  useEffect(() => { gameRef.current = game ?? null; }, [game]);
  useEffect(() => () => { unsub.current?.(); if (gameRef.current) releaseReview(gameRef.current); }, []);

  // ---------- derived ----------
  const line = useMemo(() => (tree ? mainline(tree) : []), [tree]);
  const mainSet = useMemo(() => new Set(line), [line]);
  const byNode = useMemo(() => new Map((review?.moves ?? []).filter(Boolean).map((m) => [m.nodeId, m])), [review]);
  const posEval = useMemo(() => new Map((review?.positions ?? []).filter((p) => p.depth > 0).map((p) => [p.nodeId, p.score])), [review]);
  const node = tree && cur ? tree.nodes[cur] : null;
  const onMain = !!node && mainSet.has(node.id);
  const mr: MoveReview | undefined = node ? byNode.get(node.id) : undefined;
  const mainIdx = line.indexOf(cur);
  const pathIds = useMemo(() => (tree && cur ? pathTo(tree, cur) : []), [tree, cur]);
  const openingTrack = useMemo(() => (tree ? trackOpening(pathIds.map((id) => tree.nodes[id].fen)) : null), [tree, pathIds]);
  const keyMoments = useMemo(() => {
    const idx = new Set<number>();
    (review?.moves ?? []).forEach((m, i) => { if (m && KEY_CLASSES.includes(m.cls)) idx.add(i + 1); });
    (review?.turningPoints ?? []).forEach((i) => idx.add(i + 1));
    return [...idx].sort((a, b) => a - b);
  }, [review]);

  // ---------- navigation ----------
  const go = useCallback((id: string) => {
    const now = performance.now();
    setNavMode(now - lastNav.current < 230 ? 'quick' : 'animate');
    lastNav.current = now;
    setCur(id);
  }, []);
  const setTab = (t: Tab) => {
    setTabState(t);
    updatePrefs({ reviewTab: t });
    if (t !== 'explore' && tree && node && !mainSet.has(node.id)) backToGame();
  };
  const backToGame = () => {
    if (!tree || !node) return;
    const p = pathTo(tree, node.id);
    let last = tree.rootId;
    for (const id of p) if (mainSet.has(id)) last = id;
    go(last);
  };
  const navPrev = () => { if (node?.parentId) go(node.parentId); };
  const navNext = () => {
    if (!tree || !node) return;
    const next = onMain && tab !== 'explore' ? line[mainIdx + 1] : preferredChild(tree, node.id);
    if (next) go(next);
  };
  const navFirst = () => tree && go(tree.rootId);
  const navLast = () => {
    if (!tree || !node) return;
    if (onMain) { go(line[line.length - 1]); return; }
    let c = node.id;
    for (;;) { const n = preferredChild(tree, c); if (!n) break; c = n; }
    go(c);
  };
  // ---------- explanations (on request only) ----------
  const explainData = () => {
    if (!review || !tree || !mr || !onMain || mainIdx < 1 || !allowed(mode, 'explanations')) return null;
    const m = mainIdx - 1;
    const before = review.positions.find((p) => p.nodeId === line[m]);
    const after = review.positions.find((p) => p.nodeId === line[m + 1]);
    if (!before?.lines?.length) return null;
    const prev = m >= 1 ? review.moves[m - 1] : undefined;
    return { fenBefore: tree.nodes[line[m]].fen, uci: mr.uci, cls: mr.cls, epl: mr.epl, before: before.lines, after: after?.lines ?? [], prev: prev ? { san: prev.san, uci: prev.uci, cls: prev.cls, epl: prev.epl } : null };
  };
  const canExplain = !!explainData();
  const toggleExplain = () => {
    if (explain) { setExplain(null); return; }
    const d = explainData();
    if (!d || !node) return;
    try { setExplain({ nodeId: node.id, x: explainMove(d), view: { k: 'point', i: 0 } }); } catch { /* nothing to explain */ }
  };
  const stepLine = (d: number) => setExplain((e) => {
    if (!e || e.view.k !== 'line') return e;
    const v = e.view;
    const ln = e.x.lines.find((l) => l.id === v.id);
    return ln ? { ...e, view: { ...v, step: Math.max(0, Math.min(ln.steps.length, v.step + d)) } } : e;
  });

  const prevKey = keyMoments.filter((i) => i < (onMain ? mainIdx : Infinity)).pop();
  const nextKey = keyMoments.find((i) => i > (onMain ? mainIdx : -1));
  const flip = () => setOrientation((o) => (o === 'white' ? 'black' : 'white'));
  useKeys({
    ArrowLeft: navPrev, ArrowRight: navNext, Home: navFirst, End: navLast,
    ArrowUp: () => { if (prevKey !== undefined) go(line[prevKey]); },
    ArrowDown: () => { if (nextKey !== undefined) go(line[nextKey]); },
    f: flip, F: flip,
    '?': () => setShowKeys(true),
    e: () => toggleExplain(),
    '[': () => stepLine(-1),
    ']': () => stepLine(1),
    Escape: () => { if (explain) { setExplain(null); return; } if (!onMain) { backToGame(); setTab('review'); } },
  });

  // ---------- live analysis of the current position ----------
  useEffect(() => {
    if (!node || !allowed(mode, 'engineLines')) return;
    const ac = new AbortController();
    setLive(null);
    const t = setTimeout(async () => {
      try {
        const r = await getEngine().analyze({ fen: node.fen, depth: prefs.liveDepth + 2, multipv: 3, priority: 2, signal: ac.signal, onProgress: (p) => { if (p.depth >= 6) setLive(p); } });
        setLive(r);
        if (r.lines[0]) setNodeEval((m) => ({ ...m, [node.id]: r.lines[0].score }));
      } catch (e) { if (!(e instanceof AbortedError)) setLive(null); }
    }, 140);
    return () => { clearTimeout(t); ac.abort(); };
  }, [node?.id, node?.fen, mode, prefs.liveDepth]);

  // ---------- tree edits (saved immediately, in order) ----------
  const commitTree = (t: GameTree) => { setTree(t); if (game) void queueTreeSave(game.id, t); };

  if (game === undefined) return <div className="page"><div className="empty">Loading game…</div></div>;
  if (game === null || !tree || !node) {
    return <div className="page"><div className="empty"><h2>Game not found</h2><p>It may have been deleted.</p><div className="row"><a className="btn" href="#/library">Open the library</a></div></div></div>;
  }

  const enterExplore = () => { if (tab !== 'explore') { setTabState('explore'); updatePrefs({ reviewTab: 'explore' }); } };
  const onBoardMove = (m: BoardMove) => {
    if (!allowed(mode, 'branches')) return false;
    try {
      const r = addMove(tree, node.id, m, 'user');
      if (!r.existed) { commitTree(r.tree); enterExplore(); }
      else if (!mainSet.has(r.nodeId)) enterExplore();
      go(r.nodeId);
      return true;
    } catch { return false; }
  };
  const playBranch = (uci: string) => {
    try {
      const r = addMove(tree, node.id, { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }, 'user');
      if (!r.existed) commitTree(r.tree);
      go(r.nodeId);
    } catch { /* not legal here */ }
  };
  const addTheory = (uci: string) => {
    try {
      const r = addMove(tree, node.id, { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }, 'theory');
      if (!r.existed) commitTree(r.tree);
      go(r.nodeId);
    } catch { /* not legal here */ }
  };
  const playLine = (fen: string, pv: string[], plies: number) => {
    // the line starts at `fen`: the current node or (for "best was…") its parent
    const startId = fen === node.fen ? node.id : node.parentId ?? node.id;
    let t = tree;
    let at = startId;
    for (const u of pv.slice(0, plies)) {
      try { const r = addMove(t, at, u, 'engine'); t = r.tree; at = r.nodeId; } catch { break; }
    }
    commitTree(t);
    enterExplore();
    go(at);
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
        if (r.lines[0]) setNodeEval((mm) => ({ ...mm, [a.nodeId]: r.lines[0].score }));
      }
      commitTree(t);
      enterExplore();
      go(at);
    } finally { setBusy(null); }
  };
  const engineMove = () => { if (live?.lines[0]?.pv.length) playLine(node.fen, live.lines[0].pv, 1); else void engineContinue(1); };

  const classOf = (id: string) => { const m = byNode.get(id); return m && allowed(mode, 'classifications') ? { cls: m.cls, provisional: m.provisional } : undefined; };
  const evalOf = (id: string): Score | undefined => nodeEval[id] ?? posEval.get(id);
  const exploreMode = tab === 'explore' || !onMain;
  const bStart = branchStart(tree, node.id);

  const annotation: BoardAnnotation | null = onMain && mr && node.uci && allowed(mode, 'classifications')
    ? { from: node.uci.slice(0, 2), to: node.uci.slice(2, 4), cls: mr.cls, provisional: mr.provisional, key: node.id, mode: navMode }
    : null;
  const arrows: [string, string, string][] = [];
  if (prefs.showBestArrow && allowed(mode, 'bestMoveArrows') && live?.lines[0]?.pv[0]) {
    const b = live.lines[0].pv[0];
    arrows.push([b.slice(0, 2), b.slice(2, 4), 'rgba(127, 179, 74, 0.85)']);
  }
  // while an explanation is open the board shows its position and marks; the game itself is untouched
  const xb = explain && mr ? explainBoard(explain.x, explain.view) : null;
  const boardFen = xb ? xb.fen : node.fen;
  const boardMarks = xb && mr ? toBoardMarks(xb.marks, mr.cls) : null;
  const onGamePosition = !xb || xb.fen === node.fen;
  const boardLast: [string, string] | null = xb ? xb.lastMove : node.uci ? [node.uci.slice(0, 2), node.uci.slice(2, 4)] : null;
  const whiteName = game.headers.White && game.headers.White !== '?' ? game.headers.White : 'White';
  const blackName = game.headers.Black && game.headers.Black !== '?' ? game.headers.Black : 'Black';
  const topColor = orientation === 'white' ? 'b' : 'w';
  const nameOf = (c: 'w' | 'b') => (c === 'w' ? whiteName : blackName);
  const eloOf = (c: 'w' | 'b') => (c === 'w' ? game.headers.WhiteElo : game.headers.BlackElo);
  const turn = new Chess(boardFen).turn();
  const progress = review ? Math.round((review.progress.done / Math.max(1, review.progress.total)) * 100) : 0;
  const scores = line.map((id) => posEval.get(id));
  const metaBits = [game.headers.Event, prettyDate(game.headers.Date), review?.opening ? `${review.opening.eco} ${review.opening.name}` : null].filter((x) => x && x !== '?' && x !== '????.??.??');
  const moveItems = line.slice(1).map((id) => {
    const m = byNode.get(id);
    return { san: tree.nodes[id].san!, cls: allowed(mode, 'classifications') ? m?.cls : undefined, provisional: m?.provisional, pending: !m };
  });
  const atStart = !node.parentId;
  const atEnd = onMain && tab !== 'explore' ? mainIdx === line.length - 1 : !preferredChild(tree, node.id);
  const replay = <ReplayControls atStart={atStart} atEnd={atEnd} onFirst={navFirst} onPrev={navPrev} onNext={navNext} onLast={navLast} />;
  const leaveGameAt = (() => { if (onMain) return null; const p = pathTo(tree, node.id); const id = p.find((x) => !mainSet.has(x)); return id ? tree.nodes[id] : null; })();

  return (
    <div className="page">
      <header className="page-head" style={{ marginBottom: 'var(--s-4)' }}>
        <div style={{ minWidth: 0 }}>
          <h1 className="ellipsis">{gameTitle(game)} <span className="faint" style={{ fontWeight: 500 }}>{game.result === '1/2-1/2' ? '½–½' : game.result}</span></h1>
          {metaBits.length > 0 && <div className="lede small ellipsis">{metaBits.join(', ')}</div>}
        </div>
        <div className="page-head-actions review-head-actions">
          {review && review.status !== 'complete' && review.status !== 'cancelled' && review.status !== 'error' && (
            <div className="analysis-progress" data-testid="review-progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Analysis progress">
              <span className="small dim">{review.progress.pass === 'quick' ? 'Quick pass' : 'Deep pass'} {progress}%</span>
              <span className="meter" style={{ width: 120 }}><i style={{ width: `${progress}%` }} /></span>
            </div>
          )}
          {review?.status === 'complete' && <span className="small faint" data-testid="review-complete">Analysed to depth {review.deepDepth}</span>}
          {review && (review.status === 'cancelled' || review.status === 'error') && <button type="button" className="btn btn-sm" onClick={() => startReview(game, review)}>Resume analysis</button>}
          {(game.source === 'pgn' || game.source === 'manual') && (
            <select className="input input-sm" value={game.playerColor === undefined ? (playerColorOf(game, prefs.playerNames) ?? '') : game.playerColor === null ? 'none' : game.playerColor} onChange={(e) => void setSide(e.target.value)} aria-label="Your side in this game" title="Your side in this game (used for your opening statistics)" data-testid="game-side">
              <option value="">Your side: not set</option>
              <option value="w">You played White</option>
              <option value="b">You played Black</option>
              <option value="none">Not your game</option>
            </select>
          )}
          <button type="button" className="btn btn-sm btn-quiet" onClick={async () => downloadText(`${gameTitle(game).replace(/\W+/g, '_')}.pgn`, await gamePgn({ ...game, tree }), 'application/x-chess-pgn')} data-testid="export-pgn"><IconDownload size={16} /> Export PGN</button>
        </div>
      </header>

      <div className="board-layout">
        <Stage orientation={orientation} evalScore={allowed(mode, 'evalBar') ? live?.lines[0]?.score ?? evalOf(node.id) ?? null : undefined}
          top={<PlayerStrip name={nameOf(topColor)} color={topColor} fen={boardFen} meta={eloOf(topColor)} isTurn={turn === topColor} />}
          bottom={<PlayerStrip name={nameOf(topColor === 'w' ? 'b' : 'w')} color={topColor === 'w' ? 'b' : 'w'} fen={boardFen} meta={eloOf(topColor === 'w' ? 'b' : 'w')} isTurn={turn !== topColor} />}
          below={
            <>
              <div className="row board-tools">
                <button type="button" className="btn btn-sm btn-quiet" onClick={flip} title="Flip board (F)"><IconFlip size={16} /> Flip</button>
                <PlanToggle />
                <button type="button" className="btn btn-sm btn-quiet" aria-pressed={prefs.showBestArrow} onClick={() => updatePrefs({ showBestArrow: !prefs.showBestArrow })} title="Show the engine's best move as an arrow"><IconEye size={16} /> {prefs.showBestArrow ? 'Hide best move' : 'Show best move'}</button>
                <span className="spacer" />
                <button type="button" className="btn btn-sm btn-quiet hide-mobile" onClick={() => setShowKeys(true)} title="Keyboard shortcuts (?)"><IconKeyboard size={16} /> Shortcuts</button>
              </div>
            </>
          }>
          {(size) => (
            <Board fen={boardFen} orientation={orientation} size={size} movable={allowed(mode, 'branches') && onGamePosition ? 'both' : 'none'} onMove={onBoardMove}
              lastMove={boardLast} annotation={onGamePosition && !xb ? annotation : null} arrows={xb ? [] : arrows} marks={boardMarks} frame={xb && !onGamePosition ? 'demo' : exploreMode ? 'explore' : 'normal'} id="review-board" />
          )}
        </Stage>

        <div className="panel-slot">
          <section className="panel" aria-label="Review panel">
            <div className="panel-tabs" role="tablist">
              <button type="button" role="tab" className="panel-tab" aria-selected={tab === 'review'} onClick={() => setTab('review')} data-testid="tab-review">Review</button>
              <button type="button" role="tab" className="panel-tab" aria-selected={tab === 'explore'} onClick={() => setTab('explore')} data-testid="tab-tree"><IconBranch size={16} />Explore <span className="count">{countBranches(tree) || ''}</span></button>
              <button type="button" role="tab" className="panel-tab" aria-selected={tab === 'summary'} onClick={() => setTab('summary')} data-testid="tab-summary">Summary</button>
            </div>

            {exploreMode && (
              <div className={`mode-bar${onMain ? '' : ' is-explore'}`} data-testid="mode-bar">
                <IconBranch size={18} />
                <div className="mode-text">
                  {onMain ? <>On the original game. <span className="dim">Play a move on the board to branch from here.</span></>
                    : <><b>Exploring a branch</b> <span className="dim">from {leaveGameAt ? `${Math.ceil(leaveGameAt.ply / 2)}${leaveGameAt.ply % 2 ? '.' : '…'} ${leaveGameAt.san}` : 'the game'}. The original game is unchanged.</span></>}
                </div>
                <span className="spacer" />
                {!onMain && <button type="button" className="btn btn-sm" onClick={() => { backToGame(); }} data-testid="back-to-game" title="Return to the original game (Esc)">Back to game</button>}
              </div>
            )}

            {tab === 'review' && (
              <>
                {allowed(mode, 'openingInfo') && openingTrack && (() => {
                  const op = openingTrack.plies[openingTrack.plies.length - 1];
                  const ucisToHere = pathIds.slice(1).map((id) => tree.nodes[id].uci!);
                  const lb = op.lastBookIndex;
                  const lbNode = lb >= 0 && lb < pathIds.length - 1 ? tree.nodes[pathIds[lb + 1]] : null;
                  const leftWith = !op.inBook && lbNode?.san ? `${Math.ceil(lbNode.ply / 2)}${lbNode.ply % 2 ? '.' : '…'}${lbNode.san}` : null;
                  const mine = allGames ? gamesAtPosition(allGames, node.fen, prefs.playerNames, { source: 'competitive', color: 'both' }).games.length + gamesAtPosition(allGames, node.fen, prefs.playerNames, { source: 'coach', color: 'both' }).games.length : null;
                  return <OpeningStrip ply={op} ucis={ucisToHere} leftWith={leftWith} mine={mine} isMove={!!node.parentId} />;
                })()}
                <MoveStrip moves={moveItems} current={onMain ? mainIdx : -1} onSelect={(n) => go(line[n])} showIcons={allowed(mode, 'classifications')} />
                <div className={`panel-card-scroll${explain ? ' is-explaining' : ''}`}>
                  <MoveCard node={node} parentFen={node.parentId ? tree.nodes[node.parentId].fen : undefined} mr={mr} live={live} opening={null}
                    onExplain={onMain && allowed(mode, 'explanations') ? toggleExplain : undefined} explaining={!!explain} canExplain={canExplain}
                    showClass={allowed(mode, 'classifications')} showEngine={allowed(mode, 'engineLines') && !explain} onPlayLine={playLine} />
                  {explain && mr && <ExplainPanel x={explain.x} cls={mr.cls} view={explain.view} onView={(v) => setExplain((e) => (e ? { ...e, view: v } : e))} onClose={() => setExplain(null)} />}
                </div>
                {allowed(mode, 'evalGraph') && review && <div className="panel-graph hide-mobile"><EvalGraph scores={scores} current={onMain ? mainIdx : -1} onSelect={(i) => go(line[i])} marks={line.slice(1).map((id) => byNode.get(id)?.cls)} height={46} /></div>}
                <MoveList moves={moveItems} current={onMain ? mainIdx : -1} onSelect={(n) => go(line[n])} showIcons={allowed(mode, 'classifications')} empty="This game has no moves." />
              </>
            )}
            {tab === 'explore' && (
              <div className="panel-body">
                {!onMain && <MoveCard node={node} live={live} showClass={false} showEngine={allowed(mode, 'engineLines')} onPlayLine={playLine} explore />}
                <ExplorePanel tree={tree} cur={cur} onSelect={go} classOf={classOf} evalOf={evalOf} onChangeTree={commitTree}
                  onDelete={(id) => setDeleteAsk(id)} branchId={bStart} busy={busy} canEngine={!new Chess(node.fen).isGameOver()}
                  onEngineMove={engineMove} onEngineContinue={(n) => void engineContinue(n)}
                  showTheory={allowed(mode, 'openingInfo')} onTheory={addTheory} onPlay={playBranch} />
              </div>
            )}
            {tab === 'summary' && (
              <div className="panel-body">
                {allowed(mode, 'evalGraph') && review && <div className="section"><EvalGraph scores={scores} current={onMain ? mainIdx : -1} onSelect={(i) => go(line[i])} marks={line.slice(1).map((id) => byNode.get(id)?.cls)} /></div>}
                <SummaryPanel review={review} whiteName={whiteName} blackName={blackName} onGoto={(id) => { go(id); setTab('review'); }} />
                <div className="section row show-mobile">
                  <button type="button" className="btn btn-sm" onClick={async () => downloadText(`${gameTitle(game).replace(/\W+/g, '_')}.pgn`, await gamePgn({ ...game, tree }), 'application/x-chess-pgn')}><IconDownload size={16} /> Export PGN</button>
                  {review && (review.status === 'cancelled' || review.status === 'error') && <button type="button" className="btn btn-sm" onClick={() => startReview(game, review)}>Resume analysis</button>}
                </div>
              </div>
            )}

            <div className="panel-foot hide-stacked">
              {replay}
              {tab === 'review' && keyMoments.length > 0 && (
                <div className="moments">
                  <button type="button" className="btn btn-sm btn-quiet" disabled={prevKey === undefined} onClick={() => prevKey !== undefined && go(line[prevKey])} title="Previous key moment (↑)" data-testid="prev-key">Previous key moment</button>
                  <button type="button" className="btn btn-sm btn-quiet" disabled={nextKey === undefined} onClick={() => nextKey !== undefined && go(line[nextKey])} title="Next key moment (↓)" data-testid="next-key">Next key moment</button>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

      <div className="dock" aria-label="Move navigation">{replay}</div>

      <ConfirmDialog open={!!deleteAsk} title="Delete this branch?" danger testId="delete-branch-dialog"
        body={deleteAsk && tree.nodes[deleteAsk] ? `The line starting with ${Math.ceil(tree.nodes[deleteAsk].ply / 2)}${tree.nodes[deleteAsk].ply % 2 ? '.' : '…'} ${tree.nodes[deleteAsk].san} and every move after it will be removed. The original game is not affected.` : undefined}
        confirmLabel="Delete branch" cancelLabel="Keep branch" onCancel={() => setDeleteAsk(null)}
        onConfirm={() => { if (!deleteAsk) return; const p = tree.nodes[deleteAsk].parentId!; commitTree(deleteBranch(tree, deleteAsk)); go(p); setDeleteAsk(null); }} />
      <Dialog open={showKeys} onClose={() => setShowKeys(false)} title="Keyboard shortcuts">
        <table className="compare">
          <tbody>
            {[['← →', 'Previous / next move'], ['Home End', 'First / last position'], ['↑ ↓', 'Previous / next key moment'], ['F', 'Flip the board'], ['Esc', 'Leave a branch and return to the game'], ['?', 'Show this list']].map(([k, v]) => (
              <tr key={k}><td>{k.split(' ').map((x) => <span key={x} className="kbd" style={{ marginRight: 4 }}>{x}</span>)}</td><td>{v}</td></tr>
            ))}
          </tbody>
        </table>
      </Dialog>
    </div>
  );
}
