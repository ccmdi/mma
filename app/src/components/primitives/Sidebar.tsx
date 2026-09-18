import type { KeyboardEvent, ReactNode } from "react";
import { Collapsible } from "@base-ui-components/react/collapsible";
import { Hint } from "@/components/primitives/Hint";
import clsx from "clsx";
import { Icon } from "@/components/primitives/Icon";
import { mdiArrowLeft, mdiChevronDown, mdiChevronRight } from "@mdi/js";
import { t } from "@/lib/i18n";
import { IconButton } from "@/components/primitives/IconButton";
/** Standard right-hand sidebar chrome (title, back button, scrollable body). Use for plugin sidebars. */
export function Sidebar({
	title,
	onBack,
	actions,
	className,
	flush,
	children,
}: {
	title: ReactNode;
	onBack?: () => void;
	actions?: ReactNode;
	className?: string;
	flush?: boolean;
	children: ReactNode;
}) {
	return (
		<section className={`map-sidebar plugin-sidebar${className ? ` ${className}` : ""}`}>
			<header className="plugin-sidebar__header">
				{onBack && <IconButton icon={mdiArrowLeft} label={t("Back")} onClick={onBack} />}
				<h2 className="plugin-sidebar__title truncate">{title}</h2>
				{actions && <div className="plugin-sidebar__actions">{actions}</div>}
			</header>
			<div className={`plugin-sidebar__body${flush ? " plugin-sidebar__body--flush" : ""}`}>
				{children}
			</div>
		</section>
	);
}

/** Collapsible titled section inside a Sidebar. */
export function Section({
	title,
	defaultOpen = true,
	collapsible = true,
	addons,
	children,
}: {
	title: ReactNode;
	defaultOpen?: boolean;
	collapsible?: boolean;
	addons?: ReactNode;
	children: ReactNode;
}) {
	const addonSlot = addons && <span className="plugin-section__addons">{addons}</span>;
	if (!collapsible) {
		return (
			<div className="plugin-section">
				<header className="plugin-section__header">
					<span className="plugin-section__title">{title}</span>
					{addonSlot}
				</header>
				<div className="plugin-section__body">{children}</div>
			</div>
		);
	}
	return (
		<Collapsible.Root
			defaultOpen={defaultOpen}
			className="plugin-section plugin-section--collapsible"
			render={(props, state) => (
				<div {...props}>
					<header className="plugin-section__header">
						<Collapsible.Trigger className="plugin-section__trigger">
							<span className="plugin-section__chevron">
								<Icon path={state.open ? mdiChevronDown : mdiChevronRight} size={16} />
							</span>
							<span className="plugin-section__title">{title}</span>
						</Collapsible.Trigger>
						{addonSlot}
					</header>
					<Collapsible.Panel className="plugin-section__body">{children}</Collapsible.Panel>
				</div>
			)}
		/>
	);
}

/** Labelled form row (label left, control right) for sidebar sections. */
export function Field({
	label,
	hint,
	row,
	children,
}: {
	label: ReactNode;
	hint?: ReactNode;
	row?: boolean;
	children: ReactNode;
}) {
	return (
		<div className={`plugin-field${row ? " plugin-field--row" : ""}`}>
			<span className="plugin-field__label">{label}</span>
			{children}
			{hint && <Hint>{hint}</Hint>}
		</div>
	);
}

export interface SegmentedOption<T extends string | number> {
	value: T;
	label: ReactNode;
	disabled?: boolean;
	title?: string;
}

/** Row of mutually exclusive option buttons. `role` is `"tabs"` when the options switch between
 *  panels and `"radio"` (the default) when they pick a value; `fill` stretches the options to
 *  equal widths across the row. */
export function SegmentedControl<T extends string | number>({
	options,
	value,
	onChange,
	role = "radio",
	fill,
	className,
}: {
	options: SegmentedOption<T>[];
	value: T;
	onChange: (value: T) => void;
	role?: "tabs" | "radio";
	fill?: boolean;
	className?: string;
}) {
	const tabs = role === "tabs";
	const step = (e: KeyboardEvent<HTMLDivElement>) => {
		const delta =
			e.key === "ArrowRight" || e.key === "ArrowDown"
				? 1
				: e.key === "ArrowLeft" || e.key === "ArrowUp"
					? -1
					: 0;
		if (!delta) return;
		const enabled = options.filter((o) => !o.disabled);
		const at = enabled.findIndex((o) => o.value === value);
		const next = enabled[(at + delta + enabled.length) % enabled.length];
		if (!next) return;
		e.preventDefault();
		onChange(next.value);
		const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>(".segmented__option");
		buttons[options.indexOf(next)]?.focus();
	};
	return (
		<div
			className={clsx("segmented", fill && "segmented--fill", className)}
			role={tabs ? "tablist" : "radiogroup"}
			onKeyDown={step}
		>
			{options.map((opt) => {
				const selected = opt.value === value;
				return (
					<button
						key={String(opt.value)}
						type="button"
						role={tabs ? "tab" : "radio"}
						aria-selected={tabs ? selected : undefined}
						aria-checked={tabs ? undefined : selected}
						tabIndex={selected ? 0 : -1}
						className={clsx("segmented__option", selected && "is-active")}
						disabled={opt.disabled}
						title={opt.title}
						onClick={() => onChange(opt.value)}
					>
						{opt.label}
					</button>
				);
			})}
		</div>
	);
}
