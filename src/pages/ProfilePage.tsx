import { useEffect, useState } from 'react';
import { loadCoachProfile } from '../services/coach';
import { listAdaptations, listMatches, loadRankedProfile, loadRivalModel } from '../services/ranked';
import { focusAreas, type LearningProfile } from '../coach/profile';
import { aggressionIndex, overcome, weaknesses, type RivalModel } from '../rival/model';
import type { RankedMatch, RankedProfile, RivalAdaptation } from '../db/types';
import { emptyStat, rating, SKILLS, type SkillStat } from '../coach/skills';
import { Meter } from '../ui/bits';
import { REASON_TEXT } from '../chess/rules';
import { playerScore } from '../rival/ranked';
import { OpeningStats } from './progress/OpeningStats';

export function ProfilePage() {
  const [coach, setCoach] = useState<LearningProfile | null>(null);
  const [ranked, setRanked] = useState<RankedProfile | null>(null);
  const [model, setModel] = useState<RivalModel | null>(null);
  const [matches, setMatches] = useState<RankedMatch[]>([]);
  const [adapt, setAdapt] = useState<RivalAdaptation[]>([]);
  const [tab, setTab] = useState<'coach' | 'ranked' | 'openings'>('coach');
  useEffect(() => {
    loadCoachProfile().then(setCoach);
    loadRankedProfile().then(setRanked);
    loadRivalModel().then(setModel);
    listMatches().then(setMatches);
    listAdaptations().then(setAdapt);
  }, []);
  if (!coach || !ranked || !model) return <div className="page"><div className="empty">Loading…</div></div>;
  return (
    <div className="page page-narrow">
      <header className="page-head">
        <div>
          <h1>Progress</h1>
          <div className="lede">Separate records. Training with the Coach builds your learning profile; only finished Ranked games shape the Rival's view of you; opening statistics come from your own saved games.</div>
        </div>
        <div className="page-head-actions">
          <div className="seg" role="tablist" aria-label="Record">
            <button type="button" role="tab" aria-selected={tab === 'coach'} onClick={() => setTab('coach')}>Learning profile</button>
            <button type="button" role="tab" aria-selected={tab === 'ranked'} onClick={() => setTab('ranked')}>Ranked and Rival</button>
            <button type="button" role="tab" aria-selected={tab === 'openings'} onClick={() => setTab('openings')} data-testid="progress-openings">Openings</button>
          </div>
        </div>
      </header>
      {tab === 'coach' ? <CoachProfile p={coach} /> : tab === 'ranked' ? <RankedView r={ranked} model={model} matches={matches} adapt={adapt} /> : <OpeningStats />}
    </div>
  );
}

