import { useState, useEffect, useCallback, useRef, createContext, useContext, useMemo } from "react";
import { Command } from "cmdk";
import * as RadixDialog from "@radix-ui/react-dialog";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { Icon } from "@/components/primitives/Icon";
import { mdiUndo, mdiBookmarkOutline, mdiBookmarkCheckOutline } from "@mdi/js";
import { BulkOperationModal, type BulkOperation } from "@/components/dialogs/BulkOperationModal";
import { RandomPickModal } from "@/components/dialogs/RandomPickModal.add";
import { useSelections, useCurrentMap, getSelectedLocationIds } from "@/store/useMapStore";
import { getCommands, type CommandGroup } from "@/store/commands.add";
import {
	saveCurrentSelections,
	deleteSavedSelection,
	applySavedSelection,
	selectionToSaved,
	describeRule,
} from "@/store/savedSelections.add";
import { useSetting } from "@/store/settings.add";
import { useHotkey } from "@/lib/hooks/useHotkey";
import { getBinding, useBinding } from "@/lib/util/hotkeys.add";

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
	type = "Action",
	shortcut,
}: {
	label: string;
	icon?: React.ReactNode;
	onSelect: () => void;
	disabled?: boolean;
	closeOnSelect?: boolean;
	type?: string;
	shortcut?: string;
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
			onSelect={handleSelect}
			disabled={disabled}
			className="command-palette__item"
		>
			{icon && <span className="command-palette__icon">{icon}</span>}
			<span className="command-palette__label">{label}</span>
			{shortcut && <kbd className="command-palette__kbd">{shortcut}</kbd>}
			<span className="command-palette__type">{type}</span>
		</Command.Item>
	);
}

function PageItem({ label, page, icon }: { label: string; page: string; icon?: React.ReactNode }) {
	const ctx = useContext(Ctx);
	return (
		<PaletteItem
			label={label}
			onSelect={() => ctx.setPage(page)}
			icon={icon}
			type="Page"
			closeOnSelect={false}
		/>
	);
}

const BookmarkIcon = () => <Icon path={mdiBookmarkOutline} size={18} />;
const BookmarkCheckIcon = () => <Icon path={mdiBookmarkCheckOutline} size={18} />;
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
	const map = useCurrentMap();
	const commands = getCommands();

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
							/>
						))}
						{group === "Map" && <PageItem label="Open map..." page="maps" />}
						{group === "Selections" && (
							<>
								<PageItem label="Save current selections..." page="save-selections" icon={<BookmarkIcon />} />
								{map && <PageItem label="Apply saved selection..." page="saved-selections" icon={<BookmarkCheckIcon />} />}
							</>
						)}
					</Command.Group>
				);
			})}
		</>
	);
}

function SaveSelectionsPage() {
	const ctx = useContext(Ctx);
	const selections = useSelections();
	const map = useCurrentMap();
	const inputRef = useRef<HTMLInputElement>(null);
	const [name, setName] = useState("");

	const saveableItems = useMemo(() => {
		if (!map) return [];
		return selections
			.map((s) => {
				const saved = selectionToSaved(s, map);
				if (!saved) return null;
				return { props: saved, color: s.color };
			})
			.filter((item): item is NonNullable<typeof item> => item !== null);
	}, [selections, map]);

	const handleSave = () => {
		if (!name.trim() || !map) return;
		const ok = saveCurrentSelections(name.trim(), selections, map);
		if (ok) ctx.close();
	};

	useEffect(() => {
		setTimeout(() => inputRef.current?.focus(), 0);
	}, []);

	if (!map || saveableItems.length === 0) {
		return (
			<Command.Group heading="Save Selections">
				<PaletteItem label="Back" onSelect={() => ctx.setPage(null)} icon={<UndoIcon />} closeOnSelect={false} />
				<Command.Empty>No saveable selections active.</Command.Empty>
			</Command.Group>
		);
	}

	return (
		<div className="command-palette__save-page">
			<div className="command-palette__save-form">
				<input
					ref={inputRef}
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") handleSave();
						if (e.key === "Escape") ctx.setPage(null);
						e.stopPropagation();
					}}
					placeholder="Name this selection..."
					className="command-palette__save-input"
				/>
				<button onClick={handleSave} disabled={!name.trim()} className="command-palette__save-btn">
					Save
				</button>
			</div>
			<div className="command-palette__saved-rules">
				{saveableItems.map((item, i) => (
					<span key={i} className="command-palette__rule-chip">
						<span
							className="command-palette__rule-dot"
							style={{ background: `rgb(${item.color[0]},${item.color[1]},${item.color[2]})` }}
						/>
						{describeRule(item.props)}
					</span>
				))}
			</div>
		</div>
	);
}

