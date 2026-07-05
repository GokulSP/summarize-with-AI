import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { Window } from 'happy-dom';
import { beforeAll, describe, expect, it } from 'vitest';

const USER_JS_PATH = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	'Summarize with AI.user.js',
);

/**
 * Runs the userscript source in a sandbox with a fake `module`, so its guarded
 * `module.exports` block fires (skipping `initialize()`) instead of running as a browser script.
 * @type {{escapeHtml: Function, formatQAAnswer: Function, cleanSummaryHTML: Function, mergeParams: Function, extractSummaryFromResponse: Function}}
 */
let helpers;

beforeAll(() => {
	const source = readFileSync(USER_JS_PATH, 'utf-8');
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

describe('escapeHtml', () => {
	it('escapes HTML special characters', () => {
		expect(helpers.escapeHtml('<b>&"\'</b>')).toBe('&lt;b&gt;&amp;"\'&lt;/b&gt;');
	});

	it('leaves plain text untouched', () => {
		expect(helpers.escapeHtml('hello world')).toBe('hello world');
	});
});

describe('mergeParams', () => {
	it('lets model-specific params override service defaults', () => {
		expect(helpers.mergeParams({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual({ a: 1, b: 3, c: 4 });
	});
});

describe('cleanSummaryHTML', () => {
	it('strips deprecated font attributes and rewrites font tags to span', () => {
		const input = '<font color="red" size="3">Hello</font>  World\n\nTest';
		expect(helpers.cleanSummaryHTML(input)).toBe('<span>Hello</span> World Test');
	});
});

describe('formatQAAnswer', () => {
	it('turns a bracketed section header into a bold paragraph', () => {
		expect(helpers.formatQAAnswer('[From Article]\nThis is the answer.')).toBe(
			'<p><strong>From Article</strong></p>\n<p>This is the answer.</p>',
		);
	});

	it('wraps numbered lines in a single <ul>', () => {
		expect(helpers.formatQAAnswer('1. First item\n2. Second item')).toBe(
			'<ul>\n<li>First item</li>\n<li>Second item</li>\n</ul>',
		);
	});

	it('converts a bold label ending in a colon into its own header paragraph', () => {
		expect(helpers.formatQAAnswer('**Summary:**\nDetails here.')).toBe(
			'<p><strong>Summary:</strong></p>\n<p>Details here.</p>',
		);
	});
});

describe('extractSummaryFromResponse', () => {
	it('extracts text from a Claude response, skipping a leading thinking block', () => {
		const result = helpers.extractSummaryFromResponse({
			status: 200,
			service: 'claude',
			data: {
				content: [
					{ type: 'thinking', text: 'reasoning...' },
					{ type: 'text', text: 'Actual summary' },
				],
				stop_reason: 'end_turn',
			},
		});
		expect(result).toEqual({
			rawSummary: 'Actual summary',
			finishReason: 'end_turn',
			blockType: 'text',
		});
	});

	it('extracts text from a Gemini response, skipping a leading thought part', () => {
		const result = helpers.extractSummaryFromResponse({
			status: 200,
			service: 'gemini',
			data: {
				candidates: [
					{
						content: { parts: [{ text: 'reasoning...', thought: true }, { text: 'Real answer' }] },
						finishReason: 'STOP',
					},
				],
			},
		});
		expect(result).toEqual({ rawSummary: 'Real answer', finishReason: 'STOP', blockType: null });
	});

	it('throws with status and error detail on a non-2xx response', () => {
		expect(() =>
			helpers.extractSummaryFromResponse({
				status: 500,
				statusText: 'Internal Server Error',
				service: 'claude',
				data: { error: { message: 'Server exploded' } },
			}),
		).toThrow('API Error (500): Server exploded');
	});

	it('throws a diagnostic error when the response has no text and no error', () => {
		expect(() =>
			helpers.extractSummaryFromResponse({
				status: 200,
				service: 'claude',
				data: { content: [] },
			}),
		).toThrow(/did not contain a valid summary/);
	});
});
