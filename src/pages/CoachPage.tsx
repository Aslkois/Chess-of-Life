import { Chess } from 'chess.js';
import { useEffect, useRef, useState } from 'react';
import { Board, type BoardMove } from '../ui/Board';
import { MoveList } from '../ui/MoveList';
import { MoveStrip } from '../ui/MoveStrip';
import { Meter } from '../ui/bits';
import { PlayerStrip, Stage } from '../ui/stage';
import { ClassIcon } from '../ui/ClassIcon';
import { ConfirmDialog } from '../ui/Dialog';
import { IconBulb, IconCoach, IconFlag, IconFlip } from '../ui/icons';
import { useKeys } from '../ui/useKeys';
import { useApp } from '../ui/context';
import { navigate } from '../ui/router';
import { getEngine } from '../engine/instance';
import { AbortedError, type AnalysisResult } from '../engine/controller';
import { pickMove, strengthFor, type Candidate } from '../engine/strength';
import { mulberry32, seedFrom } from '../util/rng';
import { CLASS_INFO, moveAccuracy, type Classification } from '../analysis/classify';
import { coachFeedback, type CoachFeedback } from '../analysis/explain';
import { analyzeMove } from '../analysis/motifs';
import { classifyLive } from '../coach/live';
import { buildHints, MAX_HINT_LEVEL, type Hint } from '../coach/hints';
import { assessTeachingValue, gradePrediction, type PredictionResult } from '../coach/prediction';
import { focusAreas, isMastered, type LearningProfile } from '../coach/profile';
import { SKILLS, rating, tagSkills, type Skill } from '../coach/skills';
import {
  commitCoachMove, commitPending, currentFen, isPlayerTurn, proposeMove, resignCoach, restoreCoachState, sessionStats,
  setAttemptEvaluation, startCoachSession, takeBack, updateMoveInfo, recordHint, type CoachState,
} from '../coach/session';
import { evidenceFromAttempt, finishCoachGame, loadCoachProfile, persistCoachState, saveCoachProfile, savePrediction } from '../services/coach';
import { attemptsForSession, get, getMeta, setMeta } from '../db/db';
import { REASON_TEXT } from '../chess/rules';
import { winPercentPov } from '../engine/score';
import { allowed } from '../modes';

type Phase =
  | { k: 'idle' }
  | { k: 'evaluating' }
  | { k: 'feedback'; fb: CoachFeedback; cls: Classification }
  | { k: 'coach-thinking' }
  | { k: 'predict' }
  | { k: 'lesson'; result: PredictionResult };

const SERIOUS: Classification[] = ['mistake', 'miss', 'blunder'];

