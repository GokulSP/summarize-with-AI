# Summarize with AI

A userscript that summarizes articles with Claude or Gemini in one click, with an image gallery, follow-up Q&A, and a Dieter Rams–inspired UI. Personal fork of [Summarize with AI](https://github.com/insign/userscripts) by Hélio.

## Features

- One-click summarization (Alt+S) using Claude or Gemini — latest Sonnet/Flash model auto-discovered at runtime
- Long-press the button to switch models; each model keeps its own summary cache
- Image gallery with full-screen lightbox (keyboard + swipe navigation)
- Follow-up Q&A about the article, answered by the same model
- One-click copy of the formatted summary
- Dark mode, mobile-optimized, custom modals instead of browser dialogs
- Supported sites: Harvard Business Review, The Economist, McKinsey & Company

## Installation

1. Install a userscript manager: [Tampermonkey](https://www.tampermonkey.net/), [Violentmonkey](https://violentmonkey.github.io/), or [Greasemonkey](https://www.greasespot.net/)
2. Click to install: **[Summarize with AI](https://gokulsp.github.io/summarize-with-AI/Summarize%20with%20AI.user.js)**
3. Visit a supported site and enter your [Anthropic](https://console.anthropic.com/) or [Google AI](https://aistudio.google.com/apikey) API key when prompted

## Development

```bash
pnpm install    # sets up lefthook git hooks too
pnpm lint       # biome check
pnpm typecheck  # tsc --checkJs
pnpm test       # vitest
```

All code lives in `Summarize with AI.user.js`; bump `@version` in its header on every change (lefthook syncs `.meta.js` and `package.json` automatically on commit).

## License

WTFPL — see [LICENSE](LICENSE). Original work by Hélio ([@insign](https://github.com/insign)); fork maintained by Gokul SP ([@gokulsp](https://github.com/gokulsp)).
