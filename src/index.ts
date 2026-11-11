export interface Env {
	DB: D1Database;
	BOT_TOKEN: string;
}

interface TrackedFundRow {
	id: number;
	chat_id: number;
	scheme_code: number;
	scheme_name: string;
	baseline_nav: number;
	target_pct: number;
	target_nav: number;
}

interface InlineKeyboardButton {
	text: string;
	callback_data: string;
}

type InlineKeyboardMarkup = {
	inline_keyboard: InlineKeyboardButton[][];
};

interface UserRow {
	chat_id: number;
	state: string;
	temp_scheme_code: number | null;
	temp_scheme_name: string | null;
	temp_base_nav: number | null;
}

interface DeletePagePayload {
	text: string;
	replyMarkup: InlineKeyboardMarkup;
}

const DELETE_PAGE_SIZE = 5;
const DELETE_PROMPT_EXPIRED_TEXT = "This prompt has expired. Please use /delete to select a target to delete.";

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Builds the inline keyboard containing the 'Current' button for setting base NAV. */
function buildCurrentNavMarkup(schemeCode: string | number): InlineKeyboardMarkup {
	return {
		inline_keyboard: [[{ text: "Current", callback_data: `SET_CURRENT_NAV:${schemeCode}` }]],
	};
}

/** Formats a tracked fund row's scheme name, baseline NAV, and target details as Telegram HTML. */
function formatTargetSummary(
	row: Pick<TrackedFundRow, "scheme_name" | "baseline_nav" | "target_pct" | "target_nav">
): string {
	return `<b>${escapeHtml(String(row.scheme_name))}</b>\n  Base NAV: ₹${Number(row.baseline_nav).toFixed(2)} | Target: +${row.target_pct}% (₹${Number(row.target_nav).toFixed(2)})`;
}

// -------------------------------------------------------------
// Telegram API Helpers
// -------------------------------------------------------------
async function sendTelegram(token: string, method: string, payload: Record<string, unknown>): Promise<Response> {
	if (!token) {
		throw new Error("BOT_TOKEN secret is not configured");
	}

	const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});

	if (!res.ok) {
		const errorBody = await res.text();
		throw new Error(`Telegram API ${method} failed (${res.status}): ${errorBody}`);
	}

	return res;
}

async function sendMessage(
	token: string,
	chatId: number,
	text: string,
	extra: Record<string, unknown> = {}
): Promise<Response> {
	return sendTelegram(token, "sendMessage", {
		chat_id: chatId,
		text,
		...extra,
	});
}

/** Edits an existing Telegram message when messageId is available, or sends a new message otherwise. */
async function sendOrEditMessage(
	token: string,
	chatId: number,
	messageId: number | undefined,
	text: string,
	extra: Record<string, unknown> = {},
	clearInlineKeyboard = false
): Promise<void> {
	if (messageId == null) {
		await sendMessage(token, chatId, text, extra);
		return;
	}

	const payload: Record<string, unknown> = {
		chat_id: chatId,
		message_id: messageId,
		text,
		...extra,
	};
	if (clearInlineKeyboard && !("reply_markup" in payload)) {
		payload.reply_markup = { inline_keyboard: [] };
	}

	try {
		await sendTelegram(token, "editMessageText", payload);
	} catch (err: any) {
		// Ignore Telegram's benign error when an edit leaves message content and markup unchanged
		if (err instanceof Error && err.message.includes("message is not modified")) {
			return;
		}
		throw err;
	}
}

/** Fetches the persisted conversation state for a chat. */
async function getUserState(db: D1Database, chatId: number): Promise<UserRow | null> {
	return db
		.prepare("SELECT chat_id, state, temp_scheme_code, temp_scheme_name, temp_base_nav FROM users WHERE chat_id = ?")
		.bind(chatId)
		.first<UserRow>();
}

/** Persists the conversation state for a chat, creating the user row if missing. */
async function setUserState(db: D1Database, chatId: number, state: string): Promise<void> {
	await db
		.prepare(
			`INSERT INTO users (chat_id, state) VALUES (?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET state = ?`
		)
		.bind(chatId, state, state)
		.run();
}

/** Expires any pending delete prompt when the user moves on to another command. */
async function clearPendingDeleteState(db: D1Database, chatId: number): Promise<void> {
	await db
		.prepare("UPDATE users SET state = 'IDLE' WHERE chat_id = ? AND state IN ('AWAITING_DELETE', 'DELETE_COMPLETED')")
		.bind(chatId)
		.run();
}

