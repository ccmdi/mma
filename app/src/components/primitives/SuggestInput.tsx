import { useState, useEffect, useRef, type ReactNode, type CSSProperties } from "react";
import { Popover } from "@base-ui-components/react/popover";
import { useClickOutside } from "@/lib/hooks/useClickOutside";

/** Text input with a suggestion dropdown. Enter picks the first suggestion; Escape or an
 *  outside click closes it. The dropdown shows whenever `suggestions` is non-empty, so
 *  filter or fetch them yourself. The class props restyle it. @unstable */
export function SuggestInput<T>({
	value,
	onChange,
	suggestions,
	onPick,
	renderItem,
	getKey,
	placeholder,
	containerClassName,
	inputClassName = "text-input",
	listClassName = "search-results",
	itemClassName = "search-result",
	listStyle,
	autoFocus,
	disabled,
	pickOnEnter = true,
	portal = false,
}: {
	value: string;
	onChange: (v: string) => void;
	suggestions: T[];
	onPick: (item: T) => void;
	renderItem: (item: T) => ReactNode;
	getKey: (item: T) => string | number;
	placeholder?: string;
	containerClassName?: string;
	inputClassName?: string;
	listClassName?: string;
	itemClassName?: string;
	listStyle?: CSSProperties;
	autoFocus?: boolean;
	disabled?: boolean;
	/** When false, Enter closes the dropdown and falls through (e.g. to a form submit). */
	pickOnEnter?: boolean;
	/** Render the dropdown in a body portal, anchored to the input and following it as it
	 *  moves, so it floats over clipping ancestors like `.modal__content`. Clicks on it are
	 *  exempted from dialog outside-dismissal via the `suggest-portal` class (see DialogContent). */
	portal?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const listRef = useRef<HTMLOListElement>(null);
	// Highlight lives in the DOM (aria-selected), not React state, so mouse movement
	// over the list re-renders nothing. The ref only answers "what does Enter pick".
	const highlightRef = useRef(0);

	const applyHighlight = (i: number, scroll = false) => {
		const items = listRef.current?.children;
		if (!items) return;
		items[highlightRef.current]?.setAttribute("aria-selected", "false");
		highlightRef.current = i;
		const next = items[i];
		next?.setAttribute("aria-selected", "true");
		if (scroll) next?.scrollIntoView({ block: "nearest" });
	};

	useEffect(() => {
		highlightRef.current = 0;
		const items = listRef.current?.children;
		if (!items) return;
		for (let i = 0; i < items.length; i++) items[i].setAttribute("aria-selected", String(i === 0));
	}, [suggestions]);

	// The portaled list carries `suggest-portal`, which useClickOutside exempts; a
	// non-portaled list sits inside the container.
	useClickOutside(containerRef, () => setOpen(false), open);

	const pick = (item: T) => {
		onPick(item);
		setOpen(false);
	};

	const shown = open && suggestions.length > 0;
	const list = (
		<ol
			ref={listRef}
			className={listClassName}
			hidden={!shown}
			style={
				portal
					? {
							position: "static",
							width: "var(--anchor-width)",
							pointerEvents: "auto",
							...listStyle,
						}
					: listStyle
			}
		>
			{suggestions.map((item, i) => (
				<li key={getKey(item)} aria-selected={i === 0}>
					<button
						type="button"
						className={itemClassName}
						onMouseMove={() => {
							if (highlightRef.current !== i) applyHighlight(i);
						}}
						onClick={() => pick(item)}
					>
						{renderItem(item)}
					</button>
				</li>
			))}
		</ol>
	);

	return (
		<div
			ref={containerRef}
			className={containerClassName}
			style={{ position: "relative" }}
			aria-expanded={open && suggestions.length > 0}
		>
			<input
				className={inputClassName}
				type="text"
				placeholder={placeholder}
				value={value}
				autoFocus={autoFocus}
				disabled={disabled}
				onChange={(e) => {
					onChange(e.target.value);
					setOpen(true);
				}}
				onFocus={() => suggestions.length > 0 && setOpen(true)}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown" && open && suggestions.length > 0) {
						e.preventDefault();
						applyHighlight(Math.min(highlightRef.current + 1, suggestions.length - 1), true);
					}
					if (e.key === "ArrowUp" && open && suggestions.length > 0) {
						e.preventDefault();
						applyHighlight(Math.max(highlightRef.current - 1, 0), true);
					}
					if (e.key === "Enter" && open) {
						if (pickOnEnter && suggestions.length > 0) {
							e.preventDefault();
							pick(suggestions[Math.min(highlightRef.current, suggestions.length - 1)]);
						} else {
							setOpen(false);
						}
					}
					if (e.key === "Escape" && open) {
						e.stopPropagation();
						setOpen(false);
					}
				}}
			/>
			{portal ? (
				<Popover.Root
					open={shown}
					onOpenChange={(next, details) => {
						if (next) return;
						// Pressing the input itself is not "outside": it would close and re-open.
						const target = details.event?.target;
						if (target instanceof Node && containerRef.current?.contains(target)) {
							details.cancel();
							return;
						}
						setOpen(false);
					}}
				>
					<Popover.Portal>
						<Popover.Positioner className="suggest-portal" anchor={containerRef} align="start">
							<Popover.Popup initialFocus={false} finalFocus={false}>
								{list}
							</Popover.Popup>
						</Popover.Positioner>
					</Popover.Portal>
				</Popover.Root>
			) : (
				list
			)}
		</div>
	);
}
