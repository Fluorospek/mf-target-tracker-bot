export interface Env {
	DB: D1Database;
	BOT_TOKEN: string;
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

			// Handle button clicks (Callback Queries for fund selection)
			if (update.callback_query) {
				const query = update.callback_query;
				const chatId = query.message?.chat?.id;
				const data: string | undefined = query.data;

				if (query.id) {
					await sendTelegram(env.BOT_TOKEN, "answerCallbackQuery", {
						callback_query_id: query.id,
					});
				}

				if (!chatId || !data) {
					return new Response("OK");
				}

				const [action, schemeCode] = data.split(":");

				if (action === "SELECT_FUND" && schemeCode) {
					const res = await fetch(`https://api.mfapi.in/mf/${encodeURIComponent(schemeCode)}/latest`);
					const fundData: any = await res.json();
					const latestEntry = fundData?.data?.[0];
					const schemeName: string | undefined = fundData?.meta?.scheme_name;
					const latestNav = latestEntry ? parseFloat(latestEntry.nav) : NaN;

					if (!schemeName || isNaN(latestNav)) {
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
						`Selected: <b>${escapeHtml(schemeName)}</b>\nLatest NAV: ₹${latestNav.toFixed(2)}\n\nEnter your purchase NAV (or reply <b>current</b> to track from today):`,
						{ parse_mode: "HTML" }
					);
				}
				return new Response("OK");
			}

			// Handle standard text messages
			if (update.message && update.message.text) {
				const chatId: number = update.message.chat.id;
				const text: string = update.message.text.trim();
				const command = text.startsWith("/") ? text.split(/\s+/)[0].split("@")[0].toLowerCase() : null;

				if (command === "/start") {
					await env.DB.prepare(
						`INSERT INTO users (chat_id, state) VALUES (?, 'IDLE')
             ON CONFLICT(chat_id) DO UPDATE SET state = 'IDLE'`
					)
						.bind(chatId)
						.run();

					await sendMessage(
						env.BOT_TOKEN,
						chatId,
						"👋 Welcome to Mutual Fund Target Tracker!\n\nCommands:\n/add - Track a new fund\n/list - View your active targets\n/help - Instructions"
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
						"3. Enter your purchase NAV (or reply <code>current</code>).\n" +
						"4. Enter your target gain % (e.g., <code>10</code> for +10%).\n\n" +
						"Use /list anytime to view active targets. Funds are checked daily at 7:00 AM IST.",
						{ parse_mode: "HTML" }
					);
					return new Response("OK");
				}

				if (command === "/add") {
					await env.DB.prepare(
						`INSERT INTO users (chat_id, state) VALUES (?, 'AWAITING_QUERY')
             ON CONFLICT(chat_id) DO UPDATE SET state = 'AWAITING_QUERY'`
					)
						.bind(chatId)
						.run();

					await sendMessage(
						env.BOT_TOKEN,
						chatId,
						"Enter the fund name or keywords (e.g., <code>Parag Parikh Flexi</code> or <code>Nifty 50</code>):",
						{ parse_mode: "HTML" }
					);
					return new Response("OK");
				}

				if (command === "/list") {
					const { results }: any = await env.DB.prepare(
						"SELECT * FROM tracked_funds WHERE chat_id = ? AND is_triggered = 0"
					)
						.bind(chatId)
						.all();

					if (!results || results.length === 0) {
						await sendMessage(env.BOT_TOKEN, chatId, "No active targets set. Use /add to start tracking.");
						return new Response("OK");
					}

					let responseText = "📊 <b>Active Target Funds:</b>\n\n";
					for (const item of results) {
						responseText += `• <b>${escapeHtml(String(item.scheme_name))}</b>\n  Base NAV: ₹${Number(item.baseline_nav).toFixed(2)} | Target: +${item.target_pct}% (₹${Number(item.target_nav).toFixed(2)})\n\n`;
					}

					await sendMessage(env.BOT_TOKEN, chatId, responseText, { parse_mode: "HTML" });
					return new Response("OK");
				}

				// Fetch User Conversation State
				const userState: any = await env.DB.prepare("SELECT * FROM users WHERE chat_id = ?")
					.bind(chatId)
					.first();

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
							await sendMessage(
								env.BOT_TOKEN,
								chatId,
								"Invalid number. Enter a positive number for NAV (or type <code>current</code>):",
								{ parse_mode: "HTML" }
							);
							return new Response("OK");
						}
						baseNav = parsed;
					}

					await env.DB.prepare("UPDATE users SET state = 'AWAITING_TARGET_PCT', temp_base_nav = ? WHERE chat_id = ?")
						.bind(baseNav, chatId)
						.run();

					await sendMessage(
						env.BOT_TOKEN,
						chatId,
						`Base NAV set to ₹${baseNav.toFixed(2)}.\n\nNow enter your target gain percentage (e.g., enter <code>10</code> for 10%):`,
						{ parse_mode: "HTML" }
					);
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
					await env.DB.prepare("UPDATE users SET state = 'IDLE' WHERE chat_id = ?").bind(chatId).run();

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
		const { results }: any = await env.DB.prepare(
			"SELECT * FROM tracked_funds WHERE is_triggered = 0"
		).all();

		if (!results || results.length === 0) return;

		// Deduplicate scheme codes to minimize external HTTP calls
		const distinctCodes: number[] = Array.from(new Set(results.map((r: any) => r.scheme_code)));
		const navCache: Record<number, number> = {};

		for (const code of distinctCodes) {
			try {
				const res = await fetch(`https://api.mfapi.in/mf/${code}/latest`);
				const json: any = await res.json();
				const navStr = json?.data?.[0]?.nav;
				if (navStr) {
					const parsed = parseFloat(navStr);
					if (!isNaN(parsed)) {
						navCache[code] = parsed;
					}
				}
			} catch (e) {
				console.error(`Failed to fetch NAV for scheme ${code}:`, e);
			}
		}

		for (const row of results) {
			const currentNav = navCache[row.scheme_code];
			if (!currentNav) continue;

			const baselineNav = Number(row.baseline_nav);
			const targetNav = Number(row.target_nav);
			const gainPct = ((currentNav - baselineNav) / baselineNav) * 100;

			try {
				if (currentNav >= targetNav) {
					// Target achieved: Send alert and mark as triggered
					await sendMessage(
						env.BOT_TOKEN,
						row.chat_id,
						`🎯 <b>Target Achieved!</b>\n\n<b>Fund:</b> ${escapeHtml(String(row.scheme_name))}\n<b>Baseline NAV:</b> ₹${baselineNav.toFixed(2)}\n<b>Current NAV:</b> ₹${currentNav.toFixed(2)} (+${gainPct.toFixed(2)}%)\n<b>Target Set:</b> +${row.target_pct}% (₹${targetNav.toFixed(2)})\n\nYou may log in to review or rebalance your holding.`,
						{ parse_mode: "HTML" }
					);

					await env.DB.prepare("UPDATE tracked_funds SET is_triggered = 1, last_nav = ? WHERE id = ?")
						.bind(currentNav, row.id)
						.run();
				} else {
					// Update last NAV quietly
					await env.DB.prepare("UPDATE tracked_funds SET last_nav = ? WHERE id = ?")
						.bind(currentNav, row.id)
						.run();
				}
			} catch (e) {
				console.error(`Failed to process tracked_fund ${row.id}:`, e);
			}
		}
	},
};
