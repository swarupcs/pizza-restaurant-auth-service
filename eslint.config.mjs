// Flat config — replaces .eslintrc.cjs and .eslintignore, which ESLint 10 no
// longer reads. Rule selection is carried over from the old config unchanged.
import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
    {
        // Replaces .eslintignore
        ignores: [
            "dist/**",
            "node_modules/**",
            "coverage/**",
            "tests/**",
            "**/*.spec.ts",
            ".github/**",
            "scripts/**",
            "**/*.js",
            "**/*.mjs",
            "**/*.cjs",
        ],
    },
    pluginJs.configs.recommended,
    ...tseslint.configs.recommendedTypeChecked,
    {
        languageOptions: {
            globals: globals.node,
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            "no-console": "error",
            "dot-notation": "error",
            "@typescript-eslint/require-await": "off",
            "@typescript-eslint/no-unsafe-assignment": "off",
        },
    },
    // Must stay last so it can switch off stylistic rules Prettier owns.
    prettier,
);
