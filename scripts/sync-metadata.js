#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SCRIPT_FILE = "Summarize with AI.user.js";
const META_JS = "Summarize with AI.meta.js";
const PACKAGE_JSON = "package.json";

const META_OPEN = "// ==UserScript==";
const META_CLOSE = "// ==/UserScript==";

/**
 * The file and git operations syncMetadata performs; paths are relative to the repo root.
 * @typedef {{
 *   readText: (path: string) => string,
 *   writeText: (path: string, text: string) => void,
 *   stage: (path: string) => void,
 *   log: (message: string) => void,
 * }} SyncIo
 */

/** @type {SyncIo} */
const nodeIo = {
	readText: path => readFileSync(path, "utf-8"),
	writeText: (path, text) => writeFileSync(path, text, "utf-8"),
	stage: path => execFileSync("git", ["add", path], { stdio: "pipe" }),
	log: message => console.log(message),
};

/**
 * The userscript's text split around its metadata block (markers included).
 * @param {string} content
 * @throws {Error} when either metadata marker is missing
 */
function splitMetadata(content) {
	const start = content.indexOf(META_OPEN);
	const close = content.indexOf(META_CLOSE);
	if (start === -1 || close === -1) throw new Error("Could not find userscript metadata block");
	const end = close + META_CLOSE.length;
	return {
		before: content.substring(0, start),
		metadata: content.substring(start, end),
		after: content.substring(end),
	};
}

/**
 * The metadata block with every `// @tag value` line's value aligned to one column.
 * Blank lines and plain comments are kept; other lines are trimmed.
 * @param {string} metadata
 */
export function alignMetadata(metadata) {
	const lines = metadata.split("\n").map(line => line.trim());
	const tags = lines.map(line => line.match(/^\/\/\s*(@\S+)\s+(.*)$/));
	const width = Math.max(0, ...tags.map(tag => (tag ? tag[1].length : 0)));
	return lines
		.map((line, i) => {
			const tag = tags[i];
			return tag ? `// ${tag[1].padEnd(width)} ${tag[2]}` : line;
		})
		.join("\n");
}

/**
 * Aligns the userscript's metadata block, mirrors it into the .meta.js update-check file
 * and copies its @version into package.json, staging every file it rewrites.
 * @param {SyncIo} io
 * @returns {string | undefined} the synced @version, or undefined when the header has none
 * @throws {Error} when the userscript has no metadata block
 */
export function syncMetadata(io = nodeIo) {
	const { before, metadata, after } = splitMetadata(io.readText(SCRIPT_FILE));
	const aligned = alignMetadata(metadata);
	if (aligned !== metadata) {
		io.writeText(SCRIPT_FILE, before + aligned + after);
		io.stage(SCRIPT_FILE);
		io.log("Metadata formatted and aligned");
	}

	io.writeText(META_JS, `${aligned}\n`);
	io.stage(META_JS);
	const version = aligned.match(/@version\s+(.+)/)?.[1]?.trim();
	io.log(`Metadata synced to ${META_JS} (v${version ?? "unknown"})`);
	if (!version) return undefined;

	const pkg = JSON.parse(io.readText(PACKAGE_JSON));
	if (pkg.version !== version) {
		pkg.version = version;
		io.writeText(PACKAGE_JSON, `${JSON.stringify(pkg, null, "\t")}\n`);
		io.stage(PACKAGE_JSON);
		io.log(`package.json version synced to ${version}`);
	}
	return version;
}

/**
 * Command-line entry: runs syncMetadata and reports a failure instead of throwing.
 * @param {SyncIo} io
 * @param {(message: string) => void} logError
 * @returns {0 | 1} the process exit code
 */
export function main(io = nodeIo, logError = console.error) {
	try {
		syncMetadata(io);
		return 0;
	} catch (error) {
		logError(`Error: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = main();
}
