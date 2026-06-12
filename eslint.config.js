import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/', 'dist-test/', 'coverage/', 'node_modules/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      // Library deliberately uses `any` at DOM/SDK boundaries (untyped optional
      // SDKs, CDP payloads, schema cleaning) — not worth fighting.
      '@typescript-eslint/no-explicit-any': 'off',
      // Optional provider SDKs (openai, @anthropic-ai/sdk) are loaded lazily
      // via require() inside try/catch so they stay optional peer deps.
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
  {
    // Page-context functions run inside the browser via Playwright evaluate();
    // they reference DOM globals that aren't part of the Node toolchain types.
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        getComputedStyle: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLSelectElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        Element: 'readonly',
        Node: 'readonly',
        NodeFilter: 'readonly',
        ShadowRoot: 'readonly',
        MouseEvent: 'readonly',
        KeyboardEvent: 'readonly',
        Event: 'readonly',
      },
    },
  }
);
