// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'examples/**',
      'sessions/**',
      // Imports build output on purpose; see the comment in the file itself.
      'scripts/demo-dist.ts',
      // Gitignored local debugging scratch (see .gitignore "debug-*.ts").
      'debug-*.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  {
    // Type-aware rules run on real source only — they need the program, and the
    // payoff here is catching un-awaited promises in a codebase that is almost
    // entirely async browser I/O.
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // The codebase deliberately reaches into untyped Playwright/CDP payloads
      // and LLM JSON. Keep it visible as a warning rather than blocking CI on
      // the ~116 pre-existing sites.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',

      // An `async` method that satisfies a Promise-returning interface without
      // awaiting internally is correct, not a defect — this rule flags ~200 of
      // those across providers and mocks and would train people to ignore lint.
      '@typescript-eslint/require-await': 'off',

      // Off deliberately: its autofix DELETES assertions that tsc requires.
      // Inside page.evaluate() callbacks and `import('pkg' as string)` for
      // optional deps, ESLint's type view differs from the build's, so
      // `eslint --fix` stripped casts and non-null assertions and left the
      // repo with 10 tsc errors. A rule whose fix breaks the build is a
      // liability, not a safeguard.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',

      // tsc already enforces unused vars via noUnusedLocals/noUnusedParameters;
      // keep ESLint aligned on the underscore convention rather than duplicating.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  {
    // Tests mock heavily and pull methods off objects to inspect call history;
    // type-aware strictness there costs more than it returns.
    files: ['src/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  {
    // Ad-hoc dev scripts are not shipped; console output is the whole point.
    files: ['scripts/**/*.{ts,mjs}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },

  // Must stay last: switches off every stylistic rule Prettier owns.
  prettier
);
