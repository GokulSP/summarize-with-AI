import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Runs the real userscript the way a userscript manager does: in a page (happy-dom),
 * with no `module`, so `initialize()` fires and builds the UI. Only what the manager
 * and the @require CDN scripts provide is stood in for: GM.* (in-memory storage plus
 * scripted API responses) and Readability. Tests then click, type and press keys.
 */

const USER_JS_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"Summarize with AI.user.js",
);
const SOURCE = readFileSync(USER_JS_PATH, "utf-8");

const ARTICLE_TEXT =
	"Central banks raised rates by 50 basis points as inflation hit 6.2 percent. ".repeat(4);

/** @typedef {{ status?: number, response?: any, fail?: "error" | "timeout" | "abort", statusText?: string }} Reply */
/** @typedef {{ method: string, url: string, headers: Record<string, string>, data?: string }} SentRequest */

/** Default API behaviour: list two Sonnet models, answer every POST with a summary. */
/** @param {SentRequest} req @returns {Reply} */
const defaultResponder = req => {
	if (req.url.endsWith("/v1/models")) {
		return { response: { data: [{ id: "claude-sonnet-4-6" }, { id: "claude-sonnet-5-0" }] } };
	}
	if (req.url.includes("/v1beta/models?key=")) {
		return { response: { models: [] } };
	}
	if (req.url.includes(":generateContent")) {
		return { response: { candidates: [{ content: { parts: [{ text: "<p>Gemini said</p>" }] } }] } };
	}
	return { response: { content: [{ type: "text", text: "<p>Summary text.</p>" }] } };
};

/**
 * @param {{ storage?: Record<string, any>, body?: string, url?: string, responder?: (req: SentRequest) => Reply }} [options]
 */
async function loadPage(options = {}) {
	const window = new Window({ url: options.url ?? "https://www.economist.com/finance/rates" });
	const document = window.document;
	document.title = "Rates rise again";
	document.body.innerHTML =
		options.body ?? `<article><h1>Rates rise again</h1><p>${ARTICLE_TEXT}</p></article>`;

	const storage = new Map(Object.entries(options.storage ?? {}));
	/** @type {SentRequest[]} */
	const requests = [];
	/** @type {string[]} */
	const styles = [];
	let responder = options.responder ?? defaultResponder;

	const GM = {
		/** @param {string} key @param {any} [fallback] */
		getValue: async (key, fallback) => (storage.has(key) ? storage.get(key) : fallback),
		/** @param {string} key @param {any} value */
		setValue: async (key, value) => {
			storage.set(key, value);
		},
		/** @param {string} css */
		addStyle: css => {
			styles.push(css);
		},
		/** @param {any} details */
		xmlHttpRequest: details => {
			const req = {
				method: details.method,
				url: details.url,
				headers: details.headers,
				data: details.data,
			};
			requests.push(req);
			const reply = responder(req);
			globalThis.setTimeout(() => {
				if (reply.fail === "error") details.onerror({ statusText: reply.statusText ?? "" });
				else if (reply.fail === "timeout") details.ontimeout();
				else if (reply.fail === "abort") details.onabort?.();
				else {
					// A string reply is delivered as raw text, the way GM hands back a body it
					// didn't parse as JSON.
					const text = typeof reply.response === "string" ? reply.response : undefined;
					details.onload({
						status: reply.status ?? 200,
						response: reply.response,
						responseText: text,
						statusText: "",
					});
				}
			}, 0);
		},
	};

	class Readability {
		/** @param {any} doc */
		constructor(doc) {
			this.doc = doc;
		}
		parse() {
			const text = this.doc.body.textContent.trim();
			return text ? { title: this.doc.title, content: `<p>${text}</p>`, textContent: text } : null;
		}
	}

	const sandbox = {
		window,
		document,
		console: { ...console, info() {}, warn() {}, error() {} },
		GM,
		Readability,
		/** @param {any} doc */
		isProbablyReaderable: doc => doc.body.textContent.trim().length > 40,
		// Timer wrappers resolve globalThis at call time, so vi.useFakeTimers() reaches them.
		/** @param {() => void} fn @param {number} [ms] */
		setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
		/** @param {any} id */
		clearTimeout: id => globalThis.clearTimeout(id),
		/** @param {() => void} fn */
		requestAnimationFrame: fn => globalThis.setTimeout(fn, 0),
		// Reports every observed image as already in view, like a short page would.
		IntersectionObserver: class {
			/** @param {(entries: any[]) => void} callback */
			constructor(callback) {
				this.callback = callback;
			}
			/** @param {any} target */
			observe(target) {
				this.callback([{ isIntersecting: true, target }]);
			}
			unobserve() {}
			disconnect() {}
		},
		HTMLElement: window.HTMLElement,
	};
	vm.createContext(sandbox);
	vm.runInContext(SOURCE, sandbox, { filename: USER_JS_PATH });
	await settle();

	return {
		window,
		document,
		storage,
		requests,
		styles,
		/** @param {(req: SentRequest) => Reply} fn */
		respondWith(fn) {
			responder = fn;
		},
		/** @param {string} id */
		byId: id => /** @type {any} */ (document.getElementById(id)),
		/** @param {string} selector */
		$: selector => /** @type {any} */ (document.querySelector(selector)),
		/** @param {string} selector */
		$$: selector => /** @type {any[]} */ (Array.from(document.querySelectorAll(selector))),
	};
}

