/**
 * Boot every agent in the roster, each on its own port, in one process.
 *   npm run serve-all
 */

import { loadRoster } from './agents.config';
import { startAgent } from './server';

async function main() {
  const roster = loadRoster();
  await Promise.all(roster.map((a) => startAgent(a)));
  console.log(`\n[veritas-agent] ${roster.length} agents running. POST /predict  GET /health`);
}

main().catch((err) => {
  console.error('[veritas-agent] failed to start:', err.message ?? err);
  process.exit(1);
});
