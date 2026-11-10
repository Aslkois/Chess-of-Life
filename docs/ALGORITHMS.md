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

Bands use the expected-points limits of Chess.com's Classification V2, with
inclusive upper bounds (`THRESHOLDS` in `classify.ts`):

| Band | EPL (0–100 scale) |
|---|---|
| **Best** | ≤ 0.05, or the engine's top move / a move with the top MultiPV score (not when a faster mate was available) |
| **Excellent** | ≤ 2 |
| **Good** | ≤ 5 |
| **Inaccuracy** | ≤ 10 |
| **Mistake** | ≤ 20 |
| **Blunder** | > 20 |

Rules, in order of precedence:

1. **Forced** – only one legal move: shown as Best, excluded from accuracy.
2. **Book** – a catalogued continuation in the opening reference (§4) *and
   every earlier move was too*, with EPL ≤ 20.
3. **Mates** – keeping a forced mate but a slower one is Excellent (≤ 2 moves
   longer) or Good. Losing a forced mate is a **Miss** when EPL > 5 and the
   position is still ≥ 50 %, otherwise the band applies.
4. **Brilliant** – all of: final depth (never provisional); EPL ≤ 2; the move
   offers **≥ 2 pawns of material** that the opponent can win by a legal
   capture sequence (static exchange on the real board, net of anything the
   move captured, pins respected); the mover was not already completely
   winning without it, judged on the best *alternative* with mates kept apart
   from large centipawn scores (both read as ~100 %): if the alternative
   already forces mate, no; if it is merely winning (≥ 90 %), only a sacrifice
   that turns the position into a forced mate qualifies; the mover still has ≥ 45 % after the
   move; and an **engine verification** (`analysis/verify.ts`) of the
   opponent's acceptances — a restricted search over the legal captures that
   take the material — confirms that a *real* acceptance (the material really
   stays won three plies later, or the acceptance leads to mate) leaves the
   mover ≥ 45 % and costs the opponent ≤ 15 points compared with declining
   (or is the opponent's only legal reply).
   *Regression:* 17.Rc8+!! in 1.e4 d5 2.exd5 Qxd5 3.Nc3 Qe5+ 4.Be2 Nc6 5.Nf3
   Qa5 6.d4 e6 7.O-O Bd7 8.Bd2 O-O-O 9.Nb5 Qb6 10.c4 Nb4 11.a4 Nf6 12.c5 Bxc5
   13.dxc5 Qxc5 14.Rc1 Qe7 15.Rxc7+ Kb8 16.Bf4 Nfd5 used to be rated Best: the
   old rule stopped at "the best alternative (17.Qxd5, +10.4) is already
   completely winning" before verifying the sacrifice. The rook is offered with
   double check, 17...Kxc8 is forced and 18.Nxa7# mates, so the sacrifice turns
   a winning position into a forced mate, which is now recognised.
   A trap the opponent should simply not fall into (accepting loses for them,
   e.g. the Légal pattern) is therefore not Brilliant; nor is a "sacrifice"
   whose capture is immediately regained (4.Bb5 in the Scandinavian line
   1.e4 d5 2.exd5 Qxd5 3.Nc3 Qc6: Qxb5?? Nxb5, so SEE = −6 and nothing is
   offered).
5. **Great** – the engine's top move at final depth with MultiPV alternatives,
   not checkmate, not a routine recapture or capture of the piece that just
   moved, not mate-in-one, and the game is not already decided, plus either
   * *only move*: the second-best line is ≥ 15 points worse **and** falls in a
     lower outcome band (lost < 20 %, worse < 40 %, equal ≤ 60 %, better < 80 %,
     winning), or
   * *turning point*: the opponent's previous move lost ≥ 10, this move gains
     ≥ 10 over the alternative, and it lifts the mover into a higher outcome
     band than before the opponent's error.
6. **Best** – as in the table.
7. **Miss** – EPL > 10, the opponent's previous move lost ≥ 10, that error
   raised the mover's chances by ≥ 10 to a real chance (best ≥ 60 % or a
   mate), the move gives most of it back (ends < 5 points above where the
   mover stood before the error) without making things more than 5 points
   worse than that. A fresh disaster stays a Mistake/Blunder.
8. Otherwise the band for the EPL.

* **Provisional** – a classification is provisional until both of its
  positions have been searched to the target (deep) depth; Brilliant and Great
  are never awarded provisionally. Reviews run a quick pass, then a deep pass
  that replaces every result.
* **Cached reviews** carry `REVIEW_VERSION`; reviews from an older rule set are
  re-run automatically (engine results stay cached, so this is quick).

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

### Explanations on request (`analysis/explainMove.ts`)

