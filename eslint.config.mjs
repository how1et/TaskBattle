import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "dist/**",
    ".wrangler/**",
    ".sites-runtime/**",
  ]),
  {
    rules: {
      // Photos use authorized Blob URLs and are already resized before upload.
      "@next/next/no-img-element": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }],
    },
  },
  {
    files: ["components/battle.tsx", "components/use-*.ts", "components/report-photo.tsx", "components/solver-timer.tsx"],
    rules: {
      // These hooks synchronize explicit external controllers/resources. React
      // Compiler is not enabled; hook ordering/dependency checks remain active.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/purity": "off",
    },
  },
  {
    files: ["components/battle.tsx", "components/site-header.tsx"],
    rules: {
      // Vinext 1 beta's Link transition throws in this production bundle.
      // Explicit navigation out of an attempt uses ordinary, reliable anchors.
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  {
    files: ["components/ui/**/*.{ts,tsx}", "hooks/use-mobile.ts"],
    rules: {
      // These files are vendored verbatim from shadcn@4.17.0. Keep the
      // registry source intact while applying the stricter rules to Site code.
      "@typescript-eslint/no-unused-vars": "off",
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);

export default eslintConfig;
