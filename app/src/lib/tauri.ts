/** Tauri primitives, handed to plugins as-is. */
import { invoke } from "@tauri-apps/api/core";
import { Command } from "@tauri-apps/plugin-shell";
import { open, save } from "@tauri-apps/plugin-dialog";

export { invoke };
export const shell = { Command };
export const dialog = { open, save };
