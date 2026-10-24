/** Writes a field's value the way typing would, so its change handler runs. */
export function setInputValue(input: HTMLInputElement, value: string) {
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

export type DropZone = "before" | "on" | "after";

/** Where a pointer `at` of the way along a row drops: onto its middle half when the row
 *  takes drops `onto` it, otherwise beside it on the nearer side. */
export const dropZone = (at: number, onto: boolean): DropZone =>
	onto && at > 0.25 && at < 0.75 ? "on" : at < 0.5 ? "before" : "after";
