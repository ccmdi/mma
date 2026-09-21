import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { RESIZE_EASING, RESIZE_MS } from "@/components/primitives/Dialog";

const SRC = join(__dirname, "../../src");

interface Decl {
	file: string;
	selector: string;
	prop: string;
	value: string;
	line: number;
}

function cssFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) cssFiles(path, out);
		else if (entry.name.endsWith(".css")) out.push(path);
	}
	return out;
}

function parse(file: string, css: string): Decl[] {
	const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
	const decls: Decl[] = [];
	const stack: string[] = [];
	let buf = "";
	let line = 1;
	let start = 1;
	let parens = 0;
	let quote: string | null = null;
	for (const ch of text) {
		if (ch === "\n") line++;
		if (quote) {
			buf += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === "(") parens++;
		else if (ch === ")") parens--;
		else if (parens === 0 && (ch === "{" || ch === "}" || ch === ";")) {
			const chunk = buf.trim().replace(/\s+/g, " ");
			buf = "";
			if (ch === "{") {
				stack.push(chunk);
				continue;
			}
			const colon = chunk.indexOf(":");
			if (colon > 0 && stack.length > 0 && !chunk.startsWith("@")) {
				decls.push({
					file,
					selector: stack[stack.length - 1],
					prop: chunk.slice(0, colon).trim(),
					value: chunk.slice(colon + 1).trim(),
					line: start,
				});
			}
			if (ch === "}") stack.pop();
			continue;
		}
		if (buf.trim() === "" && !/\s/.test(ch)) start = line;
		buf += ch;
	}
	return decls;
}

const DECLS = cssFiles(SRC).flatMap((path) =>
	parse(relative(SRC, path).replace(/\\/g, "/"), readFileSync(path, "utf8")),
);
const where = (d: Decl) => `${d.file}:${d.line} ${d.selector} { ${d.prop}: ${d.value} }`;

/** Custom properties whose value is written from script, so no stylesheet defines them. */
const SET_INLINE: Record<string, string> = {
	"--fill": "Slider sets its fill percentage",
	"--fs-mini-flip": "FullscreenMiniLocationPreview animates its FLIP scale",
	"--fs-mini-k": "FullscreenMiniLocationPreview sets its collapsed scale",
	"--fs-mini-loc-w": "FullscreenMiniLocationPreview sets its expanded size",
	"--fs-mini-loc-h": "FullscreenMiniLocationPreview sets its expanded size",
	"--fs-minimap-w": "FullscreenMiniMap sets its expanded size",
	"--fs-minimap-h": "FullscreenMiniMap sets its expanded size",
	"--lg-map-w": "the LocalGuessr guess map sets its expanded size",
	"--lg-map-h": "the LocalGuessr guess map sets its expanded size",
	"--spinner-size": "Spinner sets its size",
	"--tag-gap": "the tag gap setting is mirrored onto :root",
};

/** A selector for a BEM block and every element and modifier of it. */
function block(name: string): RegExp {
	return new RegExp(`^\\.${name}(?:(?:__|--)[\\w-]+)*(?![\\w-])`);
}

/** Rules that keep literal colors: they mirror map-making.app's own chrome, or draw over imagery. */
const LITERAL_COLORS: { selector: RegExp; why: string }[] = [
	{ selector: /^\.modal(::backdrop|__backdrop)$/, why: "the dialog scrim" },
	{
		selector: /^\.icon-button--overlay(?![\w-])/,
		why: "icon buttons drawn over map or pano imagery",
	},
	{ selector: block("badge"), why: "map-making.app camera badges" },
	{ selector: block("map-link"), why: "map-making.app map list" },
	{ selector: block("map-list"), why: "map-making.app map list" },
	{ selector: block("map-control"), why: "Google-style white map controls" },
	{ selector: block("compass"), why: "Google-style map compass" },
	{ selector: block("compass-control"), why: "compass links drawn over the pano" },
	{ selector: block("map-type-control"), why: "Google-style map type buttons" },
	{ selector: block("measurement-control"), why: "text inside a white map control" },
	{ selector: block("search-control"), why: "the geocoder keeps Google's light dropdown" },
	{ selector: block("opacity-target-toggle"), why: "button inside a white map control" },
	{
		selector: /^input\[type="range"\]\.slider\.sv-opacity-control__slider(?![\w-])/,
		why: "slider track inside a white map control",
	},
	{ selector: block("sv-preview-control"), why: "caption inside a white map control" },
	{ selector: block("coordinate-control"), why: "map-making.app coordinate readout on the map" },
	{ selector: block("tag"), why: "map-making.app tag pills: white selection outlines" },
	{ selector: block("tag-tree"), why: "tag pills: white selection outlines" },
	{ selector: block("duplicate-item"), why: "map-making.app thumbnail selection outline" },
	{ selector: /^\.map-embed \.loading$/, why: "text over map tiles" },
	{ selector: block("map-cursor-crosshair"), why: "drawn over map tiles" },
	{ selector: /^\.location-preview__panorama\.is-fullscreen$/, why: "letterbox behind the pano" },
	{ selector: block("compass-tape"), why: "drawn over the pano" },
	{ selector: block("file-drop-overlay"), why: "scrim over the editor" },
	{ selector: block("fullscreen-minimap"), why: "drawn over the pano" },
	{ selector: block("fullscreen-mini-location"), why: "drawn over the map" },
	{ selector: block("scale-stepper"), why: "drawn over the minimap or the location preview" },
	{ selector: block("fullscreen-tagbar"), why: "drawn over the pano" },
	{ selector: block("fullscreen-geocode"), why: "drawn over the pano" },
	{ selector: block("lg-hud"), why: "drawn over the pano" },
	{ selector: block("lg-round"), why: "buttons drawn over the pano" },
	{ selector: block("lg-guess-map"), why: "buttons drawn over the guess map" },
	{
		selector: block("doclink-panel__body--fallback"),
		why: "a Google Doc rendered with its own light styling",
	},
];

