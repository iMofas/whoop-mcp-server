import type {
	WhoopTokens,
	WhoopUser,
	WhoopBodyMeasurement,
	WhoopCycle,
	WhoopRecovery,
	WhoopSleep,
	WhoopWorkout,
	WhoopPaginatedResponse,
} from './types.js';

const WHOOP_API_BASE = 'https://api.prod.whoop.com/developer';
const WHOOP_AUTH_BASE = 'https://api.prod.whoop.com/oauth/oauth2';

interface WhoopClientConfig {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
	onTokenRefresh?: (tokens: WhoopTokens) => void;
}

interface PaginationParams {
	start?: string;
	end?: string;
	limit?: number;
	nextToken?: string;
}

export class WhoopClient {
	private tokens: WhoopTokens | null = null;
	private readonly clientId: string;
	private readonly clientSecret: string;
	private readonly redirectUri: string;
	private readonly onTokenRefresh?: (tokens: WhoopTokens) => void;
	// Single-flight на refresh: если refresh уже идёт — параллельные вызовы ждут его,
	// а не шлют свои запросы с тем же refresh_token. Whoop инвалидирует refresh_token
	// после первого успешного использования, поэтому без этого 2..N одновременных
	// refresh-вызовов всегда заканчиваются 400 «invalid_request» (видно в логах
	// 2026-05-21 04:02 / 05:02 / 07:02 — наш утренний планировщик гонялся с
	// Claude.ai-запросом за один и тот же refresh-токен).
	private refreshInFlight: Promise<void> | null = null;

	constructor(config: WhoopClientConfig) {
		this.clientId = config.clientId;
		this.clientSecret = config.clientSecret;
		this.redirectUri = config.redirectUri;
		this.onTokenRefresh = config.onTokenRefresh;
	}

	setTokens(tokens: WhoopTokens): void {
		// Не перезаписываем уже более свежими in-memory токены устаревшими данными из БД.
		// Окно гонки: refresh завершился → новые токены в `this.tokens` → onTokenRefresh
		// колбэк ещё не успел сохранить в SQLite → параллельный handler читает БД → получает
		// старые токены → вызывает setTokens(старые) → теряем свежие в памяти.
		// Считаем «свежими» по expires_at: больше — новее. При повторной авторизации
		// expires_at всегда смещается далеко в будущее, так что условие сработает.
		if (this.tokens && tokens.expires_at < this.tokens.expires_at) {
			return;
		}
		this.tokens = tokens;
	}

	getAuthorizationUrl(scopes: string[]): string {
		const params = new URLSearchParams({
			client_id: this.clientId,
			redirect_uri: this.redirectUri,
			response_type: 'code',
			scope: scopes.join(' '),
			state: crypto.randomUUID(),
		});
		return `${WHOOP_AUTH_BASE}/auth?${params}`;
	}

