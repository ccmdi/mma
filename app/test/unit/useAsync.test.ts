// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { act, createElement, useState } from "react";
import { makeLatestGate, useAsync, useAsyncSticky, useSticky } from "@/lib/hooks/useAsync";
import { mount } from "./fixtures/harness";

// The stale-result invariant of useAsync: a run's result is applied only if no
// newer run (changed deps) or cleanup (unmount) has started since.
describe("makeLatestGate", () => {
	it("reports current only for the most recent run", () => {
		const next = makeLatestGate();
		const first = next();
		expect(first()).toBe(true);

		const second = next();
		expect(first()).toBe(false); // superseded by a newer run
		expect(second()).toBe(true);
	});

	it("a later next() (e.g. cleanup) invalidates every prior predicate", () => {
		const next = makeLatestGate();
		const a = next();
		const b = next();
		next(); // cleanup / unmount

		expect(a()).toBe(false);
		expect(b()).toBe(false);
	});

	it("predicates stay valid across repeated checks until superseded", () => {
		const next = makeLatestGate();
		const only = next();
		expect(only()).toBe(true);
		expect(only()).toBe(true);
		next();
		expect(only()).toBe(false);
	});
});

describe("useAsync signal", () => {
	it("aborts a run's signal when newer deps supersede it, and on unmount", async () => {
		const signals: AbortSignal[] = [];
		let bump: () => void = () => {};
		function Probe() {
			const [dep, setDep] = useState(0);
			bump = () => setDep((n) => n + 1);
			useAsync(
				(signal) => {
					signals.push(signal);
					return new Promise<never>(() => {});
				},
				[dep],
			);
			return null;
		}
		const m = mount(createElement(Probe));
		await act(async () => bump());
		expect(signals.map((s) => s.aborted)).toEqual([true, false]);
		m.unmount();
		expect(signals[1].aborted).toBe(true);
	});
});

describe("useAsyncSticky key", () => {
	it("holds the last value across runs under one key and drops it when the key changes", async () => {
		let setDep: (n: number) => void = () => {};
		let setKey: (k: string) => void = () => {};
		let seen: string | null = null;
		const pending: ((v: string) => void)[] = [];
		function Probe() {
			const [dep, d] = useState(1);
			const [key, k] = useState("a");
			setDep = d;
			setKey = k;
			seen = useAsyncSticky(() => new Promise<string>((r) => pending.push(r)), [dep], key);
			return null;
		}
		const m = mount(createElement(Probe));
		await act(async () => pending.shift()!("v1"));
		expect(seen).toBe("v1");
		await act(async () => setDep(2));
		expect(seen).toBe("v1");
		await act(async () => pending.shift()!("v2"));
		expect(seen).toBe("v2");
		await act(async () => setKey("b"));
		expect(seen).toBeNull();
		await act(async () => pending.shift()!("v3"));
		expect(seen).toBe("v3");
		m.unmount();
	});
});

describe("useSticky", () => {
	it("holds the last settled value while loading, and a settled null is a value", () => {
		let seen: string | null | undefined;
		let setState: (s: {
			data: string | null;
			loading: boolean;
			error: Error | null;
		}) => void = () => {};
		function Probe() {
			const [state, set] = useState<{ data: string | null; loading: boolean; error: Error | null }>(
				{ data: null, loading: true, error: null },
			);
			setState = set;
			seen = useSticky(state);
			return null;
		}
		const m = mount(createElement(Probe));
		expect(seen).toBeNull();
		act(() => setState({ data: "v1", loading: false, error: null }));
		expect(seen).toBe("v1");
		act(() => setState({ data: null, loading: true, error: null }));
		expect(seen).toBe("v1");
		act(() => setState({ data: null, loading: false, error: null }));
		expect(seen).toBeNull();
		m.unmount();
	});
});
