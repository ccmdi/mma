import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ValueRecord } from "@/bindings.gen";
import { Tag } from "@/store/tag";
import { Edit } from "@/store/edit";
import { all, any, tagSelector } from "@/store/selections";

vi.mock("@/store/store", () => ({ Store: { get: () => ({ fieldValues: {} }) } }));
vi.mock("@/store/edit", () => ({ Edit: { values: vi.fn(), work: vi.fn() } }));

beforeEach(() => {
	vi.mocked(Edit.values)
		.mockReset()
		.mockResolvedValue({ mutation: { version: 1, keys: [8] } });
	vi.mocked(Edit.work)
		.mockReset()
		.mockResolvedValue({ mutation: { version: 2, keys: [] }, changed: 3, failed: [] });
});

describe("tag record edits", () => {
	it("updates only supplied fields in a single edit", async () => {
		await Tag.update([
			{ id: 2, name: "new" },
			{ id: 3, color: "#abc", order: 9 },
		]);
		expect(Edit.values).toHaveBeenCalledExactlyOnceWith("tags", [
			{ put: { id: 2, name: "new" } },
			{ put: { id: 3, color: "#abc", order: 9 } },
		]);
	});
	it("creates records with engine-assigned ids and returns all assigned keys", async () => {
		vi.mocked(Edit.values).mockResolvedValue({ mutation: { version: 3, keys: [8, 12] } });
		expect(await Tag.create([{ name: "a" }, { name: "b", color: "#abc" }])).toEqual([8, 12]);
		expect(Edit.values).toHaveBeenCalledExactlyOnceWith("tags", [
			{ add: { id: 0, name: "a" } },
			{ add: { id: 0, name: "b", color: "#abc" } },
		]);
	});
	it("sets a contiguous display order without replacing other metadata", async () => {
		await Tag.reorder([9, 2, 6]);
		expect(Edit.values).toHaveBeenCalledExactlyOnceWith("tags", [
			{ put: { id: 9, order: 0 } },
			{ put: { id: 2, order: 1 } },
			{ put: { id: 6, order: 2 } },
		]);
	});
});

describe("tag assignment workflows", () => {
	it("moves each source tag's carriers to the destination without removing the destination", async () => {
		await Tag.rename([2, 8, 3], "destination");
		expect(Edit.work).toHaveBeenCalledExactlyOnceWith(any(tagSelector(2), tagSelector(3)), {
			kind: "listSet",
			key: "tags",
			add: [8],
			remove: [2, 3],
		});
	});
	it("limits a scoped rename to the intersection of source carriers and the requested scope", async () => {
		const scope = { type: "Locations" as const, locations: [4, 5], name: null };
		await Tag.rename([2], "destination", scope);
		expect(Edit.work).toHaveBeenCalledExactlyOnceWith(all(any(tagSelector(2)), scope), {
			kind: "listSet",
			key: "tags",
			add: [8],
			remove: [2],
		});
	});
	it("avoids rewriting locations when the source already is the destination", async () => {
		await Tag.rename([8], "destination");
		expect(Edit.work).not.toHaveBeenCalled();
	});
	it("waits for records to exist before assigning their ids to locations", async () => {
		let finish!: (value: Awaited<ReturnType<typeof Edit.values>>) => void;
		vi.mocked(Edit.values).mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const selector = { type: "Everything" as const };
		const pending = Tag.assign(selector, [{ name: "a" }, { name: "b" }]);
		expect(Edit.work).not.toHaveBeenCalled();
		finish({ mutation: { version: 1, keys: [8, 12] } });
		expect(await pending).toMatchObject({ changed: 3 });
		expect(Edit.work).toHaveBeenCalledExactlyOnceWith(selector, {
			kind: "listSet",
			key: "tags",
			add: [8, 12],
			remove: [],
		});
	});
	it.each(["rename", "assign"] as const)(
		"does not assign locations when %s record creation fails",
		async (operation) => {
			const error = new Error("write failed");
			vi.mocked(Edit.values).mockRejectedValue(error);
			const pending =
				operation === "rename"
					? Tag.rename([2], "new")
					: Tag.assign({ type: "Everything" }, [{ name: "new" }]);
			await expect(pending).rejects.toBe(error);
			expect(Edit.work).not.toHaveBeenCalled();
		},
	);
	it("propagates an assignment failure after the records were created", async () => {
		const error = new Error("assignment failed");
		vi.mocked(Edit.work).mockRejectedValue(error);
		await expect(
			Tag.assign({ type: "Everything" }, [{ name: "new" } satisfies Omit<ValueRecord, "id">]),
		).rejects.toBe(error);
		expect(Edit.values).toHaveBeenCalledOnce();
	});
});
