import { Chess } from 'chess.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Board, TONE_COLOR, type BoardMove } from '../ui/Board';
import { MoveList } from '../ui/MoveList';
import { MoveStrip } from '../ui/MoveStrip';
import { Meter } from '../ui/bits';
import { PlayerStrip, Stage } from '../ui/stage';
import { ClassIcon } from '../ui/ClassIcon';
import { ConfirmDialog } from '../ui/Dialog';
import { IconBulb, IconCoach, IconFlag, IconFlip, IconUndo } from '../ui/icons';
import { useKeys } from '../ui/useKeys';
import { useApp } from '../ui/context';
import { navigate } from '../ui/router';
import { getEngine } from '../engine/instance';
import { AbortedError, type AnalysisResult } from '../engine/controller';
import { pickMove, strengthFor, type Candidate } from '../engine/strength';
import { mulberry32, seedFrom } from '../util/rng';
import { CLASS_INFO, moveAccuracy, type Classification } from '../analysis/classify';
import { analyzeMove } from '../analysis/motifs';
import { classifyLive } from '../coach/live';
import { buildHints, hintAt, type Hint } from '../coach/hints';
import { teachMove, isNotable, type Mark, type Teaching } from '../coach/teach';
import { assessTeachingValue, gradePrediction, type PredictionResult } from '../coach/prediction';
import { focusAreas, isMastered, type LearningProfile } from '../coach/profile';
import { SKILLS, rating, tagSkills, type Skill } from '../coach/skills';
import {
  canRewind, commitCoachMove, commitPending, currentFen, isPlayerTurn, markDemoSeen, proposeMove, recordHint, resignCoach, restoreCoachState,
  rewind, sessionStats, setAttemptEvaluation, startCoachSession, takeBack, updateMoveInfo, type CoachState,
} from '../coach/session';
import { evidenceFromAttempt, finishCoachGame, loadCoachProfile, persistCoachState, saveCoachProfile, savePrediction } from '../services/coach';
import { attemptsForSession, get, getMeta, setMeta } from '../db/db';
import { REASON_TEXT } from '../chess/rules';
import { winPercentPov } from '../engine/score';
import { allowed } from '../modes';
import { openingNote } from '../coach/openingNote';
import { TeachPanel, type TeachView } from './coach/TeachPanel';

type Phase =
  | { k: 'idle' }
  | { k: 'evaluating' }
  | { k: 'feedback' }
  | { k: 'coach-thinking' }
  | { k: 'predict' }
  | { k: 'lesson'; result: PredictionResult };

/** The player's most recent decision and what the Coach has to say about it. */
interface LastMove {
  attemptId: string;
  ply: number;
  uci: string;
  cls: Classification;
  provisional: boolean;
  teaching: Teaching;
  /** awaiting Retry / Continue */
  blocking: boolean;
  /** best achievable win% for the mover in the position before the move */
  winBest: number;
}

const SERIOUS: Classification[] = ['mistake', 'miss', 'blunder'];
/** Is ply `idx` still the same move from the same position? (Take back can replace it.) */
const samePly = (s: CoachState, idx: number, fenBefore: string, uci: string) => s.fens[idx] === fenBefore && s.session.moveInfo[idx]?.uci === uci;
/** Demonstrations exist only where the assistance policy allows them (never in Ranked). */
const gateTeaching = (t: Teaching): Teaching => (allowed('coach', 'demonstrations') ? t : { ...t, why: null, best: null, compare: null });
const toArrows = (m?: Mark) => (m?.arrows ?? []).map(([f, t, tone]) => [f, t, TONE_COLOR[tone]] as [string, string, string]);
const toSquares = (m?: Mark) => (m?.squares ?? []).map(([sq, tone]) => [sq, TONE_COLOR[tone]] as [string, string]);

