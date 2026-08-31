import type { Pano } from "@/types";
import { imageDateOf } from "@/lib/sv/getMetadata";
import type { GeneratorSettings } from "./types";

function normalizeText(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^\w\s-]/g, "")
		.trim();
}

function tokenize(text: string): string[] {
	return text.split(/[\s_,.;!?()'"“”«»]+/).filter(Boolean);
}

function sectionMatch(text: string, target: string): boolean {
	const term = normalizeText(target);
	const normalized = text
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "");
	const pattern = new RegExp(`(^${term}$|^${term},|,\\s*${term}$|,\\s*${term},)`, "i");
	return pattern.test(normalized);
}

/** Match a found pano's description against the user's search terms. Mirrors the
 *  reference generator's "search in panorama description" filter. */
export function passesDescriptionSearch(loc: Pano, s: GeneratorSettings): boolean {
	if (!s.searchInDescription || !s.searchTerms.trim()) return true;

	const searchTerms = s.searchTerms
		.split(",")
		.map((term) => normalizeText(term.trim()))
		.filter(Boolean);

	const description = loc.description ?? "";
	const shortDescription = loc.shortDescription ?? "";
	const combined = `${description} ${shortDescription}`;
	const normalizedText = normalizeText(combined);
	const words = tokenize(combined).map(normalizeText);

	const hasMatch = searchTerms.some((term) => {
		switch (s.searchMode) {
			case "contains":
				return normalizedText.includes(term);
			case "fullword":
				return new RegExp(`\\b${term}\\b`, "i").test(words.join(" "));
			case "startswith":
				return words.some((word) => word.startsWith(term));
			case "endswith":
				return words.some((word) => word.endsWith(term));
			case "sectionmatch":
				return sectionMatch(description, term) || sectionMatch(shortDescription, term);
		}
	});

	return s.searchFilterType === "exclude" ? !hasMatch : hasMatch;
}

export function getCameraGeneration(pano: Pano): 0 | 1 | 23 | 4 {
	const h = pano.worldSize?.height;
	switch (h) {
		case 1664:
			return 1;
		case 6656:
			return 23;
		case 8192:
			return 4;
		default:
			return 0;
	}
}

/** The capture month of a timeline entry as a comparable timestamp, NaN when it has none. */
function entryMonth(entry: { date: string }): number {
	return entry.date ? Date.parse(entry.date.slice(0, 7)) : NaN;
}

export function passesInitialFilters(res: Pano, s: GeneratorSettings): boolean {
	if (s.rejectUnofficial && !s.rejectOfficial) {
		if (s.rejectNoDescription && !s.rejectDescription && !res.description && !res.shortDescription)
			return false;
		if (s.getIntersection && res.links.length < 3) return false;
		if (s.rejectDescription && (res.description || res.shortDescription)) return false;
		if (s.pinpointSearch && res.links.length < 2) return false;
		if (s.getIntersection && !s.pinpointSearch && res.links.length < 3) return false;
		if (
			s.pinpointSearch &&
			res.links.length === 2 &&
			Math.abs(res.links[0].heading - res.links[1].heading) > s.pinpointAngle
		)
			return false;
	}

	if (s.rejectOfficial) {
		if (/^\xA9 (?:\d+ )?Google$/.test(res.copyright)) return false;
	}

	if (s.rejectGen1 && getCameraGeneration(res) === 1) return false;

	if (s.findGeneration && (!s.checkAllDates || s.selectMonths)) {
		if (getCameraGeneration(res) !== s.generation) return false;
	}

	return true;
}

export function passesDateFilters(
	res: Pano,
	s: GeneratorSettings,
): "direct" | "checkAll" | "months" | false {
	if (s.randomInTimeline) return "direct";

	if (s.checkAllDates && res.time && !s.selectMonths && !s.rejectOfficial) {
		if (!res.time.length) return false;
		const fromDate = Date.parse(s.fromDate);
		const toDate = Date.parse(s.toDate);
		for (const entry of res.time) {
			if (s.rejectUnofficial && entry.pano.length !== 22) continue;
			const iDate = entryMonth(entry);
			if (iDate >= fromDate && iDate <= toDate) return "checkAll";
		}
		return false;
	}

	if (s.selectMonths && !s.rejectOfficial) {
		if (!res.time?.length) return false;
		return "months";
	}

	if (s.rejectDateless && !imageDateOf(res)) return false;
	if (
		Date.parse(imageDateOf(res)) < Date.parse(s.fromDate) ||
		Date.parse(imageDateOf(res)) > Date.parse(s.toDate)
	)
		return false;
	return "direct";
}

export function isPanoGood(pano: Pano, s: GeneratorSettings): boolean {
	if (!passesDescriptionSearch(pano, s)) return false;

	if (s.rejectUnofficial && !s.rejectOfficial) {
		if (pano.pano.length !== 22) return false;
		if (s.filterByLinks && (pano.links.length < s.minLinks || pano.links.length > s.maxLinks))
			return false;
		if (
			s.rejectNoDescription &&
			!s.rejectDescription &&
			!pano.description &&
			!pano.shortDescription
		)
			return false;
		if (s.getIntersection && pano.links.length < 3) return false;
		if (s.rejectDescription && (pano.description || pano.shortDescription)) return false;
		if (s.pinpointSearch && pano.links.length < 2) return false;
		if (s.getIntersection && !s.pinpointSearch && pano.links.length < 3) return false;
		if (
			s.pinpointSearch &&
			pano.links.length === 2 &&
			Math.abs(pano.links[0].heading - pano.links[1].heading) > s.pinpointAngle
		)
			return false;
	}

	if (s.rejectDateless && !imageDateOf(pano)) return false;

	const fromDate = Date.parse(s.fromDate);
	const toDate = Date.parse(s.toDate);

	if (!s.selectMonths) {
		if (!s.checkAllDates || s.rejectOfficial) {
			const locDate = Date.parse(imageDateOf(pano));
			if (locDate < fromDate || locDate > toDate) return false;
		}
	}

	if (s.onlyOneInTimeframe && pano.time) {
		for (const entry of pano.time) {
			if (s.rejectUnofficial && entry.pano.length !== 22) continue;
			if (entry.pano === pano.pano) continue;
			const iDate = entryMonth(entry);
			if (iDate >= fromDate && iDate <= toDate) return false;
		}
	}

	if (s.checkAllDates && !s.selectMonths && !s.rejectOfficial) {
		if (!pano.time?.length) return false;
		if (s.findGeneration && getCameraGeneration(pano) !== s.generation) return false;
		if (s.rejectGen1 && getCameraGeneration(pano) === 1) return false;
		let dateWithin = false;
		for (const entry of pano.time) {
			if (s.rejectUnofficial && entry.pano.length !== 22) continue;
			const iDate = entryMonth(entry);
			if (iDate >= fromDate && iDate <= toDate) {
				dateWithin = true;
				break;
			}
		}
		if (!dateWithin) return false;
	}

	if (s.selectMonths && !s.rejectOfficial) {
		if (!pano.time?.length) return false;
		const fM = parseInt(s.fromMonth);
		const tM = parseInt(s.toMonth);
		const fY = parseInt(s.fromYear);
		const tY = parseInt(s.toYear);

		if (s.checkAllDates) {
			let dateWithin = false;
			for (const entry of pano.time) {
				if (s.rejectUnofficial && entry.pano.length !== 22) continue;
				if (!entry.date) continue;
				const m = parseInt(entry.date.slice(5, 7));
				const y = parseInt(entry.date.slice(0, 4));
				if (y < fY || y > tY) continue;
				const inRange = fM <= tM ? m >= fM && m <= tM : m >= fM || m <= tM;
				if (inRange) {
					dateWithin = true;
					break;
				}
			}
			if (!dateWithin) return false;
		} else {
			if (!imageDateOf(pano)) return false;
			const year = parseInt(imageDateOf(pano).slice(0, 4));
			const month = parseInt(imageDateOf(pano).slice(5));
			if (year < fY || year > tY) return false;
			const inRange = fM <= tM ? month >= fM && month <= tM : month >= fM || month <= tM;
			if (!inRange) return false;
		}
	}

	return true;
}

export function computeHeading(pano: Pano, s: GeneratorSettings): number {
	let heading = 0;
	if (s.adjustHeading) {
		const forward = pano.pov?.heading ?? 0;
		if (s.headingReference === "forward") {
			heading = forward;
		} else if (s.headingReference === "backward") {
			heading = (forward + 180) % 360;
		} else if (s.headingReference === "link" && pano.links.length > 0) {
			heading = pano.links[0].heading;
		}
		const dev = s.headingDeviation;
		if (dev > 0) heading += Math.floor(Math.random() * (2 * dev + 1)) - dev;
	}
	return heading;
}