Game Review shows a move's rating, evaluation and highlights while you step
through the game, and nothing more: an explanation is built only when
**Explain** is pressed (or E), for the selected move, and any change of
position dismisses it with its board marks. It uses the review's own engine
data (MultiPV lines before the move, the main line after it) and the board:

* **Errors** (inaccuracy to blunder): a piece left en prise or a defender
  removed (attackers, defenders and the winning capture, as arrows and rings);
  a threat that already existed and is ignored; a **bad trade** (the exchange
  on the square, from the engine line or least-valuable-attacker order cut
  where a side would stop); the opponent's punishing reply when it is a mate,
  a meaningful tactic or a double attack that costs material; the material
  the engine line wins, counted from before the move; positional costs when
  there is no tactic; otherwise an honest statement that no tactic punishes
  it. Then the better move: arrow, icon, evaluation and what it does (its
  tactic, the piece it saves, what it attacks or controls).
* **Missed opportunities**: when the opponent's previous move was an error,
  what the better move would have won.
* **Good moves**: tactics (fork, pin, skewer and discovered attack or check
  with their attack lines, only when something valuable is involved),
  **free material** (why it can be taken, including whether anything can
  recapture), deflection and removing the defender (only when the engine line
  then takes the piece), **justified sacrifices** (with the acceptance and
  what the line shows; if the engine line declines the offer, it says so),
  **defence** (checking line plus block, capture or king move; the threatened
  piece it saves; a mating threat it stops), castling, **development and
  activity** (the diagonal a bishop controls, open files, pieces attacked and
  how they are defended, central squares), pawn moves (squares gained, pieces
  defended or attacked, lines opened) and **what it prepares**: the mover's
  next quiet moves in the engine continuation, drawn as dashed numbered
  arrows and labelled a possible plan, not a forced line.
* **Best vs second best**: both evaluations and continuations; if they are
  within 2 points of winning chances the explanation says they are
  practically equal instead of inventing a difference.

Lines (the played move with the engine continuation, the best line, the
second best, the exchange) all start from the position before the move,
are replayed move by move (so they are legal), can be stepped half-move by
half-move, compared at the same step, and never touch the game or its tree.
A line counts as forcing when its first two plies are checks, captures or
replies to check, or it mates.

## 4. Openings (`analysis/openings.ts`, `services/openings.ts`, `openings/repertoire.ts`)

**Reference.** The Lichess `chess-openings` dataset (CC0-1.0, 3,865 named
lines, stored verbatim in `data/openings/`) is expanded by
`scripts/build-openings.ts` into every position that occurs along any line,
with each catalogued continuation and the number of dataset lines through it.
The build checks that no two lines end in the same position, so every named
position has exactly one name. Positions are keyed by placement, side to
move, castling rights and a *legal* en-passant square, so transpositions
share a key. The test suite replays every dataset line and checks the name,
ECO code and book status of every position on it.

**Names.** A dataset name splits into *family* (before the colon),
*variation* (first comma part) and *sub-variation* (the rest):
"Sicilian Defense: Najdorf Variation, English Attack" → Sicilian Defense /
Najdorf Variation / English Attack.

**Tracking a game** (`trackOpening`): for each position, *in book* means the
position is on a catalogued line. A move is a book move when it goes from a
book position to a book position, whether or not the dataset lists that move
order (transposition). The tracker records where theory was first left
(`leftAt`), whether the game came back into it (`reentered`), and per
position the **last known identity**: the deepest named position reached so
far on that path. Identity is never inferred ahead of the moves: after
1.e4 c5 2.Nf3 d6 3.d4 cxd4 4.Nxd4 Nf6 5.Nc3 the game is still "Sicilian
Defense", and becomes "Najdorf Variation" only with 5...a6. Book
classification (§2) uses the initial unbroken run in theory.

**My Games** (`gamesAtPosition`): the user's saved games that reach a
position (by key, so transpositions count), each game once, with the next
move played and the result from the user's side. A game counts only when the
user's side is established: Coach and Ranked games always; imported and
reconstructed games when the user sets it in the review or on saving, or when
a PGN player name matches one of the names in Settings (exactly one side).
Games marked as someone else's are never counted. Coach games are a separate
source, because takebacks and hints change their outcome.

**Personal statistics** (`openingStats`): each counted game is filed under
the deepest name it reached and appears once at each level of its path
(family → variation → sub-variation), so a level's count is never more than
its parent's. Per node: games, wins/draws/losses and score from the user's
side, opening accuracy (mean accuracy of the user's own moves in the first 12
moves, reviewed games only), early errors (the user's inaccuracies or worse
in the same span), the moves where the games left theory and whether it was
the user or the opponent, and the score per month. Filters: source, colour,
period and time control.