export function CoachPage() {
  const { prefs } = useApp();
  const [st, setStRaw] = useState<CoachState | null>(null);
  const stRef = useRef<CoachState | null>(null);
  const setSt = (s: CoachState | null) => { stRef.current = s; setStRaw(s); if (s) void persistCoachState(s); };
  const [profile, setProfile] = useState<LearningProfile | null>(null);
  const profRef = useRef<LearningProfile | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const [hints, setHints] = useState<Hint[]>([]);
  const [shownHints, setShownHints] = useState(0);
  const [orientation, setOrientation] = useState<'white' | 'black'>('white');
  const [positive, setPositive] = useState<{ san: string; cls: Classification } | null>(null);
  const [setup, setSetup] = useState({ color: 'w' as 'w' | 'b' | 'random', prediction: true });
  const [finishedGameId, setFinishedGameId] = useState<string | null>(null);
  const [confirmResign, setConfirmResign] = useState(false);
  const [loading, setLoading] = useState(true);
  const posAnalysis = useRef<{ fen: string; p: Promise<AnalysisResult> } | null>(null);
  const winBestByPly = useRef<Map<number, number>>(new Map());
  const predictionCtx = useRef<{ fen: string; analysis: AnalysisResult; category: string; chosen: Candidate } | null>(null);
  const abort = useRef(new AbortController());

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
    const ac = abort.current;
    return () => ac.abort();
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
    const turn = new Chess(fen).turn();
    if (turn === st.session.playerColor) {
      void analysisFor(fen); // pre-compute for hints & feedback
      setHints([]); setShownHints(0);
      return;
    }
    if (phase.k === 'idle') void coachTurn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st?.fens.length, st?.pending, st?.session.status]);

  // ---------- start ----------
  const start = async () => {
    const color = setup.color === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : setup.color;
    const p = profRef.current ?? (await loadCoachProfile());
    const s = startCoachSession({ playerColor: color, coachLevel: p.coachLevel, predictionEnabled: setup.prediction && prefs.predictionExercises });
    await setMeta('activeCoach', s.session.id);
    winBestByPly.current = new Map();
    setOrientation(color === 'w' ? 'white' : 'black');
    setFinishedGameId(null);
    setPhase({ k: 'idle' });
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
    setPositive(null);
    setPhase({ k: 'evaluating' });
    void evaluatePlayer(r.state, r.attempt.id);
    return true;
  };

  const evaluatePlayer = async (s: CoachState, attemptId: string) => {
    const attempt = s.attempts.find((a) => a.id === attemptId)!;
    const idx = s.ucis.length;
    const prevInfo = s.session.moveInfo[idx - 1];
    const ctx = { fens: s.fens, ucis: s.ucis, index: idx, uci: attempt.uci, prevEpl: prevInfo?.epl ?? undefined, moverWinBefore: winBestByPly.current.has(idx - 1) ? 100 - winBestByPly.current.get(idx - 1)! : undefined };
    let res;
    try {
      await analysisFor(s.fens[idx]).catch(() => undefined);
      res = await classifyLive(getEngine(), ctx, prefs.liveDepth, prefs.deepDepth, 2, abort.current.signal);
    } catch (e) {
      if (e instanceof AbortedError) return;
      // engine failure: let the player continue without a rating
      const cur = stRef.current!;
      setSt(commitPending(cur, { cls: null, epl: null, provisional: true, depth: 0 }));
      setPhase({ k: 'idle' });
      return;
    }
    const { c, after } = res;
    let cur = setAttemptEvaluation(stRef.current!, attemptId, c);
    setSt(cur);
    const p = profRef.current;
    const skills: Skill[] = tagSkills({ fenBefore: attempt.fen, uci: attempt.uci, bestUci: c.bestUci, epl: c.epl, ply: idx + 1, winBest: c.winBest, replyUci: after.lines[0]?.pv[0] });
    const mastered = !!p && skills.length > 0 && skills.every((sk) => isMastered(p, sk));
    const serious = SERIOUS.includes(c.cls);
    if (serious || (c.cls === 'inaccuracy' && !mastered)) {
      const fb = coachFeedback(attempt.fen, attempt.uci, cur.session.playerColor, c, c.cls, after.lines[0]?.pv ?? []);
      setPhase({ k: 'feedback', fb, cls: c.cls });
      // deep refinement + evidence happen in the background; the decision stays with the player
      void refineAttempt(attemptId, ctx);
      return;
    }
    winBestByPly.current.set(idx, c.winBest);
    if (c.cls === 'brilliant' || c.cls === 'great' || c.cls === 'best') setPositive({ san: attempt.san, cls: c.cls });
    cur = commitPending(cur, { cls: c.cls, epl: c.epl, provisional: c.provisional, depth: c.depth });
    setSt(cur);
    void refineAttempt(attemptId, ctx, idx);
    setPhase({ k: 'idle' });
    await afterCommit(cur);
  };

  /** Deeper analysis of a decision; updates its rating and feeds the learning profile once. */
  const refineAttempt = async (attemptId: string, ctx: Parameters<typeof classifyLive>[1], committedPly?: number) => {
    try {
      const r = await classifyLive(getEngine(), ctx, prefs.deepDepth, prefs.deepDepth, 0);
      const s = stRef.current;
      if (!s) return;
      let next = setAttemptEvaluation(s, attemptId, r.c);
      const ply = committedPly ?? next.attempts.find((a) => a.id === attemptId && a.final)?.ply;
      if (ply !== undefined && next.session.moveInfo[ply]?.uci === ctx.uci) next = updateMoveInfo(next, ply, { cls: r.c.cls, epl: r.c.epl, provisional: false, depth: r.c.depth });
      setSt(next);
      const a = next.attempts.find((x) => x.id === attemptId)!;
      const errorMotifs = r.c.epl >= 10 ? r.c.motifs.filter((m) => ['hanging-left', 'defender-removed', 'threat-ignored', 'king-exposure'].includes(m.kind)).map((m) => m.kind) : [];
      await updateProfile((p) => evidenceFromAttempt(p, a, r.c.bestUci, r.c.winBest, r.after.lines[0]?.pv[0], errorMotifs));
    } catch { /* background refinement is best effort */ }
  };

  const doTakeBack = () => {
    const s = stRef.current;
    if (!s?.pending) return;
    setSt(takeBack(s));
    setPhase({ k: 'idle' });
  };

  const doContinue = async () => {
    const s = stRef.current;
    if (!s?.pending) return;
    const a = s.attempts.find((x) => x.id === s.pending!.attemptId)!;
    const next = commitPending(s, { cls: a.cls, epl: a.epl, provisional: a.provisional, depth: 0 });
    setSt(next);
    setPhase({ k: 'idle' });
    await afterCommit(next);
  };

  const afterCommit = async (s: CoachState) => {
    if (s.session.status === 'finished') await endGame(s);
  };

  // ---------- coach move ----------
  const coachTurn = async () => {
    const s = stRef.current;
    if (!s || s.session.status !== 'active' || s.pending) return;
    const fen = currentFen(s);
    setPhase({ k: 'coach-thinking' });
    try {
      const prof = strengthFor(s.session.coachLevel);
      const focus = new Set((profRef.current ? focusAreas(profRef.current, 3) : []).map((f) => f.skill));
      const rand = mulberry32(seedFrom(s.session.seed, s.ucis.length));
      const { move, analysis } = await pickMove(getEngine(), fen, { ...prof, multipv: Math.max(prof.multipv, 3) }, rand, (cands) => cands.map((c) => {
        // Teaching bias: create the situations the player needs to practise (only among acceptable moves).
        if (!focus.has('hanging') && !focus.has('anticipation') && !focus.has('tactics')) return c;
        try {
          const k = analyzeMove(fen, c.uci).motifs.map((x) => x.kind);
          return k.some((x) => ['fork', 'pin', 'skewer', 'wins-hanging', 'mate-threat', 'discovered-attack'].includes(x)) ? { ...c, bonus: c.bonus + 0.4 } : c;
        } catch { return c; }
      }), abort.current.signal);
      // Predict the Opponent?
      const lastExercise = s.session.lastExercisePly;
      const assess = assessTeachingValue({
        fen, ply: s.ucis.length, analysis, lastMoveUci: s.ucis[s.ucis.length - 1], pliesSinceLastExercise: s.ucis.length - lastExercise,
        history: profRef.current?.predictions ?? {}, enabled: s.session.predictionEnabled && allowed('coach', 'prediction'),
      });
      if (assess.ask && assess.category) {
        predictionCtx.current = { fen, analysis, category: assess.category, chosen: move };
        const ns = { ...s, session: { ...s.session, lastExercisePly: s.ucis.length } };
        setSt(ns);
        setPhase({ k: 'predict' });
        return;
      }
      await playCoachMove(move.uci, analysis);
    } catch (e) {
      if (!(e instanceof AbortedError)) setPhase({ k: 'idle' });
    }
  };

  const playCoachMove = async (uci: string, before: AnalysisResult) => {
    const s = stRef.current!;
    const idx = s.ucis.length;
    const prevInfo = s.session.moveInfo[idx - 1];
    const ctx = { fens: s.fens, ucis: s.ucis, index: idx, uci, prevEpl: prevInfo?.epl ?? undefined, moverWinBefore: winBestByPly.current.has(idx - 1) ? 100 - winBestByPly.current.get(idx - 1)! : undefined };
    void before;
    let next = commitCoachMove(s, uci, { cls: null, epl: null, provisional: true, depth: 0 });
    setSt(next);
    setPhase({ k: 'idle' });
    // the Coach's own moves are rated too – it is not always "Best"
    void (async () => {
      try {
        const q = await classifyLive(getEngine(), ctx, prefs.liveDepth, prefs.deepDepth, 1);
        winBestByPly.current.set(idx, q.c.winBest);
        let cur = stRef.current!;
        if (cur.session.moveInfo[idx]?.uci === uci) { cur = updateMoveInfo(cur, idx, { cls: q.c.cls, epl: q.c.epl, provisional: q.c.provisional, depth: q.c.depth }); setSt(cur); }
        const d = await classifyLive(getEngine(), ctx, prefs.deepDepth, prefs.deepDepth, 0);
        cur = stRef.current!;
        if (cur.session.moveInfo[idx]?.uci === uci) setSt(updateMoveInfo(cur, idx, { cls: d.c.cls, epl: d.c.epl, provisional: false, depth: d.c.depth }));
      } catch { /* best effort */ }
    })();
    if (next.session.status === 'finished') await endGame(next);
  };

  // ---------- prediction ----------
  const submitPrediction = async (m: BoardMove | null) => {
    const pc = predictionCtx.current;
    const s = stRef.current;
    if (!pc || !s) return;
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
    const result = gradePrediction(pc.fen, predictedUci, pc.chosen.uci, pc.analysis, predictedWin);
    await savePrediction({ sessionId: s.session.id, ply: s.ucis.length, fen: pc.fen, category: pc.category, predictedUci, actualUci: pc.chosen.uci, grade: result.grade }, result.outcome);
    profRef.current = await loadCoachProfile(); setProfile(profRef.current);
    predictionCtx.current = null;
    await playCoachMove(pc.chosen.uci, pc.analysis);
    setPhase({ k: 'lesson', result });
  };

  // ---------- hints ----------
  const requestHint = async () => {
    const s = stRef.current;
    if (!s || !isPlayerTurn(s) || shownHints >= MAX_HINT_LEVEL) return;
    let hs = hints;
    if (!hs.length) {
      const a = await analysisFor(currentFen(s));
      hs = buildHints(currentFen(s), a);
      setHints(hs);
    }
    setSt(recordHint(stRef.current!));
    setShownHints((n) => n + 1);
  };

  // ---------- end ----------
  const endGame = async (s: CoachState) => {
    const accs = s.attempts.filter((a) => a.independent && a.epl !== null).map((a) => moveAccuracy(a.epl!));
    const acc = accs.length ? accs.reduce((x, y) => x + y, 0) / accs.length : null;
    const gid = await finishCoachGame(s, acc);
    await setMeta('activeCoach', null);
    profRef.current = await loadCoachProfile(); setProfile(profRef.current);
    setFinishedGameId(gid);
  };

  const resign = async () => {
    const s = stRef.current;
    if (!s) return;
    setConfirmResign(false);
    const r = resignCoach(s);
    setSt(r);
    setPhase({ k: 'idle' });
    await endGame(r);
  };

  useKeys({
    h: () => { void requestHint(); },
    f: () => setOrientation((o) => (o === 'white' ? 'black' : 'white')),
  }, !!st);

  if (loading) return <div className="page"><div className="empty">Loading…</div></div>;

  // ---------- setup screen ----------
  if (!st) {
    return (
      <div className="page page-narrow">
        <header className="page-head">
          <div>
            <h1>Coach</h1>
            <div className="lede">A real game against an opponent that wants you to improve. Every move is rated as you play. Mistakes come with an explanation, and you decide whether to take the move back. Hints point at what to look for, never the move itself.</div>
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

  const fen = st.pending ? st.pending.fenAfter : currentFen(st);
  const lastUci = st.pending ? st.pending.uci : st.ucis[st.ucis.length - 1];
  const player = st.session.playerColor;
  const coachColor = player === 'w' ? 'b' : 'w';
  const movable = phase.k === 'predict' ? coachColor : isPlayerTurn(st) && (phase.k === 'idle' || phase.k === 'lesson') ? player : 'none';
  const stats = sessionStats(st);
  const pendingAttempt = st.pending ? st.attempts.find((a) => a.id === st.pending!.attemptId) : undefined;
  const moves = [
    ...st.session.moveInfo.map((m) => ({ san: m.san, cls: m.cls, provisional: m.provisional, pending: m.cls === null, title: `${m.by === 'player' ? 'You' : 'Coach'}${m.assisted ? ', after a takeback or hint' : ''}` })),
    ...(st.pending ? [{ san: st.pending.san, cls: pendingAttempt?.cls ?? null, provisional: true, pending: !pendingAttempt?.cls }] : []),
  ];
  const over = st.session.status === 'finished';
  const top = orientation === 'white' ? 'b' : 'w';
  const names = { [player]: 'You', [coachColor]: `Coach, level ${st.session.coachLevel}` } as Record<'w' | 'b', string>;
  const turn = new Chess(fen).turn();
  const canHint = !over && isPlayerTurn(st) && (phase.k === 'idle' || phase.k === 'lesson') && shownHints < MAX_HINT_LEVEL;
  const hintTitle = over ? 'The game is over' : !isPlayerTurn(st) ? 'Hints are for your own move' : shownHints >= MAX_HINT_LEVEL ? 'All three hints for this position are shown' : 'Get a hint (H)';

  const status = over ? { cls: '', text: `Game over: ${st.session.result}${st.session.reason ? `, ${REASON_TEXT[st.session.reason].toLowerCase()}` : ''}` }
    : phase.k === 'evaluating' ? { cls: 'is-wait', text: 'Rating your move…' }
    : phase.k === 'coach-thinking' ? { cls: 'is-wait', text: 'The Coach is thinking…' }
    : phase.k === 'predict' ? { cls: 'is-predict', text: 'Predict the Coach’s reply' }
    : phase.k === 'feedback' ? { cls: '', text: 'Take the move back, or continue?' }
    : isPlayerTurn(st) ? { cls: '', text: 'Your move' } : { cls: 'is-wait', text: 'Waiting…' };

  const feedbackBlock = phase.k === 'feedback' && (
    <div className={`feedback sheet-mobile tone-${phase.fb.severity === 'bad' ? 'bad' : phase.fb.severity === 'warn' ? 'warn' : 'info'}`} data-testid="coach-feedback" role="alertdialog" aria-labelledby="fb-title">
      <div className="feedback-head"><ClassIcon cls={phase.cls} size="md" /><h2 id="fb-title">{phase.fb.headline}</h2></div>
      <ul>{phase.fb.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
      <div className="feedback-actions">
        <button type="button" className="btn btn-primary btn-lg" onClick={doTakeBack} data-testid="take-back" autoFocus>Take back</button>
        <button type="button" className="btn btn-lg" onClick={doContinue} data-testid="continue">Continue</button>
      </div>
      <p className="xs faint" style={{ margin: 'var(--s-2) 0 0' }}>Either is fine. Your first try is remembered as your own decision.</p>
    </div>
  );
  const predictBlock = phase.k === 'predict' && (
    <div className="feedback tone-predict" data-testid="prediction">
      <div className="feedback-head"><IconCoach /><h2>Predict the Coach’s reply</h2></div>
      <p className="small" style={{ marginBottom: 'var(--s-3)' }}>This is an important moment. Move one of the Coach’s pieces to show what you expect it to play.</p>
      <button type="button" className="btn btn-sm" onClick={() => submitPrediction(null)} data-testid="skip-prediction">Skip this exercise</button>
    </div>
  );
  const lessonBlock = phase.k === 'lesson' && (
    <div className={`feedback sheet-mobile tone-${phase.result.outcome >= 1 ? 'good' : phase.result.outcome > 0 ? 'info' : 'warn'}`} data-testid="lesson">
      <div className="feedback-head"><IconCoach /><h2>{phase.result.grade === 'skipped' ? 'Exercise skipped' : phase.result.grade === 'exact' ? 'Exactly right' : phase.result.grade === 'strong' ? 'Good prediction' : phase.result.grade === 'reasonable' ? 'Close' : 'Not quite'}</h2></div>
      <p className="small">{phase.result.predictedSan ? <>You expected <b>{phase.result.predictedSan}</b>. </> : null}The Coach played <b>{phase.result.actualSan}</b>.</p>
      <ul className="small">{phase.result.lesson.map((l, i) => <li key={i}>{l}</li>)}</ul>
      <button type="button" className="btn btn-sm" onClick={() => setPhase({ k: 'idle' })}>Got it</button>
    </div>
  );

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
          top={<PlayerStrip name={names[top]} color={top} fen={fen} isTurn={!over && turn === top} />}
          bottom={<PlayerStrip name={names[top === 'w' ? 'b' : 'w']} color={top === 'w' ? 'b' : 'w'} fen={fen} isTurn={!over && turn !== top} />}
          below={<div className="row board-tools hide-mobile"><button type="button" className="btn btn-sm btn-quiet" onClick={() => setOrientation(orientation === 'white' ? 'black' : 'white')} title="Flip board (F)"><IconFlip size={16} /> Flip</button></div>}>
          {(size) => <Board fen={fen} orientation={orientation} size={size} movable={over ? 'none' : movable} onMove={onPlayerMove} lastMove={lastUci ? [lastUci.slice(0, 2), lastUci.slice(2, 4)] : null} frame={phase.k === 'predict' ? 'predict' : 'normal'} id="coach-board" />}
        </Stage>
        <div className="panel-slot">
          <section className="panel" aria-label="Lesson">
            <div className={`status-line ${status.cls}`} role="status" aria-live="polite" data-testid="coach-status">
              <span className="status-dot" />
              <span>{status.text}</span>
              {positive && phase.k === 'idle' && !over && (
                <span className="row-nowrap small" style={{ marginLeft: 'auto', fontWeight: 600 }}><ClassIcon cls={positive.cls} size="sm" />{positive.san}, {CLASS_INFO[positive.cls].label.toLowerCase()}</span>
              )}
            </div>
            {over && (
              <div className="feedback tone-good" data-testid="coach-over">
                <div className="feedback-head"><h2>Game over: {st.session.result}</h2></div>
                <p className="small">Your independent decisions (first tries without hints): {stats.independentDecisions}, approximate accuracy {stats.independentEpl === null ? '–' : moveAccuracy(stats.independentEpl).toFixed(0)}. Takebacks: {stats.takebacks}, hints: {stats.hints}.</p>
                <div className="row">
                  {finishedGameId ? <button type="button" className="btn btn-primary" onClick={() => navigate(`review/${finishedGameId}`)}>Review this game</button> : <span className="small faint">Saving…</span>}
                  <button type="button" className="btn" onClick={start}>New Coach game</button>
                </div>
              </div>
            )}
            {feedbackBlock}
            {predictBlock}
            {lessonBlock}
            {shownHints > 0 && isPlayerTurn(st) && (
              <div className="section" data-testid="hints" aria-live="polite">
                <h3 className="section-title">Hints for this move</h3>
                <ol className="hint-list">{hints.slice(0, shownHints).map((h) => <li key={h.level}>{h.text}</li>)}</ol>
                {shownHints >= MAX_HINT_LEVEL && <p className="xs faint" style={{ margin: 'var(--s-2) 0 0' }}>That is every hint for this position. Trust your calculation.</p>}
              </div>
            )}
            <MoveStrip moves={moves} current={moves.length} showIcons />
            <MoveList moves={moves} current={moves.length} showIcons empty="The game starts when you or the Coach make the first move." />
            <details className="disclose section hide-mobile" style={{ paddingTop: 'var(--s-2)', paddingBottom: 'var(--s-2)' }}>
              <summary>This game and your learning profile</summary>
              <div className="stats" style={{ margin: 'var(--s-3) 0' }}>
                <div className="stat"><b>{stats.independentDecisions}</b><span>independent decisions</span></div>
                <div className="stat"><b>{stats.takebacks}</b><span>takebacks</span></div>
                <div className="stat"><b>{stats.correctedAfterTakeback}</b><span>corrected after a takeback</span></div>
              </div>
              {profile && <ProfileMini profile={profile} bare />}
            </details>
            <div className="panel-foot hide-stacked">
              <div className="row-nowrap">
                <button type="button" className="btn" onClick={requestHint} disabled={!canHint} title={hintTitle} data-testid="hint"><IconBulb size={18} /> Hint <span className="faint small">{shownHints}/{MAX_HINT_LEVEL}</span></button>
                <span className="spacer" />
                {!over && <button type="button" className="btn btn-danger" onClick={() => setConfirmResign(true)}><IconFlag size={18} /> Resign</button>}
              </div>
            </div>
          </section>
        </div>
      </div>
      <div className="dock">
        <button type="button" className="btn btn-lg" style={{ flex: 1 }} onClick={requestHint} disabled={!canHint} title={hintTitle} data-testid="hint-mobile"><IconBulb size={18} /> Hint {shownHints}/{MAX_HINT_LEVEL}</button>
        <button type="button" className="btn btn-lg btn-icon" onClick={() => setOrientation(orientation === 'white' ? 'black' : 'white')} aria-label="Flip board"><IconFlip /></button>
        {!over && <button type="button" className="btn btn-lg btn-icon btn-danger" onClick={() => setConfirmResign(true)} aria-label="Resign"><IconFlag /></button>}
      </div>
      <ConfirmDialog open={confirmResign} title="Resign this Coach game?" body="The game is saved and you can review it afterwards." danger confirmLabel="Resign game" cancelLabel="Keep playing" onCancel={() => setConfirmResign(false)} onConfirm={resign} />
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
