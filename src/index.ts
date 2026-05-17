import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import express, { type Request, type Response } from 'express';
import { appendFile } from 'node:fs';
import { WhoopClient } from './whoop-client.js';
import { WhoopDatabase } from './database.js';
import { WhoopSync } from './sync.js';

interface ToolArguments {
	days?: number;
	full?: boolean;
}

const config = {
	clientId: process.env.WHOOP_CLIENT_ID ?? '',
	clientSecret: process.env.WHOOP_CLIENT_SECRET ?? '',
	redirectUri: process.env.WHOOP_REDIRECT_URI ?? 'http://localhost:3000/callback',
	dbPath: process.env.DB_PATH ?? './whoop.db',
	port: Number.parseInt(process.env.PORT ?? '3000', 10),
	mode: process.env.MCP_MODE ?? 'http',
};

const db = new WhoopDatabase(config.dbPath);
const client = new WhoopClient({
	clientId: config.clientId,
	clientSecret: config.clientSecret,
	redirectUri: config.redirectUri,
	onTokenRefresh: tokens => db.saveTokens(tokens),
});

const existingTokens = db.getTokens();
if (existingTokens) {
	client.setTokens(existingTokens);
}

const sync = new WhoopSync(client, db);

const SESSION_TTL_MS = 30 * 60 * 1000;
const transports = new Map<string, { transport: StreamableHTTPServerTransport; lastAccess: number }>();

function cleanupStaleSessions(): void {
	const now = Date.now();
	for (const [sessionId, session] of transports) {
		if (now - session.lastAccess > SESSION_TTL_MS) {
			session.transport.close().catch(() => {});
			transports.delete(sessionId);
		}
	}
}

setInterval(cleanupStaleSessions, 5 * 60 * 1000);

function formatDuration(millis: number | null): string {
	if (!millis) return 'N/A';
	const hours = Math.floor(millis / 3_600_000);
	const minutes = Math.floor((millis % 3_600_000) / 60_000);
	return `${hours}h ${minutes}m`;
}

function formatDate(isoString: string): string {
	return new Date(isoString).toLocaleDateString('en-US', {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
	});
}

function getRecoveryZone(score: number): string {
	if (score >= 67) return 'Green (Well Recovered)';
	if (score >= 34) return 'Yellow (Moderate)';
	return 'Red (Needs Rest)';
}

function getStrainZone(strain: number): string {
	if (strain >= 18) return 'All Out (18-21)';
	if (strain >= 14) return 'High (14-17)';
	if (strain >= 10) return 'Moderate (10-13)';
	return 'Light (0-9)';
}

function validateDays(value: unknown): number {
	if (value === undefined || value === null) return 14;
	const num = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
	if (Number.isNaN(num) || num < 1) return 14;
	return Math.min(num, 90);
}

function validateBoolean(value: unknown): boolean {
	if (typeof value === 'boolean') return value;
	if (value === 'true') return true;
	return false;
}

