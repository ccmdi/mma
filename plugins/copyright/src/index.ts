import type { Location, ExtraFieldDef, EnrichCtx } from "mma-plugin-types";

const BINARY_NAME = "mma-copyright";

const IS_WIN = navigator.userAgent.includes("Windows");
const SEP = IS_WIN ? "\\" : "/";

let _pluginDir: string | null = null;
async function pluginDir(): Promise<string> {
	if (!_pluginDir) {
		const appData = await MMA.cmd.getAppDataDir();
		_pluginDir = `${appData}${SEP}plugins${SEP}copyright`;
	}
	return _pluginDir;
}

// Models ship inside the sidecar bundle, extracted next to the binary.
async function modelDir(): Promise<string> {
	return `${await pluginDir()}${SEP}sidecar${SEP}models`;
}

let tempCounter = 0;

async function writeInputFile(data: unknown): Promise<string> {
	const name = `mma_copyright_${Date.now()}_${tempCounter++}.json`;
	return MMA.cmd.writeTempFile(name, JSON.stringify(data));
}

interface DetectResult {
	panoId: string;
	year: number | null;
	text?: string;
	error?: string;
	done?: number;
	total?: number;
}

const FIELD_DEFS: Record<string, ExtraFieldDef> = {
	copyrightYear: { type: "number", label: "Copyright year" },
};

function fieldRequested(enrichFields: string[] | null): boolean {
	return !enrichFields || enrichFields.includes("copyrightYear");
}

function usableLocations(
	locations: Location[],
	enrichFields: string[] | null,
	force?: boolean,
): Location[] {
	if (!fieldRequested(enrichFields)) return [];
	return locations.filter(
		(l) => typeof l.panoId === "string" && l.panoId.length > 0 && (force || l.extra?.copyrightYear == null),
	);
}

async function enrich(
	locations: Location[],
	enrichFields: string[] | null,
	ctx?: EnrichCtx,
): Promise<Map<number, Record<string, unknown>>> {
	const patches = new Map<number, Record<string, unknown>>();

	const usable = usableLocations(locations, enrichFields, ctx?.force);
	if (usable.length === 0 || ctx?.signal?.aborted) return patches;

	const idsByPano = new Map<string, number[]>();
	for (const loc of usable) {
		const panoId = loc.panoId as string;
		const ids = idsByPano.get(panoId);
		if (ids) ids.push(loc.id);
		else idsByPano.set(panoId, [loc.id]);
	}
	const panoIds = Array.from(idsByPano.keys());

	const inputPath = await writeInputFile({ panoIds });
	const md = await modelDir();
	const proc = await MMA.sidecar.spawn("copyright", BINARY_NAME, [
		"detect",
		"--input",
		inputPath,
		"--model-dir",
		md,
	]);

	const abortHandler = () => proc.kill();
	ctx?.signal?.addEventListener("abort", abortHandler);

	proc.onStderr((line) => console.error("[copyright]", line));
	proc.onLine((line) => {
		let result: DetectResult;
		try {
			result = JSON.parse(line);
		} catch {
			return;
		}
		const ids = idsByPano.get(result.panoId);
		if (!ids) return;
		for (const id of ids) {
			if (result.error) {
				ctx?.onFail?.(id);
			} else if (result.year != null) {
				patches.set(id, { copyrightYear: result.year });
			}
			ctx?.onUnit?.();
		}
	});

	await new Promise<void>((resolve) => proc.onExit(() => resolve()));
	ctx?.signal?.removeEventListener("abort", abortHandler);

	return patches;
}

MMA.registerPlugin({
	activate() {
		MMA.registerEnrichFields([
			{ key: "copyrightYear", label: "Copyright year" },
		]);
		MMA.registerEnrichmentProvider({
			id: "copyright",
			label: "Copyright year",
			enrich,
			fieldDefs: FIELD_DEFS,
			units: (locations, enrichFields, force) => usableLocations(locations, enrichFields, force).length,
			transform(_field, value, loc) {
				if (loc.extra?.imageDate && Number((loc.extra.imageDate as string).slice(0, 4)) > Number(value)) return null;
				return `© ${value}`;
			},
		});
	},
	comingSoon: true,
});
