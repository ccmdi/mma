import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const runOxlint = (config: string, file: string) => {
	const result = spawnSync(
		process.execPath,
		[resolve("node_modules/oxlint/bin/oxlint"), "--config", config, file],
		{ encoding: "utf8" },
	);
	if (result.error) throw result.error;
	return { status: result.status, output: result.stdout + result.stderr };
};

const lint = (source: string, name = "caller.ts", target?: string) => {
	const dir = mkdtempSync(join(resolve("test"), ".mma-domain-imports-"));
	try {
		const file = join(dir, name);
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
		return runOxlint(config, target ?? file);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

describe("domain import conventions", () => {
	it("accepts canonical objects, type imports, and unrelated modules", () => {
		const result = lint(
			'import { Tag } from "@/store/tag"; import { Store, type MapState } from "@/store/store"; import type { Opening } from "@/store/store"; import * as other from "@/lib/data/tags"; void Tag; void Store; void other;',
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
				'export type { MapState } from "@/store/store"; export { type Opening } from "@/store/store";',
			).status,
		).toBe(0);
	});
});

describe("one companion roster", () => {
	it("a module exporting an object named for its file must be on the roster", () => {
		const result = lint("export const Widget = { a: 1 };", "widget.ts");
		expect(result.status).toBe(1);
		expect(result.output).toContain("Widget is a companion object");
	});

	it("components, classes and differently named exports are not companions", () => {
		expect(lint("export class Widget {}", "widget.ts").status).toBe(0);
		expect(lint("export const Other = { a: 1 };", "widget.ts").status).toBe(0);
		expect(lint("export const Widget = () => null;", "widget.tsx").status).toBe(0);
	});

	it("the MMA interface and object carry every plugin-facing companion and nothing else", () => {
		const result = lint(
			"declare const Store: unknown, Feed: unknown; interface MMA { Store: unknown; Feed: unknown } const mma: MMA = { Store, Feed }; void mma;",
		);
		expect(result.status).toBe(1);
		expect(result.output).toContain("The companion Scene is missing from the MMA interface.");
		expect(result.output).toContain("The companion Scene is missing from the MMA object.");
		expect(result.output).toContain("Feed is in the MMA interface but is not a plugin-facing");
		expect(result.output).not.toContain("The companion Store is missing");
	});

	it("the real plugin surface matches the roster", () => {
		const result = lint("", "caller.ts", resolve("src/api.ts"));
		expect(result.output).not.toContain("local(domain-objects)");
	});
});