**Explorer databases** (`explorer/*`). *Masters*, *Online* and *Player*
statistics come from the documented Lichess Opening Explorer
(explorer.lichess.org), which requires a Lichess account: Log in with Lichess
(authorization code flow with PKCE, a public client without secret or scopes)
or a pasted personal token. The token stays in the browser's localStorage and
is not part of backups. Requests go one at a time; after a 429 the client waits
a minute. Answers are cached (masters 30 days, online 1 day, player 1 hour, at
most 400 positions) and served from the cache when Lichess is unreachable.
Positions are sent as transposition-safe FENs (legal en passant only). *My
games* is computed from the saved games, offline, with the same White / Draw /
Black convention and filters (source, your side, a player's name, dates).
*Book* is the catalogued opening list. Legal moves that a database has no
games for are listed separately; when a source only returns its most common
moves this is said. Engine evaluations of the listed moves are optional and
shown apart from the statistics: popularity is not quality.

**Repertoire and practice.** Saved lines (SAN from the start position) for
one colour are merged into a tree keyed by position (transpositions share
their prepared move; disagreeing lines are reported). In practice the
training opponent plays one of the prepared replies, choosing more often
those that lead to the user's weakest decisions; optionally it deviates with
a catalogued move the repertoire does not cover. Wrong moves are not played
and can be retried without limit; "Show me" reveals the move (that decision
then counts as missed). Each decision is recorded per colour and position
(attempts, first-try successes, misses, current streak, wrong moves played).
Weakness = 2·misses − 1.5·streak − 0.25·first-try successes; positions with
weakness > 0 are listed as "moves you tend to forget". Practice never creates
games and never touches any statistic or rating.

**Coach.** After a move (never before) the Coach notes when it reached a
newly named catalogued position, left the catalogued theory (listing the
catalogued moves there and saying that leaving theory is not a mistake in
itself) or came back into it by transposition.

## 5. Variation tree (`chess/tree.ts`, `chess/pgn.ts`)

* Immutable tree of nodes; each node stores its move, resulting FEN, source
  (`historical`, `imported`, `user`, `engine`, `theory` for catalogued moves
  added from the opening reference) and optional comment / NAGs /
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
* **Feedback** (`coach/teach.ts`): Mistake / Miss / Blunder always stop the
  game for feedback; an Inaccuracy does unless every skill the move touches is
  already mastered (then it is a non-blocking note). Brilliant and Great moves,
  and Best/Excellent moves with a verified notable motif, get a short note.
  Post-move feedback is concrete: it names the piece, square, attackers and
  defenders of anything left en prise, the capture that wins it, the opponent's
  punishing reply (mate, fork, pin, skewer, discovered attack, mate threat),
  the material swing along the engine line, and positional costs (castling
  rights lost, doubled/isolated pawns, king shelter, new enemy passed pawn,
  repeated moves of a developed piece). When none of these is present it says
  that no tactic punishes the move and offers the engine's continuation.
* **Show Why / Best Move / Compare**: Show Why plays the opponent's punishing
  line from the position after the move (red = threats, orange = the concept,
  blue = plans); Best Move plays the better line from the position before it
  (green); Compare shows both moves' winning chances, material outcome and
  lines. They are computed from the same analysis as the rating, offered only
  after the move and only when asked, and they never change the game: the
  board shows the demonstration position while the game state stays untouched
  until **Return**. Pre-move hints never show the move.
* **Take back** is unlimited and needs no confirmation: a pending move, any
  played move (whatever its rating), after the Coach has replied (both moves
  are undone), repeatedly, and after the game has ended (the game continues
  and the saved game is overwritten on the next finish; the Coach level adapts
  only once per session). In-flight engine work for the undone moves is
  cancelled.
* **Attempts log**: every attempt is stored (`coachAttempts`) with attempt
  number, hints used before it, whether it was taken back or rewound, whether
  a demonstration was studied, and whether it became the final move. An
  attempt is **independent** only if it is the first attempt at that position
  (matched by position key, so transpositions count) and no hint was used.
  Independent and assisted evidence are kept apart in the learning profile.
* **Learning profile** (`coach/profile.ts`): each decision is tagged with the
  skills it gives evidence about (`coach/skills.ts`) and recorded as success
  (EPL < 5), half (EPL < 10) or failure, in separate *independent* and
  *assisted* tables. Each skill is a Beta(1,1) posterior; confidence is "none"
  below 5 decisions, "low" < 15, "moderate" < 40, else "good". A skill is
  *mastered* when the lower 90 % bound is ≥ 70 % with moderate+ confidence.
  Focus areas are the weakest skills with evidence. The Coach's level moves up
  after wins / draws and down after low independent accuracy.
* **Hints** (`coach/hints.ts`): three stages per position, all about the same
  move, the top line of the engine analysis the Coach rates moves with.
  Stage 1 is strategic advice chosen from that move's verified features
  (forced mate, a threat against you, fork, discovered attack, pin, skewer,
  loose enemy piece, mating net, sacrifice, promotion race, king safety,
  development, or quiet improvement) plus whether it is a critical moment;
  it is checked so it names neither the piece, its square nor the
  destination. Stage 2 names and highlights the piece. Stage 3 shows the move
  (both squares and an arrow) with why it works: its verified motifs, the
  material or mate the engine line wins, and the line itself. After stage 3
  the button reads "All hints revealed". The stage resets whenever the
  position changes, including coming back to an earlier position after a
  takeback. Any hint makes the following decision assisted.
* **Show Me** (`coach/replay.ts`): demonstrations play automatically at 0.5×,
  1× or 2× and can be stepped through (First, Previous, Next, Last, Play/Pause,
  Replay, clicking a move in the numbered notation, ← → Home End Space). Any
  manual step pauses playback; at the end the line stays on the board.
  Leaving returns to the unchanged game position.
* **Predict the Opponent** (`coach/prediction.ts`): teaching value = mating
  idea +4, tactical motif +3, sacrifice +2, engine line wins ≥ 2 pawns +2,
  only-move gap ≥ 15 +2, punishes a loose piece +1, trade into an endgame +1;
  −5 when almost forced, −3 for an obvious recapture, −3 in a routine opening
  (ply < 16), −2 if the player reliably anticipates that category, +1 if they
  usually miss it. An exercise is offered when the score is ≥ 4 and at least 8
  plies have passed since the last one. Grading: exact match; "strong" if the
  predicted move is within 5 expected points of the best reply; "reasonable"
  within 12; otherwise missed.

## 8. Board interaction, pacing and sound

* **Planning** (`ui/planning.ts`): right-click and drag draws an arrow,
  right-click on one square marks it; repeating removes it. Orange by default,
  Shift green, Alt blue, Ctrl/Cmd red. Annotations are the user's own (never
  engine output, also in Ranked), sit in an overlay that does not take clicks,
  never move pieces (pieces only drag with the left button), suppress the
  browser menu on the board, and clear on the next move, a left click or the
  clear button. On touch screens a Plan toggle makes taps draw instead of move.
