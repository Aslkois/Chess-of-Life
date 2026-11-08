/**
 * End-to-end checks in a real browser (Chromium via Playwright) against the
 * production build served by `vite preview`.
 *
 *   npm run build && npm run e2e
 *
 * Requires the `playwright` package and a Chromium build.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.error('Install Playwright first: npm i -D playwright && npx playwright install chromium'); process.exit(2); }
const { Chess } = require('chess.js');

const PORT = 4179;
const URL = `http://localhost:${PORT}/`;
const SHOTS = process.env.E2E_SHOTS ?? 'e2e-shots';
mkdirSync(SHOTS, { recursive: true });

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((r) => setTimeout(r, 2500));

let failures = 0;
const results = [];
let page;
async function step(name, fn) {
  const t = Date.now();
  try { await fn(); results.push(`PASS ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`); }
  catch (e) {
    failures++;
    results.push(`FAIL ${name}: ${e.message.split('\n')[0]}`);
    try {
      await page.screenshot({ path: `${SHOTS}/FAILED-${name.split(' ')[0]}.png` });
      results.push(`     page: ${page.url()} :: ${(await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 500)}`);
    } catch { /* ignore */ }
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const sq = (board, s) => page.locator(`[data-testid="${board}"] [data-square="${s}"][data-square-color]`);
const vis = (id) => page.locator(`[data-testid="${id}"]:visible`);
const cells = '[data-testid="movelist"] .ml-cell';
async function play(board, moves) {
  for (const m of moves) {
    await sq(board, m.slice(0, 2)).click();
    await sq(board, m.slice(2, 4)).click();
    await page.waitForTimeout(120);
  }
}

