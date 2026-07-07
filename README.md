# Summarize with AI

A personal userscript fork that provides AI-powered article summarization with interactive features including image galleries, Q&A capabilities, and a beautifully designed interface following Dieter Rams' design principles.

> **Note**: This is a personal fork of the original [Summarize with AI](https://github.com/insign/userscripts) by Hélio, maintained by Gokul SP. See [Fork Information](#fork-information) for details.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Feature Reference](#feature-reference)
- [Browser Compatibility](#browser-compatibility)
- [API Usage & Costs](#api-usage--costs)
- [Privacy & Security](#privacy--security)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Testing](#testing)
- [Release Process](#release-process)
- [Fork Information](#fork-information)
- [Changelog](#changelog)
- [License](#license)
- [Credits & Authors](#credits--authors)

## Features

### Core Functionality

- **One-Click AI Summarization**: Instantly summarize articles using Claude or Gemini AI with a single button press (Alt+S)
- **Multiple AI Services**: Support for both Claude and Google Gemini, with the latest Sonnet/Flash model auto-discovered at runtime
- **Universal Prompt**: A single, publication-agnostic summarization template (Core Insight → Key Points → Significance → Context → Limitations) — see [Feature Reference](#feature-reference)
- **Smart Model Management**: Switch between AI models with long-press, with automatic caching per model
- **Smart Content Extraction**: Uses Mozilla's Readability.js for accurate article content extraction

### Interactive Features

- **Image Gallery & Lightbox**:
  - Automatically extracts up to 12 relevant images from articles
  - Grid-based gallery display with up to 6 images shown
  - Full-screen lightbox viewer with keyboard navigation and swipe gestures
  - Support for interactive charts and visualizations (iframes)
  - Site-specific extraction optimizations for major publishers

- **Q&A System**:
  - Ask follow-up questions about the article
  - Context-aware responses combining article content with expert knowledge
  - Concise answers limited to 150 words
  - HTML-formatted responses with sections and bullet points

- **Copy Summary**:
  - One-click copy with HTML formatting preserved
  - Multiple fallback strategies for maximum compatibility
  - Visual feedback with "Copied ✓" confirmation

### User Experience

- **Professional UI Design**:
  - Dieter Rams-inspired minimalist design system
  - Comprehensive CSS variable system for consistent theming
  - Smooth animations and transitions
  - Dark mode auto-detection and support

- **Custom Modal System**:
  - Native-looking modals replacing browser dialogs
  - Keyboard navigation (Enter/Escape)
  - Mobile-responsive with touch support
  - Accessible and user-friendly

- **Mobile Optimized**:
  - Touch-friendly interface with proper tap targets
  - Swipe gestures for lightbox navigation
  - Fixed menu bar at bottom for easy access
  - Full-screen overlays on mobile devices
  - Prevention of accidental zoom on button taps

- **Smart Button Behavior**:
  - Long-press or tap-and-hold to select models
  - Auto-hides when typing in input fields
  - Context-aware visibility

### Supported Sites

Currently whitelisted for optimal experience on:

- Harvard Business Review (hbr.org)
- The Economist (economist.com)
- Bloomberg (bloomberg.com)
- ABC News Australia (abc.net.au)

## Installation

### Prerequisites

1. A userscript manager browser extension:
   - [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Safari, Edge)
   - [Greasemonkey](https://www.greasespot.net/) (Firefox)
   - [Violentmonkey](https://violentmonkey.github.io/) (Chrome, Firefox, Edge)

2. An AI API key:
   - Anthropic API key for Claude ([Get one here](https://console.anthropic.com/))
   - OR Google AI API key for Gemini ([Get one here](https://aistudio.google.com/apikey))

### Installation Steps

1. Install a userscript manager for your browser
2. Click the install link: **[Install Summarize with AI](https://gokulsp.github.io/summarize-with-AI/Summarize%20with%20AI.user.js)**
3. Your userscript manager will prompt you to install - click "Install"
4. Visit any supported site (see [Supported Sites](#supported-sites))
5. When prompted, enter your Anthropic or Google AI API key

## Usage

### Basic Summarization

1. Navigate to an article on a supported site
2. Click the floating "S" button (bottom-right corner) or press **Alt+S**
3. The summary will appear in a beautiful overlay with:
   - Structured summary with key insights
   - Image gallery (if available)
   - Q&A input field
   - Copy button to save the summary

### Selecting Models

1. Long-press (500ms) or tap-and-hold the "S" button
2. A dropdown will appear showing available models grouped by service (CLAUDE / GEMINI)
3. Click a model to select it and start summarization
4. Your selection is remembered for next time
5. Each model maintains its own summary cache for quick switching

### Managing API Keys

1. Open the model dropdown (long-press "S" button)
2. Click "Reset Key" next to the service name (e.g., "CLAUDE" or "GEMINI")
3. Enter your new API key or leave blank to clear
4. Each service (Claude/Gemini) has its own separate API key storage

### Asking Questions

1. After viewing a summary, find the input field: "Ask a question about this article"
2. Type your question
3. Press Enter or click the "Ask" button
4. The answer appears below with formatted sections

### Keyboard Shortcuts

- **Alt+S**: Trigger summarization
- **Escape**: Close overlay or dropdown
- **Arrow Keys**: Navigate lightbox images (when open)
- **Enter**: Submit Q&A question (when focused on input)

## Configuration

The script includes extensive configuration options in the `CONFIG` object:

```javascript
CONFIG = {
  timing: {
    longPressDuration: 500,        // ms to trigger model selection
    apiRequestTimeout: 60000,       // API timeout
  },
  limits: {
    maxImages: 12,                  // Max images to extract
    targetWordCount: 300,           // Target summary length
    bulletPointMaxWords: 20,        // Max words per bullet
  }
}
```

## Architecture

### Service Layer

- **StorageService**: Manages all GM storage operations (API keys, models, preferences)
- **NotificationService**: User-friendly notifications using custom modals
- **ModalService**: Professional modal dialogs (alert, confirm, prompt)
- **PromptBuilder**: Builds the universal summarization prompt (see [Feature Reference](#feature-reference))
- **UIHelpers**: Common UI operations
- **Validators**: Input validation logic

### Configuration System

All magic numbers, DOM IDs, storage keys, timing/limit constants, and UI colors live in a single `CONFIG` object, giving the script one source of truth for settings that would otherwise be scattered as literals.

### State Management

A single `state` object (`activeModel`, `articleData`, `customModels`, `currentSummary`, `summaryCache`, `articleImages`, ...) holds all mutable runtime data, and a `dom` object caches references to frequently-accessed elements (`button`, `dropdown`, `overlay`, `lightbox`, ...) to avoid redundant queries.

### Performance Optimizations

- Pre-compiled regex patterns for faster text processing (`REGEX_PATTERNS`, `IMAGE_EXTRACTION_REGEX`)
- LRU-style cache for auto-discovered model IDs (Sonnet/Gemini Flash), capped to avoid unbounded growth
- Event delegation for gallery and dropdown items instead of per-item listeners
- DOM element caching (the `dom` object above) to reduce repeated queries
- Lazy loading detection with the Intersection Observer API
- Batch DOM operations (`DocumentFragment`, single `innerHTML` assignment) to minimize reflows

### Design System

- CSS variables for theming (colors, spacing, typography)
- 8px grid system for consistent spacing
- Shadow elevation system (4 levels)
- Dark mode support with proper contrast ratios
- Mobile-first responsive design

## Feature Reference

### Image Gallery & Lightbox

Extracts up to 12 images per article (grid shows up to 6), with site-specific extraction tuning for HBR and The Economist, Intersection-Observer-based lazy-load detection, and a full-screen lightbox supporting both images and embedded iframes (interactive charts), keyboard/swipe navigation, and a thumbnail strip. See the image-extraction and lightbox functions in `Summarize with AI.user.js` (search for `extractArticleImages` and `createLightbox`).

### Multiple AI Service Support

Claude (Anthropic) and Gemini (Google) are both supported with separate API key storage, separate summary caches, and separate response parsing (`extractSummaryFromResponse`, covered by unit tests — see [Testing](#testing)). Rather than hardcoding a model ID, the script auto-discovers the latest available Sonnet (Claude) and Flash (Gemini) model at runtime and caches the result, so new model releases are picked up without a script update.

### Universal Prompt

Earlier versions of this fork used separate prompt templates per publication (a "research" template for HBR, a "news" template for The Economist). As of 2026-06-30 this was replaced by a single universal prompt (`PROMPT_TEMPLATE`) used for every site: Core Insight → Key Points → Significance → Context → Limitations, targeting ~300 words with bullet points capped at 20 words each.

### Q&A System

An input field below the summary lets you ask a follow-up question; the same AI model that generated the summary answers using the article content as context, formatted into `[From Article]` / `[Expert Context]`-style sections and capped at 150 words / 800 tokens. Answer formatting (bracketed headers, bold labels, numbered lists) is handled by `formatQAAnswer`, covered by unit tests.

### Copy Summary

Copies the HTML-formatted summary to the clipboard via `navigator.clipboard.write` with a `document.execCommand('copy')` fallback for browsers/sites that block the modern Clipboard API, with a temporary "Copied ✓" visual confirmation.

### Custom Modal System

Custom `alert()`/`confirm()`/`prompt()`-equivalent modals (`ModalService`) replace native browser dialogs, matching the rest of the UI's Dieter Rams-inspired design, with keyboard navigation and dark-mode/mobile support.

### Removed Features

Features present in earlier iterations that were deliberately removed:

- **Chat interface** — replaced by the simpler, single-turn Q&A system
- **OpenAI support** — dropped in favor of focusing on Claude and Gemini (free tier)
- **Extended "thinking" model timeouts** — replaced by a single flat 60-second timeout
- **Language detection** (`navigator.language`) — English-only prompts, for consistency
- **Article quality scoring** — removed in favor of focusing purely on the summary content
- **AI-generated opinion section** — removed for more objective, professional summaries
- **The Guardian, Inoreader, and ft.com support** (removed 2026-06-28) — narrowed scope to the actively-maintained site list
- **Publication-specific prompt templates** (removed 2026-06-30) — replaced by the [Universal Prompt](#universal-prompt)
- **Per-model version labels in the model dropdown** (removed 2026-06-30) — superseded by runtime model auto-discovery

## Browser Compatibility

### Tested Browsers

- Chrome 120+
- Firefox 121+
- Edge 120+
- Safari 17+ (with Tampermonkey)

### Known Issues

- Some sites may have Content Security Policy restrictions
- Copy functionality may be limited on certain sites due to clipboard API restrictions

## API Usage & Costs

The script supports two AI services:

### Claude (Anthropic)

- Pricing depends on the auto-discovered Sonnet model; check the [Anthropic Console](https://console.anthropic.com/) for current rates
- Average article summary: ~1,000 input tokens + ~300 output tokens
- Monitor usage at [Anthropic Console](https://console.anthropic.com/)

### Gemini (Google)

- Free tier available with rate limits; paid tier is typically lower cost than Claude
- Monitor usage at [Google AI Studio](https://aistudio.google.com/)

## Privacy & Security

- API keys are stored locally in your browser using GM storage (separate storage per service)
- No data is sent to any server except the selected AI service (Claude or Gemini)
- Article content is only sent to your chosen AI service for summarization
- No analytics or tracking
- Open source for full transparency
- User-supplied text (Q&A answers, error messages) is HTML-escaped via `escapeHtml()` before insertion into the page

## Troubleshooting

### "Article content not found or not readable"

- The page may not be an article or may not have enough content
- Try refreshing the page
- Check if the site is in the [supported list](#supported-sites)

### "API key for [SERVICE] is required"

- Click the dropdown (long-press "S" button)
- Click "Reset Key" next to the service name (CLAUDE or GEMINI)
- Enter your API key for the respective service:
  - Claude: Get from [Anthropic Console](https://console.anthropic.com/)
  - Gemini: Get from [Google AI Studio](https://aistudio.google.com/apikey)

### Images not appearing

- Some sites may block image extraction
- Images need to meet minimum dimensions (600x400)
- Check browser console for extraction details

### Copy not working

- Try the fallback: Select summary text and use Ctrl+C
- Some sites interfere with clipboard operations
- Check browser clipboard permissions

### Button not visible

- The button auto-hides when typing in input fields
- Check if you're on a supported site
- Verify the article is recognized as readerable

## Development

### Prerequisites

- **Node.js**: version pinned in [.nvmrc](.nvmrc) (currently 24)
  - Download from [nodejs.org](https://nodejs.org/)
  - Verify installation: `node --version`
- **pnpm**: enable via Corepack (bundled with Node) rather than installing globally:

  ```bash
  corepack enable
  corepack use pnpm@latest
  ```

- **Git**: Download from [git-scm.com](https://git-scm.com/)

### Setup

```bash
git clone https://github.com/GokulSP/Summarize-with-AI.git
cd Summarize-with-AI
pnpm install
```

This installs `@biomejs/biome`, `lefthook`, `typescript`, `vitest`, `happy-dom`, and `markdownlint-cli2` as dev dependencies. The `prepare` script runs `lefthook install` automatically, so git hooks are set up as part of `pnpm install`.

### Install the Userscript Locally

1. Open your userscript manager dashboard
2. Create a new userscript
3. Copy the contents of `Summarize with AI.user.js`
4. Save the userscript

### Project Structure

```text
summarize-with-AI/
├── .github/
│   └── workflows/
│       └── deploy-pages.yml       # GitHub Pages deployment (static passthrough)
├── scripts/
│   └── sync-metadata.js           # Formats the header, syncs it to .meta.js + package.json
├── Summarize with AI.user.js      # Main userscript file (single source of truth)
├── Summarize with AI.meta.js      # Auto-generated metadata (do not edit directly)
├── Summarize with AI.test.js      # Vitest tests for the userscript's pure helpers
├── biome.json                     # Biome configuration
├── jsconfig.json                  # JSDoc type-checking config (tsc --checkJs)
├── lefthook.yml                   # Git hooks configuration
├── package.json                   # Project dependencies and scripts
├── .markdownlint-cli2.jsonc       # Markdown lint configuration
├── .editorconfig                  # Editor configuration
├── .gitignore                     # Git ignore rules
├── README.md                      # This file
└── LICENSE                        # WTFPL license
```

### Making Code Changes

All code lives in the single file `Summarize with AI.user.js`, structured as:

```javascript
// ==UserScript==
// @name         Summarize with AI
// @version      YYYY.MM.DD.NN  // Update this on changes
// ... metadata ...
// ==/UserScript==

(() => {
  const CONFIG = { /* ... */ }
  const state = { /* ... */ }
  const dom = { /* ... */ }

  const StorageService = { /* ... */ }
  const NotificationService = { /* ... */ }
  // ... etc

  if (typeof module === 'undefined') {
    initialize();
  } else {
    module.exports = { /* pure helpers, for Summarize with AI.test.js */ };
  }
})();
```

When making changes:

1. Edit `Summarize with AI.user.js` directly
2. Update the version number in the header: format `YYYY.MM.DD.XX` (XX = iteration number for that day)
3. Test on a supported site (see [Testing](#testing))
4. Commit — Lefthook's pre-commit hook will format the code with Biome, lint any Markdown, and sync `Summarize with AI.meta.js` + `package.json`'s version automatically

Commit message prefixes: `feat:`, `fix:`, `docs:`, `style:`, `refactor:`, `perf:`, `test:`, `chore:`.

### Code Quality Tools

```bash
# Lint + format check
pnpm lint

# Lint + format, auto-fixing
pnpm format

# JSDoc type-check (tsc --checkJs, no build step)
pnpm typecheck

# Run the Vitest suite
pnpm test
```

Biome configuration is in `biome.json` (tab indentation, 100-char line width, single quotes, v2 `assist.actions.source.organizeImports` for import sorting). It defers to `.gitignore` for excluded paths (`"useIgnoreFile": true`) rather than an explicit ignore list.

**Known type-checking gap**: `jsconfig.json` deliberately sets `"strict": false` so `tsc --checkJs` only catches genuine type errors rather than flooding output with implicit-`any` noise across a 3,000+ line file that has no JSDoc annotations yet. Even with that, a few dozen pre-existing errors remain in `Summarize with AI.user.js` — mostly undeclared externals (`GM`, `Readability`, `isProbablyReaderable`, all injected by `@grant`/`@require` at runtime, not npm packages) and DOM elements typed generically as `Element`/`EventTarget` rather than their concrete subtypes. Fixing these properly needs a full JSDoc annotation pass across the file, which is out of scope for incidental changes — treat `pnpm typecheck` as informative for new/touched code rather than a zero-error gate for now.

### Sync Metadata

`Summarize with AI.meta.js` and `package.json`'s `version` field are both derived from the `Summarize with AI.user.js` header and kept in sync automatically by the pre-commit hook. To run it manually:

```bash
node scripts/sync-metadata.js
```

## Testing

### Automated Tests

`Summarize with AI.test.js` runs the userscript's DOM-independent helper functions (`escapeHtml`, `formatQAAnswer`, `cleanSummaryHTML`, `mergeParams`, `extractSummaryFromResponse`) under Vitest. Since the script is a single unbundled file with no exports, the test file loads it into a sandboxed [`vm`](https://nodejs.org/api/vm.html) context (via [happy-dom](https://github.com/capricorn86/happy-dom) for `document`) rather than importing it directly — this keeps the shipped userscript as the single source of truth with zero duplicated logic. A guarded block at the very end of the userscript (`if (typeof module === 'undefined') { initialize(); } else { module.exports = {...} }`) is a no-op in a real browser/userscript context and only activates under this test harness.

```bash
pnpm test
```

`extractSummaryFromResponse` — the Claude/Gemini response-shape parser — has the most thorough coverage, since it's the exact code two recent hotfixes ([2026.07.03.01](#changelog), [2026.07.03.02](#changelog)) had to patch for response-shape edge cases.

### Manual Testing Checklist

Automated tests only cover pure logic; DOM/GM-dependent behavior still needs manual verification on a real page:

Test on supported sites:

- [ ] Harvard Business Review (hbr.org)
- [ ] The Economist (economist.com)
- [ ] Bloomberg (bloomberg.com)
- [ ] ABC News Australia (abc.net.au)

Test features:

- [ ] Button appears on articles
- [ ] Alt+S keyboard shortcut works
- [ ] Long-press opens model dropdown
- [ ] Summarization works
- [ ] Image gallery displays (when images available)
- [ ] Lightbox navigation works (arrows, swipe)
- [ ] Q&A feature works
- [ ] Copy summary works
- [ ] API key management works
- [ ] Error handling works

Test environments:

- [ ] Desktop browser
- [ ] Mobile browser (or responsive mode)
- [ ] Light mode
- [ ] Dark mode
- [ ] Different userscript managers (Tampermonkey, Violentmonkey)

### Debugging Tips

1. **Check console errors**: Open DevTools (F12) → Console tab
2. **Inspect state**: temporarily add `console.log('State:', state)` / `console.log('Config:', CONFIG)`
3. **Verify DOM elements**: `console.log('Button:', document.getElementById(CONFIG.ids.button))`

## Release Process

### Manual Release

1. Update the version in the script header (`// @version YYYY.MM.DD.XX`)
2. Add an entry to the [Changelog](#changelog) section below
3. Commit — Lefthook syncs `Summarize with AI.meta.js` and `package.json` automatically:

   ```bash
   git add .
   git commit -m "chore: bump version to YYYY.MM.DD.XX"
   ```

4. Push to `main`

### Publishing via GitHub Pages

The `@downloadURL`/`@updateURL` fields in the userscript header point at this repo's GitHub Pages site:

```javascript
// @downloadURL https://gokulsp.github.io/summarize-with-AI/Summarize%20with%20AI.user.js
// @updateURL   https://gokulsp.github.io/summarize-with-AI/Summarize%20with%20AI.meta.js
```

[.github/workflows/deploy-pages.yml](.github/workflows/deploy-pages.yml) publishes the entire repo root as static files on every push to `main` — no build step, no manual intervention needed. Userscript managers poll `@updateURL` (the lightweight `.meta.js`), compare `@version`, and fetch `@downloadURL` (the full script) when a newer version is found.

### Troubleshooting a Failed Pre-commit Hook

```bash
# Format code
pnpm format

# Sync metadata manually
node scripts/sync-metadata.js

# Try committing again
git commit -m "your message"
```

Skipping the hook (`git commit --no-verify`) is not recommended — it's how `Summarize with AI.meta.js`/`package.json` previously drifted out of sync with the userscript's actual version (see [Changelog](#changelog)).

## Fork Information

This is a personal fork of the original **Summarize with AI** userscript created by Hélio ([@insign](https://github.com/insign)), maintained for individual use by Gokul SP ([@gokulsp](https://github.com/gokulsp)).

- **Original repository**: [insign/userscripts](https://github.com/insign/userscripts)
- **Original author**: Hélio (`open@helio.me`)
- **License**: WTFPL (unchanged from upstream)

### What's Different in This Fork

- Comprehensive documentation consolidated into this README (previously split across BUILD.md/FEATURES.md/FORK.md/CHANGELOG.md)
- Automated GitHub Pages deployment for `@downloadURL`/`@updateURL`
- Lefthook-based git hooks (Biome, markdownlint, metadata sync) — this fork briefly used Husky before migrating to Lefthook on 2026-06-28
- Vitest test suite and JSDoc-based type-checking (`tsc --checkJs`) for the script's pure helper functions
- Extensive feature additions beyond the original: multi-service AI support (Claude + Gemini), image gallery/lightbox, Q&A system, custom modal system — see [Feature Reference](#feature-reference)

All original code and features remain credited to the original author, Hélio. If you're the original author and have concerns about this fork, please reach out via GitHub issues.

## Changelog

Version history for this fork, newest first (format: `YYYY.MM.DD.NN`). Full diffs are on [GitHub](https://github.com/GokulSP/Summarize-with-AI/commits/main).

### 2026.07.06.01

- Engineering-guide audit: Vitest test suite, JSDoc type-checking (`tsc --checkJs`, `jsconfig.json`), markdownlint-cli2, Biome v2 `assist.actions.source.organizeImports`, filled in `package.json` metadata (name/version/description/repository/etc.)
- Extracted `extractSummaryFromResponse` out of `handleApiResponse` into a standalone, unit-tested function
- Fixed `@namespace` to point at this fork's own repository instead of the upstream project
- Consolidated BUILD.md, FEATURES.md, FORK.md, and CHANGELOG.md into this README
- `scripts/sync-metadata.js` now also keeps `package.json`'s `version` field in sync

### 2026.07.03.02

- fix: handle non-text content blocks and stale cached model IDs

### 2026.07.03.01

- fix: surface API response diagnostics in empty-summary error

### 2026.06.30.01

- refactor: replace site-specific prompt system with a single universal prompt
- feat: add Bloomberg and ABC Australia to supported sites
- feat: auto-discover latest Gemini Flash model at runtime; drop version labels from UI
- chore: update Gemini fallback model
- chore: pin Node 24 and the pnpm version; add pre-push lockfile check

### 2026.06.28.01

- feat: auto-discover latest Claude Sonnet model at runtime
- feat: remove support for The Guardian, Inoreader, and ft.com
- chore: migrate git hooks from Husky to Lefthook

### 2026.03.08.01

- Update Claude model to Sonnet 4.6

### 2026.01.09.03

- fix: normalize spacing between section headings and content

### 2026.01.07

- Add HBR "leadership" and "Women at Work" banner images to the image-exclusion filter

### 2026.01.04

- docs: update documentation to reflect Gemini support and current features

### 2026.01.01.26 — Personal Fork, Complete Overhaul

Complete overhaul from original (1,837 lines → 3,284 lines, +79% increase).

#### New Features Added

- **Multiple AI Service Support** - Full support for both Claude and Gemini with separate API key management
- **Model-Specific Caching** - Each AI model maintains its own summary cache for instant switching
- **Image Gallery & Lightbox** - Extract and view article images with full-screen lightbox and swipe navigation
- **Q&A System** - Ask questions about articles with context-aware responses using the selected AI model
- **Copy Summary** - One-click copy with HTML formatting and fallback strategies
- **Custom Modals** - Professional Dieter Rams-inspired modals replacing browser dialogs
- **Publication-Specific Prompts** - Tailored summarization for research vs news articles (later replaced by the [Universal Prompt](#universal-prompt))
- **Inoreader Integration** - Summarize selected text on Inoreader (later removed, see 2026.06.28.01)

#### Architecture Improvements

- Service layer (StorageService, NotificationService, ModalService, PromptBuilder, UIHelpers)
- Centralized CONFIG object eliminating magic numbers
- State management with a single state object
- DOM caching for performance

#### Performance Optimizations

- Pre-compiled regex patterns
- LRU cache for model configurations
- Event delegation for UI components
- Intersection Observer for lazy loading
- Batch DOM operations

#### UI/UX Enhancements

- CSS design system with variables
- Comprehensive dark mode support
- Mobile-optimized with touch/swipe gestures
- Toast notifications with animations
- Professional menu bar layout

## License

This project is licensed under the WTFPL (Do What The F*ck You Want To Public License).
See [LICENSE](LICENSE) for details.

## Credits & Authors

- **Readability.js**: Mozilla's article extraction library
- **Anthropic Claude** and **Google Gemini**: AI summarization engines
- **Dieter Rams**: Design inspiration for the UI

**Original Project:**

- **Hélio** ([@insign](https://github.com/insign)) - Original creator

**This Personal Fork:**

- **Gokul SP** ([@gokulsp](https://github.com/gokulsp)) - Personal fork for individual use
- **Claude (Anthropic)** - AI assistant for documentation and setup

---

*Personal fork of the original [Summarize with AI](https://github.com/insign/userscripts) by Hélio*
