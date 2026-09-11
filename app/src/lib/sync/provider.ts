export interface RemoteMapSummary {
	id: string;
	name: string;
	/** `null` when the provider's listing does not carry a count. */
	locationCount: number | null;
	/** Set when this map exists but cannot be linked, with a user-facing reason. */
	unsupported?: string;
}

/** Rust stamps auth failures with `auth: ` (see `sync.rs`); both providers detect them this way. */
export const isAuthPrefixed = (e: unknown): boolean =>
	e instanceof Error && e.message.startsWith("auth: ");

/**
 * The UI half of a sync backend. The merge itself lives in Rust (see `syncReconcile`), which also
 * owns the credential; a provider only supplies the map picker and the browser URL.
 */
export interface SyncProvider {
	/** Persisted as the `provider` column of `remote_mapping`. Never change it for a shipped provider. */
	readonly id: string;
	readonly label: string;

	/** Web URL of a remote map, for opening it in the user's browser. */
	remoteMapUrl(remoteMapId: string): string;

	/** Maps the signed-in user can link to. */
	listMaps(signal?: AbortSignal): Promise<RemoteMapSummary[]>;

	/**
	 * Whether an error from the reconcile means the session or key is no longer valid. The live
	 * loop stops on these instead of retrying a dead credential forever. Optional; omitting it
	 * treats every error as retryable.
	 */
	isAuthError?(e: unknown): boolean;
}
