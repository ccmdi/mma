import { useEffect } from "react";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import type { DeviceCodeInfo, GhUser } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { bridgeAcrossWindows, emit, useEventValue } from "@/lib/events";
import { latest } from "@/lib/util/latest";
import { errText } from "@/lib/util/format";
import { log } from "@/lib/util/log";
import { Err, Loading, Ok, type AsyncState, type Settled } from "@/types/util";

let account: AsyncState<GhUser | null> = new Loading();
let checking: Promise<Settled<GhUser | null>> | null = null;

const settle = (next: AsyncState<GhUser | null>) => {
	if (next.status === account.status && next.ok()?.login === account.ok()?.login) return;
	account = next;
	emit("account:changed");
};
const checks = latest<GhUser | null>({
	publish: (found) => settle(new Ok(found)),
	failed: (e) => {
		log.warn(`[account] sign-in check failed: ${errText(e)}`);
		settle(new Err(e));
	},
});
const know = (user: GhUser | null) => {
	checks.cancel();
	settle(new Ok(user));
};

bridgeAcrossWindows("account:changed", () => void checks.replace(() => cmd.githubMe()));

/** The GitHub account the user is signed in with, and signing in or out of it. @api */
export const Account = {
	/** The signed-in GitHub account, or null when signed out or unreachable. */
	me: async (): Promise<GhUser | null> => {
		if (account.status !== "ok")
			await (checking ??= checks.replace(() => cmd.githubMe()).finally(() => (checking = null)));
		return account.ok();
	},
	/** React hook: the signed-in GitHub account, null when signed out, and undefined until first known. */
	use: (): GhUser | null | undefined => {
		useEffect(() => void Account.me(), []);
		const current = useEventValue("account:changed", () => account);
		return current.status === "loading" ? undefined : current.ok();
	},
	/** Sign in with GitHub: `onCode` receives the code the user enters in the browser page this opens, which is also copied to the clipboard. */
	signIn: async (onCode: (code: DeviceCodeInfo) => void): Promise<GhUser> => {
		const code = await cmd.githubStartLogin();
		onCode(code);
		await navigator.clipboard
			.writeText(code.userCode)
			.catch((e: unknown) => log.warn(`[account] could not copy the sign-in code: ${errText(e)}`));
		await openExternal(code.verificationUri);
		const signedIn = await cmd.githubPollLogin();
		know(signedIn);
		return signedIn;
	},
	/** Sign out of GitHub and forget the stored session. */
	signOut: async (): Promise<void> => {
		await cmd.githubLogout();
		know(null);
	},
};
