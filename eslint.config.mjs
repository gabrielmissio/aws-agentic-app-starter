import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['temp/**', '**/dist/**', '**/cdk.out/**', '**/node_modules/**'] },
  js.configs.recommended,
  tseslint.configs.strict,
  {
    // Plain Node.js Lambda source, deployed as-is with no bundler — see the note in
    // auth-stack.ts. `js.configs.recommended` assumes no runtime globals, so `process`/`console`
    // read as undefined without this.
    files: ['infra/lambdas/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
);
