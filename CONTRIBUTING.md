# Contributing to Sentinel

Thanks for your interest in contributing! Sentinel is MIT-licensed and welcomes contributions of all kinds.

## Quick start

```bash
git clone https://github.com/arashuseyin/sentinel
cd sentinel
npm install
npm run build
npm test
```

## Project structure

```
src/
  api/          # act(), extract(), observe()
  agent/        # autonomous agent loop (plan → execute → verify → reflect)
  core/         # StateParser, SentinelDriver, LocatorCache, PromptCache
  utils/        # LLM providers, TokenTracker, ProxyProvider, telemetry
  cli/          # npx sentinel CLI
  mcp/          # MCP server
  recorder/     # Record & Replay
  reliability/  # Verifier
  types/        # Error classes
  __tests__/    # Vitest test suite
examples/       # Runnable example scripts
```

## How to contribute

### Bug fixes
1. Open an issue describing the bug and reproduction steps
2. Fork the repo and create a branch: `git checkout -b fix/your-bug`
3. Write a failing test that reproduces the bug
4. Fix the bug
5. Confirm all tests pass: `npm test`
6. Open a PR

### New features
1. Open an issue first — discuss the feature before investing time
2. Fork and branch: `git checkout -b feat/your-feature`
3. Implement the feature with tests
4. Update docs in the relevant section of README.md if needed
5. Open a PR with a clear description of what and why

### Good first issues
Look for issues tagged [`good first issue`](https://github.com/arashuseyin/sentinel/issues?q=label%3A%22good+first+issue%22) — these are scoped and beginner-friendly.

## Development

```bash
npm run build        # compile TypeScript
npm test             # run full test suite (Vitest)
npm run test:watch   # watch mode
```

Tests use [Vitest](https://vitest.dev/). Browser-level tests require a real Chromium install (`npx playwright install chromium`).

## Code style

- TypeScript strict mode
- No unnecessary abstractions — solve the problem at hand
- Every new public API gets a test
- Error messages should be actionable (see `buildFailureMessage` in `src/api/act.ts` as a reference)

## Commit messages

Use conventional commits:
```
feat: add WebshareProxyProvider
fix: correct scroll-to fallback for off-screen elements
docs: update SentinelOptions table
test: add runStream generator tests
```

## Pull request checklist

- [ ] Tests written and passing (`npm test`)
- [ ] TypeScript compiles without errors (`npx tsc --noEmit`)
- [ ] README updated if public API changed
- [ ] No breaking changes without prior discussion

## Questions?

Open a [GitHub Discussion](https://github.com/arashuseyin/sentinel/discussions) — we're happy to help.
