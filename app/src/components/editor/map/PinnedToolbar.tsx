import { useState, useEffect, useCallback, type ReactNode } from "react";
import { useMapVersion } from "@/store/useMapStore";
import { useSetting } from "@/store/settings";
import {
	getCommand,
	movePinnedCommand,
	removePinnedAt,
	insertSeparator,
	reorderPinned,
} from "@/store/commands";
import { Icon } from "@/components/primitives/Icon";
import { useDomEvent } from "@/lib/hooks/useDomEvent";
import { Tooltip } from "@/components/primitives/Tooltip";
import * as ContextMenu from "@radix-ui/react-context-menu";

export interface PanelDef {
	render: (onClose: () => void) => ReactNode;
}

export function PinnedToolbar({
	right,
	panels,
}: {
	right?: ReactNode;
	panels: Record<string, PanelDef>;
}) {
	const pinned = useSetting("pinnedCommands");
	const [openPanels, setOpenPanels] = useState<Set<string>>(new Set());
	const [dragIdx, setDragIdx] = useState<number | null>(null);
	const [dropIdx, setDropIdx] = useState<number | null>(null);
	useMapVersion();

	const handleInlinePanel = useCallback(
		(e: Event) => {
			const id = (e as CustomEvent).detail as string;
			if (panels[id])
				setOpenPanels((prev) => {
					const next = new Set(prev);
					if (next.has(id)) next.delete(id);
					else next.add(id);
					return next;
				});
		},
		[panels],
	);
	useDomEvent("open-inline-panel", handleInlinePanel);

	// eslint-disable-next-line react-hooks/exhaustive-deps -- enabled() reads arbitrary external state; no dep list covers it
	useEffect(() => {
		if (openPanels.size === 0) return;
		let changed = false;
		const next = new Set(openPanels);
		for (const id of next) {
			const cmd = getCommand(id);
			if (cmd?.enabled && !cmd.enabled()) {
				next.delete(id);
				changed = true;
			}
		}
		if (changed) setOpenPanels(next);
	});

	if (pinned.length === 0 && !right) return null;
	const togglePanel = (id: string) =>
		setOpenPanels((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	const handleDragStart = (i: number, e: React.MouseEvent) => {
		if (e.button !== 0) return;
		e.preventDefault();
		const startX = e.clientX;
		let started = false;

		const onMove = (me: MouseEvent) => {
			if (!started && Math.abs(me.clientX - startX) > 4) {
				started = true;
				setDragIdx(i);
			}
		};
		const onUp = () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			if (started) {
				setDragIdx((di) => {
					setDropIdx((dri) => {
						if (di !== null && dri !== null && di !== dri) reorderPinned(di, dri);
						return null;
					});
					return null;
				});
			}
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	};

	const handleDragOver = (i: number) => {
		if (dragIdx !== null && i !== dragIdx) setDropIdx(i);
	};

	return (
		<div className="selection-manager__toolbar">
			<div className="selection-manager__bar">
				{pinned.map((id, i) => {
					if (id === "---") {
						return (
							<ContextMenu.Root key={`sep-${i}`}>
								<ContextMenu.Trigger asChild>
									<span
										className={`selection-manager__bar-sep${dragIdx === i ? " is-dragging" : ""}`}
										data-drop={dropIdx === i ? "" : undefined}
										onMouseDown={(e) => handleDragStart(i, e)}
										onMouseMove={() => handleDragOver(i)}
									/>
								</ContextMenu.Trigger>
								<ContextMenu.Portal>
									<ContextMenu.Content className="context-menu">
										<ContextMenu.Item
											className="context-menu__item"
											onSelect={() => removePinnedAt(i)}
										>
											Remove separator
										</ContextMenu.Item>
									</ContextMenu.Content>
								</ContextMenu.Portal>
							</ContextMenu.Root>
						);
					}
					const command = getCommand(id);
					if (!command) return null;
					const disabled = command.enabled ? !command.enabled() : false;
					const hasPanel = id in panels;
					const isOpen = openPanels.has(id);
					const handleClick = hasPanel ? () => togglePanel(id) : command.execute;
					const isFirst = i === 0;
					const isLast = i === pinned.length - 1;

					const btn = command.icon ? (
						<button
							className={`icon-button${isOpen ? " is-active" : ""}${disabled ? " is-disabled" : ""}${dragIdx === i ? " is-dragging" : ""}`}
							type="button"
							aria-label={command.label}
							data-qa={id}
							data-drop={dropIdx === i ? "" : undefined}
							onClick={disabled ? undefined : handleClick}
							onMouseDown={(e) => handleDragStart(i, e)}
							onMouseMove={() => handleDragOver(i)}
						>
							<Icon path={command.icon} />
						</button>
					) : (
						<button
							className={`button${isOpen ? " is-active" : ""}${disabled ? " is-disabled" : ""}${dragIdx === i ? " is-dragging" : ""}`}
							type="button"
							data-drop={dropIdx === i ? "" : undefined}
							onClick={disabled ? undefined : handleClick}
							onMouseDown={(e) => handleDragStart(i, e)}
							onMouseMove={() => handleDragOver(i)}
						>
							{command.label}
						</button>
					);

					return (
						<ContextMenu.Root key={id}>
							<Tooltip content={command.label} side="bottom">
								<ContextMenu.Trigger asChild>{btn}</ContextMenu.Trigger>
							</Tooltip>
							<ContextMenu.Portal>
								<ContextMenu.Content className="context-menu">
									{!isFirst && (
										<ContextMenu.Item
											className="context-menu__item"
											onSelect={() => movePinnedCommand(i, -1)}
										>
											Move left
										</ContextMenu.Item>
									)}
									{!isLast && (
										<ContextMenu.Item
											className="context-menu__item"
											onSelect={() => movePinnedCommand(i, 1)}
										>
											Move right
										</ContextMenu.Item>
									)}
									<ContextMenu.Separator
										style={{ height: 1, background: "#0000001a", margin: "4px 0" }}
									/>
									<ContextMenu.Item
										className="context-menu__item"
										onSelect={() => insertSeparator(i, "before")}
									>
										Add separator before
									</ContextMenu.Item>
									<ContextMenu.Item
										className="context-menu__item"
										onSelect={() => insertSeparator(i, "after")}
									>
										Add separator after
									</ContextMenu.Item>
									<ContextMenu.Separator
										style={{ height: 1, background: "#0000001a", margin: "4px 0" }}
									/>
									<ContextMenu.Item
										className="context-menu__item"
										onSelect={() => removePinnedAt(i)}
									>
										Remove from toolbar
									</ContextMenu.Item>
								</ContextMenu.Content>
							</ContextMenu.Portal>
						</ContextMenu.Root>
					);
				})}
				{right}
			</div>
			{Object.entries(panels)
				.sort(([a], [b]) => {
					const ai = pinned.indexOf(a);
					const bi = pinned.indexOf(b);
					return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
				})
				.map(([id, panel]) => (
					<div key={id} className="selection-manager__panel" hidden={!openPanels.has(id)}>
						{panel.render(() =>
							setOpenPanels((prev) => {
								const next = new Set(prev);
								next.delete(id);
								return next;
							}),
						)}
					</div>
				))}
		</div>
	);
}
