import { describe, expect, it } from "vitest";
import { alignMetadata, main, syncMetadata } from "./sync-metadata.js";

const ALIGNED = [
	"// ==UserScript==",
	"// @name    Demo",
	"// @version 1.2.3",
	"",
	"// a plain comment",
	"// ==/UserScript==",
].join("\n");

const UNALIGNED = [
	"// ==UserScript==",
	"//   @name Demo",
	"// @version   1.2.3",
	"",
	"   // a plain comment",
	"// ==/UserScript==",
].join("\n");

/**
 * An in-memory repo: files keyed by path, plus the order files were staged in.
 * @param {Record<string, string>} files
 */
function fakeRepo(files) {
	/** @type {string[]} */
	const staged = [];
	/** @type {string[]} */
	const logged = [];
	return {
		files,
		staged,
		logged,
		io: {
			/** @param {string} path */
			readText: path => {
				if (!(path in files)) throw new Error(`ENOENT: ${path}`);
				return files[path];
			},
			/** @param {string} path @param {string} text */
			writeText: (path, text) => {
				files[path] = text;
			},
			/** @param {string} path */
			stage: path => {
				staged.push(path);
			},
			/** @param {string} message */
			log: message => {
				logged.push(message);
			},
		},
	};
}

describe("alignMetadata", () => {
	it("pads every tag to the longest one and keeps blanks and comments", () => {
		expect(alignMetadata(UNALIGNED)).toBe(
			[
				"// ==UserScript==",
				"// @name    Demo",
				"// @version 1.2.3",
				"",
				"// a plain comment",
				"// ==/UserScript==",
			].join("\n"),
		);
	});

	it("leaves a block without tags unchanged", () => {
		expect(alignMetadata("// ==UserScript==\n// ==/UserScript==")).toBe(
			"// ==UserScript==\n// ==/UserScript==",
		);
	});
});

describe("syncMetadata", () => {
	it("aligns the header, mirrors it to .meta.js and bumps package.json", () => {
		const repo = fakeRepo({
			"Summarize with AI.user.js": `#!x\n${UNALIGNED}\nbody();\n`,
			"package.json": '{\n\t"name": "demo",\n\t"version": "1.0.0"\n}\n',
		});
		const aligned = alignMetadata(UNALIGNED);

		expect(syncMetadata(repo.io)).toBe("1.2.3");
		expect(repo.files).toEqual({
			"Summarize with AI.user.js": `#!x\n${aligned}\nbody();\n`,
			"Summarize with AI.meta.js": `${aligned}\n`,
			"package.json": '{\n\t"name": "demo",\n\t"version": "1.2.3"\n}\n',
		});
		expect(repo.staged).toEqual([
			"Summarize with AI.user.js",
			"Summarize with AI.meta.js",
			"package.json",
		]);
	});

	it("rewrites only the .meta.js mirror when everything is already in sync", () => {
		const pkg = '{\n\t"version": "1.2.3"\n}\n';
		const repo = fakeRepo({
			"Summarize with AI.user.js": `${ALIGNED}\n`,
			"package.json": pkg,
		});

		expect(syncMetadata(repo.io)).toBe("1.2.3");
		expect(repo.staged).toEqual(["Summarize with AI.meta.js"]);
		expect(repo.files["package.json"]).toBe(pkg);
		expect(repo.logged).toEqual(["Metadata synced to Summarize with AI.meta.js (v1.2.3)"]);
	});

	it("leaves package.json alone when the header has no @version", () => {
		const header = "// ==UserScript==\n// @name Demo\n// ==/UserScript==";
		const repo = fakeRepo({ "Summarize with AI.user.js": header });

		expect(syncMetadata(repo.io)).toBeUndefined();
		expect(repo.staged).toEqual(["Summarize with AI.meta.js"]);
		expect(repo.logged).toEqual(["Metadata synced to Summarize with AI.meta.js (vunknown)"]);
	});

	it("fails when the userscript has no metadata block", () => {
		const repo = fakeRepo({ "Summarize with AI.user.js": "body();\n" });

		expect(() => syncMetadata(repo.io)).toThrow("Could not find userscript metadata block");
		expect(repo.staged).toEqual([]);
	});
});

describe("main", () => {
	it("exits 0 after a successful sync", () => {
		const repo = fakeRepo({
			"Summarize with AI.user.js": `${ALIGNED}
`,
			"package.json": "{}",
		});
		/** @type {string[]} */
		const errors = [];

		expect(main(repo.io, message => errors.push(message))).toBe(0);
		expect(errors).toEqual([]);
	});

	it.each([
		[new Error("disk full"), "Error: disk full"],
		["not an Error", "Error: not an Error"],
	])("reports %s and exits 1", (thrown, reported) => {
		const repo = fakeRepo({});
		repo.io.readText = () => {
			throw thrown;
		};
		/** @type {string[]} */
		const errors = [];

		expect(main(repo.io, message => errors.push(message))).toBe(1);
		expect(errors).toEqual([reported]);
	});
});
