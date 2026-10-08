import { fmt } from "@/lib/util/format";

export function DiffCounts({
	added,
	removed,
	updated,
	hideZero = false,
}: {
	added: number;
	removed: number;
	updated: number;
	hideZero?: boolean;
}) {
	const show = (n: number) => !hideZero || n > 0;
	return (
		<span className="diff-counts mono">
			{show(added) && <span className="diff-counts__added">+{fmt.format(added)}</span>}
			{show(removed) && <span className="diff-counts__removed">-{fmt.format(removed)}</span>}
			{show(updated) && <span className="diff-counts__updated">&plusmn;{fmt.format(updated)}</span>}
		</span>
	);
}
