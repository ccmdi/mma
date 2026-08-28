// Minimal ambient stand-ins for the Cloudflare Workers globals `workers/feedback/src/index.ts`
// declares on its `Env`. feedback.test.ts imports that file directly to test its pure helpers
// against the real implementation. The real types come from workers/feedback's own
// `@cloudflare/workers-types` devDependency; pulling that package into this program would
// redefine DOM globals (Response, fetch, ...) and break everything else that assumes lib.dom.

type R2Bucket = {
	put(key: string, value: unknown, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
	get(key: string): Promise<{
		body: BodyInit;
		httpMetadata?: { contentType?: string };
	} | null>;
	list(opts?: { cursor?: string }): Promise<{
		objects: { key: string; uploaded: Date }[];
		truncated: boolean;
		cursor?: string;
	}>;
	delete(keys: string | string[]): Promise<void>;
};

type RateLimit = {
	limit(opts: { key: string }): Promise<{ success: boolean }>;
};

type ScheduledController = unknown;
