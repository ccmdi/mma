// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { act } from "react";
import { mountAsync } from "./fixtures/harness";
import { initLocale } from "@/lib/i18n";
import type { ReviewSession } from "@/bindings.gen";

const h = vi.hoisted(() => ({
	stored: [] as ReviewSession[],
	removeSession: vi.fn<(id: string) => Promise<void>>(),
	toast: vi.fn(),
}));
vi.mock("@/lib/review/review", () => ({
	Review: {
		sessions: async () => h.stored,
		removeSession: (id: string) => h.removeSession(id),
		rename: async () => {},
	},
}));
vi.mock("@/lib/util/toast", () => ({ toast: h.toast }));

const { ReviewSessionsModal } = await import("@/components/dialogs/ReviewSessions");

const session = (id: string): ReviewSession =>
	({
		id,
		name: `Review ${id}`,
		order: [],
		reviewed: [],
		createdAt: 0,
		updatedAt: 0,
	}) as unknown as ReviewSession;
const names = () => [...document.querySelectorAll(".entry-list__name")].map((el) => el.textContent);
const remove = async (index: number) => {
	const button = () =>
		document.querySelectorAll<HTMLButtonElement>('[data-qa="review-session-delete"]')[index];
	await act(async () => button().click());
	await act(async () => button().click());
};

beforeAll(async () => {
	await initLocale("en");
});
beforeEach(() => {
	document.body.replaceChildren();
	h.stored = [session("a"), session("b")];
	h.removeSession.mockReset();
	h.toast.mockReset();
});

describe("review sessions", () => {
	it("drops a deleted session and shows what the store holds after", async () => {
		h.removeSession.mockImplementation(async (id) => {
			h.stored = h.stored.filter((s) => s.id !== id);
		});
		await mountAsync(<ReviewSessionsModal open onOpenChange={() => {}} />);
		expect(names()).toEqual(["Review a", "Review b"]);
		await remove(0);
		expect(names()).toEqual(["Review b"]);
	});

	it("puts a session back and says so when deleting it fails", async () => {
		h.removeSession.mockRejectedValue(new Error("locked"));
		await mountAsync(<ReviewSessionsModal open onOpenChange={() => {}} />);
		await remove(0);
		expect(names()).toEqual(["Review a", "Review b"]);
		expect(h.toast).toHaveBeenCalledWith("Error: locked");
	});
});
