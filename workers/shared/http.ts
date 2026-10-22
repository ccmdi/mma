/** A JSON response. */
export function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** An empty success response. */
export function empty(): Response {
	return new Response(null, { status: 204 });
}

/** A JSON error response saying `message`. */
export function bad(message: string, status = 400): Response {
	return json({ error: message }, status);
}
