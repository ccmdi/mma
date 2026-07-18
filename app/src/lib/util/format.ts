export const APP_NAME = "Map Making App";

export const fmt = new Intl.NumberFormat("en");
export const dateFmt = new Intl.DateTimeFormat("en-US", {
	year: "numeric",
	month: "short",
});
export const shortDateFmt = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	year: "numeric",
});
/** Day-level date like "21 May 2021" (alt pano providers / historical pickers). */
export const panoDayFmt = new Intl.DateTimeFormat("en-GB", {
	day: "numeric",
	month: "short",
	year: "numeric",
});

/** Location timestamps are Unix seconds; JS Date wants milliseconds. */
export function locDate(secs: number): Date {
	return new Date(secs * 1000);
}

/** Compact local-time "YYYY-MM-DD HH:MM" for a Unix-seconds instant. Matches the
 *  local-time interpretation the DatePicker uses, so filter chips agree with it. */
export function localDateTime(secs: number): string {
	const d = new Date(secs * 1000);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Compact "YYYY-MM-DD HH:MM" reading the instant in UTC. For wall-clock values
 *  that encode the picked numbers as a UTC epoch (DatePicker `wallClock` mode). */
export function utcDateTime(secs: number): string {
	return new Date(secs * 1000).toISOString().slice(0, 16).replace("T", " ");
}

/** Current time as Unix seconds, the form Location timestamps use. */
export function nowUnix(): number {
	return Math.floor(Date.now() / 1000);
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export function relativeTime(time: string | number): string {
	const ms = typeof time === "number" ? time * 1000 : new Date(time).getTime();
	const delta = Date.now() - ms;
	if (delta < MINUTE) return "just now";
	if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
	if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
	if (delta < 30 * DAY) return `${Math.floor(delta / DAY)}d ago`;
	return shortDateFmt.format(new Date(ms));
}
