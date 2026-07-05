#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const USER_JS = 'Summarize with AI.user.js';
const META_JS = 'Summarize with AI.meta.js';
const PACKAGE_JSON = 'package.json';

function formatUserscriptMetadata() {
	console.log('Formatting userscript metadata...');

	const content = readFileSync(USER_JS, 'utf-8');
	const metaStart = content.indexOf('// ==UserScript==');
	const metaEnd = content.indexOf('// ==/UserScript==');

	if (metaStart === -1 || metaEnd === -1)
		throw new Error('Could not find userscript metadata block');

	const beforeMeta = content.substring(0, metaStart);
	const afterMeta = content.substring(metaEnd + '// ==/UserScript=='.length);
	const metadata = content.substring(metaStart, metaEnd + '// ==/UserScript=='.length);

	const lines = metadata.split('\n');
	const metaLines = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === '// ==UserScript==' || trimmed === '// ==/UserScript==') {
			metaLines.push({ type: 'boundary', line: trimmed });
		} else if (trimmed.startsWith('// @')) {
			const match = trimmed.match(/^\/\/\s*(@\S+)\s+(.*)$/);
			if (match) {
				metaLines.push({ type: 'tag', tag: match[1], value: match[2] });
			} else {
				metaLines.push({ type: 'other', line: trimmed });
			}
		} else if (trimmed.startsWith('//')) {
			metaLines.push({ type: 'comment', line: trimmed });
		} else if (trimmed === '') {
			metaLines.push({ type: 'empty', line: '' });
		}
	}

	const tagLines = metaLines.filter(l => l.type === 'tag');
	const maxTagLength = Math.max(...tagLines.map(l => l.tag.length));

	const formattedLines = metaLines.map(item => {
		if (item.type === 'tag') {
			const padding = ' '.repeat(maxTagLength - item.tag.length);
			return `// ${item.tag}${padding} ${item.value}`;
		}
		return item.line;
	});

	const formattedMetadata = formattedLines.join('\n');

	if (formattedMetadata !== metadata) {
		writeFileSync(USER_JS, beforeMeta + formattedMetadata + afterMeta, 'utf-8');
		execSync(`git add "${USER_JS}"`, { stdio: 'pipe' });
		console.log('✓ Metadata formatted and aligned');
	} else {
		console.log('  Metadata already aligned');
	}
}

function syncMetadata() {
	console.log(`Syncing metadata to ${META_JS}...`);

	const content = readFileSync(USER_JS, 'utf-8');
	const metaStart = content.indexOf('// ==UserScript==');
	const metaEnd = content.indexOf('// ==/UserScript==');

	if (metaStart === -1 || metaEnd === -1)
		throw new Error('Could not find userscript metadata block');

	const metadata = content.substring(metaStart, metaEnd + '// ==/UserScript=='.length);
	writeFileSync(META_JS, `${metadata}\n`, 'utf-8');

	const version = metadata.match(/@version\s+(.+)/)?.[1]?.trim();
	console.log(`✓ Metadata synced to ${META_JS} (v${version ?? 'unknown'})`);

	execSync(`git add "${META_JS}"`, { stdio: 'pipe' });
	return version;
}

function syncPackageVersion(version) {
	if (!version) return;

	const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8'));
	if (pkg.version === version) return;

	pkg.version = version;
	writeFileSync(PACKAGE_JSON, `${JSON.stringify(pkg, null, '\t')}\n`, 'utf-8');
	execSync(`git add "${PACKAGE_JSON}"`, { stdio: 'pipe' });
	console.log(`✓ package.json version synced to ${version}`);
}

try {
	formatUserscriptMetadata();
	const version = syncMetadata();
	syncPackageVersion(version);
} catch (error) {
	console.error(`Error: ${error.message}`);
	process.exit(1);
}
