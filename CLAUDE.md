# CLAUDE.md

Project-specific notes for summarize-with-AI. See README.md for features, install, and dev commands.

## Don't hand-edit `.meta.js` or `package.json`'s version

`scripts/sync-metadata.js` (run by lefthook's `metadata` pre-commit stage) derives both from the userscript's `@version` header on every commit — a manual edit to either gets overwritten.

## Pushing to the default branch ships to every installed user

There's no npm package or build step — `.github/workflows/deploy-pages.yml` publishes straight to GitHub Pages, which is the URL Tampermonkey/Violentmonkey poll for updates. Treat a push here like a release, not a routine commit.

## Biome config

`biome.json` runs the recommended preset with one change: `noUnusedVariables` is raised from warning to error, because `biome check` exits 0 on warnings and an unused variable would otherwise never block a commit. No rule is turned off.