function SkillRows({ stats, assisted }: { stats: Record<string, SkillStat>; assisted?: Record<string, SkillStat> }) {
  return (
    <div>
      {SKILLS.map((s) => {
        const st = stats[s.id] ?? emptyStat();
        const r = rating(st);
        const trend = r.trend === null ? null : r.trend > 0.1 ? 'Improving' : r.trend < -0.1 ? 'Slipping' : 'Steady';
        return (
          <div className="skill-row" key={s.id}>
            <div><div style={{ fontWeight: 600 }}>{s.label}</div><div className="xs faint">{s.desc}</div></div>
            <div className="meter-cell">{r.confidence === 'none' ? <span className="small faint">Not enough evidence yet</span> : <Meter value={r.mean} lo={Math.max(0, r.mean - r.halfWidth)} hi={Math.min(1, r.mean + r.halfWidth)} />}</div>
            <div className="small num" style={{ textAlign: 'right' }}>{r.confidence === 'none' ? <span className="faint" title="Decisions recorded out of the 5 needed for an estimate">{st.n}/5 needed</span> : `${(r.mean * 100).toFixed(0)}%`}</div>
            <div className="small c-hide-narrow">
              <div className="dim">{r.confidence === 'none' ? '' : `${r.confidence} confidence`}</div>
              <div className="faint xs">{trend ?? ''}{assisted && assisted[s.id]?.n ? `${trend ? ', ' : ''}${assisted[s.id].n} assisted` : ''}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CoachProfile({ p }: { p: LearningProfile }) {
  const focus = focusAreas(p, 3);
  const preds = Object.entries(p.predictions);
  return (
    <div className="stack" style={{ gap: 'var(--s-4)' }}>
      <section className="surface surface-pad">
        <div className="stats">
          <div className="stat"><b>{p.games}</b><span>Coach games</span></div>
          <div className="stat"><b>{p.movesIndependent}</b><span>independent decisions</span></div>
          <div className="stat"><b>{p.movesAssisted}</b><span>after a takeback or hint</span></div>
          <div className="stat"><b>{p.coachLevel}</b><span>Coach level</span></div>
        </div>
        <p className="small dim" style={{ margin: 'var(--s-4) 0 0' }}>
          {focus.length ? <>Practise next: {focus.map((f) => SKILLS.find((s) => s.id === f.skill)?.label).join(', ')}.</> : 'A handful of games is not enough to describe your play reliably, so nothing is claimed yet.'}
        </p>
      </section>
      <section className="surface surface-pad">
        <h2 style={{ marginBottom: 'var(--s-1)' }}>Skills</h2>
        <p className="small faint">From first tries made without hints. A move counts as a success when it loses less than 5 of 100 expected points. Ranges narrow as evidence builds up.</p>
        <SkillRows stats={p.independent} assisted={p.assisted} />
      </section>
      <div className="grid-2">
        <section className="surface surface-pad">
          <h2 style={{ marginBottom: 'var(--s-3)' }}>Predict the Opponent</h2>
          {preds.length === 0 ? <p className="small dim" style={{ margin: 0 }}>No exercises yet. They appear at important moments in Coach games.</p> : preds.map(([k, v]) => (
            <div key={k} className="row-nowrap small" style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}><span style={{ textTransform: 'capitalize' }}>{k.replace('-', ' ')}</span><span className="spacer" /><span className="num">{v.n} exercise{v.n === 1 ? '' : 's'}, {(rating(v).mean * 100).toFixed(0)}% success</span></div>
          ))}
        </section>
        <section className="surface surface-pad">
          <h2 style={{ marginBottom: 'var(--s-3)' }}>Independent accuracy per game</h2>
          {p.accuracyHistory.length === 0 ? <p className="small dim" style={{ margin: 0 }}>Appears after your first finished Coach game.</p> : (
            <div className="row-nowrap" style={{ alignItems: 'flex-end', height: 90, gap: 3 }} role="img" aria-label={`Accuracy of your last ${Math.min(40, p.accuracyHistory.length)} Coach games`}>
              {p.accuracyHistory.slice(-40).map((a, i) => <div key={i} title={`${a.accuracy.toFixed(1)}%, ${new Date(a.ts).toLocaleDateString()}`} style={{ flex: '1 1 0', maxWidth: 14, height: `${Math.max(4, a.accuracy * 0.9)}px`, background: 'var(--ivory)', borderRadius: 2, opacity: 0.85 }} />)}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function RankedView({ r, model, matches, adapt }: { r: RankedProfile; model: RivalModel; matches: RankedMatch[]; adapt: RivalAdaptation[] }) {
  const w = weaknesses(model);
  const ov = overcome(model);
  const agg = aggressionIndex(model);
  const hist = r.history;
  const W = 600, H = 120;
  const rs = hist.map((h) => h.r);
  const lo = Math.min(1000, ...rs) - 50;
  const hi = Math.max(1400, ...rs) + 50;
  const pts = hist.map((h, i) => `${(i / Math.max(1, hist.length - 1)) * W},${H - ((h.r - lo) / (hi - lo)) * H}`).join(' ');
  const finished = matches.filter((m) => m.status === 'finished');
  return (
    <div className="stack" style={{ gap: 'var(--s-4)' }}>
      <section className="surface surface-pad">
        <div className="stats">
          <div className="stat"><b>{Math.round(r.rating.r)}</b><span>internal rating</span></div>
          <div className="stat"><b>±{Math.round(r.rating.rd * 2)}</b><span>uncertainty (95%)</span></div>
          <div className="stat"><b className="num">{r.wins}–{r.draws}–{r.losses}</b><span>wins, draws, losses</span></div>
        </div>
        {hist.length > 1 && <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 120, marginTop: 'var(--s-4)' }} preserveAspectRatio="none" role="img" aria-label="Rating history"><polyline points={pts} fill="none" stroke="#ede7d5" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>}
        <p className="xs faint" style={{ margin: 'var(--s-3) 0 0' }}>Glicko-2 on Chess of Life's own scale; Rival level L is anchored at 700 + 100 × (L − 1). Not calibrated against FIDE or any online rating.</p>
      </section>
      <div className="grid-2">
        <section className="surface surface-pad">
          <h2 style={{ marginBottom: 'var(--s-3)' }}>What the Rival has learned</h2>
          {model.games === 0 ? <p className="small dim" style={{ margin: 0 }}>Nothing yet. The Rival only learns from finished, analysed Ranked games.</p> : (
            <div className="small stack" style={{ gap: 'var(--s-2)' }}>
              <p className="dim" style={{ margin: 0 }}>From {model.games} analysed game{model.games === 1 ? '' : 's'}.{agg !== null ? ` ${(agg * 100).toFixed(0)}% of your moves are checks or captures.` : ''}</p>
              {w.length ? <ul className="move-explain" style={{ margin: 0 }}>{w.slice(0, 6).map((x) => <li key={x.id}><b>{x.label}</b>: {x.evidence}, {x.confidence} confidence</li>)}</ul> : <p className="dim" style={{ margin: 0 }}>No weakness with enough evidence to exploit.</p>}
              {ov.length > 0 && <p style={{ margin: 0 }}>Overcome: {ov.join(', ')}.</p>}
            </div>
          )}
        </section>
        <section className="surface surface-pad">
          <h2 style={{ marginBottom: 'var(--s-3)' }}>Openings in Ranked games</h2>
          {Object.values(model.openings).length === 0 ? <p className="small dim" style={{ margin: 0 }}>None recorded yet.</p> : Object.values(model.openings).sort((a, b) => b.games - a.games).slice(0, 8).map((o) => (
            <div key={o.key} className="row-nowrap small" style={{ padding: '6px 0', borderTop: '1px solid var(--line)' }}><span className="ellipsis">{o.name}</span><span className="faint">as {o.playerColor === 'w' ? 'White' : 'Black'}</span><span className="spacer" /><span className="num">{o.score}/{o.games}</span></div>
          ))}
        </section>
      </div>
      <section className="surface surface-pad">
        <h2 style={{ marginBottom: 'var(--s-3)' }}>How the Rival adapted</h2>
        {adapt.length === 0 ? <p className="small dim" style={{ margin: 0 }}>No adaptations yet.</p> : adapt.slice(0, 8).map((a) => (
          <details key={a.id} className="disclose" style={{ borderTop: '1px solid var(--line)', padding: '4px 0' }}>
            <summary>{new Date(a.ts).toLocaleString()}, {a.changes.length} change{a.changes.length === 1 ? '' : 's'}</summary>
            <ul className="move-explain">{a.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
            {a.strategyNotes.length > 0 && <p className="small dim">Plan for the next game: {a.strategyNotes.join(' ')}</p>}
          </details>
        ))}
      </section>
      <section className="surface">
        <h2 style={{ padding: 'var(--s-5) var(--s-5) var(--s-2)' }}>Match history</h2>
        {finished.length === 0 ? <div className="ml-empty">No Ranked games yet.</div> : (
          <div className="side-list">
            {finished.map((m) => {
              const sc = playerScore(m);
              const d = m.ratingAfter && m.ratingBefore ? m.ratingAfter.r - m.ratingBefore.r : null;
              return (
                <a key={m.id} href={m.gameId ? `#/review/${m.gameId}` : undefined}>
                  <span className="title">{sc === 1 ? 'Win' : sc === 0 ? 'Loss' : 'Draw'} as {m.playerColor === 'w' ? 'White' : 'Black'} against level {m.rivalLevel}<span className="sub">{new Date(m.createdAt).toLocaleDateString()}{m.reason ? `, ${REASON_TEXT[m.reason].toLowerCase()}` : ''}</span></span>
                  <span className="meta num" style={{ color: d === null ? undefined : d >= 0 ? 'var(--ok)' : '#f0857f' }}>{d === null ? '' : `${d >= 0 ? '+' : ''}${d.toFixed(1)}`}</span>
                </a>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
