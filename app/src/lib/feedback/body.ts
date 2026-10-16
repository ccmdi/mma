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

/** The collapsed sections a report can carry, by what they are titled in the issue. */
export const SECTION_TITLES: Record<keyof Attachments, string> = {
	diagnostics: "Diagnostics",
	settings: "Non-default settings",
	log: "Log",
};

function imageRefs(images: Array<{ url: string; name: string }>): string {
	return images.map((i) => `![${i.name}](${i.url})`).join("\n\n");
}

/** Below 256 characters a log is a useless fragment, so it is left out instead. */
function logSection(logTail: string | undefined, budget: number): string | null {
	if (!logTail?.trim() || budget <= 256) return null;
	return details(SECTION_TITLES.log, "```\n" + logTail.slice(-budget).trim() + "\n```");
}

/** A follow-up on a report, with whatever the reporter attached to it. */
export function buildReplyBody(
	text: string,
	opts: { logTail?: string; images?: Array<{ url: string; name: string }> } = {},
): string {
	const parts = [text.trim()];
	if (opts.images?.length) parts.push(imageRefs(opts.images));
	const log = logSection(opts.logTail, MAX_BODY - parts.join("\n\n").length - 64);
	if (log) parts.push(log);
	return parts.join("\n\n").slice(0, MAX_BODY);
}

/** A report or reply split into what someone wrote and the titles of the collapsed sections
 *  attached to it. */
export function readBody(markdown: string): { text: string; sections: string[] } {
	const sections: string[] = [];
	const text = markdown
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<details>\s*<summary>([\s\S]*?)<\/summary>[\s\S]*?<\/details>/g, (_, summary) => {
			sections.push(String(summary).trim());
			return "";
		})
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { text, sections };
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
			`${d.db.maps} maps, ${d.db.savedLocations} locations, ${d.db.values} values, ${d.db.commits} commits, ` +
				`${formatBytes(d.db.sizeBytes)} + ${formatBytes(d.db.locationSizeBytes)} (${d.db.journalMode})`,
		],
		["Plugins", d.plugins.length ? d.plugins.join(", ") : "none"],
	];
	if (d.map) {
		rows.push([
			"Open map",
			`${d.map.locationCount} locations, ${d.map.tagCount} tags, unsaved: ${d.map.unsaved ? "yes" : "no"}`,
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
	if (opts.images?.length) parts.push(imageRefs(opts.images));

	if (opts.attach.diagnostics) {
		parts.push(details(SECTION_TITLES.diagnostics, diagnosticsTable(diagnostics)));
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
		parts.push(details(SECTION_TITLES.settings, json(changed)));
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

	const log = opts.attach.log
		? logSection(opts.logTail, room - parts.join("\n\n").length - 64)
		: null;
	if (log) parts.push(log);

	let content = parts.join("\n\n");
	if (content.length > room) {
		const notice = "\n\n_(truncated)_";
		content = content.slice(0, Math.max(0, room - notice.length)) + notice;
	}
	return `${content}\n\n${meta}`;
}
