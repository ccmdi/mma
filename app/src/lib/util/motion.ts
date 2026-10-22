/** How a smoothed value moves toward its target. `ease` closes the gap exponentially with time
 *  constant `ease` ms; `spring` is a damped spring of angular frequency `spring` per ms; both stop
 *  once `settled(gap, velocity)` holds. `glide` eases out over `glide` ms from wherever the value
 *  was when the target last changed. */
export type Motion =
	| { ease: number; settled: Settled }
	| { spring: number; damping: number; settled: Settled }
	| { glide: number };

type Settled = (gap: number[], velocity: number[]) => boolean;

const SPRING_STEP_MS = 4;
const SPRING_SPAN_MS = 50;

export type Smoothed = {
	/** Where it is now; whoever moves it otherwise sets it here before the next step. */
	value: number[];
	/** Move `dt` ms toward `target`, landing on it exactly once settled or when `dt` is infinite.
	 *  Says whether it is still moving. */
	step(target: readonly number[], dt: number): boolean;
};

/** A tuple of numbers that moves toward its target the way `motion` says, one step at a time. */
export function smoothed(motion: Motion, initial: readonly number[]): Smoothed {
	const velocity = initial.map(() => 0);
	let from = [...initial];
	let to = [...initial];
	let elapsed = 0;
	const gap = (target: readonly number[]) => self.value.map((v, i) => target[i] - v);
	const settles = (target: readonly number[], dt: number): boolean => {
		const value = self.value;
		if ("ease" in motion) {
			const k = 1 - Math.exp(-dt / motion.ease);
			for (let i = 0; i < value.length; i++) value[i] += (target[i] - value[i]) * k;
			return motion.settled(gap(target), velocity);
		}
		if ("spring" in motion) {
			const { spring: w, damping } = motion;
			for (let left = Math.min(dt, SPRING_SPAN_MS); left > 0; left -= SPRING_STEP_MS) {
				const h = Math.min(SPRING_STEP_MS, left);
				for (let i = 0; i < value.length; i++) {
					velocity[i] += (w ** 2 * (target[i] - value[i]) - 2 * damping * w * velocity[i]) * h;
					value[i] += velocity[i] * h;
				}
			}
			return motion.settled(gap(target), velocity);
		}
		if (target.some((v, i) => v !== to[i])) {
			from = [...value];
			to = [...target];
			elapsed = 0;
		} else elapsed += dt;
		const f = Math.min(1, elapsed / motion.glide);
		const e = 1 - (1 - f) ** 3;
		for (let i = 0; i < value.length; i++) value[i] = from[i] + (target[i] - from[i]) * e;
		return f === 1;
	};
	const self: Smoothed = {
		value: [...initial],
		step(target, dt) {
			if (dt < Infinity && !settles(target, dt)) return true;
			self.value = [...target];
			velocity.fill(0);
			from = [...target];
			to = [...target];
			return false;
		},
	};
	return self;
}

/** Run `step` on animation frames for as long as it asks: it gets the ms since it last ran and
 *  returns how long until it next needs to, 0 for the next frame and Infinity for when woken. */
export function frameLoop(step: (dt: number, now: number) => number) {
	let raf = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let ranAt = 0;
	const run = () => {
		raf = 0;
		const now = performance.now();
		const next = step(now - ranAt, now);
		ranAt = now;
		clearTimeout(timer);
		if (next <= 0) raf ||= requestAnimationFrame(run);
		else if (next < Infinity) timer = setTimeout(wake, next);
	};
	const wake = () => {
		if (raf) return;
		ranAt = performance.now();
		raf = requestAnimationFrame(run);
	};
	return {
		/** Run on the next frame. */
		wake,
		/** Stop until woken again. */
		stop: () => {
			cancelAnimationFrame(raf);
			raf = 0;
			clearTimeout(timer);
		},
	};
}
