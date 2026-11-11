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
				is_deleted INTEGER DEFAULT 0,
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
		expect(helpBody.text).toContain("tap <b>Current</b>");
		expect(helpBody.text).not.toContain("reply <code>current</code>");
	});

	it("supports full /add -> fund selection -> Current button -> target % -> /list flow with HTML escaping", async () => {
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

		const navPromptCall = fetchSpy.mock.calls.find(
			([url, init]) =>
				String(url).includes("sendMessage") && String(init?.body).includes("Enter your purchase NAV")
		);
		expect(navPromptCall).toBeDefined();
		const navPromptPayload = JSON.parse(String(navPromptCall?.[1]?.body));
		expect(navPromptPayload.text).toContain("tap <b>Current</b>");
		expect(navPromptPayload.text).not.toContain("reply <b>current</b>");
		expect(navPromptPayload.reply_markup).toEqual({
			inline_keyboard: [[{ text: "Current", callback_data: "SET_CURRENT_NAV:122639" }]],
		});

		expect(
			(
				await postUpdate({
					callback_query: {
						id: "cb2",
						message: { message_id: 501, chat: { id: chatId } },
						data: "SET_CURRENT_NAV:122639",
					},
				})
			).status
		).toBe(200);

		const editCall = fetchSpy.mock.calls.find(([url]) => String(url).includes("editMessageText"));
		expect(editCall).toBeDefined();
		const editPayload = JSON.parse(String(editCall?.[1]?.body));
		expect(editPayload.message_id).toBe(501);
		expect(editPayload.text).toContain("Base NAV set to ₹80.00.");
		expect(editPayload.reply_markup).toEqual({ inline_keyboard: [] });

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

	it("fetches distinct active schemes and bulk-updates last_nav and is_triggered across multiple rows", async () => {
		await env.DB.prepare("DELETE FROM tracked_funds").run();

		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO tracked_funds (chat_id, scheme_code, scheme_name, baseline_nav, target_pct, target_nav, last_nav, is_triggered)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			).bind(1001, 111001, "Fund A", 100, 10, 110, 100, 0),
			env.DB.prepare(
				`INSERT INTO tracked_funds (chat_id, scheme_code, scheme_name, baseline_nav, target_pct, target_nav, last_nav, is_triggered)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			).bind(1002, 111001, "Fund A", 100, 20, 120, 100, 0),
			env.DB.prepare(
				`INSERT INTO tracked_funds (chat_id, scheme_code, scheme_name, baseline_nav, target_pct, target_nav, last_nav, is_triggered)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			).bind(1003, 111001, "Fund A", 100, 5, 105, 106, 1), // Already triggered
			env.DB.prepare(
				`INSERT INTO tracked_funds (chat_id, scheme_code, scheme_name, baseline_nav, target_pct, target_nav, last_nav, is_triggered)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			).bind(1004, 111002, "Fund B", 50, 10, 55, 50, 0),
			env.DB.prepare(
				`INSERT INTO tracked_funds (chat_id, scheme_code, scheme_name, baseline_nav, target_pct, target_nav, last_nav, is_triggered)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			).bind(1005, 111003, "Fund C (Already Triggered Only)", 200, 10, 220, 221, 1),
		]);

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes("api.mfapi.in/mf/111001/latest")) {
				return new Response(JSON.stringify({ data: [{ nav: "115.00" }] }), { status: 200 });
			}
			if (url.includes("api.mfapi.in/mf/111002/latest")) {
				return new Response(JSON.stringify({ data: [{ nav: "52.50" }] }), { status: 200 });
			}
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		});

		const batchSpy = vi.spyOn(env.DB, "batch");

		const ctx = createExecutionContext();
		await worker.scheduled({} as ScheduledController, { ...env, BOT_TOKEN: "test-token" }, ctx);
		await waitOnExecutionContext(ctx);

		// Should only fetch 111001 and 111002 once each (111003 has no active rows)
		const navCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes("api.mfapi.in/mf/"));
		expect(navCalls).toHaveLength(2);
		expect(navCalls.map(([url]) => String(url)).sort()).toEqual([
			"https://api.mfapi.in/mf/111001/latest",
			"https://api.mfapi.in/mf/111002/latest",
		]);

		// Only chat 1001 achieved its target
		const messageCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes("sendMessage"));
		expect(messageCalls).toHaveLength(1);
		expect(JSON.parse(String(messageCalls[0][1]?.body)).chat_id).toBe(1001);

		// Bulk batch calls: 1 to select triggered rows + 1 to bulk update last_nav & is_triggered
		expect(batchSpy).toHaveBeenCalledTimes(2);

		const { results: rows } = await env.DB.prepare(
			"SELECT chat_id, last_nav, is_triggered FROM tracked_funds ORDER BY chat_id"
		).all<{ chat_id: number; last_nav: number; is_triggered: number }>();

		expect(rows).toEqual([
			{ chat_id: 1001, last_nav: 115, is_triggered: 1 },
			{ chat_id: 1002, last_nav: 115, is_triggered: 0 },
			{ chat_id: 1003, last_nav: 106, is_triggered: 1 },
			{ chat_id: 1004, last_nav: 52.5, is_triggered: 0 },
			{ chat_id: 1005, last_nav: 221, is_triggered: 1 },
		]);
	});

	it("only marks is_triggered = 1 for rows whose Telegram notification succeeded", async () => {
		await env.DB.prepare("DELETE FROM tracked_funds").run();

		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO tracked_funds (chat_id, scheme_code, scheme_name, baseline_nav, target_pct, target_nav, last_nav)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			).bind(2001, 222001, "Fund Retry", 100, 5, 105, 100),
			env.DB.prepare(
				`INSERT INTO tracked_funds (chat_id, scheme_code, scheme_name, baseline_nav, target_pct, target_nav, last_nav)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			).bind(2002, 222001, "Fund Retry", 100, 5, 105, 100),
		]);

		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = String(input);
			if (url.includes("api.mfapi.in/mf/222001/latest")) {
				return new Response(JSON.stringify({ data: [{ nav: "110.00" }] }), { status: 200 });
			}
			if (url.includes("sendMessage")) {
				const body = JSON.parse(String(init?.body));
				if (body.chat_id === 2001) {
					return new Response("Forbidden", { status: 403 });
				}
			}
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		});

		const ctx = createExecutionContext();
		await worker.scheduled({} as ScheduledController, { ...env, BOT_TOKEN: "test-token" }, ctx);
		await waitOnExecutionContext(ctx);

		const { results: rows } = await env.DB.prepare(
			"SELECT chat_id, last_nav, is_triggered FROM tracked_funds ORDER BY chat_id"
		).all<{ chat_id: number; last_nav: number; is_triggered: number }>();

		expect(rows).toEqual([
			{ chat_id: 2001, last_nav: 110, is_triggered: 0 },
			{ chat_id: 2002, last_nav: 110, is_triggered: 1 },
		]);
	});

	it("chunks bulk is_triggered updates across more than 100 notified rows", async () => {
		await env.DB.prepare("DELETE FROM tracked_funds").run();

		const totalRows = 105;
		const insertStmt = env.DB.prepare(
			`INSERT INTO tracked_funds (chat_id, scheme_code, scheme_name, baseline_nav, target_pct, target_nav, last_nav)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		);
		await env.DB.batch(
			Array.from({ length: totalRows }, (_, i) => insertStmt.bind(3000 + i, 333001, "Bulk Fund", 100, 10, 110, 100))
		);

		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes("api.mfapi.in/mf/333001/latest")) {
				return new Response(JSON.stringify({ data: [{ nav: "115.00" }] }), { status: 200 });
			}
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		});

		const batchSpy = vi.spyOn(env.DB, "batch");

		const ctx = createExecutionContext();
		await worker.scheduled({} as ScheduledController, { ...env, BOT_TOKEN: "test-token" }, ctx);
		await waitOnExecutionContext(ctx);

		expect(batchSpy).toHaveBeenCalledTimes(2);
		// Second batch: 1 statement for last_nav + 2 chunked statements for 105 notified IDs (100 + 5)
		expect(batchSpy.mock.calls[1][0]).toHaveLength(3);

		const summary = await env.DB.prepare(
			"SELECT COUNT(*) as total, SUM(is_triggered) as triggered_count, MIN(last_nav) as min_nav, MAX(last_nav) as max_nav FROM tracked_funds"
		).first<{ total: number; triggered_count: number; min_nav: number; max_nav: number }>();

		expect(summary).toEqual({
			total: 105,
			triggered_count: 105,
			min_nav: 115,
			max_nav: 115,
		});
	});

	it("returns early when there are no active tracked_funds or all NAV fetches fail", async () => {
		await env.DB.prepare("DELETE FROM tracked_funds").run();

		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const batchSpy = vi.spyOn(env.DB, "batch");

		const ctx1 = createExecutionContext();
		await worker.scheduled({} as ScheduledController, { ...env, BOT_TOKEN: "test-token" }, ctx1);
		await waitOnExecutionContext(ctx1);

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(batchSpy).not.toHaveBeenCalled();

		await env.DB.prepare(
			`INSERT INTO tracked_funds (chat_id, scheme_code, scheme_name, baseline_nav, target_pct, target_nav, last_nav)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
			.bind(4001, 444001, "Broken Fund", 100, 10, 110, 100)
			.run();

		fetchSpy.mockRejectedValue(new Error("Network error"));

		const ctx2 = createExecutionContext();
		await worker.scheduled({} as ScheduledController, { ...env, BOT_TOKEN: "test-token" }, ctx2);
		await waitOnExecutionContext(ctx2);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(batchSpy).not.toHaveBeenCalled();
	});

	it("handles /delete with no active targets (ignoring triggered and already deleted rows)", async () => {
		await env.DB.prepare("DELETE FROM tracked_funds").run();
		const chatId = 61001;

		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO tracked_funds (chat_id, scheme_code, scheme_name, baseline_nav, target_pct, target_nav, last_nav, is_triggered, is_deleted)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			).bind(chatId, 500001, "Triggered Fund", 100, 10, 110, 112, 1, 0),
			env.DB.prepare(
				`INSERT INTO tracked_funds (chat_id, scheme_code, scheme_name, baseline_nav, target_pct, target_nav, last_nav, is_triggered, is_deleted)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
			).bind(chatId, 500002, "Deleted Fund", 100, 10, 110, 100, 0, 1),
		]);

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ ok: true }), { status: 200 })
		);

		const res = await worker.fetch(
			new IncomingRequest("https://example.com/", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ message: { chat: { id: chatId }, text: "/delete" } }),
			}),
			{ ...env, BOT_TOKEN: "test-token" }
		);
		expect(res.status).toBe(200);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const payload = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
		expect(payload.text).toContain("No active targets to delete");

		const userAfterEmptyDelete = await env.DB.prepare("SELECT state FROM users WHERE chat_id = ?")
			.bind(chatId)
			.first<{ state: string }>();
		expect(userAfterEmptyDelete?.state).toBe("IDLE");
	});

	it("paginates /delete in pages of 5, soft-deletes selected trigger, and excludes it from /list and cron", async () => {
		await env.DB.prepare("DELETE FROM tracked_funds").run();
		const chatId = 62001;
		const otherChatId = 62002;

		// Put user mid-/add flow to verify /delete switches state to AWAITING_DELETE
		await env.DB.prepare(
			"INSERT INTO users (chat_id, state) VALUES (?, 'AWAITING_QUERY') ON CONFLICT(chat_id) DO UPDATE SET state = 'AWAITING_QUERY'"
		)
			.bind(chatId)
			.run();

		// Insert 7 active triggers for chatId, plus 1 for another user
		const insertStmt = env.DB.prepare(
			`INSERT INTO tracked_funds (chat_id, scheme_code, scheme_name, baseline_nav, target_pct, target_nav, last_nav)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		);
		await env.DB.batch([
			...Array.from({ length: 7 }, (_, i) =>
				insertStmt.bind(chatId, 600000 + i, `Fund <${i + 1}> & Co`, 100 + i, 10, 110 + i * 1.1, 100 + i)
			),
			insertStmt.bind(otherChatId, 600999, "Other User Fund", 100, 10, 110, 100),
		]);

		const { results: insertedRows } = await env.DB.prepare(
			"SELECT id, scheme_code FROM tracked_funds WHERE chat_id = ? ORDER BY id ASC"
		)
			.bind(chatId)
			.all<{ id: number; scheme_code: number }>();
		const otherRow = await env.DB.prepare("SELECT id FROM tracked_funds WHERE chat_id = ?")
			.bind(otherChatId)
			.first<{ id: number }>();

		expect(insertedRows).toHaveLength(7);
		expect(otherRow).not.toBeNull();

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ ok: true }), { status: 200 })
		);

		const postUpdate = (body: unknown) =>
			worker.fetch(
				new IncomingRequest("https://example.com/", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}),
				{ ...env, BOT_TOKEN: "test-token" }
			);

		// 1. /delete shows Page 1 of 2 (items 1..5) and Next button
		expect((await postUpdate({ message: { chat: { id: chatId }, text: "/delete" } })).status).toBe(200);
		const userAfterDeleteCmd = await env.DB.prepare("SELECT state FROM users WHERE chat_id = ?")
			.bind(chatId)
			.first<{ state: string }>();
		expect(userAfterDeleteCmd?.state).toBe("AWAITING_DELETE");

		const page1Payload = JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body));
		expect(page1Payload.parse_mode).toBe("HTML");
		expect(page1Payload.text).toContain("Page 1 of 2");
		expect(page1Payload.text).toContain("<b>1.</b> <b>Fund &lt;1&gt; &amp; Co</b>");
		expect(page1Payload.text).toContain("<b>5.</b> <b>Fund &lt;5&gt; &amp; Co</b>");
		expect(page1Payload.text).not.toContain("Fund &lt;6&gt;");
		expect(page1Payload.reply_markup).toEqual({
			inline_keyboard: [
				[
					{ text: "1", callback_data: `DELETE_FUND:${insertedRows[0].id}` },
					{ text: "2", callback_data: `DELETE_FUND:${insertedRows[1].id}` },
					{ text: "3", callback_data: `DELETE_FUND:${insertedRows[2].id}` },
					{ text: "4", callback_data: `DELETE_FUND:${insertedRows[3].id}` },
					{ text: "5", callback_data: `DELETE_FUND:${insertedRows[4].id}` },
				],
				[{ text: "Next ➡️", callback_data: "DELETE_PAGE:1" }],
			],
		});

		// 2. Navigate to Page 2 via callback_query -> uses editMessageText with items 6..7 and Prev button
		expect(
			(
				await postUpdate({
					callback_query: {
						id: "cb_page_1",
						message: { message_id: 9001, chat: { id: chatId } },
						data: "DELETE_PAGE:1",
					},
				})
			).status
		).toBe(200);

		const editPage2Call = fetchSpy.mock.calls.find(([url]) => String(url).includes("editMessageText"));
		expect(editPage2Call).toBeDefined();
		const page2Payload = JSON.parse(String(editPage2Call?.[1]?.body));
		expect(page2Payload.message_id).toBe(9001);
		expect(page2Payload.text).toContain("Page 2 of 2");
		expect(page2Payload.text).toContain("<b>1.</b> <b>Fund &lt;6&gt; &amp; Co</b>");
		expect(page2Payload.text).toContain("<b>2.</b> <b>Fund &lt;7&gt; &amp; Co</b>");
		expect(page2Payload.reply_markup).toEqual({
			inline_keyboard: [
				[
					{ text: "1", callback_data: `DELETE_FUND:${insertedRows[5].id}` },
					{ text: "2", callback_data: `DELETE_FUND:${insertedRows[6].id}` },
				],
				[{ text: "⬅️ Prev", callback_data: "DELETE_PAGE:0" }],
			],
		});

		// 3. Cannot delete another user's trigger
		expect(
			(
				await postUpdate({
					callback_query: {
						id: "cb_other",
						message: { message_id: 9001, chat: { id: chatId } },
						data: `DELETE_FUND:${otherRow!.id}`,
					},
				})
			).status
		).toBe(200);
		const otherRowAfter = await env.DB.prepare("SELECT is_deleted FROM tracked_funds WHERE id = ?")
			.bind(otherRow!.id)
			.first<{ is_deleted: number }>();
		expect(otherRowAfter?.is_deleted).toBe(0);

		// 4. Select item 1 on Page 2 (6th fund) to soft-delete it
		expect(
			(
				await postUpdate({
					callback_query: {
						id: "cb_del_6",
						message: { message_id: 9001, chat: { id: chatId } },
						data: `DELETE_FUND:${insertedRows[5].id}`,
					},
				})
			).status
		).toBe(200);

		const deletedPayload = JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body));
		expect(deletedPayload.text).toContain("Target Deleted!");
		expect(deletedPayload.text).toContain("Fund &lt;6&gt; &amp; Co");
		expect(deletedPayload.reply_markup).toEqual({ inline_keyboard: [] });

		// Row still exists in DB with is_deleted = 1 (soft delete)
		const deletedRow = await env.DB.prepare("SELECT is_deleted, is_triggered FROM tracked_funds WHERE id = ?")
			.bind(insertedRows[5].id)
			.first<{ is_deleted: number; is_triggered: number }>();
		expect(deletedRow).toEqual({ is_deleted: 1, is_triggered: 0 });

		// 5. Re-clicking the same delete button reports already deleted cleanly
		expect(
			(
				await postUpdate({
					callback_query: {
						id: "cb_del_6_again",
						message: { message_id: 9001, chat: { id: chatId } },
						data: `DELETE_FUND:${insertedRows[5].id}`,
					},
				})
			).status
		).toBe(200);
		const alreadyDeletedPayload = JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body));
		expect(alreadyDeletedPayload.text).toContain("already deleted");

		// 6. /list excludes soft-deleted trigger
		expect((await postUpdate({ message: { chat: { id: chatId }, text: "/list" } })).status).toBe(200);
		const listPayload = JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body));
		expect(listPayload.text).not.toContain("Fund &lt;6&gt;");
		expect(listPayload.text).toContain("Fund &lt;7&gt;");
	});

	it("scheduled cron ignores soft-deleted targets for NAV lookup, alerts, and updates", async () => {
		await env.DB.prepare("DELETE FROM tracked_funds").run();

		await env.DB.batch([
			// Scheme 700001 has ONLY a soft-deleted row -> should NOT fetch MFapi at all
			env.DB.prepare(
				`INSERT INTO tracked_funds (chat_id, scheme_code, scheme_name, baseline_nav, target_pct, target_nav, last_nav, is_deleted)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			).bind(7001, 700001, "Only Deleted Fund", 100, 5, 105, 100, 1),
			// Scheme 700002 has one active row and one soft-deleted row -> only active row alerted & updated
			env.DB.prepare(
				`INSERT INTO tracked_funds (chat_id, scheme_code, scheme_name, baseline_nav, target_pct, target_nav, last_nav, is_deleted)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			).bind(7002, 700002, "Shared Active Fund", 100, 10, 110, 100, 0),
			env.DB.prepare(
				`INSERT INTO tracked_funds (chat_id, scheme_code, scheme_name, baseline_nav, target_pct, target_nav, last_nav, is_deleted)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
			).bind(7003, 700002, "Shared Deleted Fund", 100, 5, 105, 100, 1),
		]);

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes("api.mfapi.in/mf/700002/latest")) {
				return new Response(JSON.stringify({ data: [{ nav: "120.00" }] }), { status: 200 });
			}
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		});

		const ctx = createExecutionContext();
		await worker.scheduled({} as ScheduledController, { ...env, BOT_TOKEN: "test-token" }, ctx);
		await waitOnExecutionContext(ctx);

		const navCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes("api.mfapi.in/mf/"));
		expect(navCalls).toHaveLength(1);
		expect(String(navCalls[0][0])).toBe("https://api.mfapi.in/mf/700002/latest");

		const messageCalls = fetchSpy.mock.calls.filter(([url]) => String(url).includes("sendMessage"));
		expect(messageCalls).toHaveLength(1);
		expect(JSON.parse(String(messageCalls[0][1]?.body)).chat_id).toBe(7002);

		const { results: rows } = await env.DB.prepare(
			"SELECT chat_id, last_nav, is_triggered, is_deleted FROM tracked_funds ORDER BY chat_id"
		).all<{ chat_id: number; last_nav: number; is_triggered: number; is_deleted: number }>();

		expect(rows).toEqual([
			{ chat_id: 7001, last_nav: 100, is_triggered: 0, is_deleted: 1 },
			{ chat_id: 7002, last_nav: 120, is_triggered: 1, is_deleted: 0 },
			{ chat_id: 7003, last_nav: 100, is_triggered: 0, is_deleted: 1 },
		]);
	});

	it("includes the Current inline button on invalid base NAV input and handles custom NAV or stale Current clicks", async () => {
		const chatId = 77889;
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes("api.mfapi.in/mf/122639/latest")) {
				return new Response(
					JSON.stringify({
						meta: { scheme_name: "Fund One" },
						data: [{ nav: "100.00" }],
					}),
					{ status: 200 }
				);
			}
			if (url.includes("api.mfapi.in/mf/122640/latest")) {
				return new Response(
					JSON.stringify({
						meta: { scheme_name: "Fund Two" },
						data: [{ nav: "200.00" }],
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

		// Clicking Current before selecting any fund is safely ignored with expired message
		expect(
			(
				await postUpdate({
					callback_query: {
						id: "cb_idle",
						message: { message_id: 700, chat: { id: chatId } },
						data: "SET_CURRENT_NAV:122639",
					},
				})
			).status
		).toBe(200);
		const idleEditPayload = JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body));
		expect(idleEditPayload.text).toContain("expired");
		expect(idleEditPayload.reply_markup).toEqual({ inline_keyboard: [] });

		// Select Fund One, then switch to Fund Two -> clicking Fund One's Current button is rejected
		expect(
			(
				await postUpdate({
					callback_query: { id: "cb_f1", message: { chat: { id: chatId } }, data: "SELECT_FUND:122639" },
				})
			).status
		).toBe(200);
		expect(
			(
				await postUpdate({
					callback_query: { id: "cb_f2", message: { chat: { id: chatId } }, data: "SELECT_FUND:122640" },
				})
			).status
		).toBe(200);
		expect(
			(
				await postUpdate({
					callback_query: {
						id: "cb_stale_f1",
						message: { message_id: 701, chat: { id: chatId } },
						data: "SET_CURRENT_NAV:122639",
					},
				})
			).status
		).toBe(200);
		const mismatchPayload = JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body));
		expect(mismatchPayload.text).toContain("selected another fund");
		expect(mismatchPayload.reply_markup).toEqual({ inline_keyboard: [] });

		// Invalid NAV entry re-prompts with 'Current' inline button instead of asking to type current
		expect((await postUpdate({ message: { chat: { id: chatId }, text: "not-a-number" } })).status).toBe(200);
		const retryPayload = JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body));
		expect(retryPayload.text).toContain("Invalid number");
		expect(retryPayload.text).toContain("tap <b>Current</b>");
		expect(retryPayload.text).not.toContain("type <code>current</code>");
		expect(retryPayload.reply_markup).toEqual({
			inline_keyboard: [[{ text: "Current", callback_data: "SET_CURRENT_NAV:122640" }]],
		});

		// Enter custom NAV (150) -> state moves to AWAITING_TARGET_PCT
		expect((await postUpdate({ message: { chat: { id: chatId }, text: "150" } })).status).toBe(200);
		const customSetPayload = JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body));
		expect(customSetPayload.text).toContain("Base NAV set to ₹150.00");

		// Clicking stale Current button after custom NAV was set does NOT overwrite temp_base_nav
		expect(
			(
				await postUpdate({
					callback_query: {
						id: "cb_stale_f2",
						message: { message_id: 702, chat: { id: chatId } },
						data: "SET_CURRENT_NAV:122640",
					},
				})
			).status
		).toBe(200);
		const alreadySetPayload = JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body));
		expect(alreadySetPayload.text).toContain("already set to ₹150.00");
		expect(alreadySetPayload.reply_markup).toEqual({ inline_keyboard: [] });

		const userRow = await env.DB.prepare("SELECT state, temp_scheme_code, temp_base_nav FROM users WHERE chat_id = ?")
			.bind(chatId)
			.first<{ state: string; temp_scheme_code: number; temp_base_nav: number }>();
		expect(userRow).toEqual({ state: "AWAITING_TARGET_PCT", temp_scheme_code: 122640, temp_base_nav: 150 });
	});

	it("expires /delete inline prompts when the user moves on to another command", async () => {
		await env.DB.prepare("DELETE FROM tracked_funds").run();
		await env.DB.prepare("DELETE FROM users").run();

		const chatId = 63001;
		const insertStmt = env.DB.prepare(
			`INSERT INTO tracked_funds (chat_id, scheme_code, scheme_name, baseline_nav, target_pct, target_nav, last_nav)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		);
		await env.DB.batch(
			Array.from({ length: 6 }, (_, i) =>
				insertStmt.bind(chatId, 710000 + i, `Expire Test Fund ${i + 1}`, 100, 10, 110, 100)
			)
		);

		const { results: funds } = await env.DB.prepare(
			"SELECT id FROM tracked_funds WHERE chat_id = ? ORDER BY id ASC"
		)
			.bind(chatId)
			.all<{ id: number }>();
		expect(funds).toHaveLength(6);

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ ok: true }), { status: 200 })
		);

		const postUpdate = (body: unknown) =>
			worker.fetch(
				new IncomingRequest("https://example.com/", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}),
				{ ...env, BOT_TOKEN: "test-token" }
			);

		for (const nextCommand of ["/list", "/help", "/start", "/add", "/unknown"]) {
			expect((await postUpdate({ message: { chat: { id: chatId }, text: "/delete" } })).status).toBe(200);
			expect((await postUpdate({ message: { chat: { id: chatId }, text: nextCommand } })).status).toBe(200);

			// Trying to delete a fund via stale /delete inline button reports prompt expired and does not delete
			expect(
				(
					await postUpdate({
						callback_query: {
							id: `cb_expired_del_${nextCommand}`,
							message: { message_id: 9101, chat: { id: chatId } },
							data: `DELETE_FUND:${funds[0].id}`,
						},
					})
				).status
			).toBe(200);
			const expiredDeletePayload = JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body));
			expect(expiredDeletePayload.message_id).toBe(9101);
			expect(expiredDeletePayload.text).toContain("prompt has expired");
			expect(expiredDeletePayload.reply_markup).toEqual({ inline_keyboard: [] });

			// Trying to paginate stale /delete inline button also reports prompt expired
			expect(
				(
					await postUpdate({
						callback_query: {
							id: `cb_expired_page_${nextCommand}`,
							message: { message_id: 9102, chat: { id: chatId } },
							data: "DELETE_PAGE:1",
						},
					})
				).status
			).toBe(200);
			const expiredPagePayload = JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body));
			expect(expiredPagePayload.message_id).toBe(9102);
			expect(expiredPagePayload.text).toContain("prompt has expired");
			expect(expiredPagePayload.reply_markup).toEqual({ inline_keyboard: [] });
		}

		// Verify none of the funds were deleted across all expired attempts
		const activeCount = await env.DB.prepare(
			"SELECT COUNT(*) as total FROM tracked_funds WHERE chat_id = ? AND is_deleted = 0"
		)
			.bind(chatId)
			.first<{ total: number }>();
		expect(activeCount?.total).toBe(6);

		// Non-command plain text during AWAITING_DELETE does not expire the prompt; deleting still succeeds
		expect((await postUpdate({ message: { chat: { id: chatId }, text: "/delete" } })).status).toBe(200);
		expect((await postUpdate({ message: { chat: { id: chatId }, text: "random text" } })).status).toBe(200);
		expect(
			(
				await postUpdate({
					callback_query: {
						id: "cb_valid_del",
						message: { message_id: 9103, chat: { id: chatId } },
						data: `DELETE_FUND:${funds[0].id}`,
					},
				})
			).status
		).toBe(200);
		const validDeletePayload = JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body));
		expect(validDeletePayload.text).toContain("Target Deleted!");

		// Tapping a different active fund button after a delete already completed is rejected as expired
		expect(
			(
				await postUpdate({
					callback_query: {
						id: "cb_second_del",
						message: { message_id: 9103, chat: { id: chatId } },
						data: `DELETE_FUND:${funds[1].id}`,
					},
				})
			).status
		).toBe(200);
		const secondDeletePayload = JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body));
		expect(secondDeletePayload.text).toContain("prompt has expired");

		// Moving to /list after deletion expires stale re-clicks of the deleted button too
		expect((await postUpdate({ message: { chat: { id: chatId }, text: "/list" } })).status).toBe(200);
		expect(
			(
				await postUpdate({
					callback_query: {
						id: "cb_reclick_after_list",
						message: { message_id: 9103, chat: { id: chatId } },
						data: `DELETE_FUND:${funds[0].id}`,
					},
				})
			).status
		).toBe(200);
		const reclickAfterListPayload = JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body));
		expect(reclickAfterListPayload.text).toContain("prompt has expired");

		// Fund 0 is deleted, Fund 1 remains active
		const rowsAfter = await env.DB.prepare(
			"SELECT id, is_deleted FROM tracked_funds WHERE id IN (?, ?) ORDER BY id ASC"
		)
			.bind(funds[0].id, funds[1].id)
			.all<{ id: number; is_deleted: number }>();
		expect(rowsAfter.results).toEqual([
			{ id: funds[0].id, is_deleted: 1 },
			{ id: funds[1].id, is_deleted: 0 },
		]);
	});
});
