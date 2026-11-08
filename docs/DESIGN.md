# Chess of Life: interface design

## Direction

A chess study at night: evergreen-ink surfaces, a walnut board, ivory pieces of
interface. The board is the stage; everything else is one panel beside it.

* **Ivory means "you are here."** The selected move, the primary action and
  keyboard focus are ivory. Nothing else uses it.
* **Hue means something.** Colour is reserved for move classifications,
  explored branches (violet) and engine lines (steel blue, dashed). The UI
  accent never competes with a rating colour.
* **One primary action per screen.**
* **Motion answers actions.** A piece moves, then its rating lands on the
  square. No ambient animation; everything respects reduced motion.

## Tokens (`src/styles/tokens.css`)

| Role | Value |
|---|---|
| Background / panel / raised | `#0e1412` / `#141b18` / `#1b2420` |
| Ivory (text, selection, primary) | `#ede7d5` |
| Secondary / tertiary text | `#a8ac9f` / `#737b73` |
| Branch / engine / PGN variation | `#b49cf4` / `#8fb2d9` / `#d6c48f` |
| Board marks | last move `rgba(255,233,120,.42)`; planning arrows/marks orange `#f2a33a` (Shift green `#5fb944`, Alt blue `#4f8ef0`, Ctrl red `#e5534b`); premoves violet `#a970d8`, dashed; teaching: threats red, better green, concept orange, plans blue |
| Classifications | brilliant `#1fbfad`, great `#5c93f0`, best `#7fb34a`, excellent `#9ac35c`, good `#93a88b`, book `#b08d66`, inaccuracy `#eec35a`, mistake `#f09b48`, miss `#ef7462`, blunder `#e5443a` |
| Type | Bricolage Grotesque (bundled, OFL) for display, system UI for interface text, tabular numerals for clocks and scores; scale ×1.25 from 14.5 px |
| Spacing | 4 px grid |
| Radii | 5 / 10 / 16 px (outer = 2 × inner) |
| Motion | 120 ms / 200 ms, `cubic-bezier(.2,.7,.2,1)` |

## Layout and breakpoints

| Width | Shell | Board pages |
|---|---|---|
| ≥ 1101 px | full sidebar (224 px) | board sized to the viewport height, panel (392–432 px) beside it |
| 900–1100 px | icon rail with labels (76 px) | board + narrower panel (340 px) |
| 761–899 px | icon rail | board above the panel; replay controls in a fixed bottom dock |
| ≤ 760 px | top bar + drawer | board first, compact move strip, bottom dock, Coach feedback as a bottom sheet |

The board size is computed from the column width and the viewport height so
the board, its player strips and tools fit without page scrolling on desktop.
The panel is pinned to the board column's height and scrolls internally.

## Components

* `ClassIcon` – one drawing per classification (colour **and** shape/glyph),
  sized per context: 14–16 px in notation, 20 px in tables, 28 px in cards,
  ~44 % of a square on the board. Provisional ratings show a dashed inner ring.
* `Board` – drag or click to move, legal-move dots, check highlight, promotion
  picker, and in review only: squares tinted with the move's rating colour and
  the rating stamp at the destination square's top-right corner. The stamp
  appears after the piece animation; during rapid replay it fades in quickly;
  when only the analysis updates it changes colour without replaying.
* `Stage`, `PlayerStrip`, `EvalBar`, `MoveList`, `MoveStrip`, `ReplayControls`,
  `EvalGraph`, `Dialog` / `ConfirmDialog` (native `<dialog>`), `useKeys`.

## Interaction rules

* Game Review has three panel tabs. *Review* follows the original game only.
  Playing a move on the board starts a branch and switches to *Explore*: the
  board frame turns violet and a bar says where the branch left the game, with
  **Back to game** (Esc).
* Keyboard: ← → moves, Home/End, ↑ ↓ key moments, F flips, ? lists shortcuts.
  In the Coach, H asks for the next hint stage, Backspace takes back, Esc
  cancels premoves; in a demonstration ← → Home End step and Space plays or
  pauses.
* Right-click and drag draws a planning arrow, right-click marks a square; a
  left click, the next move or the ✕ on the board clears them. Touch screens
  get a Plan toggle instead. Planning never moves a piece.
* Premoves: during the opponent's turn the player's own pieces can be dragged
  or clicked; the premove shows as a dashed violet arrow and squares, with a
  "Premove … Cancel (Esc)" chip under the board.
* Destructive actions are quiet buttons that open a confirmation whose buttons
  say what happens ("Delete branch" / "Keep branch").
* Disabled controls carry a tooltip that says why.
* During an active Ranked game every assistive element is absent (not hidden)
  and the rest of the app is locked; see `src/modes.ts`.
