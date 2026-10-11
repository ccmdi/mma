import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const lint = (source: string) => {
	const dir = mkdtempSync(join(resolve("test"), ".mma-domain-imports-"));
	try {
		const file = join(dir, "caller.ts");
		const rule = resolve("lint-rules/index.js");
		const config = join(dir, "oxlint.json");
		writeFileSync(
			file,
			source.replaceAll(
				"RELATIVE_TAG",
				relative(dir, resolve("src/store/tag")).replaceAll("\\", "/"),
			),
		);
		writeFileSync(
			config,
			JSON.stringify({ jsPlugins: [rule], rules: { "local/domain-objects": "error" } }),
		);
		const result = spawnSync(
			process.execPath,
			[resolve("node_modules/oxlint/bin/oxlint"), "--config", config, file],
			{ encoding: "utf8" },
		);
		if (result.error) throw result.error;
		return { status: result.status, output: result.stdout + result.stderr };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

describe("domain import conventions", () => {
	it("accepts canonical objects, type imports, and unrelated modules", () => {
		const result = lint(
			'import { Tag } from "@/store/tag"; import { Store, type MapState } from "@/store/store"; import type { Open } from "@/store/store"; import * as other from "@/lib/data/tags"; void Tag; void Store; void other;',
		);
		expect(result.output).not.toContain("local(domain-objects)");
		expect(result.status).toBe(0);
	});
	it.each([
		'import * as Tag from "@/store/tag"; void Tag;',
		'import { Tag as mapTags } from "@/store/tag"; void mapTags;',
		'import Tag from "@/store/tag"; void Tag;',
		'import { rename } from "@/store/tag"; void rename;',
		'import { Tag as alias } from "RELATIVE_TAG"; void alias;',
	])("rejects alternative import spellings: %s", (source) => {
		const result = lint(source);
		expect(result.status).toBe(1);
		expect(result.output).toContain("Import the domain object as Tag");
	});
	it.each([
		'export * from "@/store/tag";',
		'export { Tag } from "@/store/tag";',
		'import { Tag } from "@/store/tag"; export { Tag };',
	])("rejects runtime domain barrels: %s", (source) => {
		const result = lint(source);
		expect(result.status).toBe(1);
		expect(result.output).toContain("do not re-export them");
	});
	it("allows re-exporting types without a runtime barrel", () => {
		expect(
			lint(
				'export type { MapState } from "@/store/store"; export { type Open } from "@/store/store";',
			).status,
		).toBe(0);
	});
});
