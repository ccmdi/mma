/** A rising version mark that waits park on until it reaches them.
 *  - `reached(v)` resolves at once with `late(v)` when the mark is already at `v` or past it,
 *    otherwise when `pass` or `reset` answers it.
 *  - `pass(v, value)` raises the mark to `v` and answers every wait at or below it with `value`.
 *  - `reset(v, answer)` sets the mark to `v`, up or down, and answers every wait, whatever its
 *    version, with `answer(itsVersion)`. No wait outlives a reset. */
export function watermark<T>(late: (version: number) => T) {
	let mark = 0;
	let waits: { version: number; resolve: (value: T) => void }[] = [];
	return {
		version: (): number => mark,
		reached: (version: number): Promise<T> => {
			if (mark >= version) return Promise.resolve(late(version));
			return new Promise((resolve) => waits.push({ version, resolve }));
		},
		pass: (version: number, value: T) => {
			mark = Math.max(mark, version);
			waits = waits.filter((w) => {
				if (w.version > mark) return true;
				w.resolve(value);
				return false;
			});
		},
		reset: (version: number, answer: (version: number) => T) => {
			mark = version;
			const released = waits;
			waits = [];
			for (const w of released) w.resolve(answer(w.version));
		},
	};
}
