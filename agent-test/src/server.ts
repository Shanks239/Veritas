/**
 * Reusable Veritas agent server.
 *
 * One agent = one Sui address + one strategy + one /predict endpoint.
 * `startAgent` boots an Express server; `serve-all.ts` starts several at once.
 */

import express, { Request, Response, Express } from 'express';
import { getStrategy, type WorkerPayload, type StrategyFn } from './strategies';

export interface AgentRuntime {
  name:     string;
  strategy: string;
  port:     number;
  address:  string;
}

export function createAgentApp(cfg: AgentRuntime): Express {
  const strategy: StrategyFn = getStrategy(cfg.strategy);
  const app = express();
  app.use(express.json());

  // ── GET /health ─────────────────────────────────────────────────────────
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status:    'ok',
      name:      cfg.name,
      strategy:  cfg.strategy,
      address:   cfg.address,
      timestamp: Math.floor(Date.now() / 1000),
    });
  });

  // ── POST /predict ───────────────────────────────────────────────────────
  app.post('/predict', (req: Request, res: Response) => {
    const ts      = new Date().toISOString();
    const payload = req.body as WorkerPayload;

    if (!payload?.window_id) {
      res.status(400).json({ error: 'window_id is required' });
      return;
    }

    const { distribution, order } = strategy(payload);
    const prediction = {
      windowId:     payload.window_id,
      agentAddress: cfg.address,
      distribution,
      order,
      signature:    '0x00', // Worker does not verify agent signatures (hackathon)
    };

    console.log(`[${ts}] ${cfg.name}(${cfg.strategy}) → ${order.side} ${order.sizeUsdc / 1e6} USDC @ ${(order.limitPrice / 1e6).toFixed(4)}`);
    res.json(prediction);
  });

  return app;
}

export function startAgent(cfg: AgentRuntime): Promise<void> {
  return new Promise((resolve) => {
    createAgentApp(cfg).listen(cfg.port, () => {
      console.log(`[veritas-agent] ${cfg.name} (${cfg.strategy}) on :${cfg.port}  addr=${cfg.address}`);
      resolve();
    });
  });
}
