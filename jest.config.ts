import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  injectGlobals: false,
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          ignoreDeprecations: '6.0',
        },
      },
    ],
  },
  testMatch: ['**/src/__tests__/**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/src/__tests__/e2e/'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/__tests__/**',
    '!src/index.ts',
  ],
  coverageReporters: ['text', 'lcov', 'html'],
  coverageDirectory: 'coverage',
  // A ratchet, not a target: set just under the current numbers so coverage
  // cannot silently erode, and raise it as modules get covered. The weakest
  // areas today are state-parser.ts, driver.ts and mcp/server.ts.
  coverageThreshold: {
    global: {
      statements: 54,
      branches: 45,
      functions: 60,
      lines: 57,
    },
  },
  // Deliberately NOT setting forceExit. It was masking a real defect: every
  // withTimeout() call leaked a pending timer, which kept the event loop alive
  // for the full timeout window after the work finished — in the library, not
  // just in tests. With forceExit on, Jest killed the workers and the symptom
  // never became visible. Leaving it off means the next leak fails loudly.
};

export default config;
