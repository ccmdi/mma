/** Low-level shell and file dialog access. */
import { Command } from "@tauri-apps/plugin-shell";
import { open, save } from "@tauri-apps/plugin-dialog";

/** @api @unstable */
export const shell = { Command };
/** @api @unstable */
export const dialog = { open, save };