/** Lets pending GM replies, promise chains and short UI timers run. */
async function settle(ms = 50) {
	await new Promise(resolve => setTimeout(resolve, ms));
}

/** @param {any} window @param {any} target @param {string} type @param {Record<string, any>} [init] */
function fire(window, target, type, init = {}) {
	const Ctor = type.startsWith("key")
		? window.KeyboardEvent
		: type === "wheel"
			? window.WheelEvent
			: window.MouseEvent;
	const event = new Ctor(type, { bubbles: true, cancelable: true, ...init });
	target.dispatchEvent(event);
	return event;
}

/** happy-dom's TouchEvent ignores touch lists, so attach them directly. @param {any} window @param {any} target @param {string} type @param {{ touches?: any[], changedTouches?: any[] }} lists */
function touch(window, target, type, lists) {
	const event = new window.Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, "touches", { value: lists.touches ?? [] });
	Object.defineProperty(event, "changedTouches", { value: lists.changedTouches ?? [] });
	target.dispatchEvent(event);
}

/** Long-press the S button (holds past the 500ms threshold) to open the model menu. @param {Awaited<ReturnType<typeof loadPage>>} page */
async function openModelMenu(page) {
	const button = page.byId("sai-summarize-button");
	fire(page.window, button, "mousedown");
	await settle(560);
	fire(page.window, button, "mouseup");
	fire(page.window, button, "click");
}

/** @param {Awaited<ReturnType<typeof loadPage>>} page */
const posts = page => page.requests.filter(r => r.method === "POST");

const KEYED = { claude_api_key: "sk-test" };

afterEach(() => {
	vi.useRealTimers();
});

describe("page load", () => {
	it("adds the S button and styles on a readable article", async () => {
		const page = await loadPage();

		expect(page.byId("sai-summarize-button").textContent).toBe("S");
		expect(page.byId("sai-model-dropdown").style.display).toBe("none");
		expect(page.styles).toHaveLength(1);
		expect(page.$('meta[name="viewport"]')).not.toBeNull();
	});

	it("stays out of the way on a page with no article", async () => {
		const page = await loadPage({ body: "<nav>Home</nav>" });

		expect(page.byId("sai-summarize-button")).toBeNull();
	});
});

