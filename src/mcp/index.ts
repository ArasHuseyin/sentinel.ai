#!/usr/bin/env node
import { startServer } from './server.js';

startServer().catch(err => {
  console.error('[Sentinel MCP] Fatal error:', err.message);
  process.exit(1);
});
