/**
 * Publish gate: packs the tarball, installs it into a throwaway project, and
 * imports it the way a consumer would.
 *
 * 4.1.6 shipped broken because `files` in package.json was a hand-maintained
 * per-path allowlist and the 4.1.6 refactor added dist/exports.js without
 * updating it. `tsc` was green, the unit tests were green, and every import of
 * the published package threw ERR_MODULE_NOT_FOUND. Type-checking the source
 * cannot catch that class of bug — only resolving the real tarball can.
 *
 * Run via `npm run verify:package` (also wired into prepublishOnly and CI).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Named exports a consumer must be able to reach from the package root. */
const REQUIRED_ROOT_EXPORTS = [
  'Sentinel',
  'z',
  'GeminiProvider',
  'OpenAIProvider',
  'ClaudeProvider',
  'OllamaProvider',
  'createLogger',
  'createPatternCache',
  'SentinelError',
  'ActionError',
  'BudgetExceededError',
];

/** Subpath exports declared in package.json that must also resolve. */
const REQUIRED_SUBPATHS = [{ specifier: '@isoldex/sentinel/test', exports: ['test'] }];

/**
 * Environment for the child npm invocations.
 *
 * npm exports its own config into the environment as `npm_config_*`, and child
 * npm processes read it back. Under `npm publish --dry-run` that means
 * `npm_config_dry_run=true` reaches our inner `npm pack`, which then prints the
 * tarball JSON *without writing the file* — and the subsequent install failed
 * with an opaque ENOENT. The verification must run for real regardless of how
 * the outer npm was invoked, so that flag is stripped.
 */
function childEnv() {
  const env = { ...process.env };
  delete env.npm_config_dry_run;
  // The consumer project needs the playwright peer dep to resolve the import
  // graph, but the smoke test never launches a browser — skip the download.
  env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1';
  return env;
}

function run(cmd, args, cwd) {
  // Node refuses to execFile a .cmd shim without a shell (CVE-2024-27980), so
  // npm on Windows needs shell: true. Every argument here is a literal or a
  // path we generated, never user input.
  const shell = process.platform === 'win32' && cmd.endsWith('.cmd');
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell,
    env: childEnv(),
  });
}

let workdir;
try {
  if (!existsSync(join(repoRoot, 'dist', 'index.js'))) {
    throw new Error('dist/index.js is missing — run `npm run build` first.');
  }

  console.log('· packing tarball…');
  const packed = JSON.parse(run(npm, ['pack', '--json'], repoRoot));
  const tarball = join(repoRoot, packed[0].filename);

  // `npm pack` reports a filename even when it did not write one. Fail here
  // with a readable message instead of letting the install trip over ENOENT.
  if (!existsSync(tarball)) {
    throw new Error(
      `npm pack reported ${packed[0].filename} but wrote no file. ` +
        `Something put npm into dry-run mode for the child process.`
    );
  }

  workdir = mkdtempSync(join(tmpdir(), 'sentinel-verify-'));
  console.log(`· installing into ${workdir}…`);
  writeFileSync(
    join(workdir, 'package.json'),
    JSON.stringify(
      { name: 'verify-consumer', version: '1.0.0', type: 'module', private: true },
      null,
      2
    )
  );
  // Installs the tarball exactly as a consumer would, peer dep included —
  // `dist/core/driver.js` imports playwright at module load, so a missing peer
  // dep is itself a packaging failure worth catching here.
  // `playwright` is required (dist/core/driver.js imports it at module load);
  // `@playwright/test` is the optional peer the /test subpath needs. Both are
  // installed so every declared export path is actually exercised.
  run(npm, ['install', '--no-save', tarball, 'playwright', '@playwright/test'], workdir);

  const probe = `
    const missing = [];
    const root = await import('@isoldex/sentinel');
    for (const name of ${JSON.stringify(REQUIRED_ROOT_EXPORTS)}) {
      if (root[name] === undefined) missing.push('@isoldex/sentinel#' + name);
    }
    for (const { specifier, exports } of ${JSON.stringify(REQUIRED_SUBPATHS)}) {
      const mod = await import(specifier);
      for (const name of exports) {
        if (mod[name] === undefined) missing.push(specifier + '#' + name);
      }
    }
    if (missing.length) {
      console.error('MISSING EXPORTS: ' + missing.join(', '));
      process.exit(1);
    }
    console.log('· imports resolved, ' + Object.keys(root).length + ' root exports');
  `;
  writeFileSync(join(workdir, 'probe.mjs'), probe);

  console.log('· importing as a consumer…');
  process.stdout.write(run(process.execPath, [join(workdir, 'probe.mjs')], workdir));

  rmSync(tarball, { force: true });
  console.log('✓ package verified — tarball is importable');
} catch (err) {
  const detail = err.stderr?.toString().trim() || err.stdout?.toString().trim() || err.message;
  console.error('✗ package verification FAILED\n' + detail);
  process.exitCode = 1;
} finally {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
}
