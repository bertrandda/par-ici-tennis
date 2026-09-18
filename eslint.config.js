import globals from 'globals'
import pluginJs from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'

export default [
  {
    languageOptions: { globals: globals.node },
  },
  {
    plugins: {
      '@stylistic': stylistic
    },
    rules: {
      semi: ['error', 'never'],
      quotes: ['error', 'single'],
      '@stylistic/indent': ['error', 2],
      '@stylistic/eol-last': ['error', 'always']
    }
  },
  {
    ignores: ['staticFiles.js']
  },
  pluginJs.configs.recommended,
]
