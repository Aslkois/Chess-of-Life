/**
 * End-to-end workflow check in a real browser (Chromium via Playwright).
 * Runs the production build through `vite preview` and walks the four
 * product journeys: review, branching exploration, Coach and Ranked.
 *
 *   npm run build && npm run e2e
 *
 * Requires the `playwright` package and a Chromium build to be available.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.error('Install Playwright first: npm i -D playwright && npx playwright install chromium'); process.exit(2); }

const PORT = 4179;
const URL = `http://localhost:${PORT}/`;
const SHOTS = process.env.E2E_SHOTS ?? 'e2e-shots';
mkdirSync(SHOTS, { recursive: true });

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((r) => setTimeout(r, 2500));

let failures = 0;
const results = [];
async function step(name, fn) {
  const t = Date.now();
  try { await fn(); results.push(`PASS ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`); }
  catch (e) {
    failures++;
    results.push(`FAIL ${name}: ${e.message.split('\n')[0]}`);
    const tag = name.split(' ')[0];
    try {
      await page.screenshot({ path: `${SHOTS}/FAILED-${tag}.png` });
      const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 600);
      results.push(`     page: ${page.url()} :: ${text}`);
    } catch { /* ignore */ }
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const sq = (board, s) => page.locator(`[data-testid="${board}"] [data-square="${s}"]`);
async function play(board, moves) {
  for (const m of moves) {
    await sq(board, m.slice(0, 2)).click();
    await sq(board, m.slice(2, 4)).click();
    await page.waitForTimeout(120);
  }
}
async function setFastAnalysis() {
  await page.goto(URL + '#/settings');
  await page.getByRole('button', { name: 'Fast', exact: true }).click();
}

