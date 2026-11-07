# Chess of Life

A free, local-first chess application for **reviewing** games, **exploring**
the alternatives you didn't play, **learning** with an adaptive Coach and
**competing** against a Rival that studies how you play.

Everything — Stockfish analysis, the Coach, the Rival, your history — runs in
your browser. No account, no server, no subscription, no limits on reviews.

> The name comes from the Tree of Life: every decision opens another possible
> future, and every game is one path through an enormous tree. In Chess of
> Life that tree is a real, navigable, persistent data structure.

## Features

| Area | What you get |
|---|---|
| **Game Review** | Enter a game by **reconstructing it move by move** on the board (both sides, legal moves only, undo/redo, autosave) or **import PGN** (paste or file, many games per file, headers/clocks/comments/NAGs/variations preserved, clear error reporting). Both produce the same game record. Review shows accuracy for both players, the ten move classifications (Brilliant, Great, Best, Excellent, Good, Book, Inaccuracy, Mistake, Miss, Blunder), evaluation bar and graph, winning-chance changes, centipawn loss, best lines, verified tactical explanations, turning points, opening name and a written summary. Results are provisional after a quick pass and refined by a deep pass. |
| **Tree of Life** | Play any move from any position to branch; branches nest without limit. Stockfish can play a move, a line or 6 moves of continuation. Branches can be named, annotated, compared with the original game (evaluation, winning chances, material, verified consequences) and deleted. The original game is immutable. Outline view + branch map; transpositions share cached evaluations. PGN export with nested variations. |
| **Coach** | A real game against an opponent whose goal is your improvement. Every move — yours and the Coach's — is rated live (provisional, then refined). Mistakes, misses and blunders get a concrete explanation (which piece, which square, the punishing reply) with **Show Why**, **Best Move** and **Compare** demonstrations on request, then **Retry** or **Continue**. **Take back** any move, as often as you like — after the Coach's reply or even after the game has ended. Unlimited hints that point to *what to look at*, never the move. Selective **Predict the Opponent** exercises at moments with real teaching value. A persistent learning profile separates independent decisions from assisted ones and reports confidence honestly. |
| **Ranked Rival** | Competitive games with clocks (3+2 … 30+20 or untimed), resignation, draw offers, threefold / 50-move claims, automatic fivefold / 75-move / dead-position draws and FIDE time-forfeit rules. **No assistance of any kind** while the game is running — and every other part of the app is locked. The Rival plays at a fixed, calibrated level, learns only from completed Ranked games, and steers toward your demonstrated weaknesses with sound moves. Internal Glicko-2 rating, match history, adaptation log. Analysis unlocks after the game. |
| **Openings** | An **Opening Explorer** built on the free Lichess opening list (CC0): family, variation and sub-variation with ECO code, book status per position, transpositions recognised, the last known opening kept after leaving theory, catalogued continuations with the number of dataset lines through each, **My Games** statistics from your own games (with the games behind every number), the engine only when you ask, and an honest "not included" for master games. Personal opening statistics in Progress (family → variation → sub-variation, W/D/L, score, opening accuracy, where theory was left, over time, filters), opening identity and book status per move in Game Review, post-move opening notes in the Coach, theory branches in the Tree of Life, and a **repertoire** with practice against a training opponent (unlimited retries, forgotten-move tracking, PGN import/export), kept apart from all game statistics. Locked during Ranked play like everything else. |
| **Data** | IndexedDB with versioned migrations: games, drafts, reviews, engine cache, branches, Coach sessions / attempts / predictions, learning profile, Ranked matches, Rival model and adaptations, preferences. Export / import a JSON backup; delete everything. Works offline after the first visit (PWA). |

## Interface

Game Review is one destination: it opens a chooser between **Reconstruct a
game** and **Import PGN**. The review screen keeps the board first, with the
selected move's rating stamped on the board, its explanation beside it, the
notation and replay controls below, and key-moment navigation. Exploration of
alternatives happens in a distinct Explore mode with a branch map. See
[docs/DESIGN.md](docs/DESIGN.md) for the design system, breakpoints and
interaction rules.

## Install and run

Requirements: Node.js 18+ (tested with Node 22) and npm.

```bash
npm install
```

```bash
npm run dev
```

