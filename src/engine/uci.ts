import type { Score } from './score';
import { normalizeScore } from './score';

export interface PvLine {
  multipv: number;
  depth: number;
  score: Score;
  /** UCI moves */
  pv: string[];
}

export interface InfoLine extends PvLine {
  seldepth?: number;
  nodes?: number;
  nps?: number;
  time?: number;
  bound?: 'lower' | 'upper';
}

/** Parse a UCI "info" line. Returns null for info lines without a score/pv (currmove, string...). */
export function parseInfo(line: string, sideToMove: 'w' | 'b'): InfoLine | null {
  if (!line.startsWith('info ')) return null;
  const tok = line.split(/\s+/);
  let depth: number | undefined;
  let multipv = 1;
  let raw: { cp?: number; mate?: number } | undefined;
  let bound: 'lower' | 'upper' | undefined;
  let pv: string[] = [];
  const out: Partial<InfoLine> = {};
  for (let i = 1; i < tok.length; i++) {
    const t = tok[i];
    switch (t) {
      case 'depth': depth = parseInt(tok[++i], 10); break;
      case 'seldepth': out.seldepth = parseInt(tok[++i], 10); break;
      case 'multipv': multipv = parseInt(tok[++i], 10); break;
      case 'nodes': out.nodes = parseInt(tok[++i], 10); break;
      case 'nps': out.nps = parseInt(tok[++i], 10); break;
      case 'time': out.time = parseInt(tok[++i], 10); break;
      case 'hashfull': case 'tbhits': case 'currmovenumber': case 'cpuload': i++; break;
      case 'currmove': i++; break;
      case 'score': {
        const kind = tok[++i];
        const val = parseInt(tok[++i], 10);
        raw = kind === 'mate' ? { mate: val } : { cp: val };
        if (tok[i + 1] === 'lowerbound') { bound = 'lower'; i++; }
        else if (tok[i + 1] === 'upperbound') { bound = 'upper'; i++; }
        break;
      }
      case 'wdl': i += 3; break;
      case 'pv': pv = tok.slice(i + 1); i = tok.length; break;
      case 'string': i = tok.length; break;
      default: break;
    }
  }
  if (depth === undefined || !raw || pv.length === 0) return null;
  return { ...out, depth, multipv, score: normalizeScore(raw, sideToMove), pv, bound } as InfoLine;
}

export function parseBestmove(line: string): { bestmove: string | null; ponder?: string } | null {
  if (!line.startsWith('bestmove')) return null;
  const tok = line.split(/\s+/);
  const bm = tok[1];
  return { bestmove: !bm || bm === '(none)' || bm === '0000' ? null : bm, ponder: tok[3] };
}