/** Notifies the user that a delete prompt has expired and removes its inline keyboard. */
async function sendExpiredDeletePrompt(token: string, chatId: number, messageId?: number): Promise<void> {
	await sendOrEditMessage(token, chatId, messageId, DELETE_PROMPT_EXPIRED_TEXT, {}, true);
}

/** Resets state to IDLE and notifies the user when cached current NAV is missing or invalid. */
async function resetInvalidCurrentNav(env: Env, chatId: number, messageId?: number): Promise<void> {
	await setUserState(env.DB, chatId, "IDLE");
	await sendOrEditMessage(
		env.BOT_TOKEN,
		chatId,
		messageId,
		"Could not determine the current NAV for this fund. Please try /add again.",
		{},
		messageId != null
	);
}

/** Persists the selected baseline NAV and prompts the user for the target gain percentage. */
async function confirmBaseNavAndPromptTarget(
	env: Env,
	chatId: number,
	baseNav: number,
	schemeName?: string | null,
	messageId?: number
): Promise<void> {
	await env.DB.prepare("UPDATE users SET state = 'AWAITING_TARGET_PCT', temp_base_nav = ? WHERE chat_id = ?")
		.bind(baseNav, chatId)
		.run();

	const fundPrefix = schemeName ? `Fund: <b>${escapeHtml(String(schemeName))}</b>\n` : "";
	await sendOrEditMessage(
		env.BOT_TOKEN,
		chatId,
		messageId,
		`${fundPrefix}Base NAV set to ₹${baseNav.toFixed(2)}.\n\nNow enter your target gain percentage (e.g., enter <code>10</code> for 10%):`,
		{ parse_mode: "HTML" },
		messageId != null
	);
}

/** Builds a paginated 5-item selection message and inline keyboard for active targets in a chat. */
async function buildDeletePagePayload(
	db: D1Database,
	chatId: number,
	requestedPage: number
): Promise<DeletePagePayload | null> {
	const countRow = await db
		.prepare("SELECT COUNT(*) AS total FROM tracked_funds WHERE chat_id = ? AND is_triggered = 0 AND is_deleted = 0")
		.bind(chatId)
		.first<{ total: number }>();

	const total = Number(countRow?.total ?? 0);
	if (total === 0) {
		return null;
	}

	const totalPages = Math.ceil(total / DELETE_PAGE_SIZE);
	const page = Math.min(Math.max(0, requestedPage), totalPages - 1);
	const offset = page * DELETE_PAGE_SIZE;

	const { results: items } = await db
		.prepare(
			`SELECT id, chat_id, scheme_code, scheme_name, baseline_nav, target_pct, target_nav
       FROM tracked_funds
       WHERE chat_id = ? AND is_triggered = 0 AND is_deleted = 0
       ORDER BY id ASC
       LIMIT ? OFFSET ?`
		)
		.bind(chatId, DELETE_PAGE_SIZE, offset)
		.all<TrackedFundRow>();

	if (!items || items.length === 0) {
		return null;
	}

	const listText = items.map((item, idx) => `<b>${idx + 1}.</b> ${formatTargetSummary(item)}`).join("\n\n");

	const inlineKeyboard: InlineKeyboardButton[][] = [
		items.map((item, idx) => ({
			text: String(idx + 1),
			callback_data: `DELETE_FUND:${item.id}`,
		})),
	];

	if (totalPages > 1) {
		const navRow: InlineKeyboardButton[] = [];
		if (page > 0) {
			navRow.push({ text: "⬅️ Prev", callback_data: `DELETE_PAGE:${page - 1}` });
		}
		if (page < totalPages - 1) {
			navRow.push({ text: "Next ➡️", callback_data: `DELETE_PAGE:${page + 1}` });
		}
		if (navRow.length > 0) {
			inlineKeyboard.push(navRow);
		}
	}

	return {
		text: `🗑️ <b>Select a target to delete</b> (Page ${page + 1} of ${totalPages}):\n\n${listText}`,
		replyMarkup: { inline_keyboard: inlineKeyboard },
	};
}

