import { formatBytes } from "@/lib/util/format";
import type { Diagnostics } from "@/lib/diagnostics";

export type ReportKind = "bug" | "idea";

export interface ReportInput {
	kind: ReportKind;
	title: string;
	description: string;
	/** Bug reports only. */
	steps?: string;
}

/** What the machine-readable block carries. */
export interface ReportMeta {
	v: 1;
	kind: ReportKind;
	anonymous: boolean;
	/** Null when the diagnostics are absent; `diagnosticsOmitted` says why. */
	diagnostics: Diagnostics | null;
	/** `declined` = the user withheld them, `size` = they would not fit. */
	diagnosticsOmitted?: "declined" | "size";
}

const MARKER = "mma-report";

/** GitHub rejects bodies over 65536 characters, so this is a hard ceiling */
const MAX_BODY = 65000;

function table(rows: Array<[string, string | number]>): string {
	return [
		"| Field | Value |",
		"| --- | --- |",
		...rows.map(([k, v]) => `| ${k} | ${String(v).replace(/\|/g, "\\|")} |`),
	].join("\n");
}

function details(summary: string, inner: string): string {
	return `<details>\n<summary>${summary}</summary>\n\n${inner}\n\n</details>`;
}

function json(value: unknown): string {
	return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}

function attachedDiagnostics(d: Diagnostics, attach: Attachments): Diagnostics | null {
	if (!attach.diagnostics) return null;
	if (attach.settings) return d;
	return {
		...d,
		changedSettings: {},
		map: d.map ? { ...d.map, changedSettings: {} } : null,
	};
}

function diagnosticsTable(d: Diagnostics): string {
	const rows: Array<[string, string | number]> = [
		["App", `${d.appVersion} (${d.buildMode})`],
		["Renderer", d.webglRenderer],
		["Viewport", `${d.viewport} @ ${d.devicePixelRatio}x`],
		["User agent", d.userAgent],
		["opensv", d.opensvVersion],
		["Startup", `${d.startupMs} ms`],
		[
			"Database",
			`${d.db.maps} maps, ${d.db.locations} locations, ${d.db.tags} tags, ${d.db.commits} commits, ` +
				`${formatBytes(d.db.sizeBytes)} (${d.db.journalMode})`,
		],
		["Plugins", d.plugins.length ? d.plugins.join(", ") : "none"],
	];
	if (d.map) {
		rows.push([
			"Open map",
			`${d.map.locationCount} locations, ${d.map.tagCount} tags, ${d.map.dirtyCount} unsaved`,
		]);
	}
	return table(rows);
}

/** Hides the block from the rendered issue while keeping it greppable and parseable.
 *  `>` is escaped so a value containing `-->` cannot terminate the comment early. */
function machineBlock(meta: ReportMeta): string {
	const encoded = JSON.stringify(meta).replace(/>/g, "\\u003e");
	return `<!-- ${MARKER} ${encoded} -->`;
}

/** Recover the structured payload from an issue body. The counterpart to
 *  {@link machineBlock}; what any automation over these issues should use rather than
 *  scraping the prose. */
export function parseReportBody(body: string): ReportMeta | null {
	const start = body.indexOf(`<!-- ${MARKER} `);
	if (start === -1) return null;
	const from = start + `<!-- ${MARKER} `.length;
	const end = body.indexOf(" -->", from);
	if (end === -1) return null;
	try {
		return JSON.parse(body.slice(from, end)) as ReportMeta;
	} catch {
		return null;
	}
}

export interface Attachments {
	diagnostics: boolean;
	settings: boolean;
	log: boolean;
}

export function buildIssueBody(
	input: ReportInput,
	diagnostics: Diagnostics,
	opts: {
		anonymous: boolean;
		logTail?: string;
		attach: Attachments;
		/** Images already stored, in the order they should appear. */
		images?: Array<{ url: string; name: string }>;
	},
): string {
	const parts = [input.description.trim()];

	if (input.kind === "bug" && input.steps?.trim()) {
		parts.push(`### Steps to reproduce\n\n${input.steps.trim()}`);
	}

	// Above the diagnostics: a screenshot is the part a human reads first.
	if (opts.images?.length) {
		parts.push(opts.images.map((i) => `![${i.name}](${i.url})`).join("\n\n"));
	}

	if (opts.attach.diagnostics) {
		parts.push(details("Diagnostics", diagnosticsTable(diagnostics)));
	}

	const changed = opts.attach.settings
		? {
				...(Object.keys(diagnostics.changedSettings).length
					? { app: diagnostics.changedSettings }
					: {}),
				...(diagnostics.map && Object.keys(diagnostics.map.changedSettings).length
					? { map: diagnostics.map.changedSettings }
					: {}),
			}
		: {};
	if (Object.keys(changed).length) {
		parts.push(details("Non-default settings", json(changed)));
	}

	// The machine block is what automation reads, so it is the last thing trimmed -- but it is
	// built from unbounded input, so it can overflow on its own. Past half the budget it drops
	// its payload rather than crowding out the report the human wrote.
	const payload = attachedDiagnostics(diagnostics, opts.attach);
	let meta = machineBlock({
		v: 1,
		kind: input.kind,
		anonymous: opts.anonymous,
		diagnostics: payload,
		...(payload ? {} : { diagnosticsOmitted: "declined" as const }),
	});
	if (meta.length > MAX_BODY / 2) {
		meta = machineBlock({
			v: 1,
			kind: input.kind,
			anonymous: opts.anonymous,
			diagnostics: null,
			diagnosticsOmitted: "size",
		});
	}

	const room = MAX_BODY - meta.length - 2;

	if (opts.attach.log && opts.logTail?.trim()) {
		const budget = room - parts.join("\n\n").length - 64;
		// Too little room left to be worth a section, so the log is dropped rather than
		// squeezed down to a useless fragment.
		if (budget > 256) {
			parts.push(details("Log", "```\n" + opts.logTail.slice(-budget).trim() + "\n```"));
		}
	}

	let content = parts.join("\n\n");
	if (content.length > room) {
		const notice = "\n\n_(truncated)_";
		content = content.slice(0, Math.max(0, room - notice.length)) + notice;
	}
	return `${content}\n\n${meta}`;
}
