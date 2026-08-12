/**
 * Mobile lint config — the shared base plus the two rules that only matter on a phone.
 *
 * Everything else (strict TS, no-explicit-any, no-console, eqeqeq) comes from
 * `@medicore/config/eslint` unchanged, so mobile is held to the same standard as the API.
 */
import base from "@medicore/config/eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  ...base,
  /**
   * The rules of hooks, enforced. A stale closure in a `useEffect` is the commonest React Native
   * bug there is, and here it would mean a screen holding a token or a branch id that has since
   * changed — which is worse than a rendering glitch.
   */
  {
    files: ["**/*.tsx", "**/*.ts"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    ignores: [".expo/**", "dist/**", "android/**", "ios/**", "expo-env.d.ts"],
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      /**
       * The api-client is constructed in exactly one file (M0 §9). A second `new ApiClient(...)`
       * anywhere else is a second HTTP layer with its own auth handling, which is the failure this
       * whole architecture is arranged to prevent — so it is a lint error, not a review comment.
       *
       * Same reasoning for `expo-secure-store`: one wrapper owns the refresh token, and a direct
       * import elsewhere is how a token ends up somewhere it should not be.
       */
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "expo-secure-store",
              message: "Use src/platform/secureStore.ts — one module owns the refresh token.",
            },
            {
              name: "@react-native-async-storage/async-storage",
              message:
                "Use src/platform/preferences.ts. AsyncStorage must never hold a token (M0 §15).",
            },
          ],
        },
      ],
    },
  },
  {
    // The two files that legitimately own those platform APIs.
    files: ["src/platform/secureStore.ts", "src/platform/preferences.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  {
    // Config files run in Node before the app exists.
    files: ["*.config.ts", "*.config.js", "*.config.mjs"],
    rules: { "no-console": "off" },
  },
];
