/**
 * Glicko-2 (Glickman, 2012) on an internal scale. Each Ranked game is treated
 * as its own rating period against the Rival level the player faced. The
 * Rival level's rating is a fixed internal anchor with a small deviation.
 * This is an internal rating – not FIDE Elo and not calibrated to any site.
 */
export interface Rating {
  r: number;
  rd: number;
  vol: number;
}

export const INITIAL_RATING: Rating = { r: 1200, rd: 350, vol: 0.06 };
const TAU = 0.5;
const SCALE = 173.7178;

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const E = (mu: number, muj: number, phij: number) => 1 / (1 + Math.exp(-g(phij) * (mu - muj)));

export function expectedScore(player: Rating, opp: { r: number; rd: number }): number {
  return E((player.r - 1500) / SCALE, (opp.r - 1500) / SCALE, opp.rd / SCALE);
}

/** Update a rating after one game. score: 1 win, 0.5 draw, 0 loss. */
export function updateRating(player: Rating, opp: { r: number; rd: number }, score: number): Rating {
  const mu = (player.r - 1500) / SCALE;
  const phi = player.rd / SCALE;
  const muj = (opp.r - 1500) / SCALE;
  const phij = opp.rd / SCALE;
  const gj = g(phij);
  const e = E(mu, muj, phij);
  const v = 1 / (gj * gj * e * (1 - e));
  const delta = v * gj * (score - e);
  // volatility (Illinois algorithm)
  const a = Math.log(player.vol * player.vol);
  const f = (x: number) => {
    const ex = Math.exp(x);
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * (phi * phi + v + ex) ** 2) - (x - a) / (TAU * TAU);
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }
  let fA = f(A);
  let fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > 1e-6; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else fA /= 2;
    B = C; fB = fC;
  }
  const vol = Math.exp(A / 2);
  const phiStar = Math.sqrt(phi * phi + vol * vol);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * gj * (score - e);
  return { r: muNew * SCALE + 1500, rd: Math.max(30, Math.min(350, phiNew * SCALE)), vol };
}

/** Rating deviation grows with inactivity (one period per ~30 days). */
export function decayRd(rt: Rating, daysIdle: number): Rating {
  const periods = Math.floor(daysIdle / 30);
  if (periods <= 0) return rt;
  const phi = rt.rd / SCALE;
  const phiNew = Math.sqrt(phi * phi + periods * rt.vol * rt.vol);
  return { ...rt, rd: Math.min(350, phiNew * SCALE) };
}

export const RIVAL_RD = 60;
