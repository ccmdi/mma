import { DurableObject } from "cloudflare:workers";

/** A shared map as the directory keeps it: its name, who it is shared with, and when it last
 *  changed. */
export interface ShareRecord {
	name: string;
	logins: string[];
	updatedAt: string;
}

/** A map by its host and id. */
interface Hosted {
	host: string;
	map: string;
}

/** The key prefix of every map `host` shares, and of every map shared with `login`. */
const shares = (host: string) => `share:${host}:`;
const inbox = (login: string) => `inbox:${login}:`;

/** Every shared map, and the maps shared with each login, changed one whole share at a time. */
export class Directory extends DurableObject<unknown> {
	/** The share of `host`'s map `map`, if it is shared. */
	share(host: string, map: string): ShareRecord | undefined {
		return this.ctx.storage.kv.get<ShareRecord>(shares(host) + map);
	}

	/** Share `host`'s map `map` as `share`, replacing its previous share, or unshare it. */
	save(host: string, map: string, share: { name: string; logins: string[] } | null): void {
		const kv = this.ctx.storage.kv;
		for (const login of this.share(host, map)?.logins ?? []) {
			kv.delete(`${inbox(login)}${host}:${map}`);
		}
		if (!share) {
			kv.delete(shares(host) + map);
			return;
		}
		kv.put(shares(host) + map, { ...share, updatedAt: new Date().toISOString() });
		for (const login of share.logins) kv.put(`${inbox(login)}${host}:${map}`, { host, map });
	}

	/** The maps `login` shares, and the maps shared with it. */
	listed(login: string): { mine: (Hosted & ShareRecord)[]; withMe: (Hosted & ShareRecord)[] } {
		const kv = this.ctx.storage.kv;
		const mine = [...kv.list<ShareRecord>({ prefix: shares(login) })].map(([key, record]) => ({
			host: login,
			map: key.slice(shares(login).length),
			...record,
		}));
		const withMe = [...kv.list<Hosted>({ prefix: inbox(login) })].flatMap(([, { host, map }]) => {
			const record = this.share(host, map);
			return record ? [{ host, map, ...record }] : [];
		});
		return { mine, withMe };
	}
}