function SavedSelectionsPage() {
	const ctx = useContext(Ctx);
	const map = useCurrentMap();
	const saved = useSetting("savedSelections");
	const [altHeld, setAltHeld] = useState(false);

	useEffect(() => {
		const down = (e: KeyboardEvent) => { if (e.key === "Alt") setAltHeld(true); };
		const up = (e: KeyboardEvent) => { if (e.key === "Alt") setAltHeld(false); };
		window.addEventListener("keydown", down);
		window.addEventListener("keyup", up);
		return () => {
			window.removeEventListener("keydown", down);
			window.removeEventListener("keyup", up);
		};
	}, []);

	return (
		<Command.Group heading="Saved Selections">
			<PaletteItem label="Back" onSelect={() => ctx.setPage(null)} icon={<UndoIcon />} closeOnSelect={false} />
			{saved.length === 0 && <Command.Empty>No saved selections.</Command.Empty>}
			{saved.map((s) => (
				<Command.Item
					key={s.id}
					value={s.name}
					onSelect={() => {
						if (altHeld) {
							deleteSavedSelection(s.id);
						} else if (map) {
							applySavedSelection(s, map);
							ctx.close();
						}
					}}
					className="command-palette__item command-palette__saved-item"
				>
					<div className="command-palette__saved-header">
						<span className="command-palette__label">{altHeld ? `Delete "${s.name}"` : s.name}</span>
						<span className="command-palette__type">{altHeld ? "Delete" : "Apply"}</span>
					</div>
					<div className="command-palette__saved-rules">
						{s.items.map((item, i) => (
							<span key={i} className="command-palette__rule-chip">
								<span
									className="command-palette__rule-dot"
									style={{ background: `rgb(${item.color[0]},${item.color[1]},${item.color[2]})` }}
								/>
								{describeRule(item.props)}
							</span>
						))}
					</div>
				</Command.Item>
			))}
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
					{page === "maps" && (
						<Command.Group heading="Maps">
							<PaletteItem
								label="Back"
								onSelect={() => {
									setPage(null);
									setInputValue("");
								}}
								icon={<UndoIcon />}
								closeOnSelect={false}
							/>
							<Command.Empty>No maps found.</Command.Empty>
						</Command.Group>
					)}
					{page === "save-selections" && <SaveSelectionsPage />}
					{page === "saved-selections" && <SavedSelectionsPage />}
				</Command.List>
				<p className="command-palette__footer" style={{ margin: 0, padding: ".5rem 1.375rem" }} />
			</Command>
		</Ctx.Provider>
	);
}

export function CommandPalette() {
	const [open, setOpen] = useState(false);
	const [bulkOp, setBulkOp] = useState<BulkOperation | null>(null);
	const [randomPick, setRandomPick] = useState<number | null>(null);

	useHotkey(useBinding("openCommandPalette"), () => setOpen((v) => !v));

	useEffect(() => {
		const handler = () => setOpen(true);
		document.addEventListener("open-command-palette", handler);
		return () => document.removeEventListener("open-command-palette", handler);
	}, []);

	useEffect(() => {
		const handler = (e: Event) => setBulkOp((e as CustomEvent).detail as BulkOperation);
		document.addEventListener("open-bulk-op", handler);
		return () => document.removeEventListener("open-bulk-op", handler);
	}, []);

	useEffect(() => {
		const handler = () => setRandomPick(getSelectedLocationIds().size);
		document.addEventListener("open-random-pick", handler);
		return () => document.removeEventListener("open-random-pick", handler);
	}, []);

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
			{bulkOp && <BulkOperationModal operation={bulkOp} onClose={() => setBulkOp(null)} />}
			{randomPick != null && (
				<RandomPickModal
					open
					total={randomPick}
					onOpenChange={(o) => !o && setRandomPick(null)}
				/>
			)}
		</>
	);
}