export function CoachPage() {
  const { prefs } = useApp();
  const [st, setStRaw] = useState<CoachState | null>(null);
  const stRef = useRef<CoachState | null>(null);
  const setSt = (s: CoachState | null) => { stRef.current = s; setStRaw(s); if (s) void persistCoachState(s); };
  const [profile, setProfile] = useState<LearningProfile | null>(null);
  const profRef = useRef<LearningProfile | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const [hintList, setHintList] = useState<{ fen: string; hints: Hint[] } | null>(null);
  const [shownHints, setShownHints] = useState(0);
  const [orientation, setOrientation] = useState<'white' | 'black'>('white');
  const [last, setLast] = useState<LastMove | null>(null);
  const [view, setView] = useState<TeachView>({ k: 'points' });
  const [focus, setFocus] = useState<number | null>(null);
  /** post-move note about the opening (book, leaving or re-entering theory) */
  const [openNote, setOpenNote] = useState<string | null>(null);
  const noteFor = (s: CoachState, idx: number, fenAfter: string, san: string, by: 'you' | 'coach') => {
    if (!allowed('coach', 'openingInfo') || idx > 40) return;
    const n = openingNote([...s.fens.slice(0, idx + 1), fenAfter], [...s.session.moves.slice(0, idx), san], idx, by);
    if (n) setOpenNote(n);
  };
  const [setup, setSetup] = useState({ color: 'w' as 'w' | 'b' | 'random', prediction: true });
  const [finishedGameId, setFinishedGameId] = useState<string | null>(null);
  const [confirmResign, setConfirmResign] = useState(false);
  const [loading, setLoading] = useState(true);
  const posAnalysis = useRef<{ fen: string; p: Promise<AnalysisResult> } | null>(null);
  const winBestByPly = useRef<Map<number, number>>(new Map());
  const predictionCtx = useRef<{ fen: string; analysis: AnalysisResult; category: string; chosen: Candidate } | null>(null);
  const abort = useRef(new AbortController());
  /** bumped by Take back: any engine work started before it is discarded */
  const gen = useRef(0);

  // ---------- load profile / resume ----------
  useEffect(() => {
    (async () => {
      const p = await loadCoachProfile();
      profRef.current = p; setProfile(p);
      const id = await getMeta<string>('activeCoach');
      if (id) {
        const s = await get('coachSessions', id);
        if (s && s.status === 'active') {
          const restored = restoreCoachState(s, await attemptsForSession(id));
          stRef.current = restored; setStRaw(restored);
          setOrientation(s.playerColor === 'w' ? 'white' : 'black');
        }
      }
      setLoading(false);
    })();
    return () => abort.current.abort();
  }, []);

  const updateProfile = async (f: (p: LearningProfile) => LearningProfile) => {
    const p = f(profRef.current ?? (await loadCoachProfile()));
    profRef.current = p; setProfile(p);
    await saveCoachProfile(p);
  };

  // ---------- analysis of the position the player has to solve ----------
  const analysisFor = (fen: string): Promise<AnalysisResult> => {
    if (posAnalysis.current?.fen === fen) return posAnalysis.current.p;
    const p = getEngine().analyze({ fen, depth: prefs.liveDepth, multipv: 3, priority: 1 });
    posAnalysis.current = { fen, p };
    p.catch(() => { if (posAnalysis.current?.p === p) posAnalysis.current = null; });
    return p;
  };

  // drive the Coach when it is its turn
  useEffect(() => {
    if (!st || st.session.status !== 'active' || st.pending) return;
    const fen = currentFen(st);
    if (new Chess(fen).turn() === st.session.playerColor) {
      void analysisFor(fen);
      if (hintList?.fen !== fen) { setHintList(null); setShownHints(0); }
      return;
    }
    if (phase.k === 'idle' || phase.k === 'lesson') void coachTurn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st?.fens.length, st?.pending, st?.session.status]);

  const resetTeaching = () => { setView({ k: 'points' }); setFocus(null); };

  // ---------- start ----------
  const start = async () => {
    const color = setup.color === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : setup.color;
    const p = profRef.current ?? (await loadCoachProfile());
    const s = startCoachSession({ playerColor: color, coachLevel: p.coachLevel, predictionEnabled: setup.prediction && prefs.predictionExercises });
    await setMeta('activeCoach', s.session.id);
    gen.current++;
    winBestByPly.current = new Map();
    setOrientation(color === 'w' ? 'white' : 'black');
    setFinishedGameId(null);
    setPhase({ k: 'idle' });
    setLast(null);
    setOpenNote(null);
    resetTeaching();
    setSt(s);
  };

  // ---------- player move ----------
  const onPlayerMove = (m: BoardMove) => {
    const s = stRef.current;
    if (!s) return false;
    if (phase.k === 'predict') { void submitPrediction(m); return false; }
    if (!isPlayerTurn(s) || (phase.k !== 'idle' && phase.k !== 'lesson')) return false;
    let r;
    try { r = proposeMove(s, m); } catch { return false; }
    setSt(r.state);
    setLast(null);
    resetTeaching();
    setPhase({ k: 'evaluating' });
    void evaluatePlayer(r.state, r.attempt.id);
    return true;
  };

  const liveCtx = (s: CoachState, uci: string) => {
    const idx = s.ucis.length;
    const prevInfo = s.session.moveInfo[idx - 1];
    return { fens: s.fens, ucis: s.ucis, index: idx, uci, prevEpl: prevInfo?.epl ?? undefined, moverWinBefore: winBestByPly.current.has(idx - 1) ? 100 - winBestByPly.current.get(idx - 1)! : undefined };
  };

  const evaluatePlayer = async (s: CoachState, attemptId: string) => {
    const myGen = gen.current;
    const attempt = s.attempts.find((a) => a.id === attemptId)!;
    const idx = s.ucis.length;
    const ctx = liveCtx(s, attempt.uci);
    let res;
    try {
      await analysisFor(s.fens[idx]).catch(() => undefined);
      res = await classifyLive(getEngine(), ctx, prefs.liveDepth, prefs.deepDepth, 2, abort.current.signal);
    } catch (e) {
      if (e instanceof AbortedError || myGen !== gen.current) return;
      const cur = stRef.current!;
      if (cur.pending?.attemptId === attemptId) setSt(commitPending(cur, { cls: null, epl: null, provisional: true, depth: 0 }));
      setPhase({ k: 'idle' });
      return;
    }
    if (myGen !== gen.current || stRef.current?.pending?.attemptId !== attemptId) return;
    const { c, after } = res;
    noteFor(s, idx, res.fenAfter, attempt.san, 'you');
    let cur = setAttemptEvaluation(stRef.current!, attemptId, c);
    setSt(cur);
    const teaching = gateTeaching(teachMove({ fenBefore: attempt.fen, uci: attempt.uci, c, cls: c.cls, afterPv: after.lines[0]?.pv ?? [], ply: idx }));
    const p = profRef.current;
    const skills: Skill[] = tagSkills({ fenBefore: attempt.fen, uci: attempt.uci, bestUci: c.bestUci, epl: c.epl, ply: idx + 1, winBest: c.winBest, replyUci: after.lines[0]?.pv[0] });
    const mastered = !!p && skills.length > 0 && skills.every((sk) => isMastered(p, sk));
    if (SERIOUS.includes(c.cls) || (c.cls === 'inaccuracy' && !mastered)) {
      setLast({ attemptId, ply: idx, uci: attempt.uci, cls: c.cls, provisional: c.provisional, teaching, blocking: true, winBest: c.winBest });
      setPhase({ k: 'feedback' });
      void refineAttempt(attemptId, ctx);
      return;
    }
    winBestByPly.current.set(idx, c.winBest);
    // non-blocking notes: a mastered inaccuracy, or a genuinely notable good move
    if (c.cls === 'inaccuracy' || isNotable(teaching, c.cls)) setLast({ attemptId, ply: idx, uci: attempt.uci, cls: c.cls, provisional: c.provisional, teaching, blocking: false, winBest: c.winBest });
    cur = commitPending(cur, { cls: c.cls, epl: c.epl, provisional: c.provisional, depth: c.depth });
    setSt(cur);
    void refineAttempt(attemptId, ctx, idx);
    setPhase({ k: 'idle' });
    if (cur.session.status === 'finished') await endGame(cur);
  };

  /** Deeper analysis of a decision: updates its rating, the note about it, and the learning profile once. */
  const refineAttempt = async (attemptId: string, ctx: Parameters<typeof classifyLive>[1], committedPly?: number) => {
    try {
      const r = await classifyLive(getEngine(), ctx, prefs.deepDepth, prefs.deepDepth, 0);
      const s = stRef.current;
      if (!s) return;
      let next = setAttemptEvaluation(s, attemptId, r.c);
      const ply = committedPly ?? next.attempts.find((a) => a.id === attemptId && a.final)?.ply;
      if (ply !== undefined && samePly(next, ply, ctx.fens[ctx.index], ctx.uci)) next = updateMoveInfo(next, ply, { cls: r.c.cls, epl: r.c.epl, provisional: false, depth: r.c.depth });
      setSt(next);
      const a = next.attempts.find((x) => x.id === attemptId)!;
      setLast((l) => {
        if (!l || l.attemptId !== attemptId) return l;
        const teaching = gateTeaching(teachMove({ fenBefore: a.fen, uci: a.uci, c: r.c, cls: r.c.cls, afterPv: r.after.lines[0]?.pv ?? [], ply: ctx.index }));
        return { ...l, cls: r.c.cls, provisional: false, teaching, winBest: r.c.winBest };
      });
      const errorMotifs = r.c.epl >= 10 ? r.c.motifs.filter((m) => ['hanging-left', 'defender-removed', 'threat-ignored', 'king-exposure'].includes(m.kind)).map((m) => m.kind) : [];
      await updateProfile((p) => evidenceFromAttempt(p, a, r.c.bestUci, r.c.winBest, r.after.lines[0]?.pv[0], errorMotifs));
    } catch { /* background refinement is best effort */ }
  };

  // ---------- Retry / Take back / Continue ----------
  const cancelWork = () => {
    gen.current++;
    abort.current.abort();
    abort.current = new AbortController();
    predictionCtx.current = null;
  };

  /** Undo the last decision: a pending move, or the last played move together with the Coach's reply. Unlimited. */
  const doTakeBack = async () => {
    const s = stRef.current;
    if (!s || !canRewind(s)) return;
    cancelWork();
    const wasOver = s.session.status === 'finished';
    const next = s.pending ? takeBack(s) : rewind(s);
    for (const k of [...winBestByPly.current.keys()]) if (k >= next.ucis.length) winBestByPly.current.delete(k);
    setSt(next);
    setPhase({ k: 'idle' });
    setLast(null);
    setOpenNote(null);
    resetTeaching();
    if (wasOver) await setMeta('activeCoach', next.session.id);
  };

  const doContinue = async () => {
    const s = stRef.current;
    if (!s?.pending) return;
    const a = s.attempts.find((x) => x.id === s.pending!.attemptId)!;
    const next = commitPending(s, { cls: a.cls, epl: a.epl, provisional: a.provisional, depth: 0 });
    if (last?.attemptId === a.id) winBestByPly.current.set(next.ucis.length - 1, last.winBest);
    setSt(next);
    setPhase({ k: 'idle' });
    setLast((l) => (l ? { ...l, blocking: false } : l));
    resetTeaching();
    if (next.session.status === 'finished') await endGame(next);
  };

  // ---------- demonstrations ----------
  const seeDemo = () => { const s = stRef.current; if (s && last) setSt(markDemoSeen(s, last.attemptId)); };
  const showWhy = () => { if (!last?.teaching.why) return; seeDemo(); setFocus(null); setView({ k: 'demo', line: last.teaching.why, step: 0, playing: true }); };
  const showBest = () => { if (!last?.teaching.best) return; seeDemo(); setFocus(null); setView({ k: 'demo', line: last.teaching.best, step: 0, playing: true }); };
  const showCompare = () => { if (!last?.teaching.compare) return; seeDemo(); setFocus(null); setView({ k: 'compare', cmp: last.teaching.compare }); };
  const stepTo = (n: number) => setView((v) => (v.k === 'demo' ? { ...v, step: Math.max(0, Math.min(v.line.steps.length, n)), playing: false } : v));
  useEffect(() => {
    if (view.k !== 'demo' || !view.playing) return;
    if (view.step >= view.line.steps.length) { setView({ ...view, playing: false }); return; }
    const t = setTimeout(() => setView((v) => (v.k === 'demo' && v.playing ? { ...v, step: v.step + 1 } : v)), view.step === 0 ? 700 : 1100);
    return () => clearTimeout(t);
  }, [view]);
  useEffect(() => { if (view.k !== 'points' && window.innerWidth <= 760) window.scrollTo({ top: 0 }); }, [view.k]);

  // ---------- coach move ----------
  const coachTurn = async () => {
    const s = stRef.current;
    if (!s || s.session.status !== 'active' || s.pending) return;
    const myGen = gen.current;
    const fen = currentFen(s);
    setPhase({ k: 'coach-thinking' });
    try {
      const prof = strengthFor(s.session.coachLevel);
      const focusSkills = new Set((profRef.current ? focusAreas(profRef.current, 3) : []).map((f) => f.skill));
      const rand = mulberry32(seedFrom(s.session.seed, s.ucis.length));
      const { move, analysis } = await pickMove(getEngine(), fen, { ...prof, multipv: Math.max(prof.multipv, 3) }, rand, (cands) => cands.map((c) => {
        // Teaching bias: create the situations the player needs to practise (only among acceptable moves).
        if (!focusSkills.has('hanging') && !focusSkills.has('anticipation') && !focusSkills.has('tactics')) return c;
        try {
          const k = analyzeMove(fen, c.uci).motifs.map((x) => x.kind);
          return k.some((x) => ['fork', 'pin', 'skewer', 'wins-hanging', 'mate-threat', 'discovered-attack'].includes(x)) ? { ...c, bonus: c.bonus + 0.4 } : c;
        } catch { return c; }
      }), abort.current.signal);
      if (myGen !== gen.current || currentFen(stRef.current!) !== fen) return;
      const cur = stRef.current!;
      const assess = assessTeachingValue({
        fen, ply: cur.ucis.length, analysis, lastMoveUci: cur.ucis[cur.ucis.length - 1], pliesSinceLastExercise: cur.ucis.length - cur.session.lastExercisePly,
        history: profRef.current?.predictions ?? {}, enabled: cur.session.predictionEnabled && allowed('coach', 'prediction'),
      });
      if (assess.ask && assess.category) {
        predictionCtx.current = { fen, analysis, category: assess.category, chosen: move };
        setSt({ ...cur, session: { ...cur.session, lastExercisePly: cur.ucis.length } });
        setPhase({ k: 'predict' });
        return;
      }
      await playCoachMove(move.uci);
    } catch (e) {
      if (!(e instanceof AbortedError) && myGen === gen.current) setPhase({ k: 'idle' });
    }
  };

  const playCoachMove = async (uci: string) => {
    const s = stRef.current!;
    const idx = s.ucis.length;
    const ctx = liveCtx(s, uci);
    const next = commitCoachMove(s, uci, { cls: null, epl: null, provisional: true, depth: 0 });
    noteFor(s, idx, next.fens[next.fens.length - 1], next.session.moves[next.session.moves.length - 1], 'coach');
    setSt(next);
    setPhase({ k: 'idle' });
    // the Coach's own moves are rated too – it is not always "Best"
    void (async () => {
      try {
        const q = await classifyLive(getEngine(), ctx, prefs.liveDepth, prefs.deepDepth, 1);
        winBestByPly.current.set(idx, q.c.winBest);
        let cur = stRef.current!;
        if (samePly(cur, idx, ctx.fens[idx], uci)) { cur = updateMoveInfo(cur, idx, { cls: q.c.cls, epl: q.c.epl, provisional: q.c.provisional, depth: q.c.depth }); setSt(cur); }
        const d = await classifyLive(getEngine(), ctx, prefs.deepDepth, prefs.deepDepth, 0);
        cur = stRef.current!;
        if (samePly(cur, idx, ctx.fens[idx], uci)) setSt(updateMoveInfo(cur, idx, { cls: d.c.cls, epl: d.c.epl, provisional: false, depth: d.c.depth }));
      } catch { /* best effort */ }
    })();
    if (next.session.status === 'finished') await endGame(next);
  };

  // ---------- prediction ----------
  const submitPrediction = async (m: BoardMove | null) => {
    const pc = predictionCtx.current;
    const s = stRef.current;
    if (!pc || !s) return;
    const myGen = gen.current;
    let predictedUci: string | null = null;
    if (m) {
      try { const mv = new Chess(pc.fen).move(m); predictedUci = mv.from + mv.to + (mv.promotion ?? ''); } catch { return; }
    }
    setPhase({ k: 'coach-thinking' });
    let predictedWin: number | undefined;
    if (predictedUci && !pc.analysis.lines.some((l) => l.pv[0] === predictedUci)) {
      try {
        const r = await getEngine().analyze({ fen: pc.fen, depth: prefs.liveDepth, multipv: 1, searchmoves: [predictedUci], priority: 2 });
        if (r.lines[0]) predictedWin = winPercentPov(r.lines[0].score, new Chess(pc.fen).turn());
      } catch { /* ignore */ }
    }
    if (myGen !== gen.current) return;
    const result = gradePrediction(pc.fen, predictedUci, pc.chosen.uci, pc.analysis, predictedWin);
    await savePrediction({ sessionId: s.session.id, ply: s.ucis.length, fen: pc.fen, category: pc.category, predictedUci, actualUci: pc.chosen.uci, grade: result.grade }, result.outcome);
    profRef.current = await loadCoachProfile(); setProfile(profRef.current);
    predictionCtx.current = null;
    await playCoachMove(pc.chosen.uci);
    setPhase({ k: 'lesson', result });
  };

  // ---------- hints (unlimited) ----------
  const requestHint = async () => {
    const s = stRef.current;
    if (!s || !isPlayerTurn(s)) return;
    const fen = currentFen(s);
    let list = hintList?.fen === fen ? hintList.hints : null;
    if (!list) {
      const a = await analysisFor(fen);
      const lastUci = s.ucis[s.ucis.length - 1];
      const lastMove = lastUci ? { san: s.session.moves[s.session.moves.length - 1], from: lastUci.slice(0, 2), to: lastUci.slice(2, 4) } : undefined;
      list = buildHints(fen, a, { lastMove, ply: s.ucis.length });
      setHintList({ fen, hints: list });
    }
    if (currentFen(stRef.current!) !== fen) return;
    setSt(recordHint(stRef.current!));
    setShownHints((n) => n + 1);
  };

  // ---------- end ----------
  const endGame = async (s: CoachState) => {
    const accs = s.attempts.filter((a) => a.independent && a.epl !== null).map((a) => moveAccuracy(a.epl!));
    const acc = accs.length ? accs.reduce((x, y) => x + y, 0) / accs.length : null;
    const gid = await finishCoachGame(s, acc);
    await setMeta('activeCoach', null);
    const cur = stRef.current;
    if (cur && cur.session.id === s.session.id) setSt({ ...cur, session: { ...cur.session, gameId: gid, profileApplied: true } });
    profRef.current = await loadCoachProfile(); setProfile(profRef.current);
    setFinishedGameId(gid);
  };

  const resign = async () => {
    const s = stRef.current;
    if (!s) return;
    setConfirmResign(false);
    cancelWork();
    const r = resignCoach(s);
    setSt(r);
    setPhase({ k: 'idle' });
    setLast(null);
    resetTeaching();
    await endGame(r);
  };

  const hintsShown = useMemo(() => (hintList ? Array.from({ length: shownHints }, (_, i) => hintAt(hintList.hints, i)) : []), [hintList, shownHints]);

  useKeys(view.k === 'demo' ? {
    ArrowLeft: () => stepTo(view.step - 1), ArrowRight: () => stepTo(view.step + 1), Escape: () => resetTeaching(),
  } : view.k === 'compare' ? { Escape: () => resetTeaching() } : {
    h: () => { void requestHint(); },
    f: () => setOrientation((o) => (o === 'white' ? 'black' : 'white')),
    Backspace: () => { void doTakeBack(); },
    u: () => { void doTakeBack(); },
  }, !!st);

  if (loading) return <div className="page"><div className="empty">Loading…</div></div>;

  // ---------- setup screen ----------
  if (!st) {
    return (
      <div className="page page-narrow">
        <header className="page-head">
          <div>
            <h1>Coach</h1>
            <div className="lede">A real game against an opponent that wants you to improve. Every move is rated as you play. Mistakes come with a concrete explanation, a demonstration on the board and the better move if you ask for it. Take back any move, as often as you like; hints point at what to look for, never the move itself.</div>
          </div>
        </header>
        <div className="grid-2" style={{ alignItems: 'start' }}>
          <section className="surface surface-pad stack" aria-labelledby="coach-setup">
            <h2 id="coach-setup">New game</h2>
            <div className="field">
              <span className="field-label">Play as</span>
              <div className="seg" role="group" aria-label="Your colour">
                {(['w', 'b', 'random'] as const).map((c) => <button key={c} type="button" aria-pressed={setup.color === c} onClick={() => setSetup({ ...setup, color: c })}>{c === 'w' ? 'White' : c === 'b' ? 'Black' : 'Random'}</button>)}
              </div>
            </div>
            <label className="check">
              <input type="checkbox" checked={setup.prediction} onChange={(e) => setSetup({ ...setup, prediction: e.target.checked })} />
              <span className="check-text">Predict the Opponent<small>At important moments the Coach asks what you expect it to play. Always skippable.</small></span>
            </label>
            <p className="small faint" style={{ margin: 0 }}>The Coach plays at level {profile?.coachLevel ?? 6} of 20, adjusted after each game from your independent results.</p>
            <div><button type="button" className="btn btn-primary btn-lg" onClick={start} data-testid="start-coach">Start Coach game</button></div>
          </section>
          {profile && <ProfileMini profile={profile} />}
        </div>
      </div>
    );
  }

  // ---------- board state (game, demonstration, comparison or a highlighted point) ----------
  const gameFen = st.pending ? st.pending.fenAfter : currentFen(st);
  let boardFen = gameFen;
  let arrows: [string, string, string][] = [];
  let highlights: [string, string][] = [];
  let lastMove: [string, string] | null = null;
  const lastUci = st.pending ? st.pending.uci : st.ucis[st.ucis.length - 1];
  if (lastUci) lastMove = [lastUci.slice(0, 2), lastUci.slice(2, 4)];
  let frame: 'normal' | 'predict' | 'demo' = phase.k === 'predict' ? 'predict' : 'normal';
  if (view.k === 'demo') {
    const stp = view.step > 0 ? view.line.steps[view.step - 1] : null;
    boardFen = stp ? stp.fen : view.line.startFen;
    const mark = stp ? stp.mark : view.line.startMark;
    arrows = toArrows(mark); highlights = toSquares(mark);
    lastMove = null;
    frame = 'demo';
  } else if (view.k === 'compare') {
    boardFen = view.cmp.startFen;
    arrows = [[view.cmp.played.uci.slice(0, 2), view.cmp.played.uci.slice(2, 4), TONE_COLOR.concept], [view.cmp.best.uci.slice(0, 2), view.cmp.best.uci.slice(2, 4), TONE_COLOR.better]];
    lastMove = null;
    frame = 'demo';
  } else if (last && focus !== null && last.teaching.points[focus]?.mark) {
    const mark = last.teaching.points[focus].mark;
    boardFen = last.teaching.fenAfter;
    arrows = toArrows(mark); highlights = toSquares(mark);
    lastMove = [last.teaching.from, last.teaching.to];
  }
  const teachingOnBoard = boardFen !== gameFen || view.k !== 'points';

  const player = st.session.playerColor;
  const coachColor = player === 'w' ? 'b' : 'w';
  const over = st.session.status === 'finished';
  const movable = teachingOnBoard ? 'none' : phase.k === 'predict' ? coachColor : isPlayerTurn(st) && (phase.k === 'idle' || phase.k === 'lesson') ? player : 'none';
  const stats = sessionStats(st);
  const pendingAttempt = st.pending ? st.attempts.find((a) => a.id === st.pending!.attemptId) : undefined;
  const moves = [
    ...st.session.moveInfo.map((m) => ({ san: m.san, cls: m.cls, provisional: m.provisional, pending: m.cls === null, title: `${m.by === 'player' ? 'You' : 'Coach'}${m.assisted ? ', after a retry or hint' : ''}` })),
    ...(st.pending ? [{ san: st.pending.san, cls: pendingAttempt?.cls ?? null, provisional: true, pending: !pendingAttempt?.cls }] : []),
  ];
  const top = orientation === 'white' ? 'b' : 'w';
  const names = { [player]: 'You', [coachColor]: `Coach, level ${st.session.coachLevel}` } as Record<'w' | 'b', string>;
  const turn = new Chess(boardFen).turn();
  const canHint = isPlayerTurn(st) && (phase.k === 'idle' || phase.k === 'lesson');
  const hintTitle = over ? 'The game is over. Take back a move to keep playing.' : !isPlayerTurn(st) ? 'Hints are for your own move' : 'Get a hint (H)';
  const canBack = canRewind(st);
  const backTitle = !canRewind(st) ? 'You have not made a move yet' : 'Take back your last move (Backspace). Unlimited.';

  const status = view.k === 'demo' ? { cls: '', text: 'Demonstration: the game is paused' }
    : view.k === 'compare' ? { cls: '', text: 'Comparing your move with the best move' }
    : over ? { cls: '', text: `Game over: ${st.session.result}${st.session.reason ? `, ${REASON_TEXT[st.session.reason].toLowerCase()}` : ''}` }
    : phase.k === 'evaluating' ? { cls: 'is-wait', text: 'Rating your move…' }
    : phase.k === 'coach-thinking' ? { cls: 'is-wait', text: 'The Coach is thinking…' }
    : phase.k === 'predict' ? { cls: 'is-predict', text: 'Predict the Coach’s reply' }
    : phase.k === 'feedback' ? { cls: '', text: 'Look at what happened, then retry or continue' }
    : isPlayerTurn(st) ? { cls: '', text: 'Your move' } : { cls: 'is-wait', text: 'Waiting…' };

  return (
    <div className="page">
      <header className="page-head" style={{ marginBottom: 'var(--s-4)' }}>
        <div>
          <h1>Coach game</h1>
          <div className="lede small">You have {player === 'w' ? 'White' : 'Black'}. {st.session.predictionEnabled ? 'Prediction exercises are on.' : 'Prediction exercises are off.'}</div>
        </div>
      </header>
      {phase.k === 'predict' && <div className="coach-banner show-mobile" role="status"><b>Predict the Coach’s reply:</b> move one of its pieces. <button type="button" className="btn btn-sm" onClick={() => submitPrediction(null)}>Skip</button></div>}
      <div className="board-layout">
        <Stage orientation={orientation}
          top={<PlayerStrip name={names[top]} color={top} fen={boardFen} isTurn={!over && !teachingOnBoard && turn === top} />}
          bottom={<PlayerStrip name={names[top === 'w' ? 'b' : 'w']} color={top === 'w' ? 'b' : 'w'} fen={boardFen} isTurn={!over && !teachingOnBoard && turn !== top} />}
          below={<div className="row board-tools hide-mobile"><button type="button" className="btn btn-sm btn-quiet" onClick={() => setOrientation(orientation === 'white' ? 'black' : 'white')} title="Flip board (F)"><IconFlip size={16} /> Flip</button></div>}>
          {(size) => <Board fen={boardFen} orientation={orientation} size={size} movable={over ? 'none' : movable} onMove={onPlayerMove} lastMove={lastMove} arrows={arrows} highlights={highlights} frame={frame} id="coach-board" />}
        </Stage>
        <div className="panel-slot">
          <section className="panel" aria-label="Lesson">
            <div className={`status-line ${status.cls}`} role="status" aria-live="polite" data-testid="coach-status">
              <span className="status-dot" />
              <span>{status.text}</span>
            </div>
            <div className="panel-body">
              {over && (
                <div className="feedback tone-good" data-testid="coach-over">
                  <div className="feedback-head"><h2>Game over: {st.session.result}</h2></div>
                  <p className="small">Independent decisions (first tries at a position, without hints): {stats.independentDecisions}, approximate accuracy {stats.independentEpl === null ? '–' : moveAccuracy(stats.independentEpl).toFixed(0)}. Takebacks: {stats.takebacks}, hints: {stats.hints}.</p>
                  <div className="row">
                    {finishedGameId ? <button type="button" className="btn btn-primary" onClick={() => navigate(`review/${finishedGameId}`)}>Review this game</button> : <span className="small faint">Saving…</span>}
                    <button type="button" className="btn" onClick={() => void doTakeBack()} disabled={!canRewind(st)}>Take back the last move</button>
                    <button type="button" className="btn" onClick={start}>New Coach game</button>
                  </div>
                </div>
              )}
              {last && (phase.k === 'feedback' || !last.blocking) && (
                <TeachPanel teaching={last.teaching} cls={last.cls} provisional={last.provisional} blocking={phase.k === 'feedback' && last.blocking}
                  view={view} focus={focus} onFocus={setFocus} onShowWhy={showWhy} onBest={showBest} onCompare={showCompare}
                  onRetry={() => void doTakeBack()} onContinue={doContinue} onDismiss={() => { setLast(null); resetTeaching(); }}
                  onStep={stepTo} onTogglePlay={() => setView((v) => (v.k === 'demo' ? { ...v, playing: !v.playing, step: !v.playing && v.step >= v.line.steps.length ? 0 : v.step } : v))}
                  onReturn={resetTeaching} />
              )}
              {phase.k === 'predict' && (
                <div className="feedback tone-predict" data-testid="prediction">
                  <div className="feedback-head"><IconCoach /><h2>Predict the Coach’s reply</h2></div>
                  <p className="small" style={{ marginBottom: 'var(--s-3)' }}>This is an important moment. Move one of the Coach’s pieces to show what you expect it to play.</p>
                  <button type="button" className="btn btn-sm" onClick={() => submitPrediction(null)} data-testid="skip-prediction">Skip this exercise</button>
                </div>
              )}
              {phase.k === 'lesson' && (
                <div className={`feedback sheet-mobile tone-${phase.result.outcome >= 1 ? 'good' : phase.result.outcome > 0 ? 'info' : 'warn'}`} data-testid="lesson">
                  <div className="feedback-head"><IconCoach /><h2>{phase.result.grade === 'skipped' ? 'Exercise skipped' : phase.result.grade === 'exact' ? 'Exactly right' : phase.result.grade === 'strong' ? 'Good prediction' : phase.result.grade === 'reasonable' ? 'Close' : 'Not quite'}</h2></div>
                  <p className="small">{phase.result.predictedSan ? <>You expected <b>{phase.result.predictedSan}</b>. </> : null}The Coach played <b>{phase.result.actualSan}</b>.</p>
                  <ul className="small">{phase.result.lesson.map((l, i) => <li key={i}>{l}</li>)}</ul>
                  <button type="button" className="btn btn-sm" onClick={() => setPhase({ k: 'idle' })}>Got it</button>
                </div>
              )}
              {shownHints > 0 && isPlayerTurn(st) && (
                <div className="section" data-testid="hints" aria-live="polite">
                  <h3 className="section-title">Hints for this move</h3>
                  <ol className="hint-list">{hintsShown.map((h, i) => <li key={i}>{h.kind !== 'position' && <span className="hint-kind">{h.kind === 'technique' ? 'Technique' : 'Review'}</span>}{h.text}</li>)}</ol>
                </div>
              )}
              {openNote && view.k === 'points' && <p className="xs dim section" style={{ margin: 0 }} data-testid="coach-opening-note">{openNote}</p>}
              <MoveStrip moves={moves} current={moves.length} showIcons />
              <MoveList moves={moves} current={moves.length} showIcons empty="The game starts when you or the Coach make the first move." style={{ maxHeight: 240 }} />
              <details className="disclose section hide-mobile" style={{ paddingTop: 'var(--s-2)', paddingBottom: 'var(--s-2)' }}>
                <summary>This game and your learning profile</summary>
                <div className="stats" style={{ margin: 'var(--s-3) 0' }}>
                  <div className="stat"><b>{stats.independentDecisions}</b><span>independent decisions</span></div>
                  <div className="stat"><b>{stats.takebacks}</b><span>takebacks</span></div>
                  <div className="stat"><b>{stats.correctedAfterTakeback}</b><span>corrected after a retry</span></div>
                </div>
                {profile && <ProfileMini profile={profile} bare />}
              </details>
            </div>
            <div className="panel-foot hide-stacked">
              <div className="row-nowrap">
                <button type="button" className="btn" onClick={requestHint} disabled={!canHint} title={hintTitle} data-testid="hint"><IconBulb size={18} /> Hint{shownHints > 0 && <span className="faint small">{shownHints} used</span>}</button>
                <button type="button" className="btn" onClick={() => void doTakeBack()} disabled={!canBack} title={backTitle} data-testid="takeback"><IconUndo size={18} /> Take back</button>
                <span className="spacer" />
                {!over && <button type="button" className="btn btn-icon btn-danger" onClick={() => setConfirmResign(true)} aria-label="Resign" title="Resign this game"><IconFlag size={18} /></button>}
              </div>
            </div>
          </section>
        </div>
      </div>
      <div className="dock">
        <button type="button" className="btn btn-lg" style={{ flex: 1 }} onClick={requestHint} disabled={!canHint} title={hintTitle} data-testid="hint-mobile"><IconBulb size={18} /> Hint</button>
        <button type="button" className="btn btn-lg" style={{ flex: 1 }} onClick={() => void doTakeBack()} disabled={!canBack} title={backTitle} data-testid="takeback-mobile"><IconUndo size={18} /> Take back</button>
        <button type="button" className="btn btn-lg btn-icon" onClick={() => setOrientation(orientation === 'white' ? 'black' : 'white')} aria-label="Flip board"><IconFlip /></button>
        {!over && <button type="button" className="btn btn-lg btn-icon btn-danger" onClick={() => setConfirmResign(true)} aria-label="Resign"><IconFlag /></button>}
      </div>
      <ConfirmDialog open={confirmResign} title="Resign this Coach game?" body="The game is saved and you can review it afterwards. You can still take back moves to continue it." danger confirmLabel="Resign game" cancelLabel="Keep playing" onCancel={() => setConfirmResign(false)} onConfirm={resign} />
    </div>
  );
}

