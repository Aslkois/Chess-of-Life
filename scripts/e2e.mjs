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
  await page.getByRole('button', { name: 'Fast', exact: true }).click();

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

  await step('C1 coach: hint, mistake feedback, take back, rated moves', async () => {
    await page.goto(URL + '#/coach');
    await page.getByTestId('start-coach').click();
    await page.waitForSelector('[data-testid="coach-board"]');
    await play('coach-board', ['e2e3']);
    await page.waitForFunction(() => /Your move/.test(document.querySelector('[data-testid="coach-status"]')?.textContent || ''), null, { timeout: 60000 });
    await vis('hint').click();
    await page.waitForSelector('[data-testid="hints"]');
    assert((await page.getByTestId('hints').innerText()).length > 30, 'hint should have text');
    await coachUntilFeedback();
    assert(/Blunder|Mistake|Miss|Inaccuracy/.test(await page.getByTestId('coach-feedback').innerText()), 'feedback should name the rating');
    await page.screenshot({ path: `${SHOTS}/c1-coach-feedback.png` });
    const n = await page.locator(cells).count();
    await page.getByTestId('take-back').click();
    assert((await page.locator(cells).count()) === n - 1, 'takeback should remove the pending move');
    const fen = await page.getByTestId('coach-board').getAttribute('data-fen');
    const legal = new Chess(fen).moves({ verbose: true });
    const safe = legal.find((m) => { const t = new Chess(fen); t.move(m); return !t.isAttacked(m.to, 'b'); }) ?? legal[0];
    await play('coach-board', [safe.from + safe.to]);
    await page.waitForFunction((k) => document.querySelectorAll('[data-testid="movelist"] .ml-cell').length >= k + 1 || document.querySelector('[data-testid="coach-feedback"]'), n - 1, { timeout: 60000 });
    if (await page.getByTestId('coach-feedback').count()) await page.getByTestId('continue').click();
    assert((await page.locator('[data-testid="movelist"] .cls-icon').count()) >= 3, 'moves should carry ratings');
    await page.locator('summary:has-text("This game and your learning profile")').click();
    assert(/1\s*takebacks/.test(await page.locator('details:has(summary:has-text("This game"))').innerText()), 'takeback should be counted');
  });

  // ---------- Journey D ----------
  await step('D1 ranked: no assistance, other sections locked, resume after reload', async () => {
    await page.goto(URL + '#/ranked');
    await page.getByTestId('start-ranked').click();
    await page.waitForSelector('[data-testid="ranked-board"]');
    assert((await page.getByTestId('ranked-live').count()) === 1, 'ranked state missing');
    const orientation = await page.getByTestId('ranked-board').getAttribute('data-orientation');
    if (orientation === 'white') await play('ranked-board', ['e2e4']);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="movelist"] .ml-cell').length >= 1, null, { timeout: 60000 });
    for (const forbidden of ['evalbar', 'evalgraph', 'hint', 'take-back', 'coach-feedback', 'prediction', 'tree', 'explanation', 'board-stamp', 'engine-lines', 'move-card']) {
      assert((await page.getByTestId(forbidden).count()) === 0, `${forbidden} must not exist during ranked play`);
    }
    assert((await page.locator('.cls-icon').count()) === 0, 'no classifications during ranked play');
    assert((await page.getByTestId('engine-status').count()) === 0, 'engine activity hidden during ranked');
    await page.screenshot({ path: `${SHOTS}/d1-ranked.png` });
    await page.goto(URL + '#/library');
    assert(await page.locator('text=Ranked match in progress').isVisible(), 'other pages must be locked');
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
