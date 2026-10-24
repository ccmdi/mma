import { useMap } from "./helpers";

type Focus = "page" | "field";
type Case = { keys: string[]; focus: Focus; kept: boolean };

const KEPT_ON_PAGE = [
	["Control", "v"],
	["Control", "Shift", "v"],
	["Control", "c"],
	["Shift", "Insert"],
];
const KEPT_IN_FIELD = [
	["Control", "v"],
	["Control", "Shift", "v"],
	["Control", "c"],
	["Control", "x"],
	["Control", "a"],
	["Control", "z"],
	["Control", "y"],
	["Control", "Shift", "z"],
	["Control", "ArrowLeft"],
	["Control", "ArrowRight"],
	["Control", "Backspace"],
	["Control", "Delete"],
	["Control", "Home"],
	["Control", "End"],
	["Shift", "Insert"],
];
const BLOCKED = [
	["Control", "p"],
	["Control", "f"],
	["Control", "u"],
	["Control", "g"],
];

const CASES: Case[] = [
	...KEPT_ON_PAGE.map((keys) => ({ keys, focus: "page" as const, kept: true })),
	...KEPT_IN_FIELD.map((keys) => ({ keys, focus: "field" as const, kept: true })),
	...BLOCKED.map((keys) => ({ keys, focus: "page" as const, kept: false })),
	...BLOCKED.map((keys) => ({ keys, focus: "field" as const, kept: false })),
];

async function focus(where: Focus) {
	await browser.execute((field) => {
		const probe = document.getElementById("key-probe");
		if (field) {
			const input = probe ?? document.body.appendChild(document.createElement("input"));
			input.id = "key-probe";
			input.focus();
		} else {
			probe?.remove();
			(document.activeElement as HTMLElement | null)?.blur();
		}
	}, where === "field");
}

async function prevented(keys: string[]): Promise<boolean> {
	await browser.execute(() => {
		const w = window as unknown as { __keyVerdicts?: boolean[] };
		if (!w.__keyVerdicts)
			window.addEventListener("keydown", (e) => {
				if (!["Control", "Shift", "Alt", "Meta"].includes(e.key))
					w.__keyVerdicts!.push(e.defaultPrevented);
			});
		w.__keyVerdicts = [];
	});
	await browser.keys(keys);
	const verdicts = await browser.execute(
		() => (window as unknown as { __keyVerdicts: boolean[] }).__keyVerdicts,
	);
	expect(verdicts.length).toBe(1);
	return verdicts[0];
}

describe("Webview input - which unclaimed keys keep their native behavior", () => {
	useMap("E2E Webview Input");

	after(() => focus("page"));

	for (const { keys, focus: where, kept } of CASES) {
		it(`${keys.join("+")} ${kept ? "reaches" : "is blocked from"} the webview (${where})`, async () => {
			await focus(where);
			expect(await prevented(keys)).toBe(!kept);
		});
	}
});
