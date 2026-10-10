import type { MappingBackend } from "./syncStore";

/** Clear persisted sync mappings through the Rust backend. */
export function createMappingBackend(): MappingBackend {
	const { cmd } = window.MMA;
	return {
		clear: async (provider, mapId) => {
			await cmd.remoteMappingClear(provider, mapId);
		},
	};
}
