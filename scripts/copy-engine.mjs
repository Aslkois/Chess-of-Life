/**
 * Copy the Stockfish WASM engine (lite, single-threaded) from the `stockfish`
 * npm package into public/engine/, together with its GPL licence text.
 * Run after upgrading the `stockfish` dependency: npm run copy-engine
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const src = 'node_modules/stockfish/src';
const files = readdirSync(src);
const js = files.find((f) => /^stockfish-[\d.]+-lite-single-[0-9a-f]+\.js$/.test(f));
if (!js) throw new Error('lite single-threaded Stockfish build not found in node_modules/stockfish/src');
mkdirSync('public/engine', { recursive: true });
copyFileSync(join(src, js), 'public/engine/stockfish.js');
copyFileSync(join(src, js.replace(/\.js$/, '.wasm')), 'public/engine/stockfish.wasm');
copyFileSync('node_modules/stockfish/Copying.txt', 'public/engine/COPYING.txt');
console.log(`Copied ${js} (+ .wasm, licence) to public/engine/`);
