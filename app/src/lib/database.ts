import { errText } from "@/lib/util/format";

let failure: string | null = null;

/** Whether the app's map database opened at startup. Without it the app still runs, so the
 *  user can update, change the data folder or report the problem, but nothing reads maps. */
export const Database = {
	ready: (): boolean => failure === null,
	/** Why the database did not open, or null when it did. */
	failure: (): string | null => failure,
	fail: (error: unknown) => {
		failure = errText(error);
	},
};
