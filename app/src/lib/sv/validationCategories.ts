import { ValidationFlag } from "@/bindings.consts";
import { msg } from "@/lib/i18n";

/** What validation answers for one location: its `ValidationFlag`s, and whether it was
 *  pinned when checked. */
export interface ValidationAnswer {
	flags: number;
	pinned: boolean;
}

/** A group of validated locations a user can ask for: a single flag, or a combination of
 *  flags and pinned state. */
export interface ValidationCategory {
	key: string;
	label: string;
	/** Asked for unless the user says otherwise. */
	standard: boolean;
	test: (answer: ValidationAnswer) => boolean;
}

const has = (a: ValidationAnswer, flag: ValidationFlag) => (a.flags & flag) !== 0;

/** @api @unstable */
export const VALIDATION_CATEGORIES: readonly ValidationCategory[] = [
	{
		key: "valid",
		label: msg("Valid location"),
		standard: true,
		test: (a) => a.flags === ValidationFlag.None,
	},
	{
		key: "updateAvailable",
		label: msg("Newer coverage available"),
		standard: true,
		test: (a) => a.pinned && has(a, ValidationFlag.Newer),
	},
	{
		key: "updateApplied",
		label: msg("Coverage updated since last view"),
		standard: true,
		test: (a) => !a.pinned && has(a, ValidationFlag.Newer),
	},
	{
		key: "notFound",
		label: msg("Not found"),
		standard: true,
		test: (a) => has(a, ValidationFlag.NotFound),
	},
	{
		key: "panoIdBroke",
		label: msg("Pano ID broke"),
		standard: true,
		test: (a) => has(a, ValidationFlag.PanoIdBroke),
	},
	{
		key: "unofficial",
		label: msg("Unofficial"),
		standard: true,
		test: (a) => has(a, ValidationFlag.Unofficial),
	},
	{
		key: "goodcamAvailable",
		label: msg("Badcam, but good coverage available"),
		standard: true,
		test: (a) => has(a, ValidationFlag.GoodcamAvailable),
	},
	{
		key: "newer",
		label: msg("Newer coverage than the stored pano"),
		standard: false,
		test: (a) => has(a, ValidationFlag.Newer),
	},
	{
		key: "offDefault",
		label: msg("Pinned away from the default pano"),
		standard: false,
		test: (a) => has(a, ValidationFlag.OffDefault),
	},
	{
		key: "defaultStale",
		label: msg("Default pano is not the newest"),
		standard: false,
		test: (a) => has(a, ValidationFlag.DefaultStale),
	},
];

/** @api @unstable */
export const STANDARD_VALIDATION_CATEGORIES = VALIDATION_CATEGORIES.filter((c) => c.standard).map(
	(c) => c.key,
);

/** The category a key names, or null for one this version does not know. @api @unstable */
export function validationCategory(key: string): ValidationCategory | null {
	return VALIDATION_CATEGORIES.find((c) => c.key === key) ?? null;
}