function ProfileMini({ profile, bare }: { profile: LearningProfile; bare?: boolean }) {
  const focus = focusAreas(profile, 3);
  const label = (s: Skill) => SKILLS.find((x) => x.id === s)?.label ?? s;
  const body = focus.length === 0 ? (
    <p className="small dim" style={{ margin: 0 }}>Not enough independent decisions yet to say anything reliable ({profile.movesIndependent} so far). The profile fills in as you play.</p>
  ) : (
    <div className="stack" style={{ gap: 'var(--s-3)' }}>
      <p className="small dim" style={{ margin: 0 }}>Skills to practise, weakest first:</p>
      {focus.map((f) => {
        const r = rating(profile.independent[f.skill]);
        return (
          <div key={f.skill}>
            <div className="row-nowrap small" style={{ marginBottom: 4 }}><span>{label(f.skill)}</span><span className="spacer" /><span className="faint num">{(r.mean * 100).toFixed(0)}%, {r.confidence} confidence</span></div>
            <Meter value={r.mean} lo={Math.max(0, r.mean - r.halfWidth)} hi={Math.min(1, r.mean + r.halfWidth)} />
          </div>
        );
      })}
      <a href="#/profile" className="small">Open your full learning profile</a>
    </div>
  );
  if (bare) return <div data-testid="learning-mini">{body}</div>;
  return (
    <section className="surface surface-pad stack" data-testid="learning-mini" aria-labelledby="coach-learned">
      <h2 id="coach-learned">What the Coach has learned</h2>
      {body}
    </section>
  );
}

export { CLASS_INFO, ClassIcon };
