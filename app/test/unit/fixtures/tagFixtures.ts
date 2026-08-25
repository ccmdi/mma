import type { TagTreeNode } from "@/components/editor/tags/tagTreeRange";
import type { Tag } from "@/bindings.gen";

export const mkTag = (id: number, name: string, color = "#888888", order = id): Tag => ({
	id,
	name,
	color,
	order,
});

export function findNode(nodes: TagTreeNode[], path: string): TagTreeNode | null {
	for (const n of nodes) {
		if (n.fullPath === path) return n;
		const hit = findNode(n.children, path);
		if (hit) return hit;
	}
	return null;
}

export const segs = (nodes: TagTreeNode[]) => nodes.map((n) => n.segment);
