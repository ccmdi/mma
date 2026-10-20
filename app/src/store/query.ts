import type { Answer, Ask, LocationList, Location, Target } from "@/bindings.gen";
import type { Selector } from "@/types";
import { cmd } from "@/lib/commands";
import { mmaBufUrl } from "@/lib/util/util";
export type AnswerOf<K extends Answer["kind"]> = Extract<Answer, { kind: K }>;

// A single payload field becomes its value; several fields stay together.
type Payload<T> = {
	[K in keyof T]: Exclude<keyof T, K> extends never ? T[K] : T;
}[keyof T];

type Materialized<T> = T extends LocationList ? Location[] : T;

export type ReadResult<A extends Answer> = A extends Answer
	? Materialized<Payload<Omit<A, "kind">>>
	: never;

/** Read locations and summaries for a selector. @api */
export const Query = {
	/** Ask one question about the locations `selector` matches. A full-location answer loads any
	 *  backing file automatically; ask for ids or columns when full locations are unnecessary. */
	read: async <A extends Ask>(
		selector: Selector,
		ask: A,
		target: Target = { kind: "map" },
	): Promise<ReadResult<AnswerOf<A["kind"]>>> => {
		const answer = await cmd.storeRead(target, selector, ask);
		if (answer.kind !== ask.kind)
			throw new Error(`read answered ${answer.kind}, expected ${ask.kind}`);
		const { kind: _, ...payload } = answer;
		const values = Object.values(payload);
		const value = values.length === 1 ? values[0] : payload;
		// Buffered payloads carry their own transport tag; ordinary payloads do not.
		const result =
			value && typeof value === "object" && "kind" in value
				? await Query.locationsOf(value)
				: value;
		return result as ReadResult<AnswerOf<A["kind"]>>;
	},
	/** The locations an answer carries, fetched from its temp file when it was too large to send inline. */
	locationsOf: async (list: LocationList): Promise<Location[]> => {
		return list.kind === "inline" ? list.locations : (await fetch(mmaBufUrl(list.path))).json();
	},
};
