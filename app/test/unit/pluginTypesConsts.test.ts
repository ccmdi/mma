import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dts = readFileSync(new URL("../../../plugins/types/mma.d.ts", import.meta.url), "utf-8");

describe("plugin types", () => {
	it("keep a constant that shares its name with a type as a value on MMA", () => {
		const constants = new Set([...dts.matchAll(/^declare const (\w+):/gm)].map((m) => m[1]));
		const reexported = new Set(
			[...dts.matchAll(/^export type (\w+) = (\w+);$/gm)]
				.filter(([, , target]) => constants.has(target))
				.map(([, alias]) => alias),
		);
		expect(reexported.size).toBeGreaterThan(0);
		for (const [, typeOnly, list] of dts.matchAll(/^[ \t]+export (type )?\{([^}]*)\};$/gm)) {
			for (const part of list.split(",")) {
				const local = part.trim().split(/\s+/)[0];
				if (reexported.has(local)) expect(typeOnly, local).toBeUndefined();
			}
		}
	});
});
