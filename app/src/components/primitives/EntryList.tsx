import type { ReactNode } from "react";

export function EntryList({ children }: { children: ReactNode }) {
	return <ul className="entry-list">{children}</ul>;
}

export function EntryCard({ actions, children }: { actions: ReactNode; children: ReactNode }) {
	return (
		<li className="entry-list__card">
			<div className="entry-list__info">{children}</div>
			<div className="entry-list__actions">{actions}</div>
		</li>
	);
}
