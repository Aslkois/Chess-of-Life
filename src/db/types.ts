import type { GameTree } from '../chess/tree';
import type { GameReview } from '../analysis/review';
import type { Classification } from '../analysis/classify';
import type { TimeControl } from '../chess/clock';
import type { EndReason, GameResult } from '../chess/rules';
import type { RivalStrategy } from '../rival/policy';
import type { Rating } from '../rival/glicko';

export type GameSource = 'manual' | 'pgn' | 'coach' | 'ranked';

export interface GameRecord {
  id: string;
  source: GameSource;
  headers: Record<string, string>;
  startFen: string;
  /** historical mainline in SAN */
  moves: string[];
  result: GameResult;
  /** the full variation tree (original game + explored branches) */
  tree: GameTree;
  createdAt: number;
  updatedAt: number;
  /** linked records */
  coachSessionId?: string;
  rankedMatchId?: string;
}

export interface ReconstructionDraft {
  id: string;
  /** SAN moves entered so far, including redo history beyond the cursor */
  moves: string[];
  cursor: number;
  orientation: 'white' | 'black';
  headers: Record<string, string>;
  startFen: string;
  updatedAt: number;
}

export interface StoredReview extends GameReview {}

export interface CoachAttempt {
  id: string;
  sessionId: string;
  /** ply index (0-based) of the decision */
  ply: number;
  fen: string;
  attemptNo: number;
  uci: string;
  san: string;
  cls: Classification | null;
  epl: number | null;
  provisional: boolean;
  hintsBefore: number;
  /** the attempt was taken back */
  tookBack: boolean;
  /** the attempt became the move actually played */
  final: boolean;
  /** first attempt with no hints = independent evidence */
  independent: boolean;
  ts: number;
}

export interface PredictionRecord {
  id: string;
  sessionId: string;
  ply: number;
  fen: string;
  category: string;
  predictedUci: string | null;
  actualUci: string;
  grade: string;
  ts: number;
}

export interface CoachMoveInfo {
  ply: number;
  san: string;
  uci: string;
  color: 'w' | 'b';
  by: 'player' | 'coach';
  cls: Classification | null;
  epl: number | null;
  provisional: boolean;
  depth: number;
  assisted: boolean;
}

export interface CoachSession {
  id: string;
  playerColor: 'w' | 'b';
  coachLevel: number;
  predictionEnabled: boolean;
  startFen: string;
  /** committed moves (SAN) */
  moves: string[];
  moveInfo: CoachMoveInfo[];
  hintsUsed: number;
  takebacks: number;
  lastExercisePly: number;
  status: 'active' | 'finished' | 'abandoned';
  result: GameResult;
  reason?: EndReason;
  seed: number;
  gameId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RankedMatch {
  id: string;
  playerColor: 'w' | 'b';
  rivalLevel: number;
  rivalRating: number;
  timeControl: TimeControl;
  startFen: string;
  moves: string[];
  ucis: string[];
  /** ms spent and remaining after each ply */
  timeSpent: number[];
  clockAfter: number[];
  status: 'active' | 'finished';
  result: GameResult;
  reason?: EndReason;
  ratingBefore?: Rating;
  ratingAfter?: Rating;
  strategy: RivalStrategy;
  /** why the Rival chose each of its moves (revealed only after the game) */
  rivalNotes: { ply: number; san: string; reasons: string[] }[];
  seed: number;
  /** clock state for resuming */
  clock?: { remaining: { w: number; b: number }; running: 'w' | 'b' | null; since: number };
  drawOfferedByPlayerAtPly?: number;
  analysisDone: boolean;
  gameId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RivalAdaptation {
  id: string;
  matchId: string;
  ts: number;
  changes: string[];
  strategyNotes: string[];
}

export interface RankedProfile {
  id: 'ranked';
  rating: Rating;
  history: { ts: number; matchId: string; r: number; rd: number; result: number; rivalLevel: number }[];
  wins: number;
  draws: number;
  losses: number;
  lastPlayed?: number;
}

export interface Preferences {
  quickDepth: number;
  deepDepth: number;
  liveDepth: number;
  showLegalMoves: boolean;
  showCoordinates: boolean;
  boardTheme: 'walnut' | 'moss' | 'slate' | 'sand';
  predictionExercises: boolean;
  confirmResign: boolean;
  /** 'system' follows the OS setting; 'reduced' turns off non-essential motion */
  motion: 'system' | 'reduced';
  /** show the engine's best-move arrow in Game Review */
  showBestArrow: boolean;
  /** last-used Game Review panel tab */
  reviewTab: 'review' | 'explore' | 'summary';
}

export const DEFAULT_PREFS: Preferences = {
  quickDepth: 10,
  deepDepth: 16,
  liveDepth: 12,
  showLegalMoves: true,
  showCoordinates: true,
  boardTheme: 'walnut',
  predictionExercises: true,
  confirmResign: true,
  motion: 'system',
  showBestArrow: false,
  reviewTab: 'review',
};