try {
  await page.goto(URL);
  await page.waitForSelector('h1');
  await page.goto(URL + '#/settings');
  await page.getByRole('group', { name: 'Analysis quality' }).getByRole('button', { name: 'Fast', exact: true }).click();

  // ---------- Game Review chooser ----------
  await step('V1 chooser modal: focus, arrow keys, Tab containment, Escape, focus return', async () => {
    await page.goto(URL + '#/home');
    const navBtn = page.getByTestId('nav-review');
    await navBtn.focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="review-chooser"][open]');
    let active = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    assert(active === 'choose-reconstruct', `initial focus should be on the first option, got ${active}`);
    await page.keyboard.press('ArrowRight');
    active = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    assert(active === 'choose-import', `arrow key should move to Import PGN, got ${active}`);
    for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
    const inside = await page.evaluate(() => !!document.activeElement?.closest('dialog[open]'));
    assert(inside, 'Tab must stay inside the dialog');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-testid="review-chooser"][open]'));
    active = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    assert(active === 'nav-review', `focus should return to the trigger, got ${active}`);
    await page.getByTestId('home-review').click();
    await page.getByTestId('choose-reconstruct').click();
    await page.waitForURL(/#\/reconstruct/);
  });

  // ---------- Journey A ----------
  let gameUrl = '';
  await step('A1 reconstruct with undo/redo, typed moves and autosave', async () => {
    await play('reconstruct-board', ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4']);
    await page.getByTestId('typed-move').fill('Nf6');
    await page.getByTestId('typed-move').press('Enter');
    await vis('prev').click();
    await vis('prev').click();
    assert((await page.locator(`${cells}.is-future`).count()) === 2, 'expected 2 redo moves');
    await vis('next').click();
    await vis('next').click();
    await page.getByTestId('undo').click();
    assert((await page.locator(cells).count()) === 5, 'undo should remove the last move');
    await page.getByTestId('typed-move').fill('Kf9');
    await page.getByTestId('typed-move').press('Enter');
    assert(await page.locator('text=is not a legal move').isVisible(), 'illegal typed move should be reported');
    await page.getByTestId('typed-move').fill('');
    await play('reconstruct-board', ['g8f6', 'h5f7']);
    assert((await page.locator(cells).allInnerTexts()).join(' ').includes('Qxf7#'), 'checkmate move missing');
    assert(/Checkmate/i.test(await page.getByTestId('recon-status').innerText()), 'status should say checkmate');
    await page.reload();
    await page.waitForSelector(cells);
    assert((await page.locator(cells).count()) === 7, 'draft not restored');
    await page.screenshot({ path: `${SHOTS}/a1-reconstruct.png` });
  });

  await step('A2 review: accuracy, board stamp in sync with the explanation', async () => {
    await page.getByTestId('review-game').click();
    await page.waitForURL(/#\/review\//);
    gameUrl = page.url();
    await page.waitForSelector('[data-testid="review-complete"]', { timeout: 120000 });
    await page.getByTestId('tab-summary').click();
    const accW = parseFloat(await page.getByTestId('accuracy-w').innerText());
    const accB = parseFloat(await page.getByTestId('accuracy-b').innerText());
    assert(accW > accB, `white accuracy ${accW} should beat black ${accB}`);
    await page.getByTestId('tab-review').click();
    await page.locator(`${cells}[data-ply="6"]`).click();
    assert((await page.getByTestId('move-class').innerText()) === 'Blunder', '3...Nf6 should be a Blunder');
    const stamp = page.getByTestId('board-stamp');
    await stamp.waitFor();
    assert((await stamp.getAttribute('data-cls')) === 'blunder' && (await stamp.getAttribute('data-square')) === 'f6', 'stamp must mark f6 as a blunder');
    assert(/Qxf7#/.test(await page.getByTestId('explanation').innerText()), 'explanation should mention the mate');
    assert(await page.getByTestId('evalbar').isVisible(), 'eval bar missing');
    assert(await page.getByTestId('evalgraph').first().isVisible(), 'eval graph missing');
    // the stamp follows the selected move
    await page.locator(`${cells}[data-ply="7"]`).click();
    assert((await stamp.getAttribute('data-square')) === 'f7', 'stamp should move to the new destination');
    await page.screenshot({ path: `${SHOTS}/a2-review.png` });
  });

  await step('V2 board flip keeps the stamp on the right square', async () => {
    const square = page.locator('[data-testid="review-board"] [data-square="f7"][data-square-color]');
    const center = async (l) => { const b = await l.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width }; };
    const before = await center(page.getByTestId('board-stamp'));
    await page.keyboard.press('f');
    await page.waitForTimeout(400);
    const after = await center(page.getByTestId('board-stamp'));
    const sqc = await center(square);
    assert(Math.abs(after.y - before.y) > 100, 'stamp should move when the board flips');
    assert(Math.abs(after.x - (sqc.x + sqc.w / 2)) < sqc.w * 0.6 && Math.abs(after.y - (sqc.y - sqc.w / 2)) < sqc.w * 0.6, 'stamp should sit at the top-right corner of f7');
    await page.keyboard.press('f');
  });

  await step('V3 rapid replay stays in sync and the move list follows', async () => {
    await page.keyboard.press('Home');
    for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    const cur = page.locator(`${cells}.is-current`);
    assert((await cur.innerText()).includes('Qxf7#'), 'last move should be current');
    assert((await page.getByTestId('board-stamp').getAttribute('data-square')) === 'f7', 'stamp should be on the last move');
    assert((await page.getByTestId('move-card').innerText()).includes('Qxf7#'), 'move card should show the last move');
  });

  // ---------- Journey B ----------
  await step('B1 branch from the mistake, nested branch, engine continuation', async () => {
    await page.locator(`${cells}[data-ply="5"]`).click(); // position before 3...Nf6
    await play('review-board', ['g7g6']);
    await page.waitForSelector('[data-testid="branch-panel"]');
    assert(await page.getByTestId('mode-bar').isVisible(), 'explore mode bar missing');
    assert((await page.getByTestId('review-board').getAttribute('class') ?? '').length >= 0, '');
    await page.getByTestId('branch-name').fill('Defend with g6');
    await page.getByTestId('branch-name').press('Enter');
    await play('review-board', ['h5f3']);
    await vis('prev').click();
    await play('review-board', ['h5e2']);
    await page.getByTestId('engine-continue').click();
    await page.waitForFunction(() => document.querySelectorAll('.tree-move.src-engine').length >= 4, null, { timeout: 60000 });
    const tree = await page.getByTestId('tree').innerText();
    assert(tree.includes('Qxf7#') && tree.includes('g6') && tree.includes('Qf3') && tree.includes('Qe2'), 'tree incomplete');
    assert(/Original game/i.test(await page.getByTestId('branch-compare').innerText()), 'comparison table missing');
    await page.screenshot({ path: `${SHOTS}/b1-tree.png` });
    await page.getByTestId('back-to-game').click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="back-to-game"]'));
  });

  await step('B2 branches persist; PGN export keeps the original game and variations', async () => {
    await page.reload();
    await page.waitForSelector('[data-testid="review-board"]');
    await page.getByTestId('tab-tree').click();
    assert((await page.getByTestId('tree').innerText()).includes('Defend with g6'), 'branch name not persisted');
    const dl = page.waitForEvent('download');
    await page.getByTestId('export-pgn').click();
    const pgn = readFileSync(await (await dl).path(), 'utf8');
    writeFileSync(`${SHOTS}/exported.pgn`, pgn);
    assert(pgn.includes('(3... g6') && pgn.includes('Branch: Defend with g6'), 'variation or branch name missing');
    let main = pgn.slice(pgn.indexOf('\n\n')).replace(/\{[^}]*\}/g, '').replace(/\$\d+/g, '');
    while (/\([^()]*\)/.test(main)) main = main.replace(/\([^()]*\)/g, '');
    main = main.replace(/\d+\.(\.\.)?/g, ' ').replace(/\s+/g, ' ').trim();
    assert(main === 'e4 e5 Qh5 Nc6 Bc4 Nf6 Qxf7# 1-0', `mainline altered: ${main}`);
    await page.getByTestId('tab-review').click();
  });

  await step('V4 promotion through the picker', async () => {
    await page.goto(URL + '#/reconstruct');
    await page.waitForSelector('[data-testid="reconstruct-board"]');
    if (await page.getByTestId('reset').isEnabled()) { await page.getByTestId('reset').click(); await page.getByTestId('reset-dialog-confirm').click(); }
    assert(!(await page.getByTestId('reset').isEnabled()), '"Start over" should be disabled on an empty board');
    await play('reconstruct-board', ['e2e4', 'd7d5', 'e4d5', 'c7c6', 'd5c6', 'g8f6', 'c6b7', 'b8d7']);
    await sq('reconstruct-board', 'b7').click();
    await sq('reconstruct-board', 'a8').click();
    await page.getByTestId('promo-n').click();
    assert((await page.locator(cells).allInnerTexts()).some((t) => t.includes('bxa8=N')), 'under-promotion should be recorded');
    await page.getByTestId('reset').click();
    await page.getByTestId('reset-dialog-confirm').click();
  });

  // ---------- PGN import ----------
  await step('PGN import: multiple games and error reporting', async () => {
    await page.goto(URL + '#/import');
    await page.getByTestId('pgn-text').fill('[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 1-0\n\n[White "C"]\n[Black "D"]\n\n1. d4 d5 2. Kd3 *');
    await page.getByTestId('parse-pgn').click();
    const txt = await page.getByTestId('pgn-results').innerText();
    assert(/2 games found/i.test(txt) && /illegal or unreadable move "Kd3"/.test(txt), 'parse results wrong');
    await page.getByTestId('import-selected').click();
    await page.waitForURL(/#\/library/);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="game-row"]').length >= 3, null, { timeout: 10000 });
  });

  await step('V6 long game: the move list keeps the current move in view', async () => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(URL + '#/import');
    await page.getByTestId('pgn-text').fill('[White "Morphy"]\n[Black "Allies"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0');
    await page.getByTestId('parse-pgn').click();
    await page.getByTestId('import-selected').click();
    await page.waitForURL(/#\/review\//);
    await page.waitForSelector(cells);
    await page.getByTestId('tab-review').click();
    const inView = async () => {
      const list = await page.getByTestId('movelist').boundingBox();
      const cur = await page.locator(`${cells}.is-current`).boundingBox();
      return list && cur && cur.y >= list.y - 1 && cur.y + cur.height <= list.y + list.height + 1;
    };
    await page.keyboard.press('End');
    await page.waitForTimeout(250);
    assert(await inView(), 'last move should be scrolled into view');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(250);
    assert(await inView(), 'first move should be scrolled into view');
    const scroll = await page.evaluate(() => window.scrollY);
    assert(scroll === 0, `the page itself should not scroll (scrollY ${scroll})`);
    await page.setViewportSize({ width: 1360, height: 900 });
  });

  // ---------- Journey C ----------
  async function coachUntilFeedback(board = 'coach-board') {
    for (let tries = 0; tries < 10; tries++) {
      await page.waitForFunction(() => document.querySelector('[data-testid="coach-feedback"]') || (/Your move/.test(document.querySelector('[data-testid="coach-status"]')?.textContent || '')) || document.querySelector('[data-testid="prediction"]'), null, { timeout: 60000 });
      if (await page.getByTestId('coach-feedback').count()) return;
      if (await page.getByTestId('prediction').count()) { await page.getByTestId('skip-prediction').click(); continue; }
      const fen = await page.getByTestId(board).getAttribute('data-fen');
      const c = new Chess(fen);
      const moves = c.moves({ verbose: true });
      const hangs = moves.filter((m) => { if (m.piece === 'k' || m.piece === 'p') return false; const t = new Chess(fen); t.move(m); return t.isAttacked(m.to, 'b') && !t.isAttacked(m.to, 'w'); })
        .sort((a, b) => ({ q: 0, r: 1, b: 2, n: 3 }[a.piece] - { q: 0, r: 1, b: 2, n: 3 }[b.piece]));
      const mv = hangs[0] ?? moves.find((m) => /^[ah]/.test(m.to) && m.piece !== 'k') ?? moves[0];
      await play(board, [mv.from + mv.to]);
      await page.waitForTimeout(300);
    }
    throw new Error('the Coach never intervened');
  }

  await step('C1 coach: unlimited hints, specific feedback, Show Why / Best / Compare, Retry, takeback after the reply', async () => {
    await page.goto(URL + '#/coach');
    await page.getByTestId('start-coach').click();
    await page.waitForSelector('[data-testid="coach-board"]');
    await play('coach-board', ['e2e3']);
    await page.waitForFunction(() => /Your move/.test(document.querySelector('[data-testid="coach-status"]')?.textContent || ''), null, { timeout: 60000 });
    // three hint stages for this position, then no more
    await vis('hint').click();
    await page.waitForSelector('[data-testid="hint-stage-1"]', { timeout: 30000 });
    assert(/Hint 2 of 3/.test(await vis('hint').innerText()), 'the button names the next stage');
    await vis('hint').click();
    await page.waitForSelector('[data-testid="hint-stage-2"]');
    const pieceSq = (await page.getByTestId('hint-stage-2').innerText()).match(/on ([a-h][1-8])/)[1];
    await vis('hint').click();
    await page.waitForSelector('[data-testid="hint-stage-3"]');
    const s3 = await page.getByTestId('hint-stage-3').innerText();
    assert(/Best move/.test(s3) && /Engine line/.test(s3), `stage 3 shows the move and why: ${s3}`);
    assert(await vis('hint').isDisabled(), 'no fourth hint');
    assert(/All hints revealed/.test(await vis('hint').innerText()), 'All hints revealed');
    assert((await page.locator('[data-testid="hints"] li').count()) === 3, 'exactly three stages');
    await page.screenshot({ path: `${SHOTS}/c1-coach-hints.png` });
    // play the revealed best move: hints start again in the next position
    const hintFen = await page.getByTestId('coach-board').getAttribute('data-fen');
    const best = new Chess(hintFen).moves({ verbose: true }).find((m) => m.from === pieceSq && s3.includes(m.san));
    assert(best, 'the revealed move is legal and uses the hinted piece');
    await play('coach-board', [best.from + best.to + (best.promotion ?? '')]);
    await page.waitForFunction(() => /Your move/.test(document.querySelector('[data-testid="coach-status"]')?.textContent || '') || document.querySelector('[data-testid="coach-feedback"] [data-testid="continue"]'), null, { timeout: 60000 });
    if (await page.getByTestId('continue').count()) await page.getByTestId('continue').click();
    await page.waitForFunction(() => /Your move/.test(document.querySelector('[data-testid="coach-status"]')?.textContent || ''), null, { timeout: 60000 });
    assert(/^\s*Hint\s*$/.test(await vis('hint').innerText()) && await vis('hint').isEnabled(), 'hints reset in the new position');
    await coachUntilFeedback();
    const fbText = await page.getByTestId('coach-feedback').innerText();
    assert(/Blunder|Mistake|Miss|Inaccuracy/.test(fbText), 'feedback should name the rating');
    assert((await page.getByTestId('teach-point').count()) >= 1, 'feedback should have concrete points');
    await page.screenshot({ path: `${SHOTS}/c1-coach-feedback.png` });
    const gameFen = await page.getByTestId('coach-board').getAttribute('data-fen');
    const n = await page.locator(cells).count();
    // Show Why: a demonstration that does not touch the game
    if (await page.getByTestId('show-why').count()) {
      await page.getByTestId('show-why').click();
      await page.waitForSelector('[data-testid="demo"]');
      await page.getByTestId('demo-next').click();
      assert((await page.getByTestId('demo-play').getAttribute('aria-pressed')) === 'false', 'manual navigation pauses playback');
      const demoFen = await page.getByTestId('coach-board').getAttribute('data-fen');
      assert(demoFen !== gameFen, 'the demonstration should show a different position');
      const nMoves = await page.getByTestId('demo-move').count();
      assert(nMoves >= 1 && /\d+\./.test(await page.getByTestId('demo-notation').innerText()), 'notation with move numbers');
      await page.getByTestId('demo-move').nth(nMoves - 1).click();
      assert((await page.getByTestId('demo-move').nth(nMoves - 1).getAttribute('aria-current')) === 'step', 'clicking a move jumps to it and highlights it');
      await page.getByTestId('demo-first').click();
      assert((await page.locator('[data-testid="demo-notation"] .is-start').getAttribute('aria-current')) === 'step', 'First returns to the start of the line');
      await page.getByTestId('demo-speed-2').click();
      await page.getByTestId('demo-replay').click();
      await page.waitForFunction((n) => document.querySelector(`[data-testid="demo-move"]:nth-of-type(1)`) && [...document.querySelectorAll('[data-testid="demo-move"]')].at(-1)?.getAttribute('aria-current') === 'step', nMoves, { timeout: 15000 });
      assert((await page.getByTestId('demo-play').getAttribute('aria-pressed')) === 'false', 'playback stops at the end');
      assert((await page.getByTestId('demo').count()) === 1, 'the line stays visible after playback');
      await page.getByTestId('demo-prev').click();
      await page.getByTestId('demo-last').click();
      assert(await page.getByTestId('coach-board').evaluate((el) => el.classList.contains('is-demo')), 'the board is marked as a demonstration');
      assert((await page.locator('[data-testid="coach-board"] svg path, [data-testid="coach-board"] svg line').count()) >= 0, 'arrows');
      await page.screenshot({ path: `${SHOTS}/c1-coach-show-why.png` });
      await page.getByTestId('demo-prev').click();
      await page.getByTestId('demo-return').click();
      assert((await page.getByTestId('coach-board').getAttribute('data-fen')) === gameFen, 'Return should restore the game position');
      assert((await page.locator(cells).count()) === n, 'a demonstration must not change the game');
    }
    if (await page.getByTestId('best-move').count()) {
      await page.getByTestId('best-move').click();
      await page.waitForSelector('[data-testid="demo"]');
      assert(/Better was/.test(await page.getByTestId('demo').innerText()), 'best line title');
      await page.screenshot({ path: `${SHOTS}/c1-coach-best.png` });
      await page.keyboard.press('Escape');
      assert((await page.getByTestId('demo').count()) === 0, 'Escape leaves the demonstration');
    }
    if (await page.getByTestId('compare').count()) {
      await page.getByTestId('compare').click();
      await page.waitForSelector('[data-testid="compare-view"]');
      await page.screenshot({ path: `${SHOTS}/c1-coach-compare.png` });
      await page.getByTestId('compare-return').click();
    }
    assert((await page.getByTestId('coach-board').getAttribute('data-fen')) === gameFen, 'the game position is preserved');
    await page.getByTestId('take-back').click(); // Retry
    assert((await page.locator(cells).count()) === n - 1, 'Retry should remove the pending move');
    let fen = await page.getByTestId('coach-board').getAttribute('data-fen');
    let legal = new Chess(fen).moves({ verbose: true });
    let safe = legal.find((m) => { const t = new Chess(fen); t.move(m); return !t.isAttacked(m.to, 'b'); }) ?? legal[0];
    await play('coach-board', [safe.from + safe.to]);
    // wait for the Coach's reply (or feedback, which we accept)
    await page.waitForFunction((k) => document.querySelectorAll('[data-testid="movelist"] .ml-cell').length >= k + 1 || document.querySelector('[data-testid="coach-feedback"] [data-testid="continue"]'), n, { timeout: 60000 });
    if (await page.getByTestId('continue').count()) await page.getByTestId('continue').click();
    await page.waitForFunction((k) => document.querySelectorAll('[data-testid="movelist"] .ml-cell').length >= k + 1 && /Your move/.test(document.querySelector('[data-testid="coach-status"]')?.textContent || ''), n, { timeout: 60000 });
    const m = await page.locator(cells).count();
    assert((await page.locator('[data-testid="movelist"] .cls-icon').count()) >= 3, 'moves should carry ratings');
    // take back after the Coach has replied: both moves go, no confirmation
    await vis('takeback').click();
    await page.waitForFunction((k) => document.querySelectorAll('[data-testid="movelist"] .ml-cell').length === k - 2, m, { timeout: 10000 });
    assert(/Your move/.test(await page.getByTestId('coach-status').innerText()), 'it is the player’s move again');
    // and once more (keyboard)
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Backspace');
    await page.waitForFunction((k) => document.querySelectorAll('[data-testid="movelist"] .ml-cell').length === k - 4, m, { timeout: 10000 });
    await page.locator('summary:has-text("This game and your learning profile")').click();
    assert(/3\s*takebacks/.test(await page.locator('details:has(summary:has-text("This game"))').innerText()), 'all takebacks should be counted');
  });

  await step('C2 premoves in the Coach: queued during its turn, played when legal, cancelled with Escape', async () => {
    await page.goto(URL + '#/coach');
    await page.waitForSelector('[data-testid="coach-board"]');
    await page.locator('.panel-foot button[aria-label="Resign"]').click();
    await page.locator('dialog[open] button:has-text("Resign game")').click();
    await page.locator('button:has-text("New Coach game")').first().click();
    await page.waitForSelector('[data-testid="coach-board"]');
    const orient = await page.getByTestId('coach-board').getAttribute('data-orientation');
    if (orient === 'black') {
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="movelist"] .ml-cell').length >= 1, null, { timeout: 60000 });
    }
    const fen0 = await page.getByTestId('coach-board').getAttribute('data-fen');
    const me = new Chess(fen0).turn();
    const [mv, pre] = me === 'w' ? ['e2e4', 'g1f3'] : ['g8f6', 'b8c6'];
    await play('coach-board', [mv]);
    await play('coach-board', [pre]);
    await page.waitForSelector('[data-testid="premove-status"]', { timeout: 5000 });
    assert((await page.getByTestId('coach-board').getAttribute('data-premoves')) === '1', 'one premove queued and shown');
    await page.screenshot({ path: `${SHOTS}/c2-premove.png` });
    const before = await page.locator(cells).count();
    await page.waitForFunction((k) => document.querySelectorAll('[data-testid="movelist"] .ml-cell').length >= k + 2, before, { timeout: 60000 });
    const last = (await page.locator(cells).last().innerText()).trim();
    assert(/^N[fc][36]/.test(last), `the premove was played after the Coach's reply: ${last}`);
    // queue another during the Coach's turn and cancel it
    const fen1 = await page.getByTestId('coach-board').getAttribute('data-fen');
    if (new Chess(fen1).turn() !== me) {
      await play('coach-board', [me === 'w' ? 'b1c3' : 'e7e6']);
      await page.waitForSelector('[data-testid="premove-status"]', { timeout: 3000 });
      await page.keyboard.press('Escape');
      assert((await page.getByTestId('premove-status').count()) === 0, 'Escape cancels premoves');
    }
  });

  // ---------- Journey E: openings ----------
  await step('E1 opening explorer: names, book status, theory, engine only on request, masters honest', async () => {
    await page.goto(URL + '#/openings');
    await page.waitForSelector('[data-testid="opening-explorer"]');
    assert(/Starting position/.test(await page.getByTestId('opening-name').innerText()), 'start position has no opening name');
    for (const m of ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3']) await play('explorer-board', [m]);
    let name = await page.getByTestId('opening-name').innerText();
    assert(/Sicilian Defense/.test(name) && !/Najdorf/.test(name), `no premature variation name: ${name}`);
    await play('explorer-board', ['a7a6']);
    name = await page.getByTestId('opening-name').innerText();
    assert(/Najdorf Variation/.test(name) && /B90/.test(name) && /Catalogued position/.test(name), `Najdorf B90 expected: ${name}`);
    assert(/e2e4,c7c5/.test(page.url()), 'the address follows the position');
    assert((await page.getByTestId('continuation').count()) >= 5, 'catalogued continuations listed');
    await page.screenshot({ path: `${SHOTS}/e1-explorer.png` });
    // leave theory
    await play('explorer-board', ['h2h4']);
    assert(/Outside the catalogued theory since 6\.h4/.test(await page.getByTestId('opening-name').innerText()), 'leaving theory is reported');
    assert(/Najdorf/.test(await page.getByTestId('opening-name').innerText()), 'last known identity kept');
    await page.keyboard.press('ArrowLeft');
    await page.getByTestId('pane-masters').click();
    assert(/not included/.test(await page.getByTestId('masters-unavailable').innerText()), 'masters: honest unavailable state');
    await page.getByTestId('pane-engine').click();
    assert((await page.getByTestId('engine-lines-explorer').count()) === 0, 'no engine output before it is requested');
    await page.getByTestId('analyse-position').click();
    await page.waitForSelector('[data-testid="engine-lines-explorer"]', { timeout: 60000 });
    await page.getByTestId('pane-mine').click();
    await page.waitForSelector('[data-testid="my-games"]');
  });

  await step('E2 repertoire and practice: save a line, unlimited retries, opponent replies', async () => {
    await page.getByTestId('add-to-repertoire').click();
    await page.getByTestId('save-line-confirm').click();
    await page.goto(URL + '#/openings/repertoire');
    await page.waitForSelector('[data-testid="rep-line"]');
    assert(/Najdorf/.test(await page.getByTestId('rep-line').first().innerText()), 'line saved');
    await page.getByTestId('practise-b').click();
    await page.waitForFunction(() => /Your move/.test(document.querySelector('[data-testid="practice-status"]')?.textContent || ''), null, { timeout: 10000 });
    for (let i = 0; i < 3; i++) await play('practice-board', ['e7e5']);
    assert(/not in your line/.test(await page.getByTestId('practice-note').innerText()), 'wrong move rejected');
    assert((await page.locator('[data-testid="practice-moves"] .ml-cell').count()) === 1, 'the wrong move is not played');
    await page.getByTestId('practice-show').click();
    assert(/c5/.test(await page.getByTestId('practice-note').innerText()), 'Show me reveals the prepared move');
    await play('practice-board', ['c7c5']);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="practice-moves"] .ml-cell').length >= 3, null, { timeout: 10000 });
    await page.screenshot({ path: `${SHOTS}/e2-practice.png` });
  });

  await step('E3 review and progress: opening per position, your side, personal statistics', async () => {
    await page.goto(URL + '#/import');
    await page.getByTestId('pgn-text').fill('[White "alice99"]\n[Black "Bob"]\n[Date "2026.03.04"]\n[Result "1-0"]\n\n1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6 6. h4 e5 7. Nf3 Be7 1-0');
    await page.getByTestId('parse-pgn').click();
    await page.getByTestId('import-selected').click();
    await page.waitForURL(/#\/review\//);
    const id = page.url().split('/review/')[1].split('/')[0];
    await page.goto(URL + `#/review/${id}/10`);
    await page.waitForSelector('[data-testid="review-opening"]');
    let op = await page.getByTestId('review-opening').innerText();
    assert(/Najdorf/.test(op) && /Book/.test(op), `review opening at 5...a6: ${op}`);
    await page.keyboard.press('ArrowRight');
    op = await page.getByTestId('review-opening').innerText();
    assert(/Out of book/.test(op) && /leaves the catalogued theory/.test(op) && /not a mistake in itself/.test(op), `leaving theory explained: ${op}`);
    await page.getByTestId('game-side').selectOption('w');
    await page.screenshot({ path: `${SHOTS}/e3-review-opening.png` });
    await page.goto(URL + '#/profile');
    await page.getByTestId('progress-openings').click();
    await page.waitForSelector('[data-testid="opening-stats"]');
    assert(/Sicilian Defense/.test(await page.getByTestId('opening-stats').innerText()), 'the game counts once its side is known');
    await page.getByTestId('op-node').first().click();
    assert(/6\.h4/.test(await page.getByTestId('op-detail').innerText()), 'where theory was left is shown');
    await page.screenshot({ path: `${SHOTS}/e3-progress-openings.png` });
  });

  await step('P1 planning arrows: right-click draws, toggles and marks without moving pieces; sounds per event', async () => {
    await page.goto(URL + '#/openings/explore');
    await page.waitForSelector('[data-testid="explorer-board"]');
    await page.evaluate(() => { window.__cm = []; window.addEventListener('contextmenu', (e) => setTimeout(() => window.__cm.push(e.defaultPrevented))); });
    const fen0 = await page.getByTestId('explorer-board').getAttribute('data-fen');
    const box = async (sqr) => sq('explorer-board', sqr).boundingBox();
    const rdrag = async (a, b) => {
      const A = await box(a); const B = await box(b);
      await page.mouse.move(A.x + A.width / 2, A.y + A.height / 2);
      await page.mouse.down({ button: 'right' });
      await page.mouse.move(B.x + B.width / 2, B.y + B.height / 2, { steps: 4 });
      await page.mouse.up({ button: 'right' });
    };
    await rdrag('e2', 'e4');
    await rdrag('g1', 'f3');
    await rdrag('d7', 'd5');
    let ann = Number(await page.getByTestId('explorer-board').getAttribute('data-annotations'));
    assert(ann === 3, `three arrows drawn (${ann})`);
    assert((await page.locator('[data-testid="explorer-board"] [data-testid="plan-arrow"]').count()) === 3, 'arrows rendered');
    await rdrag('d7', 'd5'); // the same arrow again removes it
    await rdrag('e5', 'e5'); // a single square is marked
    ann = Number(await page.getByTestId('explorer-board').getAttribute('data-annotations'));
    assert(ann === 3, `toggle and mark (${ann})`);
    assert((await page.getByTestId('explorer-board').getAttribute('data-fen')) === fen0, 'no piece moved');
    const cm = await page.evaluate(() => window.__cm);
    assert(cm.length > 0 && cm.every(Boolean), 'the browser context menu is suppressed on the board');
    await page.screenshot({ path: `${SHOTS}/p1-planning.png` });
    await page.getByTestId('clear-annotations').click();
    assert((await page.getByTestId('explorer-board').getAttribute('data-annotations')) === '0', 'clear removes everything');
    await rdrag('e2', 'e4');
    const s0 = await page.evaluate(() => window.__chessOfLifeSounds.total);
    await play('explorer-board', ['e2e4', 'd7d5', 'e4d5', 'd8d5', 'b1c3', 'd5e5']);
    assert((await page.getByTestId('explorer-board').getAttribute('data-annotations')) === '0', 'annotations clear after a move');
    await play('explorer-board', ['f1e2', 'e5e2']);
    const played = await page.evaluate((n) => window.__chessOfLifeSounds.played.slice(-(window.__chessOfLifeSounds.total - n)), s0);
    // 1.e4 d5 2.exd5 Qxd5 3.Nc3 Qe5+ 4.Be2 Qxe2+
    assert(JSON.stringify(played) === JSON.stringify(['move', 'move', 'capture', 'capture', 'move', 'check', 'move', 'check']), `one sound per move, by event: ${played}`);
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(60);
    const back = await page.evaluate(() => window.__chessOfLifeSounds.played.at(-1));
    assert(back === 'move', 'stepping back plays a move sound');
  });

  await step('S1 gameplay settings persist and apply without a reload', async () => {
    await page.goto(URL + '#/settings');
    await page.locator('[data-testid="pref-speed"] button:has-text("Fast")').click();
    await page.getByTestId('pref-multi-premoves').check();
    await page.getByTestId('pref-volume').fill('40');
    await page.getByTestId('pref-sound').uncheck();
    await page.waitForTimeout(300);
    await page.reload();
    await page.waitForSelector('[data-testid="pref-speed"]');
    assert((await page.locator('[data-testid="pref-speed"] button:has-text("Fast")').getAttribute('aria-pressed')) === 'true', 'speed persisted');
    assert(await page.getByTestId('pref-multi-premoves').isChecked(), 'multiple premoves persisted');
    assert(!(await page.getByTestId('pref-sound').isChecked()), 'sound off persisted');
    assert((await page.getByTestId('pref-volume').inputValue()) === '40', 'volume persisted');
    // sound off applies immediately
    await page.goto(URL + '#/openings/explore');
    await page.waitForSelector('[data-testid="explorer-board"]');
    const n0 = await page.evaluate(() => window.__chessOfLifeSounds.total);
    await play('explorer-board', ['e2e4']);
    assert((await page.evaluate(() => window.__chessOfLifeSounds.total)) === n0, 'no sound when sound effects are off');
    await page.goto(URL + '#/settings');
    await page.getByTestId('pref-sound').check();
    await page.locator('[data-testid="pref-speed"] button:has-text("Natural")').click();
    await page.getByTestId('pref-multi-premoves').uncheck();
    await page.getByTestId('pref-volume').fill('70');
  });

  // ---------- Journey D ----------
  await step('D1 ranked: no assistance, other sections locked, resume after reload', async () => {
    await page.goto(URL + '#/ranked');
    await page.getByTestId('start-ranked').click();
    await page.waitForSelector('[data-testid="ranked-board"]');
    assert((await page.getByTestId('ranked-live').count()) === 1, 'ranked state missing');
    const orientation = await page.getByTestId('ranked-board').getAttribute('data-orientation');
    // a premove made while the Rival thinks is played as soon as it is legal
    if (orientation === 'white') { await play('ranked-board', ['e2e4']); await play('ranked-board', ['g1f3']); }
    else { await page.waitForFunction(() => document.querySelectorAll('[data-testid="movelist"] .ml-cell').length >= 1, null, { timeout: 60000 }); await play('ranked-board', ['g8f6']); await play('ranked-board', ['b8c6']); }
    const premoved = await page.getByTestId('premove-status').count();
    await page.waitForFunction((k) => document.querySelectorAll('[data-testid="movelist"] .ml-cell').length >= k || /Premove cancelled/.test(document.body.innerText), orientation === 'white' ? 3 : 4, { timeout: 60000 });
    if (premoved && !(await page.locator('text=Premove cancelled').count())) {
      const lastSan = (await page.locator(cells).last().innerText()).trim();
      assert(/^N[fc][36]/.test(lastSan), `the Ranked premove was played: ${lastSan}`);
    }
    for (const forbidden of ['evalbar', 'evalgraph', 'hint', 'hint-mobile', 'take-back', 'takeback', 'takeback-mobile', 'coach-feedback', 'show-why', 'best-move', 'compare', 'demo', 'prediction', 'tree', 'explanation', 'board-stamp', 'engine-lines', 'move-card', 'opening-name', 'opening-explorer', 'review-opening', 'coach-opening-note', 'theory-branches']) {
      assert((await page.getByTestId(forbidden).count()) === 0, `${forbidden} must not exist during ranked play`);
    }
    assert((await page.locator('.cls-icon').count()) === 0, 'no classifications during ranked play');
    assert((await page.getByTestId('engine-status').count()) === 0, 'engine activity hidden during ranked');
    await page.screenshot({ path: `${SHOTS}/d1-ranked.png` });
    await page.goto(URL + '#/library');
    assert(await page.locator('text=Ranked match in progress').isVisible(), 'other pages must be locked');
    await page.goto(URL + '#/openings/explore/e2e4');
    assert(await page.locator('text=Ranked match in progress').isVisible(), 'the Opening Explorer is locked during Ranked play');
    assert((await page.getByTestId('opening-explorer').count()) === 0, 'no explorer during Ranked play');
    assert((await page.getByTestId('nav-openings').count()) === 0, 'the Openings link is disabled');
    await page.goto(URL + '#/ranked');
    const before = await page.locator(cells).count();
    await page.reload();
    await page.waitForSelector('[data-testid="ranked-board"]');
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="movelist"] .ml-cell').length >= n, before);
    assert((await page.getByTestId('ranked-live').count()) === 1, 'match should resume after reload');
  });

  await step('D2 ranked: resign, rating change, analysis unlocks', async () => {
    await vis('resign').click();
    await page.getByTestId('confirm-resign-dialog-confirm').click();
    await page.waitForSelector('[data-testid="ranked-result"]');
    const t = await page.getByTestId('ranked-result').innerText();
    assert(/You lost/.test(t) && /1200/.test(t), `unexpected result: ${t.slice(0, 120)}`);
    await page.screenshot({ path: `${SHOTS}/d2-ranked-result.png` });
    await page.getByTestId('ranked-review').click();
    await page.waitForURL(/#\/review\//);
    await page.waitForSelector('[data-testid="evalbar"]');
  });

  // ---------- motion ----------
  await step('V5 reduced motion: ratings appear without animation', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(gameUrl);
    await page.waitForSelector('[data-testid="review-board"]');
    await page.getByTestId('tab-review').click();
    await page.locator(`${cells}[data-ply="6"]`).click();
    const cls = await page.getByTestId('board-stamp').getAttribute('class');
    assert(!/is-anim|is-quick/.test(cls), `stamp should not animate, got "${cls}"`);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.reload();
    await page.waitForSelector('[data-testid="review-board"]');
    await page.locator(`${cells}[data-ply="4"]`).click();
    await page.waitForTimeout(400);
    await page.locator(`${cells}[data-ply="6"]`).click();
    assert(/is-anim/.test(await page.getByTestId('board-stamp').getAttribute('class')), 'stamp should animate normally');
  });

  // ---------- offline ----------
  await step('O1 works offline after the first visit', async () => {
    await page.goto(URL + '#/home');
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector('h1', { timeout: 15000 });
    await page.goto(URL + '#/reconstruct');
    await play('reconstruct-board', ['a2a3', 'h7h6', 'h2h4', 'a7a5', 'b2b4']);
    await page.getByTestId('review-game').click();
    await page.waitForSelector('[data-testid="review-complete"]', { timeout: 120000 });
    await ctx.setOffline(false);
  });

  // ---------- responsive ----------
  await step('M1 layouts at 1280, 1024, 820 and 390 px without overflow', async () => {
    for (const [w, h] of [[1280, 800], [1024, 768], [820, 1180], [390, 844]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(gameUrl);
      await page.waitForSelector('[data-testid="review-board"] [data-square="e4"]');
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(overflow <= 1, `horizontal overflow ${overflow}px at ${w}px`);
      const bw = await page.locator('[data-testid="review-board"]').boundingBox();
      assert(bw && bw.width >= Math.min(300, w - 90), `board too small at ${w}px`);
      const nextBtn = vis('next');
      assert(await nextBtn.count() >= 1, `replay controls not reachable at ${w}px`);
      const nb = await nextBtn.first().boundingBox();
      assert(nb && nb.y + nb.height <= h + 1, `replay controls below the fold at ${w}px`);
      await page.screenshot({ path: `${SHOTS}/m-review-${w}.png` });
      for (const route of ['#/openings/explore/e2e4,c7c5', '#/openings/repertoire', '#/openings/practice', '#/profile']) {
        await page.goto(URL + route);
        await page.waitForTimeout(400);
        const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert(o <= 1, `${route} overflows by ${o}px at ${w}px`);
      }
      if (w === 390) await page.goto(URL + '#/openings/explore/e2e4,c7c5').then(() => page.waitForTimeout(400)).then(() => page.screenshot({ path: `${SHOTS}/m-explorer-390.png`, fullPage: true }));
    }
  });

  await step('M2 phone: Coach feedback is on screen without scrolling', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(URL + '#/coach');
    await page.waitForSelector('[data-testid="coach-board"]');
    await coachUntilFeedback();
    const fb = await page.getByTestId('coach-feedback').boundingBox();
    assert(fb && fb.y >= 0 && fb.y + 40 < 844, 'feedback should be visible in the viewport');
    const tb = await page.getByTestId('take-back').boundingBox();
    assert(tb && tb.y + tb.height <= 844 && tb.height >= 44, 'Take back must be reachable and touch-sized');
    await page.screenshot({ path: `${SHOTS}/m2-coach-feedback-phone.png` });
    await page.getByTestId('continue').click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 1, `coach page overflows by ${overflow}px`);
    await page.setViewportSize({ width: 1360, height: 900 });
  });
} finally {
  await browser.close();
  server.kill();
}
console.log(results.join('\n'));
if (errors.length) console.log('Browser errors:\n' + [...new Set(errors)].slice(0, 10).join('\n'));
process.exit(failures ? 1 : 0);
