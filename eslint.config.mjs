import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.js", "**/*.mjs", "**/*.d.ts", "**/vite.config.ts", "**/vitest.config.ts", "tests/**"],
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
    },
  },
  prettier,
];
