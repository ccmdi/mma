import { useState, type ReactNode } from "react";
import { Icon } from "@/components/primitives/Icon";
import { mdiArrowLeft, mdiChevronDown, mdiChevronRight } from "@mdi/js";
import { t } from "@/lib/i18n";
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
				{onBack && (
					<button className="icon-button" type="button" aria-label={t("Back")} onClick={onBack}>
						<Icon path={mdiArrowLeft} />
					</button>
				)}
				<h2 className="plugin-sidebar__title">{title}</h2>
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
	const [open, setOpen] = useState(defaultOpen);
	const show = collapsible ? open : true;
	return (
		<div className={`plugin-section${collapsible ? " plugin-section--collapsible" : ""}`}>
			<header
				className="plugin-section__header"
				onClick={collapsible ? () => setOpen((o) => !o) : undefined}
			>
				{collapsible && (
					<span className="plugin-section__chevron">
						<Icon path={open ? mdiChevronDown : mdiChevronRight} size={16} />
					</span>
				)}
				<span className="plugin-section__title">{title}</span>
				{addons && <span className="plugin-section__addons">{addons}</span>}
			</header>
			{show && <div className="plugin-section__body">{children}</div>}
		</div>
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
			{hint && <span className="plugin-field__hint">{hint}</span>}
		</div>
	);
}

/** Centered icon + message for empty panels. */
export function EmptyState({ icon, children }: { icon?: string; children: ReactNode }) {
	return (
		<div className="plugin-empty">
			{icon && <Icon path={icon} size={28} className="plugin-empty__icon" />}
			<div>{children}</div>
		</div>
	);
}

export interface SegmentedOption<T extends string | number> {
	value: T;
	label: ReactNode;
	disabled?: boolean;
	title?: string;
}

/** Row of mutually exclusive option buttons (a compact radio group). */
export function SegmentedControl<T extends string | number>({
	options,
	value,
	onChange,
	className,
}: {
	options: SegmentedOption<T>[];
	value: T;
	onChange: (value: T) => void;
	className?: string;
}) {
	return (
		<div className={`segmented${className ? ` ${className}` : ""}`} role="tablist">
			{options.map((opt) => (
				<button
					key={String(opt.value)}
					type="button"
					role="tab"
					aria-selected={opt.value === value}
					className={`segmented__option${opt.value === value ? " is-active" : ""}`}
					disabled={opt.disabled}
					title={opt.title}
					onClick={() => onChange(opt.value)}
				>
					{opt.label}
				</button>
			))}
		</div>
	);
}
