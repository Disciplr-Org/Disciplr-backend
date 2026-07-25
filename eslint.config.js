import js from '@eslint/js'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'ts-node',
              message: 'ts-node is dropped in favour of tsx and ts-jest. Please do not import or use it.',
            },
            {
              name: 'better-sqlite3',
              message: 'SQLite has been removed. Use PostgreSQL via src/db/pool.ts instead.',
            },
          ],
        },
      ],
    },
  },
]
