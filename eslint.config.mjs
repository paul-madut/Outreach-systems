import js from "@eslint/js";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

// eslint-config-next 16 ships native flat configs, so these are imported
// directly rather than through FlatCompat.
const eslintConfig = [
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts"],
  },
  js.configs.recommended,
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      // Unused arguments are common in typed callbacks and route signatures.
      // Allow the conventional leading-underscore opt-out.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["scripts/**/*.{ts,js,mjs}", "tests/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
];

export default eslintConfig;
