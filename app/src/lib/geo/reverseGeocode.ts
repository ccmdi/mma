import { cmd } from "@/lib/commands";
import { getSettings } from "@/store/settings";
import type { Pano } from "@/bindings.gen";

export interface GeoDisplay {
	address: string;
	countryCode: string | null;
}

async function geocodeLocal(lat: number, lng: number): Promise<GeoDisplay | null> {
	const result = await cmd.reverseGeocode(lat, lng);
	if (!result) return null;
	const parts = [result.city, result.admin].filter(Boolean);
	return {
		address: parts.join(", "),
		countryCode: result.country_code?.toUpperCase() ?? null,
	};
}

/** Google already answered inside the pano's metadata. */
export function geocodeGoogle(pano: Pano | null): GeoDisplay | null {
	return (
		pano && {
			address: pano.description || "",
			countryCode: pano.countryCode?.toUpperCase() ?? null,
		}
	);
}

async function geocodeNominatim(lat: number, lng: number): Promise<GeoDisplay | null> {
	const apiKey = getSettings().nominatimApiKey;
	const url = new URL("https://nominatim.openstreetmap.org/reverse");
	url.searchParams.set("lat", String(lat));
	url.searchParams.set("lon", String(lng));
	url.searchParams.set("format", "json");
	url.searchParams.set("zoom", "14");
	if (apiKey) url.searchParams.set("key", apiKey);
	const res = await fetch(url.toString(), { headers: { "Accept-Language": "en" } });
	if (!res.ok) return null;
	const data = await res.json();
	if (!data?.address) return null;
	const a = data.address;
	const parts = [a.road, a.suburb || a.town || a.city || a.village, a.state || a.county].filter(
		Boolean,
	);
	return {
		address: parts.join(", "),
		countryCode: (a.country_code as string)?.toUpperCase() ?? null,
	};
}

/** The configured provider's answer for a position; the google provider answers from pano
 *  metadata instead and is resolved synchronously by the caller via {@link geocodeGoogle}. */
export async function reverseGeocode(lat: number, lng: number): Promise<GeoDisplay | null> {
	const fn = getSettings().geocodeProvider === "nominatim" ? geocodeNominatim : geocodeLocal;
	return fn(lat, lng);
}
