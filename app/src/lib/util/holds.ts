/** A count of holds on something: `hold` takes one and returns its release, which counts once
 *  however often it is called; `held` says whether any is taken. `changed` runs after each hold
 *  and each release. */
export function holds(changed: () => void) {
	let count = 0;
	return {
		hold: (): (() => void) => {
			let released = false;
			count++;
			changed();
			return () => {
				if (released) return;
				released = true;
				count--;
				changed();
			};
		},
		held: () => count > 0,
	};
}
