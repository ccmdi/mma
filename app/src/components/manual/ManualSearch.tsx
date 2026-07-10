import { useState, useMemo, useRef } from "react";
import * as RadixDialog from "@radix-ui/react-dialog";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { searchManual } from "@/components/manual/search";
import { openManual } from "@/store/router";
import "@/components/manual/manual.css";

export function ManualSearch({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (v: boolean) => void;
}) {
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const results = useMemo(() => searchManual(query), [query]);

	const choose = (id: string) => {
		onOpenChange(false);
		openManual(id);
	};

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setActive((a) => Math.min(a + 1, results.length - 1));
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			setActive((a) => Math.max(a - 1, 0));
		} else if (e.key === "Enter") {
			e.preventDefault();
			const r = results[active];
			if (r) choose(r.id);
		}
	};

	return (
		<RadixDialog.Root open={open} onOpenChange={onOpenChange}>
			<RadixDialog.Portal>
				<RadixDialog.Overlay className="modal__backdrop" />
				<RadixDialog.Content
					className="modal command-palette manual-search"
					aria-describedby={undefined}
				>
					<VisuallyHidden.Root>
						<RadixDialog.Title>Search the manual</RadixDialog.Title>
					</VisuallyHidden.Root>
					<div className="manual-search__panel">
						<input
							ref={inputRef}
							autoFocus
							value={query}
							onChange={(e) => {
								setQuery(e.target.value);
								setActive(0);
							}}
							onKeyDown={onKeyDown}
							placeholder="Search the manual..."
							className="command-palette__input"
						/>
						<div className="command-palette__scroll manual-search__results">
							{query.trim() && results.length === 0 && (
								<div className="manual-search__empty">No results.</div>
							)}
							{results.map((r, i) => (
								<button
									key={r.id}
									className={
										i === active ? "manual-search__result is-active" : "manual-search__result"
									}
									onMouseMove={() => setActive(i)}
									onClick={() => choose(r.id)}
								>
									<span className="manual-search__result-title">{r.title}</span>
									<span className="manual-search__result-snippet">{r.snippet}</span>
								</button>
							))}
						</div>
					</div>
				</RadixDialog.Content>
			</RadixDialog.Portal>
		</RadixDialog.Root>
	);
}
