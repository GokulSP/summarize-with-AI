// Ambient globals injected by the @require CDN scripts in the userscript header
// (Mozilla's Readability.js / Readability-readerable.js) — not npm packages.

declare function isProbablyReaderable(doc: Document): boolean;

declare class Readability {
	constructor(doc: Document, options?: Record<string, unknown>);
	parse(): { title: string; content: string; textContent: string } | null;
}