	async exchangeCodeForTokens(code: string): Promise<WhoopTokens> {
		const response = await fetch(`${WHOOP_AUTH_BASE}/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				client_id: this.clientId,
				client_secret: this.clientSecret,
				redirect_uri: this.redirectUri,
			}),
		});

		if (!response.ok) {
			throw new Error(`Token exchange failed: ${await response.text()}`);
		}

		const data = await response.json() as { access_token: string; refresh_token: string; expires_in: number };
		const tokens: WhoopTokens = {
			access_token: data.access_token,
			refresh_token: data.refresh_token,
			expires_at: Date.now() + data.expires_in * 1000,
		};

		this.tokens = tokens;
		return tokens;
	}

	private async refreshTokens(): Promise<void> {
		// Если refresh уже выполняется в этом процессе — переиспользуем тот же Promise,
		// не запускаем второй параллельный POST /token. См. комментарий у refreshInFlight.
		if (this.refreshInFlight) {
			return this.refreshInFlight;
		}

		this.refreshInFlight = this.doRefreshTokens();
		try {
			await this.refreshInFlight;
		} finally {
			// Снимаем замок в любом случае (успех или ошибка) — иначе одна неудачная
			// попытка навсегда заблокирует будущие refresh.
			this.refreshInFlight = null;
		}
	}

	private async doRefreshTokens(): Promise<void> {
		if (!this.tokens?.refresh_token) {
			throw new Error('No refresh token available');
		}

		const response = await fetch(`${WHOOP_AUTH_BASE}/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: this.tokens.refresh_token,
				client_id: this.clientId,
				client_secret: this.clientSecret,
			}),
		});

		if (!response.ok) {
			throw new Error(`Token refresh failed: ${await response.text()}`);
		}

		const data = await response.json() as { access_token: string; refresh_token: string; expires_in: number };
		this.tokens = {
			access_token: data.access_token,
			refresh_token: data.refresh_token,
			expires_at: Date.now() + data.expires_in * 1000,
		};

		this.onTokenRefresh?.(this.tokens);
	}

	private async request<T>(path: string, params?: Record<string, string>): Promise<T> {
		if (!this.tokens) {
			throw new Error('Not authenticated');
		}

		// Если до экспайра меньше 5 минут — обновляемся заранее. refreshTokens()
		// сам сериализует параллельные вызовы, так что при Promise.all() из sync.ts
		// четыре одновременных request<T>() приведут только к одному реальному
		// POST /token.
		if (this.tokens.expires_at - Date.now() < 5 * 60 * 1000) {
			await this.refreshTokens();
		}

		const url = new URL(`${WHOOP_API_BASE}${path}`);
		if (params) {
			for (const [key, value] of Object.entries(params)) {
				url.searchParams.set(key, value);
			}
		}

		const response = await fetch(url.toString(), {
			headers: { Authorization: `Bearer ${this.tokens.access_token}` },
		});

		if (!response.ok) {
			throw new Error(`API request failed: ${response.status} ${await response.text()}`);
		}

		return response.json() as Promise<T>;
	}

	async getProfile(): Promise<WhoopUser> {
		return this.request<WhoopUser>('/v2/user/profile/basic');
	}

	async getBodyMeasurement(): Promise<WhoopBodyMeasurement> {
		return this.request<WhoopBodyMeasurement>('/v2/user/measurement/body');
	}

	async getCycles(params?: PaginationParams): Promise<WhoopPaginatedResponse<WhoopCycle>> {
		const queryParams: Record<string, string> = {};
		if (params?.start) queryParams.start = params.start;
		if (params?.end) queryParams.end = params.end;
		if (params?.limit) queryParams.limit = params.limit.toString();
		if (params?.nextToken) queryParams.nextToken = params.nextToken;
		return this.request<WhoopPaginatedResponse<WhoopCycle>>('/v2/cycle', queryParams);
	}

	async getRecoveries(params?: PaginationParams): Promise<WhoopPaginatedResponse<WhoopRecovery>> {
		const queryParams: Record<string, string> = {};
		if (params?.start) queryParams.start = params.start;
		if (params?.end) queryParams.end = params.end;
		if (params?.limit) queryParams.limit = params.limit.toString();
		if (params?.nextToken) queryParams.nextToken = params.nextToken;
		return this.request<WhoopPaginatedResponse<WhoopRecovery>>('/v2/recovery', queryParams);
	}

	async getSleeps(params?: PaginationParams): Promise<WhoopPaginatedResponse<WhoopSleep>> {
		const queryParams: Record<string, string> = {};
		if (params?.start) queryParams.start = params.start;
		if (params?.end) queryParams.end = params.end;
		if (params?.limit) queryParams.limit = params.limit.toString();
		if (params?.nextToken) queryParams.nextToken = params.nextToken;
		return this.request<WhoopPaginatedResponse<WhoopSleep>>('/v2/activity/sleep', queryParams);
	}

	async getWorkouts(params?: PaginationParams): Promise<WhoopPaginatedResponse<WhoopWorkout>> {
		const queryParams: Record<string, string> = {};
		if (params?.start) queryParams.start = params.start;
		if (params?.end) queryParams.end = params.end;
		if (params?.limit) queryParams.limit = params.limit.toString();
		if (params?.nextToken) queryParams.nextToken = params.nextToken;
		return this.request<WhoopPaginatedResponse<WhoopWorkout>>('/v2/activity/workout', queryParams);
	}

	async getAllCycles(params?: { start?: string; end?: string }): Promise<WhoopCycle[]> {
		const results: WhoopCycle[] = [];
		let nextToken: string | undefined;

		do {
			const response = await this.getCycles({ ...params, limit: 25, nextToken });
			results.push(...response.records);
			nextToken = response.next_token;
		} while (nextToken);

		return results;
	}

	async getAllRecoveries(params?: { start?: string; end?: string }): Promise<WhoopRecovery[]> {
		const results: WhoopRecovery[] = [];
		let nextToken: string | undefined;

		do {
			const response = await this.getRecoveries({ ...params, limit: 25, nextToken });
			results.push(...response.records);
			nextToken = response.next_token;
		} while (nextToken);

		return results;
	}

	async getAllSleeps(params?: { start?: string; end?: string }): Promise<WhoopSleep[]> {
		const results: WhoopSleep[] = [];
		let nextToken: string | undefined;

		do {
			const response = await this.getSleeps({ ...params, limit: 25, nextToken });
			results.push(...response.records);
			nextToken = response.next_token;
		} while (nextToken);

		return results;
	}

	async getAllWorkouts(params?: { start?: string; end?: string }): Promise<WhoopWorkout[]> {
		const results: WhoopWorkout[] = [];
		let nextToken: string | undefined;

		do {
			const response = await this.getWorkouts({ ...params, limit: 25, nextToken });
			results.push(...response.records);
			nextToken = response.next_token;
		} while (nextToken);

		return results;
	}
}
