import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dts = readFileSync(new URL("../../../plugins/types/mma.d.ts", import.meta.url), "utf-8");

describe("plugin types", () => {
	it("keep a constant that shares its name with a type as a value on MMA", () => {
		const constants = new Set([...dts.matchAll(/^declare const (\w+):/gm)].map((m) => m[1]));
		const aliases = [...dts.matchAll(/^export type (\w+) = (\w+);$/gm)].filter(([, , target]) =>
			constants.has(target),
		);
		expect(aliases.length).toBeGreaterThan(0);
		for (const [, alias] of aliases) expect(constants).toContain(alias);
		for (const [, list] of dts.matchAll(/^[ 	]+export type \{([^}]*)\};$/gm)) {
			for (const part of list.split(","))
				expect(constants).not.toContain(part.trim().split(/\s+/)[0]);
		}
	});
});
