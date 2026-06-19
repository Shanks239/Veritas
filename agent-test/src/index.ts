/**
 * Single-agent entry point (legacy / quick test).
 *
 *   PORT=3001 AGENT_ADDRESS=0x... STRATEGY=momentum npm run dev
 *
 * Defaults reproduce the original baseline agent. To run the full roster of
 * strategy agents at once, use `npm run serve-all` instead.
 */

import { startAgent } from './server';

startAgent({
  name:     process.env.AGENT_NAME ?? 'agent',
  strategy: process.env.STRATEGY ?? 'baseline',
  port:     process.env.PORT ? parseInt(process.env.PORT, 10) : 3001,
  address:  process.env.AGENT_ADDRESS ?? '0x' + '0'.repeat(64),
});
