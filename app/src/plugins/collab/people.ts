import type { Member, RGB } from "@/bindings.gen";
import { t } from "@/lib/i18n";

const GUEST = "guest--";

const PALETTE: RGB[] = [
	[236, 72, 153],
	[59, 130, 246],
	[34, 197, 94],
	[249, 115, 22],
	[168, 85, 247],
	[234, 179, 8],
	[20, 184, 166],
	[239, 68, 68],
];

/** Someone in a session as this app shows them. */
export type Person = Member & { name: string; avatar: string | null; color: RGB };

/** Everyone in `roster` once, each in a color that is the same in every app in the session: in
 *  order, each takes their own palette slot or the next one nobody earlier holds, so a session
 *  repeats a color only once it outgrows the palette. */
export function toPeople(roster: readonly Member[]): Person[] {
	const taken = new Set<number>();
	const people = new Map<string, Person>();
	for (const { login, guest } of roster) {
		if (people.has(login)) continue;
		let slot = 0;
		for (const c of login) slot = (slot * 31 + c.charCodeAt(0)) >>> 0;
		slot %= PALETTE.length;
		if (taken.size < PALETTE.length) while (taken.has(slot)) slot = (slot + 1) % PALETTE.length;
		taken.add(slot);
		people.set(login, {
			login,
			guest,
			name: guest ? t("Guest {id}", { id: login.slice(GUEST.length) }) : login,
			avatar: guest ? null : `https://avatars.githubusercontent.com/${login}?s=64`,
			color: PALETTE[slot],
		});
	}
	return [...people.values()];
}
