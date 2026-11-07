import { EngineController } from './controller';
import { createWorkerTransport } from './transport';
import { persistentAnalysisCache } from '../db/db';

/**
 * One shared engine for the whole app. All modes go through its priority
 * queue, so there are never several competing searches.
 */
let engine: EngineController | null = null;

export function getEngine(): EngineController {
  if (!engine) {
    engine = new EngineController(() => createWorkerTransport(), { hashMb: 32, persistentCache: persistentAnalysisCache });
    engine.init().catch(() => { /* reported through status */ });
  }
  return engine;
}
