import { describe, it, expect } from "vitest";
import { isImportPreview, isSeenPreview } from "@/types";
import { LocationFlag, PREVIEW_FLAGS } from "@/bindings.consts";
import type { Location } from "@/bindings.gen";

const withFlags = (flags: number) => ({ flags }) as Location;

describe("preview kind flags", () => {
	it("reads the kind from flags, independent of other bits", () => {
		expect(isImportPreview(withFlags(LocationFlag.ImportPreview))).toBe(true);
		expect(isSeenPreview(withFlags(LocationFlag.SeenOverlay | LocationFlag.LoadAsPanoId))).toBe(
			true,
		);
		expect(isImportPreview(withFlags(LocationFlag.SeenOverlay))).toBe(false);
		expect(isSeenPreview(withFlags(LocationFlag.LoadAsPanoId))).toBe(false);
	});

	it("PREVIEW_FLAGS strips both kind bits while keeping real attributes", () => {
		const flags = LocationFlag.LoadAsPanoId | LocationFlag.SeenOverlay;
		expect(flags & ~PREVIEW_FLAGS).toBe(LocationFlag.LoadAsPanoId);
	});
});
