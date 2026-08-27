/** Accountless issue intake for MMA.
 *
 *  This is a front door, not a tracker. It files the issue on GitHub and forgets it: there is
 *  no database, no user record, and no copy of the report here. The reply token is an HMAC of
 *  the issue number, so reads are authorized arithmetically rather than by lookup.
 *
 *  Signed-in users never touch this worker -- the app talks to GitHub directly as them. */

import {
	addLabels,
	createIssue,
	getIssue,
	referencedAttachments,
	relayedComments,
} from "./github";
import {
	hmacHex,
	imageType,
	mintChallenge,
	safeEqual,
	sha256Hex,
	validChallenge,
	verifyPow,
} from "./verify";

export interface Env {
	/** Numeric id of the GitHub App. */
	GITHUB_APP_ID: string;
	/** PKCS#8 PEM private key for that App. */
	GITHUB_APP_KEY: string;
	/** `owner/repo` the App is installed on. */
	GITHUB_REPO: string;
	/** Signing key for reply tokens. Rotating it invalidates every outstanding token. */
	WORKER_SECRET: string;
	/** Images referenced by report bodies. GitHub's own attachment store is unreachable from
	 *  here -- it rejects both App installation and user-to-server tokens -- so the images a
	 *  reporter attaches live in a bucket and are served back by the route below. */
	ATTACHMENTS: R2Bucket;
	/** Per-IP request ceiling. The proof of work prices a single request; this caps how many
	 *  of them one address can spend, so neither the bucket nor the GitHub API budget can be
	 *  drained from a loop. */
	RATE: RateLimit;
}

/** Must match `POW_BITS` in `app/src-tauri/src/net/feedback.rs`. */
const POW_BITS = 20;

const MAX_TITLE = 200;
const MAX_BODY = 65_000;

/** Per attachment. Generous for a screenshot, small enough that the proof of work above is a
 *  real cost per megabyte stored. The app caps the count. */
const MAX_ATTACHMENT = 5 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
};

/** Marks a body as one of ours. The label route will touch nothing without it. */
const MARKER = "<!-- mma-report ";

/** The only labels this worker will ever apply, keyed by the report kind in the machine block.
 *  An allowlist rather than a passthrough: the body is written by the client, so anything read
 *  out of it is untrusted input. */
const KIND_LABELS: Record<string, string> = { bug: "bug", idea: "enhancement" };

/** The report kind declared in the body's machine block, if it is one of ours. */
export function reportKind(body: string): string | null {
	const start = body.indexOf(MARKER);
	if (start === -1) return null;
	const end = body.indexOf(" -->", start);
	if (end === -1) return null;
	try {
		const meta = JSON.parse(body.slice(start + MARKER.length, end)) as { kind?: unknown };
		return typeof meta.kind === "string" && meta.kind in KIND_LABELS ? meta.kind : null;
	} catch {
		return null;
	}
}

