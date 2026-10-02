// ==UserScript==
// @name        Summarize with AI
// @namespace   https://github.com/GokulSP/summarize-with-AI
// @version     2026.10.03.01
// @description Single-button AI summarization (Claude & Gemini) with model selection dropdown for articles/news. Uses Alt+S shortcut. Long press 'S' (tap-and-hold on mobile, Arrow Up from the keyboard) to select model. Custom modals with Dieter Rams-inspired design. Adapts to dark mode and mobile viewports.
// @author      Hélio <open@helio.me>
// @contributor Gokul SP (Personal fork maintainer)
// @contributor Claude (Anthropic AI assistant)
// @license     WTFPL
// @match       https://hbr.org/*
// @match       https://www.economist.com/*
// @match       https://www.mckinsey.com/*
// @grant       GM.addStyle
// @grant       GM.xmlHttpRequest
// @grant       GM.setValue
// @grant       GM.getValue
// @connect     api.anthropic.com
// @connect     generativelanguage.googleapis.com
// @require     https://cdnjs.cloudflare.com/ajax/libs/readability/0.6.0/Readability.min.js
// @require     https://cdnjs.cloudflare.com/ajax/libs/readability/0.6.0/Readability-readerable.min.js
// @downloadURL https://gokulsp.github.io/summarize-with-AI/Summarize%20with%20AI.user.js
// @updateURL   https://gokulsp.github.io/summarize-with-AI/Summarize%20with%20AI.meta.js
// ==/UserScript==

