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
  testMatch: ['**/src/__tests__/e2e/**/*.test.ts'],
  testTimeout: 90_000,
  forceExit: true,
};

export default config;
