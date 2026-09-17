import {
	useState,
	useEffect,
	useLayoutEffect,
	useRef,
	type ReactNode,
	type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
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
	/** Render the dropdown in a body portal (fixed, anchored to the input) so it floats
	 *  over clipping ancestors like `.modal__content`. Clicks on it are exempted from
	 *  dialog outside-dismissal via the `suggest-portal` class (see DialogContent). */
	portal?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [anchor, setAnchor] = useState<DOMRect | null>(null);
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

	useLayoutEffect(() => {
		if (!portal || !open) return;
		const update = () => setAnchor(containerRef.current?.getBoundingClientRect() ?? null);
		update();
		const ac = new AbortController();
		window.addEventListener("resize", update, { signal: ac.signal });
		window.addEventListener("scroll", update, { capture: true, signal: ac.signal });
		return () => ac.abort();
	}, [portal, open]);

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

	const list = (
		<ol
			ref={listRef}
			className={portal ? `${listClassName} suggest-portal` : listClassName}
			hidden={!open || suggestions.length === 0}
			style={
				portal
					? {
							position: "fixed",
							top: anchor?.bottom ?? 0,
							left: anchor?.left ?? 0,
							width: anchor?.width,
							zIndex: "var(--z-popover)",
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
			{portal ? createPortal(list, document.body) : list}
		</div>
	);
}
