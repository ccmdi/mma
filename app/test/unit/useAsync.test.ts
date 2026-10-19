// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { act, createElement, useState, useEffect } from "react";
import { useAsync, useAsyncSticky, useSticky, type Rerunnable } from "@/lib/hooks/useAsync";
import { Err, Loading, Ok, type AsyncState } from "@/types/util";
import { mount } from "./fixtures/harness";

describe("useAsync signal", () => {
	it("aborts a run's signal when newer deps supersede it, and on unmount", async () => {
		const signals: AbortSignal[] = [];
		let bump: () => void = () => {};
		function Probe() {
			const [dep, setDep] = useState(0);
			useEffect(() => {
				bump = () => setDep((n) => n + 1);
			}, []);
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

describe("useAsync discard", () => {
	it("hands a superseded run's value to discard and never returns it", async () => {
		let bump: () => void = () => {};
		let seen: string | null = null;
		const pending: ((v: string) => void)[] = [];
		const discarded: string[] = [];
		function Probe() {
			const [dep, setDep] = useState(0);
			const state = useAsync(() => new Promise<string>((r) => pending.push(r)), [dep], {
				discard: (value) => discarded.push(value),
			});
			const value = state.status === "ok" ? state.value : null;
			useEffect(() => {
				bump = () => setDep((n) => n + 1);
				seen = value;
			}, [value]);
			return null;
		}
		const m = mount(createElement(Probe));
		await act(async () => bump());
		await act(async () => pending[0]("old"));
		await act(async () => pending[1]("new"));
		expect(discarded).toEqual(["old"]);
		expect(seen).toBe("new");
		m.unmount();
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
			const state = useAsyncSticky(() => new Promise<string>((r) => pending.push(r)), [dep], key);
			const value = state.status === "ok" ? state.value : null;
			useEffect(() => {
				setDep = d;
				setKey = k;
				seen = value;
			}, [value]);
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
	it("holds the last value while loading, and never holds an error", () => {
		let seen: AsyncState<string> | undefined;
		let setState: (s: AsyncState<string>) => void = () => {};
		function Probe() {
			const [state, set] = useState<AsyncState<string>>(new Loading());
			const shown = useSticky(state);
			useEffect(() => {
				setState = set;
				seen = shown;
			}, [shown]);
			return null;
		}
		const m = mount(createElement(Probe));
		expect(seen).toStrictEqual(new Loading());
		act(() => setState(new Ok("v1")));
		act(() => setState(new Loading()));
		expect(seen).toStrictEqual(new Ok("v1"));
		act(() => setState(new Err(new Error("down"))));
		act(() => setState(new Loading()));
		expect(seen).toStrictEqual(new Loading());
		m.unmount();
	});
});

describe("useAsync rerun", () => {
	it("runs again with the same deps after a failure", async () => {
		let calls = 0;
		let seen: Rerunnable<string> | undefined;
		function Probe() {
			const state = useAsync(async () => {
				calls++;
				if (calls === 1) throw new Error("down");
				return "up";
			}, []);
			useEffect(() => {
				seen = state;
			}, [state]);
			return null;
		}
		const m = mount(createElement(Probe));
		await act(async () => {});
		expect(seen?.status).toBe("error");
		let settled: unknown;
		await act(async () => {
			settled = await seen!.rerun();
		});
		expect(settled).toStrictEqual(new Ok("up"));
		expect(seen?.status === "ok" && seen.value).toBe("up");
		m.unmount();
	});
});
