import { useEffect, useState } from 'react';
import { loadCoachProfile } from '../services/coach';
import { listAdaptations, listMatches, loadRankedProfile, loadRivalModel } from '../services/ranked';
import type { LearningProfile } from '../coach/profile';
import { focusAreas } from '../coach/profile';
import type { RivalModel } from '../rival/model';
import { aggressionIndex, overcome, weaknesses } from '../rival/model';
import type { RankedMatch, RankedProfile, RivalAdaptation } from '../db/types';
import { emptyStat, rating, SKILLS } from '../coach/skills';
import { Meter } from '../ui/bits';
import { REASON_TEXT } from '../chess/rules';
import { playerScore } from '../rival/ranked';

export function ProfilePage() {
  const [coach, setCoach] = useState<LearningProfile | null>(null);
  const [ranked, setRanked] = useState<RankedProfile | null>(null);
  const [model, setModel] = useState<RivalModel | null>(null);
  const [matches, setMatches] = useState<RankedMatch[]>([]);
  const [adapt, setAdapt] = useState<RivalAdaptation[]>([]);
  const [tab, setTab] = useState<'coach' | 'ranked'>('coach');
  useEffect(() => {
    loadCoachProfile().then(setCoach);
    loadRankedProfile().then(setRanked);
    loadRivalModel().then(setModel);
    listMatches().then(setMatches);
    listAdaptations().then(setAdapt);
  }, []);
  if (!coach || !ranked || !model) return <div className="empty">Loading…</div>;
  return (
    <div style={{ maxWidth: 1000 }}>
      <h1>Progress</h1>
      <p className="muted">Two separate records. The Coach’s learning profile includes training games (with independent and assisted decisions kept apart). The Rival’s model uses only completed Ranked games.</p>
      <div className="tabs">
        <button className={tab === 'coach' ? 'on' : ''} onClick={() => setTab('coach')}>Learning profile (Coach)</button>
        <button className={tab === 'ranked' ? 'on' : ''} onClick={() => setTab('ranked')}>Ranked & Rival</button>
      </div>
      {tab === 'coach' ? <CoachProfile p={coach} /> : <RankedView r={ranked} model={model} matches={matches} adapt={adapt} />}
    </div>
  );
}

