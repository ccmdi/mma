/** Low-level command, shell, and file dialog access. */
import { invoke as invokeCommand } from "@tauri-apps/api/core";
import { Command } from "@tauri-apps/plugin-shell";
import { open, save } from "@tauri-apps/plugin-dialog";

/** @api @unstable */
export const invoke = invokeCommand;
/** @api @unstable */
export const shell = { Command };
/** @api @unstable */
export const dialog = { open, save };
