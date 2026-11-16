/*
 * eslint.config.mjs - lint, aimed where nothing else looks.
 *
 * ---- WHY THIS REPLACED `.eslintrc.json` (F-21, D-251) ----
 *
 * The inherited config was not merely unused. It was **unrunnable, and would have
 * been wrong if it had run**:
 *
 *   - ESLint was not a dependency and was not installed;
 *   - there was no `lint` script;
 *   - `.eslintrc` is the legacy format, which ESLint 9+ no longer reads;
 *   - `parserOptions` said `ecmaVersion: 6, sourceType: "script"` against a
 *     codebase that is ES2022 modules, so every `import` would have been a parse
 *     error;
 *   - `env.jquery` was true, and nothing here uses jQuery;
 *   - the `*.ts` override carried an EMPTY rules object;
 *   - and all six rules it did declare - `no-dupe-args`, `no-redeclare` and the
 *     rest - are already compile errors under the TypeScript checker.
 *
 * So it lint nothing, in a dialect the code is not written in, with rules another
 * tool already enforced. Deleted rather than repaired.
 *
 * ---- WHAT THIS ONE IS FOR ----
 *
 * NOT style. `strict: true` (F-20a) now covers the TypeScript sources, and a second
 * opinion about semicolons is worth nothing.
 *
 * The value is `no-undef` and `no-unused-vars` over **`tools/` and the test
 * suites**, which are `.mjs` and have **no type checking over them at all** - the
 * gap `D-249` named as the larger exposure. This session alone wrote three
 * undefined variables into tools (`SMAP`, `GRID_SUITE`, `projects`), each of which
 * type-checked fine because nothing type-checks them, and each of which cost a
 * failing run to find (observation 397). Every one is a `no-undef`.
 *
 * ---- WHY `.mjs` AND NOT `.js` ----
 *
 * The nuspec ships every .js file. An `eslint.config.js` would be swept into the
 * delivered package - a lint configuration handed to customers. `.mjs` matches no
 * shipping pattern, and is the extension the rest of the tooling already uses.
 */

export default [
    {
        // Emitted output, dependencies, and the framework stub: none is ours.
        ignores: [
            '**/*.js',
            '**/*.ts',
            '**/*.d.ts',
            'node_modules/**',
            'Packages/**',
            'ref/**',
        ],
    },
    {
        files: ['tools/**/*.mjs', 'Helpers/SubstrateMapEngine/tests/**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: {
                // Node, for the tools and the suites.
                process: 'readonly', console: 'readonly', Buffer: 'readonly',
                URL: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
                setTimeout: 'readonly', clearTimeout: 'readonly',
                setInterval: 'readonly', clearInterval: 'readonly',
                globalThis: 'readonly', structuredClone: 'readonly',
                // Installed by the shims, and read by the suites through them.
                window: 'readonly', document: 'readonly', TcHmi: 'readonly',
                DOMMatrix: 'readonly', DOMPoint: 'readonly', Path2D: 'readonly',
                ImageData: 'readonly',
                performance: 'readonly',
            },
        },
        rules: {
            /*
             * THE TWO RULES THIS EXISTS FOR. A name that does not resolve, and a
             * name bound and never read - the first is the defect this session hit
             * three times, the second is what is left behind when a refactor half
             * lands.
             */
            'no-undef': 'error',
            'no-unused-vars': ['error', {
                args: 'after-used',
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
                caughtErrors: 'none',
            }],

            /*
             * Mistakes the TypeScript checker would catch in a `.ts` file and
             * cannot catch here. Each is a real defect rather than a preference.
             */
            'no-dupe-keys': 'error',
            /*
             * One import statement per module (H-7). The `.ts` sources are held to
             * the same rule by `check-hmiextproj`, which ESLint here does not parse.
             */
            'no-duplicate-imports': 'error',
            'no-dupe-args': 'error',
            'no-duplicate-case': 'error',
            'no-unreachable': 'error',
            'no-cond-assign': 'error',
            'no-constant-condition': ['error', { checkLoops: false }],
            'no-self-compare': 'error',
            'no-compare-neg-zero': 'error',
            'use-isnan': 'error',
            'valid-typeof': 'error',
            'no-fallthrough': 'error',
            'no-sparse-arrays': 'error',
            'require-atomic-updates': 'error',
        },
    },
    /*
     * THE TYPESCRIPT SOURCES ARE DELIBERATELY NOT LINTED (F-21, D-251).
     *
     * Measured, not assumed: pointing the default parser at them produced **19
     * parse errors** - "Unexpected token interface", "Unexpected token readonly",
     * "Unexpected token as". ESLint cannot read TypeScript without
     * `typescript-eslint`, and installing that means a second dependency, a second
     * version to hold in step with `typescript`, and a second semantic analysis of
     * code that `strict: true` already analyses six times per gate.
     *
     * Nineteen findings, none of them about the code. They are excluded above.
     */
];
