/** Minting a GitHub App installation token and the API calls the worker makes with it.
 *
 *  An App installation token rather than a personal access token: it is scoped to the one
 *  repository the App is installed on, expires on its own, and never has to be rotated by
 *  hand. The cost is the JWT dance below. */

import { Base64url } from "../../shared/base64url";
import type { Env } from "./index";

const API = "https://api.github.com";
const UA = "mma-feedback-worker";

/** PEM (PKCS#8) to the raw DER the WebCrypto importer wants. GitHub hands out PKCS#1 by
 *  default -- convert it with `openssl pkcs8 -topk8 -nocrypt` before storing the secret. */
function pemToDer(pem: string): ArrayBuffer {
	const body = pem
		.replace(/-----BEGIN [^-]+-----/, "")
		.replace(/-----END [^-]+-----/, "")
		.replace(/\s+/g, "");
	const raw = atob(body);
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
	return out.buffer;
}

async function appJwt(env: Env): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const header = Base64url.encode(
		new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
	);
	// 60s back-dated for clock skew, which GitHub explicitly recommends.
	const payload = Base64url.encode(
		new TextEncoder().encode(
			JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID }),
		),
	);
	const key = await crypto.subtle.importKey(
		"pkcs8",
		pemToDer(env.GITHUB_APP_KEY),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(`${header}.${payload}`),
	);
	return `${header}.${payload}.${Base64url.encode(signature)}`;
}

let cached: { token: string; expiresAt: number } | null = null;

/** Installation token, cached in isolate memory until shortly before it expires. */
export async function installationToken(env: Env): Promise<string> {
	if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

	const jwt = await appJwt(env);
	const headers = {
		Authorization: `Bearer ${jwt}`,
		Accept: "application/vnd.github+json",
		"User-Agent": UA,
	};
	const install = await fetch(`${API}/repos/${env.GITHUB_REPO}/installation`, {
		headers,
	});
	if (!install.ok) throw new Error(`installation lookup failed (${install.status})`);
	const { id } = (await install.json()) as { id: number };

	const minted = await fetch(`${API}/app/installations/${id}/access_tokens`, {
		method: "POST",
		headers,
	});
	if (!minted.ok) throw new Error(`token mint failed (${minted.status})`);
	const body = (await minted.json()) as { token: string; expires_at: string };
	cached = { token: body.token, expiresAt: Date.parse(body.expires_at) };
	return body.token;
}

async function apiFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
	const token = await installationToken(env);
	return fetch(`${API}/repos/${env.GITHUB_REPO}${path}`, {
		...init,
		headers: {
			...init?.headers,
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"User-Agent": UA,
		},
	});
}

export async function createIssue(
	env: Env,
	title: string,
	body: string,
	labels: string[],
): Promise<{ number: number; url: string }> {
	const resp = await apiFetch(env, "/issues", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title, body, labels }),
	});
	if (!resp.ok) throw new Error(`issue create failed (${resp.status})`);
	const issue = (await resp.json()) as { number: number; html_url: string };
	return { number: issue.number, url: issue.html_url };
}

export interface Issue {
	user?: { login?: string };
	body?: string;
	state?: string;
	state_reason?: string | null;
	locked?: boolean;
	/** Present when the "issue" is actually a pull request -- the issues API serves both. */
	pull_request?: unknown;
}

export async function getIssue(env: Env, number: number): Promise<Issue> {
	const resp = await apiFetch(env, `/issues/${number}`);
	if (!resp.ok) throw new Error(`issue read failed (${resp.status})`);
	return (await resp.json()) as Issue;
}

/** Adds to whatever is already on the issue; it never removes or replaces. */
export async function addLabels(env: Env, number: number, labels: string[]): Promise<void> {
	const resp = await apiFetch(env, `/issues/${number}/labels`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ labels }),
	});
	if (!resp.ok) throw new Error(`label failed (${resp.status})`);
}

/** Every attachment key some issue body still points at.
 *
 *  Paginates to completion and throws on the first bad page: a partial answer would read as
 *  "nothing references these" and take live screenshots with it. */
export async function referencedAttachments(env: Env): Promise<Set<string>> {
	const keys = new Set<string>();
	for (let page = 1; ; page++) {
		const resp = await apiFetch(env, `/issues?state=all&per_page=100&page=${page}`);
		if (!resp.ok) throw new Error(`issue list failed (${resp.status})`);
		const issues = (await resp.json()) as Array<{ body?: string }>;
		for (const issue of issues) {
			for (const m of (issue.body ?? "").matchAll(/\/attachments\/([\w-]+\.\w+)/g)) keys.add(m[1]);
		}
		if (issues.length < 100) return keys;
	}
}

export interface Comment {
	user?: { login?: string; avatar_url?: string };
	body?: string;
	created_at?: string;
}

export async function listComments(env: Env, number: number): Promise<Comment[]> {
	const resp = await apiFetch(env, `/issues/${number}/comments?per_page=100`);
	if (!resp.ok) throw new Error(`comment read failed (${resp.status})`);
	return (await resp.json()) as Comment[];
}

export async function createComment(env: Env, number: number, body: string): Promise<Comment> {
	const resp = await apiFetch(env, `/issues/${number}/comments`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ body }),
	});
	if (!resp.ok) throw new Error(`comment failed (${resp.status})`);
	return (await resp.json()) as Comment;
}