describe("summarizing with Claude", () => {
	it("asks for an API key when none is stored", async () => {
		const page = await loadPage();

		page.byId("sai-summarize-button").click();
		await settle();

		expect(page.$(".sai-error-message").innerText).toBe(
			"Claude API key is required. To add one, long-press the S button and select Reset Key.",
		);
		expect(page.byId("sai-summarize-button").style.display).toBe("flex");
		expect(page.requests).toEqual([]);
	});

	it("auto-discovers the newest Sonnet, then shows a sanitised summary", async () => {
		const page = await loadPage({ storage: KEYED });
		page.respondWith(req =>
			req.method === "GET"
				? defaultResponder(req)
				: {
						response: {
							content: [
								{ type: "thinking", thinking: "..." },
								{
									type: "text",
									text: '```html\n<p onclick="x()">Core <font color="red">point</font></p><script>steal()</script><a href="javascript:x">bad</a>\n```',
								},
							],
						},
					},
		);

		page.byId("sai-summarize-button").click();
		await settle(100);

		const [post] = posts(page);
		expect(post.url).toBe("https://api.anthropic.com/v1/messages");
		expect(post.headers["x-api-key"]).toBe("sk-test");
		const body = JSON.parse(/** @type {string} */ (post.data));
		expect(body.model).toBe("claude-sonnet-5-0");
		expect(body.messages[0].content).toContain("<title>Rates rise again</title>");
		expect(page.storage.get("last_used_model")).toBe("claude-sonnet-5-0");

		const summary = page.$(".sai-summary-content-body").innerHTML;
		expect(summary).toBe("<p>Core <span>point</span></p><a>bad</a>");
		expect(page.byId("sai-summarize-question-input")).not.toBeNull();
		expect(page.byId("sai-summarize-button").style.display).toBe("none");
	});

	it("reuses the cached model list and summary on the next click", async () => {
		const page = await loadPage({ storage: KEYED });
		page.byId("sai-summarize-button").click();
		await settle();
		page.byId("sai-summarize-close").click();
		expect(page.byId("sai-summarize-overlay")).toBeNull();
		expect(page.byId("sai-summarize-button").style.display).toBe("flex");

		page.byId("sai-summarize-button").click();
		await settle();

		expect(page.requests.filter(r => r.method === "GET")).toHaveLength(1);
		expect(posts(page)).toHaveLength(1);
		expect(page.$(".sai-summary-content-body").textContent).toBe("Summary text.");
	});

	it("shows an API error with a working Try Again button", async () => {
		const page = await loadPage({ storage: KEYED });
		page.respondWith(req =>
			req.method === "GET"
				? { status: 500, response: {} }
				: { status: 400, response: { error: { message: "invalid x-api-key" } } },
		);

		page.byId("sai-summarize-button").click();
		await settle();

		const content = page.byId("sai-summarize-content");
		expect(content.textContent).toContain(
			"Error: [claude-sonnet-4-6] API Error (400): invalid x-api-key",
		);
		page.respondWith(defaultResponder);
		page.byId("sai-summarize-retry-button").click();
		await settle();
		expect(page.$(".sai-summary-content-body").textContent).toBe("Summary text.");
	});

	it.each([
		["error", "Network error: Failed to connect"],
		["timeout", "Request timed out after 60 seconds"],
		["abort", "Request aborted"],
	])("reports a %s from the request", async (fail, message) => {
		const page = await loadPage({
			storage: {
				...KEYED,
				latest_sonnet_cache: { modelId: "claude-sonnet-4-6", timestamp: Date.now() },
			},
		});
		page.respondWith(() => ({ fail: /** @type {any} */ (fail) }));

		page.byId("sai-summarize-button").click();
		await settle();

		expect(page.byId("sai-summarize-content").textContent).toContain(message);
	});

	it("explains an empty response instead of showing nothing", async () => {
		const page = await loadPage({ storage: KEYED });
		page.respondWith(req =>
			req.method === "GET"
				? defaultResponder(req)
				: { response: { content: [], stop_reason: "max_tokens" } },
		);

		page.byId("sai-summarize-button").click();
		await settle();

		expect(page.byId("sai-summarize-content").textContent).toContain(
			"did not contain a valid summary (stop reason: max_tokens, status: 200)",
		);
	});

	it("retries once after a 503 overload", async () => {
		const page = await loadPage({ storage: KEYED });
		let attempts = 0;
		page.respondWith(req => {
			if (req.method === "GET") return defaultResponder(req);
			attempts++;
			return attempts === 1 ? { status: 503, response: {} } : defaultResponder(req);
		});
		vi.useFakeTimers();

		page.byId("sai-summarize-button").click();
		await vi.advanceTimersByTimeAsync(3500);

		expect(attempts).toBe(2);
		expect(page.$(".sai-summary-content-body").textContent).toBe("Summary text.");
	});

	it("refuses an article over the length limit", async () => {
		const page = await loadPage({ storage: KEYED });
		page.$("article p").textContent = "x".repeat(100_001);

		page.byId("sai-summarize-button").click();
		await settle();

		expect(page.byId("sai-summarize-content").textContent).toMatch(
			/Article is too long to summarize \(100,0\d\d characters, limit is 100,000\)/,
		);
	});

	it("tells the user when the content can no longer be extracted", async () => {
		const page = await loadPage({ storage: KEYED });
		const scriptState = page.byId("sai-summarize-button");
		page.document.body.innerHTML = "";
		page.document.body.appendChild(scriptState);

		scriptState.click();
		await settle();

		// The load-time snapshot is still used, so summarising goes ahead.
		expect(posts(page)).toHaveLength(1);
	});

	it("recovers from a stale stored model and rejects an unknown one", async () => {
		const stale = await loadPage({ storage: { ...KEYED, last_used_model: "claude-sonnet-3-0" } });
		stale.byId("sai-summarize-button").click();
		await settle();
		expect(JSON.parse(/** @type {string} */ (posts(stale)[0].data)).model).toBe(
			"claude-sonnet-5-0",
		);

		const unknown = await loadPage({ storage: { ...KEYED, last_used_model: "gpt-9" } });
		unknown.byId("sai-summarize-button").click();
		await settle();
		expect(unknown.$(".sai-error-message").innerText).toBe(
			'Model "gpt-9" is not available. Please select another model.',
		);
	});
});

