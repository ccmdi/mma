import { describe, expect, it } from "vitest";
import type { Layer } from "@deck.gl/core";
import { replayLayers, type ReplayPin } from "@/plugins/localguessr/gameMap";
import type { RoundResult } from "@/plugins/localguessr/game";

function round(id: number, guessed: boolean): Pick<RoundResult, "location" | "guess"> {
	return {
		location: { id, lat: id, lng: 0, heading: 0, pitch: 0, zoom: 0, panoId: null },
		guess: guessed ? { lat: id, lng: 1 } : null,
	};
}

const results = [round(10, true), round(11, false), round(12, true)];

function draw(highlighted: number | null, settledZoom: number | null): Layer[] {
	return replayLayers(results, highlighted, settledZoom);
}

function layer(layers: Layer[], id: string) {
	return layers.find((l) => l.id === id);
}

function rounds(l: Layer | undefined): number[] {
	return ((l?.props.data ?? []) as ReplayPin[]).map((p) => p.round);
}

describe("replay layers", () => {
	it("draw every answer and only the rounds that were guessed", () => {
		const layers = draw(null, 3);
		expect(rounds(layer(layers, "lg-replay-truth"))).toEqual([0, 1, 2]);
		expect(rounds(layer(layers, "lg-replay-guess"))).toEqual([0, 2]);
		expect(layer(layers, "lg-replay-line")?.props.data).toHaveLength(2);
	});

	it("number answers from one", () => {
		const text = layer(draw(null, 3), "lg-replay-n")!;
		const { getText } = text.props as unknown as { getText: (d: ReplayPin) => string };
		expect((text.props.data as ReplayPin[]).map(getText)).toEqual(["1", "2", "3"]);
	});

	it("wait for a settled zoom before drawing lines", () => {
		expect(layer(draw(null, null), "lg-replay-line")).toBeUndefined();
	});

	it("dim every other round beneath a highlighted one", () => {
		const layers = draw(2, 3);
		const dimmed = layer(layers, "lg-replay-truth")!;
		const active = layer(layers, "lg-replay-active-truth")!;
		expect(rounds(dimmed)).toEqual([0, 1]);
		expect(rounds(active)).toEqual([2]);
		expect(dimmed.props.opacity).toBeLessThan(1);
		expect(active.props.opacity).toBe(1);
		expect(layers.indexOf(active)).toBeGreaterThan(layers.indexOf(dimmed));
	});
});
