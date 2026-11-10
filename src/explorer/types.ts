/** One normalised shape for every explorer data source. Nothing here is ever filled with invented numbers. */
export type ExplorerDb = 'masters' | 'lichess' | 'player' | 'local' | 'book';
export type Speed = 'ultraBullet' | 'bullet' | 'blitz' | 'rapid' | 'classical' | 'correspondence';
export const SPEEDS: Speed[] = ['ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence'];
export const RATING_GROUPS = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500] as const;

export interface ExPlayer { name: string; rating?: number }
export interface ExGame {
  id: string;
  source: 'masters' | 'lichess' | 'local';
  white: ExPlayer;
  black: ExPlayer;
  winner: 'white' | 'black' | null;
  year?: number;
  month?: string | null;
  date?: string;
  /** the move played from the explored position in this game */
  uci?: string;
  speed?: string;
  /** position index in the local game (for opening it at the right move) */
  ply?: number;
}
export interface ExMove {
  uci: string;
  san: string;
  white: number;
  draws: number;
  black: number;
  averageRating?: number;
  performance?: number;
  opening?: { eco: string; name: string } | null;
}
export interface ExResult {
  db: ExplorerDb;
  white: number;
  draws: number;
  black: number;
  moves: ExMove[];
  topGames: ExGame[];
  recentGames: ExGame[];
  opening: { eco: string; name: string } | null;
  /** player explorer: Lichess is still indexing the player's games */
  queuePosition?: number;
  fromCache?: boolean;
  fetchedAt: number;
  /** the source only returns the most common moves (others may exist below the cut) */
  truncated?: boolean;
}

export interface MastersFilter { since?: number; until?: number }
export interface LichessFilter { speeds: Speed[]; ratings: number[]; since?: string; until?: string }
export interface PlayerFilter { name: string; color: 'white' | 'black'; speeds: Speed[]; modes: ('rated' | 'casual')[]; since?: string; until?: string }

export const total = (m: { white: number; draws: number; black: number }) => m.white + m.draws + m.black;
/** Percentages of a W/D/L triple (0 when there are no games). */
export function percentages(m: { white: number; draws: number; black: number }): { white: number; draws: number; black: number } {
  const t = total(m);
  if (!t) return { white: 0, draws: 0, black: 0 };
  return { white: (m.white / t) * 100, draws: (m.draws / t) * 100, black: (m.black / t) * 100 };
}
/** Expected score for the side to move from a W/D/L triple, in [0,1] (null without games). */
export function scoreFor(m: { white: number; draws: number; black: number }, side: 'w' | 'b'): number | null {
  const t = total(m);
  if (!t) return null;
  return ((side === 'w' ? m.white : m.black) + m.draws / 2) / t;
}