Then open the printed URL (default http://localhost:5173). For the optimised,
offline-capable build:

```bash
npm run build
```

```bash
npm run preview
```

`dist/` is a static site: it can be served from any static file server (or
opened from a local server) — there is no backend. After the first visit the
service worker caches the app and the 7 MB engine, so it keeps working
offline.

## Deployment (GitHub Pages)

`.github/workflows/deploy.yml` runs on every push:

1. **Unit tests and production build** – `npm ci`, `npm test`, `npm run build`, then
   uploads `dist/` as the Pages artifact.
2. **End-to-end workflows** – installs Playwright + Chromium and runs
   `npm run e2e` against the production build (screenshots are kept as a
   workflow artifact).
3. **Deploy** – only for pushes to `main`, and only when both jobs pass:
   publishes the build with `actions/deploy-pages`.

One-time repository setting: **Settings → Pages → Build and deployment →
Source: GitHub Actions**. The site is then served at
`https://<owner>.github.io/<repo>/`. The build uses relative asset paths and
hash routing, so it works under that sub-path without configuration, and the
service worker makes it available offline after the first visit.

## Tests

```bash
npm test
```

165 unit/integration tests (Vitest). Highlights: complete legal games, castling /
en passant / promotion, stalemate, insufficient material, threefold vs fivefold
and 50 vs 75-move rules, time forfeit vs insufficient material, clocks; PGN
import (multi-game, comments, NAGs, clocks, variations, errors, `0-0`, FEN
starts) and export round-trip with nested variations; branch creation,
immutability, deletion rules, transpositions, many branches; score
normalisation incl. mates; engine controller cancellation, stale-output
rejection, queue cancellation, pre-emption, crash restart, terminal positions;
**real Stockfish** (the same WASM build, driven over stdio) for mate detection, a
full two-pass game review, Rival move legality and model learning;
classification rules for every class incl. Miss, Great, Brilliant
verification, Book; IndexedDB persistence across reconnects, backups;
Coach takebacks (any move, repeatedly, after the Coach's reply and after the
game ends; original decisions kept, retries marked assisted, transpositions
recognised), specific post-move explanations that never invent a tactic
(hanging pieces, mates, positional costs, honest "no tactic" lines), Show Why /
Best Move / Compare lines, independent vs assisted evidence, unlimited hints
that never reveal the move, prediction
selection / cooldown / mastery, fair grading; Ranked assistance policy,
Glicko-2, Rival learning only from Ranked data (Coach data present in the DB is
ignored), decided positions ignored as evidence, deterministic strategy,
strategy never widening the quality tolerance; openings validated against the
dataset itself (every one of the 3,865 lines named at its final position, book
status along every line; Sicilian, Najdorf, Scandinavian, Italian, Giuoco
Piano, Queen's Gambit, QGA, QGD, King's Indian incl. Orthodox), name hierarchy,
no premature variation names, transpositions (King's Indian via the English,
QGD via 1.Nf3), leaving and re-entering theory, continuation line counts; My
Games and personal statistics counting each game once, only with an
established side, Coach games apart, colour and source filters, early errors
and opening accuracy from reviews; repertoire merging, conflicts, practice with
unlimited retries, opponent deviations, forgotten-move tracking; the database
upgrade keeping existing games, backups including the repertoire, repertoire
PGN round trip; theory branches; no opening aids during Ranked.

End-to-end check in a real browser (requires Playwright with Chromium):

```bash
npm run build && npm run e2e
```

It drives the production build through 20 checks: the Game Review chooser
(initial focus, arrow keys, Tab containment, Escape, focus return);
reconstruction with board and typed moves, undo/redo and reload; a full review
where the board stamp, the move panel and the explanation agree; board flipping
with the stamp staying on its square; rapid replay; move-list auto-scroll on a
longer game; branching (nested branch, engine continuation, naming,
comparison, back to game); persistence and PGN export with variations;
under-promotion through the picker; multi-game PGN import with an illegal
move; a Coach game with six hints, feedback, Show Why / Best Move / Compare
leaving the game untouched, Retry, and takebacks after the Coach's reply
(button and keyboard); the Opening Explorer (no premature names, Najdorf B90,
leaving theory with the last known name kept, honest masters state, engine
only on request), saving a repertoire line and practising it (wrong moves
rejected and not played, Show me, the opponent replying), Review opening
strip at a deep-linked move with the side set, and the Progress openings
tree; Ranked with
every assistive element absent, the app locked, resume after reload,
resignation and rating change; reduced motion; offline use; layouts at 1280,
1024, 820 and 390 px without overflow and with replay controls on screen; and
Coach feedback visible on a phone. Screenshots go to `e2e-shots/`.

## Architecture

```
src/
  chess/      rules & status (FIDE draws, time forfeits), clock, PGN parser/exporter,
              variation tree, transposition-safe position keys
  engine/     UCI parsing, score normalisation, Web Worker transport,
              EngineController (queue, priorities, cancellation, cache, restarts),
              strength ladder for engine opponents
  analysis/   board model + static exchange evaluation, motif detection,
              explanations, opening reference, classification & accuracy, review pipeline
  coach/      Coach session state (attempt log), live classification, learning
              profile & skills, hints, Predict the Opponent
  rival/      Ranked rules, Glicko-2, player model, competitive strategy
  db/         IndexedDB schema, migrations, backup
  services/   glue between logic and storage (games, reviews, Coach, Ranked)
  modes.ts    the single assistance policy every UI element consults
  ui/, pages/ React interface
```

Key decisions:

* **Engine**: Stockfish 17.1 *lite, single-threaded* WASM (≈7 MB) from the
  `stockfish` npm package, served from `public/engine/` and run in a dedicated
  Web Worker. Single-threaded avoids the cross-origin-isolation headers that
  multi-threaded WASM needs, so the static build works on any host. One engine
  instance serves the whole app through a priority queue, so there are never
  competing searches; interactive work pre-empts background review.
* **Rules**: chess.js for legal moves and notation; game termination and draw
  claims are computed by our own FIDE-aware layer.
* **Board**: react-chessboard (drag and click), with our own click-to-move,
  legal-move dots, promotion picker and check highlighting.
* **No cloud AI**: explanations, hints and coaching are generated from verified
  board facts and engine lines. Nothing is sent anywhere.
* **Algorithms**: see [docs/ALGORITHMS.md](docs/ALGORITHMS.md) for exact
  classification rules, accuracy, explanations, Coach profile, hint and
  prediction policies, Rival strength / model / strategy and the rating
  system.

## Licences

* Chess of Life source: public domain (Unlicense, see `LICENSE`).
* **Stockfish** is GPL-3.0. The engine files in `public/engine/` come
  unmodified from the `stockfish` npm package (Stockfish 17.1, stockfish.js
  by Nathan Rugg); the licence text ships as `public/engine/COPYING.txt`.
  Source: https://github.com/official-stockfish/Stockfish and
  https://github.com/nmrugg/stockfish.js. If you redistribute a build that
  includes the engine, the GPL's obligations (licence notice, corresponding
  source) apply to the engine.
