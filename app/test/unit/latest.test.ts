import { describe, expect, it, vi } from "vitest";
import { latest } from "@/lib/util/latest";

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
		const publish = vi.fn();
		const discard = vi.fn();
		const requests = latest<string>({ publish, discard });
		const older = deferred<string>();
		const first = requests.replace(() => older.promise);
		await requests.replace(() => Promise.resolve("new"));
		older.resolve("old resource");
		await first;
		expect(publish.mock.calls).toEqual([["new"]]);
		expect(discard.mock.calls).toEqual([["old resource"]]);
	});
	it("suppresses obsolete errors but reports a current error", async () => {
		const failed = vi.fn();
		const requests = latest<string>({ failed });
		const older = deferred<string>();
		const first = requests.replace(() => older.promise);
		await requests.replace(() => Promise.resolve("new"));
		older.reject(new Error("obsolete"));
		await first;
		expect(failed).not.toHaveBeenCalled();
		const error = new Error("current");
		await requests.replace(() => Promise.reject(error));
		expect(failed).toHaveBeenCalledExactlyOnceWith(error);
	});
	it("rejects with a current error when nothing handles failures", async () => {
		const requests = latest<string>();
		const error = new Error("current");
		await expect(requests.replace(() => Promise.reject(error))).rejects.toBe(error);
		await expect(
			requests.replace(() => {
				throw error;
			}),
		).rejects.toBe(error);
	});
	it("cancellation aborts requests and invalidates callbacks, including when reopened", async () => {
		const publish = vi.fn();
		const requests = latest<string>({ publish });
		const result = deferred<string>();
		let signal!: AbortSignal;
		const pending = requests.replace((owner) => {
			signal = owner;
			return result.promise;
		});
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
		const publishOpen = vi.fn();
		const publishRead = vi.fn();
		const openings = latest<string>({ publish: publishOpen });
		const refreshes = latest<string>({ publish: publishRead });
		const pending = deferred<string>();
		const opening = openings.replace(() => pending.promise);
		const refresh = refreshes.replace(() => "sync");
		expect(publishRead).toHaveBeenCalledWith("sync");
		refreshes.cancel();
		pending.resolve("opening");
		await Promise.all([opening, refresh]);
		expect(publishOpen).toHaveBeenCalledWith("opening");
	});
});

describe("owned requests", () => {
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
