import { Chess } from 'chess.js';
import type { GameReview } from '../analysis/review';
import { addOutcome, emptyStat, outcomeOf, rating, SKILLS, tagSkills, type Skill, type SkillStat } from '../coach/skills';
import { parseBoard, type Board } from '../analysis/board';

/**
 * The Rival's model of the player. It is built ONLY from completed Ranked
 * games: committed, unassisted moves and their outcomes. Coach data (takebacks,
 * hints, corrected attempts) never enters this model.
 */
export interface OpeningRecord { key: string; name: string; playerColor: 'w' | 'b'; games: number; score: number; eplSum: number; moves: number; line: string[] }

export interface RivalModel {
  id: 'rival';
  version: 1;
  games: number;
  skills: Record<Skill, SkillStat>;
  openings: Record<string, OpeningRecord>;
  /** move quality under time pressure (<15% of initial time left) vs. otherwise */
  timePressure: SkillStat;
  normalTime: SkillStat;
  /** quality of play in closed vs open structures */
  closed: SkillStat;
  open: SkillStat;
  /** player's answer to a Rival sacrifice */
  vsSacrifice: SkillStat;
  /** share of checks/captures/king-side pushes among player's moves */
  aggression: { forcing: number; total: number };
  /** average share of time spent per move by phase */
  timeUse: { opening: number; middlegame: number; endgame: number; n: number };
  /** skills per game (for trend / "overcome" detection) */
  skillHistory: { ts: number; matchId: string; skills: Partial<Record<Skill, number>> }[];
  updatedAt: number;
}

export function emptyRivalModel(): RivalModel {
  return {
    id: 'rival', version: 1, games: 0,
    skills: Object.fromEntries(SKILLS.map((s) => [s.id, emptyStat()])) as Record<Skill, SkillStat>,
    openings: {}, timePressure: emptyStat(), normalTime: emptyStat(), closed: emptyStat(), open: emptyStat(), vsSacrifice: emptyStat(),
    aggression: { forcing: 0, total: 0 }, timeUse: { opening: 0, middlegame: 0, endgame: 0, n: 0 }, skillHistory: [], updatedAt: Date.now(),
  };
}

/** Number of pawns blocked head-on by an enemy pawn – a simple "closed structure" measure. */
export function lockedPawnPairs(b: Board): number {
  let n = 0;
  for (let i = 0; i < 56; i++) {
    const p = b[i];
    if (p?.t === 'p' && p.c === 'w') {
      const q = b[i + 8];
      if (q?.t === 'p' && q.c === 'b') n++;
    }
  }
  return n;
}

export const isClosed = (fen: string) => lockedPawnPairs(parseBoard(fen)) >= 3;

export interface RankedGameData {
  matchId: string;
  playerColor: 'w' | 'b';
  /** 1 win, 0.5 draw, 0 loss (player) */
  score: number;
  opening: { key: string; name: string; line: string[] } | null;
  review: GameReview;
  fens: string[];
  /** ms spent per ply (index = ply index in game) */
  timeSpent: (number | undefined)[];
  /** remaining ms after each ply */
  clockAfter: (number | undefined)[];
  initialMs: number;
}

export interface ModelUpdate { model: RivalModel; changes: string[] }