* **Premoves** (`chess/premove.ts`): during the opponent's turn the player's
  pieces can be moved to any square their movement pattern reaches on the
  board as it will be after earlier premoves (blocking pieces ignored, as the
  opponent's reply is unknown; nothing about that reply is used). The premove
  is shown with dashed violet arrows and squares, distinct from the yellow last
  move and the orange planning arrows. When it is the player's turn the first
  premove is played only if it is legal in the real position; otherwise the
  queue is cancelled. One premove replaces the previous one; with Multiple
  premoves up to five are queued. The queue is cleared by Esc, a right-click,
  the Cancel button, a takeback, resignation, a new game and the end of the
  game. In timed Ranked games a premove is played after at least 0.1 s of the
  player's clock. Premoved plies are recorded, and their time is left out of
  the Rival's time-use model.
* **Opponent pacing** (`engine/pacing.ts`): the Coach and the Rival pause before
  moving. The situation sets a range (forced/obvious 0.3–0.8 s, book 0.3–0.9 s,
  normal 0.6–1.5 s, complicated 1.2–2.5 s, time pressure 0.1–0.5 s); the pause
  is drawn from it with seeded randomness, stretched 0.9–1.1× by level in
  complicated positions, scaled by the speed setting (Instant 0, Fast 0.5×,
  Natural 1×, Relaxed 1.6×), and capped on a clock at 3 % of the remaining time
  plus half the increment and never within 3 s of zero. Time the engine already
  spent counts toward the pause. The pause is cancelled by takebacks, new
  games, resignation and leaving the page, and it never affects which move is
  chosen. These ranges are this app's own; no published timings exist to copy.
* **Sounds** (`audio/sounds.ts`): one sound per move by priority check >
  castling > capture > move, chosen by matching the board change to a legal
  move, so it works the same for both sides, demonstrations and replay
  (stepping back plays a softer move sound; jumps and square selection are
  silent). The four sounds are synthesised (filtered noise transients and short
  tones), normalised below clipping, rendered into audio buffers once and
  played through Web Audio after the first user gesture; they work offline.

## 9. Ranked Rival (`rival/*`, `engine/strength.ts`)

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

## 10. Rules (`chess/rules.ts`)

chess.js provides legal moves. Game status is computed from the full position
history: checkmate, stalemate, dead position (insufficient material), fivefold
repetition and the 75-move rule end the game automatically; threefold
repetition and the 50-move rule are claimable. On a time forfeit the game is
drawn if the opponent cannot checkmate by any legal sequence (conservatively:
lone king, or a lone minor piece against a bare king).
