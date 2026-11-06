# Chess of Life — algorithms

Everything below is Chess of Life's own documented method. Where a formula was
published by others (Lichess's win-probability curve and accuracy curve,
Glickman's Glicko-2) it is credited; nothing is copied from Chess.com.

All code references are to `src/`.

## 1. Scores and winning chances (`engine/score.ts`)

* UCI scores are reported from the side to move. They are converted to
  **White's point of view** immediately (`normalizeScore`). Mate scores are
  kept as mates (`{ mate: n }`, positive = White mates); a checkmated
  terminal position is `{ mated: 'w' | 'b' }`.
* For ordering, mates map to ±(100000 − 10·n), so a faster mate is better and
  any mate beats any centipawn score.
* **Winning chances** (expected points, 0–100) use the logistic curve
  published by Lichess, fitted on human games:
  `win% = 50 + 50 · (2 / (1 + e^(−0.00368208 · cp)) − 1)`, cp clamped to ±1000.
  Mates are 100 / 0.

## 2. Move classification (`analysis/classify.ts`)

Each position of the game is analysed once with MultiPV 3. The position after
move *n* is the position before move *n+1*, so a game of N plies costs N+1
searches. Terms (all from the mover's point of view):

* `winBest` – winning chances after the best move (max of the engine's top
  line and the played move's own evaluation, to absorb search instability).
* `winAfter` – winning chances after the played move.
* **EPL** (expected points lost) = `max(0, winBest − winAfter)`.

Rules, in order:

| Class | Rule |
|---|---|
| Forced | only one legal move → shown as **Best**, excluded from accuracy |
| **Book** | the move is a catalogued continuation in the opening reference (§4) *and every earlier move was too*, and EPL < 20 |
| Mate handling | had a forced mate and lost it: **Miss** if the mate was ≤ 5 moves and the position is still ≥ 50 %; **Good** if still ≥ 99 %. Kept a mate but slower: **Excellent** (≤ 2 moves longer) or **Good** |
| **Best** | the engine's top move, or a move whose MultiPV score equals the top score (±5 cp) |
| **Excellent** | EPL < 2 |
| **Good** | EPL < 5 |
| **Inaccuracy** | EPL < 10 |
| **Mistake** | EPL < 20 |
| **Blunder** | EPL ≥ 20 |

Upgrades/overrides:

* **Miss** – the opponent's previous move lost ≥ 10 expected points, that error
  raised the mover's best chances by ≥ 10 over what they were before it, the
  move played loses ≥ 10, *and* the mover ends up no more than 5 points below
  where they stood before the opponent's error. In words: a real opportunity
  appeared and was not taken, without the move itself being a fresh disaster
  (that stays a Mistake/Blunder).
* **Great** – a Best move where the second-best line is ≥ 15 expected points
  worse (an "only move"), the position is neither lost (best < 30 %) nor
  already trivially won (> 97 %), it is not a recapture on the square the
  opponent just captured on, not a simple capture of an undefended piece, and
  not a mate-in-one.
* **Brilliant** – Best/Great/Excellent with EPL < 2 that **sacrifices ≥ 2 pawns
  of material** (verified by static exchange evaluation on the real board: the
  opponent can legally capture and come out ahead by that much, net of
  anything the move itself captured), the resulting position is not worse for
  the mover (≥ 50 %), the position was not already completely won, and a
  **tactical verification search** confirms that after the opponent *accepts*
  the sacrifice (best capture) the mover still has ≥ 50 %. Merely hanging a
  piece is never Brilliant because it fails the EPL and verification tests.
* **Provisional** – a classification is marked provisional until both of its
  positions have been searched to the target (deep) depth. Reviews run a
  quick pass first and then a deep pass that replaces every result.

### Accuracy

Per move: `accuracy = 103.1668 · e^(−0.04354 · EPL) − 3.1669 + 1`, clamped to
0–100 (curve published by Lichess, implemented independently). Game accuracy is
the mean of (a) a volatility-weighted mean, where each move is weighted by the
standard deviation of White's winning chances in a sliding window, and (b) the
harmonic mean. Forced moves are excluded.

### Turning points and summary

Turning points are the (up to 5) moves with the largest swing in winning
chances (≥ 15) that are classified Inaccuracy or worse, or Great/Brilliant. The
summary is generated only from the stored review data.

## 3. Tactical verification and explanations (`analysis/board.ts`, `motifs.ts`, `explain.ts`)

The engine supplies evaluations and lines; reasons are derived separately from
the board:

* attack maps, **static exchange evaluation**, hanging pieces (respecting pins
  through legal-move generation), passed pawns, pawn shield, king zone.
* motifs of a move: check, discovered check/attack, **fork** (moved piece
  attacks ≥ 2 valuable targets and cannot be won itself), **pin / skewer**
  (line pieces), mate threat / back-rank threat (null-move mate-in-one search),
  pieces left hanging, **defender removed**, ignored threats, overloaded
  defenders, sacrifices, promotions, new passed pawns, king-shelter weakening.
* material claims are checked by **playing the engine line out** to a quiet
  position and counting material (`materialAlongLine`).

If no motif explains an evaluation change, the explanation says so and shows
the engine line instead of inventing a reason.

## 4. Opening reference (`analysis/openings.ts`, `scripts/build-openings.ts`)

The Lichess `chess-openings` dataset (CC0, 3,865 named lines, stored verbatim in
`data/openings/`) is expanded into every position that occurs along any line,
with the catalogued continuations from it. Positions are keyed by placement,
side to move, castling rights and a *legal* en-passant square, so transpositions
are recognised. "Book" is granted only for catalogued continuations.

## 5. Variation tree (`chess/tree.ts`, `chess/pgn.ts`)

* Immutable tree of nodes; each node stores its move, resulting FEN, source
  (`historical`, `imported`, `user`, `engine`) and optional comment / NAGs /
  clock / branch name / note.
* The original game is the chain of `historical` nodes: it cannot be deleted,
  renamed or overwritten. Playing an existing move follows it instead of
  duplicating it.
* Transpositions: engine results are cached per position key, so different
  move orders reaching the same position share evaluations while keeping their
  own histories.
* PGN export writes the mainline with nested `( … )` variations, comments,
  branch names, source markers, `[%clk]` clocks and classification NAGs.

## 6. Engine controller (`engine/controller.ts`)

One Stockfish 17.1 (WASM, single-threaded) in a Web Worker. Requests go through
a priority queue (interactive > normal > background). Each search has an id;
on cancellation the controller sends `stop` and discards everything until the
matching `bestmove` (stale output rejection). A higher-priority request
pre-empts a background search, which is re-queued. Results are cached in memory
and in IndexedDB by `(position key, MultiPV, searchmoves)` and reused when the
cached depth is sufficient (a higher-MultiPV result also answers a lower one).
Terminal positions never reach the engine. A watchdog restarts a hung engine,
crashed workers are restarted and the search retried (twice).

## 7. Coach (`coach/*`)

* **Live rating**: player and Coach moves get a light search (live depth) for
  immediate feedback, shown as provisional, then a deep search replaces it.
* **Feedback**: Mistake / Miss / Blunder always trigger feedback; Inaccuracy
  does unless every skill the move touches is already mastered. Feedback names
  concepts (abandoned defender, double attack available, king danger …) from
  verified motifs of the played move and of the opponent's best reply, never
  the better move. The player chooses **Take Back** or **Continue**.
* **Attempts log**: every attempt is stored (`coachAttempts`) with attempt
  number, hints used before it, whether it was taken back and whether it became
  the final move. An attempt is **independent** only if it is the first attempt
  at that move and no hint was used.
* **Learning profile** (`coach/profile.ts`): each decision is tagged with the
  skills it gives evidence about (`coach/skills.ts`) and recorded as success
  (EPL < 5), half (EPL < 10) or failure, in separate *independent* and
  *assisted* tables. Each skill is a Beta(1,1) posterior; confidence is "none"
  below 5 decisions, "low" < 15, "moderate" < 40, else "good". A skill is
  *mastered* when the lower 90 % bound is ≥ 70 % with moderate+ confidence.
  Focus areas are the weakest skills with evidence. The Coach's level moves up
  after wins / draws and down after low independent accuracy.
* **Hints** (`coach/hints.ts`): three levels — where to look (threats, forcing
  moves, king, quiet improvement), which piece type, then the idea (fork, pin,
  mate net …). Text is sanitised so it never contains the move's SAN or its
  destination square; no arrows or highlights are shown.
* **Predict the Opponent** (`coach/prediction.ts`): teaching value = mating
  idea +4, tactical motif +3, sacrifice +2, engine line wins ≥ 2 pawns +2,
  only-move gap ≥ 15 +2, punishes a loose piece +1, trade into an endgame +1;
  −5 when almost forced, −3 for an obvious recapture, −3 in a routine opening
  (ply < 16), −2 if the player reliably anticipates that category, +1 if they
  usually miss it. An exercise is offered when the score is ≥ 4 and at least 8
  plies have passed since the last one. Grading: exact match; "strong" if the
  predicted move is within 5 expected points of the best reply; "reasonable"
  within 12; otherwise missed.

## 8. Ranked Rival (`rival/*`, `engine/strength.ts`)

* **Strength ladder**: level L (1–20) fixes search depth `round(4 + 0.7·L)`,
  MultiPV (5/3/2) and a **tolerance** of `max(0, 22 − 1.15·L)` expected points.
  The Rival only ever picks among engine candidates within that tolerance of
  the best move, weighted by `exp(−EPL / T + bonus)`. Weak levels therefore
  play plausible second-choice moves, never random blunders. The level and the
  random seed are fixed when the match starts.
* **Player model** (`rival/model.ts`): built only from completed Ranked games
  after post-game analysis — committed moves, results, clocks. Tracks skills
  (same tags as the Coach, separate data), openings by colour with score and
  early-move quality, play in closed vs open structures (≥ 3 head-on blocked
  pawn pairs), play under time pressure (< 15 % of initial time), answers to
  Rival sacrifices, aggression, time use, and a per-game skill history used to
  detect weaknesses that were **overcome**. Coach attempts, hints and
  takebacks are never read.
* **Strategy** (`rival/policy.ts`): derived once per game from weaknesses with
  evidence — king-attack, closing / opening the structure, simplification,
  tension, sacrifices, time-pressure complication, and opening lines to steer
  toward (player scored ≤ 50 % or played inaccurately) or avoid. Strategy adds
  bonuses only to moves already inside the tolerance, and a targeted book move
  is only added after a restricted search shows it is within tolerance. The
  Rival's per-move reasons are stored and revealed only after the game.
* **Draw offers**: the Rival accepts when its own evaluation gives it ≤ 50 %
  after ply 40, or ≤ 55 % after ply 80.
* **Rating** (`rival/glicko.ts`): Glicko-2 (τ = 0.5), each game its own rating
  period, against the Rival level's fixed internal anchor `700 + 100·(L − 1)`
  with RD 60. The player starts at 1200 ± 350; RD grows with ~30-day idle
  periods. The Rival level for a new match is the anchor nearest the player's
  rating (expected score ≈ 50 %). **This is an internal scale, not FIDE or any
  site's rating.**

## 9. Rules (`chess/rules.ts`)

chess.js provides legal moves. Game status is computed from the full position
history: checkmate, stalemate, dead position (insufficient material), fivefold
repetition and the 75-move rule end the game automatically; threefold
repetition and the 50-move rule are claimable. On a time forfeit the game is
drawn if the opponent cannot checkmate by any legal sequence (conservatively:
lone king, or a lone minor piece against a bare king).