export function updateRivalModel(prev: RivalModel, g: RankedGameData): ModelUpdate {
  const m: RivalModel = structuredClone(prev);
  const changes: string[] = [];
  const before = Object.fromEntries(SKILLS.map((s) => [s.id, rating(prev.skills[s.id] ?? emptyStat()).mean])) as Record<Skill, number>;
  const gameSkills: Partial<Record<Skill, { s: number; n: number }>> = {};
  let forcing = 0;
  let total = 0;
  for (let i = 0; i < g.review.moves.length; i++) {
    const mv = g.review.moves[i];
    if (!mv) continue;
    if (mv.color !== g.playerColor) {
      continue;
    }
    const fenBefore = g.fens[i];
    const next = g.review.moves[i + 1];
    const tags = tagSkills({ fenBefore, uci: mv.uci, bestUci: mv.bestUci, epl: mv.epl, ply: mv.ply, winBest: mv.winBefore, replyUci: next?.bestUci ?? undefined });
    const out = outcomeOf(mv.epl);
    for (const t of tags) {
      m.skills[t] = addOutcome(m.skills[t] ?? emptyStat(), out);
      const gs = (gameSkills[t] ??= { s: 0, n: 0 });
      gs.s += out; gs.n++;
    }
    // time pressure
    const left = g.clockAfter[i];
    if (g.initialMs > 0 && left !== undefined) {
      if (left < g.initialMs * 0.15) m.timePressure = addOutcome(m.timePressure, out);
      else m.normalTime = addOutcome(m.normalTime, out);
      const spent = g.timeSpent[i];
      if (spent !== undefined) {
        const share = spent / g.initialMs;
        m.timeUse = { ...m.timeUse, [mv.phase]: m.timeUse[mv.phase] + share, n: m.timeUse.n + 1 };
      }
    }
    // structure
    if (isClosed(fenBefore)) m.closed = addOutcome(m.closed, out);
    else m.open = addOutcome(m.open, out);
    // reaction to a Rival sacrifice on the previous move
    const prevRival = i >= 1 ? g.review.moves[i - 1] : undefined;
    if (prevRival && prevRival.color !== g.playerColor && prevRival.sacrifice >= 2) m.vsSacrifice = addOutcome(m.vsSacrifice, out);
    // aggression
    total++;
    try {
      const c = new Chess(fenBefore);
      const mo = c.move({ from: mv.uci.slice(0, 2), to: mv.uci.slice(2, 4), promotion: mv.uci[4] });
      if (mo.captured || mo.san.includes('+')) forcing++;
    } catch { /* ignore */ }
  }
  m.aggression = { forcing: m.aggression.forcing + forcing, total: m.aggression.total + total };

  if (g.opening) {
    const key = `${g.playerColor}:${g.opening.key}`;
    const rec = m.openings[key] ?? { key, name: g.opening.name, playerColor: g.playerColor, games: 0, score: 0, eplSum: 0, moves: 0, line: g.opening.line };
    const early = g.review.moves.filter((x) => x && x.color === g.playerColor && x.ply <= 30);
    rec.games++;
    rec.score += g.score;
    rec.eplSum += early.reduce((a, b) => a + b.epl, 0);
    rec.moves += early.length;
    m.openings[key] = rec;
    changes.push(`Recorded your result in the ${g.opening.name} as ${g.playerColor === 'w' ? 'White' : 'Black'} (${rec.games} game${rec.games === 1 ? '' : 's'}, score ${rec.score}/${rec.games}).`);
  }
  m.games++;
  m.skillHistory = [...m.skillHistory, { ts: Date.now(), matchId: g.matchId, skills: Object.fromEntries(Object.entries(gameSkills).map(([k, v]) => [k, v!.s / v!.n])) }].slice(-50);
  m.updatedAt = Date.now();

  for (const s of SKILLS) {
    const after = rating(m.skills[s.id]);
    const delta = after.mean - before[s.id];
    if (after.confidence !== 'none' && Math.abs(delta) >= 0.04) {
      changes.push(`${s.label}: estimated success rate ${delta > 0 ? 'rose' : 'fell'} to ${(after.mean * 100).toFixed(0)}% (${after.confidence} confidence).`);
    }
  }
  return { model: m, changes };
}

export interface Weakness { id: string; label: string; strength: number; confidence: string; evidence: string }

/** Weaknesses with enough evidence to act on, strongest first. */
export function weaknesses(m: RivalModel): Weakness[] {
  const out: Weakness[] = [];
  for (const s of SKILLS) {
    const r = rating(m.skills[s.id]);
    if (r.confidence === 'none') continue;
    if (r.mean < 0.6) out.push({ id: s.id, label: s.label, strength: 0.6 - r.mean, confidence: r.confidence, evidence: `${(r.mean * 100).toFixed(0)}% success over ${m.skills[s.id].n} decisions` });
  }
  const cmp = (a: SkillStat, b: SkillStat, id: string, label: string) => {
    if (a.n < 8 || b.n < 8) return;
    const ra = rating(a).mean;
    const rb = rating(b).mean;
    if (rb - ra >= 0.1) out.push({ id, label, strength: rb - ra, confidence: a.n >= 25 ? 'moderate' : 'low', evidence: `${(ra * 100).toFixed(0)}% vs ${(rb * 100).toFixed(0)}% success` });
  };
  cmp(m.closed, m.open, 'closed', 'Closed pawn structures');
  cmp(m.open, m.closed, 'open', 'Open positions');
  cmp(m.timePressure, m.normalTime, 'time-pressure', 'Play under time pressure');
  if (m.vsSacrifice.n >= 3 && rating(m.vsSacrifice).mean < 0.5) out.push({ id: 'vs-sacrifice', label: 'Responding to sacrifices', strength: 0.5 - rating(m.vsSacrifice).mean, confidence: 'low', evidence: `${m.vsSacrifice.n} sacrifices faced` });
  return out.sort((a, b) => b.strength - a.strength);
}

/** Skills the player has overcome: weak earlier, solid in recent Ranked games. */
export function overcome(m: RivalModel): string[] {
  const res: string[] = [];
  if (m.skillHistory.length < 6) return res;
  const half = Math.floor(m.skillHistory.length / 2);
  for (const s of SKILLS) {
    const olds = m.skillHistory.slice(0, half).map((h) => h.skills[s.id]).filter((x): x is number => x !== undefined);
    const news = m.skillHistory.slice(half).map((h) => h.skills[s.id]).filter((x): x is number => x !== undefined);
    if (olds.length < 3 || news.length < 3) continue;
    const a = olds.reduce((x, y) => x + y, 0) / olds.length;
    const b = news.reduce((x, y) => x + y, 0) / news.length;
    if (a < 0.55 && b >= 0.7) res.push(s.label);
  }
  return res;
}

export function aggressionIndex(m: RivalModel): number | null {
  return m.aggression.total >= 30 ? m.aggression.forcing / m.aggression.total : null;
}