describe("summarizing with Gemini", () => {
	it("is chosen from the model menu and sends the key in the URL", async () => {
		const page = await loadPage({ storage: { gemini_api_key: " g-key " } });
		page.respondWith(req =>
			req.url.includes("?key=") && req.method === "GET"
				? {
						response: {
							models: [
								{
									name: "models/gemini-4.0-flash",
									supportedGenerationMethods: ["generateContent"],
								},
								{
									name: "models/gemini-9-flash-live",
									supportedGenerationMethods: ["generateContent"],
								},
								{ name: "models/gemini-1.0-pro", supportedGenerationMethods: ["generateContent"] },
							],
						},
					}
				: {
						response: {
							candidates: [
								{
									content: {
										parts: [{ text: "thinking", thought: true }, { text: "<p>Flash says</p>" }],
									},
									finishReason: "MAX_TOKENS",
								},
							],
						},
					},
		);

		await openModelMenu(page);
		expect(page.byId("sai-model-dropdown").style.display).toBe("block");
		page.$('[data-model-id="gemini-3.5-flash"]').click();
		await settle();

		expect(posts(page)[0].url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-4.0-flash:generateContent?key=g-key",
		);
		expect(page.storage.get("last_used_model")).toBe("gemini-4.0-flash");
		expect(page.$(".sai-summary-content-body").textContent).toBe("Flash says");
	});

	it("falls back to the stable model when the discovered one needs the Interactions API", async () => {
		const page = await loadPage({
			storage: {
				gemini_api_key: "g-key",
				last_used_model: "gemini-3.5-flash",
				latest_gemini_cache: { modelId: "gemini-5-flash", timestamp: Date.now() },
			},
		});
		page.respondWith(req =>
			req.url.includes("gemini-5-flash")
				? { status: 400, response: { error: { message: "Use the Interactions API" } } }
				: defaultResponder(req),
		);

		page.byId("sai-summarize-button").click();
		await settle();

		expect(posts(page).map(r => r.url.split("/").pop()?.split(":")[0])).toEqual([
			"gemini-5-flash",
			"gemini-3.5-flash",
		]);
		expect(page.storage.get("latest_gemini_cache")).toBeNull();
		expect(page.$(".sai-summary-content-body").textContent).toBe("Gemini said");
	});
});

describe("asking a question", () => {
	/** @param {Awaited<ReturnType<typeof loadPage>>} page @param {string} question */
	async function ask(page, question) {
		const input = page.byId("sai-summarize-question-input");
		input.value = question;
		fire(page.window, input, "keypress", { key: "Enter" });
		await settle();
	}

	it("answers with formatted text about the article", async () => {
		const page = await loadPage({ storage: KEYED });
		page.byId("sai-summarize-button").click();
		await settle();
		page.respondWith(req =>
			req.method === "GET"
				? defaultResponder(req)
				: {
						response: { content: [{ type: "text", text: "Rates went up.\n1. First\n2. Second" }] },
					},
		);

		await ask(page, "Why <now>?");

		const lastPost = JSON.parse(/** @type {string} */ (posts(page).at(-1)?.data));
		expect(lastPost.max_tokens).toBe(800);
		expect(lastPost.messages[0].content).toContain("Question: Why <now>?");
		const answer = page.$(".sai-answer").innerHTML;
		expect(answer).toContain("<strong>Q:</strong> Why &lt;now&gt;?");
		expect(answer).toContain("<ul>\n<li>First</li>\n<li>Second</li>\n</ul>");
		expect(page.byId("sai-summarize-question-input").value).toBe("");
		expect(page.byId("sai-summarize-ask-button").textContent).toBe("Ask");
	});

	it("needs a question, and shows request failures inline", async () => {
		const page = await loadPage({ storage: KEYED });
		page.byId("sai-summarize-button").click();
		await settle();

		page.byId("sai-summarize-ask-button").click();
		await settle();
		expect(page.$(".sai-error-message").innerText).toBe("Please enter a question.");

		page.respondWith(() => ({ status: 429, response: { message: "rate limited" } }));
		await ask(page, "What next?");
		expect(page.byId("sai-answer-container").textContent).toContain(
			"Error: [claude-sonnet-5-0] API Error (429): rate limited",
		);
	});
});

describe("API key management", () => {
	it("saves, clears, or leaves the key from the Reset Key prompt", async () => {
		const page = await loadPage();
		await openModelMenu(page);
		const resetClaude = () => page.$(".sai-reset-key-link").click();

		resetClaude();
		await settle(150);
		const input = page.byId("sai-custom-modal-input");
		expect(page.byId("sai-custom-modal-message").textContent).toBe("Enter your Claude API key:");
		input.value = "  sk-new  ";
		fire(page.window, input, "keydown", { key: "Enter" });
		await settle(260);
		expect(page.storage.get("claude_api_key")).toBe("sk-new");
		expect(page.byId("sai-custom-modal-message").textContent).toBe(
			"Claude API key updated successfully.",
		);
		page.$(".sai-modal-button-primary").click();
		await settle(260);
		expect(page.byId("sai-custom-modal-overlay")).toBeNull();

		resetClaude();
		await settle(150);
		page.$(".sai-modal-button-primary").click();
		await settle(260);
		expect(page.storage.get("claude_api_key")).toBe("");
		expect(page.byId("sai-custom-modal-message").textContent).toBe(
			"Claude API key has been cleared.",
		);
		fire(page.window, page.document, "keydown", { key: "Escape" });
		await settle(260);

		resetClaude();
		await settle(150);
		fire(page.window, page.byId("sai-custom-modal-input"), "keydown", { key: "Escape" });
		await settle(260);
		expect(page.byId("sai-custom-modal-overlay")).toBeNull();
		expect(page.storage.get("claude_api_key")).toBe("");
	});
});

