import { describe, it, expect } from "vitest";
import {
	isVirtualLocation,
	isImportPreview,
	isSeenPreview,
	LocationFlag,
	VIRTUAL_FLAGS,
} from "@/types";
import type { Location } from "@/bindings.gen";

const withFlags = (flags: number) => ({ flags }) as Location;

// Virtual (preview) locations are identified by a negative id (so bare-id checks work), with
// the kind carried in the flags bitfield. Real ids (>= 1) and the unassigned sentinel (0) are
// never virtual.
describe("virtual location identity", () => {
	it("negative ids are virtual; real/sentinel ids are not", () => {
		expect(isVirtualLocation({ id: -1 })).toBe(true);
		expect(isVirtualLocation({ id: -999 })).toBe(true);
		expect(isVirtualLocation({ id: 0 })).toBe(false); // unassigned sentinel
		expect(isVirtualLocation({ id: 1 })).toBe(false);
		expect(isVirtualLocation({ id: 4_294_967_295 })).toBe(false); // u32 max
	});
});

describe("virtual kind flags", () => {
	it("reads the kind from flags, independent of other bits", () => {
		expect(isImportPreview(withFlags(LocationFlag.ImportPreview))).toBe(true);
		expect(isSeenPreview(withFlags(LocationFlag.SeenOverlay | LocationFlag.LoadAsPanoId))).toBe(
			true,
		);
		expect(isImportPreview(withFlags(LocationFlag.SeenOverlay))).toBe(false);
		expect(isSeenPreview(withFlags(LocationFlag.LoadAsPanoId))).toBe(false);
	});

	it("VIRTUAL_FLAGS strips both kind bits while keeping real attributes", () => {
		const flags = LocationFlag.LoadAsPanoId | LocationFlag.SeenOverlay;
		expect(flags & ~VIRTUAL_FLAGS).toBe(LocationFlag.LoadAsPanoId);
	});
});