try {
  await page.goto(URL);
  await page.waitForSelector('h1:has-text("Chess of Life")');
  await setFastAnalysis();

  // ---------- Journey A: reconstruct + review ----------
  let gameUrl = '';
  await step('A1 reconstruct a game with undo/redo', async () => {
    await page.goto(URL + '#/reconstruct');
    await play('reconstruct-board', ['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'g8f6']);
    await page.getByTestId('back').click();
    await page.getByTestId('back').click();
    let texts = await page.locator('[data-testid="movelist"] .mv.future').allInnerTexts();
    assert(texts.length === 2, `expected 2 redo moves, got ${texts.length}`);
    await page.getByTestId('forward').click();
    await page.getByTestId('forward').click();
    await page.getByTestId('undo').click(); // removes Nf6
    texts = await page.locator('[data-testid="movelist"] .mv').allInnerTexts();
    assert(texts.length === 5, `expected 5 moves after undo, got ${texts.length}`);
    await play('reconstruct-board', ['g8f6', 'h5f7']);
    texts = await page.locator('[data-testid="movelist"] .mv').allInnerTexts();
    assert(texts.join(' ').includes('Qxf7#'), 'checkmate move missing');
    // the draft survives a reload
    await page.reload();
    await page.waitForSelector('[data-testid="movelist"] .mv');
    assert((await page.locator('[data-testid="movelist"] .mv').count()) === 7, 'draft not restored');
    await page.screenshot({ path: `${SHOTS}/a1-reconstruct.png` });
  });

  await step('A2 review: accuracy, classifications, explanation', async () => {
    await page.getByTestId('review-game').click();
    await page.waitForURL(/#\/review\//);
    gameUrl = page.url();
    await page.waitForSelector('[data-testid="review-complete"]', { timeout: 120000 });
    const accW = await page.getByTestId('accuracy-w').innerText();
    const accB = await page.getByTestId('accuracy-b').innerText();
    assert(parseFloat(accW) > parseFloat(accB), `white accuracy ${accW} should beat black ${accB}`);
    await page.locator('.moves .mv[data-ply="6"]').click();
    const cls = await page.getByTestId('move-class').innerText();
    assert(cls === 'Blunder', `3...Nf6 should be a Blunder, got ${cls}`);
    const expl = await page.getByTestId('explanation').innerText();
    assert(/Qxf7#/.test(expl), 'explanation should mention the mate');
    assert(await page.getByTestId('evalbar').isVisible(), 'eval bar missing in review');
    assert(await page.getByTestId('evalgraph').isVisible(), 'eval graph missing');
    await page.screenshot({ path: `${SHOTS}/a2-review.png` });
  });

  // ---------- Journey B: explore a different future ----------
  await step('B1 branch from the mistake, nested branch, engine continuation', async () => {
    await page.getByTestId('try-alternative').click();
    await play('review-board', ['g7g6']); // instead of 3...Nf6
    await page.waitForSelector('[data-testid="branch-panel"]');
    await page.getByTestId('branch-name').fill('Defend with g6');
    await page.getByTestId('branch-name').blur();
    await play('review-board', ['h5f3']);
    await page.getByTestId('prev').click(); // back to after g6
    await play('review-board', ['h5e2']); // nested alternative
    await page.getByTestId('engine-continue').click();
    await page.waitForFunction(() => document.querySelectorAll('.tree .tm.engine').length >= 4, null, { timeout: 60000 });
    const tree = await page.getByTestId('tree').innerText();
    assert(tree.includes('Qxf7#'), 'original game must remain in the tree');
    assert(tree.includes('g6') && tree.includes('Qf3') && tree.includes('Qe2'), 'branches missing from tree');
    const compare = await page.getByTestId('branch-compare').innerText();
    assert(/Original game/i.test(compare), 'comparison table missing');
    await page.screenshot({ path: `${SHOTS}/b1-tree.png` });
  });

  await step('B2 branches persist; original game unchanged; PGN export has variations', async () => {
    await page.reload();
    await page.getByTestId('tab-tree').click();
    const tree = await page.getByTestId('tree').innerText();
    assert(tree.includes('Defend with g6'), 'branch name not persisted');
    const dl = page.waitForEvent('download');
    await page.getByTestId('export-pgn').click();
    const file = await dl;
    const path = await file.path();
    const pgn = (await import('node:fs')).readFileSync(path, 'utf8');
    (await import('node:fs')).writeFileSync(`${SHOTS}/exported.pgn`, pgn);
    assert(pgn.includes('(3... g6'), 'variation missing from PGN');
    let main = pgn.slice(pgn.indexOf('\n\n')).replace(/\{[^}]*\}/g, '').replace(/\$\d+/g, '');
    while (/\([^()]*\)/.test(main)) main = main.replace(/\([^()]*\)/g, '');
    main = main.replace(/\d+\.(\.\.)?/g, ' ').replace(/\s+/g, ' ').trim();
    assert(main === 'e4 e5 Qh5 Nc6 Bc4 Nf6 Qxf7# 1-0', `mainline altered in PGN: ${main}`);
    assert(pgn.includes('Branch: Defend with g6'), 'branch name missing from PGN');
  });

  // ---------- PGN import ----------
  await step('PGN import: multiple games and error reporting', async () => {
    await page.goto(URL + '#/import');
    await page.getByTestId('pgn-text').fill('[White "A"]\n[Black "B"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 1-0\n\n[White "C"]\n[Black "D"]\n\n1. d4 d5 2. Kd3 *');
    await page.getByTestId('parse-pgn').click();
    const txt = await page.getByTestId('pgn-results').innerText();
    assert(/2 games found/i.test(txt), 'should find two games');
    assert(/illegal or unreadable move "Kd3"/.test(txt), 'illegal move should be reported');
    await page.getByTestId('import-selected').click();
    await page.waitForURL(/#\/library/);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="game-row"]').length >= 3, null, { timeout: 10000 });
  });

  // ---------- Journey C: Coach ----------
  await step('C1 coach: mistake feedback, take back, hint, continue', async () => {
    await page.goto(URL + '#/coach');
    await page.getByTestId('start-coach').click();
    await page.waitForSelector('[data-testid="coach-board"]');
    await play('coach-board', ['e2e3']);
    await page.waitForFunction(() => !document.querySelector('[data-testid="evaluating"]'), null, { timeout: 30000 });
    await page.waitForTimeout(500);
    // wait for coach reply
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="movelist"] .mv').length >= 2, null, { timeout: 60000 });
    await page.getByTestId('hint').click();
    await page.waitForSelector('[data-testid="hints"]');
    const hint = await page.getByTestId('hints').innerText();
    assert(hint.length > 20, 'hint should have text');
    // play deliberately poor moves (preferably hanging a piece) until the Coach intervenes
    const { Chess } = require('chess.js');
    let c;
    for (let tries = 0; tries < 10; tries++) {
      const fen = await page.getByTestId('coach-board').getAttribute('data-fen');
      c = new Chess(fen);
      const moves = c.moves({ verbose: true });
      const hangs = moves.filter((m) => {
        if (m.piece === 'k' || m.piece === 'p') return false;
        const t = new Chess(fen); t.move(m);
        return t.isAttacked(m.to, 'b') && !t.isAttacked(m.to, 'w');
      }).sort((a, b) => ({ q: 0, r: 1, b: 2, n: 3 }[a.piece] - { q: 0, r: 1, b: 2, n: 3 }[b.piece]));
      const rim = moves.filter((m) => /^[ah]/.test(m.to) && m.piece !== 'k');
      const mv = hangs[0] ?? rim[0] ?? moves[0];
      const n0 = await page.locator('[data-testid="movelist"] .mv').count();
      await play('coach-board', [mv.from + mv.to]);
      // either the Coach intervenes, or our move is accepted and the Coach replies
      await page.waitForFunction((k) => document.querySelector('[data-testid="coach-feedback"]') || document.querySelectorAll('[data-testid="movelist"] .mv').length >= k + 2, n0, { timeout: 60000 });
      if (await page.getByTestId('coach-feedback').count()) break;
      await page.waitForFunction(() => (document.querySelector('[data-testid="coach-board"]')?.getAttribute('data-fen') || '').split(' ')[1] === 'w' && !document.body.innerText.includes('The Coach is thinking'), null, { timeout: 60000 });
      if (await page.getByTestId('prediction').count()) await page.getByTestId('skip-prediction').click();
      if (await page.getByTestId('lesson').count()) await page.getByRole('button', { name: 'Got it' }).click();
    }
    await page.waitForSelector('[data-testid="coach-feedback"]', { timeout: 30000 });
    const fb = await page.getByTestId('coach-feedback').innerText();
    assert(/Blunder|Mistake|Miss/.test(fb), `expected a serious error, got: ${fb.slice(0, 80)}`);
    await page.screenshot({ path: `${SHOTS}/c1-coach-feedback.png` });
    const withPending = await page.locator('[data-testid="movelist"] .mv').count();
    await page.getByTestId('take-back').click();
    assert((await page.locator('[data-testid="movelist"] .mv').count()) === withPending - 1, 'takeback should remove the pending move');
    c = new Chess(await page.getByTestId('coach-board').getAttribute('data-fen'));
    const pawnAttacked = (sq) => { const t = new Chess(c.fen()); return t.isAttacked(sq, 'b'); };
    const legal = c.moves({ verbose: true });
    const safe = ['g1f3', 'b1c3', 'd2d4', 'f1e2'].find((u) => legal.some((m) => m.from + m.to === u && !pawnAttacked(m.to)))
      ?? legal.filter((m) => !pawnAttacked(m.to)).map((m) => m.from + m.to)[0] ?? legal[0].from + legal[0].to;
    await play('coach-board', [safe]);
    // the move is rated and the Coach replies (or intervenes again)
    await page.waitForFunction((k) => document.querySelectorAll('[data-testid="movelist"] .mv').length >= k + 1 || document.querySelector('[data-testid="coach-feedback"]'), withPending, { timeout: 60000 });
    if (await page.getByTestId('coach-feedback').count()) { await page.getByTestId('continue').click(); }
    const badges = await page.locator('[data-testid="movelist"] .badge').count();
    assert(badges >= 3, 'coach and player moves should carry ratings');
    const stats = await page.locator('text=takebacks 1').count();
    assert(stats >= 1, 'takeback should be counted');
  });

  // ---------- Journey D: Ranked ----------
  await step('D1 ranked: no assistance during play, lock elsewhere', async () => {
    await page.goto(URL + '#/ranked');
    await page.getByTestId('start-ranked').click();
    await page.waitForSelector('[data-testid="ranked-board"]');
    assert(await page.getByTestId('ranked-live').isVisible(), 'ranked banner missing');
    const board = await page.getByTestId('ranked-board').getAttribute('data-testid');
    assert(board, 'board');
    // whoever moves first, play a few moves
    const iAmBlack = await page.locator('[data-testid="ranked-board"] [data-square="a1"]').evaluate((el) => el.getBoundingClientRect().top < 200);
    if (!iAmBlack) await play('ranked-board', ['e2e4']);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="movelist"] .mv').length >= (1), null, { timeout: 60000 });
    for (const forbidden of ['evalbar', 'evalgraph', 'hint', 'take-back', 'coach-feedback', 'prediction', 'tree', 'explanation']) {
      assert((await page.getByTestId(forbidden).count()) === 0, `${forbidden} must not exist during ranked play`);
    }
    assert((await page.locator('.badge').count()) === 0, 'no classifications during ranked play');
    assert((await page.getByTestId('engine-status').count()) === 0, 'engine activity indicator hidden during ranked');
    await page.screenshot({ path: `${SHOTS}/d1-ranked.png` });
    await page.goto(URL + '#/library');
    assert(await page.locator('text=Ranked match in progress').isVisible(), 'other pages must be locked');
    await page.goto(URL + '#/ranked');
    await page.waitForSelector('[data-testid="ranked-board"]');
    // a reload resumes the same match (and keeps the lock)
    const before = await page.locator('[data-testid="movelist"] .mv').count();
    await page.reload();
    await page.waitForSelector('[data-testid="ranked-board"]');
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="movelist"] .mv').length >= n, before);
    assert(await page.getByTestId('ranked-live').isVisible(), 'match should resume after reload');
  });

  await step('D2 ranked: resign, rating update, post-game analysis unlocked', async () => {
    await page.getByTestId('resign').click();
    await page.getByTestId('confirm-resign').click();
    await page.waitForSelector('[data-testid="ranked-result"]');
    const t = await page.getByTestId('ranked-result').innerText();
    assert(/You lost/.test(t) && /Rating 1200 →/.test(t), `unexpected result text: ${t.slice(0, 120)}`);
    await page.getByTestId('ranked-review').click();
    await page.waitForURL(/#\/review\//);
    await page.waitForSelector('[data-testid="evalbar"]');
  });

  // ---------- offline ----------
  await step('O1 works offline after the first visit (service worker + local engine)', async () => {
    await page.goto(URL + '#/home');
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector('h1:has-text("Chess of Life")', { timeout: 15000 });
    // a brand-new game: every position must be analysed by the local engine
    await page.goto(URL + '#/reconstruct');
    await play('reconstruct-board', ['a2a3', 'h7h6', 'h2h4', 'a7a5', 'b2b4']);
    await page.getByTestId('review-game').click();
    await page.waitForSelector('[data-testid="review-complete"]', { timeout: 120000 });
    await ctx.setOffline(false);
  });

  // ---------- mobile ----------
  await step('M1 narrow mobile layout', async () => {
    // same context (same local data), narrow viewport
    const mp = page;
    await mp.setViewportSize({ width: 390, height: 844 });
    await mp.goto(gameUrl);
    await mp.waitForSelector('[data-testid="review-board"] [data-square="e4"]');
    const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 1, `page scrolls horizontally by ${overflow}px`);
    const bw = await mp.locator('[data-testid="review-board"]').boundingBox();
    assert(bw && bw.width >= 300, 'board too small on mobile');
    await mp.screenshot({ path: `${SHOTS}/m1-review-mobile.png`, fullPage: false });
    await mp.goto(URL + '#/coach');
    await mp.waitForTimeout(800);
    await mp.screenshot({ path: `${SHOTS}/m2-coach-mobile.png` });
    const overflow2 = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow2 <= 1, `coach page scrolls horizontally by ${overflow2}px`);
    await mp.setViewportSize({ width: 1360, height: 900 });
  });
} finally {
  await browser.close();
  server.kill();
}
console.log(results.join('\n'));
if (errors.length) console.log('Browser errors:\n' + [...new Set(errors)].slice(0, 10).join('\n'));
process.exit(failures ? 1 : 0);
