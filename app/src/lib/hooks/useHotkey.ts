import { useEffect, useRef, useMemo, useCallback, useEffectEvent } from "react";
import { getCommands } from "@/store/commands";
import { getBinding } from "@/lib/util/hotkeys";

const IS_MAC = /Mac|iPod|iPhone|iPad/i.test(navigator.platform);

interface ParsedKey {
	ctrl: boolean;
	alt: boolean;
	meta: boolean;
	shift: boolean;
	key: string;
}

function parseCombo(combo: string): ParsedKey {
	if (combo === "+") {
		return { ctrl: false, alt: false, meta: false, shift: false, key: "+" };
	}
	const parts = combo.split("+");
	const parsed: ParsedKey = { ctrl: false, alt: false, meta: false, shift: false, key: "" };
	for (const p of parts) {
		const lower = p.toLowerCase();
		if (lower === "mod" || lower === "control" || lower === "ctrl") {
			if (IS_MAC) parsed.meta = true;
			else parsed.ctrl = true;
		} else if (lower === "alt") {
			parsed.alt = true;
		} else if (lower === "meta") {
			parsed.meta = true;
		} else if (lower === "shift") {
			parsed.shift = true;
		} else if (lower === "plus") {
			parsed.key = "+";
		} else {
			parsed.key = lower;
		}
	}
	return parsed;
}

export function parseHotkey(hotkeyStr: string): ParsedKey[][] {
	return hotkeyStr.split(",").map((alt) =>
		alt
			.trim()
			.split(" ")
			.map((combo) => parseCombo(combo.trim())),
	);
}

/** Display form of a stored combo string (e.g. "Mod+k" -> "Ctrl+k" / "Cmd+k"). */
export function formatBinding(binding: string): string {
	return binding
		.replace(/Mod/g, IS_MAC ? "Cmd" : "Ctrl")
		.replace(/ArrowRight/g, "Right")
		.replace(/ArrowLeft/g, "Left")
		.replace(/ArrowUp/g, "Up")
		.replace(/ArrowDown/g, "Down");
}

// Number-row physical key. e.key here is shift-dependent (Shift+0 -> ")"), so we key
// off e.code to speak in base digits and keep Shift explicit in the combo.
const DIGIT_CODE = /^Digit([0-9])$/;

/** Canonical combo string for a captured keydown, or null for a bare modifier. */
export function buildComboString(e: KeyboardEvent): string | null {
	const key = e.key;
	if (["Control", "Alt", "Shift", "Meta"].includes(key)) return null;

	const parts: string[] = [];
	if (e.ctrlKey && !IS_MAC) parts.push("Mod");
	if (e.metaKey && IS_MAC) parts.push("Mod");
	if (e.ctrlKey && IS_MAC) parts.push("Ctrl");
	if (e.metaKey && !IS_MAC) parts.push("Meta");
	if (e.altKey) parts.push("Alt");
	if (e.shiftKey) parts.push("Shift");

	const digit = e.code?.match(DIGIT_CODE);
	let keyName = key;
	if (digit) keyName = digit[1];
	else if (key === " ") keyName = "space";
	else if (key === "=" && !e.shiftKey) keyName = "+";
	else if (key.length === 1) keyName = key.toLowerCase();

	if (keyName === "+" && parts.length === 0) {
		parts.push("plus");
		return parts.join("+");
	}

	parts.push(keyName);
	return parts.join("+");
}

const SHIFTED_CHARS = new Set('?!@#$%^&*()_+{}|:"<>~');

// ignoreAlt: Alt is the global "slow" navigation modifier, so nav handlers match
// bindings regardless of whether Alt is held. Single source of truth for that rule.
export function matchesKey(
	e: KeyboardEvent,
	pk: ParsedKey,
	opts?: { ignoreAlt?: boolean; ignoreShift?: boolean },
): boolean {
	const ctrl = e.ctrlKey;
	const alt = e.altKey;
	const meta = e.metaKey;
	const shift = e.shiftKey;
	const digit = e.code?.match(DIGIT_CODE);
	let key = e.key.toLowerCase();
	if (digit) key = digit[1];
	else if (key === " ") key = "space";
	else if (key === "=") key = "+";

	// Digit row keeps Shift explicit (key is normalized via e.code), so the implied-shift
	// relaxation must not apply or Shift+1 would also match a bare "1" binding.
	const shiftImplied = !digit && (SHIFTED_CHARS.has(pk.key) || SHIFTED_CHARS.has(e.key));

	return (
		ctrl === pk.ctrl &&
		(opts?.ignoreAlt || alt === pk.alt) &&
		meta === pk.meta &&
		(opts?.ignoreShift || shiftImplied || shift === pk.shift) &&
		key === pk.key
	);
}

export function isEditableElement(el: EventTarget | null): boolean {
	if (!(el instanceof HTMLElement)) return false;
	const tag = el.tagName.toLowerCase();
	const type = (el.getAttribute("type") ?? "").toLowerCase();
	return (
		tag === "select" ||
		tag === "textarea" ||
		(tag === "input" &&
			type !== "submit" &&
			type !== "reset" &&
			type !== "checkbox" &&
			type !== "radio" &&
			type !== "file" &&
			type !== "range") ||
		el.isContentEditable
	);
}

export function useHotkey(
	hotkey: string,
	callback: (e: KeyboardEvent) => void,
	options: {
		enableInInputs?: boolean;
		bubble?: boolean;
		ignoreAlt?: boolean;
		ignoreShift?: boolean;
	} = {},
) {
	const parsed = useMemo(() => parseHotkey(hotkey), [hotkey]);

	const onKey = useEffectEvent((e: KeyboardEvent) => {
		if (e.defaultPrevented) return;
		if (!options.enableInInputs && isEditableElement(e.target)) return;

		for (const alt of parsed) {
			if (
				alt.length === 1 &&
				matchesKey(e, alt[0], { ignoreAlt: options.ignoreAlt, ignoreShift: options.ignoreShift })
			) {
				e.preventDefault();
				callback(e);
				return;
			}
		}
	});

	useEffect(() => {
		const handler = (e: KeyboardEvent) => onKey(e);
		// Default: capture phase so global hotkeys fire before focused widgets (e.g. the SV
		// pano viewer) that stopPropagation arrow/wasd keys in their own capture handler.
		// Bubble phase is for lower-priority handlers that yield to capture-phase ones.
		const useCapture = !options.bubble;
		document.addEventListener("keydown", handler, useCapture);
		return () => document.removeEventListener("keydown", handler, useCapture);
	}, [options.bubble]);
}

export function useHotkeyRef<T extends HTMLElement = HTMLButtonElement>(
	hotkey: string,
	options: { enableInInputs?: boolean } = {},
) {
	const ref = useRef<T>(null);
	useHotkey(
		hotkey,
		useCallback(() => {
			ref.current?.click();
		}, []),
		options,
	);
	return ref;
}

export function useCommandHotkeys() {
	useEffect(() => {
		function handler(e: KeyboardEvent) {
			if (e.defaultPrevented) return;
			if (isEditableElement(e.target)) return;

			for (const cmd of getCommands()) {
				const binding = getBinding(cmd.id);
				if (!binding) continue;

				const parsed = parseHotkey(binding);
				for (const alt of parsed) {
					if (alt.length === 1 && matchesKey(e, alt[0])) {
						if (cmd.enabled && !cmd.enabled()) return;
						e.preventDefault();
						cmd.execute();
						return;
					}
				}
			}
		}
		document.addEventListener("keydown", handler, true);
		return () => document.removeEventListener("keydown", handler, true);
	}, []);
}