describe("keyboard and pointer shortcuts", () => {
	it("Alt+S summarizes and Escape closes the overlay", async () => {
		const page = await loadPage({ storage: KEYED });

		fire(page.window, page.document, "keydown", { code: "KeyS", key: "s", altKey: true });
		await settle();
		expect(page.byId("sai-summarize-overlay")).not.toBeNull();

		fire(page.window, page.document, "keydown", { key: "Escape" });
		expect(page.byId("sai-summarize-overlay")).toBeNull();
	});

	it("closes the overlay when its backdrop is clicked", async () => {
		const page = await loadPage({ storage: KEYED });
		page.byId("sai-summarize-button").click();
		await settle();

		page.byId("sai-summarize-overlay").click();

		expect(page.byId("sai-summarize-overlay")).toBeNull();
	});

	it("hides the model menu on Escape, an outside click, or a second long press", async () => {
		const page = await loadPage();
		const menu = page.byId("sai-model-dropdown");

		await openModelMenu(page);
		fire(page.window, page.document, "keydown", { key: "Escape" });
		expect(menu.style.display).toBe("none");

		await openModelMenu(page);
		page.$("article").click();
		expect(menu.style.display).toBe("none");

		await openModelMenu(page);
		await openModelMenu(page);
		expect(menu.style.display).toBe("none");
	});

	it("hides the button while typing in a page input and restores it after", async () => {
		const page = await loadPage({
			body: `<article><p>${ARTICLE_TEXT}</p><input id="q"></article>`,
		});
		const input = page.byId("q");
		const button = page.byId("sai-summarize-button");

		input.dispatchEvent(new page.window.FocusEvent("focusin", { bubbles: true }));
		expect(button.style.display).toBe("none");
		fire(page.window, page.document, "keydown", { code: "KeyS", altKey: true });

		input.dispatchEvent(new page.window.FocusEvent("focusout", { bubbles: true }));
		await settle(80);
		expect(button.style.display).toBe("flex");
	});

	it("dismisses an error notification from its close button", async () => {
		const page = await loadPage({ storage: { ...KEYED, last_used_model: "gpt-9" } });
		page.byId("sai-summarize-button").click();
		await settle();

		page.$(".sai-error-close").click();

		expect(page.byId("sai-summarize-error")).toBeNull();
	});
});

