import assert from "node:assert/strict";
import test from "node:test";
import { checkReleaseTags } from "./check-sidecars.mjs";

const registry = [
	{
		id: "copyright",
		sidecar: { name: "mma-copyright", version: "0.7.0" },
		builds: [{ version: "0.6.0", sidecar: { name: "mma-copyright", version: "0.6.0" } }],
	},
	{ id: "heatmap", builds: [{ version: "0.1.0" }] },
];

const remote = (...tags) => () =>
	tags.map((tag, i) => `${String(i).padStart(40, "0")}\trefs/tags/${tag}`).join("\n");

const unreachable = () => {
	throw new Error("fatal: unable to access origin\nmore detail");
};

test("passes when every sidecar release tag is on origin", () => {
	assert.deepEqual(
		checkReleaseTags(registry, remote("copyright-v0.7.0", "copyright-v0.6.0", "v0.11.6"), true),
		{ errors: [], warnings: [] },
	);
});

test("fails naming each missing release tag", () => {
	assert.deepEqual(checkReleaseTags(registry, remote("copyright-v0.6.0^{}"), true), {
		errors: ["registry.json names sidecar release copyright-v0.7.0, missing on origin"],
		warnings: [],
	});
});

test("warns outside CI when origin is unreachable", () => {
	assert.deepEqual(checkReleaseTags(registry, unreachable, false), {
		errors: [],
		warnings: ["cannot list origin tags (fatal: unable to access origin)"],
	});
});

test("fails in CI when origin is unreachable", () => {
	assert.deepEqual(checkReleaseTags(registry, unreachable, true), {
		errors: ["cannot list origin tags (fatal: unable to access origin)"],
		warnings: [],
	});
});
