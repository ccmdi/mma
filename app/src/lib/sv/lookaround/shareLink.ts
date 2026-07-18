import { LOOKMAP_ORIGIN } from "./endpoints";

/** lookaround-map share hash payload: lat, lon, yaw, pitch as Float32 LE → base64url. */
export function encodeShareLinkPayload(
	lat: number,
	lon: number,
	yaw: number,
	pitch: number,
): string {
	const floats = new Float32Array(4);
	floats[0] = lat;
	floats[1] = lon;
	floats[2] = yaw;
	floats[3] = pitch;
	const bytes = new Uint8Array(floats.buffer);
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Inverse of {@link encodeShareLinkPayload}. */
export function decodeShareLinkPayload(
	payload: string,
): { lat: number; lon: number; yaw: number; pitch: number } | null {
	try {
		const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
		const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
		const binary = atob(b64 + pad);
		if (binary.length < 16) return null;
		const bytes = new Uint8Array(16);
		for (let i = 0; i < 16; i++) bytes[i] = binary.charCodeAt(i);
		const floats = new Float32Array(bytes.buffer);
		const lat = floats[0]!;
		const lon = floats[1]!;
		const yaw = floats[2]!;
		const pitch = floats[3]!;
		if (![lat, lon, yaw, pitch].every(Number.isFinite)) return null;
		if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
		return { lat, lon, yaw, pitch };
	} catch {
		return null;
	}
}

/** Google POV (degrees) → lookmap viewer yaw/pitch (radians). */
export function googlePovToLookmapRadians(headingDeg: number, pitchDeg: number): {
	yaw: number;
	pitch: number;
} {
	return {
		yaw: (-headingDeg * Math.PI) / 180,
		pitch: (pitchDeg * Math.PI) / 180,
	};
}

/** lookmap viewer yaw/pitch (radians) → Google POV (degrees). */
export function lookmapRadiansToGooglePov(yaw: number, pitch: number): {
	heading: number;
	pitch: number;
} {
	return {
		heading: (((-yaw * 180) / Math.PI) % 360 + 360) % 360,
		pitch: (pitch * 180) / Math.PI,
	};
}

export function buildLookmapOpenUrl(
	lat: number,
	lon: number,
	headingDeg: number,
	pitchDeg: number,
): string {
	return `${LOOKMAP_ORIGIN}/#c=18/${lat}/${lon}&p=${lat}/${lon}&a=${headingDeg}/${pitchDeg}`;
}

export function buildLookmapShareUrl(
	lat: number,
	lon: number,
	yaw: number,
	pitch: number,
): string {
	return `${LOOKMAP_ORIGIN}/#s=${encodeShareLinkPayload(lat, lon, yaw, pitch)}`;
}

export function isLookmapHost(hostname: string): boolean {
	return (
		hostname === "lookmap.skzk.dev" ||
		hostname === "www.lookmap.skzk.dev" ||
		hostname.endsWith(".lookmap.skzk.dev")
	);
}

/**
 * Parse a lookmap.skzk.dev URL (`#s=` short share or `#c=`/`#p=`/`#a=` open link)
 * into map POV. Does not resolve a panoid — callers should run closest-pano.
 */
export function parseLookmapUrl(url: URL): {
	lat: number;
	lng: number;
	heading: number;
	pitch: number;
} | null {
	if (!isLookmapHost(url.hostname)) return null;
	const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
	if (!hash) return null;
	const params = new URLSearchParams(hash);

	const short = params.get("s");
	if (short) {
		const decoded = decodeShareLinkPayload(short);
		if (!decoded) return null;
		const pov = lookmapRadiansToGooglePov(decoded.yaw, decoded.pitch);
		return { lat: decoded.lat, lng: decoded.lon, heading: pov.heading, pitch: pov.pitch };
	}

	// `#p=lat/lng` preferred; fall back to `#c=zoom/lat/lng`.
	const p = params.get("p");
	let lat: number | null = null;
	let lng: number | null = null;
	if (p) {
		const parts = p.split("/");
		if (parts.length >= 2) {
			lat = parseFloat(parts[0]!);
			lng = parseFloat(parts[1]!);
		}
	}
	if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
		const c = params.get("c");
		if (c) {
			const parts = c.split("/");
			if (parts.length >= 3) {
				lat = parseFloat(parts[1]!);
				lng = parseFloat(parts[2]!);
			}
		}
	}
	if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
	if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

	let heading = 0;
	let pitch = 0;
	const a = params.get("a");
	if (a) {
		const parts = a.split("/");
		if (parts[0]) heading = parseFloat(parts[0]) || 0;
		if (parts[1]) pitch = parseFloat(parts[1]) || 0;
	}
	return { lat, lng, heading, pitch };
}