describe("image gallery and lightbox", () => {
	const GALLERY_PAGE = `<article><p>${ARTICLE_TEXT}</p>
		<iframe src="https://flo.uri.sh/visualisation/1/embed" title="Rates chart"></iframe>
		<img src="https://www.economist.com/cdn-cgi/image/width=360/content-assets/images/WBC1.png" alt="Chart one">
		<img src="https://www.economist.com/cdn-cgi/image/width=1424/content-assets/images/big.jpg" alt="Hero">
		<img src="https://www.economist.com/cdn-cgi/image/width=1600/content-assets/images/big2.jpg" alt="Second hero">
		<img src="https://www.economist.com/cdn-cgi/image/width=800/x_DE_y.jpg" alt="Header">
		<div class="teaser_mb-teaser__x"><img src="https://www.economist.com/cdn-cgi/image/width=900/content-assets/images/teaser.jpg"></div>
		<img src="data:image/png;base64,AAAA">
		<img src="https://www.economist.com/tiny.png">
	</article>`;

	async function openGallery() {
		const page = await loadPage({ storage: KEYED, body: GALLERY_PAGE });
		page.byId("sai-summarize-button").click();
		await settle(700);
		return page;
	}

	it("collects charts and article images, skipping promos, headers and tiny images", async () => {
		const page = await openGallery();

		const items = page.$$(".sai-gallery-item");
		expect(items).toHaveLength(3);
		expect(items[0].classList.contains("sai-gallery-item-iframe")).toBe(true);
		expect(items.slice(1).map(item => item.querySelector("img").alt)).toEqual([
			"Chart one",
			"Hero",
		]);
	});

	it("browses images with buttons, keys, thumbnails and swipes", async () => {
		const page = await openGallery();
		page.$('[data-image-index="1"] img').click();

		const counter = page.$(".sai-lightbox-counter");
		const image = page.$(".sai-lightbox-image");
		expect(counter.textContent).toBe("2 / 3");
		expect(image.alt).toBe("Chart one");

		page.$(".sai-lightbox-next").click();
		expect(counter.textContent).toBe("3 / 3");
		expect(page.$(".sai-lightbox-next").disabled).toBe(true);

		fire(page.window, page.document, "keydown", { key: "ArrowLeft" });
		fire(page.window, page.document, "keydown", { key: "ArrowLeft" });
		expect(counter.textContent).toBe("1 / 3");
		expect(page.$(".sai-lightbox-iframe").style.display).toBe("block");
		fire(page.window, page.document, "keydown", { key: "ArrowRight" });
		expect(counter.textContent).toBe("2 / 3");

		page.$$(".sai-lightbox-thumbnail-img")[1].click();
		expect(counter.textContent).toBe("3 / 3");
		page.$(".sai-lightbox-thumbnail-iframe-indicator").click();
		expect(counter.textContent).toBe("1 / 3");

		const content = page.$(".sai-lightbox-content");
		const at = (/** @type {number} */ x) => ({ screenX: x, screenY: 0, clientX: x, clientY: 0 });
		touch(page.window, content, "touchstart", { touches: [at(300)] });
		touch(page.window, content, "touchend", { changedTouches: [at(100)] });
		expect(counter.textContent).toBe("2 / 3");
		touch(page.window, content, "touchstart", { touches: [at(100)] });
		touch(page.window, content, "touchend", { changedTouches: [at(300)] });
		expect(counter.textContent).toBe("1 / 3");

		fire(page.window, page.document, "keydown", { key: "Escape" });
		expect(page.$(".sai-lightbox-overlay")).toBeNull();
	});

	it("zooms and pans with wheel, drag, double-click, pinch and double-tap", async () => {
		const page = await openGallery();
		page.$('[data-image-index="2"] img').click();
		const image = page.$(".sai-lightbox-image");
		const content = page.$(".sai-lightbox-content");

		fire(page.window, image, "wheel", { deltaY: -100 });
		expect(image.style.transform).toBe("translate(0px, 0px) scale(1.25)");
		fire(page.window, image, "mousedown", { clientX: 10, clientY: 10 });
		fire(page.window, page.window, "mousemove", { clientX: 30, clientY: 40 });
		fire(page.window, page.window, "mouseup");
		expect(image.style.transform).toBe("translate(20px, 30px) scale(1.25)");
		fire(page.window, image, "wheel", { deltaY: 100 });
		expect(image.style.transform).toBe("translate(0px, 0px) scale(1)");
		fire(page.window, image, "mousedown", { clientX: 10, clientY: 10 }); // no pan at 1x

		fire(page.window, image, "dblclick");
		expect(image.style.transform).toBe("translate(0px, 0px) scale(2.5)");
		const finger = (/** @type {number} */ x) => ({
			screenX: x,
			screenY: 0,
			clientX: x,
			clientY: 0,
		});
		touch(page.window, content, "touchstart", { touches: [finger(0)] });
		touch(page.window, content, "touchmove", { touches: [finger(15)] });
		touch(page.window, content, "touchend", { changedTouches: [finger(15)] });
		expect(image.style.transform).toBe("translate(15px, 0px) scale(2.5)");
		fire(page.window, image, "dblclick");
		expect(image.style.cursor).toBe("zoom-in");

		touch(page.window, content, "touchstart", { touches: [finger(0), finger(100)] });
		touch(page.window, content, "touchmove", { touches: [finger(0), finger(200)] });
		touch(page.window, content, "touchend", { touches: [], changedTouches: [finger(200)] });
		expect(image.style.transform).toBe("translate(0px, 0px) scale(2)");

		touch(page.window, content, "touchstart", { touches: [finger(50)] });
		touch(page.window, content, "touchend", { changedTouches: [finger(50)] });
		touch(page.window, content, "touchstart", { touches: [finger(50)] });
		touch(page.window, content, "touchend", { changedTouches: [finger(50)] });
		expect(image.style.transform).toBe("translate(0px, 0px) scale(1)");

		page.$(".sai-lightbox-overlay").click();
		expect(page.$(".sai-lightbox-overlay")).toBeNull();
		page.$('[data-image-index="0"]').click();
		page.$(".sai-lightbox-prev").click();
		page.$$(".sai-lightbox-menubar .sai-menubar-button").at(-1).click();
		expect(page.$(".sai-lightbox-overlay")).toBeNull();
	});
});

/** Gives happy-dom images the decoded size a browser would report. @param {any} img @param {number} width @param {number} height */
function sized(img, width, height) {
	Object.defineProperty(img, "naturalWidth", { value: width });
	Object.defineProperty(img, "naturalHeight", { value: height });
}

