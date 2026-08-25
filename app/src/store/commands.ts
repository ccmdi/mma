export type CommandGroup = "Map" | "Selections" | "Bulk Operations" | "Tags";

export interface CommandDef {
	label: string;
	icon?: string;
	group: CommandGroup;
	defaultBinding?: string;
	aliases?: string[];
	execute: () => void | Promise<void>;
	enabled?: () => boolean;
}

export interface Command extends CommandDef {
	id: string;
}

const commands: Command[] = [];

export function runCommand(cmd: Command): void {
	void Promise.resolve(cmd.execute());
}

export function registerCommand(cmd: Command): void {
	commands.push(cmd);
}

export function getCommands(): readonly Command[] {
	return commands;
}

export function getCommand(id: string): Command | undefined {
	return commands.find((c) => c.id === id);
}

import { getSettings, setSetting } from "./settings";

export function togglePinnedCommand(id: string): void {
	const pinned = getSettings().pinnedCommands;
	const idx = pinned.indexOf(id);
	setSetting("pinnedCommands", idx >= 0 ? pinned.toSpliced(idx, 1) : [...pinned, id]);
}

export function movePinnedCommand(index: number, direction: -1 | 1): void {
	const pinned = getSettings().pinnedCommands;
	const target = index + direction;
	if (target < 0 || target >= pinned.length) return;
	setSetting("pinnedCommands", pinned.with(index, pinned[target]).with(target, pinned[index]));
}

export function removePinnedAt(index: number): void {
	setSetting("pinnedCommands", getSettings().pinnedCommands.toSpliced(index, 1));
}

export function insertSeparator(index: number, position: "before" | "after"): void {
	const at = position === "before" ? index : index + 1;
	setSetting("pinnedCommands", getSettings().pinnedCommands.toSpliced(at, 0, "---"));
}

export function reorderPinned(fromIndex: number, toIndex: number): void {
	const pinned = getSettings().pinnedCommands;
	setSetting(
		"pinnedCommands",
		pinned.toSpliced(fromIndex, 1).toSpliced(toIndex, 0, pinned[fromIndex]),
	);
}
