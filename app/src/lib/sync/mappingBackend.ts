import type { MappingBackend } from "./syncStore";

/** Real mapping persistence over the Rust `remote_mapping_*` commands (cmd proxy auto-unwraps). */
export function createMappingBackend(): MappingBackend {
	const { cmd } = window.MMA;
	return {
		get: (provider, mapId) => cmd.remoteMappingGet(provider, mapId),
		upsert: async (provider, mapId, rows) => {
			await cmd.remoteMappingUpsert(provider, mapId, rows);
		},
		delete: async (provider, mapId, localIds) => {
			await cmd.remoteMappingDelete(provider, mapId, localIds);
		},
		clear: async (provider, mapId) => {
			await cmd.remoteMappingClear(provider, mapId);
		},
	};
}