describe("site-specific image filtering", () => {
	it("skips HBR's promo, podcast and fixed-size teaser images", async () => {
		const page = await loadPage({
			url: "https://hbr.org/2026/09/pricing",
			storage: KEYED,
			body: `<article><p>${ARTICLE_TEXT}</p>
				<img id="shop" src="https://cdn11.bigcommerce.com/book.jpg">
				<img id="podcast" src="https://hbr.org/resources/images/podcasts/episode-ideacast.png">
				<img id="cover" src="https://hbr.org/cover.jpg">
				<img id="promo" src="https://hbr.org/promo.jpg">
				<img id="figure" src="https://hbr.org/figure.jpg">
			</article>`,
		});
		for (const id of ["shop", "podcast", "figure"]) sized(page.byId(id), 1200, 800);
		sized(page.byId("cover"), 500, 750);
		sized(page.byId("promo"), 383, 215);

		page.byId("sai-summarize-button").click();
		await settle();

		const images = page.$$(".sai-gallery-item img");
		expect(images.map(img => img.getAttribute("src"))).toEqual(["https://hbr.org/figure.jpg"]);
		expect(images[0].alt).toBe("Article image");
	});

	it("keeps McKinsey's vector exhibits but skips people photos and thumbnails", async () => {
		const page = await loadPage({
			url: "https://www.mckinsey.com/insights/ai",
			storage: KEYED,
			body: `<article><p>${ARTICLE_TEXT}</p>
				<img src="https://www.mckinsey.com/our%20people/jane.jpg">
				<img src="https://www.mckinsey.com/exhibit-thumb.png">
				<img src="https://www.mckinsey.com/headshot-2.png">
				<img src="https://www.mckinsey.com/exhibit-1.svgz" alt="Exhibit 1">
				<img src="https://www.mckinsey.com/exhibit-2.svg" alt="Exhibit 2">
			</article>`,
		});
		for (const img of page.$$("article img").slice(0, 3)) sized(img, 1200, 800);

		page.byId("sai-summarize-button").click();
		await settle();

		expect(page.$$(".sai-gallery-item img").map(img => img.alt)).toEqual([
			"Exhibit 1",
			"Exhibit 2",
		]);
	});

	it("waits for lazy images and reads deferred sources", async () => {
		const page = await loadPage({
			url: "https://example.com/post",
			storage: KEYED,
			body: `<main><p>${ARTICLE_TEXT}</p>
				<iframe data-src="https://datawrapper.dwcdn.net/abc/1/"></iframe>
				<iframe src="https://datawrapper.dwcdn.net/abc/1/"></iframe>
				<iframe src="https://www.youtube.com/embed/x"></iframe>
				<img loading="lazy" data-src="https://example.com/lazy.jpg">
			</main>`,
		});
		sized(page.$("img"), 1000, 600);

		page.byId("sai-summarize-button").click();
		await settle(250);

		const items = page.$$(".sai-gallery-item");
		expect(items).toHaveLength(2);
		expect(items[0].classList.contains("sai-gallery-item-iframe")).toBe(true);
		expect(items[1].querySelector("img").getAttribute("src")).toBe("https://example.com/lazy.jpg");
	});
});

describe("less common API responses", () => {
	it("accepts responses delivered as raw JSON text", async () => {
		const page = await loadPage({ storage: KEYED });
		page.respondWith(req =>
			req.method === "GET"
				? { response: JSON.stringify({ data: [{ id: "claude-sonnet-6-1" }] }) }
				: { response: JSON.stringify({ content: [{ type: "text", text: "<p>From text</p>" }] }) },
		);

		page.byId("sai-summarize-button").click();
		await settle();

		expect(JSON.parse(/** @type {string} */ (posts(page)[0].data)).model).toBe("claude-sonnet-6-1");
		expect(page.$(".sai-summary-content-body").textContent).toBe("From text");
	});

	it("keeps the default model when the models API answers with an error status", async () => {
		const page = await loadPage({ storage: KEYED });
		page.respondWith(req =>
			req.method === "GET"
				? { status: 500, response: { data: [{ id: "claude-sonnet-9-9" }] } }
				: defaultResponder(req),
		);

		page.byId("sai-summarize-button").click();
		await settle();

		expect(JSON.parse(/** @type {string} */ (posts(page)[0].data)).model).toBe("claude-sonnet-4-6");
	});

	it("shows an error instead of hanging when the API body is not JSON", async () => {
		const page = await loadPage({ storage: KEYED });
		page.respondWith(req =>
			req.method === "GET" ? defaultResponder(req) : { status: 502, response: "<html>Bad gateway" },
		);

		page.byId("sai-summarize-button").click();
		await settle();

		expect(page.byId("sai-summarize-content").textContent).toContain("JSON");
	});

	it("keeps the default model when model discovery fails or finds nothing", async () => {
		const claude = await loadPage({ storage: KEYED });
		claude.respondWith(req => (req.method === "GET" ? { fail: "error" } : defaultResponder(req)));
		claude.byId("sai-summarize-button").click();
		await settle();
		expect(JSON.parse(/** @type {string} */ (posts(claude)[0].data)).model).toBe(
			"claude-sonnet-4-6",
		);

		const gemini = await loadPage({
			storage: { gemini_api_key: "g", last_used_model: "gemini-3.5-flash" },
		});
		gemini.byId("sai-summarize-button").click();
		await settle();
		expect(posts(gemini)[0].url).toContain("/gemini-3.5-flash:generateContent");
	});

	it("names the block type, or falls back to a generic message, when there is no text", async () => {
		const page = await loadPage({ storage: KEYED });
		page.respondWith(req =>
			req.method === "GET"
				? defaultResponder(req)
				: { response: { content: [{ type: "thinking" }] } },
		);
		page.byId("sai-summarize-button").click();
		await settle();
		expect(page.byId("sai-summarize-content").textContent).toContain(
			"(block type: thinking, status: 200)",
		);

		page.respondWith(() => ({ status: 502, response: {} }));
		page.byId("sai-summarize-retry-button").click();
		await settle();
		expect(page.byId("sai-summarize-content").textContent).toContain(
			"API Error (502): Unknown API error",
		);
	});

	it("tells the user in the open overlay when the key disappears mid-session", async () => {
		const page = await loadPage({ storage: KEYED });
		page.byId("sai-summarize-button").click();
		await settle();
		page.storage.delete("claude_api_key");

		const input = page.byId("sai-summarize-question-input");
		input.value = "Anything?";
		page.byId("sai-summarize-ask-button").click();
		await settle();

		expect(page.$(".sai-summary-content-body").textContent).toContain("Claude API key is required");
	});
});