* Opening reference: lichess-org/chess-openings, CC0 (`data/openings/`), built
  into `src/data/openings.json` by `npm run openings`. Line counts in the
  Explorer are counts of lines in this list, not of games. No master-game
  database is bundled: none is available under terms that allow
  redistribution in a free offline app, so the Explorer says so instead of
  showing numbers.
* Piece images: "Cburnett" set (CC BY-SA 3.0) bundled by react-chessboard (MIT).
* Typeface: Bricolage Grotesque (SIL Open Font License), bundled via @fontsource.

## Limitations

* The engine is the **lite** NNUE build (smaller network, single thread):
  noticeably weaker than desktop Stockfish, so very deep tactics can be judged
  differently than by a full engine. Default review depths are 10 (quick) and
  16 (deep); raise them in Settings for stronger, slower analysis.
* Repetition history is not sent to the engine (positions are analysed by FEN),
  so engine evaluations can miss that a line repeats. The game rules
  themselves track repetition correctly.
* Explanations are limited to motifs that can be verified on the board (forks,
  pins, skewers, discovered attacks, hanging pieces, removed defenders,
  overloaded defenders, mate and back-rank threats, sacrifices, passed pawns,
  king shelter, material along the engine line). Deeper strategic reasons are
  not invented; the evaluation and line are shown instead.
* Skill and weakness estimates need many decisions before they are reliable;
  the app shows "not enough evidence" / confidence levels instead of guessing.
* The Ranked rating is an **internal** Glicko-2 scale anchored to Rival levels
  (700 + 100·(level − 1)). Those anchors are not calibrated against human
  ratings; do not read it as FIDE or online-site Elo.
* The time-forfeit draw rule uses a conservative test for "cannot checkmate by
  any legal sequence" (lone king, or lone minor piece vs bare king).
* Clocks keep running if you leave a Ranked game (by design); the Rival's
  thinking time counts against its own clock.
* Opening names come only from the catalogued list: positions it does not
  name keep the last name reached on the path, and a game that re-enters
  theory at an unnamed position keeps its earlier name. There are no master
  statistics (see Licences).
* Imported and reconstructed games count in opening statistics only once your
  side is known (set it in the review, or list your PGN names in Settings).
* There is no on-device language model; an optional local LLM layer could be
  added on top of the verified facts in the future.
