// Test-side encoder for the array-JSON ("json+protobuf") form SingleImageSearch answers:
// a message becomes an array with field `n` at index `n - 1`. Field numbers come from the
// schema itself, so a stub built here matches whatever `getmetadata.array.gen.ts` reads.
import { readFileSync } from "node:fs";
import parse from "protocol-buffers-schema";

const schema = parse(
	readFileSync(new URL("../src/lib/proto/getmetadata.proto", import.meta.url), "utf8"),
);
const messages = new Map(schema.messages.map((m) => [m.name, m]));

/** `obj` (the JSON shape the pbf reader produces) as the array-JSON of message `name`. */
export function toArrayJson(obj, name) {
	const message = messages.get(name);
	if (!message) throw new Error(`arrayJson: unknown message ${name}`);
	const out = [];
	for (const f of message.fields) {
		const v = obj?.[f.name];
		if (v === undefined || v === null) continue;
		const one = (x) => (messages.has(f.type) ? toArrayJson(x, f.type) : x);
		out[f.tag - 1] = f.repeated ? v.map(one) : one(v);
	}
	for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = null;
	return out;
}

/** A SingleImageSearch location-search body answering `meta` (an `ImageMetadata` object). */
export function searchAnswer(meta) {
	return JSON.stringify([[0], toArrayJson(meta, "ImageMetadata"), null]);
}
