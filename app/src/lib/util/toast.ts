import { emit as emitEvent } from "@/lib/events";

interface ToastEntry {
	id: number;
	message: string;
}

let toasts: ToastEntry[] = [];
let nextId = 0;

/** Show a brief toast notification. Optionally scoped to a `container` element. */
export function toast(message: string, duration = 2500, container?: HTMLElement) {
	if (container) {
		const el = document.createElement("div");
		el.textContent = message;
		el.className = "toast-entry toast-entry--scoped popover-surface";
		container.appendChild(el);
		setTimeout(() => el.remove(), duration);
		return;
	}
	const id = nextId++;
	toasts = [...toasts, { id, message }];
	emitEvent("toasts:changed");
	setTimeout(() => {
		toasts = toasts.filter((t) => t.id !== id);
		emitEvent("toasts:changed");
	}, duration);
}

/** Current list of visible toasts. @unstable */
export function getToasts() {
	return toasts;
}