interface ReportRequest {
	title?: unknown;
	body?: unknown;
	installId?: unknown;
	challenge?: unknown;
	nonce?: unknown;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function bad(message: string, status = 400): Response {
	return json({ error: message }, status);
}

async function replyToken(env: Env, number: number): Promise<string> {
	return hmacHex(env.WORKER_SECRET, `report:${number}`);
}

async function handleSubmit(request: Request, env: Env): Promise<Response> {
	// Ceiling well above any legal payload (title + body + JSON escaping)
	const declared = Number(request.headers.get("Content-Length"));
	if (!Number.isInteger(declared) || declared > 512 * 1024) return bad("report too large", 413);

	let payload: ReportRequest;
	try {
		payload = (await request.json()) as ReportRequest;
	} catch {
		return bad("malformed request");
	}

	const { title, body, installId, challenge, nonce } = payload;
	if (typeof title !== "string" || typeof body !== "string" || typeof installId !== "string") {
		return bad("missing fields");
	}
	if (!title.trim() || !body.trim()) return bad("empty report");
	if (title.length > MAX_TITLE || body.length > MAX_BODY) return bad("report too large", 413);
	if (typeof challenge !== "string" || !(await validChallenge(env.WORKER_SECRET, challenge))) {
		return bad("expired or invalid challenge", 429);
	}
	if (typeof nonce !== "number") return bad("missing proof of work");

	// The work is bound to this exact title+body pair and to the challenge's lifetime, so a
	// solved nonce cannot be recycled for other content or stockpiled for later.
	const content = await sha256Hex(`${title}\u0000${body}`);
	if (!(await verifyPow(`${challenge}:${content}`, nonce, POW_BITS))) {
		return bad("insufficient proof of work", 429);
	}

	// Every body the app composes ends with the machine block. Its absence does not prove
	// abuse, but a report without one did not come from the app, and only the app's reports
	// are ours to file under this identity.
	const kind = reportKind(body);
	if (!kind) return bad("not an app report", 403);

	const labels = ["via:app", "anonymous", KIND_LABELS[kind]];
	const issue = await createIssue(env, title, body, labels);
	return json({ ...issue, token: await replyToken(env, issue.number) });
}

/** A display name that cannot carry markup into the alt text of the reference. The extension
 *  comes from the sniffed type, never from what the client claimed. */
function safeName(raw: string | null, contentType: string): string {
	const stem =
		(raw ?? "")
			.replace(/\.[^.]*$/, "")
			.replace(/[^\w.-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "attachment";
	return `${stem}.${EXTENSIONS[contentType]}`;
}

/** Store an image and hand back the URL to reference it by.
 *
 *  Separate from the report itself because the body has to carry the URLs, so the upload has
 *  to happen first. Both tiers come through here: the app cannot reach any image host of its
 *  own, and GitHub's is closed to us. */
async function handleUpload(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const challenge = url.searchParams.get("challenge") ?? "";
	if (!(await validChallenge(env.WORKER_SECRET, challenge))) {
		return bad("expired or invalid challenge", 429);
	}
	const declared = Number(request.headers.get("Content-Length"));
	if (!Number.isInteger(declared) || declared <= 0) return bad("missing content length", 411);
	if (declared > MAX_ATTACHMENT) return bad("attachment too large", 413);

	const bytes = await request.arrayBuffer();
	if (!bytes.byteLength) return bad("empty attachment");
	// the header is a claim that must be checked
	if (bytes.byteLength > MAX_ATTACHMENT) return bad("attachment too large", 413);

	const contentType = imageType(bytes);
	if (!contentType) return bad("not an image");

	const digest = await sha256Hex(bytes);
	const nonce = Number(url.searchParams.get("nonce"));
	if (!(await verifyPow(`${challenge}:${digest}`, nonce, POW_BITS))) {
		return bad("insufficient proof of work", 429);
	}

	// Content-addressed: replaying the same bytes within the challenge window overwrites the
	// same object instead of storing another copy.
	const key = `${digest}.${EXTENSIONS[contentType]}`;
	await env.ATTACHMENTS.put(key, bytes, { httpMetadata: { contentType } });
	return json({
		url: `${url.origin}/attachments/${key}`,
		name: safeName(url.searchParams.get("name"), contentType),
	});
}

/** Serve a stored image. Keys are ours and immutable, so this is cacheable forever and needs
 *  no authentication -- the URL is the capability, and it only exists inside an issue body. */
async function handleAttachment(key: string, env: Env): Promise<Response> {
	const object = await env.ATTACHMENTS.get(key);
	if (!object) return bad("not found", 404);
	return new Response(object.body, {
		headers: {
			"Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": "public, max-age=31536000, immutable",
		},
	});
}

/** Apply our labels to an issue the app filed as the signed-in user.
 *
 *  GitHub silently drops labels from reporters without push access, so an outside contributor's
 *  report arrives bare however the app sends it. The installation token has push access, so the
 *  worker finishes the job. The marker scopes the effect (a fixed label set, only on bodies
 *  that identify as app reports) but anyone can paste a marker, so it is not authorization --
 *  the proof of work is what prices the call, since each one spends GitHub API budget. */
async function handleLabel(number: number, url: URL, env: Env): Promise<Response> {
	const challenge = url.searchParams.get("challenge") ?? "";
	if (!(await validChallenge(env.WORKER_SECRET, challenge))) {
		return bad("expired or invalid challenge", 429);
	}
	const nonce = Number(url.searchParams.get("nonce"));
	if (!(await verifyPow(`${challenge}:label:${number}`, nonce, POW_BITS))) {
		return bad("insufficient proof of work", 429);
	}
	const issue = await getIssue(env, number);
	if (issue.pull_request) return bad("not an app report", 403);
	const kind = reportKind(issue.body ?? "");
	if (!kind) return bad("not an app report", 403);
	await addLabels(env, number, ["via:app", KIND_LABELS[kind]]);
	return json({ ok: true });
}

/** What became of the report, and the replies addressed to whoever filed it. The state is what
 *  lets the app show a closed report as closed without the reporter having a GitHub account. */
async function handleReplies(number: number, token: string, env: Env): Promise<Response> {
	if (!safeEqual(token, await replyToken(env, number))) return bad("invalid token", 403);
	const [issue, comments] = await Promise.all([
		getIssue(env, number),
		relayedComments(env, number),
	]);
	return json({
		state: issue.state ?? "open",
		stateReason: issue.state_reason ?? null,
		comments,
	});
}

/** An upload happens before the issue that quotes it exists, so anything this young may simply
 *  not have been submitted yet. */
const SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;

/** Drop stored images no issue points at any more.
 *
 *  Reachability rather than an expiry rule: an attachment has to live exactly as long as the
 *  issue quoting it, and a blanket lifecycle would blank the screenshots on old reports. What
 *  actually accumulates is uploads whose report was never filed, and those are unreferenced
 *  from the moment they land. */
async function sweepAttachments(env: Env): Promise<void> {
	const referenced = await referencedAttachments(env);
	const cutoff = Date.now() - SWEEP_GRACE_MS;
	let cursor: string | undefined;
	do {
		const page = await env.ATTACHMENTS.list({ cursor });
		const stale = page.objects
			.filter((o) => !referenced.has(o.key) && o.uploaded.getTime() < cutoff)
			.map((o) => o.key);
		if (stale.length) await env.ATTACHMENTS.delete(stale);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (!(request.method === "GET" && url.pathname.startsWith("/attachments/"))) {
			const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
			const { success } = await env.RATE.limit({ key: ip });
			if (!success) return bad("rate limited", 429);
        }

		if (request.method === "GET" && url.pathname === "/challenge") {
			return json({ challenge: await mintChallenge(env.WORKER_SECRET) });
		}

		if (request.method === "POST" && url.pathname === "/reports") {
			return handleSubmit(request, env).catch((e) => bad(String(e), 502));
		}

		if (request.method === "POST" && url.pathname === "/uploads") {
			return handleUpload(request, env).catch((e) => bad(String(e), 502));
		}

		const attachment = url.pathname.match(/^\/attachments\/([\w-]+\.\w+)$/);
		if (request.method === "GET" && attachment) {
			return handleAttachment(attachment[1], env).catch((e) => bad(String(e), 502));
		}

		const label = url.pathname.match(/^\/reports\/(\d+)\/label$/);
		if (request.method === "POST" && label) {
			return handleLabel(Number(label[1]), url, env).catch((e) => bad(String(e), 502));
		}

		const replies = url.pathname.match(/^\/reports\/(\d+)$/);
		if (request.method === "GET" && replies) {
			// A header rather than a query parameter: URLs end up in request logs, and the
			// token is a bearer credential for this issue's thread.
			const auth = request.headers.get("Authorization") ?? "";
			const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
			if (!token) return bad("missing token", 403);
			return handleReplies(Number(replies[1]), token, env).catch((e) => bad(String(e), 502));
		}

		return bad("not found", 404);
	},
	async scheduled(_event: ScheduledController, env: Env): Promise<void> {
		await sweepAttachments(env);
	},
};
