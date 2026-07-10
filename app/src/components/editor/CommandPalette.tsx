import { useState, useCallback, useMemo, createContext, useContext } from "react";
import { useDomEvent } from "@/lib/hooks/useDomEvent";
import { Command } from "cmdk";
import * as RadixDialog from "@radix-ui/react-dialog";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { Icon } from "@/components/primitives/Icon";
import { mdiUndo, mdiPin, mdiPinOutline } from "@mdi/js";
import { BulkOperationModal, type BulkOperation } from "@/components/dialogs/BulkOperationModal";
import { getCommands, togglePinnedCommand, type CommandGroup } from "@/store/commands";
import { useSetting } from "@/store/settings";
import { useHotkey } from "@/lib/hooks/useHotkey";
import { getBinding, useBinding } from "@/lib/util/hotkeys";
import { useMapList, getCurrentMapId, closeMap } from "@/store/useMapStore";
import { goToMap } from "@/store/router";

interface PaletteContext {
	close: () => void;
	setPage: (page: string | null) => void;
}
const Ctx = createContext<PaletteContext>({ close: () => {}, setPage: () => {} });

function PaletteItem({
	label,
	icon,
	onSelect,
	disabled = false,
	closeOnSelect = true,
	shortcut,
	commandId,
	pinned,
	keywords,
}: {
	label: string;
	icon?: React.ReactNode;
	onSelect: () => void;
	disabled?: boolean;
	closeOnSelect?: boolean;
	shortcut?: string;
	commandId?: string;
	pinned?: boolean;
	keywords?: string[];
}) {
	const ctx = useContext(Ctx);
	const handleSelect = useCallback(() => {
		try {
			onSelect();
		} finally {
			if (closeOnSelect) ctx.close();
		}
	}, [onSelect, closeOnSelect, ctx]);

	return (
		<Command.Item
			value={label}
			keywords={keywords}
			onSelect={handleSelect}
			disabled={disabled}
			className="command-palette__item"
			onContextMenu={
				commandId
					? (e) => {
							e.preventDefault();
							togglePinnedCommand(commandId);
						}
					: undefined
			}
		>
			{icon && <span className="command-palette__icon">{icon}</span>}
			<span className="command-palette__label">{label}</span>
			{shortcut && <kbd className="command-palette__kbd">{shortcut}</kbd>}
			{commandId && (
				<button
					className="command-palette__pin"
					title={pinned ? "Unpin from toolbar" : "Pin to toolbar"}
					onPointerDown={(e) => {
						e.preventDefault();
						e.stopPropagation();
					}}
					onClick={(e) => {
						e.preventDefault();
						e.stopPropagation();
						togglePinnedCommand(commandId);
					}}
				>
					<Icon path={pinned ? mdiPin : mdiPinOutline} size={18} />
				</button>
			)}
		</Command.Item>
	);
}

const UndoIcon = () => <Icon path={mdiUndo} size={18} />;

function formatBinding(binding: string): string {
	return binding
		.replace("Mod+", navigator.platform.includes("Mac") ? "⌘" : "Ctrl+")
		.replace("Shift+", "⇧")
		.replace("ArrowLeft", "←")
		.replace("ArrowRight", "→")
		.replace("ArrowUp", "↑")
		.replace("ArrowDown", "↓");
}

const COMMAND_GROUPS: CommandGroup[] = ["Map", "Bulk Operations", "Selections", "Tags"];

