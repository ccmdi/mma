import { describe, it, expect } from "vitest";
import { EFFECT_CALLS, PLAIN_CALLS } from "@/bindings.consts";
import type { ProcedureHost } from "@/lib/data/procedureHost";

// `satisfies` pins this object to the declared interface: a member added to or dropped
// from `ProcedureHost` fails typecheck here, and the assertion below compares what is left
// against the name lists Rust's QuickJS installer owns (`procedure/quickjs.rs`).
// If either side drifts, one of the two suites goes red.
const surface = {
	fetch: 0,
	fetchMany: 0,
	panos: 0,
	sidecar: 0,
	classify: 0,
	progress: 0,
	fail: 0,
	aborted: 0,
	log: 0,
	tz: 0,
} satisfies Record<keyof ProcedureHost, unknown>;

describe("ProcedureHost", () => {
	it("declares exactly the calls the QuickJS host installs", () => {
		// `log` and `tz` are set directly rather than through either list.
		const installed = [...EFFECT_CALLS, ...PLAIN_CALLS, "log", "tz"];
		expect(Object.keys(surface).sort()).toEqual([...installed].sort());
	});
});
