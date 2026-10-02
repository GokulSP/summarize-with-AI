#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const SCRIPT_FILE = "Summarize with AI.user.js";
const META_JS = "Summarize with AI.meta.js";
const PACKAGE_JSON = "package.json";

/** @typedef {{ type: 'tag', tag: string, value: string } | { type: 'boundary' | 'comment' | 'empty' | 'other', line: string }} MetaLine */

/** @type {(l: MetaLine) => l is Extract<MetaLine, { type: 'tag' }>} */
const isTagLine = l => l.type === "tag";

const META_OPEN = "// ==UserScript==";
const META_CLOSE = "// ==/UserScript==";

/**
 * The userscript's text split around its metadata block (markers included).
 * @param {string} content
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

function formatUserscriptMetadata() {
	console.log("Formatting userscript metadata...");

	const {
		before: beforeMeta,
		metadata,
		after: afterMeta,
	} = splitMetadata(readFileSync(SCRIPT_FILE, "utf-8"));

	const lines = metadata.split("\n");
	/** @type {MetaLine[]} */
	const metaLines = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === META_OPEN || trimmed === META_CLOSE) {
			metaLines.push({ type: "boundary", line: trimmed });
		} else if (trimmed.startsWith("// @")) {
			const match = trimmed.match(/^\/\/\s*(@\S+)\s+(.*)$/);
			if (match) {
				metaLines.push({ type: "tag", tag: match[1], value: match[2] });
			} else {
				metaLines.push({ type: "other", line: trimmed });
			}
		} else if (trimmed.startsWith("//")) {
			metaLines.push({ type: "comment", line: trimmed });
		} else if (trimmed === "") {
			metaLines.push({ type: "empty", line: "" });
		}
	}

	const tagLines = metaLines.filter(isTagLine);
	const maxTagLength = Math.max(...tagLines.map(l => l.tag.length));

	const formattedLines = metaLines.map(item => {
		if (item.type === "tag") {
			const padding = " ".repeat(maxTagLength - item.tag.length);
			return `// ${item.tag}${padding} ${item.value}`;
		}
		return item.line;
	});

	const formattedMetadata = formattedLines.join("\n");

	if (formattedMetadata !== metadata) {
		writeFileSync(SCRIPT_FILE, beforeMeta + formattedMetadata + afterMeta, "utf-8");
		execFileSync("git", ["add", SCRIPT_FILE], { stdio: "pipe" });
		console.log("✓ Metadata formatted and aligned");
	} else {
		console.log("  Metadata already aligned");
	}
}

function syncMetadata() {
	console.log(`Syncing metadata to ${META_JS}...`);

	const { metadata } = splitMetadata(readFileSync(SCRIPT_FILE, "utf-8"));
	writeFileSync(META_JS, `${metadata}\n`, "utf-8");

	const version = metadata.match(/@version\s+(.+)/)?.[1]?.trim();
	console.log(`✓ Metadata synced to ${META_JS} (v${version ?? "unknown"})`);

	execFileSync("git", ["add", META_JS], { stdio: "pipe" });
	return version;
}

/** @param {string | undefined} version */
function syncPackageVersion(version) {
	if (!version) return;

	const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf-8"));
	if (pkg.version === version) return;

	pkg.version = version;
	writeFileSync(PACKAGE_JSON, `${JSON.stringify(pkg, null, "\t")}\n`, "utf-8");
	execFileSync("git", ["add", PACKAGE_JSON], { stdio: "pipe" });
	console.log(`✓ package.json version synced to ${version}`);
}

try {
	formatUserscriptMetadata();
	const version = syncMetadata();
	syncPackageVersion(version);
} catch (error) {
	console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
