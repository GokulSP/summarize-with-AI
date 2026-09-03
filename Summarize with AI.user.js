// ==UserScript==
// @name        Summarize with AI
// @namespace   https://github.com/GokulSP/summarize-with-AI
// @version     2026.09.01.01
// @description Single-button AI summarization (Claude & Gemini) with model selection dropdown for articles/news. Uses Alt+S shortcut. Long press 'S' (or tap-and-hold on mobile) to select model. Allows adding custom models. Custom modals with Dieter Rams-inspired design. Adapts to dark mode and mobile viewports.
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
		ids: {
			button: "summarize-button",
			dropdown: "model-dropdown",
			overlay: "summarize-overlay",
			closeButton: "summarize-close",
			content: "summarize-content",
			error: "summarize-error",
			retryButton: "summarize-retry-button",
			askButton: "summarize-ask-button",
			questionInput: "summarize-question-input",
			questionSection: "summarize-question-section",
			modal: "custom-modal",
			modalOverlay: "custom-modal-overlay",
			modalContent: "custom-modal-content",
			modalMessage: "custom-modal-message",
			modalInput: "custom-modal-input",
			modalActions: "custom-modal-actions",
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
			defaultMaxTokens: 1000,
			targetWordCount: 300,
			bulletPointMaxWords: 20,
			maxImages: 12,
			galleryDisplayLimit: 6,
		},

		// Selectors
		selectors: {
			input: 'input, textarea, select, [contenteditable="true"]',
		},

		// Model Groups
		modelGroups: {
			claude: {
				name: "Claude",
				baseUrl: "https://api.anthropic.com/v1/messages",
				models: [{ id: "claude-sonnet-4-6", name: "Sonnet" }],
				get defaultParams() {
					return { max_tokens: CONFIG.limits.defaultMaxTokens };
				},
			},
			gemini: {
				name: "Gemini",
				baseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
				models: [{ id: "gemini-3.5-flash", name: "Flash" }],
			},
		},

		// UI Styles & Colors
		styles: {
			fontFamily:
				'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
			colors: {
				activeModel: "#1A73E8",
				error: "#d32f2f",
			},
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
	/** @typedef {{ closeBtn: HTMLButtonElement | null, retryBtn: HTMLButtonElement | null, askBtn: HTMLButtonElement | null, questionInput: HTMLInputElement | null, answerContainer: HTMLElement | null, imageGallery: HTMLElement | null }} OverlayElements */
	/** @typedef {{ img: HTMLImageElement, iframe: HTMLIFrameElement, counter: HTMLElement, prevBtn: HTMLButtonElement, nextBtn: HTMLButtonElement, thumbnailStrip: HTMLElement }} LightboxElements */

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
			SONNET_CACHE: "latest_sonnet_cache",
			GEMINI_CACHE: "latest_gemini_cache",
			/** @param {string} service */
			API_KEY: service => `${service}_api_key`,
		},

		/** @param {string} defaultModel */
		async getLastUsedModel(defaultModel) {
			return await GM.getValue(this.keys.LAST_USED_MODEL, defaultModel);
		},

		/** @param {string} modelId */
		async setLastUsedModel(modelId) {
			if (!modelId) {
				console.warn("StorageService: Cannot save empty model ID");
				return;
			}
			return await GM.setValue(this.keys.LAST_USED_MODEL, modelId);
		},

		/** @param {string} service */
		async getApiKey(service) {
			if (!service) {
				console.error("StorageService: Service parameter is required");
				return null;
			}
			const apiKey = /** @type {string | undefined} */ (
				await GM.getValue(this.keys.API_KEY(service))
			);
			return apiKey?.trim() || null;
		},

		/** @param {string} service @param {string} apiKey */
		async setApiKey(service, apiKey) {
			if (!service) {
				throw new Error("StorageService: Service parameter is required");
			}
			const keyToSave = (apiKey || "").trim();
			return await GM.setValue(this.keys.API_KEY(service), keyToSave);
		},

		async getLatestSonnetCache() {
			return /** @type {{ modelId: string, timestamp: number } | null} */ (
				await GM.getValue(this.keys.SONNET_CACHE, null)
			);
		},

		/** @param {string} modelId */
		async setLatestSonnetCache(modelId) {
			await GM.setValue(this.keys.SONNET_CACHE, { modelId, timestamp: Date.now() });
		},

		async getLatestGeminiCache() {
			return /** @type {{ modelId: string, timestamp: number } | null} */ (
				await GM.getValue(this.keys.GEMINI_CACHE, null)
			);
		},

		/** @param {string} modelId */
		async setLatestGeminiCache(modelId) {
			await GM.setValue(this.keys.GEMINI_CACHE, { modelId, timestamp: Date.now() });
		},

		async clearLatestGeminiCache() {
			await GM.setValue(this.keys.GEMINI_CACHE, null);
		},
	};

	// UI Helper Functions
	const UIHelpers = {
		/** @param {boolean} visible */
		toggleDropdown(visible) {
			if (dom.dropdown) {
				dom.dropdown.style.display = visible ? "block" : "none";
			}
		},

		hideDropdown() {
			this.toggleDropdown(false);
		},

		showDropdown() {
			this.toggleDropdown(true);
		},

		/** @param {string} message @param {boolean} [preferOverlay] */
		showError(message, preferOverlay = false) {
			if (preferOverlay && dom.overlay) {
				updateSummaryOverlay(
					`<p style="color: ${CONFIG.styles.colors.error};">${message}</p>`,
					false,
				);
			} else {
				showErrorNotification(message);
			}
		},
	};

	// Validation Functions

	/** @typedef {HTMLElement & { _escHandler?: (e: KeyboardEvent) => void }} ModalOverlayElement */
	/** @typedef {{ message?: string, inputType?: string, placeholder?: string, defaultValue?: string }} ModalOptions */

	// Custom Modal Service - Dieter Rams inspired design
	const ModalService = {
		/** @type {ModalOverlayElement | null} */
		currentModal: null,
		/** @type {((value: any) => void) | null} */
		resolveCallback: null,

		/** @param {string} type @param {ModalOptions} [options] */
		create(type, options = {}) {
			return new Promise(resolve => {
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
					className: "modal-overlay",
				})
			);

			const modalContent = createElement("div", {
				id: CONFIG.ids.modalContent,
				className: `modal-content modal-${type}`,
			});

			// Message
			if (options.message) {
				const messageEl = createElement("div", {
					id: CONFIG.ids.modalMessage,
					className: "modal-message",
					innerHTML: options.message,
				});
				modalContent.appendChild(messageEl);
			}

			// Input field for prompt type
			let inputEl = null;
			if (type === "prompt") {
				inputEl = createElement("input", {
					id: CONFIG.ids.modalInput,
					className: "modal-input",
					type: options.inputType || "text",
					placeholder: options.placeholder || "",
					value: options.defaultValue || "",
				});
				modalContent.appendChild(inputEl);
			}

			// Actions
			const actionsEl = createElement("div", {
				id: CONFIG.ids.modalActions,
				className: "modal-actions",
			});

			if (type === "alert") {
				const okBtn = createElement("button", {
					className: "modal-button modal-button-primary",
					textContent: "OK",
					onclick: () => this.resolve(true),
					onmouseout: (/** @type {MouseEvent} */ e) =>
						/** @type {HTMLElement} */ (e.target)?.blur(),
				});
				actionsEl.appendChild(okBtn);
			} else if (type === "prompt") {
				const cancelBtn = createElement("button", {
					className: "modal-button modal-button-secondary",
					textContent: "Cancel",
					onclick: () => this.resolve(null),
					onmouseout: (/** @type {MouseEvent} */ e) =>
						/** @type {HTMLElement} */ (e.target)?.blur(),
				});
				const okBtn = createElement("button", {
					className: "modal-button modal-button-primary",
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
				modalOverlay.classList.add("modal-active");
			});
		},

		/** @param {any} value */
		resolve(value) {
			if (this.currentModal?._escHandler) {
				document.removeEventListener("keydown", this.currentModal._escHandler);
			}

			if (this.currentModal) {
				this.currentModal.classList.remove("modal-active");
				setTimeout(() => {
					this.close();
					if (this.resolveCallback) {
						this.resolveCallback(value);
						this.resolveCallback = null;
					}
				}, 200);
			}
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

	/** @type {{ activeModel: string, articleData: ArticleData | null, currentSummary: Summary | null, dropdownNeedsUpdate: boolean, articleImages: ImageItem[], summaryCache: Map<string, { articleData: ArticleData | null, images: ImageItem[], summary: Summary | null }> }} */
	const state = {
		activeModel: CONFIG.modelGroups.claude.models[0].id,
		articleData: null,
		currentSummary: null,
		dropdownNeedsUpdate: true,
		articleImages: [],
		summaryCache: new Map(), // Cache summaries by model: modelId -> { articleData, images, summary }
	};

	/** @type {{ button: HTMLElement | null, dropdown: HTMLElement | null, overlay: HTMLElement | null, overlayElements: OverlayElements | null, overlayCleanup: (() => void) | null, lightbox: HTMLElement | null, lightboxElements: LightboxElements | null, lightboxCleanup: (() => void) | null }} */
	const dom = {
		button: null,
		dropdown: null,
		overlay: null,
		overlayElements: null,
		overlayCleanup: null,
		lightbox: null,
		lightboxElements: null, // Cache lightbox child elements
		lightboxCleanup: null, // Store cleanup function for lightbox listeners
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

		/** @param {Event} [e] */
		const cancel = e => {
			if (e) e.stopPropagation();
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
	 * @param {(string | Node)[]} [children]
	 * @returns {HTMLElementTagNameMap[K]}
	 */
	const createElement = (tag, attrs = {}, children = []) => {
		const el = /** @type {any} */ (document.createElement(tag));

		// Use for...of for better performance than forEach
		for (const [key, value] of Object.entries(attrs)) {
			if (key === "style") {
				el.style.cssText = value;
			} else if (key.startsWith("on")) {
				el.addEventListener(key.substring(2).toLowerCase(), value);
			} else {
				el[key] = value;
			}
		}

		for (const child of children) {
			el.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
		}

		return el;
	};

	/** @param {Record<string, any>} serviceDefaults @param {Record<string, any>} [modelParams] */
	const mergeParams = (serviceDefaults, modelParams) => ({
		...serviceDefaults,
		...modelParams,
	});

	/** @param {string} contentHTML @param {boolean} [hasError] @param {boolean} [isLoading] */
	const buildOverlayContent = (contentHTML, hasError = false, isLoading = false) => {
		// Optimize: pre-allocate approximate string size and use single concatenation
		let html = `<div class="summary-content-body">${contentHTML}</div>`;

		if (hasError) {
			html += `<div style="text-align:center;padding-bottom:24px"><button id="${CONFIG.ids.retryButton}" class="retry-button">Try Again</button></div>`;
		} else if (!isLoading) {
			// Add images section if available (optimized: use array join instead of string concatenation)
			if (state.articleImages.length > 0) {
				const galleryItems = [];
				const displayLimit = Math.min(
					state.articleImages.length,
					CONFIG.limits.galleryDisplayLimit,
				);
				for (let i = 0; i < displayLimit; i++) {
					const item = state.articleImages[i];
					if (item.type === "iframe") {
						galleryItems.push(`<div class="gallery-item gallery-item-iframe" data-image-index="${i}">
                <div class="iframe-preview">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="2" y="3" width="20" height="14" rx="2"/>
                    <line x1="8" y1="21" x2="16" y2="21"/>
                    <line x1="12" y1="17" x2="12" y2="21"/>
                    <path d="M7 8l5 3-5 3V8z"/>
                  </svg>
                  <span>Interactive Chart</span>
                </div>
              </div>`);
					} else {
						galleryItems.push(`<div class="gallery-item" data-image-index="${i}">
                <img src="${item.src}" alt="${item.alt || "Article image"}" loading="lazy" decoding="async" />
              </div>`);
					}
				}
				html += `<div class="image-gallery">${galleryItems.join("")}</div>`;
			}

			// Add Q&A section after summary (but not during loading or error states)
			html += `<div id="${CONFIG.ids.questionSection}" class="question-section">
          <div class="question-header">Ask a question about this article:</div>
          <div class="question-input-wrapper">
            <input
              type="text"
              id="${CONFIG.ids.questionInput}"
              class="question-input"
              placeholder="Ask a question..."
            />
            <button id="${CONFIG.ids.askButton}" class="ask-button">Ask</button>
          </div>
          <div id="answer-container" class="answer-container"></div>
        </div>`;
		}

		// Add menu bar at the bottom
		html += `<div class="summary-menubar">`;
		html += `<button id="${CONFIG.ids.closeButton}" class="menubar-button" title="Close (Esc)">Close</button></div>`;

		return html;
	};

	// Optimize DOM queries by caching element lookups (avoid repeated getElementById calls)
	const attachOverlayHandlers = () => {
		// Batch DOM queries using a single call
		const contentElement = document.getElementById(CONFIG.ids.content);
		if (!contentElement) return;

		// Use querySelector on parent instead of multiple getElementById calls
		const closeBtn = /** @type {HTMLButtonElement | null} */ (
			contentElement.querySelector(`#${CONFIG.ids.closeButton}`)
		);
		const retryBtn = /** @type {HTMLButtonElement | null} */ (
			contentElement.querySelector(`#${CONFIG.ids.retryButton}`)
		);
		const askBtn = /** @type {HTMLButtonElement | null} */ (
			contentElement.querySelector(`#${CONFIG.ids.askButton}`)
		);
		const questionInput = /** @type {HTMLInputElement | null} */ (
			contentElement.querySelector(`#${CONFIG.ids.questionInput}`)
		);
		const answerContainer = /** @type {HTMLElement | null} */ (
			contentElement.querySelector("#answer-container")
		);

		// Create handler functions that can be removed later
		const handlers = {
			close: () => closeOverlay(),
			retry: () => processSummarization(),
			ask: () => handleAskQuestion(),
			/** @param {KeyboardEvent} e */
			keypress: e => {
				if (e.key === "Enter") handleAskQuestion();
			},
			/** @param {MouseEvent} e */
			galleryClick: e => {
				const galleryItem = /** @type {HTMLElement} */ (e.target)?.closest(".gallery-item");
				if (galleryItem instanceof HTMLElement && galleryItem.dataset.imageIndex) {
					const index = parseInt(galleryItem.dataset.imageIndex, 10);
					openLightbox(index);
				}
			},
		};

		// Attach event listeners
		if (closeBtn) closeBtn.addEventListener("click", handlers.close);
		if (retryBtn) retryBtn.addEventListener("click", handlers.retry);
		if (askBtn) askBtn.addEventListener("click", handlers.ask);
		if (questionInput) questionInput.addEventListener("keypress", handlers.keypress);

		// Optimize: Use event delegation instead of attaching handlers to each item
		const imageGallery = /** @type {HTMLElement | null} */ (
			contentElement.querySelector(".image-gallery")
		);
		if (imageGallery && !imageGallery.dataset.hasListener) {
			imageGallery.dataset.hasListener = "true";
			imageGallery.addEventListener("click", handlers.galleryClick);
		}

		// Cache elements for reuse
		dom.overlayElements = {
			closeBtn,
			retryBtn,
			askBtn,
			questionInput,
			answerContainer,
			imageGallery,
		};

		// Return cleanup function to remove all event listeners
		return () => {
			if (closeBtn) closeBtn.removeEventListener("click", handlers.close);
			if (retryBtn) retryBtn.removeEventListener("click", handlers.retry);
			if (askBtn) askBtn.removeEventListener("click", handlers.ask);
			if (questionInput) questionInput.removeEventListener("keypress", handlers.keypress);
			if (imageGallery) {
				imageGallery.removeEventListener("click", handlers.galleryClick);
				delete imageGallery.dataset.hasListener;
			}
		};
	};

	// --- Main Functions ---
	async function initialize() {
		state.articleData = getArticleData();

		if (state.articleData) {
			state.activeModel = await StorageService.getLastUsedModel(state.activeModel);
			addSummarizeButton();
			setupEventListeners();
			injectStyles();
		}
	}

	function getArticleData() {
		try {
			const documentClone = /** @type {Document} */ (document.cloneNode(true));
			const nonContentElements = documentClone.querySelectorAll(
				"script, style, noscript, iframe, figure, img, svg, header, footer, nav",
			);

			// Optimize: remove in forward order (no need to reverse iterate with NodeList)
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
	const IMAGE_EXTRACTION_REGEX = {
		economistWidth: /width=(\d+)/,
	};

	// Pre-calculated constants
	const IMAGE_ASPECT_RATIO = 0.5625; // 9/16

	async function extractArticleImages() {
		try {
			// Site-specific detection (cached once)
			const hostname = window.location.hostname;
			const isHBR = hostname.includes("hbr.org");
			const isEconomist = hostname.includes("economist.com");
			const isMcKinsey = hostname.includes("mckinsey.com");

			// Optimized lazy loading: Use Intersection Observer API instead of forced scrolling
			// This is non-blocking and much more performant
			/** @returns {Promise<void>} */
			const triggerLazyLoading = () => {
				return new Promise(resolve => {
					const images = document.querySelectorAll(
						'img[loading="lazy"], img[data-src], img[data-lazy-src]',
					);
					if (images.length === 0) {
						resolve();
						return;
					}

					let loadedCount = 0;
					const timeout = setTimeout(() => resolve(), 500); // Failsafe timeout

					const observer = new IntersectionObserver(entries => {
						entries.forEach(entry => {
							if (entry.isIntersecting) {
								observer.unobserve(entry.target);
							}
						});
					});

					images.forEach(img => {
						observer.observe(img);
						// Trigger load by scrolling into view (non-blocking)
						requestAnimationFrame(() => {
							img.scrollIntoView({ block: "nearest", behavior: "auto" });
							loadedCount++;
							if (loadedCount === images.length) {
								clearTimeout(timeout);
								observer.disconnect();
								// Small delay to let images actually load
								setTimeout(resolve, 100);
							}
						});
					});
				});
			};

			await triggerLazyLoading();

			const maxImages = CONFIG.limits.maxImages;
			/** @type {ImageItem[]} */
			const images = [];
			/** @type {Set<string>} */
			const seen = new Set();

			// Track first large image for Economist
			let hasEconomistLargeImage = false;

			// HBR.org URL exclusion - Use array for iteration, Set for checking
			const hbrExcludedUrls = [
				"https://hbr.org/resources/images/article_assets/2015/12/HBR-Ideacast-HP-feed.png",
				"https://hbr.org/resources/images/article_assets/2019/03/wide-cold-call.png",
				"https://hbr.org/resources/images/podcasts/episode-ideacast.png",
				"https://hbr.org/resources/images/podcasts/episode-cold-call.png",
				"https://hbr.org/resources/images/products/generic-tool.png",
				"https://hbr.org/resources/images/article_assets/2023/05/wide-hbr-on-leadership.png",
				"https://hbr.org/resources/images/article_assets/2019/04/WomenAtWork-Wide_WP_1200.png",
			];
			const hbrExcludedPrefix = "https://cdn11.bigcommerce.com/";

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

				// Optimize: single loop check instead of multiple includes
				let isVisualization = false;
				for (const domain of vizDomains) {
					if (src.includes(domain)) {
						isVisualization = true;
						break;
					}
				}

				if (isVisualization) {
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

			// STEP 2: Extract regular images (only if space available after iframes)
			if (images.length < maxImages) {
				const combinedSelector =
					'article img, main img, [role="main"] img, .article-content img, .post-content img, .entry-content img';
				const imgs = /** @type {NodeListOf<HTMLImageElement>} */ (
					document.querySelectorAll(combinedSelector)
				);

				for (const img of imgs) {
					if (images.length >= maxImages) break;

					const src = img.currentSrc || img.src || img.dataset.src || img.dataset.lazySrc;
					if (!src || seen.has(src) || src.startsWith("data:")) continue;

					// Combine Economist filters in single check
					if (isEconomist) {
						const hasPromotionalClass = img.closest('[class*="e1kb1ha80"]') !== null;
						const isHeaderImage = src.includes("_DE_");
						// "More from"/related-article teaser cards use CSS-module classes like
						// teaser_mb-teaser__k_8Tk and media_mb-teaser__media__JtjA2 — the hashed
						// suffix changes per Economist deploy, but the mb-teaser token is stable.
						const isTeaserImage = img.closest('[class*="mb-teaser"]') !== null;

						if (hasPromotionalClass || isHeaderImage || isTeaserImage) {
							continue;
						}
					}

					// Early URL filtering - optimized HBR check
					if (isHBR) {
						if (src.startsWith(hbrExcludedPrefix)) continue;
						// Optimize: use some() instead of manual loop
						if (hbrExcludedUrls.some(url => src.startsWith(url))) continue;
					}

					// McKinsey: exclude staff headshots and thumbnail crops
					if (isMcKinsey) {
						if (
							src.includes("/our%20people/") ||
							src.includes("-thumb") ||
							src.includes("headshot")
						)
							continue;
					}

					// Extract dimensions
					let width = img.naturalWidth;
					let height = img.naturalHeight;
					let isEconomistChart = false;

					// Extract width from URL parameters
					if (isEconomist && src.includes("cdn-cgi/image/width=")) {
						const match = IMAGE_EXTRACTION_REGEX.economistWidth.exec(src);
						if (match) {
							width = parseInt(match[1], 10);
							height = Math.round(width * IMAGE_ASPECT_RATIO);

							// Detect Economist charts (WBC = Weekly Business Chart, or content-assets/images path)
							isEconomistChart = src.includes("WBC") || src.includes("content-assets/images");
						}
					}

					// McKinsey exhibit charts are vector SVGs (often gzipped .svgz) with no
					// intrinsic raster size, so naturalWidth/naturalHeight report 0
					const isMcKinseySvgChart = isMcKinsey && (src.includes(".svgz") || src.includes(".svg"));

					// Combined size filters (with exemptions for Economist/McKinsey charts)
					if (width < 300 || height < 300) {
						// Allow Economist charts even if small (they're often 360px wide)
						if ((isEconomist && isEconomistChart) || isMcKinseySvgChart) {
							// Chart exemption - continue to add the image
						} else {
							continue;
						}
					}
					if (
						isHBR &&
						((width === 500 && height >= 700 && height <= 800) || (width === 383 && height === 215))
					)
						continue;

					// Economist large image filter
					if (isEconomist && width >= 1280 && height >= 720) {
						if (hasEconomistLargeImage) continue;
						hasEconomistLargeImage = true;
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
			}

			return images;
		} catch (error) {
			console.error("Summarize with AI: Image extraction failed:", error);
			return [];
		}
	}

	function addSummarizeButton() {
		if (dom.button) return;

		dom.button = createElement("div", {
			id: CONFIG.ids.button,
			textContent: "S",
			title: "Summarize (Alt+S) / Long Press or Tap & Hold to Select Model",
		});
		document.body.appendChild(dom.button);

		dom.dropdown = createDropdownElement();
		document.body.appendChild(dom.dropdown);
		populateDropdown(dom.dropdown);
	}

	function setupEventListeners() {
		const { button, dropdown } = dom;
		if (!button || !dropdown) return;

		const buttonPressHandler = createLongPressHandler(toggleDropdown);

		document.addEventListener("keydown", handleKeyPress);

		button.addEventListener("click", () => {
			if (!buttonPressHandler.check()) processSummarization();
		});

		buttonPressHandler.attachTo(button);

		// Event delegation for dropdown items
		dropdown.addEventListener("click", (/** @type {MouseEvent} */ e) => {
			const modelItem = /** @type {HTMLElement} */ (e.target)?.closest(
				".model-item:not(#add-custom-model)",
			);
			if (modelItem instanceof HTMLElement && modelItem.dataset.modelId) {
				state.activeModel = modelItem.dataset.modelId;
				StorageService.setLastUsedModel(state.activeModel);
				UIHelpers.hideDropdown();
				processSummarization();
			}
		});

		document.addEventListener("click", handleOutsideClick);
		setupFocusListeners();
	}

	function createDropdownElement() {
		return createElement("div", {
			id: CONFIG.ids.dropdown,
			style: "display: none",
		});
	}

	/** @param {HTMLElement} dropdownElement */
	function populateDropdown(dropdownElement) {
		const fragment = document.createDocumentFragment();

		for (const [service, group] of Object.entries(CONFIG.modelGroups)) {
			const models = group.models || [];

			if (models.length > 0) {
				const groupDiv = createElement("div", { className: "model-group" });
				groupDiv.appendChild(createHeader(group.name, service));
				for (const modelObj of models) {
					groupDiv.appendChild(createModelItem(modelObj, service));
				}
				fragment.appendChild(groupDiv);
			}
		}

		dropdownElement.innerHTML = "";
		dropdownElement.appendChild(fragment);
	}

	/** @param {string} text @param {string} service */
	function createHeader(text, service) {
		const container = createElement("div", { className: "group-header-container" });

		container.appendChild(
			createElement("span", {
				className: "group-header-text",
				textContent: text,
			}),
		);

		container.appendChild(
			createElement("a", {
				href: "#",
				textContent: "Reset Key",
				className: "reset-key-link",
				title: `Reset ${text} API Key`,
				onclick: (/** @type {MouseEvent} */ e) => {
					e.preventDefault();
					e.stopPropagation();
					handleApiKeyReset(service);
				},
			}),
		);

		return container;
	}

	/** @param {ModelEntry} modelObj @param {string} service */
	function createModelItem(modelObj, service) {
		const item = createElement("div", {
			className: "model-item",
			textContent: modelObj.name || modelObj.id,
			title: "Click to use this model.",
		});

		// Store data as attributes for event delegation
		item.dataset.modelId = modelObj.id;
		item.dataset.service = service;

		if (modelObj.id === state.activeModel) {
			item.style.fontWeight = "normal";
			item.style.color = CONFIG.styles.colors.activeModel;
		}

		return item;
	}

	function toggleDropdown() {
		if (!dom.dropdown) return;
		if (dom.dropdown.style.display === "none") {
			if (state.dropdownNeedsUpdate) {
				populateDropdown(dom.dropdown);
				state.dropdownNeedsUpdate = false;
			}
			UIHelpers.showDropdown();
		} else {
			UIHelpers.hideDropdown();
		}
	}

	/** @param {MouseEvent} event */
	function handleOutsideClick(event) {
		const target = /** @type {Node} */ (event.target);
		if (
			dom.dropdown &&
			dom.dropdown.style.display !== "none" &&
			!dom.dropdown.contains(target) &&
			!dom.button?.contains(target)
		) {
			UIHelpers.hideDropdown();
		}
	}

	/** @param {string} contentHTML @param {boolean} [isError] @param {boolean} [isLoading] */
	function showSummaryOverlay(contentHTML, isError = false, isLoading = false) {
		if (dom.overlay) {
			updateSummaryOverlay(contentHTML, isError, isLoading);
			return;
		}

		dom.overlay = createElement("div", { id: CONFIG.ids.overlay });
		dom.overlay.innerHTML = `<div id="${CONFIG.ids.content}">${buildOverlayContent(contentHTML, isError, isLoading)}</div>`;

		document.body.appendChild(dom.overlay);
		document.body.style.overflow = "hidden";

		// Store cleanup function for proper event listener removal
		dom.overlayCleanup = attachOverlayHandlers() ?? null;
		dom.overlay.onclick = e => e.target === dom.overlay && closeOverlay();
	}

	function closeOverlay() {
		if (dom.overlay) {
			// Cleanup event listeners before removing overlay
			if (dom.overlayCleanup) {
				dom.overlayCleanup();
				dom.overlayCleanup = null;
			}

			dom.overlay.remove();
			dom.overlay = null;
			dom.overlayElements = null;
			document.body.style.overflow = "";

			// Memory cleanup: clear temporary display data
			// Note: Keep state.articleData intact for re-summarization and cache lookup
			state.currentSummary = null;
			state.articleImages = [];

			// Show the summary button again after closing overlay
			if (dom.button) dom.button.style.display = "flex";
		}
	}

	/** @param {string} contentHTML @param {boolean} [isError] @param {boolean} [isLoading] */
	function updateSummaryOverlay(contentHTML, isError = false, isLoading = false) {
		const contentDiv = document.getElementById(CONFIG.ids.content);
		if (contentDiv) {
			// Cleanup old event listeners before updating content
			if (dom.overlayCleanup) {
				dom.overlayCleanup();
				dom.overlayCleanup = null;
			}

			contentDiv.innerHTML = buildOverlayContent(contentHTML, isError, isLoading);

			// Reattach handlers with new cleanup function
			dom.overlayCleanup = attachOverlayHandlers() ?? null;
		}
	}

	/** @param {string} message */
	function showErrorNotification(message) {
		const existing = document.getElementById(CONFIG.ids.error);
		if (existing) existing.remove();

		const errorDiv =
			/** @type {HTMLDivElement & { _autoDismissTimeout?: ReturnType<typeof setTimeout> }} */ (
				createElement("div", {
					id: CONFIG.ids.error,
					className: "error-notification",
				})
			);

		const messageEl = createElement("div", {
			className: "error-message",
			innerText: message,
		});

		const closeBtn = createElement("button", {
			className: "error-close",
			textContent: "×",
			onclick: () => errorDiv.remove(),
		});

		errorDiv.appendChild(messageEl);
		errorDiv.appendChild(closeBtn);
		document.body.appendChild(errorDiv);

		// Animate in
		requestAnimationFrame(() => {
			errorDiv.classList.add("error-active");
		});

		// Auto-dismiss after duration, but allow manual dismiss (with cleanup)
		const autoDismissTimeout = setTimeout(() => {
			if (errorDiv.parentNode) {
				errorDiv.classList.remove("error-active");
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
	/**
	 * @param {keyof typeof CONFIG.modelGroups} service
	 * @param {string} activePrefix
	 * @param {(apiKey: string) => Promise<ModelEntry | null>} resolver
	 * @param {string} apiKey
	 */
	async function syncLatestModel(service, activePrefix, resolver, apiKey) {
		const latest = await resolver(apiKey);
		if (!latest) return;

		const currentEntry = CONFIG.modelGroups[service].models[0];
		if (currentEntry.id === latest.id) return;

		currentEntry.id = latest.id;
		currentEntry.name = latest.name;
		if (state.activeModel.startsWith(activePrefix)) {
			state.activeModel = latest.id;
			StorageService.setLastUsedModel(state.activeModel);
		}
		state.dropdownNeedsUpdate = true;
	}

	async function validateModelAndApiKey() {
		let modelConfig = getActiveModelConfig();
		if (!modelConfig) {
			// The persisted model ID may be stale (e.g. an auto-discovered model from a
			// prior session that no longer matches the freshly-initialized seed list).
			// Fall back to that service's seed model so the auto-discovery below can
			// reconcile state.activeModel to the current latest model.
			const fallbackService = state.activeModel.startsWith("gemini")
				? "gemini"
				: state.activeModel.startsWith("claude")
					? "claude"
					: null;
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

		const modelDisplayName = modelConfig.name || modelConfig.id;
		const service = modelConfig.service;

		const apiKey = await StorageService.getApiKey(service);
		if (!apiKey) {
			const errorMsg = `${toTitleCase(service)} API key is required. To add one, long-press the S button and select Reset Key.`;
			UIHelpers.showError(errorMsg, true);
			return null;
		}

		if (service === "claude") {
			await syncLatestModel("claude", "claude-sonnet", resolveLatestSonnetModel, apiKey);
		} else if (service === "gemini") {
			await syncLatestModel("gemini", "gemini", resolveLatestGeminiModel, apiKey);
		}

		const finalModelConfig = getActiveModelConfig() ?? modelConfig;
		const finalDisplayName = finalModelConfig.name || finalModelConfig.id;

		return { modelConfig: finalModelConfig, apiKey, service, modelDisplayName: finalDisplayName };
	}

	async function processSummarization() {
		try {
			// Hide the summary button during summarization
			if (dom.button) dom.button.style.display = "none";

			// Re-extract on every click (not just at page load) so content revealed after
			// load — e.g. clicking a "Transcript" tab — is picked up. Readability's own
			// visibility filter drops hidden tab panels at parse time, so the load-time
			// snapshot never contains a tab the user hadn't opened yet.
			const articleData = getArticleData() ?? state.articleData;
			if (!articleData) {
				showErrorNotification(
					"Unable to extract article content. Please try selecting text manually.",
				);
				// Show button again if validation fails
				if (dom.button) dom.button.style.display = "flex";
				return;
			}

			const validationResult = await validateModelAndApiKey();
			if (!validationResult) {
				// Show button again if validation fails
				if (dom.button) dom.button.style.display = "flex";
				return;
			}

			const { modelConfig } = validationResult;

			// Check cache first - use cached summary if available for this model
			const cachedData = state.summaryCache.get(modelConfig.id);
			if (cachedData?.summary) {
				// Restore from cache
				state.articleData = cachedData.articleData;
				state.articleImages = cachedData.images;
				state.currentSummary = cachedData.summary;

				// Show cached summary immediately
				showSummaryOverlay(cachedData.summary.content);
				return;
			}

			// No cache - extract images and generate new summary
			state.articleImages = await extractArticleImages();

			await executeSummarization(articleData, validationResult);
		} catch (/** @type {any} */ error) {
			handleSummarizationError(error);
			// Show button again on error
			if (dom.button) dom.button.style.display = "flex";
		}
	}

	// Known-stable text model to fall back to if the auto-discovered "latest flash"
	// model turns out to be a managed-agent/live variant requiring the Interactions API.
	/** @type {ModelConfig} */
	const GEMINI_SAFE_FALLBACK = { id: "gemini-3.5-flash", name: "Flash", service: "gemini" };

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
			const canFallBack =
				service === "gemini" &&
				modelConfig.id !== GEMINI_SAFE_FALLBACK.id &&
				/Interactions API/i.test(error.message);
			if (!canFallBack) throw annotateModelError(error, modelConfig.id);

			console.warn(
				"Summarize with AI: Auto-discovered Gemini model requires the Interactions API, retrying with",
				GEMINI_SAFE_FALLBACK.id,
			);
			await StorageService.clearLatestGeminiCache();
			showLoadingState(GEMINI_SAFE_FALLBACK.name);
			try {
				const response = await sendApiRequestWithRetry(
					service,
					apiKey,
					prompt,
					GEMINI_SAFE_FALLBACK,
				);
				handleApiResponse(response);
			} catch (/** @type {any} */ fallbackError) {
				throw annotateModelError(fallbackError, GEMINI_SAFE_FALLBACK.id);
			}
		}
	}

	/** @param {string} modelDisplayName */
	function showLoadingState(modelDisplayName) {
		const loadingMessage = `<p class="glow">Summarizing with ${modelDisplayName}... </p>`;
		if (dom.overlay) {
			updateSummaryOverlay(loadingMessage, false, true);
		} else {
			showSummaryOverlay(loadingMessage, false, true);
		}
	}

	/** @param {Error} error */
	function handleSummarizationError(error) {
		const errorMsg = `Error: ${error.message}`;
		console.error("Summarize with AI:", errorMsg, error);
		showSummaryOverlay(`<p style="color: ${CONFIG.styles.colors.error};">${errorMsg}</p>`, true);
		UIHelpers.hideDropdown();
	}

	/**
	 * @param {keyof typeof CONFIG.modelGroups} service @param {string} apiKey @param {string} prompt
	 * @param {ModelConfig} modelConfig @param {number} [maxTokens]
	 * @returns {Promise<ApiResponse>}
	 */
	async function sendApiRequest(service, apiKey, prompt, modelConfig, maxTokens) {
		const group = CONFIG.modelGroups[service];
		let url = group.baseUrl;
		const requestBody = buildRequestBody(prompt, modelConfig, service, maxTokens);

		// For Gemini, append model ID and API key to URL
		if (service === "gemini") {
			url = `${url}/${modelConfig.id}:generateContent?key=${apiKey}`;
		}

		return new Promise((resolve, reject) => {
			GM.xmlHttpRequest({
				method: "POST",
				url,
				headers: getHeaders(apiKey, service),
				data: JSON.stringify(requestBody),
				responseType: "json",
				timeout: CONFIG.timing.apiRequestTimeout,
				onload: response => {
					const responseData = response.response || response.responseText;
					resolve({
						status: response.status,
						data:
							typeof responseData === "object" ? responseData : JSON.parse(responseData || "{}"),
						statusText: response.statusText,
						service, // Pass service for response handling
					});
				},
				onerror: error =>
					reject(new Error(`Network error: ${error.statusText || "Failed to connect"}`)),
				onabort: () => reject(new Error("Request aborted")),
				ontimeout: () => reject(new Error("Request timed out after 60 seconds")),
			});
		});
	}

	// Shared GET + status-check + JSON-parse for the two providers' "list models" endpoints;
	// each provider still does its own candidate filtering/sorting on the returned data.
	/** @param {string} url @param {Record<string, string>} [headers] @returns {Promise<any>} */
	function fetchModelsList(url, headers = {}) {
		return new Promise((resolve, reject) => {
			GM.xmlHttpRequest({
				method: "GET",
				url,
				headers,
				responseType: "json",
				timeout: 10000,
				onload: response => {
					const data =
						typeof response.response === "object"
							? response.response
							: JSON.parse(response.responseText || "{}");
					if (response.status < 200 || response.status >= 300) {
						reject(new Error(`Models API error: ${response.status}`));
						return;
					}
					resolve(data);
				},
				onerror: err =>
					reject(new Error(`Network error: ${err.statusText || "Failed to connect"}`)),
				ontimeout: () => reject(new Error("Models API request timed out")),
			});
		});
	}

	/** @param {string} apiKey @returns {Promise<string>} */
	async function fetchLatestSonnetModel(apiKey) {
		const data = await fetchModelsList("https://api.anthropic.com/v1/models", {
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			"anthropic-dangerous-direct-browser-access": "true",
		});
		/** @type {{ id: string }[]} */
		const sonnetModels = (data.data || [])
			.filter((/** @type {{ id: string }} */ m) => m.id?.startsWith("claude-sonnet"))
			.sort((/** @type {{ id: string }} */ a, /** @type {{ id: string }} */ b) =>
				b.id.localeCompare(a.id),
			);
		if (sonnetModels.length === 0) throw new Error("No Sonnet models found");
		return sonnetModels[0].id;
	}

	/** @param {string} apiKey @returns {Promise<string>} */
	async function fetchLatestGeminiFlashModel(apiKey) {
		const data = await fetchModelsList(
			`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
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
	}

	const MODEL_CACHE_TTL = 24 * 60 * 60 * 1000;

	// Shared cache-check -> fetch -> cache-store -> catch-and-warn-null flow for both providers'
	// "latest model" resolution; only the cache accessors, fetcher, and display name differ.
	/**
	 * @param {() => Promise<{ modelId: string, timestamp: number } | null>} getCache
	 * @param {(id: string) => Promise<void>} setCache
	 * @param {(apiKey: string) => Promise<string>} fetchModel
	 * @param {string} name @param {string} apiKey @param {string} label
	 * @returns {Promise<ModelEntry | null>}
	 */
	async function resolveLatestModel(getCache, setCache, fetchModel, name, apiKey, label) {
		try {
			const cached = await getCache();
			if (cached && Date.now() - cached.timestamp < MODEL_CACHE_TTL) {
				return { id: cached.modelId, name };
			}
			const modelId = await fetchModel(apiKey);
			await setCache(modelId);
			return { id: modelId, name };
		} catch (/** @type {any} */ err) {
			console.warn(
				`Summarize with AI: Could not fetch latest ${label} model, using default:`,
				err.message,
			);
			return null;
		}
	}

	/** @param {string} apiKey */
	function resolveLatestSonnetModel(apiKey) {
		return resolveLatestModel(
			() => StorageService.getLatestSonnetCache(),
			id => StorageService.setLatestSonnetCache(id),
			fetchLatestSonnetModel,
			"Sonnet",
			apiKey,
			"Sonnet",
		);
	}

	/** @param {string} apiKey */
	function resolveLatestGeminiModel(apiKey) {
		return resolveLatestModel(
			() => StorageService.getLatestGeminiCache(),
			id => StorageService.setLatestGeminiCache(id),
			fetchLatestGeminiFlashModel,
			"Flash",
			apiKey,
			"Gemini",
		);
	}

	// Consolidated regex patterns at module level for better performance and maintainability
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

		// Only use DOM for final sanitization if needed
		const tempDiv = document.createElement("div");
		tempDiv.innerHTML = cleaned;
		return tempDiv.innerHTML;
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

		let rawSummary = "";
		let finishReason = null;
		let blockType = null;

		// Extract text based on API provider
		if (service === "gemini") {
			// Gemini response format: { candidates: [{ content: { parts: [{ text: "..." }] } }] }
			// Thinking-enabled models may prepend parts with `thought: true` before the answer part.
			const candidate = data?.candidates?.[0];
			const parts = candidate?.content?.parts || [];
			const answerPart = parts.find((/** @type {any} */ p) => p.text && !p.thought) || parts[0];
			rawSummary = answerPart?.text || "";
			finishReason = candidate?.finishReason || null;
			blockType = answerPart?.thought ? "thought" : null;

			// Check for finish reason
			if (finishReason === "MAX_TOKENS") {
				console.warn("Summarize with AI: Summary may be incomplete (max token limit reached)");
			}
		} else {
			// Claude response format (default)
			// Extended-thinking responses prepend a `thinking` block before the `text` block.
			const blocks = data?.content || [];
			const textBlock = blocks.find((/** @type {any} */ b) => b.type === "text") || blocks[0];
			finishReason = data?.stop_reason || null;
			blockType = textBlock?.type || null;
			if (finishReason === "max_tokens") {
				console.warn("Summarize with AI: Summary may be incomplete (max token limit reached)");
			}
			rawSummary = textBlock?.text || "";
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
			throw new Error(
				`API response did not contain a valid summary (${diagnostics || "no diagnostic info in response"}).`,
			);
		}

		return { rawSummary, finishReason, blockType };
	}

	/** @param {ApiResponse} response */
	function handleApiResponse(response) {
		const { rawSummary } = extractSummaryFromResponse(response);
		const cleanedSummary = cleanSummaryHTML(rawSummary);
		state.currentSummary = {
			title: state.articleData?.title || "Untitled",
			content: cleanedSummary,
			timestamp: new Date().toISOString(),
		};

		// Cache the summary with article data and images for this model
		state.summaryCache.set(state.activeModel, {
			articleData: state.articleData,
			images: state.articleImages,
			summary: state.currentSummary,
		});

		updateSummaryOverlay(cleanedSummary, false);
	}

	/**
	 * @param {string} prompt
	 * @param {ModelConfig} modelConfig
	 * @param {Service} service
	 * @param {number} [maxTokens]
	 */
	function buildRequestBody(
		prompt,
		modelConfig,
		service,
		maxTokens = CONFIG.limits.defaultMaxTokens,
	) {
		if (service === "gemini") {
			// Gemini API format - REST API requires structured content format
			return {
				contents: [
					{
						parts: [
							{
								text: prompt,
							},
						],
					},
				],
			};
		}

		// Claude API format (default)
		return {
			model: modelConfig.id,
			messages: [{ role: "user", content: prompt }],
			max_tokens: maxTokens,
		};
	}

	/** @param {string} apiKey @param {Service} service @returns {Record<string, string>} */
	function getHeaders(apiKey, service) {
		if (service === "gemini") {
			// Gemini uses API key in URL, not headers
			return {
				"Content-Type": "application/json",
			};
		}

		// Claude headers (default)
		return {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			"anthropic-dangerous-direct-browser-access": "true",
		};
	}

	/** @param {string} service */
	async function handleApiKeyReset(service) {
		if (!service || !CONFIG.modelGroups[/** @type {Service} */ (service)]) {
			console.error("Invalid service provided for API key reset:", service);
			await ModalService.alert("Invalid service provided.");
			return;
		}
		const newApiKey = await ModalService.prompt(
			`Enter your ${toTitleCase(service)} API key:`,
			"",
			"Leave blank to clear existing key",
		);

		if (newApiKey !== null) {
			const trimmedApiKey = newApiKey.trim();
			await StorageService.setApiKey(service, newApiKey);
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
		const result = [];
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
					result.push("</ul>");
					inList = false;
				}
				continue;
			}

			// Check if this is a numbered list item
			if (formatQA.numberedList.test(trimmedLine)) {
				if (!inList) {
					result.push("<ul>");
					inList = true;
				}
				// Remove the number and add as list item
				const content = trimmedLine.replace(formatQA.numberedListRemove, "");
				result.push(`<li>${content}</li>`);
				lastWasSectionHeader = false;
			}
			// Check if line is a section header (contains colon before closing tags)
			// Matches: <strong>Text:</strong>, <p><strong>Text:</strong></p>, or <strong>Text:</strong></p>
			else if (
				trimmedLine.includes(":") &&
				trimmedLine.match(/^(<p>)?<strong>[^<]+:<\/strong>(<\/p>)?$/)
			) {
				if (inList) {
					result.push("</ul>");
					inList = false;
				}
				// Wrap standalone <strong> headers in paragraph tags
				if (!trimmedLine.startsWith("<p>")) {
					result.push(`<p>${trimmedLine}</p>`);
				} else {
					result.push(trimmedLine);
				}
				lastWasSectionHeader = true;
			}
			// Check if line already has HTML tags (but not section headers)
			else if (trimmedLine.startsWith("<p>") || trimmedLine.startsWith("<strong>")) {
				if (inList) {
					result.push("</ul>");
					inList = false;
				}
				result.push(trimmedLine);
				lastWasSectionHeader = false;
			}
			// Regular paragraph
			else {
				if (inList) {
					result.push("</ul>");
					inList = false;
				}
				result.push(`<p>${trimmedLine}</p>`);
				lastWasSectionHeader = false;
			}
		}

		// Close any open list
		if (inList) {
			result.push("</ul>");
		}

		return result.join("\n");
	}

	async function handleAskQuestion() {
		const { questionInput, answerContainer, askBtn } = dom.overlayElements || {};

		if (!questionInput || !answerContainer) return;

		const question = questionInput.value.trim();
		if (!question) {
			showErrorNotification("Please enter a question.");
			return;
		}

		if (!state.articleData) {
			showErrorNotification("No article content available.");
			return;
		}

		// Disable input while processing
		questionInput.disabled = true;
		if (askBtn) {
			askBtn.disabled = true;
			askBtn.textContent = "Thinking...";
		}

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
			try {
				const response = await sendApiRequest(service, apiKey, prompt, modelConfig, 800);
				answer = extractSummaryFromResponse(response).rawSummary;
			} catch (/** @type {any} */ err) {
				throw annotateModelError(err, modelConfig.id);
			}

			// Format the answer with proper HTML structure
			const formattedAnswer = formatQAAnswer(answer);

			// Display answer
			answerContainer.innerHTML = `
        <div class="answer">
          <p><strong>Q:</strong> ${escapeHtml(question)}</p>
          <div class="answer-content">${formattedAnswer}</div>
        </div>
      `;

			// Clear input
			questionInput.value = "";
		} catch (/** @type {any} */ error) {
			console.error("Ask question failed:", error);
			answerContainer.innerHTML = `<p style="color: ${CONFIG.styles.colors.error};">Error: ${escapeHtml(error.message)}</p>`;
		} finally {
			// Re-enable input
			questionInput.disabled = false;
			if (askBtn) {
				askBtn.disabled = false;
				askBtn.textContent = "Ask";
			}
		}
	}

	/** @param {string} text */
	function escapeHtml(text) {
		const div = document.createElement("div");
		div.textContent = text;
		return div.innerHTML;
	}

	// --- Image Lightbox Functions ---
	let currentImageIndex = 0;
	let lightboxZoom = { scale: 1, x: 0, y: 0 };

	/** @param {number} scale */
	function clampZoomScale(scale) {
		return Math.min(Math.max(scale, 1), 4);
	}

	function applyLightboxZoomTransform() {
		const img = dom.lightboxElements?.img;
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

	/** @param {number} index */
	function openLightbox(index) {
		if (!state.articleImages.length) return;

		currentImageIndex = index;

		if (!dom.lightbox) {
			createLightbox();
		}

		updateLightboxImage();
		if (dom.lightbox) dom.lightbox.style.display = "flex";
		document.body.style.overflow = "hidden";
	}

	function closeLightbox() {
		if (dom.lightbox) {
			document.body.style.overflow = "";

			// Cleanup event listeners to prevent memory leaks
			if (dom.lightboxCleanup) {
				dom.lightboxCleanup();
				dom.lightboxCleanup = null;
			}

			// Remove the lightbox entirely so the next openLightbox() rebuilds it via
			// createLightbox(), re-attaching the wheel/drag/pinch/touch listeners that
			// dom.lightboxCleanup() just tore down (a stale-but-visible node would skip
			// createLightbox() and leave those listeners missing on the next open).
			dom.lightbox.remove();
			dom.lightbox = null;
			dom.lightboxElements = null;
		}
	}

	function createLightbox() {
		const lightbox = createElement("div", {
			className: "lightbox-overlay",
		});
		dom.lightbox = lightbox;

		// Create content container
		const lightboxContent = createElement("div", {
			className: "lightbox-content",
		});

		const img = createElement("img", {
			className: "lightbox-image",
			alt: "Full size image",
			title: "Scroll or pinch to zoom, drag to pan, double-click/tap to reset",
		});

		const iframe = createElement("iframe", {
			className: "lightbox-iframe",
			frameborder: "0",
			scrolling: "no",
			style: "display: none;",
		});

		lightboxContent.appendChild(img);
		lightboxContent.appendChild(iframe);

		// Create thumbnail strip
		const thumbnailStrip = createElement("div", {
			className: "lightbox-thumbnails",
		});

		// Create menu bar at bottom (similar to summary overlay)
		const menuBar = createElement("div", {
			className: "lightbox-menubar",
		});

		const prevBtn = createElement("button", {
			className: "menubar-button lightbox-prev",
			textContent: "← Prev",
			onclick: () => navigateLightbox(-1),
		});

		const counter = createElement("div", {
			className: "lightbox-counter",
		});

		const nextBtn = createElement("button", {
			className: "menubar-button lightbox-next",
			textContent: "Next →",
			onclick: () => navigateLightbox(1),
		});

		const closeBtn = createElement("button", {
			className: "menubar-button",
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
		dom.lightboxElements = {
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
			Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);

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

			const wasPinchOrPan = isPinching || isPanning;
			isPinching = false;
			isPanning = false;
			if (wasPinchOrPan) return;

			const touch = e.changedTouches[0];
			touchEndX = touch.screenX;
			const movedDistance = Math.hypot(touch.screenX - touchStartX, touch.screenY - touchStartY);

			if (movedDistance < 10) {
				// Tap - check for double-tap to toggle zoom
				const now = Date.now();
				if (now - lastTapTime < 300) {
					toggleLightboxZoom();
					lastTapTime = 0;
				} else {
					lastTapTime = now;
				}
			} else if (lightboxZoom.scale <= 1) {
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
		dom.lightboxCleanup = () => {
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
		if (!dom.lightbox || !dom.lightboxElements || !state.articleImages.length) return;

		resetLightboxZoom();

		const { img, iframe, counter, prevBtn, nextBtn, thumbnailStrip } = dom.lightboxElements;
		const currentItem = state.articleImages[currentImageIndex];
		counter.textContent = `${currentImageIndex + 1} / ${state.articleImages.length}`;

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
		nextBtn.disabled = currentImageIndex === state.articleImages.length - 1;

		// Update active thumbnail highlight
		const thumbnails = thumbnailStrip.querySelectorAll(".lightbox-thumbnail-item");
		thumbnails.forEach((thumb, idx) => {
			if (idx === currentImageIndex) {
				thumb.classList.add("active");
			} else {
				thumb.classList.remove("active");
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
		if (newIndex >= 0 && newIndex < state.articleImages.length) {
			currentImageIndex = newIndex;
			updateLightboxImage();
		}
	}

	function renderThumbnails() {
		if (!dom.lightboxElements || !dom.lightboxElements.thumbnailStrip) return;

		const { thumbnailStrip } = dom.lightboxElements;
		thumbnailStrip.innerHTML = "";

		state.articleImages.forEach((item, index) => {
			const thumbItem = createElement("div", {
				className: "lightbox-thumbnail-item",
			});

			const isIframe = item.type === "iframe";

			// Create thumbnail image or iframe indicator
			let thumbContent;
			if (isIframe) {
				thumbContent = createElement("div", {
					className: "lightbox-thumbnail-iframe-indicator",
					textContent: "🖼️",
					title: "Interactive content",
				});
			} else {
				thumbContent = createElement("img", {
					className: "lightbox-thumbnail-img",
					src: item.src,
					alt: item.alt || `Image ${index + 1}`,
				});
			}

			// Make thumbnail clickable to navigate
			thumbContent.addEventListener("click", () => {
				currentImageIndex = index;
				updateLightboxImage();
			});

			thumbItem.appendChild(thumbContent);
			thumbnailStrip.appendChild(thumbItem);
		});
	}

	/** @param {KeyboardEvent} e */
	function handleLightboxKeyboard(e) {
		if (!dom.lightbox || dom.lightbox.style.display === "none") return;

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

	// --- Event Handlers & Utilities ---
	/** @param {KeyboardEvent} e */
	function handleKeyPress(e) {
		if (e.altKey && e.code === "KeyS" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
			e.preventDefault();
			if (dom.button && !document.activeElement?.closest(CONFIG.selectors.input)) {
				processSummarization();
			}
		}
		if (e.key === "Escape") {
			if (dom.overlay) {
				e.preventDefault();
				closeOverlay();
			} else if (dom.dropdown && dom.dropdown.style.display !== "none") {
				e.preventDefault();
				dom.dropdown.style.display = "none";
			}
		}
	}

	function setupFocusListeners() {
		/** @type {ReturnType<typeof setTimeout> | null} */
		let focusOutTimer = null;

		document.addEventListener("focusin", event => {
			const target = /** @type {Element | null} */ (event.target);
			// Exclude modal inputs from hiding the button
			const isModalInput = target?.closest(".custom-modal-overlay");
			if (target?.closest(CONFIG.selectors.input) && !isModalInput) {
				if (focusOutTimer) {
					clearTimeout(focusOutTimer);
					focusOutTimer = null;
				}
				if (dom.button) dom.button.style.display = "none";
				if (dom.dropdown) dom.dropdown.style.display = "none";
			}
		});

		document.addEventListener(
			"focusout",
			event => {
				const target = /** @type {Element | null} */ (event.target);
				const relatedTarget = /** @type {Element | null} */ (event.relatedTarget);
				// Exclude modal inputs from the restore logic
				const isModalInput = target?.closest(".custom-modal-overlay");
				const isLeavingInput = target?.closest(CONFIG.selectors.input) && !isModalInput;
				const isEnteringInput = relatedTarget?.closest(CONFIG.selectors.input);

				if (isLeavingInput && !isEnteringInput && state.articleData) {
					focusOutTimer = setTimeout(() => {
						if (!document.activeElement?.closest(CONFIG.selectors.input)) {
							if (dom.button) dom.button.style.display = "flex";
						}
						focusOutTimer = null;
					}, CONFIG.timing.focusDebounceDelay);
				}
			},
			true,
		);
	}

	function injectStyles() {
		const fontFamily = CONFIG.styles.fontFamily;

		// Add viewport meta tag to prevent zooming on mobile
		if (!document.querySelector('meta[name="viewport"][content*="user-scalable=no"]')) {
			const viewport = document.createElement("meta");
			viewport.name = "viewport";
			viewport.content =
				"width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no";
			document.head.appendChild(viewport);
		}

		GM.addStyle(`
      /* =================================================================
         DESIGN SYSTEM TOKENS - Dieter Rams Principles
         Less but better: Unified spacing, colors, typography, transitions
         ================================================================= */
      :root {
        /* Color Palette */
        --color-text-primary: #1a1a1a;
        --color-text-secondary: #666;
        --color-text-tertiary: #999;
        --color-border: #e0e0e0;
        --color-border-light: #f0f0f0;
        --color-bg-primary: #ffffff;
        --color-bg-hover: #f5f5f5;
        --color-error: #d32f2f;
        --color-accent: #1A73E8;

        /* Component-specific colors */
        --button-bg: #1a1a1a;
        --button-bg-hover: #2a2a2a;
        --button-text: #ffffff;
        --input-focus-border: #d0d0d0;
        --overlay-bg: rgba(0, 0, 0, 0.4);
        --modal-button-text: #666;
        --answer-border: #1a1a1a;
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
        :root {
          --color-text-primary: #e8e8e8;
          --color-text-secondary: #999;
          --color-text-tertiary: #777;
          --color-border: #333;
          --color-border-light: #2a2a2a;
          --color-bg-primary: #1a1a1a;
          --color-bg-hover: #2a2a2a;
          --button-bg: #e8e8e8;
          --button-bg-hover: #ffffff;
          --button-text: #1a1a1a;
          --input-focus-border: #444;
          --overlay-bg: rgba(0, 0, 0, 0.6);
          --modal-button-text: #999;
          --answer-border: #666;
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
         MOBILE TOUCH PREVENTION
         ================================================================= */
      @media (max-width: 600px) {
        /* Prevent zooming and manipulation on all content areas */
        body {
          touch-action: pan-y;
          overscroll-behavior: none;
        }

        /* Lock all overlay and modal content from manipulation */
        #${CONFIG.ids.overlay},
        #${CONFIG.ids.content},
        .modal-overlay,
        .modal-content,
        .summary-content-body,
        .question-section,
        .image-gallery,
        .lightbox-overlay,
        .lightbox-content {
          touch-action: pan-y;
          user-select: none;
          -webkit-user-select: none;
        }

        /* Allow text selection only in specific content areas */
        #${CONFIG.ids.content} p,
        #${CONFIG.ids.content} ul,
        #${CONFIG.ids.content} ol,
        #${CONFIG.ids.content} li,
        .answer-content {
          user-select: text;
          -webkit-user-select: text;
        }

        /* Ensure buttons and interactive elements remain functional */
        button,
        .modal-button,
        .menubar-button,
        .ask-button,
        #${CONFIG.ids.button},
        .model-item,
        .lightbox-nav,
        .lightbox-close {
          touch-action: manipulation;
          user-select: none;
          -webkit-user-select: none;
        }

        /* Allow input fields to be interactive */
        input,
        textarea,
        .question-input,
        .modal-input {
          touch-action: manipulation;
          user-select: text;
          -webkit-user-select: text;
        }
      }

      /* =================================================================
         CUSTOM MODAL SYSTEM - Dieter Rams Design Principles
         ================================================================= */
      .modal-overlay {
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

      .modal-overlay.modal-active {
        background: var(--overlay-bg);
        opacity: 1;
      }

      .modal-content {
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

      .modal-active .modal-content {
        transform: scale(1) translateY(0);
      }

      .modal-message {
        padding: var(--space-lg) var(--space-lg) var(--space-md) var(--space-lg);
        font-size: var(--font-size-base);
        line-height: var(--line-height-normal);
        color: var(--color-text-primary);
        text-align: left;
      }

      .modal-input {
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

      .modal-input:focus {
        border-color: var(--input-focus-border);
        background: var(--color-bg-primary);
        box-shadow: none;
      }

      .modal-input::placeholder {
        color: var(--color-text-tertiary);
      }

      .modal-actions {
        display: flex;
        gap: 0;
        border-top: 1px solid var(--color-border-light);
      }

      .modal-button {
        flex: 1;
        padding: var(--space-sm);
        border: none;
        background: transparent;
        font-family: ${fontFamily};
        font-size: var(--font-size-base);
        font-weight: var(--font-weight-normal);
        cursor: pointer;
        transition: background var(--transition-fast);
        color: var(--modal-button-text);
        user-select: none;
        -webkit-user-select: none;
        -webkit-tap-highlight-color: transparent;
      }

      .modal-button:hover {
        background: var(--color-bg-hover);
      }

      .modal-button:active {
        background: transparent;
      }

      .modal-button:focus {
        outline: 2px solid var(--color-accent);
        outline-offset: -2px;
      }

      .modal-button-secondary {
        border-right: 1px solid var(--color-border-light);
      }

      .modal-button:only-child {
        border-right: none;
      }

      /* =================================================================
         MAIN UI COMPONENTS
         ================================================================= */
      #${CONFIG.ids.button} {
        position: fixed; bottom: 24px; right: 24px;
        width: 56px; height: 56px;
        background: #1A73E8;
        color: #ffffff;
        font-size: 16px; font-weight: var(--font-weight-normal);
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
        background: #1976D2;
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
      .summary-menubar {
        display: flex; justify-content: flex-end; gap: 12px;
        position: sticky; bottom: 0;
        background: var(--menubar-bg);
        padding: 12px 24px;
        border-top: 1px solid var(--color-border-light);
        z-index: 10;
        backdrop-filter: blur(10px);
      }
      .menubar-button {
        background: transparent;
        border: 1px solid var(--color-border);
        font-family: ${fontFamily};
        font-size: 15px;
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
      .menubar-button:hover {
        background: var(--color-bg-hover);
        border-color: var(--color-border);
        color: var(--color-text-primary);
      }
      .summary-content-body {
        padding: var(--space-lg) var(--space-xl);
        flex: 1;
        display: flex;
        flex-direction: column;
        justify-content: center;
      }

      /* When content is loaded, remove centering */
      .summary-content-body:has(ul),
      .summary-content-body:has(p:not(.glow)) {
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
        font-size: 16px !important;
        line-height: 1.5 !important;
      }
      #${CONFIG.ids.content} ul {
        margin: 0 0 1.2em 0;
        padding-left: 1.5em;
        color: inherit;
        font-size: 16px !important;
      }
      #${CONFIG.ids.content} li {
        list-style-type: disc;
        margin-bottom: 0.6em;
        color: inherit;
        font-size: 16px !important;
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
      .error-notification {
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

      .error-notification.error-active {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }

      .error-message {
        flex: 1;
        font-size: 15px;
        line-height: 1.5;
        color: var(--color-text-primary);
        margin: 0;
      }

      .error-close {
        background: transparent;
        border: none;
        color: var(--color-text-secondary);
        font-size: 24px;
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

      .error-close:hover {
        background: var(--color-bg-hover);
        color: var(--color-text-primary);
      }

      /* Base button styles */
      .retry-button, .save-button {
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
      .retry-button:hover, .save-button:hover:not(:disabled) {
        background-color: var(--button-bg-hover);
        box-shadow: var(--shadow-sm);
        transform: translateY(-1px);
      }
      .save-button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      /* =================================================================
         Q&A SECTION
         ================================================================= */
      .question-section {
        border-top: 1px solid var(--color-border-light);
        padding: var(--space-md) var(--space-xl);
        margin-top: 0;
        background: var(--section-bg);
      }
      .question-header {
        font-weight: var(--font-weight-normal);
        color: var(--color-text-primary);
        margin-bottom: 12px;
        font-size: 15px;
      }
      .question-input-wrapper {
        display: flex;
        gap: 10px;
        margin-bottom: var(--space-sm);
      }
      .question-input {
        flex: 1;
        padding: 10px 14px;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        font-family: ${fontFamily};
        font-size: 15px;
        transition: border-color var(--transition-fast);
        background: var(--color-bg-primary);
        color: var(--color-text-primary);
        outline: none;
      }
      .question-input:focus {
        outline: none;
        border-color: var(--input-focus-border);
        box-shadow: none;
      }
      .question-input:disabled {
        background: var(--color-bg-hover);
        color: var(--color-text-secondary);
        cursor: not-allowed;
      }
      .ask-button {
        padding: 10px 20px;
        background-color: var(--button-bg);
        color: var(--button-text);
        border: none;
        border-radius: var(--radius-sm);
        cursor: pointer;
        font-family: ${fontFamily};
        font-size: 15px;
        font-weight: var(--font-weight-normal);
        transition: all var(--transition-fast);
        white-space: nowrap;
        user-select: none;
        -webkit-user-select: none;
        -webkit-tap-highlight-color: transparent;
      }
      .ask-button:hover:not(:disabled) {
        background-color: var(--button-bg-hover);
      }
      .ask-button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .answer-container {
        min-height: 40px;
      }
      .answer {
        background: var(--color-bg-primary);
        padding: var(--space-sm);
        border-radius: var(--radius-sm);
        border-left: 3px solid var(--answer-border);
        line-height: var(--line-height-normal);
      }
      .answer > p {
        margin-top: 0;
        margin-bottom: 1em;
      }
      .answer > p:first-child {
        font-weight: var(--font-weight-semibold);
        color: var(--color-text-primary);
        margin-bottom: 0.75em;
      }
      .answer strong {
        color: var(--color-text-primary);
        font-weight: var(--font-weight-semibold);
      }
      .answer-content {
        margin-top: 0.5em;
      }
      .answer-content p {
        margin-top: 0;
        margin-bottom: 1em;
        line-height: var(--line-height-normal);
      }
      .answer-content ul {
        margin: 0.75em 0;
        padding-left: 1.5em;
      }
      .answer-content li {
        margin-bottom: 0.5em;
        line-height: 1.5;
      }

      /* =================================================================
         IMAGE GALLERY
         ================================================================= */
      .image-gallery {
        padding: var(--space-md) var(--space-xl);
        background: var(--section-bg);
        border-top: 1px solid var(--color-border-light);
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: 12px;
      }
      .gallery-item {
        overflow: hidden;
        border-radius: var(--radius-sm);
        background: var(--color-bg-primary);
        box-shadow: var(--shadow-sm);
        cursor: pointer;
        transition: transform var(--transition-fast), box-shadow var(--transition-fast);
      }
      .gallery-item:hover {
        transform: translateY(-2px);
        box-shadow: var(--shadow-md);
      }
      .gallery-item img {
        width: 100%;
        height: 180px;
        object-fit: cover;
        display: block;
      }
      /* Exhibit-chart SVGs are designed for a white canvas — force it regardless of
         dark/light mode so chart text stays legible, and avoid cropping chart labels. */
      .gallery-item img[src*=".svg"] {
        background: #fff;
        object-fit: contain;
      }
      .gallery-item-iframe {
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--color-bg-hover);
        min-height: 200px;
      }
      .iframe-preview {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: var(--space-xs);
        color: var(--color-text-secondary);
      }
      .iframe-preview svg {
        width: 48px;
        height: 48px;
      }
      .iframe-preview span {
        font-size: var(--font-size-sm);
        font-weight: var(--font-weight-normal);
      }

      /* =================================================================
         LIGHTBOX VIEWER
         ================================================================= */
      .lightbox-overlay {
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
      .lightbox-menubar {
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
      .lightbox-menubar .menubar-button {
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
      .lightbox-menubar .menubar-button:hover:not(:disabled) {
        background: var(--color-bg-hover);
        border-color: var(--color-border);
        color: var(--color-text-primary);
      }
      .lightbox-menubar .menubar-button:disabled {
        opacity: 0.3;
        cursor: not-allowed;
      }
      .lightbox-counter {
        color: var(--color-text-secondary);
        padding: 4px 12px;
        font-size: var(--font-size-base);
        font-family: ${fontFamily};
        font-weight: var(--font-weight-normal);
        margin: 0;
      }
      .lightbox-content {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        padding: 20px;
      }
      .lightbox-image {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        user-select: none;
        -webkit-user-select: none;
        touch-action: none;
        cursor: zoom-in;
      }
      .lightbox-image[src*=".svg"] {
        background: #fff;
      }
      .lightbox-iframe {
        width: 90vw;
        max-width: 1200px;
        height: 80vh;
        border: none;
        background: var(--color-bg-primary);
      }

      /* Thumbnail Strip */
      .lightbox-thumbnails {
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
      .lightbox-thumbnails::-webkit-scrollbar {
        height: 6px;
      }
      .lightbox-thumbnails::-webkit-scrollbar-track {
        background: transparent;
      }
      .lightbox-thumbnails::-webkit-scrollbar-thumb {
        background: var(--color-border);
        border-radius: 3px;
      }
      .lightbox-thumbnail-item {
        position: relative;
        flex-shrink: 0;
        width: 80px;
        height: 80px;
        border: 2px solid transparent;
        border-radius: var(--radius-sm);
        overflow: hidden;
        cursor: pointer;
        transition: all var(--transition-fast);
        background: var(--color-bg-primary);
      }
      .lightbox-thumbnail-item.active {
        border-color: var(--color-text-primary);
        box-shadow: 0 0 0 1px var(--color-text-primary);
      }
      .lightbox-thumbnail-item:hover {
        border-color: var(--color-border);
        transform: scale(1.05);
      }
      .lightbox-thumbnail-img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .lightbox-thumbnail-img[src*=".svg"] {
        background: #fff;
        object-fit: contain;
      }
      .lightbox-thumbnail-iframe-indicator {
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 32px;
        background: var(--section-bg);
        border: 1px solid var(--color-border);
      }
      /* =================================================================
         DROPDOWN COMPONENTS
         ================================================================= */
      .model-group {
        margin-bottom: 12px;
      }
      .group-header-container {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        background: var(--group-header-bg);
        border-radius: var(--radius-sm);
        margin-bottom: 6px;
        border-left: 2px solid var(--color-border);
      }
      .group-header-text {
        font-weight: var(--font-weight-normal);
        color: var(--color-text-secondary);
        font-size: var(--font-size-base);
        text-transform: none;
        letter-spacing: 0.08em;
        flex-grow: 1;
      }
      .reset-key-link {
        font-size: var(--font-size-base);
        color: var(--reset-link-color);
        text-decoration: none;
        margin-left: 12px;
        white-space: nowrap;
        cursor: pointer;
        transition: color var(--transition-fast);
        font-weight: var(--font-weight-normal);
      }
      .reset-key-link:hover {
        color: var(--reset-link-hover);
      }
      .model-item {
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
      .model-item:hover {
        background-color: var(--color-bg-hover);
        color: var(--color-text-primary);
        transform: translateX(2px);
      }

      /* =================================================================
         LOADING & STATUS INDICATORS
         ================================================================= */
      .glow {
        text-align: center;
        margin: 0;
        padding: 0;
        animation: glow 2.5s ease-in-out infinite;
        font-family: ${fontFamily};
        font-weight: 400;
        line-height: 1;
        transform: translateY(1em);
      }

      /* =================================================================
         ANIMATIONS
         ================================================================= */
      @keyframes glow {
        0%, 100% { color: #4a90e2; text-shadow: 0 0 10px rgba(74, 144, 226, 0.6), 0 0 20px rgba(74, 144, 226, 0.4); }
        33%      { color: #9b59b6; text-shadow: 0 0 12px rgba(155, 89, 182, 0.7), 0 0 25px rgba(155, 89, 182, 0.5); }
        66%      { color: #e74c3c; text-shadow: 0 0 12px rgba(231, 76, 60, 0.7), 0 0 25px rgba(231, 76, 60, 0.5); }
      }
      @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
      @keyframes fadeOut { from { opacity: 1; } to { opacity: 0; } }
      @keyframes slideInUp {
         from { transform: translateY(30px); opacity: 0; }
         to { transform: translateY(0); opacity: 1; }
      }


      /* =================================================================
         MOBILE RESPONSIVENESS
         ================================================================= */
      @media (max-width: 600px) {
         /* Custom Modal Mobile */
         .modal-content {
           max-width: 95%;
           border-radius: 12px;
         }

         .modal-message {
           padding: 24px 24px 20px 24px;
           font-size: 15px;
         }

         .modal-input {
           margin: 0 24px 20px 24px;
           width: calc(100% - 48px);
           padding: 12px 14px;
           font-size: 15px;
         }

         .modal-button {
           padding: 14px;
           font-size: 15px;
         }

         /* Error Notification Mobile */
         .error-notification {
           bottom: 20px;
           left: 16px;
           right: 16px;
           transform: translateX(0) translateY(20px);
           min-width: auto;
           max-width: none;
           padding: 14px 16px;
         }

         .error-notification.error-active {
           transform: translateX(0) translateY(0);
         }

         .error-message {
           font-size: 14px;
         }

         .error-close {
           width: 20px;
           height: 20px;
           font-size: 21px;
         }

         #${CONFIG.ids.content} {
            width: 100%; height: 100%;
            max-width: none; max-height: none;
            padding: 0 0 56px 0;
            box-shadow: none; animation: none;
            overflow-y: auto;
            border-radius: 0;
         }
         .summary-menubar {
            padding: 10px 16px;
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            z-index: 11;
         }
         .menubar-button {
            font-size: 14px;
            padding: 6px 10px;
         }
         .summary-content-body {
            padding: 20px 16px;
         }
         .question-section {
            padding: 20px 16px;
         }
         .question-header {
            font-size: 14px;
         }
         .question-input-wrapper {
            flex-direction: column;
            gap: 8px;
         }
         .question-input {
            font-size: 14px;
         }
         .ask-button {
            width: 100%;
            font-size: 14px;
         }
         .image-gallery {
            padding: 20px 16px;
            grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
            gap: 10px;
         }
         .gallery-item img {
            height: 140px;
         }
         #${CONFIG.ids.overlay} ~ #${CONFIG.ids.button},
         #${CONFIG.ids.overlay} ~ #${CONFIG.ids.dropdown} { display: none !important; }

         .lightbox-menubar {
            padding: 8px 12px;
            gap: 8px;
         }
         .lightbox-menubar .menubar-button {
            font-size: 14px;
            padding: 4px 6px;
         }
         .lightbox-counter {
            font-size: 14px;
            padding: 4px 8px;
         }
         .lightbox-content {
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
			mergeParams,
			extractSummaryFromResponse,
		};
	}
})();
