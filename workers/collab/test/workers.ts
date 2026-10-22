/** The `cloudflare:workers` base class a Durable Object extends, outside the Workers runtime. */
export class DurableObject<Env = unknown> {
	constructor(
		protected ctx: DurableObjectState,
		protected env: Env,
	) {}
}
