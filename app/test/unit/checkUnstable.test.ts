import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { usedNames } from "../../../plugins/check-unstable.mjs";
import { surfaceOf } from "../../../plugins/check-legacy.mjs";

// check-unstable warns plugin authors off unstable API by member path, so a stable member
// that shares a name with an unstable one elsewhere on the surface is never flagged.
describe("check-unstable matches plugin code by member path", () => {
	it("reads nested destructuring as dotted paths", () => {
		const dir = mkdtempSync(join(tmpdir(), "mma-unstable-"));
		try {
			const file = join(dir, "index.ts");
			writeFileSync(file, "const { on, ui: { Sidebar } } = MMA;\nMMA.toast('hi');\n");
			expect([...usedNames(file).keys()].sort()).toEqual(["on", "toast", "ui", "ui.Sidebar"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps a stable member stable when an unstable one elsewhere shares its name", () => {
		const surface = surfaceOf(join(__dirname, "../../../plugins/types/mma.d.ts"));
		expect(surface.get("on")).toBe(false);
		expect(surface.get("pano.on")).toBe(true);
		expect(surface.get("toast")).toBe(false);
		expect(surface.get("pano.toast")).toBe(true);
	});
});
