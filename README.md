# Summarize with AI

A userscript that summarizes articles with Claude or Gemini in one click, with an image gallery, follow-up Q&A, and a Dieter Rams–inspired UI — for readers of Harvard Business Review, The Economist, and McKinsey & Company who want the gist without the full article. Personal fork of [Summarize with AI](https://github.com/insign/userscripts) by Hélio.

## Setup

Prerequisites requiring manual action:

- A userscript manager: [Tampermonkey](https://www.tampermonkey.net/), [Violentmonkey](https://violentmonkey.github.io/), or [Greasemonkey](https://www.greasespot.net/)
- An [Anthropic](https://console.anthropic.com/) or [Google AI](https://aistudio.google.com/apikey) API key — entered when prompted on your first visit to a supported site

Install the userscript:

1. Install a userscript manager (above)
2. Click to install: **[Summarize with AI](https://gokulsp.github.io/summarize-with-AI/Summarize%20with%20AI.user.js)**
3. Visit a supported site and enter your API key when prompted
4. Verify: open your userscript manager's dashboard and confirm "Summarize with AI" is listed and enabled

To work on the code itself:

```bash
task setup   # pnpm install + lefthook install
```

## Application commands

This is a browser userscript, not a CLI — there's no terminal command to run. Its one entry point is triggered from the page itself, on a supported site (Harvard Business Review, The Economist, McKinsey & Company):

- **Alt+S**, or click the floating button — summarizes the current article with the latest Claude or Gemini model (auto-discovered at runtime)
- **Long-press the button** (or press Arrow Up while it has focus) — switch models; each model keeps its own summary cache
- Once a summary appears — browse the image gallery, ask follow-up questions, or copy the formatted summary; see [Features](#features) for the full list

There's no terminal output to show: success looks like the summary panel rendering in place over the article.

## Configuration

None — no `process.env` usage anywhere in the script; the API key is stored via `GM.setValue`/`GM.getValue` (the userscript manager's own storage), entered through the in-page prompt rather than an environment variable or config file.

## Development commands

| Command | Description |
| --- | --- |
| `task lint` | biome check |
| `task typecheck` | tsc --checkJs |
| `task test` | vitest, failing under the coverage floors |
| `task audit` | pnpm audit + semgrep |
| `task ci` | every gate on every file plus a full-history secret scan |

Scoped to a single test:

```bash
task test -- "Summarize with AI.ui.test.js" -t "long press"
```

`Summarize with AI.ui.test.js` runs the real userscript in a happy-dom page with only the userscript manager (`GM.*`) and the `@require`d Readability stood in, then drives it like a user: clicks, long presses, keys, touches.

## Features

- One-click summarization (Alt+S) using Claude or Gemini — latest Sonnet/Flash model auto-discovered at runtime
- Long-press the button (or press Arrow Up while it has focus) to switch models; each model keeps its own summary cache
- Image gallery with full-screen lightbox (keyboard + swipe navigation)
- Follow-up Q&A about the article, answered by the same model
- One-click copy of the formatted summary
- Dark mode, mobile-optimized, custom modals instead of browser dialogs
- Supported sites: Harvard Business Review, The Economist, McKinsey & Company

## Notes

All code lives in `Summarize with AI.user.js`; bump `@version` in its header on every change (lefthook syncs `.meta.js` and `package.json` automatically on commit).

## License

WTFPL — see [LICENSE](LICENSE). Original work by Hélio ([@insign](https://github.com/insign)); fork maintained by Gokul SP ([@gokulsp](https://github.com/gokulsp)).