function createMcpServer(): Server {
	const server = new Server(
		{ name: 'whoop-mcp-server', version: '1.0.0' },
		{ capabilities: { tools: {} } }
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{
				name: 'get_today',
				description: "Get today's Whoop data including recovery score, last night's sleep, and current strain.",
				inputSchema: { type: 'object', properties: {}, required: [] },
			},
			{
				name: 'get_recovery_trends',
				description: 'Get recovery score trends over time, including HRV and resting heart rate patterns.',
				inputSchema: {
					type: 'object',
					properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 90)' } },
					required: [],
				},
			},
			{
				name: 'get_sleep_analysis',
				description: 'Get detailed sleep analysis including duration, stages, efficiency, and sleep debt.',
				inputSchema: {
					type: 'object',
					properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 90)' } },
					required: [],
				},
			},
			{
				name: 'get_strain_history',
				description: 'Get training strain history and workout data.',
				inputSchema: {
					type: 'object',
					properties: { days: { type: 'number', description: 'Number of days to analyze (default: 14, max: 90)' } },
					required: [],
				},
			},
			{
				name: 'sync_data',
				description: 'Manually trigger a data sync from Whoop.',
				inputSchema: {
					type: 'object',
					properties: { full: { type: 'boolean', description: 'Force a full 90-day sync (default: false)' } },
					required: [],
				},
			},
			{
				name: 'get_auth_url',
				description: 'Get the Whoop authorization URL to connect your account.',
				inputSchema: { type: 'object', properties: {}, required: [] },
			},
		],
	}));

	server.setRequestHandler(CallToolRequestSchema, async request => {
		const { name, arguments: args } = request.params;
		const typedArgs = (args ?? {}) as ToolArguments;

		try {
			const dataTools = ['get_today', 'get_recovery_trends', 'get_sleep_analysis', 'get_strain_history'];
			if (dataTools.includes(name)) {
				const tokens = db.getTokens();
				if (!tokens) {
					return { content: [{ type: 'text', text: 'Not authenticated with Whoop. Use get_auth_url to authorize first.' }] };
				}
				client.setTokens(tokens);
				try {
					await sync.smartSync();
				} catch {
					// Continue with cached data
				}
			}

			switch (name) {
				case 'get_today': {
					const recovery = db.getLatestRecovery();
					const sleep = db.getLatestSleep();
					const cycle = db.getLatestCycle();

					if (!recovery && !sleep && !cycle) {
						return { content: [{ type: 'text', text: 'No data available. Try running sync_data first.' }] };
					}

					let response = "# Today's Whoop Summary\n\n";

					if (recovery) {
						response += `## Recovery: ${recovery.recovery_score ?? 'N/A'}% ${recovery.recovery_score ? getRecoveryZone(recovery.recovery_score) : ''}\n`;
						response += `- **HRV**: ${recovery.hrv_rmssd?.toFixed(1) ?? 'N/A'} ms\n`;
						response += `- **Resting HR**: ${recovery.resting_hr ?? 'N/A'} bpm\n`;
						if (recovery.spo2) response += `- **SpO2**: ${recovery.spo2.toFixed(1)}%\n`;
						if (recovery.skin_temp) response += `- **Skin Temp**: ${recovery.skin_temp.toFixed(1)}°C\n`;
						response += '\n';
					}

					if (sleep) {
						const totalSleep = (sleep.total_in_bed_milli ?? 0) - (sleep.total_awake_milli ?? 0);
						response += `## Last Night's Sleep\n`;
						response += `- **Total Sleep**: ${formatDuration(totalSleep)}\n`;
						response += `- **Performance**: ${sleep.sleep_performance?.toFixed(0) ?? 'N/A'}%\n`;
						response += `- **Efficiency**: ${sleep.sleep_efficiency?.toFixed(0) ?? 'N/A'}%\n`;
						response += `- **Stages**: Light ${formatDuration(sleep.total_light_milli)}, Deep ${formatDuration(sleep.total_deep_milli)}, REM ${formatDuration(sleep.total_rem_milli)}\n`;
						if (sleep.respiratory_rate) response += `- **Respiratory Rate**: ${sleep.respiratory_rate.toFixed(1)} breaths/min\n`;
						response += '\n';
					}

					if (cycle) {
						response += `## Current Strain\n`;
						response += `- **Day Strain**: ${cycle.strain?.toFixed(1) ?? 'N/A'} ${cycle.strain ? getStrainZone(cycle.strain) : ''}\n`;
						if (cycle.kilojoule) response += `- **Calories**: ${Math.round(cycle.kilojoule / 4.184)} kcal\n`;
						if (cycle.avg_hr) response += `- **Avg HR**: ${cycle.avg_hr} bpm\n`;
						if (cycle.max_hr) response += `- **Max HR**: ${cycle.max_hr} bpm\n`;
					}

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_recovery_trends': {
					const days = validateDays(typedArgs.days);
					const trends = db.getRecoveryTrends(days);

					if (trends.length === 0) {
						return { content: [{ type: 'text', text: 'No recovery data available for the requested period.' }] };
					}

					let response = `# Recovery Trends (Last ${days} Days)\n\n`;
					response += '| Date | Recovery | HRV | RHR |\n|------|----------|-----|-----|\n';

					for (const day of trends) {
						response += `| ${formatDate(day.date)} | ${day.recovery_score}% | ${day.hrv?.toFixed(1) ?? 'N/A'} ms | ${day.rhr ?? 'N/A'} bpm |\n`;
					}

					const avgRecovery = trends.reduce((sum, d) => sum + (d.recovery_score || 0), 0) / trends.length;
					const avgHrv = trends.reduce((sum, d) => sum + (d.hrv || 0), 0) / trends.length;
					const avgRhr = trends.reduce((sum, d) => sum + (d.rhr || 0), 0) / trends.length;

					response += `\n## Averages\n- **Recovery**: ${avgRecovery.toFixed(0)}%\n- **HRV**: ${avgHrv.toFixed(1)} ms\n- **RHR**: ${avgRhr.toFixed(0)} bpm\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_sleep_analysis': {
					const days = validateDays(typedArgs.days);
					const trends = db.getSleepTrends(days);

					if (trends.length === 0) {
						return { content: [{ type: 'text', text: 'No sleep data available for the requested period.' }] };
					}

					let response = `# Sleep Analysis (Last ${days} Days)\n\n`;
					response += '| Date | Duration | Performance | Efficiency |\n|------|----------|-------------|------------|\n';

					for (const day of trends) {
						response += `| ${formatDate(day.date)} | ${day.total_sleep_hours?.toFixed(1) ?? 'N/A'}h | ${day.performance?.toFixed(0) ?? 'N/A'}% | ${day.efficiency?.toFixed(0) ?? 'N/A'}% |\n`;
					}

					const avgDuration = trends.reduce((sum, d) => sum + (d.total_sleep_hours || 0), 0) / trends.length;
					const avgPerf = trends.reduce((sum, d) => sum + (d.performance || 0), 0) / trends.length;
					const avgEff = trends.reduce((sum, d) => sum + (d.efficiency || 0), 0) / trends.length;

					response += `\n## Averages\n- **Duration**: ${avgDuration.toFixed(1)} hours\n- **Performance**: ${avgPerf.toFixed(0)}%\n- **Efficiency**: ${avgEff.toFixed(0)}%\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				case 'get_strain_history': {
					const days = validateDays(typedArgs.days);
					const trends = db.getStrainTrends(days);

					if (trends.length === 0) {
						return { content: [{ type: 'text', text: 'No strain data available for the requested period.' }] };
					}

					let response = `# Strain History (Last ${days} Days)\n\n`;
					response += '| Date | Strain | Calories |\n|------|--------|----------|\n';

					for (const day of trends) {
						response += `| ${formatDate(day.date)} | ${day.strain?.toFixed(1) ?? 'N/A'} | ${day.calories ?? 'N/A'} kcal |\n`;
					}

					const avgStrain = trends.reduce((sum, d) => sum + (d.strain || 0), 0) / trends.length;
					const avgCalories = trends.reduce((sum, d) => sum + (d.calories || 0), 0) / trends.length;

					response += `\n## Averages\n- **Daily Strain**: ${avgStrain.toFixed(1)}\n- **Daily Calories**: ${Math.round(avgCalories)} kcal\n`;

					return { content: [{ type: 'text', text: response }] };
				}

				case 'sync_data': {
					const tokens = db.getTokens();
					if (!tokens) {
						return { content: [{ type: 'text', text: 'Not authenticated with Whoop. Use get_auth_url to authorize first.' }] };
					}
					client.setTokens(tokens);

					const full = validateBoolean(typedArgs.full);
					let stats;

					if (full) {
						stats = await sync.syncDays(90);
					} else {
						const result = await sync.smartSync();
						if (result.type === 'skip') {
							return { content: [{ type: 'text', text: 'Data is already up to date (synced within the last hour).' }] };
						}
						stats = result.stats;
					}

					return {
						content: [{
							type: 'text',
							text: `Sync complete!\n- Cycles: ${stats?.cycles}\n- Recoveries: ${stats?.recoveries}\n- Sleeps: ${stats?.sleeps}\n- Workouts: ${stats?.workouts}`,
						}],
					};
				}

				case 'get_auth_url': {
					const scopes = ['read:profile', 'read:body_measurement', 'read:cycles', 'read:recovery', 'read:sleep', 'read:workout', 'offline'];
					const url = client.getAuthorizationUrl(scopes);
					return {
						content: [{
							type: 'text',
							text: `To authorize with Whoop:\n\n1. Visit: ${url}\n2. Log in and authorize\n3. You'll be redirected back automatically\n\nRedirect URI: ${config.redirectUri}`,
						}],
					};
				}

				default:
					throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Unknown error';
			return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
		}
	});

	return server;
}

