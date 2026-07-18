/**
 * Storage vs viewer pano id conventions for non-Google providers.
 *
 * - **Storage** (Location.panoId, export JSON, clipboard): raw provider id, no prefix.
 * - **Viewer** (Google opensv inject): `BAIDU:` / `TENCENT:` / … via prefix helpers.
 * - **Import**: accept prefixed ids; strip and infer provider when missing.
 */
import { stripBaidu, prefixBaidu, BAIDU_PANO_PREFIX } from "@/lib/sv/baidu/prefix";
import { stripTencent, prefixTencent, TENCENT_PANO_PREFIX } from "@/lib/sv/tencent/prefix";
import type { AltSvProviderId, SvProvider } from "./types";

const STORAGE_PREFIXES: ReadonlyArray<{
	prefix: string;
	provider: AltSvProviderId;
	strip: (id: string) => string;
}> = [
	{ prefix: "APPLE:", provider: "apple", strip: (id) => (id.startsWith("APPLE:") ? id.slice(6) : id) },
	{ prefix: BAIDU_PANO_PREFIX, provider: "baidu", strip: stripBaidu },
	{ prefix: TENCENT_PANO_PREFIX, provider: "tencent", strip: stripTencent },
	{ prefix: "YANDEX:", provider: "yandex", strip: (id) => (id.startsWith("YANDEX:") ? id.slice(7) : id) },
];

export interface ParsedStoragePanoRef {
	panoId: string;
	/** Set when the input carried a provider prefix. */
	inferredProvider: AltSvProviderId | null;
}

/** Parse a possibly prefixed pano id into storage form + optional provider hint. */
export function parsePrefixedStoragePanoId(panoId: string): ParsedStoragePanoRef {
	for (const { prefix, provider, strip } of STORAGE_PREFIXES) {
		if (panoId.startsWith(prefix)) {
			return { panoId: strip(panoId), inferredProvider: provider };
		}
	}
	return { panoId, inferredProvider: null };
}

/** Strip any known alt-provider prefix for internal storage / export. */
export function normalizeStoragePanoId(panoId: string | null | undefined): string | null {
	if (typeof panoId !== "string" || panoId.length === 0) return null;
	return parsePrefixedStoragePanoId(panoId).panoId;
}

export interface StorageLocationFields {
	panoId?: string | null;
	provider?: string | null;
}

/** Normalize panoId (and infer provider from prefix when unset) for Location storage. */
export function normalizeLocationStorageFields<T extends StorageLocationFields>(fields: T): T {
	const panoId = fields.panoId;
	if (panoId == null || panoId === "") return fields;
	const parsed = parsePrefixedStoragePanoId(panoId);
	const provider =
		fields.provider && fields.provider !== "google"
			? fields.provider
			: parsed.inferredProvider ?? fields.provider;
	return {
		...fields,
		panoId: parsed.panoId,
		...(provider ? { provider } : {}),
	};
}

/** Convert a storage pano id to the Google viewer / inject id for a provider. */
export function viewerPanoId(provider: SvProvider, storagePanoId: string): string {
	switch (provider) {
		case "baidu":
			return prefixBaidu(storagePanoId);
		case "tencent":
			return prefixTencent(storagePanoId);
		default:
			return storagePanoId;
	}
}
