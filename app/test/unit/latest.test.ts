import { describe, expect, it, vi } from "vitest";
import { latest, owned } from "@/lib/util/latest";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

describe("latest request ownership", () => {
	it("only publishes the newest result and releases superseded resources", async () => {
		const requests = latest();
		const older = deferred<string>();
		const publish = vi.fn();
		const discard = vi.fn();
		const first = requests.replace(() => older.promise, publish, { discard });
		await requests.replace(() => Promise.resolve("new"), publish);
		older.resolve("old resource");
		await first;
		expect(publish.mock.calls).toEqual([["new"]]);
		expect(discard.mock.calls).toEqual([["old resource"]]);
	});
	it("suppresses obsolete errors but reports a current error", async () => {
		const requests = latest();
		const older = deferred<string>();
		const failed = vi.fn();
		const publish = vi.fn();
		const first = requests.replace(() => older.promise, publish, { failed });
		await requests.replace(() => Promise.resolve("new"), publish, { failed });
		older.reject(new Error("obsolete"));
		await first;
		expect(failed).not.toHaveBeenCalled();
		const error = new Error("current");
		await requests.replace(() => Promise.reject(error), publish, { failed });
		expect(failed).toHaveBeenCalledExactlyOnceWith(error);
	});
	it("cancellation aborts requests and invalidates callbacks, including when reopened", async () => {
		const requests = latest();
		const result = deferred<string>();
		const publish = vi.fn();
		let signal!: AbortSignal;
		const pending = requests.replace((owner) => {
			signal = owner;
			return result.promise;
		}, publish);
		const callback = requests.bind(publish);
		requests.cancel();
		expect(signal.aborted).toBe(true);
		requests.bind(publish)("new callback");
		callback("old callback");
		result.resolve("old result");
		await pending;
		expect(publish.mock.calls).toEqual([["new callback"]]);
	});
	it("runs effect-only work without a publisher and still supersedes it", async () => {
		const runs = latest();
		const signals: AbortSignal[] = [];
		const first = runs.replace((signal) => void signals.push(signal));
		await runs.replace((signal) => void signals.push(signal));
		await first;
		expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
	});
	it("publishes synchronous values immediately and keeps independent request scopes separate", async () => {
		const openings = latest();
		const refreshes = latest();
		const pending = deferred<string>();
		const publishOpen = vi.fn();
		const opening = openings.replace(() => pending.promise, publishOpen);
		const publishRead = vi.fn();
		const refresh = refreshes.replace(() => "sync", publishRead);
		expect(publishRead).toHaveBeenCalledWith("sync");
		refreshes.cancel();
		pending.resolve("opening");
		await Promise.all([opening, refresh]);
		expect(publishOpen).toHaveBeenCalledWith("opening");
	});
});

describe("configured ownership", () => {
	it("uses configured publication and disposal without a case-specific wrapper", async () => {
		const publish = vi.fn();
		const discard = vi.fn();
		const requests = latest<string>({ publish, discard });
		const obsolete = deferred<string>();
		const first = requests.replace(() => obsolete.promise);
		await requests.replace(() => "current");
		obsolete.resolve("obsolete");
		await first;
		expect(publish.mock.calls).toEqual([["current"]]);
		expect(discard.mock.calls).toEqual([["obsolete"]]);
	});
	it("invalidates callbacks and pending answers when their resource owner changes", async () => {
		let owner = {};
		const publish = vi.fn();
		const discard = vi.fn();
		const failed = vi.fn();
		const requests = latest<string>({ owner: () => owner, publish, discard, failed });
		const value = deferred<string>();
		const reading = requests.replace(() => value.promise);
		const callback = requests.bind(publish);
		owner = {};
		callback("obsolete callback");
		value.resolve("obsolete answer");
		await reading;
		expect(publish).not.toHaveBeenCalled();
		expect(discard).toHaveBeenCalledWith("obsolete answer");
		const error = deferred<string>();
		const failing = requests.replace(() => error.promise);
		owner = {};
		error.reject(new Error("obsolete error"));
		await failing;
		expect(failed).not.toHaveBeenCalled();
	});
});

it("bound operations keep their promised result shape after invalidation", async () => {
	const scope = latest();
	const operation = vi.fn(async () => 7 as number | null);
	const bound = scope.bind(operation, () => Promise.resolve(null));
	expect(await bound()).toBe(7);
	scope.cancel();
	expect(await bound()).toBeNull();
	expect(operation).toHaveBeenCalledTimes(1);
});

describe("owned method APIs", () => {
	it("provides stable methods, current context, and inert retained callbacks without caller wiring", async () => {
		const first = {};
		let current: { resource: object; value: number } | null = { resource: first, value: 1 };
		const run = vi.fn(
			async (owner: { resource: object; value: number }, add: number) => owner.value + add,
		);
		const api = owned(
			() => current,
			{ run },
			(owner) => owner.resource,
		);
		const retained = api.run;
		expect(await retained(2)).toBe(3);
		current = { resource: first, value: 4 };
		expect(api.run).toBe(retained);
		expect(await retained(2)).toBe(6);
		current = { resource: {}, value: 10 };
		expect(api.run).not.toBe(retained);
		expect(await retained(2)).toBeNull();
		expect(await api.run(2)).toBe(12);
		const active = api.run;
		current = null;
		expect(await active(2)).toBeNull();
		expect(await api.run(2)).toBeNull();
		expect(run).toHaveBeenCalledTimes(3);
	});
	it("allows an admitted operation to finish for its original owner", async () => {
		const oldOwner = {};
		let current: object | null = oldOwner;
		const pending = deferred<number>();
		const write = vi.fn((_owner: object) => pending.promise);
		const api = owned(() => current, { write });
		const admitted = api.write();
		current = {};
		pending.resolve(7);
		expect(await admitted).toBe(7);
		expect(write).toHaveBeenCalledExactlyOnceWith(oldOwner);
	});
});