async function main(): Promise<void> {
	if (config.mode === 'stdio') {
		const server = createMcpServer();
		const transport = new StdioServerTransport();
		await server.connect(transport);
		process.stderr.write('Whoop MCP server running on stdio\n');
	} else {
		const app = express();
		// Доверяем заголовкам X-Forwarded-* от KeenDNS, чтобы видеть реальный IP клиента
		// и корректный protocol/host в логах.
		app.set('trust proxy', true);

		// ВАЖНО: парсеры тела НЕ применяем к /mcp — MCP SDK (StreamableHTTPServerTransport)
		// читает сырой поток req сам. Если тут вызвать express.json(), поток уйдёт в req.body,
		// и transport.handleRequest упадёт с «stream is not readable» (Claude в UI покажет это
		// как «Authorization with the MCP server failed», хотя проблема не в OAuth).
		const jsonParser = express.json();
		const urlencodedParser = express.urlencoded({ extended: true });
		app.use((req, res, next) => {
			if (req.path === '/mcp') {
				next();
				return;
			}
			jsonParser(req, res, err => {
				if (err) {
					next(err);
					return;
				}
				urlencodedParser(req, res, next);
			});
		});

		// Логирование каждого входящего HTTP-запроса в stdout (видно в pm2 logs).
		// Полезно для отладки: видно, кто и куда стучится (Claude/Anthropic, OAuth callback и т.д.).
		app.use((req: Request, _res: Response, next: () => void) => {
			const ip = req.ip ?? req.socket.remoteAddress ?? '-';
			const ua = req.headers['user-agent'] ?? '-';
			process.stdout.write(`[${new Date().toISOString()}] ${ip} ${req.method} ${req.url} ua="${ua}"\n`);
			next();
		});

		// ---- Заглушки MCP OAuth (MCP Authorization spec 2025-06-18) ----
		// Claude.ai при добавлении custom connector ожидает, что MCP-сервер реализует
		// OAuth 2.0 со всем discovery (RFC 9728 / 8414 / 7591). Этот форк репы их не
		// реализует, поэтому подсовываем минимальный «открытый» OAuth: discovery отвечает,
		// /register возвращает фиктивного клиента, /authorize сразу редиректит обратно
		// с подложным code, /token выдаёт подложный bearer. Реальная защита /mcp нам не
		// нужна — сервер крутится в локальной сети за KeenDNS и доступен только нам.

		// База публичного URL сервера — берём из WHOOP_REDIRECT_URI, обрезая /callback.
		const PUBLIC_URL = (process.env.WHOOP_REDIRECT_URI ?? '').replace(/\/callback$/, '');

		// RFC 9728 — описание защищённого ресурса. Claude ходит и в общую форму,
		// и в форму с суффиксом ресурса (/mcp), отвечаем одинаково.
		const protectedResource = (_req: Request, res: Response) => {
			res.json({
				resource: `${PUBLIC_URL}/mcp`,
				authorization_servers: [PUBLIC_URL],
			});
		};
		app.get('/.well-known/oauth-protected-resource', protectedResource);
		app.get('/.well-known/oauth-protected-resource/mcp', protectedResource);

		// RFC 8414 — метаданные OAuth Authorization Server.
		app.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
			res.json({
				issuer: PUBLIC_URL,
				authorization_endpoint: `${PUBLIC_URL}/authorize`,
				token_endpoint: `${PUBLIC_URL}/token`,
				registration_endpoint: `${PUBLIC_URL}/register`,
				response_types_supported: ['code'],
				grant_types_supported: ['authorization_code', 'refresh_token'],
				code_challenge_methods_supported: ['S256'],
				token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
			});
		});

		// RFC 7591 — Dynamic Client Registration. Возвращаем фиктивные client_id/secret.
		// Эхо назад полей запроса нужно, чтобы клиент не ругнулся на отсутствие redirect_uris.
		app.post('/register', (req: Request, res: Response) => {
			const body = (req.body ?? {}) as Record<string, unknown>;
			res.status(201).json({
				client_id: 'stub-client',
				client_secret: 'stub-secret',
				client_id_issued_at: Math.floor(Date.now() / 1000),
				redirect_uris: body.redirect_uris ?? [],
				grant_types: body.grant_types ?? ['authorization_code'],
				response_types: body.response_types ?? ['code'],
				token_endpoint_auth_method: body.token_endpoint_auth_method ?? 'none',
			});
		});

		// Authorization endpoint — мгновенно редиректит на redirect_uri с фиктивным code.
		// State обязательно эхом, иначе клиент отбракует ответ как CSRF.
		app.get('/authorize', (req: Request, res: Response) => {
			const redirectUri = req.query.redirect_uri as string | undefined;
			const state = req.query.state as string | undefined;
			if (!redirectUri) {
				res.status(400).send('Missing redirect_uri');
				return;
			}
			let url: URL;
			try {
				url = new URL(redirectUri);
			} catch {
				res.status(400).send('Invalid redirect_uri');
				return;
			}
			url.searchParams.set('code', 'stub-auth-code');
			if (state) url.searchParams.set('state', state);
			res.redirect(302, url.toString());
		});

		// Token endpoint — отдаёт фиктивный bearer на любой запрос.
		app.post('/token', (_req: Request, res: Response) => {
			res.json({
				access_token: 'stub-access-token',
				token_type: 'Bearer',
				expires_in: 31536000,
				refresh_token: 'stub-refresh-token',
				scope: 'read',
			});
		});
		// ---- конец заглушек MCP OAuth ----

		app.get('/callback', async (req: Request, res: Response) => {
			const code = req.query.code as string | undefined;
			if (!code) {
				res.status(400).send('Missing authorization code');
				return;
			}

			try {
				const tokens = await client.exchangeCodeForTokens(code);
				db.saveTokens(tokens);
				sync.syncDays(90).catch(() => {});
				res.send('Authorization successful! You can close this window.');
			} catch {
				res.status(500).send('Authorization failed. Please try again.');
			}
		});

		app.get('/health', (_req: Request, res: Response) => {
			res.json({ status: 'ok', authenticated: Boolean(db.getTokens()) });
		});

		app.all('/mcp', async (req: Request, res: Response) => {
			const sessionId = req.headers['mcp-session-id'] as string | undefined;

			// DELETE с известной сессией — закрываем явно (transport SDK сам это не делает).
			if (req.method === 'DELETE' && sessionId && transports.has(sessionId)) {
				const session = transports.get(sessionId)!;
				await session.transport.close();
				transports.delete(sessionId);
				res.status(200).send('Session closed');
				return;
			}

			// POST: первый запрос (initialize) создаёт сессию; последующие используют существующую
			// по заголовку Mcp-Session-Id.
			if (req.method === 'POST') {
				// Читаем сырое тело сами, чтобы (1) залогировать его в trace для отладки Claude.ai
				// proxy bug, (2) передать SDK уже распарсенным через параметр parsedBody —
				// иначе SDK сам вызовет getRawBody(req), а после нашего чтения поток уже пуст.
				const chunks: Buffer[] = [];
				for await (const chunk of req) {
					chunks.push(chunk as Buffer);
				}
				const rawBody = Buffer.concat(chunks).toString('utf8');
				let parsedBody: unknown;
				try {
					parsedBody = JSON.parse(rawBody);
				} catch (e) {
					appendFile(
						'/Users/mofas/.pm2/logs/whoop-mcp-mcp-trace.log',
						`[${new Date().toISOString()}] REQUEST PARSE_FAIL ua="${req.headers['user-agent'] ?? '-'}" session=${sessionId ?? '-'} body=${JSON.stringify(rawBody)} err=${(e as Error).message}\n`,
						() => {},
					);
					res.status(400).json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
					return;
				}
				// trace-лог: пишем без блокировки. Тела урезаем до 500 символов, чтобы файл
				// не разрастался — для отладки достаточно увидеть метод, params и начало результата.
				const reqBodyStr = JSON.stringify(parsedBody);
				const reqBodyTrimmed = reqBodyStr.length > 500 ? reqBodyStr.slice(0, 500) + `...[+${reqBodyStr.length - 500}B]` : reqBodyStr;
				appendFile(
					'/Users/mofas/.pm2/logs/whoop-mcp-mcp-trace.log',
					`[${new Date().toISOString()}] REQUEST ua="${req.headers['user-agent'] ?? '-'}" session=${sessionId ?? '-'} ct="${req.headers['content-type'] ?? '-'}" accept="${req.headers.accept ?? '-'}" body=${reqBodyTrimmed}\n`,
					() => {},
				);

				// Извлекаем method/id из тела для корректных ответов на edge-cases.
				const requestMethod =
					typeof parsedBody === 'object' && parsedBody !== null && 'method' in parsedBody
						? (parsedBody as { method?: unknown }).method
						: undefined;
				const requestId =
					typeof parsedBody === 'object' && parsedBody !== null && 'id' in parsedBody
						? (parsedBody as { id?: unknown }).id
						: null;

				let transport: StreamableHTTPServerTransport;

				if (sessionId && transports.has(sessionId)) {
					// Известная сессия — переиспользуем существующий transport.
					const session = transports.get(sessionId)!;
					session.lastAccess = Date.now();
					transport = session.transport;
				} else if (sessionId) {
					// Клиент шлёт session_id, которой у нас нет (типично — после pm2 restart
					// наш Map в памяти обнуляется, но Anthropic-прокси кеширует session_id у себя).
					// По спеке MCP Streamable HTTP клиент в этом случае ДОЛЖЕН переинициализироваться:
					// мы отвечаем 404, клиент шлёт новый initialize → получает новый session_id.
					res.status(404).json({
						jsonrpc: '2.0',
						error: { code: -32001, message: 'Session not found; please re-initialize' },
						id: requestId ?? null,
					});
					return;
				} else if (requestMethod === 'initialize') {
					// Нет сессии и это initialize — нормальный first contact, создаём transport.
					transport = new StreamableHTTPServerTransport({
						sessionIdGenerator: () => crypto.randomUUID(),
						onsessioninitialized: newSessionId => {
							transports.set(newSessionId, { transport, lastAccess: Date.now() });
						},
						// Возвращаем одиночный JSON вместо SSE-стрима. Спека MCP Streamable HTTP
						// разрешает оба варианта, но Anthropic-прокси в Claude.ai на text/event-stream
						// падает с «Invalid content from server». Для наших инструментов streaming
						// не нужен (короткие ответы, без долгих операций), JSON безопаснее.
						enableJsonResponse: true,
					});

					const server = createMcpServer();
					await server.connect(transport);
				} else {
					// Нет сессии и НЕ initialize — клиент идёт мимо протокола, отвечаем 400.
					res.status(400).json({
						jsonrpc: '2.0',
						error: { code: -32600, message: 'Initialize required before other methods' },
						id: requestId ?? null,
					});
					return;
				}

				// Перехват записи ответа — пишем тело в тот же trace-лог.
				// res.write/res.end перегружены в типах Node, поэтому используем any для оборачивания.
				const origEnd = res.end.bind(res);
				const origWrite = res.write.bind(res);
				const respChunks: Buffer[] = [];
				(res.write as unknown) = (chunk: unknown, ...args: unknown[]) => {
					if (chunk) respChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
					return (origWrite as (...a: unknown[]) => unknown)(chunk, ...args);
				};
				(res.end as unknown) = (chunk: unknown, ...args: unknown[]) => {
					if (chunk) respChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
					const respBody = Buffer.concat(respChunks).toString('utf8');
					const respTrimmed = respBody.length > 500 ? respBody.slice(0, 500) + `...[+${respBody.length - 500}B]` : respBody;
					appendFile(
						'/Users/mofas/.pm2/logs/whoop-mcp-mcp-trace.log',
						`[${new Date().toISOString()}] RESPONSE status=${res.statusCode} session=${sessionId ?? '-'} length=${respBody.length} body=${respTrimmed}\n`,
						() => {},
					);
					return (origEnd as (...a: unknown[]) => unknown)(chunk, ...args);
				};

				await transport.handleRequest(req, res, parsedBody);
				return;
			}

			// GET: клиент открывает SSE для серверных уведомлений в рамках существующей сессии.
			// Делегируем тому же transport — он сам стримит события.
			if (req.method === 'GET' && sessionId && transports.has(sessionId)) {
				const session = transports.get(sessionId)!;
				session.lastAccess = Date.now();
				await session.transport.handleRequest(req, res);
				return;
			}

			res.status(405).send('Method not allowed');
		});

		app.get('/sse', (_req: Request, res: Response) => {
			res.status(410).send('SSE endpoint deprecated. Use /mcp with Streamable HTTP transport.');
		});

		const server = app.listen(config.port, '0.0.0.0', () => {
			process.stdout.write(`Whoop MCP server running on http://0.0.0.0:${config.port}\n`);
		});

		const shutdown = (): void => {
			process.stdout.write('\nShutting down...\n');
			for (const [, session] of transports) {
				session.transport.close().catch(() => {});
			}
			transports.clear();
			db.close();
			server.close(() => process.exit(0));
		};

		process.on('SIGTERM', shutdown);
		process.on('SIGINT', shutdown);
	}
}

main().catch(error => {
	process.stderr.write(`Fatal error: ${error}\n`);
	process.exit(1);
});