function MainCommands() {
	const ctx = useContext(Ctx);
	const commands = getCommands();
	const pinnedSet = new Set(useSetting("pinnedCommands"));

	return (
		<>
			{COMMAND_GROUPS.map((group) => {
				const groupCmds = commands.filter((c) => c.group === group);
				if (groupCmds.length === 0) return null;
				return (
					<Command.Group key={group} heading={group}>
						{groupCmds.map((cmd) => (
							<PaletteItem
								key={cmd.id}
								label={cmd.label}
								icon={cmd.icon ? <Icon path={cmd.icon} size={18} /> : undefined}
								onSelect={cmd.execute}
								disabled={cmd.enabled ? !cmd.enabled() : false}
								shortcut={cmd.defaultBinding ? formatBinding(getBinding(cmd.id)) : undefined}
								commandId={cmd.id}
								pinned={pinnedSet.has(cmd.id)}
								keywords={cmd.aliases}
							/>
						))}
						{group === "Map" && (
							<PaletteItem
								label="Open map..."
								onSelect={() => ctx.setPage("maps")}
								closeOnSelect={false}
							/>
						)}
					</Command.Group>
				);
			})}
		</>
	);
}

function MapSwitcher() {
	const ctx = useContext(Ctx);
	const maps = useMapList();
	const currentId = getCurrentMapId();
	const others = maps.filter((m) => m.id !== currentId);

	return (
		<Command.Group heading="Switch map">
			<PaletteItem
				label="Back"
				onSelect={() => ctx.setPage(null)}
				icon={<UndoIcon />}
				closeOnSelect={false}
			/>
			{others.length === 0 ? (
				<Command.Empty>No other maps.</Command.Empty>
			) : (
				others.map((m) => (
					<PaletteItem
						key={m.id}
						label={m.name}
						onSelect={() => closeMap().then(() => goToMap(m.id))}
					/>
				))
			)}
		</Command.Group>
	);
}

function PaletteContent({ onChangeOpen }: { onChangeOpen: (v: boolean) => void }) {
	const [inputValue, setInputValue] = useState("");
	const [page, setPage] = useState<string | null>(null);

	const ctx = useMemo(
		() => ({
			close: () => onChangeOpen(false),
			setPage: (p: string | null) => {
				setPage(p);
				setInputValue("");
			},
		}),
		[onChangeOpen],
	);

	return (
		<Ctx.Provider value={ctx}>
			<Command
				onKeyDown={(e) => {
					if (e.key === "Escape" && page !== null) {
						e.preventDefault();
						setPage(null);
						setInputValue("");
					}
				}}
				loop
			>
				<Command.Input
					value={inputValue}
					onValueChange={setInputValue}
					autoFocus
					placeholder="Type command"
					className="command-palette__input"
				/>
				<Command.List className="command-palette__scroll">
					{page === null && <MainCommands />}
					{page === "maps" && <MapSwitcher />}
				</Command.List>
				<p className="command-palette__footer" style={{ margin: 0, padding: ".5rem 1.375rem" }} />
			</Command>
		</Ctx.Provider>
	);
}

export function CommandPalette() {
	const [open, setOpen] = useState(false);
	const [bulkOp, setBulkOp] = useState<{
		operation: BulkOperation;
		locationIds?: number[];
	} | null>(null);
	useHotkey(useBinding("openCommandPalette"), () => setOpen((v) => !v));

	useDomEvent("open-command-palette", () => setOpen(true));

	useDomEvent("open-bulk-op", (e) => {
		const detail = (e as CustomEvent).detail as
			| BulkOperation
			| { operation: BulkOperation; locationIds?: number[] };
		if (typeof detail === "string") setBulkOp({ operation: detail });
		else setBulkOp(detail);
	});

	return (
		<>
			<RadixDialog.Root open={open} onOpenChange={setOpen}>
				<RadixDialog.Portal>
					<RadixDialog.Overlay className="modal__backdrop" />
					<RadixDialog.Content className="modal command-palette" aria-describedby={undefined}>
						<VisuallyHidden.Root>
							<RadixDialog.Title>Command Palette</RadixDialog.Title>
						</VisuallyHidden.Root>
						<PaletteContent onChangeOpen={setOpen} />
					</RadixDialog.Content>
				</RadixDialog.Portal>
			</RadixDialog.Root>
			{bulkOp && (
				<BulkOperationModal
					operation={bulkOp.operation}
					locationIds={bulkOp.locationIds}
					onClose={() => setBulkOp(null)}
				/>
			)}
		</>
	);
}