describe("answer formatting", () => {
	it("turns headers, notes, lists and paragraphs into tidy HTML", async () => {
		const page = await loadPage({ storage: KEYED });
		page.byId("sai-summarize-button").click();
		await settle();
		const reply = [
			"[Short answer]",
			"Rates rose. **Why it matters:**",
			"",
			"1. Borrowing costs",
			"2. Savings",
			"",
			"**Bottom line:**",
			"",
			"",
			"",
			"Expect more hikes.",
			"1. Watch inflation",
			"**Note** this is a paragraph",
		].join("\n");
		page.respondWith(req =>
			req.method === "GET"
				? defaultResponder(req)
				: { response: { content: [{ type: "text", text: reply }] } },
		);

		const input = page.byId("sai-summarize-question-input");
		input.value = "What happened?";
		fire(page.window, input, "keypress", { key: "Enter" });
		await settle();

		expect(page.$(".sai-answer-content").innerHTML).toBe(
			[
				"<p><strong>Short answer</strong></p>",
				"<p>Rates rose.</p>",
				"<p><strong>Why it matters:</strong></p>",
				"<ul>",
				"<li>Borrowing costs</li>",
				"<li>Savings</li>",
				"</ul>",
				"<p><strong>Bottom line:</strong></p>",
				"<p>Expect more hikes.</p>",
				"<ul>",
				"<li>Watch inflation</li>",
				"</ul>",
				"<strong>Note</strong> this is a paragraph",
			].join("\n"),
		);
	});
});

describe("smaller interactions", () => {
	it("closes an alert by clicking its backdrop", async () => {
		const page = await loadPage();
		await openModelMenu(page);
		page.$(".sai-reset-key-link").click();
		await settle(150);
		page.$(".sai-modal-button-primary").click();
		await settle(260);

		page.byId("sai-custom-modal-overlay").click();
		await settle(260);

		expect(page.byId("sai-custom-modal-overlay")).toBeNull();
	});

	it("ignores focus moving between non-input elements", async () => {
		const page = await loadPage();

		page.$("article").dispatchEvent(new page.window.FocusEvent("focusin", { bubbles: true }));

		expect(page.byId("sai-summarize-button").style.display).toBe("");
	});
});

describe("edge cases found while testing", () => {
	it("keeps the model menu open while the API-key prompt has focus", async () => {
		const page = await loadPage();
		await openModelMenu(page);
		page.$(".sai-reset-key-link").click();
		await settle(150);

		page
			.byId("sai-custom-modal-input")
			.dispatchEvent(new page.window.FocusEvent("focusin", { bubbles: true }));

		// Regression: the focus handler looked for a stale ".custom-modal-overlay" class, so
		// typing a key hid the S button and the menu it was opened from.
		expect(page.byId("sai-summarize-button").style.display).not.toBe("none");
		expect(page.byId("sai-model-dropdown").style.display).toBe("block");
	});

	it("drops HTML comments from a summary along with the unsafe markup", async () => {
		const page = await loadPage({ storage: KEYED });
		page.respondWith(req =>
			req.method === "GET"
				? defaultResponder(req)
				: { response: { content: [{ type: "text", text: "<p>Kept<!-- hidden note --></p>" }] } },
		);

		page.byId("sai-summarize-button").click();
		await settle();

		expect(page.$(".sai-summary-content-body").innerHTML).toBe("<p>Kept</p>");
	});

	it("treats an empty body as an empty response, and shows a network error's status", async () => {
		const page = await loadPage({ storage: KEYED });
		page.respondWith(req => (req.method === "GET" ? defaultResponder(req) : { response: "" }));
		page.byId("sai-summarize-button").click();
		await settle();
		expect(page.byId("sai-summarize-content").textContent).toContain(
			"did not contain a valid summary (status: 200)",
		);

		page.respondWith(() => ({ fail: "error", statusText: "Bad Gateway" }));
		page.byId("sai-summarize-retry-button").click();
		await settle();
		expect(page.byId("sai-summarize-content").textContent).toContain("Network error: Bad Gateway");
	});

	it("keeps a bracketed header in its own paragraph", async () => {
		const page = await loadPage({ storage: KEYED });
		page.byId("sai-summarize-button").click();
		await settle();
		page.respondWith(req =>
			req.method === "GET"
				? defaultResponder(req)
				: { response: { content: [{ type: "text", text: "[Key facts:]\n\nRates are up." }] } },
		);

		const input = page.byId("sai-summarize-question-input");
		input.value = "Facts?";
		fire(page.window, input, "keypress", { key: "Enter" });
		await settle();

		expect(page.$(".sai-answer-content").innerHTML).toBe(
			"<p><strong>Key facts:</strong></p>\n<p>Rates are up.</p>",
		);
	});
});
