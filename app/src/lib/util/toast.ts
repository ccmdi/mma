import { createSyncStore } from "@/lib/util/syncStore";

interface ToastEntry {
	id: number;
	message: string;
	progress?: { fraction: number; label?: string };
}

let toasts: ToastEntry[] = [];
let nextId = 0;
const { subscribe: subscribeToasts, notify } = createSyncStore();
export { subscribeToasts };

export function toast(message: string, duration = 2500) {
	const id = nextId++;
	toasts = [...toasts, { id, message }];
	notify();
	setTimeout(() => {
		toasts = toasts.filter((t) => t.id !== id);
		notify();
	}, duration);
}

export interface ProgressHandle {
	update(fraction: number, label?: string): void;
	finish(message?: string, duration?: number): void;
}

export function progressToast(message: string): ProgressHandle {
	const id = nextId++;
	toasts = [...toasts, { id, message, progress: { fraction: 0 } }];
	notify();
	return {
		update(fraction: number, label?: string) {
			toasts = toasts.map((t) => (t.id === id ? { ...t, progress: { fraction, label } } : t));
			notify();
		},
		finish(message?: string, duration = 2500) {
			if (message) {
				toasts = toasts.map((t) => (t.id === id ? { ...t, message, progress: undefined } : t));
				notify();
				setTimeout(() => {
					toasts = toasts.filter((t) => t.id !== id);
					notify();
				}, duration);
			} else {
				toasts = toasts.filter((t) => t.id !== id);
				notify();
			}
		},
	};
}

export function getToasts() {
	return toasts;
}
