/**
 * ESLint flat config: the recommended rules over every `.js` file as Node ESM, with
 * unused variables and arguments allowed only when prefixed `_`. Run through
 * `npm run lint` with `--max-warnings=0`.
 *
 * @module eslint.config
 */

import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'logs/**', 'report.html'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
