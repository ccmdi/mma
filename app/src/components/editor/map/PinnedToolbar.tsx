import { useState, useEffect, type ReactNode } from "react";
import clsx from "clsx";
import { useEventValue } from "@/lib/events";
import { useSetting } from "@/store/settings";
import {
	getCommand,
	runCommand,
	movePinnedCommand,
	removePinnedAt,
	insertSeparator,
	reorderPinned,
} from "@/store/commands";
import { Icon } from "@/components/primitives/Icon";
import { Button } from "@/components/primitives/Button";
import { useDialog } from "@/store/dialogBus";
import { Tooltip } from "@/components/primitives/Tooltip";
import { ContextMenu } from "@base-ui-components/react/context-menu";
import { toggleInSet } from "@/lib/util/util";
import { t } from "@/lib/i18n";

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
	useEventValue("store:changed", () =>
		pinned.map((id) => (getCommand(id)?.enabled?.() === false ? "0" : "1")).join(""),
	);

	useDialog("inline-panel", (id) => {
		if (panels[id]) setOpenPanels((prev) => toggleInSet(prev, id));
	});

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
	const togglePanel = (id: string) => setOpenPanels((prev) => toggleInSet(prev, id));

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
								<ContextMenu.Trigger
									render={
										<span
											className={`selection-manager__bar-sep${dragIdx === i ? " is-dragging" : ""}`}
											data-drop={dropIdx === i ? "" : undefined}
											onMouseDown={(e) => handleDragStart(i, e)}
											onMouseMove={() => handleDragOver(i)}
										/>
									}
								/>
								<ContextMenu.Portal>
									<ContextMenu.Positioner className="menu-positioner">
										<ContextMenu.Popup className="context-menu">
											<ContextMenu.Item
												className="context-menu__item"
												onClick={() => removePinnedAt(i)}
											>
												{t("Remove separator")}
											</ContextMenu.Item>
										</ContextMenu.Popup>
									</ContextMenu.Positioner>
								</ContextMenu.Portal>
							</ContextMenu.Root>
						);
					}
					const command = getCommand(id);
					if (!command) return null;
					const disabled = command.enabled ? !command.enabled() : false;
					const hasPanel = id in panels;
					const isOpen = openPanels.has(id);
					const handleClick = hasPanel ? () => togglePanel(id) : () => runCommand(command);
					const isFirst = i === 0;
					const isLast = i === pinned.length - 1;

					const btn = command.icon ? (
						<button
							className={clsx("icon-button", {
								"is-active": isOpen,
								"is-disabled": disabled,
								"is-dragging": dragIdx === i,
							})}
							type="button"
							aria-label={t(command.label)}
							data-qa={id}
							data-drop={dropIdx === i ? "" : undefined}
							onClick={disabled ? undefined : handleClick}
							onMouseDown={(e) => handleDragStart(i, e)}
							onMouseMove={() => handleDragOver(i)}
						>
							<Icon path={command.icon} />
						</button>
					) : (
						<Button
							className={clsx({
								"is-active": isOpen,
								"is-disabled": disabled,
								"is-dragging": dragIdx === i,
							})}
							data-drop={dropIdx === i ? "" : undefined}
							onClick={disabled ? undefined : handleClick}
							onMouseDown={(e) => handleDragStart(i, e)}
							onMouseMove={() => handleDragOver(i)}
						>
							{t(command.label)}
						</Button>
					);

					return (
						<ContextMenu.Root key={id}>
							<Tooltip content={t(command.label)} side="bottom">
								<ContextMenu.Trigger render={btn} />
							</Tooltip>
							<ContextMenu.Portal>
								<ContextMenu.Positioner className="menu-positioner">
									<ContextMenu.Popup className="context-menu">
										{!isFirst && (
											<ContextMenu.Item
												className="context-menu__item"
												onClick={() => movePinnedCommand(i, -1)}
											>
												{t("Move left")}
											</ContextMenu.Item>
										)}
										{!isLast && (
											<ContextMenu.Item
												className="context-menu__item"
												onClick={() => movePinnedCommand(i, 1)}
											>
												{t("Move right")}
											</ContextMenu.Item>
										)}
										<ContextMenu.Separator className="context-menu__separator" />
										<ContextMenu.Item
											className="context-menu__item"
											onClick={() => insertSeparator(i, "before")}
										>
											{t("Add separator before")}
										</ContextMenu.Item>
										<ContextMenu.Item
											className="context-menu__item"
											onClick={() => insertSeparator(i, "after")}
										>
											{t("Add separator after")}
										</ContextMenu.Item>
										<ContextMenu.Separator className="context-menu__separator" />
										<ContextMenu.Item
											className="context-menu__item"
											onClick={() => removePinnedAt(i)}
										>
											{t("Remove from toolbar")}
										</ContextMenu.Item>
									</ContextMenu.Popup>
								</ContextMenu.Positioner>
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
						{panel.render(() => setOpenPanels((prev) => toggleInSet(prev, id, false)))}
					</div>
				))}
		</div>
	);
}
