// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { act } from "react";
import { mountAsync } from "./fixtures/harness";
import { cmd } from "@/lib/commands";
import { open as openExternal } from "@tauri-apps/plugin-shell";

const user = { login: "octo", avatarUrl: "https://avatars.example/octo.png" };

vi.mock("@/lib/commands", () => ({
	cmd: {
		githubMe: vi.fn().mockResolvedValue(null),
		githubStartLogin: vi.fn().mockResolvedValue({
			userCode: "ABCD-1234",
			verificationUri: "https://github.com/login/device",
			expiresIn: 900,
		}),
		githubPollLogin: vi.fn(async () => user),
		githubLogout: vi.fn().mockResolvedValue(null),
	},
}));
const windows = vi.hoisted(() => ({
	broadcasts: [] as string[],
	listeners: new Map<string, (e: { payload: string }) => void>(),
}));
vi.mock("@tauri-apps/api/event", () => ({
	emit: async (event: string) => void windows.broadcasts.push(event),
	listen: async (event: string, fn: (e: { payload: string }) => void) => {
		windows.listeners.set(event, fn);
		return () => {};
	},
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "map-1" }) }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/util/log", async () => (await import("./fixtures/mocks")).logMock());

const writeText = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

const { Account } = await import("@/lib/account");

function Login({ className }: { className: string }) {
	const me = Account.use();
	return <span className={className}>{me === undefined ? "loading" : (me?.login ?? "none")}</span>;
}

const text = (cls: string) => document.querySelector(`.${cls}`)?.textContent;

describe("account", () => {
	it("checks once for every consumer, reads an unreachable check as signed out, and retries it", async () => {
		vi.mocked(cmd.githubMe).mockRejectedValueOnce(new Error("offline"));
		await mountAsync(
			<>
				<Login className="first" />
				<Login className="second" />
			</>,
		);
		expect(cmd.githubMe).toHaveBeenCalledOnce();
		expect(text("first")).toBe("none");
		expect(text("second")).toBe("none");

		await expect(Account.me()).resolves.toBeNull();
		expect(cmd.githubMe).toHaveBeenCalledTimes(2);
	});

	it("updates every consumer on sign-in and sign-out", async () => {
		vi.mocked(cmd.githubMe).mockClear();
		await mountAsync(
			<>
				<Login className="first" />
				<Login className="second" />
			</>,
		);
		expect(text("first")).toBe("none");

		const onCode = vi.fn();
		await act(() => Account.signIn(onCode));
		expect(onCode).toHaveBeenCalledWith(expect.objectContaining({ userCode: "ABCD-1234" }));
		expect(text("first")).toBe("octo");
		expect(text("second")).toBe("octo");
		await expect(Account.me()).resolves.toEqual(user);

		await act(() => Account.signOut());
		expect(cmd.githubLogout).toHaveBeenCalledOnce();
		expect(text("first")).toBe("none");
		expect(text("second")).toBe("none");
		await expect(Account.me()).resolves.toBeNull();
		expect(cmd.githubMe).not.toHaveBeenCalled();
	});

	it("checks again when another window signs in or out, settling without echoing back", async () => {
		vi.resetModules();
		const { Account: fresh } = await import("@/lib/account");
		const elsewhere = () =>
			act(async () => windows.listeners.get("xwin:account:changed")!({ payload: "main" }));
		vi.mocked(cmd.githubMe).mockResolvedValue(null);
		await expect(fresh.me()).resolves.toBeNull();

		vi.mocked(cmd.githubMe).mockResolvedValue(user);
		await elsewhere();
		await expect(fresh.me()).resolves.toEqual(user);
		const broadcasts = windows.broadcasts.length;
		await elsewhere();
		expect(windows.broadcasts).toHaveLength(broadcasts);

		vi.mocked(cmd.githubMe).mockResolvedValue(null);
		await elsewhere();
		await expect(fresh.me()).resolves.toBeNull();
	});

	it("lets a sign-in win over a check still under way", async () => {
		vi.resetModules();
		const { Account: fresh } = await import("@/lib/account");
		let answer: (found: null) => void = () => {};
		vi.mocked(cmd.githubMe).mockImplementationOnce(() => new Promise((done) => (answer = done)));
		const checked = fresh.me();
		await act(() => fresh.signIn(() => {}));
		answer(null);
		await expect(checked).resolves.toEqual(user);
		await expect(fresh.me()).resolves.toEqual(user);
	});

	it("copies the sign-in code before opening the browser, and signs in when the copy is refused", async () => {
		writeText.mockClear();
		vi.mocked(openExternal).mockClear();
		await act(() => Account.signIn(() => {}));
		expect(writeText).toHaveBeenCalledWith("ABCD-1234");
		expect(writeText.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(openExternal).mock.invocationCallOrder[0],
		);

		writeText.mockRejectedValueOnce(new Error("denied"));
		await expect(act(() => Account.signIn(() => {}))).resolves.toEqual(user);
	});
});
