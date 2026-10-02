import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { Window } from "happy-dom";
import { beforeAll, describe, expect, it } from "vitest";

const USER_JS_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"Summarize with AI.user.js",
);

/**
 * Runs the userscript source in a sandbox with a fake `module`, so its guarded
 * `module.exports` block fires (skipping `initialize()`) instead of running as a browser script.
 * @type {{escapeHtml: Function, formatQAAnswer: Function, cleanSummaryHTML: Function, extractSummaryFromResponse: Function}}
 */
let helpers;

beforeAll(() => {
	const source = readFileSync(USER_JS_PATH, "utf-8");
	const window = new Window();
	const sandbox = {
		module: { exports: /** @type {any} */ ({}) },
		document: window.document,
		window,
		console,
	};
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename: USER_JS_PATH });
	helpers = sandbox.module.exports;
});

describe("escapeHtml", () => {
	it("escapes HTML special characters", () => {
		expect(helpers.escapeHtml("<b>&\"'</b>")).toBe("&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;");
	});

	it("leaves plain text untouched", () => {
		expect(helpers.escapeHtml("hello world")).toBe("hello world");
	});
});

describe("cleanSummaryHTML", () => {
	it("strips deprecated font attributes and rewrites font tags to span", () => {
		const input = '<font color="red" size="3">Hello</font>  World\n\nTest';
		expect(helpers.cleanSummaryHTML(input)).toBe("<span>Hello</span> World Test");
	});

	it("strips a markdown code fence some models wrap the response in", () => {
		const input = "```html\n<p><strong>Core Insight:</strong></p>\n<p>Summary text.</p>\n```";
		expect(helpers.cleanSummaryHTML(input)).toBe(
			"<p><strong>Core Insight:</strong></p> <p>Summary text.</p>",
		);
	});

	it("strips a bare code fence with no language tag", () => {
		const input = "```\n<p>Summary text.</p>\n```";
		expect(helpers.cleanSummaryHTML(input)).toBe("<p>Summary text.</p>");
	});

	// Prompt-injected AI output is untrusted HTML injected via innerHTML into the host
	// page, so these prove the allowlist sanitizer (not just the regex cleanup above)
	// actually blocks the standard XSS vectors rather than just cosmetic tag stripping.
	it("removes a <script> tag entirely, including its content", () => {
		const input = "<p>Summary</p><script>alert(1)</script>";
		expect(helpers.cleanSummaryHTML(input)).toBe("<p>Summary</p>");
	});

	it("strips an onerror handler (and the disallowed <img> tag carrying it)", () => {
		const input = '<p>Article summary</p><img src="x" onerror="alert(1)">';
		expect(helpers.cleanSummaryHTML(input)).toBe("<p>Article summary</p>");
	});

	it("strips a javascript: href but keeps the link text and a safe href intact", () => {
		const malicious = '<p>See <a href="javascript:alert(1)">this link</a> for details.</p>';
		expect(helpers.cleanSummaryHTML(malicious)).toBe("<p>See <a>this link</a> for details.</p>");

		const safe = '<p>See <a href="https://example.com">this link</a> for details.</p>';
		expect(helpers.cleanSummaryHTML(safe)).toBe(
			'<p>See <a href="https://example.com">this link</a> for details.</p>',
		);
	});
});

describe("formatQAAnswer", () => {
	it("turns a bracketed section header into a bold paragraph", () => {
		expect(helpers.formatQAAnswer("[From Article]\nThis is the answer.")).toBe(
			"<p><strong>From Article</strong></p>\n<p>This is the answer.</p>",
		);
	});

	it("wraps numbered lines in a single <ul>", () => {
		expect(helpers.formatQAAnswer("1. First item\n2. Second item")).toBe(
			"<ul>\n<li>First item</li>\n<li>Second item</li>\n</ul>",
		);
	});

	it("converts a bold label ending in a colon into its own header paragraph", () => {
		expect(helpers.formatQAAnswer("**Summary:**\nDetails here.")).toBe(
			"<p><strong>Summary:</strong></p>\n<p>Details here.</p>",
		);
	});

	it.each([
		["a blank line", "1. One\n\nAfter", "<p>After</p>"],
		["a section header", "1. One\n**Next:**\n\nText", "<p><strong>Next:</strong></p>\n<p>Text</p>"],
		["a line starting in bold", "1. One\n**Bold** start", "<strong>Bold</strong> start"],
		["a plain paragraph", "1. One\nPlain", "<p>Plain</p>"],
	])("closes an open list at %s", (_, input, rest) => {
		expect(helpers.formatQAAnswer(input)).toBe(`<ul>\n<li>One</li>\n</ul>\n${rest}`);
	});

	it("opens a list straight after a section header", () => {
		expect(helpers.formatQAAnswer("**Key:**\n1. Item")).toBe(
			"<p><strong>Key:</strong></p>\n<ul>\n<li>Item</li>\n</ul>",
		);
	});

	it("moves an inline bold label onto its own line", () => {
		expect(helpers.formatQAAnswer("Intro. **Key:** rest")).toBe(
			"<p>Intro.</p>\n<strong>Key:</strong> rest",
		);
	});

	it("escapes HTML in the model's answer", () => {
		expect(helpers.formatQAAnswer("Tom & <Jerry>")).toBe("<p>Tom &amp; &lt;Jerry&gt;</p>");
	});
});

describe("extractSummaryFromResponse", () => {
	it("extracts text from a Claude response, skipping a leading thinking block", () => {
		const result = helpers.extractSummaryFromResponse({
			status: 200,
			service: "claude",
			data: {
				content: [
					{ type: "thinking", text: "reasoning..." },
					{ type: "text", text: "Actual summary" },
				],
				stop_reason: "end_turn",
			},
		});
		expect(result).toEqual({
			rawSummary: "Actual summary",
			finishReason: "end_turn",
			blockType: "text",
		});
	});

	it("extracts text from a Gemini response, skipping a leading thought part", () => {
		const result = helpers.extractSummaryFromResponse({
			status: 200,
			service: "gemini",
			data: {
				candidates: [
					{
						content: { parts: [{ text: "reasoning...", thought: true }, { text: "Real answer" }] },
						finishReason: "STOP",
					},
				],
			},
		});
		expect(result).toEqual({ rawSummary: "Real answer", finishReason: "STOP", blockType: null });
	});

	it("falls back to a Gemini thought part when it is the only text", () => {
		const result = helpers.extractSummaryFromResponse({
			status: 200,
			service: "gemini",
			data: { candidates: [{ content: { parts: [{ text: "only thoughts", thought: true }] } }] },
		});
		expect(result).toEqual({
			rawSummary: "only thoughts",
			finishReason: null,
			blockType: "thought",
		});
	});

	it("reports an empty Gemini response by its status", () => {
		expect(() =>
			helpers.extractSummaryFromResponse({ status: 200, service: "gemini", data: {} }),
		).toThrow("API response did not contain a valid summary (status: 200).");
	});

	it("throws with status and error detail on a non-2xx response", () => {
		expect(() =>
			helpers.extractSummaryFromResponse({
				status: 500,
				statusText: "Internal Server Error",
				service: "claude",
				data: { error: { message: "Server exploded" } },
			}),
		).toThrow("API Error (500): Server exploded");
	});

	it("throws a diagnostic error when the response has no text and no error", () => {
		expect(() =>
			helpers.extractSummaryFromResponse({
				status: 200,
				service: "claude",
				data: { content: [] },
			}),
		).toThrow(/did not contain a valid summary/);
	});
});