(() => {
	const CONFIG = {
		// DOM Element IDs
		// All prefixed "sai-" (Summarize with AI) since this script runs on arbitrary
		// third-party pages via @match — an unprefixed id like "custom-modal" could
		// plausibly already exist on a host page.
		ids: {
			button: "sai-summarize-button",
			dropdown: "sai-model-dropdown",
			overlay: "sai-summarize-overlay",
			closeButton: "sai-summarize-close",
			content: "sai-summarize-content",
			error: "sai-summarize-error",
			retryButton: "sai-summarize-retry-button",
			askButton: "sai-summarize-ask-button",
			questionInput: "sai-summarize-question-input",
			questionSection: "sai-summarize-question-section",
			modal: "sai-custom-modal",
			modalOverlay: "sai-custom-modal-overlay",
			modalContent: "sai-custom-modal-content",
			modalMessage: "sai-custom-modal-message",
			modalInput: "sai-custom-modal-input",
			modalActions: "sai-custom-modal-actions",
		},

		// Timing & Duration (milliseconds)
		timing: {
			longPressDuration: 500,
			apiRequestTimeout: 60000,
			errorNotificationDuration: 4000,
			focusDebounceDelay: 50,
			modalFocusDelay: 100,
			modalCloseTransition: 200,
			errorFadeOut: 200,
		},

		// Length & Size Limits
		limits: {
			defaultMaxTokens: 2000,
			targetWordCount: 300,
			bulletPointMaxWords: 20,
			maxImages: 12,
			galleryDisplayLimit: 6,
			// ~100k chars (~25k tokens) comfortably covers even long-form articles/reports
			// while keeping the request well under typical API context limits and cost.
			maxArticleContentLength: 100000,
		},

		// Selectors
		selectors: {
			input: 'input, textarea, select, [contenteditable="true"]',
		},

		// Model Groups
		modelGroups: {
			claude: {
				name: "Claude",
				models: [{ id: "claude-sonnet-4-6", name: "Sonnet" }],
			},
			gemini: {
				name: "Gemini",
				models: [{ id: "gemini-3.5-flash", name: "Flash" }],
			},
		},

		// UI font stack; colors live as CSS custom properties on .sai-scope
		styles: {
			fontFamily:
				'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
		},
	};

	/** @typedef {{ title: string, content: string }} ArticleData */
	/** @typedef {{ src: string, alt: string, width: number, height: number, type: 'image' | 'iframe', priority: number }} ImageItem */
	/** @typedef {{ id: string, name: string }} ModelEntry */
	/** @typedef {keyof typeof CONFIG.modelGroups} Service */
	/** @typedef {ModelEntry & { service: Service }} ModelConfig */
	/** @typedef {{ modelConfig: ModelConfig, apiKey: string, service: Service, modelDisplayName: string }} ValidationResult */
	/** @typedef {{ title: string, content: string, timestamp: string }} Summary */
	/** @typedef {{ status: number, data: any, statusText?: string, service: Service }} ApiResponse */
	/** @typedef {{ setBusy: (busy: boolean) => void, showAnswer: (html: string) => void, clearQuestion: () => void }} AnswerBox */
	/** @typedef {{ isError?: boolean, isLoading?: boolean, images?: ImageItem[] }} OverlayContentOptions */
	/** @typedef {{ img: HTMLImageElement, iframe: HTMLIFrameElement, counter: HTMLElement, prevBtn: HTMLButtonElement, nextBtn: HTMLButtonElement, thumbnailStrip: HTMLElement }} LightboxElements */

	// --- AI providers ---
	// Everything that differs between Claude and Gemini lives here, so the rest of the script
	// never names a provider: how to build a request, read its response, discover the latest
	// model (and cache it), and any model to fall back to. Adding a provider is one entry here
	// plus its CONFIG.modelGroups entry for the dropdown.
	/**
	 * @typedef {object} Provider
	 * @property {string} idPrefix model ids starting with this belong to the provider
	 * @property {(apiKey: string, prompt: string, modelId: string, maxTokens: number) => { url: string, headers: Record<string, string>, body: object }} request
	 * @property {(data: any) => { rawSummary: string, finishReason: string | null, blockType: string | null }} parse
	 * @property {string} truncatedReason the finishReason meaning the max token limit cut it short
	 * @property {{ cacheKey: string, activePrefix: string, name: string, label: string, fetchId: (apiKey: string) => Promise<string> }} latest
	 * @property {{ model: ModelConfig, reason: string, appliesTo: (error: Error) => boolean }} [fallback]
	 */

	const ANTHROPIC_HEADERS = {
		"anthropic-version": "2023-06-01",
		"anthropic-dangerous-direct-browser-access": "true",
	};

	/** @type {Record<Service, Provider>} */
	const PROVIDERS = {
		claude: {
			idPrefix: "claude",
			request: (apiKey, prompt, modelId, maxTokens) => ({
				url: "https://api.anthropic.com/v1/messages",
				headers: { "Content-Type": "application/json", "x-api-key": apiKey, ...ANTHROPIC_HEADERS },
				body: {
					model: modelId,
					messages: [{ role: "user", content: prompt }],
					max_tokens: maxTokens,
				},
			}),
			parse: data => {
				// Extended-thinking responses prepend a `thinking` block before the `text` block.
				const blocks = data?.content || [];
				const textBlock = blocks.find((/** @type {any} */ b) => b.type === "text") || blocks[0];
				return {
					rawSummary: textBlock?.text || "",
					finishReason: data?.stop_reason || null,
					blockType: textBlock?.type || null,
				};
			},
			truncatedReason: "max_tokens",
			latest: {
				cacheKey: "latest_sonnet_cache",
				activePrefix: "claude-sonnet",
				name: "Sonnet",
				label: "Sonnet",
				fetchId: async apiKey => {
					const data = await fetchModelsList("https://api.anthropic.com/v1/models", {
						"x-api-key": apiKey,
						...ANTHROPIC_HEADERS,
					});
					/** @type {{ id: string }[]} */
					const sonnetModels = (data.data || [])
						.filter((/** @type {{ id: string }} */ m) => m.id?.startsWith("claude-sonnet"))
						.sort((/** @type {{ id: string }} */ a, /** @type {{ id: string }} */ b) =>
							b.id.localeCompare(a.id),
						);
					if (sonnetModels.length === 0) throw new Error("No Sonnet models found");
					return sonnetModels[0].id;
				},
			},
		},
		gemini: {
			idPrefix: "gemini",
			// The key goes in a header, not the URL, so it stays out of logs and history.
			request: (apiKey, prompt, modelId) => ({
				url: `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`,
				headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
				body: { contents: [{ parts: [{ text: prompt }] }] },
			}),
			parse: data => {
				// { candidates: [{ content: { parts: [{ text }] } }] }; thinking-enabled models may
				// prepend parts with `thought: true` before the answer part.
				const candidate = data?.candidates?.[0];
				const parts = candidate?.content?.parts || [];
				const answerPart = parts.find((/** @type {any} */ p) => p.text && !p.thought) || parts[0];
				return {
					rawSummary: answerPart?.text || "",
					finishReason: candidate?.finishReason || null,
					blockType: answerPart?.thought ? "thought" : null,
				};
			},
			truncatedReason: "MAX_TOKENS",
			latest: {
				cacheKey: "latest_gemini_cache",
				activePrefix: "gemini",
				name: "Flash",
				label: "Gemini",
				fetchId: async apiKey => {
					const data = await fetchModelsList(
						"https://generativelanguage.googleapis.com/v1beta/models",
						{ "x-goog-api-key": apiKey },
					);
					// Exclude flash variants built for a different call shape (live/interactions,
					// audio, image, tts, managed agents) even though they list generateContent support.
					const NON_TEXT_VARIANT =
						/live|audio|tts|image|native-audio|realtime|computer-use|agent|deep-research|antigravity|interaction/;
					/** @typedef {{ name: string, supportedGenerationMethods?: string[] }} GeminiModel */
					/** @type {string[]} */
					const flashModels = (data.models || [])
						.filter((/** @type {GeminiModel} */ m) => {
							const id = m.name?.replace("models/", "");
							return (
								id?.includes("flash") &&
								!NON_TEXT_VARIANT.test(id) &&
								(m.supportedGenerationMethods || []).includes("generateContent")
							);
						})
						.map((/** @type {GeminiModel} */ m) => m.name.replace("models/", ""))
						.sort((/** @type {string} */ a, /** @type {string} */ b) => b.localeCompare(a));
					if (flashModels.length === 0) throw new Error("No Gemini Flash models found");
					return flashModels[0];
				},
			},
			// An auto-discovered model can need the Interactions API, which generateContent
			// can't call; the stable seed model always works.
			fallback: {
				model: { id: "gemini-3.5-flash", name: "Flash", service: "gemini" },
				reason: "Auto-discovered Gemini model requires the Interactions API",
				appliesTo: error => /Interactions API/i.test(error.message),
			},
		},
	};

	/** @param {string} modelId @returns {Service | null} */
	const serviceForModelId = modelId =>
		/** @type {Service | undefined} */ (
			Object.keys(PROVIDERS).find(s =>
				modelId.startsWith(PROVIDERS[/** @type {Service} */ (s)].idPrefix),
			)
		) ?? null;

	/** @param {string} title @param {string} content */
	const PROMPT_TEMPLATE = (title, content) => `Target: ~${CONFIG.limits.targetWordCount} words
Tags: <p>, <ul>, <li>, <strong> only

<article>
<title>${title}</title>
<content>${content}</content>
</article>

Summarize this article accurately and concisely. Ground key points in the article's concrete facts, figures, and statistics rather than vague generalities.

Format exactly as shown:

<p><strong>Core Insight:</strong></p>
<p>The central finding, argument, or event in one sentence.</p>

<p><strong>Key Points:</strong></p>
<ul>
<li>Most important point, citing specific data/figures where the article provides them (max ${CONFIG.limits.bulletPointMaxWords} words)</li>
<li>Second key point, citing specific data/figures where the article provides them (max ${CONFIG.limits.bulletPointMaxWords} words)</li>
<li>Third key point, citing specific data/figures where the article provides them (max ${CONFIG.limits.bulletPointMaxWords} words)</li>
<li>Fourth key point, citing specific data/figures where the article provides them (max ${CONFIG.limits.bulletPointMaxWords} words)</li>
</ul>

<p><strong>Significance:</strong></p>
<p>Real-world impact, practical application, or broader implications in 1-2 sentences. If the article uses a notable analogy or illustrative example, work it in here to make the point memorable; omit if none.</p>

<p><strong>Context:</strong></p>
<p>Relevant background, historical perspective, or setting in 1-2 sentences.</p>

<p><strong>Limitations:</strong></p>
<p>Counterarguments, missing perspectives, or unresolved uncertainties in 1-2 sentences.</p>`;

	// Storage Layer - Centralized storage operations
	const StorageService = {
		keys: {
			LAST_USED_MODEL: "last_used_model",
			/** @param {string} service */
			API_KEY: service => `${service}_api_key`,
		},

		/** @param {string} defaultModel */
		async loadLastUsedModel(defaultModel) {
			return await GM.getValue(this.keys.LAST_USED_MODEL, defaultModel);
		},

		/** @param {string} modelId */
		async saveLastUsedModel(modelId) {
			return await GM.setValue(this.keys.LAST_USED_MODEL, modelId);
		},

		/** @param {string} service */
		async loadApiKey(service) {
			const apiKey = /** @type {string | undefined} */ (
				await GM.getValue(this.keys.API_KEY(service))
			);
			return apiKey?.trim() || null;
		},

		/** @param {string} service @param {string} apiKey */
		async saveApiKey(service, apiKey) {
			return await GM.setValue(this.keys.API_KEY(service), apiKey.trim());
		},

		/** @param {string} cacheKey */
		async loadModelCache(cacheKey) {
			return /** @type {{ modelId: string, timestamp: number } | null} */ (
				await GM.getValue(cacheKey, null)
			);
		},

		/** @param {string} cacheKey @param {string} modelId */
		async saveModelCache(cacheKey, modelId) {
			await GM.setValue(cacheKey, { modelId, timestamp: Date.now() });
		},

		/** @param {string} cacheKey */
		async clearModelCache(cacheKey) {
			await GM.setValue(cacheKey, null);
		},
	};

	// UI Helper Functions
	/**
	 * Shows message inside the open overlay, or as a notification when none is open.
	 * @param {string} message
	 */
	function showMessage(message) {
		if (Overlay.isOpen()) {
			Overlay.update(`<p class="sai-error-text">${escapeHtml(message)}</p>`, {
				images: state.articleImages,
			});
		} else {
			showErrorNotification(message);
		}
	}

	/** @typedef {HTMLElement & { _escHandler?: (e: KeyboardEvent) => void }} ModalOverlayElement */
	/** @typedef {{ message: string, inputType?: string, placeholder?: string, defaultValue?: string }} ModalOptions */

	// Custom Modal Service - Dieter Rams inspired design
	const ModalService = {
		/** @type {ModalOverlayElement | null} */
		currentModal: null,
		/** @type {((value: any) => void) | null} */
		resolveCallback: null,

		/** @param {string} type @param {ModalOptions} options */
		create(type, options) {
			return new Promise(resolve => {
				// A modal replaced before it was answered counts as cancelled, so its
				// caller isn't left waiting forever.
				this.resolveCallback?.(null);
				this.resolveCallback = resolve;
				this.show(type, options);
			});
		},

		/** @param {string} type @param {ModalOptions} options */
		show(type, options) {
			// Remove existing modal if any
			this.close();

			const modalOverlay = /** @type {ModalOverlayElement} */ (
				createElement("div", {
					id: CONFIG.ids.modalOverlay,
					className: "sai-scope sai-modal-overlay",
				})
			);

			const modalContent = createElement("div", {
				id: CONFIG.ids.modalContent,
				className: `sai-modal-content sai-modal-${type}`,
			});

			modalContent.appendChild(
				createElement("div", {
					id: CONFIG.ids.modalMessage,
					className: "sai-modal-message",
					textContent: options.message,
				}),
			);

			// Input field for prompt type
			let inputEl = null;
			if (type === "prompt") {
				inputEl = createElement("input", {
					id: CONFIG.ids.modalInput,
					className: "sai-modal-input",
					type: options.inputType || "text",
					placeholder: options.placeholder || "",
					value: options.defaultValue || "",
				});
				modalContent.appendChild(inputEl);
			}

			// Actions
			const actionsEl = createElement("div", {
				id: CONFIG.ids.modalActions,
				className: "sai-modal-actions",
			});

			if (type === "alert") {
				const okBtn = createElement("button", {
					className: "sai-modal-button sai-modal-button-primary",
					textContent: "OK",
					onclick: () => this.resolve(true),
					onmouseout: (/** @type {MouseEvent} */ e) =>
						/** @type {HTMLElement} */ (e.target)?.blur(),
				});
				actionsEl.appendChild(okBtn);
			} else if (type === "prompt") {
				const cancelBtn = createElement("button", {
					className: "sai-modal-button sai-modal-button-secondary",
					textContent: "Cancel",
					onclick: () => this.resolve(null),
					onmouseout: (/** @type {MouseEvent} */ e) =>
						/** @type {HTMLElement} */ (e.target)?.blur(),
				});
				const okBtn = createElement("button", {
					className: "sai-modal-button sai-modal-button-primary",
					textContent: "OK",
					onclick: () => {
						const value = inputEl?.value || "";
						this.resolve(value);
					},
					onmouseout: (/** @type {MouseEvent} */ e) =>
						/** @type {HTMLElement} */ (e.target)?.blur(),
				});
				actionsEl.appendChild(cancelBtn);
				actionsEl.appendChild(okBtn);

				// Enter key submit
				if (inputEl) {
					inputEl.addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							okBtn.click();
						} else if (e.key === "Escape") {
							e.preventDefault();
							cancelBtn.click();
						}
					});
				}
			}

			modalContent.appendChild(actionsEl);
			modalOverlay.appendChild(modalContent);
			document.body.appendChild(modalOverlay);

			// Focus management
			if (inputEl) {
				setTimeout(() => inputEl.focus(), CONFIG.timing.modalFocusDelay);
			}

			// ESC key handler
			/** @param {KeyboardEvent} e */
			const escHandler = e => {
				if (e.key === "Escape") {
					e.preventDefault();
					this.resolve(type === "prompt" ? null : false);
				}
			};
			document.addEventListener("keydown", escHandler);
			modalOverlay._escHandler = escHandler;

			// Click outside to close (only for alerts)
			if (type === "alert") {
				modalOverlay.onclick = e => {
					if (e.target === modalOverlay) {
						this.resolve(true);
					}
				};
			}

			this.currentModal = modalOverlay;

			// Animation
			requestAnimationFrame(() => {
				modalOverlay.classList.add("sai-modal-active");
			});
		},

		/** @param {any} value */
		resolve(value) {
			const modal = this.currentModal;
			// Already closing: a second click or key during the fade-out is ignored.
			if (!modal?._escHandler) return;
			document.removeEventListener("keydown", modal._escHandler);
			modal._escHandler = undefined;
			modal.classList.remove("sai-modal-active");
			setTimeout(() => {
				this.close();
				this.resolveCallback?.(value);
				this.resolveCallback = null;
			}, CONFIG.timing.modalCloseTransition);
		},

		close() {
			if (this.currentModal) {
				this.currentModal.remove();
				this.currentModal = null;
			}
		},

		// Convenience methods
		/** @param {string} message */
		async alert(message) {
			return await this.create("alert", { message });
		},

		/** @param {string} message @param {string} [defaultValue] @param {string} [placeholder] */
		async prompt(message, defaultValue = "", placeholder = "") {
			return /** @type {Promise<string | null>} */ (
				this.create("prompt", { message, defaultValue, placeholder })
			);
		},
	};

	// Helper to convert service name to Title Case
	/** @param {string} str */
	const toTitleCase = str => {
		return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
	};

	// What this page's summarizing session knows. The overlay, model menu and lightbox
	// each own their own DOM; none of them keeps a copy of this.
	/** @type {{ activeModel: string, articleData: ArticleData | null, articleImages: ImageItem[], summaryCache: Map<string, { articleData: ArticleData | null, images: ImageItem[], summary: Summary }> }} */
	const state = {
		activeModel: CONFIG.modelGroups.claude.models[0].id,
		articleData: null,
		articleImages: [],
		summaryCache: new Map(), // modelId -> { articleData, images, summary }
	};

	/** @param {() => void} onLongPress @param {number} [duration] */
	const createLongPressHandler = (onLongPress, duration = CONFIG.timing.longPressDuration) => {
		/** @type {ReturnType<typeof setTimeout> | null} */
		let timer = null;
		let isLongPress = false;

		const start = () => {
			isLongPress = false;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				isLongPress = true;
				onLongPress();
			}, duration);
		};

		/** @param {Event} e */
		const cancel = e => {
			e.stopPropagation();
			if (timer) clearTimeout(timer);
		};

		const check = () => {
			const wasLongPress = isLongPress;
			isLongPress = false;
			return wasLongPress;
		};

		/** @param {HTMLElement} element */
		const attachTo = element => {
			const passiveOptions = { passive: true };
			element.addEventListener("mousedown", start);
			element.addEventListener("mouseup", cancel);
			element.addEventListener("mouseleave", cancel);
			element.addEventListener("touchstart", start, passiveOptions);
			element.addEventListener("touchend", cancel);
			element.addEventListener("touchmove", cancel);
			element.addEventListener("touchcancel", cancel);
		};

		return { check, attachTo };
	};

	/**
	 * @template {keyof HTMLElementTagNameMap} K
	 * @param {K} tag
	 * @param {Record<string, any>} [attrs]
	 * @returns {HTMLElementTagNameMap[K]}
	 */
	const createElement = (tag, attrs = {}) => {
		const el = /** @type {any} */ (document.createElement(tag));

		for (const [key, value] of Object.entries(attrs)) {
			if (key === "style") {
				el.style.cssText = value;
			} else if (key.startsWith("on")) {
				el.addEventListener(key.substring(2).toLowerCase(), value);
			} else {
				el[key] = value;
			}
		}

		return el;
	};

	// --- Summary Overlay ---
	// Owns the overlay element, its listeners and the Q&A box. Callers hand it content
	// and react to what the user does through the callbacks below.
	const Overlay = (() => {
		/** @type {HTMLElement | null} */
		let overlay = null;
		/** @type {(() => void) | null} */
		let cleanup = null;
		/** @type {ImageItem[]} */
		let images = [];

		/** @param {string} contentHTML @param {OverlayContentOptions} options */
		function buildContent(contentHTML, { isError = false, isLoading = false }) {
			let html = `<div class="sai-summary-content-body">${contentHTML}</div>`;

			if (isError) {
				html += `<div style="text-align:center;padding-bottom:var(--space-md)"><button id="${CONFIG.ids.retryButton}" class="sai-retry-button">Try Again</button></div>`;
			} else if (!isLoading) {
				if (images.length > 0) {
					const galleryItems = [];
					const displayLimit = Math.min(images.length, CONFIG.limits.galleryDisplayLimit);
					for (let i = 0; i < displayLimit; i++) {
						const item = images[i];
						if (item.type === "iframe") {
							galleryItems.push(`<button type="button" class="sai-gallery-item sai-gallery-item-iframe" data-image-index="${i}">
                <span class="sai-iframe-preview">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <rect x="2" y="3" width="20" height="14" rx="2"/>
                    <line x1="8" y1="21" x2="16" y2="21"/>
                    <line x1="12" y1="17" x2="12" y2="21"/>
                    <path d="M7 8l5 3-5 3V8z"/>
                  </svg>
                  <span>Interactive Chart</span>
                </span>
              </button>`);
						} else {
							galleryItems.push(`<button type="button" class="sai-gallery-item" data-image-index="${i}">
                <img src="${escapeHtml(item.src)}" alt="${escapeHtml(item.alt || "Article image")}" loading="lazy" decoding="async" />
              </button>`);
						}
					}
					html += `<div class="sai-image-gallery">${galleryItems.join("")}</div>`;
				}

				html += `<div id="${CONFIG.ids.questionSection}" class="sai-question-section">
          <label class="sai-question-header" for="${CONFIG.ids.questionInput}">Ask a question about this article:</label>
          <div class="sai-question-input-wrapper">
            <input
              type="text"
              id="${CONFIG.ids.questionInput}"
              class="sai-question-input"
              placeholder="Ask a question..."
            />
            <button id="${CONFIG.ids.askButton}" class="sai-ask-button">Ask</button>
          </div>
          <div id="sai-answer-container" class="sai-answer-container"></div>
        </div>`;
			}

			html += `<div class="sai-summary-menubar">`;
			html += `<button id="${CONFIG.ids.closeButton}" class="sai-menubar-button" title="Close (Esc)">Close</button></div>`;
			return html;
		}

		/**
		 * Wires the freshly rendered content to the callbacks; returns the cleanup.
		 * @param {HTMLElement} content
		 */
		function attachHandlers(content) {
			const closeBtn = content.querySelector(`#${CONFIG.ids.closeButton}`);
			const retryBtn = content.querySelector(`#${CONFIG.ids.retryButton}`);
			const askBtn = /** @type {HTMLButtonElement | null} */ (
				content.querySelector(`#${CONFIG.ids.askButton}`)
			);
			const questionInput = /** @type {HTMLInputElement | null} */ (
				content.querySelector(`#${CONFIG.ids.questionInput}`)
			);
			const answerContainer = /** @type {HTMLElement | null} */ (
				content.querySelector("#sai-answer-container")
			);
			const imageGallery = content.querySelector(".sai-image-gallery");

			const ask = () => {
				if (!questionInput || !answerContainer) return;
				/** @type {AnswerBox} */
				const answerBox = {
					setBusy(busy) {
						questionInput.disabled = busy;
						if (askBtn) {
							askBtn.disabled = busy;
							askBtn.textContent = busy ? "Thinking..." : "Ask";
						}
					},
					showAnswer(html) {
						answerContainer.innerHTML = html;
					},
					clearQuestion() {
						questionInput.value = "";
					},
				};
				handleAskQuestion(questionInput.value.trim(), answerBox);
			};
			const handlers = {
				close: () => close(),
				retry: () => processSummarization(),
				ask,
				/** @param {Event} e */
				keypress: e => {
					if (/** @type {KeyboardEvent} */ (e).key === "Enter") ask();
				},
				/** @param {Event} e */
				galleryClick: e => {
					const item = /** @type {HTMLElement} */ (e.target)?.closest(".sai-gallery-item");
					if (item instanceof HTMLElement && item.dataset.imageIndex) {
						Lightbox.open(images, parseInt(item.dataset.imageIndex, 10));
					}
				},
			};

			closeBtn?.addEventListener("click", handlers.close);
			retryBtn?.addEventListener("click", handlers.retry);
			askBtn?.addEventListener("click", handlers.ask);
			questionInput?.addEventListener("keypress", handlers.keypress);
			imageGallery?.addEventListener("click", handlers.galleryClick);

			return () => {
				closeBtn?.removeEventListener("click", handlers.close);
				retryBtn?.removeEventListener("click", handlers.retry);
				askBtn?.removeEventListener("click", handlers.ask);
				questionInput?.removeEventListener("keypress", handlers.keypress);
				imageGallery?.removeEventListener("click", handlers.galleryClick);
			};
		}

		/** @param {HTMLElement} content @param {string} contentHTML @param {OverlayContentOptions} options */
		function render(content, contentHTML, options) {
			cleanup?.();
			images = options.images ?? [];
			content.innerHTML = buildContent(contentHTML, options);
			cleanup = attachHandlers(content);
		}

		/**
		 * Opens the overlay with this content, or replaces the content of the open one.
		 * @param {string} contentHTML @param {OverlayContentOptions} [options]
		 */
		function show(contentHTML, options = {}) {
			if (!overlay) {
				const opened = createElement("div", { id: CONFIG.ids.overlay, className: "sai-scope" });
				opened.appendChild(createElement("div", { id: CONFIG.ids.content }));
				opened.onclick = e => e.target === opened && close();
				document.body.appendChild(opened);
				document.body.style.overflow = "hidden";
				overlay = opened;
			}
			render(/** @type {HTMLElement} */ (overlay.firstElementChild), contentHTML, options);
		}

		/**
		 * Replaces the content only if the overlay is still open (the user may have
		 * closed it while a request was in flight).
		 * @param {string} contentHTML @param {OverlayContentOptions} [options]
		 */
		function update(contentHTML, options = {}) {
			if (overlay) show(contentHTML, options);
		}

		function close() {
			if (!overlay) return;
			cleanup?.();
			cleanup = null;
			overlay.remove();
			overlay = null;
			images = [];
			document.body.style.overflow = "";
			onClosed();
		}

		return { show, update, close, isOpen: () => overlay !== null };
	})();

	// What closing the overlay does to the session.
	function onClosed() {
		// Keep articleData and the cache for re-summarizing; drop the shown images.
		state.articleImages = [];
		ModelMenu.showButton();
	}

	// --- Main Functions ---
	async function initialize() {
		state.articleData = getArticleData();

		if (state.articleData) {
			state.activeModel = await StorageService.loadLastUsedModel(state.activeModel);
			ModelMenu.mount();
			document.addEventListener("keydown", handleKeyPress);
			injectStyles();
		}
	}

	function getArticleData() {
		try {
			const documentClone = /** @type {Document} */ (document.cloneNode(true));
			const nonContentElements = documentClone.querySelectorAll(
				"script, style, noscript, iframe, figure, img, svg, header, footer, nav",
			);

			for (const element of nonContentElements) {
				element.remove();
			}

			if (!isProbablyReaderable(documentClone)) return null;

			const reader = new Readability(documentClone);
			const parsedArticle = reader.parse();

			return parsedArticle?.content && parsedArticle.textContent?.trim()
				? { title: parsedArticle.title, content: parsedArticle.textContent.trim() }
				: null;
		} catch (error) {
			console.error("Summarize with AI: Article parsing failed:", error);
			return null;
		}
	}

	// Pre-compiled regex patterns (compile once at module level)
	const IMAGE_ASPECT_RATIO = 0.5625; // 9/16
	const ECONOMIST_WIDTH_PARAM = /cdn-cgi\/image\/width=(\d+)/;
	const HBR_EXCLUDED_PREFIXES = [
		"https://cdn11.bigcommerce.com/",
		"https://hbr.org/resources/images/article_assets/2015/12/HBR-Ideacast-HP-feed.png",
		"https://hbr.org/resources/images/article_assets/2019/03/wide-cold-call.png",
		"https://hbr.org/resources/images/podcasts/episode-ideacast.png",
		"https://hbr.org/resources/images/podcasts/episode-cold-call.png",
		"https://hbr.org/resources/images/products/generic-tool.png",
		"https://hbr.org/resources/images/article_assets/2023/05/wide-hbr-on-leadership.png",
		"https://hbr.org/resources/images/article_assets/2019/04/WomenAtWork-Wide_WP_1200.png",
	];

	/**
	 * Per-site tweaks to the generic article-image filter, keyed by a hostname fragment.
	 * Every rule is optional; a site with none uses the generic filter unchanged.
	 * @typedef {{ width: number, height: number }} ImageSize
	 * @typedef {Object} SiteImageRules
	 * @property {(img: HTMLImageElement, src: string) => boolean} [exclude] promo, teaser or
	 *   headshot images to drop outright
	 * @property {(src: string) => (ImageSize & { isChart: boolean }) | null} [sizeFromUrl] the
	 *   rendered size encoded in the URL, when naturalWidth/Height can't be trusted
	 * @property {(src: string, isChart: boolean) => boolean} [keepWhenSmall] charts worth
	 *   keeping below the generic 300px minimum
	 * @property {(size: ImageSize) => boolean} [excludeSize] known ad/promo dimensions
	 * @property {boolean} [firstLargeImageOnly] keep only the first image of 1280x720 or more
	 *   (the rest are repeats of the hero image)
	 */

	/** @type {Record<string, SiteImageRules>} */
	const SITE_IMAGE_RULES = {
		"hbr.org": {
			exclude: (_img, src) => HBR_EXCLUDED_PREFIXES.some(prefix => src.startsWith(prefix)),
			excludeSize: ({ width, height }) =>
				(width === 500 && height >= 700 && height <= 800) || (width === 383 && height === 215),
		},
		"economist.com": {
			exclude: (img, src) =>
				img.closest('[class*="e1kb1ha80"]') !== null ||
				src.includes("_DE_") ||
				// "More from"/related-article teaser cards use CSS-module classes like
				// teaser_mb-teaser__k_8Tk -- the hashed suffix changes per deploy, but the
				// mb-teaser token is stable.
				img.closest('[class*="mb-teaser"]') !== null,
			sizeFromUrl: src => {
				const match = ECONOMIST_WIDTH_PARAM.exec(src);
				if (!match) return null;
				const width = parseInt(match[1], 10);
				// WBC = Weekly Business Chart; content-assets/images also holds charts.
				const isChart = src.includes("WBC") || src.includes("content-assets/images");
				return { width, height: Math.round(width * IMAGE_ASPECT_RATIO), isChart };
			},
			// Economist charts are often only 360px wide.
			keepWhenSmall: (_src, isChart) => isChart,
			firstLargeImageOnly: true,
		},
		"mckinsey.com": {
			exclude: (_img, src) =>
				src.includes("/our%20people/") || src.includes("-thumb") || src.includes("headshot"),
			// Exhibit charts are vector SVGs (often gzipped .svgz) with no intrinsic raster
			// size, so naturalWidth/naturalHeight report 0.
			keepWhenSmall: src => src.includes(".svgz") || src.includes(".svg"),
		},
	};

	async function extractArticleImages() {
		try {
			const hostname = window.location.hostname;
			/** @type {SiteImageRules} */
			const rules =
				Object.entries(SITE_IMAGE_RULES).find(([host]) => hostname.includes(host))?.[1] ?? {};

			// Scroll each lazy image into view on the next frame so it starts loading, then
			// give the batch 100ms. Hidden tabs pause animation frames, so 500ms caps the wait.
			/** @returns {Promise<void>} */
			const triggerLazyLoading = () =>
				new Promise(resolve => {
					const images = document.querySelectorAll(
						'img[loading="lazy"], img[data-src], img[data-lazy-src]',
					);
					if (images.length === 0) {
						resolve();
						return;
					}
					setTimeout(resolve, 500);
					requestAnimationFrame(() => {
						for (const img of images) img.scrollIntoView({ block: "nearest", behavior: "auto" });
						setTimeout(resolve, 100);
					});
				});

			await triggerLazyLoading();

			const maxImages = CONFIG.limits.maxImages;
			/** @type {ImageItem[]} */
			const images = [];
			/** @type {Set<string>} */
			const seen = new Set();

			let hasLargeImage = false;

			// Visualization domains for fast checking
			const vizDomains = ["flo.uri.sh", "flourish", "datawrapper.dwcdn.net"];

			// STEP 1: Extract interactive visualizations FIRST (highest priority)
			const iframeSelector =
				'article iframe, main iframe, [role="main"] iframe, .article-content iframe, .post-content iframe, .entry-content iframe';
			const iframes = /** @type {NodeListOf<HTMLIFrameElement>} */ (
				document.querySelectorAll(iframeSelector)
			);

			for (const iframe of iframes) {
				if (images.length >= maxImages) break;

				const src = iframe.src || iframe.dataset.src;
				if (!src || seen.has(src)) continue;

				if (vizDomains.some(domain => src.includes(domain))) {
					seen.add(src);
					images.push({
						src,
						alt: iframe.title || "Interactive visualization",
						width: Number(iframe.width) || 800,
						height: Number(iframe.height) || 600,
						type: "iframe",
						priority: 1,
					});
				}
			}

			// STEP 2: Extract regular images into whatever room the iframes left
			const combinedSelector =
				'article img, main img, [role="main"] img, .article-content img, .post-content img, .entry-content img';
			const imgs = /** @type {NodeListOf<HTMLImageElement>} */ (
				document.querySelectorAll(combinedSelector)
			);

			for (const img of imgs) {
				if (images.length >= maxImages) break;

				const src = img.currentSrc || img.src || img.dataset.src || img.dataset.lazySrc;
				if (!src || seen.has(src) || src.startsWith("data:")) continue;

				if (rules.exclude?.(img, src)) continue;

				const fromUrl = rules.sizeFromUrl?.(src) ?? null;
				const width = fromUrl ? fromUrl.width : img.naturalWidth;
				const height = fromUrl ? fromUrl.height : img.naturalHeight;
				const isChart = fromUrl?.isChart ?? false;

				if ((width < 300 || height < 300) && !rules.keepWhenSmall?.(src, isChart)) continue;
				if (rules.excludeSize?.({ width, height })) continue;
				if (rules.firstLargeImageOnly && width >= 1280 && height >= 720) {
					if (hasLargeImage) continue;
					hasLargeImage = true;
				}

				seen.add(src);
				images.push({
					src,
					alt: img.alt || "",
					width,
					height,
					type: "image",
					priority: 0,
				});
			}

			return images;
		} catch (error) {
			console.error("Summarize with AI: Image extraction failed:", error);
			return [];
		}
	}

	// --- Summarize Button & Model Menu ---
	// Owns the floating S button and its model dropdown: tap summarizes, long-press
	// opens the menu, and both hide while the user types in a page input.
	const ModelMenu = (() => {
		/** @type {HTMLElement | null} */
		let button = null;
		/** @type {HTMLElement | null} */
		let dropdown = null;
		// The menu is rebuilt on next open once the model list changes.
		let stale = true;

		/** @param {string} text @param {Service} service */
		function createHeader(text, service) {
			const container = createElement("div", { className: "sai-group-header-container" });
			container.appendChild(
				createElement("span", { className: "sai-group-header-text", textContent: text }),
			);
			container.appendChild(
				createElement("button", {
					type: "button",
					textContent: "Reset Key",
					className: "sai-reset-key-link",
					title: `Reset ${text} API Key`,
					onclick: (/** @type {MouseEvent} */ e) => {
						e.stopPropagation();
						handleApiKeyReset(service);
					},
				}),
			);
			return container;
		}

		/** @param {ModelEntry} modelObj @param {Service} service */
		function createModelItem(modelObj, service) {
			const item = createElement("button", {
				type: "button",
				className: "sai-model-item",
				textContent: modelObj.name,
				title: "Click to use this model.",
			});
			item.dataset.modelId = modelObj.id;
			item.dataset.service = service;
			if (modelObj.id === state.activeModel) {
				item.classList.add("sai-model-item-active");
			}
			return item;
		}

		/** @param {HTMLElement} menu */
		function populate(menu) {
			const fragment = document.createDocumentFragment();
			for (const [serviceKey, group] of Object.entries(CONFIG.modelGroups)) {
				const service = /** @type {Service} */ (serviceKey);
				const groupDiv = createElement("div", { className: "sai-model-group" });
				groupDiv.appendChild(createHeader(group.name, service));
				for (const modelObj of group.models) {
					groupDiv.appendChild(createModelItem(modelObj, service));
				}
				fragment.appendChild(groupDiv);
			}
			menu.innerHTML = "";
			menu.appendChild(fragment);
			stale = false;
		}

		const isDropdownOpen = () => dropdown !== null && dropdown.style.display !== "none";

		function hideDropdown() {
			if (dropdown) dropdown.style.display = "none";
		}

		function toggleDropdown() {
			if (!dropdown) return;
			if (isDropdownOpen()) {
				hideDropdown();
				return;
			}
			if (stale) populate(dropdown);
			dropdown.style.display = "block";
		}

		/** Opens the menu from the keyboard, with focus on the active model. */
		function openDropdownWithFocus() {
			if (!dropdown) return;
			if (!isDropdownOpen()) toggleDropdown();
			const item = /** @type {HTMLElement | null} */ (
				dropdown.querySelector(".sai-model-item-active") ??
					dropdown.querySelector(".sai-model-item")
			);
			item?.focus();
		}

		/** @param {boolean} visible */
		function setButtonVisible(visible) {
			if (button) button.style.display = visible ? "flex" : "none";
		}

		/** Hides the button and menu while a page input has focus, then restores the button. */
		function hideWhileTyping() {
			/** @type {ReturnType<typeof setTimeout> | null} */
			let focusOutTimer = null;

			document.addEventListener("focusin", event => {
				const target = /** @type {Element | null} */ (event.target);
				const isModalInput = target?.closest(".sai-modal-overlay");
				if (target?.closest(CONFIG.selectors.input) && !isModalInput) {
					if (focusOutTimer) {
						clearTimeout(focusOutTimer);
						focusOutTimer = null;
					}
					setButtonVisible(false);
					hideDropdown();
				}
			});

			document.addEventListener(
				"focusout",
				event => {
					const target = /** @type {Element | null} */ (event.target);
					const relatedTarget = /** @type {Element | null} */ (event.relatedTarget);
					const isModalInput = target?.closest(".sai-modal-overlay");
					const isLeavingInput = target?.closest(CONFIG.selectors.input) && !isModalInput;
					const isEnteringInput = relatedTarget?.closest(CONFIG.selectors.input);

					if (isLeavingInput && !isEnteringInput && state.articleData !== null) {
						focusOutTimer = setTimeout(() => {
							if (!document.activeElement?.closest(CONFIG.selectors.input)) {
								setButtonVisible(true);
							}
							focusOutTimer = null;
						}, CONFIG.timing.focusDebounceDelay);
					}
				},
				true,
			);
		}

		/** Adds the button and menu to the page and wires them up; called once per page. */
		function mount() {
			const summarizeButton = createElement("button", {
				type: "button",
				id: CONFIG.ids.button,
				className: "sai-scope",
				textContent: "S",
				title: "Summarize (Alt+S) / Long Press, Tap & Hold or Arrow Up to Select Model",
			});
			summarizeButton.setAttribute("aria-label", "Summarize with AI");
			summarizeButton.setAttribute("aria-haspopup", "menu");
			const menu = createElement("div", {
				id: CONFIG.ids.dropdown,
				className: "sai-scope",
				style: "display: none",
			});
			document.body.appendChild(summarizeButton);
			document.body.appendChild(menu);
			populate(menu);
			button = summarizeButton;
			dropdown = menu;

			const longPress = createLongPressHandler(toggleDropdown);
			summarizeButton.addEventListener("click", () => {
				if (!longPress.check()) processSummarization();
			});
			longPress.attachTo(summarizeButton);
			// The keyboard stand-in for a long press.
			summarizeButton.addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => {
				if (e.key === "ArrowUp" || e.key === "ContextMenu") {
					e.preventDefault();
					openDropdownWithFocus();
				}
			});

			menu.addEventListener("click", (/** @type {MouseEvent} */ e) => {
				const modelItem = /** @type {HTMLElement} */ (e.target)?.closest(".sai-model-item");
				if (modelItem instanceof HTMLElement && modelItem.dataset.modelId) {
					hideDropdown();
					onSelectModel(modelItem.dataset.modelId);
				}
			});
			// Escape inside the menu closes only the menu and hands focus back to the button.
			menu.addEventListener("keydown", (/** @type {KeyboardEvent} */ e) => {
				if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					hideDropdown();
					summarizeButton.focus();
				}
			});

			document.addEventListener("click", (/** @type {MouseEvent} */ event) => {
				const target = /** @type {Node} */ (event.target);
				if (isDropdownOpen() && !menu.contains(target) && !summarizeButton.contains(target)) {
					hideDropdown();
				}
			});
			hideWhileTyping();
		}

		return {
			mount,
			showButton: () => setButtonVisible(true),
			hideButton: () => setButtonVisible(false),
			isDropdownOpen,
			hideDropdown,
			markStale: () => {
				stale = true;
			},
		};
	})();

	/** Switches to modelId, remembers it for next time, and summarizes with it. @param {string} modelId */
	function onSelectModel(modelId) {
		state.activeModel = modelId;
		StorageService.saveLastUsedModel(modelId);
		processSummarization();
	}

	/** @param {string} message */
	function showErrorNotification(message) {
		const existing = document.getElementById(CONFIG.ids.error);
		if (existing) existing.remove();

		const errorDiv =
			/** @type {HTMLDivElement & { _autoDismissTimeout?: ReturnType<typeof setTimeout> }} */ (
				createElement("div", {
					id: CONFIG.ids.error,
					className: "sai-scope sai-error-notification",
				})
			);

		const messageEl = createElement("div", {
			className: "sai-error-message",
			innerText: message,
		});

		const closeBtn = createElement("button", {
			className: "sai-error-close",
			textContent: "×",
			onclick: () => errorDiv.remove(),
		});

		errorDiv.appendChild(messageEl);
		errorDiv.appendChild(closeBtn);
		document.body.appendChild(errorDiv);

		// Animate in
		requestAnimationFrame(() => {
			errorDiv.classList.add("sai-error-active");
		});

		// Auto-dismiss after duration, but allow manual dismiss (with cleanup)
		const autoDismissTimeout = setTimeout(() => {
			if (errorDiv.parentNode) {
				errorDiv.classList.remove("sai-error-active");
				setTimeout(() => {
					if (errorDiv.parentNode) {
						errorDiv.remove();
					}
				}, CONFIG.timing.errorFadeOut);
			}
		}, CONFIG.timing.errorNotificationDuration);

		// Store timeout reference for cleanup on manual dismiss
		errorDiv._autoDismissTimeout = autoDismissTimeout;
		closeBtn.onclick = () => {
			if (errorDiv._autoDismissTimeout) {
				clearTimeout(errorDiv._autoDismissTimeout);
			}
			errorDiv.remove();
		};
	}

	/** @returns {ModelConfig | null} */
	function getActiveModelConfig() {
		const activeId = state.activeModel;

		for (const serviceKey in CONFIG.modelGroups) {
			const service = /** @type {Service} */ (serviceKey);
			const group = CONFIG.modelGroups[service];
			const modelConfig = group.models.find(m => m.id === activeId);
			if (modelConfig) {
				return { ...modelConfig, service };
			}
		}

		console.error(`Summarize with AI: Active model configuration not found for ID: ${activeId}`);
		return null;
	}

	// Refreshes CONFIG.modelGroups[service]'s seed model to the auto-discovered latest one,
	// and follows state.activeModel along if it was still pointing at that service's model.
	/** @param {Service} service @param {string} apiKey */
	async function syncLatestModel(service, apiKey) {
		const latest = await resolveLatestModel(service, apiKey);
		if (!latest) return;
		const { activePrefix } = PROVIDERS[service].latest;

		const currentEntry = CONFIG.modelGroups[service].models[0];
		if (currentEntry.id === latest.id) return;

		currentEntry.id = latest.id;
		currentEntry.name = latest.name;
		if (state.activeModel.startsWith(activePrefix)) {
			state.activeModel = latest.id;
			StorageService.saveLastUsedModel(state.activeModel);
		}
		ModelMenu.markStale();
	}

	async function validateModelAndApiKey() {
		let modelConfig = getActiveModelConfig();
		if (!modelConfig) {
			// The persisted model ID may be stale (e.g. an auto-discovered model from a
			// prior session that no longer matches the freshly-initialized seed list).
			// Fall back to that service's seed model so the auto-discovery below can
			// reconcile state.activeModel to the current latest model.
			const fallbackService = serviceForModelId(state.activeModel);
			if (fallbackService) {
				state.activeModel = CONFIG.modelGroups[fallbackService].models[0].id;
				modelConfig = getActiveModelConfig();
			}
		}
		if (!modelConfig) {
			showErrorNotification(
				`Model "${state.activeModel}" is not available. Please select another model.`,
			);
			return null;
		}

		const service = modelConfig.service;

		const apiKey = await StorageService.loadApiKey(service);
		if (!apiKey) {
			showMessage(
				`${toTitleCase(service)} API key is required. To add one, long-press the S button and select Reset Key.`,
			);
			return null;
		}

		await syncLatestModel(service, apiKey);

		const finalModelConfig = getActiveModelConfig() ?? modelConfig;
		return {
			modelConfig: finalModelConfig,
			apiKey,
			service,
			modelDisplayName: finalModelConfig.name,
		};
	}

	async function processSummarization() {
		try {
			ModelMenu.hideButton();

			// Re-extract on every click (not just at page load) so content revealed after
			// load — e.g. clicking a "Transcript" tab — is picked up. Readability's own
			// visibility filter drops hidden tab panels at parse time, so the load-time
			// snapshot never contains a tab the user hadn't opened yet.
			const articleData = getArticleData() ?? state.articleData;
			if (!articleData) {
				showErrorNotification(
					"Unable to extract article content. Please try selecting text manually.",
				);
				ModelMenu.showButton();
				return;
			}

			if (articleData.content.length > CONFIG.limits.maxArticleContentLength) {
				throw new Error(
					`Article is too long to summarize (${articleData.content.length.toLocaleString()} characters, limit is ${CONFIG.limits.maxArticleContentLength.toLocaleString()}).`,
				);
			}

			const validationResult = await validateModelAndApiKey();
			if (!validationResult) {
				ModelMenu.showButton();
				return;
			}

			const { modelConfig } = validationResult;

			// Check cache first - use cached summary if available for this model
			const cachedData = state.summaryCache.get(modelConfig.id);
			if (cachedData?.summary) {
				state.articleData = cachedData.articleData;
				state.articleImages = cachedData.images;
				Overlay.show(cachedData.summary.content, { images: cachedData.images });
				return;
			}

			// No cache - extract images and generate new summary
			state.articleImages = await extractArticleImages();

			await executeSummarization(articleData, validationResult);
		} catch (/** @type {any} */ error) {
			handleSummarizationError(error);
			ModelMenu.showButton();
		}
	}

	// Prefixes the error with the model it came from, so the user sees which model failed.
	/** @param {Error} error @param {string} modelId */
	function annotateModelError(error, modelId) {
		error.message = `[${modelId}] ${error.message}`;
		return error;
	}

	// Providers occasionally return a transient 503 under high load; one short retry
	// resolves most of these without bothering the user with a manual re-click.
	/**
	 * @param {Service} service @param {string} apiKey @param {string} prompt
	 * @param {ModelConfig} modelConfig @param {number} [maxTokens]
	 */
	async function sendApiRequestWithRetry(service, apiKey, prompt, modelConfig, maxTokens) {
		const response = await sendApiRequest(service, apiKey, prompt, modelConfig, maxTokens);
		if (response.status !== 503) return response;

		console.warn(`Summarize with AI: [${modelConfig.id}] 503 (overloaded), retrying once in 3s`);
		await new Promise(resolve => setTimeout(resolve, 3000));
		return sendApiRequest(service, apiKey, prompt, modelConfig, maxTokens);
	}

	/** @param {ArticleData} articleData @param {ValidationResult} validationResult */
	async function executeSummarization(articleData, validationResult) {
		const { modelConfig, apiKey, service, modelDisplayName } = validationResult;

		// Update state with current article data so Q&A can access it
		state.articleData = articleData;

		console.info("Summarize with AI: using model", {
			id: modelConfig.id,
			service,
			name: modelConfig.name,
		});
		showLoadingState(modelDisplayName);

		const prompt = PROMPT_TEMPLATE(articleData.title, articleData.content);

		try {
			const response = await sendApiRequestWithRetry(service, apiKey, prompt, modelConfig);
			handleApiResponse(response);
		} catch (/** @type {any} */ error) {
			const { fallback, latest } = PROVIDERS[service];
			const canFallBack =
				fallback && modelConfig.id !== fallback.model.id && fallback.appliesTo(error);
			if (!canFallBack) throw annotateModelError(error, modelConfig.id);

			console.warn(`Summarize with AI: ${fallback.reason}, retrying with`, fallback.model.id);
			await StorageService.clearModelCache(latest.cacheKey);
			showLoadingState(fallback.model.name);
			try {
				const response = await sendApiRequestWithRetry(service, apiKey, prompt, fallback.model);
				handleApiResponse(response);
			} catch (/** @type {any} */ fallbackError) {
				throw annotateModelError(fallbackError, fallback.model.id);
			}
		}
	}

	/** @param {string} modelDisplayName */
	function showLoadingState(modelDisplayName) {
		Overlay.show(`<p class="sai-glow">Summarizing with ${escapeHtml(modelDisplayName)}... </p>`, {
			isLoading: true,
		});
	}

	/** @param {Error} error */
	function handleSummarizationError(error) {
		const errorMsg = `Error: ${error.message}`;
		console.error("Summarize with AI:", errorMsg, error);
		// The message can carry provider or response-body text, so it's escaped.
		Overlay.show(`<p class="sai-error-text">${escapeHtml(errorMsg)}</p>`, {
			isError: true,
		});
		ModelMenu.hideDropdown();
	}

	/**
	 * @param {keyof typeof CONFIG.modelGroups} service @param {string} apiKey @param {string} prompt
	 * @param {ModelConfig} modelConfig @param {number} [maxTokens]
	 * @returns {Promise<ApiResponse>}
	 */
	async function sendApiRequest(
		service,
		apiKey,
		prompt,
		modelConfig,
		maxTokens = CONFIG.limits.defaultMaxTokens,
	) {
		const { url, headers, body } = PROVIDERS[service].request(
			apiKey,
			prompt,
			modelConfig.id,
			maxTokens,
		);

		const response = await gmJsonRequest({
			method: "POST",
			url,
			headers,
			body,
			timeout: CONFIG.timing.apiRequestTimeout,
			timeoutMessage: `Request timed out after ${CONFIG.timing.apiRequestTimeout / 1000} seconds`,
		});
		return { ...response, service };
	}

	/**
	 * The script's one network call: GM.xmlHttpRequest as a Promise of the status and
	 * the parsed JSON body. Network errors, aborts, timeouts and unparseable bodies
	 * reject with an Error.
	 * @param {{ method: "GET" | "POST", url: string, headers?: Record<string, string>, body?: unknown, timeout: number, timeoutMessage: string }} request
	 * @returns {Promise<{ status: number, statusText: string, data: any }>}
	 */
	function gmJsonRequest({ method, url, headers = {}, body, timeout, timeoutMessage }) {
		return new Promise((resolve, reject) => {
			GM.xmlHttpRequest({
				method,
				url,
				headers,
				...(body === undefined ? {} : { data: JSON.stringify(body) }),
				responseType: "json",
				timeout,
				onload: response => {
					const raw = response.response || response.responseText;
					try {
						const data = typeof raw === "object" ? raw : JSON.parse(raw || "{}");
						resolve({ status: response.status, statusText: response.statusText, data });
					} catch (error) {
						reject(error);
					}
				},
				onerror: error =>
					reject(new Error(`Network error: ${error.statusText || "Failed to connect"}`)),
				onabort: () => reject(new Error("Request aborted")),
				ontimeout: () => reject(new Error(timeoutMessage)),
			});
		});
	}

	// Shared GET + status-check + JSON-parse for the two providers' "list models" endpoints;
	// each provider still does its own candidate filtering/sorting on the returned data.
	/** @param {string} url @param {Record<string, string>} [headers] @returns {Promise<any>} */
	async function fetchModelsList(url, headers = {}) {
		const { status, data } = await gmJsonRequest({
			method: "GET",
			url,
			headers,
			timeout: 10000,
			timeoutMessage: "Models API request timed out",
		});
		if (status < 200 || status >= 300) throw new Error(`Models API error: ${status}`);
		return data;
	}

	const MODEL_CACHE_TTL = 24 * 60 * 60 * 1000;

	// Cache-check -> fetch -> cache-store, warning and returning null (keep the seed model)
	// when discovery fails; only the provider's cache key and fetch differ.
	/** @param {Service} service @param {string} apiKey @returns {Promise<ModelEntry | null>} */
	async function resolveLatestModel(service, apiKey) {
		const { cacheKey, fetchId, name, label } = PROVIDERS[service].latest;
		try {
			const cached = await StorageService.loadModelCache(cacheKey);
			if (cached && Date.now() - cached.timestamp < MODEL_CACHE_TTL) {
				return { id: cached.modelId, name };
			}
			const modelId = await fetchId(apiKey);
			await StorageService.saveModelCache(cacheKey, modelId);
			return { id: modelId, name };
		} catch (/** @type {any} */ err) {
			console.warn(
				`Summarize with AI: Could not fetch latest ${label} model, using default:`,
				err.message,
			);
			return null;
		}
	}

	const REGEX_PATTERNS = {
		// Summary cleaning patterns
		cleanSummary: {
			codeFenceOpen: /^```[a-zA-Z]*\s*/,
			codeFenceClose: /\s*```$/,
			newlines: /\n/g,
			multiSpaces: / {2,}/g,
			styleAttr: / style="[^"]*"/gi,
			deprecatedAttrs: / (?:color|face|size)="[^"]*"/gi,
			fontOpenTag: /<font([^>]*)>/gi,
			fontCloseTag: /<\/font>/gi,
		},
		// Q&A formatting patterns
		formatQA: {
			brackets: /\[([^\]]+)\]/g,
			bold: /\*\*([^*]+)\*\*/g,
			numberedList: /^\d+\.\s/,
			numberedListRemove: /^\d+\.\s*/,
		},
	};

	// --- HTML Sanitization ---
	// The AI response is prompt-instructed to only ever use a handful of formatting
	// tags (see PROMPT_TEMPLATE), but the response text is still untrusted: a page
	// whose extracted content contains adversarial instructions could coax the model
	// into emitting `<script>`/`<img onerror>`/`javascript:` markup, which would then
	// execute once injected into the host page via innerHTML. This allowlist-based
	// sanitizer is the actual security boundary — the regex cleanup above is just
	// cosmetic pre-processing (markdown fences, legacy `<font>` tags).

	// Tags whose entire subtree is non-narrative (code/resources), so they're removed
	// along with their content rather than unwrapped — unwrapping `<script>` would
	// dump raw JS source as visible text for no benefit.
	const SANITIZE_STRIP_ENTIRELY = new Set([
		"SCRIPT",
		"STYLE",
		"IFRAME",
		"OBJECT",
		"EMBED",
		"LINK",
		"META",
		"BASE",
		"NOSCRIPT",
		"TEMPLATE",
		"FORM",
		"INPUT",
		"BUTTON",
		"SELECT",
		"TEXTAREA",
		"SVG",
		"MATH",
	]);

	// Everything else the AI could plausibly need for a formatted summary.
	const SANITIZE_ALLOWED_TAGS = new Set([
		"P",
		"BR",
		"B",
		"STRONG",
		"I",
		"EM",
		"UL",
		"OL",
		"LI",
		"CODE",
		"PRE",
		"A",
		"SPAN",
	]);

	// Per-tag attribute allowlist; any attribute not listed here (and every `on*`
	// handler, unconditionally) is stripped from allowed elements.
	/** @type {Record<string, string[]>} */
	const SANITIZE_ALLOWED_ATTRS = { A: ["href"] };

	const SANITIZE_UNSAFE_URL_SCHEME = /^(?:javascript|data|vbscript):/i;

	/** @param {Element} element */
	function unwrapElement(element) {
		const parent = element.parentNode;
		if (!parent) return;
		while (element.firstChild) {
			parent.insertBefore(element.firstChild, element);
		}
		parent.removeChild(element);
	}

	/** @param {string} href */
	function isSafeHref(href) {
		// Strip whitespace attackers use to break up a scheme name (e.g. "java\tscript:")
		// before testing it.
		const normalized = href.replace(/\s+/g, "");
		return !SANITIZE_UNSAFE_URL_SCHEME.test(normalized);
	}

	/** Recursively sanitizes `container`'s children in place (allowlist-based). @param {Node} container */
	function sanitizeChildren(container) {
		for (const node of Array.from(container.childNodes)) {
			// Node.COMMENT_NODE (8): drop comments outright.
			if (node.nodeType === 8) {
				container.removeChild(node);
				continue;
			}
			// Node.ELEMENT_NODE (1) is the only other case needing work; text nodes pass through untouched.
			if (node.nodeType !== 1) continue;

			const element = /** @type {Element} */ (node);
			const tag = element.tagName;

			if (SANITIZE_STRIP_ENTIRELY.has(tag)) {
				container.removeChild(element);
				continue;
			}

			if (!SANITIZE_ALLOWED_TAGS.has(tag)) {
				// Not dangerous, just not in the allowlist (e.g. a stray <div>/<h1>) —
				// unwrap so the AI's actual text content survives.
				sanitizeChildren(element);
				unwrapElement(element);
				continue;
			}

			const allowedAttrs = SANITIZE_ALLOWED_ATTRS[tag] || [];
			for (const attr of Array.from(element.attributes)) {
				const name = attr.name.toLowerCase();
				const isEventHandler = name.startsWith("on");
				const isAllowed = allowedAttrs.includes(name);
				if (isEventHandler || !isAllowed) {
					element.removeAttribute(attr.name);
				} else if (tag === "A" && name === "href" && !isSafeHref(attr.value)) {
					element.removeAttribute(attr.name);
				}
			}

			sanitizeChildren(element);
		}
	}

	/**
	 * Sanitizes untrusted HTML down to a small formatting-tag allowlist before it is
	 * ever assigned to `innerHTML`. Parses into a detached `<template>` — its `.content`
	 * fragment is inert per spec (no image loads, no event firing), unlike a plain
	 * `<div>`, so a malicious payload can't exploit the sanitization pass itself.
	 * @param {string} htmlString
	 */
	function sanitizeHtml(htmlString) {
		const template = /** @type {HTMLTemplateElement} */ (document.createElement("template"));
		template.innerHTML = htmlString;
		sanitizeChildren(template.content);
		return template.innerHTML;
	}

	/** @param {string} htmlString */
	function cleanSummaryHTML(htmlString) {
		// Use cached regex for all replacements
		const { cleanSummary } = REGEX_PATTERNS;
		const cleaned = htmlString
			.trim()
			.replace(cleanSummary.codeFenceOpen, "")
			.replace(cleanSummary.codeFenceClose, "")
			.replace(cleanSummary.newlines, " ")
			.replace(cleanSummary.multiSpaces, " ")
			.trim()
			.replace(cleanSummary.styleAttr, "")
			.replace(cleanSummary.deprecatedAttrs, "")
			.replace(cleanSummary.fontOpenTag, "<span$1>")
			.replace(cleanSummary.fontCloseTag, "</span>");

		return sanitizeHtml(cleaned);
	}

	/**
	 * Parses a raw API response into a summary string, or throws with a diagnostic
	 * message. Pure (no DOM/GM access) so it can run standalone under Vitest.
	 * @param {{status: number, data: any, statusText?: string, service: string}} response
	 * @returns {{rawSummary: string, finishReason: string|null, blockType: string|null}}
	 */
	function extractSummaryFromResponse(response) {
		const { status, data, statusText, service } = response;

		if (status < 200 || status >= 300) {
			const errorDetails =
				data?.error?.message || data?.message || statusText || "Unknown API error";
			throw new Error(`API Error (${status}): ${errorDetails}`);
		}

		const provider = PROVIDERS[/** @type {Service} */ (service)];
		const { rawSummary, finishReason, blockType } = provider.parse(data);
		if (finishReason === provider.truncatedReason) {
			console.warn("Summarize with AI: Summary may be incomplete (max token limit reached)");
		}

		if (!rawSummary && !data?.error) {
			console.error("Summarize with AI: API Response Data:", data);
			const diagnostics = [
				finishReason ? `stop reason: ${finishReason}` : null,
				blockType && blockType !== "text" ? `block type: ${blockType}` : null,
				`status: ${status}`,
			]
				.filter(Boolean)
				.join(", ");
			throw new Error(`API response did not contain a valid summary (${diagnostics}).`);
		}

		return { rawSummary, finishReason, blockType };
	}

	// A model can emit well-formed HTML right up to the cutoff (e.g. stopping after
	// "<p><strong>Key Points:</strong></p>" with no <ul> yet), so the sanitizer sees
	// valid markup and the truncation is otherwise invisible in the rendered output.
	/** @param {string | null} finishReason @param {Service} service @returns {string} */
	function truncationNotice(finishReason, service) {
		if (finishReason !== PROVIDERS[service].truncatedReason) return "";
		return '<p class="sai-error-text">The response was cut short because it hit the model’s length limit.</p>';
	}

	/** @param {ApiResponse} response */
	function handleApiResponse(response) {
		const { rawSummary, finishReason } = extractSummaryFromResponse(response);
		const cleanedSummary =
			cleanSummaryHTML(rawSummary) + truncationNotice(finishReason, response.service);
		state.summaryCache.set(state.activeModel, {
			articleData: state.articleData,
			images: state.articleImages,
			summary: {
				title: state.articleData?.title || "Untitled",
				content: cleanedSummary,
				timestamp: new Date().toISOString(),
			},
		});
		Overlay.update(cleanedSummary, { images: state.articleImages });
	}

	/** @param {Service} service */
	async function handleApiKeyReset(service) {
		const newApiKey = await ModalService.prompt(
			`Enter your ${toTitleCase(service)} API key:`,
			"",
			"Leave blank to clear existing key",
		);

		if (newApiKey !== null) {
			const trimmedApiKey = newApiKey.trim();
			await StorageService.saveApiKey(service, newApiKey);
			const message = trimmedApiKey
				? `${toTitleCase(service)} API key updated successfully.`
				: `${toTitleCase(service)} API key has been cleared.`;
			await ModalService.alert(message);
		}
	}

	// --- Q&A Functionality ---
	/** @param {string} text */
	function formatQAAnswer(text) {
		// Escape HTML first
		let formatted = escapeHtml(text);

		// Use consolidated regex patterns
		const { formatQA } = REGEX_PATTERNS;

		formatted = formatted.replace(formatQA.brackets, "<p><strong>$1</strong></p>");

		// Add line break BEFORE any bold label ending with colon (like "**Actionable Insights:**")
		// This ensures all section headers appear on their own line
		// Look for sentence ending (. ! ?) or word character followed by space(s) and **Text:**
		formatted = formatted.replace(/([.!?a-z])\s+(\*\*[A-Z][^*]+:\*\*)/g, "$1\n$2");

		// Convert **bold** to <strong>
		formatted = formatted.replace(formatQA.bold, "<strong>$1</strong>");

		// Remove excessive blank lines (more than 2 consecutive newlines)
		formatted = formatted.replace(/\n{3,}/g, "\n\n");

		// Split into lines for processing
		const lines = formatted.split("\n");
		const htmlLines = [];
		let inList = false;
		let lastWasSectionHeader = false;

		for (const line of lines) {
			const trimmedLine = line.trim();

			if (!trimmedLine) {
				// Skip empty lines after section headers to prevent extra spacing
				if (lastWasSectionHeader) {
					continue;
				}
				// Close list if we were in one
				if (inList) {
					htmlLines.push("</ul>");
					inList = false;
				}
				continue;
			}

			// Check if this is a numbered list item
			if (formatQA.numberedList.test(trimmedLine)) {
				if (!inList) {
					htmlLines.push("<ul>");
					inList = true;
				}
				// Remove the number and add as list item
				const content = trimmedLine.replace(formatQA.numberedListRemove, "");
				htmlLines.push(`<li>${content}</li>`);
				lastWasSectionHeader = false;
			}
			// Check if line is a section header (contains colon before closing tags)
			// Matches: <strong>Text:</strong>, <p><strong>Text:</strong></p>, or <strong>Text:</strong></p>
			else if (
				trimmedLine.includes(":") &&
				trimmedLine.match(/^(<p>)?<strong>[^<]+:<\/strong>(<\/p>)?$/)
			) {
				if (inList) {
					htmlLines.push("</ul>");
					inList = false;
				}
				// Wrap standalone <strong> headers in paragraph tags
				if (!trimmedLine.startsWith("<p>")) {
					htmlLines.push(`<p>${trimmedLine}</p>`);
				} else {
					htmlLines.push(trimmedLine);
				}
				lastWasSectionHeader = true;
			}
			// Check if line already has HTML tags (but not section headers)
			else if (trimmedLine.startsWith("<p>") || trimmedLine.startsWith("<strong>")) {
				if (inList) {
					htmlLines.push("</ul>");
					inList = false;
				}
				htmlLines.push(trimmedLine);
				lastWasSectionHeader = false;
			}
			// Regular paragraph
			else {
				if (inList) {
					htmlLines.push("</ul>");
					inList = false;
				}
				htmlLines.push(`<p>${trimmedLine}</p>`);
				lastWasSectionHeader = false;
			}
		}

		// Close any open list
		if (inList) {
			htmlLines.push("</ul>");
		}

		return htmlLines.join("\n");
	}

	/** @param {string} question @param {AnswerBox} answerBox */
	async function handleAskQuestion(question, answerBox) {
		if (!question) {
			showErrorNotification("Please enter a question.");
			return;
		}

		if (!state.articleData) {
			showErrorNotification("No article content available.");
			return;
		}

		answerBox.setBusy(true);

		try {
			const validationResult = await validateModelAndApiKey();
			if (!validationResult) {
				throw new Error("Model or API key validation failed");
			}

			const { modelConfig, apiKey, service } = validationResult;

			const prompt = `Answer the following question about this article. Use the article as your primary source; supplement with broader knowledge where relevant, noting it briefly.

<article>
<title>${state.articleData.title}</title>
<content>${state.articleData.content}</content>
</article>

Question: ${question}

Keep your answer under 150 words. Write in clear paragraphs. No section headers.`;

			let answer;
			let finishReason;
			try {
				const response = await sendApiRequest(service, apiKey, prompt, modelConfig, 800);
				({ rawSummary: answer, finishReason } = extractSummaryFromResponse(response));
			} catch (/** @type {any} */ err) {
				throw annotateModelError(err, modelConfig.id);
			}

			// Format the answer with proper HTML structure
			const formattedAnswer = formatQAAnswer(answer) + truncationNotice(finishReason, service);

			answerBox.showAnswer(`
        <div class="sai-answer">
          <p><strong>Q:</strong> ${escapeHtml(question)}</p>
          <div class="sai-answer-content">${formattedAnswer}</div>
        </div>
      `);
			answerBox.clearQuestion();
		} catch (/** @type {any} */ error) {
			console.error("Ask question failed:", error);
			answerBox.showAnswer(`<p class="sai-error-text">Error: ${escapeHtml(error.message)}</p>`);
		} finally {
			answerBox.setBusy(false);
		}
	}

	/** @type {Record<string, string>} */
	const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

	/**
	 * Text made safe to place in HTML, as element content or a quoted attribute value.
	 * @param {string} text
	 */
	function escapeHtml(text) {
		return text.replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
	}

	// --- Image Lightbox ---
	// Owns its overlay, zoom/pan state and listeners; the rest of the script only calls
	// Lightbox.open(images, index) and asks Lightbox.isOpen().
	const Lightbox = (() => {
		/** @type {{ overlay: HTMLElement | null, elements: LightboxElements | null, cleanup: (() => void) | null }} */
		const lb = { overlay: null, elements: null, cleanup: null };
		/** @type {ImageItem[]} */
		let images = [];

		let currentImageIndex = 0;
		let lightboxZoom = { scale: 1, x: 0, y: 0 };

		/** @param {number} scale */
		function clampZoomScale(scale) {
			return Math.min(Math.max(scale, 1), 4);
		}

		function applyLightboxZoomTransform() {
			const img = lb.elements?.img;
			if (!img) return;
			img.style.transform = `translate(${lightboxZoom.x}px, ${lightboxZoom.y}px) scale(${lightboxZoom.scale})`;
			img.style.cursor = lightboxZoom.scale > 1 ? "grab" : "zoom-in";
		}

		function resetLightboxZoom() {
			lightboxZoom = { scale: 1, x: 0, y: 0 };
			applyLightboxZoomTransform();
		}

		function toggleLightboxZoom() {
			if (lightboxZoom.scale > 1) {
				resetLightboxZoom();
			} else {
				lightboxZoom = { scale: 2.5, x: 0, y: 0 };
				applyLightboxZoomTransform();
			}
		}

		/** @param {ImageItem[]} items @param {number} index */
		function openLightbox(items, index) {
			if (!items.length) return;

			images = items;
			currentImageIndex = index;

			if (!lb.overlay) {
				createLightbox();
			}

			updateLightboxImage();
			if (lb.overlay) lb.overlay.style.display = "flex";
			document.body.style.overflow = "hidden";
		}

		function closeLightbox() {
			if (lb.overlay) {
				document.body.style.overflow = "";

				// Cleanup event listeners to prevent memory leaks
				if (lb.cleanup) {
					lb.cleanup();
					lb.cleanup = null;
				}

				// Remove the lightbox entirely so the next openLightbox() rebuilds it via
				// createLightbox(), re-attaching the wheel/drag/pinch/touch listeners that
				// lb.cleanup() just tore down (a stale-but-visible node would skip
				// createLightbox() and leave those listeners missing on the next open).
				lb.overlay.remove();
				lb.overlay = null;
				lb.elements = null;
			}
		}

		function createLightbox() {
			const lightbox = createElement("div", {
				className: "sai-scope sai-lightbox-overlay",
			});
			lb.overlay = lightbox;

			// Create content container
			const lightboxContent = createElement("div", {
				className: "sai-lightbox-content",
			});

			const img = createElement("img", {
				className: "sai-lightbox-image",
				alt: "Full size image",
				title: "Scroll or pinch to zoom, drag to pan, double-click/tap to reset",
			});

			const iframe = createElement("iframe", {
				className: "sai-lightbox-iframe",
				frameborder: "0",
				scrolling: "no",
				style: "display: none;",
			});

			lightboxContent.appendChild(img);
			lightboxContent.appendChild(iframe);

			// Create thumbnail strip
			const thumbnailStrip = createElement("div", {
				className: "sai-lightbox-thumbnails",
			});

			// Create menu bar at bottom (similar to summary overlay)
			const menuBar = createElement("div", {
				className: "sai-lightbox-menubar",
			});

			const prevBtn = createElement("button", {
				className: "sai-menubar-button sai-lightbox-prev",
				textContent: "← Prev",
				onclick: () => navigateLightbox(-1),
			});

			const counter = createElement("div", {
				className: "sai-lightbox-counter",
			});

			const nextBtn = createElement("button", {
				className: "sai-menubar-button sai-lightbox-next",
				textContent: "Next →",
				onclick: () => navigateLightbox(1),
			});

			const closeBtn = createElement("button", {
				className: "sai-menubar-button",
				textContent: "Close",
				title: "Close (Esc)",
				onclick: closeLightbox,
			});

			menuBar.appendChild(prevBtn);
			menuBar.appendChild(counter);
			menuBar.appendChild(nextBtn);
			menuBar.appendChild(closeBtn);

			lightbox.appendChild(lightboxContent);
			lightbox.appendChild(thumbnailStrip);
			lightbox.appendChild(menuBar);
			document.body.appendChild(lightbox);

			// Cache lightbox elements to avoid repeated DOM queries
			lb.elements = {
				img,
				iframe,
				counter,
				prevBtn,
				nextBtn,
				thumbnailStrip,
			};

			// Initialize thumbnails
			renderThumbnails();

			// Close on overlay click
			/** @param {MouseEvent} e */
			const overlayClickHandler = e => {
				if (e.target === lightbox) {
					closeLightbox();
				}
			};
			lightbox.addEventListener("click", overlayClickHandler);

			// Keyboard navigation
			document.addEventListener("keydown", handleLightboxKeyboard);

			// Touch/swipe/pan/pinch-zoom support
			let touchStartX = 0;
			let touchStartY = 0;
			let touchEndX = 0;
			let pinchStartDistance = 0;
			let pinchStartScale = 1;
			let panOrigin = { x: 0, y: 0 };
			let panStart = { x: 0, y: 0 };
			let isPanning = false;
			let isPinching = false;
			let lastTapTime = 0;

			/** @param {TouchList} touches */
			const getTouchDistance = touches =>
				Math.hypot(
					touches[0].clientX - touches[1].clientX,
					touches[0].clientY - touches[1].clientY,
				);

			/** @param {TouchEvent} e */
			const touchStartHandler = e => {
				if (e.touches.length === 2) {
					isPinching = true;
					pinchStartDistance = getTouchDistance(e.touches);
					pinchStartScale = lightboxZoom.scale;
				} else if (e.touches.length === 1) {
					touchStartX = e.touches[0].screenX;
					touchStartY = e.touches[0].screenY;
					if (lightboxZoom.scale > 1) {
						isPanning = true;
						panOrigin = { x: e.touches[0].clientX, y: e.touches[0].clientY };
						panStart = { x: lightboxZoom.x, y: lightboxZoom.y };
					}
				}
			};

			/** @param {TouchEvent} e */
			const touchMoveHandler = e => {
				if (isPinching && e.touches.length === 2) {
					e.preventDefault();
					const distance = getTouchDistance(e.touches);
					lightboxZoom.scale = clampZoomScale(pinchStartScale * (distance / pinchStartDistance));
					applyLightboxZoomTransform();
				} else if (isPanning && e.touches.length === 1) {
					e.preventDefault();
					lightboxZoom.x = panStart.x + (e.touches[0].clientX - panOrigin.x);
					lightboxZoom.y = panStart.y + (e.touches[0].clientY - panOrigin.y);
					applyLightboxZoomTransform();
				}
			};

			/** @param {TouchEvent} e */
			const touchEndHandler = e => {
				if (e.touches.length > 0) return;

				const wasPinch = isPinching;
				const wasPan = isPanning;
				isPinching = false;
				isPanning = false;
				if (wasPinch) return;

				const touch = e.changedTouches[0];
				touchEndX = touch.screenX;
				const movedDistance = Math.hypot(touch.screenX - touchStartX, touch.screenY - touchStartY);

				// A one-finger touch while zoomed in starts a pan, but one that barely moved is
				// still a tap — otherwise double-tap could never reset the zoom.
				if (movedDistance < 10) {
					// Tap - check for double-tap to toggle zoom
					const now = Date.now();
					if (now - lastTapTime < 300) {
						toggleLightboxZoom();
						lastTapTime = 0;
					} else {
						lastTapTime = now;
					}
				} else if (!wasPan && lightboxZoom.scale <= 1) {
					handleSwipe();
				}
			};

			lightboxContent.addEventListener("touchstart", touchStartHandler, { passive: true });
			lightboxContent.addEventListener("touchmove", touchMoveHandler, { passive: false });
			lightboxContent.addEventListener("touchend", touchEndHandler, { passive: true });

			function handleSwipe() {
				const swipeThreshold = 50;
				if (touchEndX < touchStartX - swipeThreshold) {
					navigateLightbox(1); // Swipe left - next image
				} else if (touchEndX > touchStartX + swipeThreshold) {
					navigateLightbox(-1); // Swipe right - previous image
				}
			}

			// Desktop zoom: wheel to zoom, drag to pan, double-click to toggle
			/** @param {WheelEvent} e */
			const wheelHandler = e => {
				e.preventDefault();
				const delta = e.deltaY < 0 ? 0.25 : -0.25;
				lightboxZoom.scale = clampZoomScale(lightboxZoom.scale + delta);
				if (lightboxZoom.scale === 1) {
					lightboxZoom.x = 0;
					lightboxZoom.y = 0;
				}
				applyLightboxZoomTransform();
			};

			const dblClickHandler = () => toggleLightboxZoom();

			let isDragging = false;
			let dragStart = { x: 0, y: 0 };
			let dragPanStart = { x: 0, y: 0 };

			/** @param {MouseEvent} e */
			const mouseDownHandler = e => {
				if (lightboxZoom.scale <= 1) return;
				isDragging = true;
				dragStart = { x: e.clientX, y: e.clientY };
				dragPanStart = { x: lightboxZoom.x, y: lightboxZoom.y };
				img.style.cursor = "grabbing";
				e.preventDefault();
			};
			/** @param {MouseEvent} e */
			const mouseMoveHandler = e => {
				if (!isDragging) return;
				lightboxZoom.x = dragPanStart.x + (e.clientX - dragStart.x);
				lightboxZoom.y = dragPanStart.y + (e.clientY - dragStart.y);
				applyLightboxZoomTransform();
			};
			const mouseUpHandler = () => {
				isDragging = false;
				applyLightboxZoomTransform();
			};

			img.addEventListener("wheel", wheelHandler, { passive: false });
			img.addEventListener("dblclick", dblClickHandler);
			img.addEventListener("mousedown", mouseDownHandler);
			window.addEventListener("mousemove", mouseMoveHandler);
			window.addEventListener("mouseup", mouseUpHandler);

			// Store cleanup function to remove all event listeners
			lb.cleanup = () => {
				document.removeEventListener("keydown", handleLightboxKeyboard);
				lightbox.removeEventListener("click", overlayClickHandler);
				lightboxContent.removeEventListener("touchstart", touchStartHandler);
				lightboxContent.removeEventListener("touchmove", touchMoveHandler);
				lightboxContent.removeEventListener("touchend", touchEndHandler);
				img.removeEventListener("wheel", wheelHandler);
				img.removeEventListener("dblclick", dblClickHandler);
				img.removeEventListener("mousedown", mouseDownHandler);
				window.removeEventListener("mousemove", mouseMoveHandler);
				window.removeEventListener("mouseup", mouseUpHandler);
			};
		}

		function updateLightboxImage() {
			if (!lb.overlay || !lb.elements || !images.length) return;

			resetLightboxZoom();

			const { img, iframe, counter, prevBtn, nextBtn, thumbnailStrip } = lb.elements;
			const currentItem = images[currentImageIndex];
			counter.textContent = `${currentImageIndex + 1} / ${images.length}`;

			// Show image or iframe based on type
			if (currentItem.type === "iframe") {
				img.style.display = "none";
				iframe.style.display = "block";
				iframe.src = currentItem.src;
				iframe.title = currentItem.alt || "Interactive visualization";
			} else {
				iframe.style.display = "none";
				img.style.display = "block";
				img.src = currentItem.src;
				img.alt = currentItem.alt || "Article image";
			}

			// Disable/enable buttons at boundaries
			prevBtn.disabled = currentImageIndex === 0;
			nextBtn.disabled = currentImageIndex === images.length - 1;

			// Update active thumbnail highlight
			const thumbnails = thumbnailStrip.querySelectorAll(".sai-lightbox-thumbnail-item");
			thumbnails.forEach((thumb, idx) => {
				if (idx === currentImageIndex) {
					thumb.classList.add("sai-active");
				} else {
					thumb.classList.remove("sai-active");
				}
			});

			// Scroll active thumbnail into view
			const activeThumb = thumbnails[currentImageIndex];
			if (activeThumb) {
				activeThumb.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
			}
		}

		/** @param {number} direction */
		function navigateLightbox(direction) {
			const newIndex = currentImageIndex + direction;
			if (newIndex >= 0 && newIndex < images.length) {
				currentImageIndex = newIndex;
				updateLightboxImage();
			}
		}

		function renderThumbnails() {
			if (!lb.elements?.thumbnailStrip) return;

			const { thumbnailStrip } = lb.elements;
			thumbnailStrip.innerHTML = "";

			images.forEach((item, index) => {
				const thumbItem = createElement("button", {
					type: "button",
					className: "sai-lightbox-thumbnail-item",
				});

				const isIframe = item.type === "iframe";

				// Create thumbnail image or iframe indicator
				let thumbContent;
				if (isIframe) {
					thumbContent = createElement("span", {
						className: "sai-lightbox-thumbnail-iframe-indicator",
						textContent: "🖼️",
						title: "Interactive content",
					});
				} else {
					thumbContent = createElement("img", {
						className: "sai-lightbox-thumbnail-img",
						src: item.src,
						alt: item.alt || `Image ${index + 1}`,
					});
				}

				thumbItem.addEventListener("click", () => {
					currentImageIndex = index;
					updateLightboxImage();
				});

				thumbItem.appendChild(thumbContent);
				thumbnailStrip.appendChild(thumbItem);
			});
		}

		/** @param {KeyboardEvent} e */
		function handleLightboxKeyboard(e) {
			if (!lb.overlay || lb.overlay.style.display === "none") return;

			switch (e.key) {
				case "Escape":
					e.preventDefault();
					closeLightbox();
					break;
				case "ArrowLeft":
					e.preventDefault();
					navigateLightbox(-1);
					break;
				case "ArrowRight":
					e.preventDefault();
					navigateLightbox(1);
					break;
			}
		}

		return { open: openLightbox, isOpen: () => lb.overlay !== null };
	})();

	// --- Keyboard Shortcuts ---
	/** @param {KeyboardEvent} e */
	function handleKeyPress(e) {
		if (e.altKey && e.code === "KeyS" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
			e.preventDefault();
			if (!document.activeElement?.closest(CONFIG.selectors.input)) {
				processSummarization();
			}
		}
		// The lightbox handles its own Escape; it sits above the overlay it opened from,
		// so one press must close only the lightbox.
		if (e.key === "Escape" && !Lightbox.isOpen()) {
			if (Overlay.isOpen()) {
				e.preventDefault();
				Overlay.close();
			} else if (ModelMenu.isDropdownOpen()) {
				e.preventDefault();
				ModelMenu.hideDropdown();
			}
		}
	}

	function injectStyles() {
		const fontFamily = CONFIG.styles.fontFamily;

		GM.addStyle(`
      /* =================================================================
         DESIGN SYSTEM TOKENS - Dieter Rams Principles
         Less but better: Unified spacing, colors, typography, transitions
         ================================================================= */
      .sai-scope {
        /* Reset inheritable text properties so host-page styles (font, color,
           line-height, etc. cascade via inheritance, not selector specificity)
           can't bleed into the injected UI. Not "all: initial" - that would also
           reset non-inherited layout properties (display, position, margin) that
           this file's own more-specific rules for each container rely on. */
        font-family: ${fontFamily};
        font-size: var(--font-size-base);
        font-weight: 400;
        font-style: normal;
        line-height: 1.6;
        text-align: left;
        text-transform: none;
        letter-spacing: normal;
        color: var(--color-text-primary);

        /* Color Palette */
        --color-text-primary: #1a1a1a;
        --color-text-secondary: #666;
        --color-text-tertiary: #6e6e6e;
        --color-border: #e0e0e0;
        --color-border-light: #f0f0f0;
        --color-bg-primary: #ffffff;
        --color-bg-hover: #f5f5f5;
        --color-error: #d32f2f;
        --color-accent: #1565c0;
        /* Loading-text glow cycle; each stop keeps 4.5:1 on --color-bg-primary */
        --glow-1: #1565c0;
        --glow-2: #7b1fa2;
        --glow-3: #c62828;
        /* Floating S button: same in both modes (white on blue, 4.5:1+) */
        --fab-bg: #1a73e8;
        --fab-bg-hover: #1976d2;
        --fab-text: #ffffff;
        /* Exhibit charts are drawn for a white canvas in either mode */
        --chart-canvas-bg: #ffffff;

        /* Component-specific colors */
        --button-bg: #1a1a1a;
        --button-bg-hover: #2a2a2a;
        --button-text: #ffffff;
        --input-focus-border: #d0d0d0;
        --overlay-bg: rgba(0, 0, 0, 0.4);
        --sai-modal-button-text: #666;
        --sai-answer-border: #1a1a1a;
        --group-header-bg: #fafafa;
        --menubar-bg: rgba(255, 255, 255, 0.98);
        --section-bg: #f8f8f8;
        --reset-link-color: #666;
        --reset-link-hover: #1a1a1a;

        /* Spacing Scale (based on 4px grid) */
        --space-xs: 8px;
        --space-sm: 16px;
        --space-md: 24px;
        --space-lg: 32px;
        --space-xl: 40px;

        /* Typography Scale */
        --font-size-sm: 14px;
        --font-size-base: 16px;
        --font-size-icon: 24px;
        --font-size-icon-lg: 32px;
        --font-weight-normal: 400;
        --font-weight-semibold: 600;
        --line-height-normal: 1.6;

        /* Border Radius */
        --radius-sm: 4px;
        --radius-md: 8px;

        /* Shadows (unified elevation system) */
        --shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.08);
        --shadow-md: 0 4px 16px rgba(0, 0, 0, 0.12);
        --shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.12);
        --shadow-button: 0 2px 8px rgba(0, 0, 0, 0.15), 0 1px 2px rgba(0, 0, 0, 0.1);
        --shadow-button-hover: 0 4px 12px rgba(0, 0, 0, 0.2), 0 2px 4px rgba(0, 0, 0, 0.15);

        /* Transitions (consistent timing) */
        --transition-fast: 0.15s cubic-bezier(0.4, 0, 0.2, 1);
        --transition-base: 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        --easing-standard: cubic-bezier(0.4, 0, 0.2, 1);

        /* Z-Index Scale */
        --z-dropdown: 2147483641;
        --z-button: 2147483640;
        --z-overlay: 2147483645;
        --z-error: 2147483646;
        --z-lightbox: 2147483647;
        --z-modal: 2147483648;
      }

      /* Dark Mode Overrides */
      @media (prefers-color-scheme: dark) {
        .sai-scope {
          --color-text-primary: #e8e8e8;
          --color-text-secondary: #999;
          --color-text-tertiary: #949494;
          --color-error: #f28b82;
          --color-accent: #8ab4f8;
          --glow-1: #8ab4f8;
          --glow-2: #ce93d8;
          --glow-3: #f28b82;
          --color-border: #333;
          --color-border-light: #2a2a2a;
          --color-bg-primary: #1a1a1a;
          --color-bg-hover: #2a2a2a;
          --button-bg: #e8e8e8;
          --button-bg-hover: #ffffff;
          --button-text: #1a1a1a;
          --input-focus-border: #444;
          --overlay-bg: rgba(0, 0, 0, 0.6);
          --sai-modal-button-text: #999;
          --sai-answer-border: #666;
          --group-header-bg: #242424;
          --menubar-bg: rgba(26, 26, 26, 0.98);
          --section-bg: #1a1a1a;
          --shadow-lg: 0 8px 32px rgba(0, 0, 0, 0.4);
          --shadow-button: 0 2px 8px rgba(0, 0, 0, 0.3);
          --shadow-button-hover: 0 4px 12px rgba(0, 0, 0, 0.4);
          --reset-link-color: #999;
          --reset-link-hover: #e8e8e8;
        }
      }

      /* =================================================================
         MOBILE TOUCH HANDLING
         ================================================================= */
      @media (max-width: 600px) {
        /* "manipulation" still allows panning and pinch-zoom; it only drops
           double-tap zoom, which would otherwise swallow quick taps. */
        #${CONFIG.ids.overlay},
        #${CONFIG.ids.content},
        .sai-modal-overlay,
        .sai-modal-content,
        .sai-summary-content-body,
        .sai-question-section,
        .sai-image-gallery,
        .sai-lightbox-overlay,
        .sai-lightbox-content {
          touch-action: manipulation;
          user-select: none;
          -webkit-user-select: none;
        }

        /* Allow text selection only in specific content areas */
        #${CONFIG.ids.content} p,
        #${CONFIG.ids.content} ul,
        #${CONFIG.ids.content} ol,
        #${CONFIG.ids.content} li,
        .sai-answer-content {
          user-select: text;
          -webkit-user-select: text;
        }

        /* Ensure buttons and interactive elements remain functional */
        .sai-scope button,
        #${CONFIG.ids.button} {
          touch-action: manipulation;
          user-select: none;
          -webkit-user-select: none;
        }

        /* Allow input fields to be interactive */
        .sai-question-input,
        .sai-modal-input {
          touch-action: manipulation;
          user-select: text;
          -webkit-user-select: text;
        }
      }

      /* =================================================================
         CUSTOM MODAL SYSTEM - Dieter Rams Design Principles
         ================================================================= */
      .sai-modal-overlay {
        position: fixed;
        top: 0; left: 0;
        width: 100%; height: 100%;
        background: rgba(0, 0, 0, 0);
        z-index: var(--z-modal);
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background var(--transition-base);
        opacity: 0;
      }

      .sai-modal-overlay.sai-modal-active {
        background: var(--overlay-bg);
        opacity: 1;
      }

      .sai-modal-content {
        background: var(--color-bg-primary);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        max-width: 420px;
        width: 90%;
        padding: 0;
        font-family: ${fontFamily};
        transform: scale(0.9) translateY(20px);
        transition: transform var(--transition-base);
        overflow: hidden;
      }

      .sai-modal-active .sai-modal-content {
        transform: scale(1) translateY(0);
      }

      .sai-modal-message {
        padding: var(--space-lg) var(--space-lg) var(--space-md) var(--space-lg);
        font-size: var(--font-size-base);
        line-height: var(--line-height-normal);
        color: var(--color-text-primary);
        text-align: left;
      }

      .sai-modal-input {
        width: 100%;
        padding: 12px var(--space-sm);
        margin: 0 var(--space-lg) var(--space-md) var(--space-lg);
        width: calc(100% - var(--space-lg) * 2);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        font-family: ${fontFamily};
        font-size: var(--font-size-base);
        color: var(--color-text-primary);
        background: var(--color-bg-hover);
        box-sizing: border-box;
        transition: all var(--transition-fast);
        outline: none;
      }

      .sai-modal-input:focus {
        border-color: var(--input-focus-border);
        background: var(--color-bg-primary);
        box-shadow: none;
        outline: 2px solid var(--color-accent);
        outline-offset: -1px;
      }

      .sai-modal-input::placeholder {
        color: var(--color-text-tertiary);
      }

      .sai-modal-actions {
        display: flex;
        gap: 0;
        border-top: 1px solid var(--color-border-light);
      }

      .sai-modal-button {
        flex: 1;
        padding: var(--space-sm);
        border: none;
        background: transparent;
        font-family: ${fontFamily};
        font-size: var(--font-size-base);
        font-weight: var(--font-weight-normal);
        cursor: pointer;
        transition: background var(--transition-fast);
        color: var(--sai-modal-button-text);
        user-select: none;
        -webkit-user-select: none;
        -webkit-tap-highlight-color: transparent;
      }

      .sai-modal-button:hover {
        background: var(--color-bg-hover);
      }

      .sai-modal-button:active {
        background: transparent;
      }

      /* Every button the script adds shows where keyboard focus is. */
      .sai-scope button:focus-visible {
        outline: 2px solid var(--color-accent);
        outline-offset: 2px;
      }
      #${CONFIG.ids.button}:focus-visible {
        outline: 2px solid var(--fab-bg);
        outline-offset: 3px;
      }
      /* Inset: the modal clips anything drawn outside its buttons. */
      .sai-scope .sai-modal-button:focus {
        outline: 2px solid var(--color-accent);
        outline-offset: -2px;
      }

      .sai-modal-button-secondary {
        border-right: 1px solid var(--color-border-light);
      }

      .sai-modal-button:only-child {
        border-right: none;
      }

      /* =================================================================
         MAIN UI COMPONENTS
         ================================================================= */
      #${CONFIG.ids.button} {
        position: fixed; bottom: 24px; right: 24px;
        width: 56px; height: 56px;
        background: var(--fab-bg);
        color: var(--fab-text);
        padding: 0;
        font-size: var(--font-size-base); font-weight: var(--font-weight-normal);
        font-family: ${fontFamily};
        border-radius: 50%; cursor: pointer; z-index: var(--z-button);
        box-shadow: var(--shadow-button);
        display: flex; align-items: center; justify-content: center;
        transition: all var(--transition-fast);
        line-height: 1;
        user-select: none;
        -webkit-user-select: none;
        -webkit-tap-highlight-color: transparent;
        border: none;
      }
      #${CONFIG.ids.button}:hover {
        background: var(--fab-bg-hover);
        box-shadow: var(--shadow-button-hover);
        transform: translateY(-1px);
      }
      #${CONFIG.ids.dropdown} {
        position: fixed; bottom: 80px; right: 20px;
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        z-index: var(--z-dropdown);
        max-height: 70vh; overflow-y: auto;
        padding: var(--space-xs); width: 300px;
        font-family: ${fontFamily};
        display: none;
        animation: fadeIn var(--transition-base) ease-out;
      }
      #${CONFIG.ids.overlay} {
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background-color: var(--overlay-bg);
        z-index: var(--z-overlay);
        display: flex; align-items: center; justify-content: center;
        overflow: hidden;
        font-family: ${fontFamily};
        animation: fadeIn 0.3s ease-out;
      }
      #${CONFIG.ids.content} {
        background-color: var(--color-bg-primary);
        color: var(--color-text-primary);
        padding: 0;
        box-shadow: var(--shadow-lg);
        max-width: 680px; width: 90%; max-height: 90vh; min-height: 90vh;
        overflow-y: auto;
        overflow-x: clip;
        position: relative;
        font-size: var(--font-size-base);
        line-height: var(--line-height-normal);
        animation: slideInUp 0.3s ease-out;
        white-space: normal;
        box-sizing: border-box;
        border-radius: var(--radius-md);
        display: flex;
        flex-direction: column;
      }
      #${CONFIG.ids.content}::-webkit-scrollbar {
        width: 10px;
      }
      #${CONFIG.ids.content}::-webkit-scrollbar-track {
        background: transparent;
      }
      #${CONFIG.ids.content}::-webkit-scrollbar-thumb {
        background: var(--color-border);
        border-radius: var(--radius-sm);
        border: 2px solid var(--color-bg-primary);
      }
      #${CONFIG.ids.content} {
        scrollbar-width: thin;
        scrollbar-color: var(--color-border) transparent;
      }
      .sai-summary-menubar {
        display: flex; justify-content: flex-end; gap: 12px;
        position: sticky; bottom: 0;
        background: var(--menubar-bg);
        padding: 12px 24px;
        border-top: 1px solid var(--color-border-light);
        z-index: 10;
        backdrop-filter: blur(10px);
      }
      .sai-menubar-button {
        background: transparent;
        border: 1px solid var(--color-border);
        font-family: ${fontFamily};
        font-size: var(--font-size-base);
        font-weight: var(--font-weight-normal);
        color: var(--color-text-secondary);
        cursor: pointer;
        padding: 6px 12px;
        border-radius: var(--radius-sm);
        transition: all var(--transition-fast);
        white-space: nowrap;
        user-select: none;
        -webkit-user-select: none;
        -webkit-tap-highlight-color: transparent;
      }
      .sai-menubar-button:hover {
        background: var(--color-bg-hover);
        border-color: var(--color-border);
        color: var(--color-text-primary);
      }
      .sai-summary-content-body {
        padding: var(--space-lg) var(--space-xl);
        flex: 1;
        display: flex;
        flex-direction: column;
        justify-content: center;
      }

      /* When content is loaded, remove centering */
      .sai-summary-content-body:has(ul),
      .sai-summary-content-body:has(p:not(.sai-glow)) {
        justify-content: flex-start;
      }
      #${CONFIG.ids.content},
      #${CONFIG.ids.content} p,
      #${CONFIG.ids.content} li,
      #${CONFIG.ids.content} strong,
      #${CONFIG.ids.content} button,
      #${CONFIG.ids.content} input {
        font-family: ${fontFamily} !important;
        font-weight: var(--font-weight-normal) !important;
      }
      #${CONFIG.ids.content} p {
        margin-top: 0;
        margin-bottom: 1.2em;
        color: inherit;
        max-width: 65ch;
        font-size: var(--font-size-base) !important;
        line-height: 1.5 !important;
      }
      #${CONFIG.ids.content} ul {
        margin: 0 0 1.2em 0;
        padding-left: 1.5em;
        color: inherit;
        font-size: var(--font-size-base) !important;
      }
      #${CONFIG.ids.content} li {
        list-style-type: disc;
        margin-bottom: 0.6em;
        color: inherit;
        font-size: var(--font-size-base) !important;
        line-height: 1.5 !important;
      }
      #${CONFIG.ids.content} strong {
        font-weight: var(--font-weight-semibold) !important;
        color: var(--color-text-primary);
        font-size: 1em !important;
        letter-spacing: -0.005em;
      }
      #${CONFIG.ids.content} span:not([class*="article-"]) {
        color: inherit;
      }
      /* Error Notification - Dieter Rams Style */
      .sai-error-notification {
        position: fixed;
        bottom: 80px;
        left: 50%;
        transform: translateX(-50%) translateY(20px);
        background: var(--color-bg-primary);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        box-shadow: var(--shadow-lg);
        z-index: var(--z-error);
        font-family: ${fontFamily};
        display: flex;
        align-items: flex-start;
        gap: 12px;
        padding: var(--space-sm) 20px;
        min-width: 320px;
        max-width: 480px;
        opacity: 0;
        transition: all var(--transition-base);
      }

      .sai-error-notification.sai-error-active {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }

      .sai-error-message {
        flex: 1;
        font-size: var(--font-size-base);
        line-height: 1.5;
        color: var(--color-text-primary);
        margin: 0;
      }

      .sai-error-close {
        background: transparent;
        border: none;
        color: var(--color-text-secondary);
        font-size: var(--font-size-icon);
        line-height: 1;
        cursor: pointer;
        padding: 0;
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: var(--radius-sm);
        transition: all var(--transition-fast);
        flex-shrink: 0;
        font-family: ${fontFamily};
      }

      .sai-error-close:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      .sai-retry-button {
        display: block;
        margin: var(--space-md) auto 0;
        padding: 12px var(--space-md);
        background-color: var(--button-bg);
        color: var(--button-text);
        border: none;
        border-radius: var(--radius-sm);
        cursor: pointer;
        font-size: var(--font-size-base);
        font-weight: var(--font-weight-normal);
        font-family: ${fontFamily};
        transition: all var(--transition-fast);
        letter-spacing: 0.02em;
      }
      .sai-retry-button:hover {
        background-color: var(--button-bg-hover);
        box-shadow: var(--shadow-sm);
        transform: translateY(-1px);
      }

      /* =================================================================
         Q&A SECTION
         ================================================================= */
      .sai-question-section {
        border-top: 1px solid var(--color-border-light);
        padding: var(--space-md) var(--space-xl);
        margin-top: 0;
        background: var(--section-bg);
      }
      .sai-question-header {
        display: block;
        font-weight: var(--font-weight-normal);
        color: var(--color-text-primary);
        margin-bottom: 12px;
        font-size: var(--font-size-base);
      }
      .sai-question-input-wrapper {
        display: flex;
        gap: 10px;
        margin-bottom: var(--space-sm);
      }
      .sai-question-input {
        flex: 1;
        padding: 10px 14px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        font-family: ${fontFamily};
        font-size: var(--font-size-base);
        transition: border-color var(--transition-fast);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        outline: none;
      }
      .sai-question-input:focus {
        outline: 2px solid var(--color-accent);
        outline-offset: -1px;
        border-color: var(--input-focus-border);
        box-shadow: none;
      }
      .sai-question-input:disabled {
        background: var(--color-bg-hover);
        color: var(--color-text-secondary);
        cursor: not-allowed;
      }
      .sai-ask-button {
        padding: 10px 20px;
        background-color: var(--button-bg);
        color: var(--button-text);
        border: none;
        border-radius: var(--radius-sm);
        cursor: pointer;
        font-family: ${fontFamily};
        font-size: var(--font-size-base);
        font-weight: var(--font-weight-normal);
        transition: all var(--transition-fast);
        white-space: nowrap;
        user-select: none;
        -webkit-user-select: none;
        -webkit-tap-highlight-color: transparent;
      }
      .sai-ask-button:hover:not(:disabled) {
        background-color: var(--button-bg-hover);
      }
      .sai-ask-button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .sai-answer-container {
        min-height: 40px;
      }
      .sai-answer {
        background: var(--color-bg-primary);
        padding: var(--space-sm);
        border-radius: var(--radius-sm);
        border-left: 3px solid var(--sai-answer-border);
        line-height: var(--line-height-normal);
      }
      .sai-answer > p {
        margin-top: 0;
        margin-bottom: 1em;
      }
      .sai-answer > p:first-child {
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
        margin-bottom: 0.75em;
      }
      .sai-answer strong {
        color: var(--color-text-primary);
        font-weight: var(--font-weight-semibold);
      }
      .sai-answer-content {
        margin-top: 0.5em;
      }
      .sai-answer-content p {
        margin-top: 0;
        margin-bottom: 1em;
        line-height: var(--line-height-normal);
      }
      .sai-answer-content ul {
        margin: 0.75em 0;
        padding-left: 1.5em;
      }
      .sai-answer-content li {
        margin-bottom: 0.5em;
        line-height: 1.5;
      }

      /* =================================================================
         IMAGE GALLERY
         ================================================================= */
      .sai-image-gallery {
        padding: var(--space-md) var(--space-xl);
        background: var(--section-bg);
        border-top: 1px solid var(--color-border-light);
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: 12px;
      }
      .sai-gallery-item {
        display: block;
        width: 100%;
        padding: 0;
        border: none;
        color: inherit;
        font: inherit;
        overflow: hidden;
        border-radius: var(--radius-sm);
        background: var(--color-bg-primary);
        box-shadow: var(--shadow-sm);
        cursor: pointer;
        transition: transform var(--transition-fast), box-shadow var(--transition-fast);
      }
      .sai-gallery-item:hover {
        transform: translateY(-2px);
        box-shadow: var(--shadow-md);
      }
      .sai-gallery-item img {
        width: 100%;
        height: 180px;
        object-fit: cover;
        display: block;
      }
      /* Exhibit-chart SVGs are designed for a white canvas — force it regardless of
         dark/light mode so chart text stays legible, and avoid cropping chart labels. */
      .sai-gallery-item img[src*=".svg"] {
        background: var(--chart-canvas-bg);
        object-fit: contain;
      }
      .sai-gallery-item-iframe {
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--color-bg-hover);
        min-height: 200px;
      }
      .sai-iframe-preview {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: var(--space-xs);
        color: var(--color-text-secondary);
      }
      .sai-iframe-preview svg {
        width: 48px;
        height: 48px;
      }
      .sai-iframe-preview span {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-normal);
      }

      /* =================================================================
         LIGHTBOX VIEWER
         ================================================================= */
      .sai-lightbox-overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: var(--color-bg-primary);
        z-index: var(--z-lightbox);
        display: none;
        flex-direction: column;
        animation: fadeIn 0.3s ease-out;
      }
      .sai-lightbox-menubar {
        display: flex;
        justify-content: center;
        align-items: center;
        gap: 12px;
        background: var(--menubar-bg);
        padding: 10px var(--space-md);
        border-top: 1px solid var(--color-border-light);
        z-index: 10;
        backdrop-filter: blur(8px);
        flex-shrink: 0;
      }
      .sai-lightbox-menubar .sai-menubar-button {
        background: transparent;
        border: 1px solid var(--color-border);
        font-family: ${fontFamily};
        font-size: var(--font-size-base);
        font-weight: var(--font-weight-normal);
        color: var(--color-text-secondary);
        cursor: pointer;
        padding: 4px var(--space-xs);
        border-radius: var(--radius-sm);
        transition: all var(--transition-base);
      }
      .sai-lightbox-menubar .sai-menubar-button:hover:not(:disabled) {
        background: var(--color-bg-hover);
        border-color: var(--color-border);
        color: var(--color-text-primary);
      }
      .sai-lightbox-menubar .sai-menubar-button:disabled {
        opacity: 0.3;
        cursor: not-allowed;
      }
      .sai-lightbox-counter {
        color: var(--color-text-secondary);
        padding: 4px 12px;
        font-size: var(--font-size-base);
        font-family: ${fontFamily};
        font-weight: var(--font-weight-normal);
        margin: 0;
      }
      .sai-lightbox-content {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        padding: 20px;
      }
      .sai-lightbox-image {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        user-select: none;
        -webkit-user-select: none;
        touch-action: none;
        cursor: zoom-in;
      }
      .sai-lightbox-image[src*=".svg"] {
        background: var(--chart-canvas-bg);
      }
      .sai-lightbox-iframe {
        width: 90vw;
        max-width: 1200px;
        height: 80vh;
        border: none;
        background: var(--color-bg-primary);
      }

      /* Thumbnail Strip */
      .sai-lightbox-thumbnails {
        display: flex;
        justify-content: center;
        gap: 8px;
        padding: 12px var(--space-md);
        background: var(--section-bg);
        border-top: 1px solid var(--color-border-light);
        overflow-x: auto;
        overflow-y: hidden;
        flex-shrink: 0;
        max-height: 120px;
        scrollbar-width: thin;
        scrollbar-color: var(--color-border) transparent;
      }
      .sai-lightbox-thumbnails::-webkit-scrollbar {
        height: 6px;
      }
      .sai-lightbox-thumbnails::-webkit-scrollbar-track {
        background: transparent;
      }
      .sai-lightbox-thumbnails::-webkit-scrollbar-thumb {
        background: var(--color-border);
        border-radius: 3px;
      }
      .sai-lightbox-thumbnail-item {
        position: relative;
        flex-shrink: 0;
        width: 80px;
        height: 80px;
        padding: 0;
        border: 2px solid transparent;
        border-radius: var(--radius-sm);
        overflow: hidden;
        cursor: pointer;
        transition: all var(--transition-fast);
        background: var(--color-bg-primary);
      }
      .sai-lightbox-thumbnail-item.sai-active {
        border-color: var(--color-text-primary);
        box-shadow: 0 0 0 1px var(--color-text-primary);
      }
      .sai-lightbox-thumbnail-item:hover {
        border-color: var(--color-border);
        transform: scale(1.05);
      }
      .sai-lightbox-thumbnail-img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .sai-lightbox-thumbnail-img[src*=".svg"] {
        background: var(--chart-canvas-bg);
        object-fit: contain;
      }
      .sai-lightbox-thumbnail-iframe-indicator {
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: var(--font-size-icon-lg);
        background: var(--section-bg);
        border: 1px solid var(--color-border);
      }
      /* =================================================================
         DROPDOWN COMPONENTS
         ================================================================= */
      .sai-model-group {
        margin-bottom: 12px;
      }
      .sai-group-header-container {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        background: var(--group-header-bg);
        border-radius: var(--radius-sm);
        margin-bottom: 6px;
        border-left: 2px solid var(--color-border);
      }
      .sai-group-header-text {
        font-weight: var(--font-weight-normal);
        color: var(--color-text-secondary);
        font-size: var(--font-size-base);
        text-transform: none;
        letter-spacing: 0.08em;
        flex-grow: 1;
      }
      .sai-reset-key-link {
        background: none;
        border: none;
        padding: 0;
        font-family: ${fontFamily};
        font-size: var(--font-size-base);
        color: var(--reset-link-color);
        text-decoration: none;
        margin-left: 12px;
        white-space: nowrap;
        cursor: pointer;
        transition: color var(--transition-fast);
        font-weight: var(--font-weight-normal);
      }
      .sai-reset-key-link:hover {
        color: var(--reset-link-hover);
      }
      .sai-model-item {
        width: 100%;
        text-align: left;
        background: transparent;
        border: none;
        font-family: ${fontFamily};
        padding: 11px 14px;
        margin: 2px 0;
        border-radius: var(--radius-sm);
        transition: all var(--transition-fast);
        font-size: var(--font-size-base);
        cursor: pointer;
        color: var(--color-text-secondary);
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-weight: var(--font-weight-normal);
      }
      .sai-model-item:hover {
        background-color: var(--color-bg-hover);
        color: var(--color-text-primary);
        transform: translateX(2px);
      }
      .sai-model-item.sai-model-item-active,
      .sai-model-item.sai-model-item-active:hover {
        color: var(--color-accent);
      }
      .sai-error-text {
        color: var(--color-error);
      }

      /* =================================================================
         LOADING & STATUS INDICATORS
         ================================================================= */
      .sai-glow {
        text-align: center;
        margin: 0;
        padding: 0;
        animation: sai-glow 2.5s ease-in-out infinite;
        text-shadow: 0 0 12px color-mix(in srgb, currentColor 40%, transparent);
        font-family: ${fontFamily};
        font-weight: 400;
        line-height: 1;
        transform: translateY(1em);
      }

      /* =================================================================
         ANIMATIONS
         ================================================================= */
      @keyframes sai-glow {
        0%, 100% { color: var(--glow-1); }
        33%      { color: var(--glow-2); }
        66%      { color: var(--glow-3); }
      }
      @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
      @keyframes slideInUp {
         from { transform: translateY(30px); opacity: 0; }
         to { transform: translateY(0); opacity: 1; }
      }


      /* =================================================================
         MOBILE RESPONSIVENESS
         ================================================================= */
      @media (max-width: 600px) {
         /* Custom Modal Mobile */
         .sai-modal-content {
           max-width: 95%;
           border-radius: 12px;
         }

         .sai-modal-message {
           padding: 24px 24px 20px 24px;
           font-size: var(--font-size-sm);
         }

         .sai-modal-input {
           margin: 0 24px 20px 24px;
           width: calc(100% - 48px);
           padding: 12px 14px;
           font-size: var(--font-size-sm);
         }

         .sai-modal-button {
           padding: 14px;
           font-size: var(--font-size-sm);
         }

         /* Error Notification Mobile */
         .sai-error-notification {
           bottom: 20px;
           left: 16px;
           right: 16px;
           transform: translateX(0) translateY(20px);
           min-width: auto;
           max-width: none;
           padding: 14px 16px;
         }

         .sai-error-notification.sai-error-active {
           transform: translateX(0) translateY(0);
         }

         .sai-error-message {
           font-size: var(--font-size-sm);
         }

         .sai-error-close {
           width: 44px;
           height: 44px;
         }

         /* 44px touch targets */
         .sai-menubar-button,
         .sai-ask-button,
         .sai-modal-button,
         .sai-model-item,
         .sai-reset-key-link {
           min-height: 44px;
           min-width: 44px;
         }

         #${CONFIG.ids.content} {
            width: 100%; height: 100%;
            max-width: none; max-height: none;
            padding: 0 0 56px 0;
            box-shadow: none; animation: none;
            overflow-y: auto;
            border-radius: 0;
         }
         .sai-summary-menubar {
            padding: 10px 16px;
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            z-index: 11;
         }
         .sai-menubar-button {
            font-size: var(--font-size-sm);
            padding: 6px 10px;
         }
         .sai-summary-content-body {
            padding: 20px 16px;
         }
         .sai-question-section {
            padding: 20px 16px;
         }
         .sai-question-header {
            font-size: var(--font-size-sm);
         }
         .sai-question-input-wrapper {
            flex-direction: column;
            gap: 8px;
         }
         .sai-question-input {
            font-size: var(--font-size-sm);
         }
         .sai-ask-button {
            width: 100%;
            font-size: var(--font-size-sm);
         }
         .sai-image-gallery {
            padding: 20px 16px;
            grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
            gap: 10px;
         }
         .sai-gallery-item img {
            height: 140px;
         }
         #${CONFIG.ids.overlay} ~ #${CONFIG.ids.button},
         #${CONFIG.ids.overlay} ~ #${CONFIG.ids.dropdown} { display: none !important; }

         .sai-lightbox-menubar {
            padding: 8px 12px;
            gap: 8px;
         }
         .sai-lightbox-menubar .sai-menubar-button {
            font-size: var(--font-size-sm);
            padding: 4px 6px;
         }
         .sai-lightbox-counter {
            font-size: var(--font-size-sm);
            padding: 4px 8px;
         }
         .sai-lightbox-content {
            padding: 10px;
         }
      }
    `);
	}

	// --- Initialization ---
	// `module` only exists when Vitest imports this file for the pure-helper tests below;
	// it's always undefined in a real userscript/browser context, where init must run.
	if (typeof module === "undefined") {
		initialize();
	} else {
		module.exports = {
			escapeHtml,
			formatQAAnswer,
			cleanSummaryHTML,
			extractSummaryFromResponse,
			truncationNotice,
		};
	}
})();
