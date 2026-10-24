import type { Answer, Ask, LocationList, Location, Target } from "@/bindings.gen";
import type { Selector } from "@/types";
import { cmd } from "@/lib/commands";
import { each, mmaBufUrl, type Each } from "@/lib/util/util";
export type AnswerOf<K extends Answer["kind"]> = Extract<Answer, { kind: K }>;

// A single payload field becomes its value; several fields stay together.
type Payload<T> = {
	[K in keyof T]: Exclude<keyof T, K> extends never ? T[K] : T;
}[keyof T];

type Materialized<T> = T extends LocationList ? Location[] : T;

export type ReadResult<A extends Answer> = A extends Answer
	? Materialized<Payload<Omit<A, "kind">>>
	: never;

/** Read locations and summaries for selectors. @api */
export const Query = {
	/** Ask one question about the locations a selector matches, or about each of a list of
	 *  selectors in one read, answered in order. A full-location answer loads any backing file
	 *  automatically; ask for ids or columns when full locations are unnecessary. */
	read: <A extends Ask, I extends Selector | readonly Selector[] = Selector>(
		selectors: I,
		ask: A,
		target: Target = { kind: "map" },
	): Promise<Each<I, ReadResult<AnswerOf<A["kind"]>>>> =>
		each(selectors, async (all: Selector[]) => {
			const answers = await cmd.storeRead(target, all, ask);
			return Promise.all(
				answers.map(async (answer) => {
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
				}),
			);
		}),
	/** The locations an answer carries, fetched from its temp file when it was too large to send inline. */
	locationsOf: async (list: LocationList): Promise<Location[]> => {
		return list.kind === "inline" ? list.locations : (await fetch(mmaBufUrl(list.path))).json();
	},
};
