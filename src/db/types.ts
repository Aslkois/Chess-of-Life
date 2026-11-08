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
  /**
   * The side the user played. Known for Coach and Ranked games; for imported
   * and reconstructed games it is set by the user (or matched from the PGN
   * player names in Settings). `null` = the user did not play in this game.
   */
  playerColor?: 'w' | 'b' | null;
}

export interface ReconstructionDraft {
  id: string;
  /** SAN moves entered so far, including redo history beyond the cursor */
  moves: string[];
  cursor: number;
  orientation: 'white' | 'black';
  headers: Record<string, string>;
  startFen: string;
  /** the side the user played, if they say so */
  playerColor?: 'w' | 'b' | null;
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
  /** first attempt at this position in the session, made without hints = independent evidence */
  independent: boolean;
  /** the move was committed and later undone with Take back */
  rewound?: boolean;
  /** the player looked at a demonstration (Show Why / Best Move) of this attempt */
  sawDemo?: boolean;
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
  /** the Coach-level adaptation for this game has been applied (only once, even if the game is reopened) */
  profileApplied?: boolean;
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
  /** plies the player made with a premove (their time says nothing about thinking) */
  premovePlies?: number[];
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
  /** names the user plays under in PGN files (to know their side in imported games) */
  playerNames: string[];
  /** prepare moves during the opponent's turn (Coach and Ranked) */
  premoves: boolean;
  /** allow up to five queued premoves instead of one */
  multiPremoves: boolean;
  /** right-click (or plan mode on touch) to draw arrows and mark squares */
  planning: boolean;
  /** how long the Coach and the Rival pause before moving */
  opponentSpeed: 'instant' | 'fast' | 'natural' | 'relaxed';
  sound: boolean;
  /** 0..1 */
  soundVolume: number;
}

/** A saved opening line of the user's repertoire (SAN from the standard start position). */
export interface RepertoireLine {
  id: string;
  name: string;
  /** the side the user plays in this line */
  color: 'w' | 'b';
  moves: string[];
  note?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Practice record for one decision of the repertoire: a position (by key)
 * where the user is to move, for one colour. Kept apart from all game
 * statistics.
 */
export interface DrillRecord {
  /** `${color}|${positionKey}` */
  id: string;
  color: 'w' | 'b';
  fen: string;
  /** repertoire moves (UCI) accepted in this position */
  expected: string[];
  attempts: number;
  /** answered correctly at the first try */
  firstTry: number;
  misses: number;
  /** consecutive first-try successes */
  streak: number;
  lastPracticed: number;
  lastMissed?: number;
  /** the wrong moves played here, most recent first (UCI) */
  wrong: string[];
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
  playerNames: [],
  premoves: true,
  multiPremoves: false,
  planning: true,
  opponentSpeed: 'natural',
  sound: true,
  soundVolume: 0.7,
};
