import { readFileSync } from "node:fs";

export interface MirrorCases {
	yearMonth: { valid: [string, number, number][]; invalid: string[] };
	officialPano: { official: string[]; unofficial: string[] };
	lngDelta: [number, number, number][];
}

export const mirrorCases: MirrorCases = JSON.parse(
	readFileSync(new URL("../../fixtures/mirrors.json", import.meta.url), "utf-8"),
);