export default {
	// -----------------------------------------------------------
	// 1. Webhook Handler: Bot Conversations & Registration
	// -----------------------------------------------------------
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("OK", { status: 200 });
		}

		try {
			const update: any = await request.json();

			// Handle button clicks (Callback Queries for fund selection, base NAV, & deletion)
			if (update.callback_query) {
				const query = update.callback_query;
				const chatId = query.message?.chat?.id;
				const messageId: number | undefined = query.message?.message_id;
				const data: string | undefined = query.data;

				if (query.id) {
					await sendTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
						callback_query_id: query.id,
					});
				}

				if (!chatId || !data) {
					return new Response("OK");
				}

				const [action, arg] = data.split(":");

				if (action === "SELECT_FUND" && arg) {
					const schemeCode = arg;
					const res = await fetch(`https://api.mfapi.in/mf/${encodeURIComponent(schemeCode)}/latest`);
					const fundData: any = await res.json();
					const latestEntry = fundData?.data?.[0];
					const schemeName: string | undefined = fundData?.meta?.scheme_name;
					const latestNav = latestEntry ? parseFloat(latestEntry.nav) : NaN;

					if (!schemeName || isNaN(latestNav) || latestNav <= 0) {
						await sendMessage(
							env.BOT_TOKEN,
							chatId,
							"Could not fetch NAV details for that fund right now. Please try /add again."
						);
						return new Response("OK");
					}

					// Update state to await purchase/base NAV
					await env.DB.prepare(
						`INSERT INTO users (chat_id, state, temp_scheme_code, temp_scheme_name, temp_base_nav)
             VALUES (?, 'AWAITING_BASE_NAV', ?, ?, ?)
             ON CONFLICT(chat_id) DO UPDATE SET 
                state='AWAITING_BASE_NAV', temp_scheme_code=?, temp_scheme_name=?, temp_base_nav=?`
					)
						.bind(chatId, schemeCode, schemeName, latestNav, schemeCode, schemeName, latestNav)
						.run();

					await sendMessage(
						env.BOT_TOKEN,
						chatId,
						`Selected: <b>${escapeHtml(schemeName)}</b>\nLatest NAV: ₹${latestNav.toFixed(2)}\n\nEnter your purchase NAV, or tap <b>Current</b> to track from today:`,
						{
							parse_mode: "HTML",
							reply_markup: buildCurrentNavMarkup(schemeCode),
						}
					);
					return new Response("OK");
				}

				if (action === "SET_CURRENT_NAV") {
					const userState = await getUserState(env.DB, chatId);

					if (!userState || userState.state !== "AWAITING_BASE_NAV") {
						const expiredText =
							userState?.state === "AWAITING_TARGET_PCT" &&
							userState.temp_base_nav != null &&
							Number.isFinite(Number(userState.temp_base_nav))
								? `Base NAV is already set to ₹${Number(userState.temp_base_nav).toFixed(2)}. Please enter your target gain percentage (e.g., enter <code>10</code> for 10%):`
								: "This prompt has expired. Please use /add to start tracking a fund.";
						await sendOrEditMessage(
							env.BOT_TOKEN,
							chatId,
							messageId,
							expiredText,
							{ parse_mode: "HTML" },
							true
						);
						return new Response("OK");
					}

					if (arg && String(userState.temp_scheme_code) !== arg) {
						await sendOrEditMessage(
							env.BOT_TOKEN,
							chatId,
							messageId,
							"This prompt has expired because you selected another fund.",
							{},
							true
						);
						return new Response("OK");
					}

					const baseNav = Number(userState.temp_base_nav);
					if (!Number.isFinite(baseNav) || baseNav <= 0) {
						await resetInvalidCurrentNav(env, chatId, messageId);
						return new Response("OK");
					}

					await confirmBaseNavAndPromptTarget(env, chatId, baseNav, userState.temp_scheme_name, messageId);
					return new Response("OK");
				}

				if (action === "DELETE_PAGE" && arg && /^\d+$/.test(arg)) {
					const userState = await getUserState(env.DB, chatId);
					if (!userState || userState.state !== "AWAITING_DELETE") {
						await sendExpiredDeletePrompt(env.BOT_TOKEN, chatId, messageId);
						return new Response("OK");
					}

					const page = Number(arg);
					const payload = await buildDeletePagePayload(env.DB, chatId, page);
					if (!payload) {
						await setUserState(env.DB, chatId, "IDLE");
						await sendOrEditMessage(
							env.BOT_TOKEN,
							chatId,
							messageId,
							"No active targets to delete. Use /add to start tracking.",
							{},
							true
						);
						return new Response("OK");
					}

					await sendOrEditMessage(env.BOT_TOKEN, chatId, messageId, payload.text, {
						parse_mode: "HTML",
						reply_markup: payload.replyMarkup,
					});
					return new Response("OK");
				}

				if (action === "DELETE_FUND" && arg && /^\d+$/.test(arg)) {
					const userState = await getUserState(env.DB, chatId);
					if (
						!userState ||
						(userState.state !== "AWAITING_DELETE" && userState.state !== "DELETE_COMPLETED")
					) {
						await sendExpiredDeletePrompt(env.BOT_TOKEN, chatId, messageId);
						return new Response("OK");
					}

					const fundId = Number(arg);
					const target = await env.DB.prepare(
						`SELECT id, chat_id, scheme_code, scheme_name, baseline_nav, target_pct, target_nav
             FROM tracked_funds
             WHERE id = ? AND chat_id = ? AND is_triggered = 0 AND is_deleted = 0`
					)
						.bind(fundId, chatId)
						.first<TrackedFundRow>();

					if (userState.state === "DELETE_COMPLETED" && target) {
						await sendExpiredDeletePrompt(env.BOT_TOKEN, chatId, messageId);
						return new Response("OK");
					}

					const deleteResult =
						userState.state === "AWAITING_DELETE" && target
							? await env.DB.prepare(
									"UPDATE tracked_funds SET is_deleted = 1 WHERE id = ? AND chat_id = ? AND is_triggered = 0 AND is_deleted = 0"
							  )
									.bind(fundId, chatId)
									.run()
							: null;

					if (!target || !deleteResult?.meta.changes) {
						await sendOrEditMessage(
							env.BOT_TOKEN,
							chatId,
							messageId,
							"That target is no longer active or was already deleted.",
							{},
							true
						);
						return new Response("OK");
					}

					await setUserState(env.DB, chatId, "DELETE_COMPLETED");
					await sendOrEditMessage(
						env.BOT_TOKEN,
						chatId,
						messageId,
						`🗑️ <b>Target Deleted!</b>\n\n• ${formatTargetSummary(target)}\n\nUse /delete to remove another target or /list to view active targets.`,
						{ parse_mode: "HTML" },
						true
					);
					return new Response("OK");
				}

				return new Response("OK");
			}

			// Handle standard text messages
			if (update.message && update.message.text) {
				const chatId: number = update.message.chat.id;
				const text: string = update.message.text.trim();
				const command = text.startsWith("/") ? text.split(/\s+/)[0].split("@")[0].toLowerCase() : null;

				if (command && command !== "/delete" && command !== "/start" && command !== "/add") {
					await clearPendingDeleteState(env.DB, chatId);
				}

				if (command === "/start") {
					await setUserState(env.DB, chatId, "IDLE");

					await sendMessage(
						env.BOT_TOKEN,
						chatId,
						"👋 Welcome to Mutual Fund Target Tracker!\n\nCommands:\n/add - Track a new fund\n/list - View your active targets\n/delete - Delete an active target\n/help - Instructions"
					);
					return new Response("OK");
				}

				if (command === "/help") {
					await sendMessage(
						env.BOT_TOKEN,
						chatId,
						"ℹ️ <b>How to use Mutual Fund Target Tracker:</b>\n\n" +
						"1. Send /add and type a fund name (e.g., <code>Parag Parikh Flexi</code>).\n" +
						"2. Tap your fund from the search results.\n" +
						"3. Enter your purchase NAV (or tap <b>Current</b>).\n" +
						"4. Enter your target gain % (e.g., <code>10</code> for +10%).\n\n" +
						"Use /list anytime to view active targets or /delete to remove one. Funds are checked daily at 7:00 AM IST.",
						{ parse_mode: "HTML" }
					);
					return new Response("OK");
				}

				if (command === "/add") {
					await setUserState(env.DB, chatId, "AWAITING_QUERY");

					await sendMessage(
						env.BOT_TOKEN,
						chatId,
						"Enter the fund name or keywords (e.g., <code>Parag Parikh Flexi</code> or <code>Nifty 50</code>):",
						{ parse_mode: "HTML" }
					);
					return new Response("OK");
				}

				if (command === "/list") {
					const { results } = await env.DB.prepare(
						"SELECT id, chat_id, scheme_code, scheme_name, baseline_nav, target_pct, target_nav FROM tracked_funds WHERE chat_id = ? AND is_triggered = 0 AND is_deleted = 0 ORDER BY id ASC"
					)
						.bind(chatId)
						.all<TrackedFundRow>();

					if (!results || results.length === 0) {
						await sendMessage(env.BOT_TOKEN, chatId, "No active targets set. Use /add to start tracking.");
						return new Response("OK");
					}

					let responseText = "📊 <b>Active Target Funds:</b>\n\n";
					for (const item of results) {
						responseText += `• ${formatTargetSummary(item)}\n\n`;
					}

					await sendMessage(env.BOT_TOKEN, chatId, responseText, { parse_mode: "HTML" });
					return new Response("OK");
				}

				if (command === "/delete") {
					const payload = await buildDeletePagePayload(env.DB, chatId, 0);
					if (!payload) {
						await setUserState(env.DB, chatId, "IDLE");
						await sendMessage(env.BOT_TOKEN, chatId, "No active targets to delete. Use /add to start tracking.");
						return new Response("OK");
					}

					await setUserState(env.DB, chatId, "AWAITING_DELETE");
					await sendMessage(env.BOT_TOKEN, chatId, payload.text, {
						parse_mode: "HTML",
						reply_markup: payload.replyMarkup,
					});
					return new Response("OK");
				}

				// Fetch User Conversation State
				const userState = await getUserState(env.DB, chatId);

				if (!userState || userState.state === "IDLE") {
					return new Response("OK");
				}

				// State 1: Searching for Fund
				if (userState.state === "AWAITING_QUERY") {
					const searchRes = await fetch(
						`https://api.mfapi.in/mf/search?q=${encodeURIComponent(text)}`
					);
					const searchData: any = await searchRes.json();
					const topMatches = Array.isArray(searchData)
						? searchData.filter((m: any) => m?.schemeCode != null && m?.schemeName).slice(0, 5)
						: [];

					if (topMatches.length === 0) {
						await sendMessage(
							env.BOT_TOKEN,
							chatId,
							"No funds found matching that keyword. Please try a different query:"
						);
						return new Response("OK");
					}

					const fundList = topMatches
						.map((m: any, idx: number) => `<b>${idx + 1}.</b> ${escapeHtml(String(m.schemeName))}`)
						.join("\n\n");

					const inlineKeyboard = [
						topMatches.map((m: any, idx: number) => ({
							text: String(idx + 1),
							callback_data: `SELECT_FUND:${m.schemeCode}`,
						})),
					];

					await sendMessage(
						env.BOT_TOKEN,
						chatId,
						`Tap a number below to track:\n\n${fundList}`,
						{
							parse_mode: "HTML",
							reply_markup: { inline_keyboard: inlineKeyboard },
						}
					);
					return new Response("OK");
				}

				// State 2: Input Baseline NAV
				if (userState.state === "AWAITING_BASE_NAV") {
					let baseNav = Number(userState.temp_base_nav);
					if (text.toLowerCase() !== "current") {
						const parsed = parseFloat(text);
						if (isNaN(parsed) || parsed <= 0) {
							const extra: Record<string, unknown> = { parse_mode: "HTML" };
							if (userState.temp_scheme_code != null) {
								extra.reply_markup = buildCurrentNavMarkup(userState.temp_scheme_code);
							}
							await sendMessage(
								env.BOT_TOKEN,
								chatId,
								"Invalid number. Enter a positive number for NAV, or tap <b>Current</b>:",
								extra
							);
							return new Response("OK");
						}
						baseNav = parsed;
					} else if (!Number.isFinite(baseNav) || baseNav <= 0) {
						await resetInvalidCurrentNav(env, chatId);
						return new Response("OK");
					}

					await confirmBaseNavAndPromptTarget(env, chatId, baseNav, userState.temp_scheme_name);
					return new Response("OK");
				}

				// State 3: Input Target Percentage & Finalize
				if (userState.state === "AWAITING_TARGET_PCT") {
					const targetPct = parseFloat(text);
					if (isNaN(targetPct) || targetPct <= 0) {
						await sendMessage(
							env.BOT_TOKEN,
							chatId,
							"Please enter a valid positive percentage (e.g. <code>10</code> or <code>15.5</code>):",
							{ parse_mode: "HTML" }
						);
						return new Response("OK");
					}

					const baseNav = Number(userState.temp_base_nav);
					const targetNav = +(baseNav * (1 + targetPct / 100)).toFixed(4);

					// Insert into tracked_funds
					await env.DB.prepare(
						`INSERT INTO tracked_funds 
             (chat_id, scheme_code, scheme_name, baseline_nav, target_pct, target_nav, last_nav) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`
					)
						.bind(
							chatId,
							userState.temp_scheme_code,
							userState.temp_scheme_name,
							baseNav,
							targetPct,
							targetNav,
							baseNav
						)
						.run();

					// Reset user state to IDLE
					await setUserState(env.DB, chatId, "IDLE");

					await sendMessage(
						env.BOT_TOKEN,
						chatId,
						`✅ <b>Target Registered!</b>\n\n• Fund: ${escapeHtml(String(userState.temp_scheme_name))}\n• Base NAV: ₹${baseNav.toFixed(2)}\n• Target: +${targetPct}% (₹${targetNav.toFixed(2)})\n\nWe evaluate every morning at 7:00 AM IST and will notify you when achieved!`,
						{ parse_mode: "HTML" }
					);
					return new Response("OK");
				}
			}

			return new Response("OK");
		} catch (err: any) {
			console.error("Webhook handler error:", err);
			return new Response(err?.message ?? "Internal Server Error", { status: 500 });
		}
	},

	// -----------------------------------------------------------
	// 2. Cron Trigger Handler: Evaluates Daily at 7:00 AM IST
	// -----------------------------------------------------------
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		const { results: schemeRows } = await env.DB.prepare(
			"SELECT DISTINCT scheme_code FROM tracked_funds WHERE is_triggered = 0 AND is_deleted = 0"
		).all<{ scheme_code: number }>();

		if (!schemeRows || schemeRows.length === 0) return;

		const navCache = new Map<number, number>();

		for (const { scheme_code: code } of schemeRows) {
			try {
				const res = await fetch(`https://api.mfapi.in/mf/${code}/latest`);
				const json: any = await res.json();
				const navStr = json?.data?.[0]?.nav;
				if (navStr) {
					const parsed = parseFloat(navStr);
					if (!isNaN(parsed) && parsed > 0) {
						navCache.set(code, parsed);
					}
				}
			} catch (e) {
				console.error(`Failed to fetch NAV for scheme ${code}:`, e);
			}
		}

		if (navCache.size === 0) return;

		const navEntries = Array.from(navCache.entries());

		// Query only active tracked_funds whose targets have been achieved
		const selectTriggeredStmt = env.DB.prepare(
			`SELECT id, chat_id, scheme_code, scheme_name, baseline_nav, target_pct, target_nav
       FROM tracked_funds
       WHERE is_triggered = 0 AND is_deleted = 0 AND scheme_code = ? AND target_nav <= ?`
		);
		const triggeredResults = await env.DB.batch<TrackedFundRow>(
			navEntries.map(([code, nav]) => selectTriggeredStmt.bind(code, nav))
		);

		const notifiedIds: number[] = [];

		for (const result of triggeredResults) {
			for (const row of result.results ?? []) {
				const currentNav = navCache.get(row.scheme_code);
				if (!currentNav) continue;

				const baselineNav = Number(row.baseline_nav);
				const targetNav = Number(row.target_nav);
				const gainPct = ((currentNav - baselineNav) / baselineNav) * 100;

				try {
					await sendMessage(
						env.BOT_TOKEN,
						row.chat_id,
						`🎯 <b>Target Achieved!</b>\n\n<b>Fund:</b> ${escapeHtml(String(row.scheme_name))}\n<b>Baseline NAV:</b> ₹${baselineNav.toFixed(2)}\n<b>Current NAV:</b> ₹${currentNav.toFixed(2)} (+${gainPct.toFixed(2)}%)\n<b>Target Set:</b> +${row.target_pct}% (₹${targetNav.toFixed(2)})\n\n`,
						{ parse_mode: "HTML" }
					);
					notifiedIds.push(row.id);
				} catch (e) {
					console.error(`Failed to process tracked_fund ${row.id}:`, e);
				}
			}
		}

		// Bulk-update last_nav per scheme and mark notified rows as triggered in one batch transaction
		const updateNavStmt = env.DB.prepare(
			"UPDATE tracked_funds SET last_nav = ? WHERE scheme_code = ? AND is_triggered = 0 AND is_deleted = 0"
		);
		const updateStatements: D1PreparedStatement[] = navEntries.map(([code, nav]) =>
			updateNavStmt.bind(nav, code)
		);

		// D1 allows at most 100 bound parameters per SQL statement
		const MAX_D1_PARAMS = 100;
		for (let i = 0; i < notifiedIds.length; i += MAX_D1_PARAMS) {
			const chunk = notifiedIds.slice(i, i + MAX_D1_PARAMS);
			const placeholders = chunk.map(() => "?").join(", ");
			updateStatements.push(
				env.DB.prepare(`UPDATE tracked_funds SET is_triggered = 1 WHERE id IN (${placeholders}) AND is_deleted = 0`).bind(
					...chunk
				)
			);
		}

		await env.DB.batch(updateStatements);
	},
};
