/** Text the worker publishes is posted as the App, so a mention in it would have the App ping
 *  whoever it names. A word joiner after the `@` is invisible and stops GitHub linking it. */

const WORD_JOINER = "⁠";

/** Inline code, HTML comments and bare URLs: GitHub never mentions inside them. */
const INERT = /(`+)[\s\S]*?(?<!`)\1(?!`)|<!--[\s\S]*?(?:-->|$)|(?:https?:\/\/|www\.)[^\s<>]+/g;

/** A letter or digit before the `@` makes it an email address instead. */
const MENTION = /(?<![A-Za-z0-9])@(?=[A-Za-z0-9])/g;

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function defuseProse(text: string): string {
	let out = "";
	let last = 0;
	for (const m of text.matchAll(INERT)) {
		out += text.slice(last, m.index).replace(MENTION, `@${WORD_JOINER}`) + m[0];
		last = m.index + m[0].length;
	}
	return out + text.slice(last).replace(MENTION, `@${WORD_JOINER}`);
}

/** `markdown` with every mention defused and everything else byte-exact. */
export function defuseMentions(markdown: string): string {
	const out: string[] = [];
	let prose: string[] = [];
	let fence: string | null = null;
	const flush = () => {
		if (prose.length) out.push(defuseProse(prose.join("\n")));
		prose = [];
	};
	for (const line of markdown.split("\n")) {
		const m = FENCE.exec(line);
		if (fence) {
			out.push(line);
			// CommonMark: a fence closes on a bare run of its own character at least as long.
			if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim()) {
				fence = null;
			}
		} else if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
			flush();
			fence = m[1];
			out.push(line);
		} else {
			prose.push(line);
		}
	}
	flush();
	return out.join("\n");
}
