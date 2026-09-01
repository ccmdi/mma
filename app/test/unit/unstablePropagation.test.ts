import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `@unstable` is declared once, on a surface or namespace, and the SDK generator stamps it
// onto every member the tag covers. Together with check-legacy.mjs it decides whether
// removing a plugin-visible API is allowed to ship, and a member that loses its stamp
// silently becomes a stable promise nobody meant to make. Asserted against the committed
// artifact, so a generator regression fails here rather than at a plugin author's install.
const dts = readFileSync(join(__dirname, "../../../plugins/types/mma.d.ts"), "utf8");

/** Members of a `declare const <name>: { ... }` block, with the doc comment above each. */
function membersOf(name: string): { member: string; doc: string }[] {
	const start = dts.indexOf(`declare const ${name}: {`);
	if (start < 0) return [];
	const body = dts.slice(start, dts.indexOf("\n};", start));
	const out: { member: string; doc: string }[] = [];
	const re = /(\/\*\*[\s\S]*?\*\/)?\s*\n\s{4}(\w+)\s*:/g;
	for (const m of body.matchAll(re)) out.push({ doc: m[1] ?? "", member: m[2] });
	return out;
}

describe("@unstable propagation reaches the members plugins actually call", () => {
	it("stamps a large number of members, not just the surfaces", () => {
		expect((dts.match(/@unstable/g) ?? []).length).toBeGreaterThan(100);
	});

	it("every command carries the tag, because the whole cmd namespace is unstable", () => {
		const cmds = membersOf("commands");
		expect(cmds.length).toBeGreaterThan(50);
		const bare = cmds.filter((c) => !c.doc.includes("@unstable")).map((c) => c.member);
		expect(bare).toEqual([]);
	});

	it("a legacy shim is unstable from birth, so it is never a stable promise", () => {
		const deprecated = dts
			.split(/\n(?=\s*\/\*\*)/)
			.filter((block) => block.includes("@deprecated"));
		expect(deprecated.length).toBeGreaterThan(0);
		const stable = deprecated.filter((b) => !b.includes("@unstable"));
		expect(stable).toEqual([]);
	});
});
