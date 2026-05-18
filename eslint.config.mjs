import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";
import sonarjs from "eslint-plugin-sonarjs";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.js", "**/*.mjs", "**/*.d.ts", "**/vite.config.ts", "**/vitest.config.ts", "tests/**", "nodes/_dynamic/**"],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: "error",
    },
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        projectService: true,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      "react-hooks": reactHooks,
      sonarjs,
    },
    rules: {
      // === Enforce const over let ===
      "prefer-const": "error",
      "no-var": "error",

      // === No unused vars ===
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // === Enforce readonly where possible ===
      "@typescript-eslint/prefer-readonly": "error",

      // === Enforce explicit member accessibility (private/public/protected) ===
      "@typescript-eslint/explicit-member-accessibility": [
        "error",
        { accessibility: "no-public" },
      ],

      // === No explicit any — force proper typing ===
      "@typescript-eslint/no-explicit-any": "error",

      // === Enforce return types on functions ===
      "@typescript-eslint/explicit-function-return-type": [
        "error",
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: true,
        },
      ],

      // === No duplicate imports ===
      "no-duplicate-imports": "error",

      // === Strict equality ===
      eqeqeq: ["error", "always"],

      // === No console — use pino or NestJS Logger ===
      "no-console": "error",

      // === No floating promises ===
      "@typescript-eslint/no-floating-promises": "error",

      // === Require await in async functions ===
      "@typescript-eslint/require-await": "error",

      // === No unnecessary type assertions ===
      "@typescript-eslint/no-unnecessary-type-assertion": "error",

      // === Consistent type imports ===
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],

      // === No non-null assertions ===
      "@typescript-eslint/no-non-null-assertion": "error",

      // === No unnecessary conditions ===
      "@typescript-eslint/no-unnecessary-condition": "error",

      // === Switch must be exhaustive ===
      "@typescript-eslint/switch-exhaustiveness-check": "error",

      // === No dead code / unreachable code ===
      "no-unreachable": "error",
      "no-unused-expressions": "error",
      "@typescript-eslint/no-useless-constructor": "error",

      // === No empty functions/blocks ===
      "no-empty": "error",
      "no-empty-function": "off",
      "@typescript-eslint/no-empty-function": "error",

      // === React hooks rules ===
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",

      // === File length limit ===
      // 500 lines is the soft cap — enough headroom for a single
      // cohesive concern (a runner, a panel) without the file becoming
      // a dumping ground. Past this, the lint nags us to extract a
      // sibling module rather than letting drift accumulate.
      "max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }],

      // === SonarJS — complexity + anti-patterns ===
      // Curated subset of the recommended ruleset. Picks the ones that
      // catch real maintenance traps (gnarly branching, dupes, dead
      // logic) without nagging on stylistic preferences SonarCloud
      // would surface later.
      //
      // Cognitive-complexity is the flagship rule but we set it to 60
      // as the INITIAL BASELINE — above today's worst offender (53 in
      // NetworkGraph + seed). The intent is to ratchet DOWN over time
      // (60 → 40 → 25 → 20 default) as the worst hot-spots get
      // extracted. Lower threshold today would block CI on legitimate
      // tech debt the user already plans to address incrementally.
      // Same logic for no-duplicate-string (10 instead of the default
      // 5) — leaves headroom for short repeated label strings while
      // still catching real magic-value duplication.
      "sonarjs/cognitive-complexity": ["error", 60],
      "sonarjs/no-identical-functions": "error",
      "sonarjs/no-duplicate-string": ["error", { threshold: 10 }],
      "sonarjs/no-collapsible-if": "error",
      "sonarjs/no-redundant-jump": "error",
      "sonarjs/no-useless-catch": "error",
      "sonarjs/prefer-immediate-return": "error",
      "sonarjs/no-redundant-boolean": "error",
      "sonarjs/no-small-switch": "error",
      "sonarjs/no-inverted-boolean-check": "error",
      "sonarjs/no-nested-template-literals": "error",
      "sonarjs/prefer-single-boolean-return": "error",
      "sonarjs/no-identical-conditions": "error",
      "sonarjs/no-identical-expressions": "error",
      "sonarjs/no-element-overwrite": "error",
      "sonarjs/no-all-duplicated-branches": "error",
      "sonarjs/no-use-of-empty-return-value": "error",
    },
  },
  prettier,
];