const NAMED_COLORS = new Set(
	"aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen".split(
		" ",
	),
);
const COLOR =
	/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\((?![^)]*\b(?:var|from)\b)[^)]*\)|(?<![\w-])[a-z]+(?![\w-])/gi;
const BLACK = /^(#0{3}[0-9a-f]?|#0{6}([0-9a-f]{2})?|rgba?\(\s*0[\s,]+0[\s,]+0\b.*|black)$/i;

/** Literal colors in a declaration. Masks are alpha only, and shadows are black ink in any theme. */
function literalColors({ prop, value }: Decl): string[] {
	if (prop.startsWith("--") || /^(-webkit-)?mask/.test(prop)) return [];
	const bare = value.replace(/url\([^)]*\)/g, "").replace(/"[^"]*"|'[^']*'/g, "");
	const shadow = /shadow|^filter$/.test(prop);
	return [...bare.matchAll(COLOR)]
		.map((m) => m[0])
		.filter((c) => c.startsWith("#") || c.includes("(") || NAMED_COLORS.has(c.toLowerCase()))
		.filter((c) => !(shadow && BLACK.test(c)));
}

function selectors(list: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let current = "";
	for (const ch of list) {
		if (ch === "(") depth++;
		else if (ch === ")") depth--;
		if (ch === "," && depth === 0) {
			out.push(current.trim());
			current = "";
		} else current += ch;
	}
	out.push(current.trim());
	return out;
}

function token(name: string): string {
	const decl = DECLS.find(
		(d) => d.file === "styles.css" && d.selector === ":root" && d.prop === name,
	);
	if (!decl) throw new Error(`${name} is not defined on :root in styles.css`);
	return decl.value;
}

describe("css tokens", () => {
	it("every var() names a custom property some stylesheet defines", () => {
		const defined = new Set(DECLS.filter((d) => d.prop.startsWith("--")).map((d) => d.prop));
		const undefinedUses = DECLS.flatMap((d) =>
			[...d.value.matchAll(/var\(\s*(--[\w-]+)/g)]
				.map((m) => m[1])
				.filter((name) => !defined.has(name) && !(name in SET_INLINE))
				.map((name) => `${name} in ${where(d)}`),
		);
		expect(undefinedUses).toEqual([]);
	});

	it("colors come from tokens outside the mirrored and over-imagery rules", () => {
		const literals = DECLS.filter((d) => {
			if (literalColors(d).length === 0) return false;
			return !selectors(d.selector).every((sel) =>
				LITERAL_COLORS.some((a) => a.selector.test(sel)),
			);
		}).map(where);
		expect(literals).toEqual([]);
	});

	it("every literal-color allowance still matches a rule with a literal color", () => {
		const used = DECLS.filter((d) => literalColors(d).length > 0).flatMap((d) =>
			selectors(d.selector),
		);
		const stale = LITERAL_COLORS.filter((a) => !used.some((sel) => a.selector.test(sel))).map(
			(a) => `${a.selector} (${a.why})`,
		);
		expect(stale).toEqual([]);
	});

	it("every animation names a keyframe some stylesheet defines", () => {
		const keyframes = new Set(
			cssFiles(SRC).flatMap((path) =>
				[...readFileSync(path, "utf8").matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]),
			),
		);
		const keywords =
			/^(none|infinite|linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end|normal|reverse|alternate|alternate-reverse|forwards|backwards|both|running|paused|initial|inherit|unset)$/;
		const missing = DECLS.filter(
			(d) => d.prop === "animation" || d.prop === "animation-name",
		).flatMap((d) =>
			d.value
				.replace(/[\w-]+\([^)]*\)/g, "")
				.split(/[\s,]+/)
				.filter((word) => /^[a-z][\w-]*$/i.test(word) && !keywords.test(word))
				.filter((name) => !keyframes.has(name))
				.map((name) => `${name} in ${where(d)}`),
		);
		expect(missing).toEqual([]);
	});

	it("the semantic :root block defines every design token", () => {
		const tokens = [
			"surface-0",
			"surface-1",
			"surface-2",
			"surface-3",
			"border-subtle",
			"border-strong",
			"text-1",
			"text-2",
			"text-3",
			"accent",
			"accent-hover",
			"accent-muted",
			"on-accent",
			"action",
			"action-hover",
			"on-action",
			"constructive",
			"destructive",
			"on-destructive",
			"destructive-text",
			"deconstructive",
			"warning",
			"warning-muted",
			"hover",
			"pressed",
			"disabled-opacity",
			"dur-fast",
			"dur",
			"dur-slow",
			"ease-standard",
			"ease-enter",
			"focus-ring",
			"focus-offset",
			"z-chrome",
			"z-modal",
			"z-fullscreen",
			"z-popover",
			"z-toast",
			"z-drag",
			"radius-1",
			"radius-2",
			"radius-3",
			"radius-pill",
			"font-mono",
		];
		for (const name of tokens) expect(token(`--${name}`), name).not.toBe("");
	});

	it("dialog height easing matches the slow motion tokens", () => {
		expect(`${RESIZE_MS}ms`).toBe(token("--dur-slow"));
		expect(RESIZE_EASING).toBe(token("--ease-standard"));
	});
});
