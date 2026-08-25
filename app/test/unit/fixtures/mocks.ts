import { vi } from "vitest";

/**
 * Shared `vi.mock` factories.
 *
 * `vi.mock` is hoisted above imports, so these cannot be imported normally and referenced
 * inside a factory. Call them through a dynamic import instead, which is lazy enough that
 * hoisting never sees them:
 *
 *     vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());
 */

export function logMock() {
	return {
		log: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
			trace: vi.fn(),
		},
		fireAndForget: (p: Promise<unknown> | undefined) => void p?.catch(() => {}),
		asyncHandler:
			<A extends unknown[]>(fn: (...args: A) => Promise<unknown>, _label: string) =>
			(...args: A) =>
				void fn(...args).catch(() => {}),
		initLogging: async () => {},
	};
}
