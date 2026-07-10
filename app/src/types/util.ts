/* eslint-disable @typescript-eslint/no-explicit-any */
type Digits = {
	"0": [];
	"1": [0];
	"2": [0, 0];
	"3": [0, 0, 0];
	"4": [0, 0, 0, 0];
	"5": [0, 0, 0, 0, 0];
	"6": [0, 0, 0, 0, 0, 0];
	"7": [0, 0, 0, 0, 0, 0, 0];
	"8": [0, 0, 0, 0, 0, 0, 0, 0];
	"9": [0, 0, 0, 0, 0, 0, 0, 0, 0];
};
type D = keyof Digits;

type CmpDigit<A extends D, B extends D> = Digits[A] extends [...Digits[B], ...infer R]
	? R extends []
		? "eq"
		: "gt"
	: "lt";
type BuildLen<S extends string, Acc extends any[] = []> = S extends `${string}${infer R}`
	? BuildLen<R, [...Acc, any]>
	: Acc;
type Len<S extends string> = BuildLen<S>["length"];
type CmpSameLen<A extends string, B extends string> = A extends `${infer Ad extends D}${infer Ar}`
	? B extends `${infer Bd extends D}${infer Br}`
		? CmpDigit<Ad, Bd> extends "eq"
			? CmpSameLen<Ar, Br>
			: CmpDigit<Ad, Bd>
		: "gt"
	: "eq";

// Compare two non-negative INTEGER strings.
type CmpInt<As extends string, Bs extends string> =
	Len<As> extends Len<Bs>
		? CmpSameLen<As, Bs>
		: [...BuildLen<As>] extends [...BuildLen<Bs>, any, ...any[]]
			? "gt"
			: "lt";

// Split "12.34" -> ["12","34"];  "12" -> ["12",""].
type SplitDec<S extends string> = S extends `${infer I}.${infer F}` ? [I, F] : [S, ""];
// Right-pad a fraction with zeros so two fractions can be compared left-aligned.
type PadRight<S extends string, ToLen extends any[]> =
	BuildLen<S> extends [...ToLen, ...any[]] ? S : PadRight<`${S}0`, ToLen>;
type CmpFrac<Fa extends string, Fb extends string> =
	PadRight<Fa, BuildLen<Fb>> extends infer PA extends string
		? PadRight<Fb, BuildLen<Fa>> extends infer PB extends string
			? CmpSameLen<PA, PB>
			: never
		: never;

// Magnitude compare of two non-negative DECIMAL strings: integer part first, then fraction.
type CmpMag<As extends string, Bs extends string> =
	SplitDec<As> extends [infer Ia extends string, infer Fa extends string]
		? SplitDec<Bs> extends [infer Ib extends string, infer Fb extends string]
			? CmpInt<Ia, Ib> extends "eq"
				? CmpFrac<Fa, Fb>
				: CmpInt<Ia, Ib>
			: never
		: never;

type Abs<A extends number> = `${A}` extends `-${infer R}` ? R : `${A}`;
type IsNeg<A extends number> = `${A}` extends `-${string}` ? true : false;

type LessThan<A extends number, B extends number> =
	IsNeg<A> extends true
		? IsNeg<B> extends true
			? CmpMag<Abs<A>, Abs<B>> extends "gt"
				? true
				: false // both negative: a<b ⇔ |a|>|b|
			: true // a negative, b non-negative
		: IsNeg<B> extends true
			? false // a non-negative, b negative
			: CmpMag<Abs<A>, Abs<B>> extends "lt"
				? true
				: false; // both non-negative

export type Range = { min: number; max: number };

export const range = <const T extends readonly [number, number]>(
	t: LessThan<T[0], T[1]> extends true ? T : ["ERROR: first must be < second", never],
): { min: T[0]; max: T[1] } => {
	const tup = t as T;
	return { min: tup[0], max: tup[1] };
};

export const clamp = (val: number, r: Range): number => Math.min(r.max, Math.max(r.min, val));

export type RequireNonNull<T> = { [P in keyof T]-?: NonNullable<T[P]> };
export type Nullable<T> = { [K in keyof T]: T[K] | null };
export type Rename<T, Map extends Record<string, string>> = {
	[K in keyof T as K extends keyof Map ? Map[K] : K]: T[K];
};

/** The member(s) of union `U` whose discriminant `D` (default `"type"`) is `V`. */
export type Variant<U, V extends U[D], D extends keyof U = "type" & keyof U> = Extract<
	U,
	Record<D, V>
>;

/** Narrowing guard: is `value` one of the given variant tag(s)? */
export function isVariant<U, const V extends U[D], D extends keyof U = "type" & keyof U>(
	value: U,
	tag: V | readonly V[],
	discriminant: D = "type" as D,
): value is Extract<U, Record<D, V>> {
	const tags = (Array.isArray(tag) ? tag : [tag]) as readonly PropertyKey[];
	return tags.includes(value[discriminant] as PropertyKey);
}

/**
 * Build a readonly tuple the compiler verifies contains *every* member of union
 * `T` (in any order). Omitting one is a type error naming the missing member.
 */
export const unionTuple =
	<T extends PropertyKey>() =>
	<const U extends readonly T[]>(
		tuple: U & ([T] extends [U[number]] ? unknown : { readonly __missing: Exclude<T, U[number]> }),
	): U =>
		tuple;
