import { createRequire } from 'node:module';

/**
 * Single source of truth for the package version.
 *
 * It was previously hardcoded in three places — `mcp/server.ts` (twice) and
 * `telemetry.ts`, where it had drifted to `3.9.0` while the package was at
 * 4.1.6. Reading package.json at load time means a version bump cannot leave a
 * stale literal behind. The path resolves identically from `src/` during tests
 * and from `dist/` in the published package, and npm always includes
 * package.json in the tarball.
 */
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version?: string };

export const SENTINEL_VERSION: string = pkg.version ?? '0.0.0';
