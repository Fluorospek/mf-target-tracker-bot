import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("mf-alert-bot worker", () => {
	beforeAll(async () => {
		await env.DB.prepare(
			`CREATE TABLE IF NOT EXISTS users (
				chat_id INTEGER PRIMARY KEY,
				state TEXT DEFAULT 'IDLE',
				temp_scheme_code INTEGER,
				temp_scheme_name TEXT,
				temp_base_nav REAL
			)`
		).run();

		await env.DB.prepare(
			`CREATE TABLE IF NOT EXISTS tracked_funds (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				chat_id INTEGER NOT NULL,
				scheme_code INTEGER NOT NULL,
				scheme_name TEXT NOT NULL,
				baseline_nav REAL NOT NULL,
				target_pct REAL NOT NULL,
				target_nav REAL NOT NULL,
				last_nav REAL,
				is_triggered INTEGER DEFAULT 0,
				created_at DATETIME DEFAULT CURRENT_TIMESTAMP
			)`
		).run();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns OK on GET requests", async () => {
		const request = new IncomingRequest("https://example.com/", { method: "GET" });
		const response = await worker.fetch(request, { ...env, BOT_TOKEN: "test-token" });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("OK");
	});

	it("handles /start webhook, stores user in D1, and sends welcome message", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ ok: true }), { status: 200 })
		);

		const request = new IncomingRequest("https://example.com/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				update_id: 1,
				message: {
					message_id: 10,
					chat: { id: 123456, type: "private" },
					text: "/start",
				},
			}),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { ...env, BOT_TOKEN: "test-token" });
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0];
		expect(url).toBe("https://api.telegram.org/bottest-token/sendMessage");
		const sentBody = JSON.parse(String(init?.body));
		expect(sentBody.chat_id).toBe(123456);
		expect(sentBody.text).toContain("Welcome to Mutual Fund Target Tracker");

		const user = await env.DB.prepare("SELECT * FROM users WHERE chat_id = ?").bind(123456).first();
		expect(user).toMatchObject({ chat_id: 123456, state: "IDLE" });
	});

	it("handles /start@botname and /help commands", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ ok: true }), { status: 200 })
		);

		const startReq = new IncomingRequest("https://example.com/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				update_id: 2,
				message: { chat: { id: 777 }, text: "/start@mftargetbot" },
			}),
		});
		const startRes = await worker.fetch(startReq, { ...env, BOT_TOKEN: "test-token" });
		expect(startRes.status).toBe(200);

		const helpReq = new IncomingRequest("https://example.com/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				update_id: 3,
				message: { chat: { id: 777 }, text: "/help" },
			}),
		});
		const helpRes = await worker.fetch(helpReq, { ...env, BOT_TOKEN: "test-token" });
		expect(helpRes.status).toBe(200);

		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const helpBody = JSON.parse(String(fetchSpy.mock.calls[1][1]?.body));
		expect(helpBody.text).toContain("How to use Mutual Fund Target Tracker");
	});

	it("supports full /add -> fund selection -> NAV -> target % -> /list flow with HTML escaping", async () => {
		const chatId = 55501;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes("api.mfapi.in/mf/search")) {
				return new Response(
					JSON.stringify([{ schemeCode: 122639, schemeName: "Parag Parikh <Flexi> & Cap_Direct" }]),
					{ status: 200 }
				);
			}
			if (url.includes("api.mfapi.in/mf/122639/latest")) {
				return new Response(
					JSON.stringify({
						meta: { scheme_name: "Parag Parikh <Flexi> & Cap_Direct" },
						data: [{ nav: "80.00" }],
					}),
					{ status: 200 }
				);
			}
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		});

		const postUpdate = (body: unknown) =>
			worker.fetch(
				new IncomingRequest("https://example.com/", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}),
				{ ...env, BOT_TOKEN: "test-token" }
			);

		expect((await postUpdate({ message: { chat: { id: chatId }, text: "/add" } })).status).toBe(200);
		expect((await postUpdate({ message: { chat: { id: chatId }, text: "Parag" } })).status).toBe(200);
		expect(
			(
				await postUpdate({
					callback_query: { id: "cb1", message: { chat: { id: chatId } }, data: "SELECT_FUND:122639" },
				})
			).status
		).toBe(200);
		expect((await postUpdate({ message: { chat: { id: chatId }, text: "current" } })).status).toBe(200);
		expect((await postUpdate({ message: { chat: { id: chatId }, text: "10" } })).status).toBe(200);
		expect((await postUpdate({ message: { chat: { id: chatId }, text: "/list" } })).status).toBe(200);

		const lastTelegramCall = fetchSpy.mock.calls.at(-1);
		const listPayload = JSON.parse(String(lastTelegramCall?.[1]?.body));
		expect(listPayload.parse_mode).toBe("HTML");
		expect(listPayload.text).toContain("Parag Parikh &lt;Flexi&gt; &amp; Cap_Direct");
		expect(listPayload.text).toContain("₹88.00");
	});

	it("evaluates targets in scheduled handler and marks triggered funds", async () => {
		await env.DB.prepare(
			`INSERT INTO tracked_funds (chat_id, scheme_code, scheme_name, baseline_nav, target_pct, target_nav, last_nav)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
			.bind(88801, 120503, "Axis Growth & Direct", 100, 10, 110, 100)
			.run();

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes("api.mfapi.in/mf/120503/latest")) {
				return new Response(JSON.stringify({ data: [{ nav: "112.50" }] }), { status: 200 });
			}
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		});

		const ctx = createExecutionContext();
		await worker.scheduled({} as ScheduledController, { ...env, BOT_TOKEN: "test-token" }, ctx);
		await waitOnExecutionContext(ctx);

		const alertCall = fetchSpy.mock.calls.find(([url]) => String(url).includes("sendMessage"));
		expect(alertCall).toBeDefined();
		const alertBody = JSON.parse(String(alertCall?.[1]?.body));
		expect(alertBody.chat_id).toBe(88801);
		expect(alertBody.text).toContain("Target Achieved!");

		const row: any = await env.DB.prepare("SELECT * FROM tracked_funds WHERE chat_id = ?")
			.bind(88801)
			.first();
		expect(row.is_triggered).toBe(1);
		expect(row.last_nav).toBe(112.5);
	});

	it("returns 500 when BOT_TOKEN is missing or Telegram rejects sendMessage", async () => {
		const missingTokenReq = new IncomingRequest("https://example.com/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: { chat: { id: 123456 }, text: "/start" } }),
		});
		const missingRes = await worker.fetch(missingTokenReq, { ...env, BOT_TOKEN: "" });
		expect(missingRes.status).toBe(500);
		expect(await missingRes.text()).toContain("BOT_TOKEN secret is not configured");

		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }), {
				status: 401,
			})
		);

		const badTokenReq = new IncomingRequest("https://example.com/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: { chat: { id: 123456 }, text: "/start" } }),
		});
		const res = await worker.fetch(badTokenReq, { ...env, BOT_TOKEN: "bad-token" });
		expect(res.status).toBe(500);
		expect(await res.text()).toContain("Telegram API sendMessage failed (401)");
	});

	it("displays full fund names in a numbered list with numbered inline buttons", async () => {
		const chatId = 99901;
		const longDirectName = "Parag Parikh Flexi Cap Fund - Direct Plan - Growth Option <Special & New>";
		const longRegularName = "Parag Parikh Flexi Cap Fund - Regular Plan - IDCW Payout Option";

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes("api.mfapi.in/mf/search")) {
				return new Response(
					JSON.stringify([
						{ schemeCode: 122639, schemeName: longDirectName },
						{ schemeCode: 122640, schemeName: longRegularName },
					]),
					{ status: 200 }
				);
			}
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		});

		const postUpdate = (body: unknown) =>
			worker.fetch(
				new IncomingRequest("https://example.com/", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}),
				{ ...env, BOT_TOKEN: "test-token" }
			);

		expect((await postUpdate({ message: { chat: { id: chatId }, text: "/add" } })).status).toBe(200);
		expect((await postUpdate({ message: { chat: { id: chatId }, text: "Parag" } })).status).toBe(200);

		const searchSendCall = fetchSpy.mock.calls.find(
			([url, init]) =>
				String(url).includes("sendMessage") &&
				String(init?.body).includes("Tap a number below to track:")
		);
		expect(searchSendCall).toBeDefined();

		const payload = JSON.parse(String(searchSendCall?.[1]?.body));
		expect(payload.parse_mode).toBe("HTML");
		expect(payload.text).toContain(
			"<b>1.</b> Parag Parikh Flexi Cap Fund - Direct Plan - Growth Option &lt;Special &amp; New&gt;"
		);
		expect(payload.text).toContain(`<b>2.</b> ${longRegularName}`);
		expect(payload.text).not.toContain("...");
		expect(payload.reply_markup).toEqual({
			inline_keyboard: [
				[
					{ text: "1", callback_data: "SELECT_FUND:122639" },
					{ text: "2", callback_data: "SELECT_FUND:122640" },
				],
			],
		});
	});
});
