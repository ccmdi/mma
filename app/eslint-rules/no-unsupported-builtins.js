import bcd from "@mdn/browser-compat-data" with { type: "json" };

/** The oldest runtime we ship against. Safari = oldest WKWebView we support (also stands in
 *  for WebKitGTK); Chrome sits high because WebView2 is evergreen -- it only catches the rare
 *  builtin Safari shipped first. */
export const FLOOR = { safari: "18.4", chrome: "140" };

function cmp(a, b) {
	const A = String(a).split(".").map(Number);
	const B = String(b).split(".").map(Number);
	for (let i = 0; i < Math.max(A.length, B.length); i++) {
		const d = (A[i] || 0) - (B[i] || 0);
		if (d) return d;
	}
	return 0;
}

/** `version_added` is a version string, `true` (always shipped), `false` (never), `null`
 *  (BCD doesn't know) or "preview". Unknown is not the same as unsupported -- plenty of
 *  `bcd.api` entries are simply unresearched -- so only an explicit `false`/"preview"
 *  blocks. Returns the browser that falls short, or null when everything clears the floor. */
function need(compat) {
	if (!compat) return null;
	let worst = null;
	for (const [browser, floor] of Object.entries(FLOOR)) {
		const raw = compat.support[browser];
		const entry = Array.isArray(raw) ? raw[0] : raw;
		const v = entry?.version_added;
		if (entry?.flags) return `${browser} (behind a flag)`;
		if (v === true || v == null) continue;
		if (v === false || v === "preview") return `${browser} (unshipped)`;
		if (typeof v === "string" && cmp(v, floor) > 0) worst ??= `${browser} ${v}`;
	}
	return worst;
}

const blockedGlobals = new Map(); // Temporal -> "safari (unshipped)"
const blockedMembers = new Map(); // Iterator -> Map(take -> "safari 18.4")

/** BCD tags statics as `parse_static` and annotations as `foo_event`, `foo_permission` etc.
 *  Peel the static marker; anything still carrying an underscore is an annotation, not a
 *  property anyone writes. */
function memberName(key) {
	const name = key.replace(/_static$/, "");
	return name.includes("_") ? null : name;
}

// Both namespaces feed the same tables. `javascript.builtins` covers the language,
// `api` covers everything the platform adds (Blob, URL, AbortSignal, ...).
for (const namespace of [bcd.javascript.builtins, bcd.api]) {
	for (const [owner, node] of Object.entries(namespace)) {
		const ownerReq = need(node.__compat);
		if (ownerReq) {
			// The whole global is out of reach; flagging the identifier covers every member.
			blockedGlobals.set(owner, ownerReq);
			continue;
		}
		const members = blockedMembers.get(owner) ?? new Map();
		for (const [key, sub] of Object.entries(node)) {
			if (key === "__compat" || !sub?.__compat) continue;
			const member = memberName(key);
			const req = member && need(sub.__compat);
			if (req) members.set(member, req);
		}
		if (members.size) blockedMembers.set(owner, members);
	}
}

/** TypeScript's lib names the declaring interface differently from BCD in three mechanical
 *  ways: statics live on `XConstructor`, immutable views on `ReadonlyX`, and iterator
 *  helpers on `IteratorObject`. Peel those and see what BCD recognises. */
function toBcdOwner(name) {
	if (!name) return null;
	const candidates = [
		name,
		name.replace(/Constructor$/, ""),
		name.replace(/^Readonly/, ""),
		name.replace(/Object$/, ""),
	];
	return candidates.find((c) => bcd.javascript.builtins[c] || bcd.api[c]) ?? null;
}

/** Every reference to a name this file never declares: unresolved identifiers plus the
 *  predefined globals from `languageOptions.globals` (which resolve, but carry no defs). */
function globalReferences(sourceCode) {
	const gs = sourceCode.scopeManager.globalScope;
	const refs = [...gs.through];
	for (const v of gs.variables) if (v.defs.length === 0) refs.push(...v.references);
	return refs;
}

export default {
	meta: {
		type: "problem",
		docs: {
			description:
				"Ban ECMAScript builtins and Web APIs newer than the runtime support floor, per MDN compat data.",
		},
		schema: [],
		messages: {
			unsupported:
				"{{name}} needs {{req}}; our floor is {{floor}}. Raise FLOOR in eslint-rules/no-unsupported-builtins.js only if you mean to stop supporting older macOS and WebKitGTK.",
		},
	},
	create(context) {
		const floor = Object.entries(FLOOR)
			.map(([b, v]) => `${b} ${v}`)
			.join(" / ");
		const report = (node, name, req) =>
			context.report({ node, messageId: "unsupported", data: { name, req, floor } });

		// Member checks need the type checker to know what the receiver is. Without type
		// information only the global checks below run.
		const services = context.sourceCode.parserServices;
		const program = services?.program;

		/** The builtin a property access resolves to, or null when it isn't a builtin at all
		 *  (our own classes land here, which is what keeps `PbMsg.toArray()` quiet). */
		function ownerOf(node, member) {
			const type = services.getTypeAtLocation(node.object);
			const symbol = type && program.getTypeChecker().getPropertyOfType(type, member);
			for (const decl of symbol?.declarations ?? []) {
				if (!program.isSourceFileDefaultLibrary(decl.getSourceFile())) continue;
				const owner = toBcdOwner(decl.parent?.name?.text);
				if (owner) return owner;
			}
			return null;
		}

		// Statics reached straight off a global (`Intl.DurationFormat`) are settled by scope
		// analysis alone, which also covers namespaces the checker won't hand us a property
		// symbol for. Recorded so the type pass below doesn't report them twice.
		const seen = new Set();

		return {
			"Program:exit"() {
				for (const ref of globalReferences(context.sourceCode)) {
					const id = ref.identifier;
					const req = blockedGlobals.get(id.name);
					if (req) {
						report(id, id.name, req);
						continue;
					}
					const members = blockedMembers.get(id.name);
					const p = id.parent;
					if (!members || p?.type !== "MemberExpression" || p.object !== id) continue;
					if (p.computed || p.property.type !== "Identifier") continue;
					const memberReq = members.get(p.property.name);
					if (memberReq && !seen.has(p.property)) {
						seen.add(p.property);
						report(p.property, `${id.name}.${p.property.name}`, memberReq);
					}
				}
			},
			MemberExpression(node) {
				if (!program || node.computed || node.property.type !== "Identifier") return;
				const member = node.property.name;
				// Cheap reject first: most property accesses share no name with a blocked
				// member, and asking the checker for a type is the expensive part.
				let anyOwner = false;
				for (const members of blockedMembers.values()) {
					if (members.has(member)) {
						anyOwner = true;
						break;
					}
				}
				if (!anyOwner) return;

				const owner = ownerOf(node, member);
				const req = owner && blockedMembers.get(owner)?.get(member);
				if (req && !seen.has(node.property)) {
					seen.add(node.property);
					report(node.property, `${owner}.${member}`, req);
				}
			},
		};
	},
};
