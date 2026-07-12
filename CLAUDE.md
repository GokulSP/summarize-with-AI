# CLAUDE.md

Project-specific notes for summarize-with-AI. See README.md for features, install, and dev commands.

## Don't hand-edit `.meta.js` or `package.json`'s version

`scripts/sync-metadata.js` (run by lefthook's `metadata` pre-commit stage) derives both from the userscript's `@version` header on every commit — a manual edit to either gets overwritten.

## Pushing to the default branch ships to every installed user

There's no npm package or build step — `.github/workflows/deploy-pages.yml` publishes straight to GitHub Pages, which is the URL Tampermonkey/Violentmonkey poll for updates. Treat a push here like a release, not a routine commit.

## Biome config disables several default rules

`biome.json` turns off `noExplicitAny`, `noArrayIndexKey`, `noNonNullAssertion`, `noExcessiveCognitiveComplexity`, `noForEach`, and `noUnusedVariables` from the recommended set. These are intentional relaxations for this codebase (a single large userscript file), not oversights — don't "fix" code to satisfy a rule that's deliberately off here.
