import type { Selector } from "@/types";
import { ValidationFlag } from "@/bindings.consts";
import {
	Procedure,
	type BatchOutcome,
	type BulkOpts,
	type ProcedureSpec,
} from "@/lib/data/procedure";
import {
	STANDARD_VALIDATION_CATEGORIES,
	VALIDATION_CATEGORIES,
	type ValidationAnswer,
} from "@/lib/sv/validationCategories";
import { SV_SEARCH_RADIUS } from "@/lib/sv/constants";
import { log } from "@/lib/util/log";
import { msg } from "@/lib/i18n";

/** Configuration for Street View validation: the radius of the coordinate lookup. */
export interface ValidateConfig {
	radius: number;
}

/** Street View coverage validation. Checks each location's stored pano, coordinate
 *  lookup, unofficial status, camera quality, and timeline. Answers with a
 *  `ValidationAnswer` per location without writing anything. */
const validateSpec: ProcedureSpec<ValidationAnswer, ValidateConfig> = {
	entry: Procedure.entry("validate"),
	batch: { mode: "chunk", size: 200 },
	sink: "collect",
	config: { radius: SV_SEARCH_RADIUS },
};

const KNOWN_BITS = Object.values(ValidationFlag).reduce<number>((all, f) => all | f, 0);

/** What a validation run answered: the ids in each asked-for category that any location
 *  fell into, keyed by category in table order, over the outcome every run reports. */
export interface ValidationOutcome extends BatchOutcome {
	categories: Map<string, number[]>;
}

/** Check that each location's Street View coverage still exists, grouping the locations
 *  into `categories` (keys of `VALIDATION_CATEGORIES`; the standard ones when omitted). */
export async function validateLocations(
	selector: Selector,
	opts: BulkOpts & { config?: Partial<ValidateConfig>; categories?: readonly string[] } = {},
): Promise<ValidationOutcome> {
	const { categories: asked = STANDARD_VALIDATION_CATEGORIES, ...runOpts } = opts;
	const run = await Procedure.run(validateSpec, selector, {
		id: "validate",
		label: msg("Validating"),
		...runOpts,
	});

	const wanted = VALIDATION_CATEGORIES.filter((c) => asked.includes(c.key));
	const ids = wanted.map((): number[] => []);
	for (const { id, value: answer } of run.collected ?? []) {
		if ((answer.flags & ~KNOWN_BITS) !== 0) {
			log.warn(`[validate] location ${id}: unknown validation flags ${String(answer.flags)}`);
			continue;
		}
		wanted.forEach((c, i) => {
			if (c.test(answer)) ids[i].push(id);
		});
	}
	const categories = new Map(
		wanted.flatMap((c, i) => (ids[i].length > 0 ? [[c.key, ids[i]] as const] : [])),
	);
	return { succeeded: run.succeeded, failed: run.failed, categories };
}
