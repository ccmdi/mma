import type { Ask, Target } from "@/bindings.gen";
import type { Selector } from "@/types";
import { Edit } from "./edit";
import { Mutation } from "./mutation";
import { Store } from "./store";
import { Query, type AnswerOf, type ReadResult } from "./query";
import { cmd } from "@/lib/commands";
import { serial } from "@/lib/util/concurrent";
import { log } from "@/lib/util/log";

type LocationEdits = Parameters<typeof Edit.locations>[1];
type LayerRead = <A extends Ask>(
	selector: Selector,
	ask: A,
) => Promise<ReadResult<AnswerOf<A["kind"]>>>;

/** A pending layer. Operations run in order; work still writing to a landed layer outlives close. @api @unstable */
export class Layer {
	readonly target: Extract<Target, { kind: "pending" }>;
	private readonly queue = serial();
	private closed: Promise<void> | null = null;

	private readonly mapId: string;

	private constructor(mapId: string) {
		this.mapId = mapId;
		this.target = { kind: "pending", name: `layer:${crypto.randomUUID()}` };
	}

	/** Create a layer and stage its first edits. */
	static async open(edits: LocationEdits = []): Promise<Layer> {
		const mapId = Store.get().mapId;
		if (!mapId) throw new Error("No map is open");
		const layer = new Layer(mapId);
		try {
			await layer.edit(edits);
			return layer;
		} catch (error) {
			await layer.close();
			throw error;
		}
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		if (this.closed) return Promise.reject(new Error("Layer is closed"));
		return this.queue(() => {
			if (Store.get().mapId !== this.mapId) throw new Error("Layer belongs to another map");
			return operation();
		});
	}

	/** Read through the layer after its earlier operations finish. */
	read<A extends Ask>(selector: Selector, ask: A) {
		return this.enqueue(() => Query.read(selector, ask, this.target));
	}

	/** Stage location edits using the shared mutation path. */
	edit(edits: LocationEdits | ((read: LayerRead) => Promise<LocationEdits>)) {
		return this.enqueue(async () => {
			const changes =
				typeof edits === "function"
					? await edits((selector, ask) => Query.read(selector, ask, this.target))
					: edits;
			if (Store.get().mapId !== this.mapId) throw new Error("Layer belongs to another map");
			return Edit.locations(this.target, changes);
		});
	}

	/** Land the layer's edits as one undo step, resolving once the map accepts them; later writes to the layer join that step. A layer lands once. */
	land() {
		return this.enqueue(async () => {
			if (!Store.get().map) return Mutation.none();
			const result = await cmd.storeLandLayer(this.target.name);
			void Mutation.settle(result).catch((error) =>
				log.error("[layer] land failed to settle:", error),
			);
			return result;
		});
	}

	/** Close after queued operations finish. Edits not yet landed are discarded. */
	close(): Promise<void> {
		return (this.closed ??= this.queue(async () => {
			await cmd.storeCloseLayer(this.target.name, this.mapId);
		}));
	}
}