function SkillTable({ stats, assisted }: { stats: Record<string, ReturnType<typeof emptyStat>>; assisted?: Record<string, ReturnType<typeof emptyStat>> }) {
  return (
    <table className="list">
      <thead><tr><th>Skill</th><th style={{ width: '34%' }}>Estimated success (90% interval)</th><th>Decisions</th><th>Confidence</th><th>Trend</th>{assisted && <th>Assisted</th>}</tr></thead>
      <tbody>
        {SKILLS.map((s) => {
          const st = stats[s.id] ?? emptyStat();
          const r = rating(st);
          return (
            <tr key={s.id}>
              <td title={s.desc}>{s.label}</td>
              <td>{r.confidence === 'none' ? <span className="faint small">not enough evidence</span> : <div className="row" style={{ flexWrap: 'nowrap' }}><div style={{ flex: 1 }}><Meter value={r.mean} lo={Math.max(0, r.mean - r.halfWidth)} hi={Math.min(1, r.mean + r.halfWidth)} /></div><span className="mono small">{(r.mean * 100).toFixed(0)}%</span></div>}</td>
              <td className="mono">{st.n}</td>
              <td><span className={`pill ${r.confidence === 'good' ? 'accent' : ''}`}>{r.confidence}</span></td>
              <td className="small">{r.trend === null ? <span className="faint">—</span> : r.trend > 0.1 ? <span style={{ color: 'var(--accent)' }}>improving</span> : r.trend < -0.1 ? <span style={{ color: '#f08a8d' }}>slipping</span> : 'steady'}</td>
              {assisted && <td className="mono faint">{assisted[s.id]?.n ?? 0}</td>}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function CoachProfile({ p }: { p: LearningProfile }) {
  const focus = focusAreas(p, 3);
  const predCats = Object.entries(p.predictions);
  return (
    <div>
      <div className="card">
        <div className="row" style={{ gap: 28 }}>
          <div className="stat"><b>{p.games}</b><span>Coach games</span></div>
          <div className="stat"><b>{p.movesIndependent}</b><span>independent decisions</span></div>
          <div className="stat"><b>{p.movesAssisted}</b><span>assisted decisions</span></div>
          <div className="stat"><b>{p.takebacks}</b><span>takebacks</span></div>
          <div className="stat"><b>{p.hintsUsed}</b><span>hints</span></div>
          <div className="stat"><b>{p.coachLevel}</b><span>Coach level</span></div>
        </div>
      </div>
      <div className="card">
        <h3>Focus areas</h3>
        {focus.length ? <ul style={{ margin: 0, paddingLeft: 18 }}>{focus.map((f) => <li key={f.skill}>{SKILLS.find((s) => s.id === f.skill)?.label}: {(f.mean * 100).toFixed(0)}% success ({f.confidence} confidence)</li>)}</ul> : <p className="muted">Not enough evidence yet. A handful of games is not enough to describe your play reliably; the profile fills in as you play.</p>}
      </div>
      <div className="card" style={{ overflowX: 'auto' }}>
        <h3>Independent decisions (first attempts, no hints)</h3>
        <SkillTable stats={p.independent} assisted={p.assisted} />
        <p className="faint small" style={{ marginTop: 8 }}>A decision counts as a success when it loses fewer than 5 expected points, half a success below 10. Intervals come from a Beta(1,1) prior and shrink as evidence accumulates.</p>
      </div>
      <div className="card">
        <h3>Predict the Opponent</h3>
        {predCats.length === 0 ? <p className="muted small">No exercises yet.</p> : (
          <table className="list"><tbody>{predCats.map(([k, v]) => { const r = rating(v); return <tr key={k}><td>{k}</td><td className="mono">{v.n} exercises</td><td className="mono">{(r.mean * 100).toFixed(0)}% success</td></tr>; })}</tbody></table>
        )}
      </div>
      {p.accuracyHistory.length > 0 && (
        <div className="card"><h3>Independent accuracy per Coach game</h3>
          <div className="row" style={{ alignItems: 'flex-end', height: 80, gap: 3 }}>{p.accuracyHistory.slice(-40).map((a, i) => <div key={i} title={`${a.accuracy.toFixed(1)}% — ${new Date(a.ts).toLocaleDateString()}`} style={{ width: 10, height: `${a.accuracy * 0.8}px`, background: 'var(--accent)', borderRadius: 2 }} />)}</div>
        </div>
      )}
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
    <div>
      <div className="card">
        <div className="row" style={{ gap: 28 }}>
          <div className="stat"><b>{Math.round(r.rating.r)}</b><span>internal rating</span></div>
          <div className="stat"><b>±{Math.round(r.rating.rd * 2)}</b><span>95% uncertainty</span></div>
          <div className="stat"><b>{r.wins}</b><span>wins</span></div>
          <div className="stat"><b>{r.draws}</b><span>draws</span></div>
          <div className="stat"><b>{r.losses}</b><span>losses</span></div>
        </div>
        <p className="faint small" style={{ marginTop: 8 }}>Glicko-2 on Chess of Life’s internal scale (Rival level L is anchored at 700 + 100·(L−1)). It is not calibrated against FIDE or any online rating.</p>
        {hist.length > 1 && <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 120 }} preserveAspectRatio="none"><polyline points={pts} fill="none" stroke="#8fc17a" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>}
      </div>
      <div className="grid2">
        <div className="card">
          <h3>What the Rival has learned</h3>
          {model.games === 0 ? <p className="muted small">Nothing yet — the Rival only learns from completed, analysed Ranked games.</p> : (
            <>
              <p className="small muted">{model.games} analysed Ranked game{model.games === 1 ? '' : 's'}.{agg !== null ? ` ${(agg * 100).toFixed(0)}% of your moves are checks or captures.` : ''}</p>
              {w.length ? <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{w.slice(0, 6).map((x) => <li key={x.id}><b>{x.label}</b> — {x.evidence} ({x.confidence} confidence)</li>)}</ul> : <p className="small muted">No weakness with enough evidence to exploit.</p>}
              {ov.length > 0 && <p className="small" style={{ marginTop: 8 }}>Overcome: {ov.join(', ')}.</p>}
            </>
          )}
        </div>
        <div className="card">
          <h3>Openings in Ranked games</h3>
          {Object.values(model.openings).length === 0 ? <p className="muted small">None recorded.</p> : (
            <table className="list small"><tbody>{Object.values(model.openings).sort((a, b) => b.games - a.games).slice(0, 8).map((o) => <tr key={o.key}><td>{o.name}</td><td>as {o.playerColor === 'w' ? 'White' : 'Black'}</td><td className="mono">{o.score}/{o.games}</td></tr>)}</tbody></table>
          )}
        </div>
      </div>
      <div className="card">
        <h3>Rival adaptation history</h3>
        {adapt.length === 0 ? <p className="muted small">No adaptations yet.</p> : adapt.slice(0, 10).map((a) => (
          <div key={a.id} style={{ marginBottom: 10 }}>
            <div className="faint small">{new Date(a.ts).toLocaleString()}</div>
            <ul className="small" style={{ margin: '2px 0', paddingLeft: 18 }}>{a.changes.map((c, i) => <li key={i}>{c}</li>)}</ul>
            {a.strategyNotes.length > 0 && <div className="small muted">Next game plan: {a.strategyNotes.join(' ')}</div>}
          </div>
        ))}
      </div>
      <div className="card" style={{ overflowX: 'auto' }}>
        <h3>Match history</h3>
        {finished.length === 0 ? <p className="muted small">No Ranked games yet.</p> : (
          <table className="list"><thead><tr><th>Date</th><th>Colour</th><th>Rival</th><th>Result</th><th>Reason</th><th>Rating</th><th /></tr></thead><tbody>
            {finished.map((m) => {
              const sc = playerScore(m);
              const d = m.ratingAfter && m.ratingBefore ? m.ratingAfter.r - m.ratingBefore.r : null;
              return <tr key={m.id}><td>{new Date(m.createdAt).toLocaleDateString()}</td><td>{m.playerColor === 'w' ? 'White' : 'Black'}</td><td>level {m.rivalLevel}</td><td>{sc === 1 ? 'Win' : sc === 0 ? 'Loss' : 'Draw'} ({m.result})</td><td className="small muted">{m.reason ? REASON_TEXT[m.reason] : ''}</td><td className="mono">{d === null ? '—' : `${d >= 0 ? '+' : ''}${d.toFixed(1)}`}</td><td>{m.gameId && <a href={`#/review/${m.gameId}`}>review</a>}</td></tr>;
            })}
          </tbody></table>
        )}
      </div>
    </div>
  );
}
