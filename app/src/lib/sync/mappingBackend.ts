import type { MappingBackend } from "./syncStore";

/** Real mapping persistence over the Rust `remote_mapping_clear` command (cmd proxy auto-unwraps). */
export function createMappingBackend(): MappingBackend {
	const { cmd } = window.MMA;
	return {
		clear: async (provider, mapId) => {
			await cmd.remoteMappingClear(provider, mapId);
		},
	};
}
