# CLAUDE.md

Project-specific notes for summarize-with-AI. See README.md for setup, usage, and dev commands.

## Map

- `biome.json` runs Biome's recommended preset with one change: `noUnusedVariables` is raised from warning to error, because `biome check` exits 0 on warnings and an unused variable would otherwise never block a commit. No other rule is turned off.

## Invariants

- **Don't hand-edit `.meta.js` or `package.json`'s version.** `scripts/sync-metadata.js` (run by lefthook's `metadata` pre-commit stage) derives both from the userscript's `@version` header on every commit — a manual edit to either gets overwritten.
- **Don't push to the default branch as a routine commit.** There's no npm package or build step — `.github/workflows/deploy-pages.yml` publishes straight to GitHub Pages, which is the URL Tampermonkey/Violentmonkey poll for updates, so every push ships to every installed user immediately. Treat a push here like a release.
