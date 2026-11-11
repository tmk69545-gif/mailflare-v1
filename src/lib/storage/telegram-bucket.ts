import type { B2HttpMetadata } from "@/lib/storage/b2-types";
import type { TelegramConfig } from "@/lib/storage/b2-config";

type PutValue = ArrayBuffer | ArrayBufferView | string | ReadableStream | Blob | null;
type PutOptions = { httpMetadata?: B2HttpMetadata | Headers; customMetadata?: Record<string, string> };

async function toBuffer(value: PutValue): Promise<ArrayBuffer> {
	if (value === null) return new ArrayBuffer(0);
	if (typeof value === "string") return new TextEncoder().encode(value).buffer as ArrayBuffer;
	if (value instanceof ArrayBuffer) return value;
	if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
	if (value instanceof Blob) return value.arrayBuffer();
	return new Response(value).arrayBuffer();
}

function parseMetadata(options?: PutOptions): { httpMetadata: B2HttpMetadata; customMetadata: Record<string, string> } {
	const customMetadata: Record<string, string> = { ...(options?.customMetadata ?? {}) };
	const meta = options?.httpMetadata;
	const httpMetadata: B2HttpMetadata = meta instanceof Headers
		? {
				contentType: meta.get("content-type") ?? undefined,
				contentDisposition: meta.get("content-disposition") ?? undefined,
				cacheControl: meta.get("cache-control") ?? undefined,
			}
		: meta ?? {};
	return { httpMetadata, customMetadata };
}

export class TelegramObject {
	readonly size: number;
	readonly etag: string;
	readonly uploaded: Date;
	readonly httpMetadata: B2HttpMetadata;
	readonly customMetadata: Record<string, string>;

	constructor(
		readonly key: string,
		private readonly response: Response,
		size: number,
		uploaded?: Date,
		httpMetadata?: B2HttpMetadata,
		customMetadata?: Record<string, string>,
	) {
		this.size = size;
		this.uploaded = uploaded ?? new Date();
		this.etag = (response.headers.get("etag") ?? `${this.uploaded.getTime()}`).replace(/"/g, "");
		this.httpMetadata = httpMetadata ?? {
			contentType: response.headers.get("content-type") ?? undefined,
			contentDisposition: response.headers.get("content-disposition") ?? undefined,
			cacheControl: response.headers.get("cache-control") ?? undefined,
		};
		this.customMetadata = customMetadata ?? {};
	}

	get httpEtag() { return `"${this.etag}"`; }
	get version() { return this.etag; }
	get body(): ReadableStream<Uint8Array> {
		return (this.response.body ?? new Blob([]).stream()) as ReadableStream<Uint8Array>;
	}
	get bodyUsed() { return this.response.bodyUsed; }
	arrayBuffer() { return this.response.arrayBuffer(); }
	text() { return this.response.text(); }
	json<T>() { return this.response.json() as Promise<T>; }
	blob() { return this.response.blob(); }

	writeHttpMetadata(headers: Headers) {
		if (this.httpMetadata.contentType) headers.set("Content-Type", this.httpMetadata.contentType);
		if (this.httpMetadata.contentDisposition) headers.set("Content-Disposition", this.httpMetadata.contentDisposition);
		if (this.httpMetadata.cacheControl) headers.set("Cache-Control", this.httpMetadata.cacheControl);
	}
}

type StoredMeta = {
	key: string;
	fileId: string;
	messageId?: number;
	size: number;
	mimeType?: string;
	httpMetadata?: B2HttpMetadata;
	customMetadata?: Record<string, string>;
	uploadedAt: number;
};

export class TelegramBucket {
	private readonly memoryCache = new Map<string, StoredMeta>();
	private tableReady = false;

	constructor(
		private readonly config: TelegramConfig,
		private readonly getDb?: () => any,
	) {}

	private async ensureTable(): Promise<void> {
		if (this.tableReady) return;
		const db = this.getDb?.();
		if (!db?.prepare) return;
		try {
			await db.prepare(`
				CREATE TABLE IF NOT EXISTS _telegram_storage (
					key TEXT PRIMARY KEY,
					file_id TEXT NOT NULL,
					message_id INTEGER,
					file_size INTEGER,
					mime_type TEXT,
					http_metadata TEXT,
					custom_metadata TEXT,
					created_at INTEGER
				)
			`).run();
			this.tableReady = true;
		} catch {
			// Memory cache fallback if table creation fails
		}
	}

	async put(key: string, value: PutValue, options?: PutOptions): Promise<TelegramObject> {
		const body = await toBuffer(value);
		const { httpMetadata, customMetadata } = parseMetadata(options);
		const contentType = httpMetadata.contentType || "application/octet-stream";
		const filename = key.split("/").pop() || "file";

		const formData = new FormData();
		formData.set("chat_id", this.config.chatId);
		formData.set("document", new Blob([body], { type: contentType }), filename);
		const caption = key.length > 200 ? key.slice(-200) : key;
		formData.set("caption", caption);

		const apiBase = (this.config.apiRoot ?? "https://api.telegram.org").replace(/\/+$/, "");
		const res = await fetch(`${apiBase}/bot${this.config.botToken}/sendDocument`, {
			method: "POST",
			body: formData,
		});
		const result: any = await res.json();
		if (!result.ok) {
			throw new Error(`Telegram sendDocument failed: ${result.description ?? res.statusText}`);
		}

		const messageId = result.result?.message_id;
		const doc = result.result?.document ?? result.result?.audio ?? result.result?.video ?? result.result?.photo?.slice(-1)[0];
		const fileId = doc?.file_id ?? "";
		const fileSize = doc?.file_size ?? body.byteLength;
		const mimeType = httpMetadata.contentType ?? doc?.mime_type ?? "application/octet-stream";
		const uploadedAt = Date.now();

		const meta: StoredMeta = {
			key,
			fileId,
			messageId,
			size: fileSize,
			mimeType,
			httpMetadata,
			customMetadata,
			uploadedAt,
		};
		this.memoryCache.set(key, meta);

		const db = this.getDb?.();
		if (db?.prepare) {
			try {
				await this.ensureTable();
				const existing = await db.prepare("SELECT file_id FROM _telegram_storage WHERE key = ?").bind(key).first();
				if (existing) {
					await db.prepare(`
						UPDATE _telegram_storage
						SET file_id = ?, message_id = ?, file_size = ?, mime_type = ?, http_metadata = ?, custom_metadata = ?, created_at = ?
						WHERE key = ?
					`).bind(fileId, messageId ?? null, fileSize, mimeType, JSON.stringify(httpMetadata), JSON.stringify(customMetadata), uploadedAt, key).run();
				} else {
					await db.prepare(`
						INSERT INTO _telegram_storage (key, file_id, message_id, file_size, mime_type, http_metadata, custom_metadata, created_at)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					`).bind(key, fileId, messageId ?? null, fileSize, mimeType, JSON.stringify(httpMetadata), JSON.stringify(customMetadata), uploadedAt).run();
				}
			} catch {
				// Memory cache still retains the object
			}
		}

		const response = new Response(body, {
			headers: {
				"Content-Type": mimeType,
				"Content-Length": String(fileSize),
				"Last-Modified": new Date(uploadedAt).toUTCString(),
			},
		});
		return new TelegramObject(key, response, fileSize, new Date(uploadedAt), httpMetadata, customMetadata);
	}

	async get(key: string, options?: { range?: { offset?: number; length?: number; suffix?: number } }): Promise<TelegramObject | null> {
		let meta = this.memoryCache.get(key);
		if (!meta) {
			const db = this.getDb?.();
			if (db?.prepare) {
				try {
					await this.ensureTable();
					const row: any = await db.prepare(`
						SELECT file_id, message_id, file_size, mime_type, http_metadata, custom_metadata, created_at
						FROM _telegram_storage WHERE key = ?
					`).bind(key).first();
					if (row) {
						meta = {
							key,
							fileId: row.file_id,
							messageId: row.message_id,
							size: Number(row.file_size ?? 0),
							mimeType: row.mime_type,
							httpMetadata: row.http_metadata ? JSON.parse(row.http_metadata) : undefined,
							customMetadata: row.custom_metadata ? JSON.parse(row.custom_metadata) : undefined,
							uploadedAt: Number(row.created_at ?? Date.now()),
						};
						this.memoryCache.set(key, meta);
					}
				} catch {
					// Fallback to cache
				}
			}
		}
		if (!meta) return null;

		const apiBase = (this.config.apiRoot ?? "https://api.telegram.org").replace(/\/+$/, "");
		const fileInfoRes = await fetch(`${apiBase}/bot${this.config.botToken}/getFile?file_id=${encodeURIComponent(meta.fileId)}`);
		const fileInfo: any = await fileInfoRes.json();
		if (!fileInfo.ok || !fileInfo.result?.file_path) {
			return null;
		}

		const downloadUrl = `${apiBase}/file/bot${this.config.botToken}/${fileInfo.result.file_path}`;
		const range = options?.range;
		const headers: Record<string, string> = {};
		if (range) {
			if (range.suffix != null) headers.Range = `bytes=-${range.suffix}`;
			else {
				const start = range.offset ?? 0;
				headers.Range = range.length != null ? `bytes=${start}-${start + range.length - 1}` : `bytes=${start}-`;
			}
		}

		const fileRes = await fetch(downloadUrl, { headers });
		if (!fileRes.ok && fileRes.status !== 206) return null;

		return new TelegramObject(key, fileRes, meta.size, new Date(meta.uploadedAt), meta.httpMetadata, meta.customMetadata);
	}

	async head(key: string): Promise<TelegramObject | null> {
		let meta = this.memoryCache.get(key);
		if (!meta) {
			const db = this.getDb?.();
			if (db?.prepare) {
				try {
					await this.ensureTable();
					const row: any = await db.prepare(`
						SELECT file_id, message_id, file_size, mime_type, http_metadata, custom_metadata, created_at
						FROM _telegram_storage WHERE key = ?
					`).bind(key).first();
					if (row) {
						meta = {
							key,
							fileId: row.file_id,
							messageId: row.message_id,
							size: Number(row.file_size ?? 0),
							mimeType: row.mime_type,
							httpMetadata: row.http_metadata ? JSON.parse(row.http_metadata) : undefined,
							customMetadata: row.custom_metadata ? JSON.parse(row.custom_metadata) : undefined,
							uploadedAt: Number(row.created_at ?? Date.now()),
						};
						this.memoryCache.set(key, meta);
					}
				} catch {}
			}
		}
		if (!meta) return null;

		const response = new Response(null, {
			headers: {
				"Content-Type": meta.mimeType || meta.httpMetadata?.contentType || "application/octet-stream",
				"Content-Length": String(meta.size),
				"Last-Modified": new Date(meta.uploadedAt).toUTCString(),
			},
		});
		return new TelegramObject(key, response, meta.size, new Date(meta.uploadedAt), meta.httpMetadata, meta.customMetadata);
	}

	async delete(keys: string | string[]): Promise<void> {
		const list = Array.isArray(keys) ? keys : [keys];
		const apiBase = (this.config.apiRoot ?? "https://api.telegram.org").replace(/\/+$/, "");
		for (const key of list) {
			const meta = this.memoryCache.get(key);
			this.memoryCache.delete(key);
			let messageId = meta?.messageId;
			const db = this.getDb?.();
			if (db?.prepare) {
				try {
					await this.ensureTable();
					if (!messageId) {
						const row: any = await db.prepare("SELECT message_id FROM _telegram_storage WHERE key = ?").bind(key).first();
						messageId = row?.message_id;
					}
					await db.prepare("DELETE FROM _telegram_storage WHERE key = ?").bind(key).run();
				} catch {}
			}
			if (messageId) {
				try {
					await fetch(`${apiBase}/bot${this.config.botToken}/deleteMessage`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ chat_id: this.config.chatId, message_id: messageId }),
					});
				} catch {}
			}
		}
	}

	async list(options: { prefix?: string; cursor?: string; limit?: number } = {}): Promise<{ objects: { key: string; size: number; uploaded: Date }[]; truncated: boolean; cursor?: string }> {
		const limit = Math.min(options.limit ?? 1000, 1000);
		const map = new Map<string, { key: string; size: number; uploaded: Date }>();

		for (const [key, meta] of this.memoryCache.entries()) {
			if (!options.prefix || key.startsWith(options.prefix)) {
				map.set(key, { key, size: meta.size, uploaded: new Date(meta.uploadedAt) });
			}
		}

		const db = this.getDb?.();
		if (db?.prepare) {
			try {
				await this.ensureTable();
				let sql = "SELECT key, file_size, created_at FROM _telegram_storage";
				const params: any[] = [];
				if (options.prefix) {
					sql += " WHERE key LIKE ?";
					params.push(`${options.prefix}%`);
				}
				sql += " ORDER BY key ASC LIMIT ?";
				params.push(limit + 1);
				const res = await db.prepare(sql).bind(...params).all();
				for (const row of res.results ?? []) {
					map.set(row.key, { key: row.key, size: Number(row.file_size ?? 0), uploaded: new Date(Number(row.created_at ?? Date.now())) });
				}
			} catch {}
		}

		let objects = Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key));
		if (options.cursor) {
			const idx = objects.findIndex((o) => o.key > options.cursor!);
			if (idx >= 0) objects = objects.slice(idx);
		}
		const truncated = objects.length > limit;
		if (truncated) objects = objects.slice(0, limit);
		return {
			objects,
			truncated,
			cursor: truncated ? objects[objects.length - 1]?.key : undefined,
		};
	}

	createMultipartUpload(key: string, options?: PutOptions) {
		const parts = new Map<number, Uint8Array>();
		return {
			key,
			uploadId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
			uploadPart: async (partNumber: number, value: PutValue) => {
				const buf = await toBuffer(value);
				parts.set(partNumber, new Uint8Array(buf));
				return { partNumber, etag: `part-${partNumber}` };
			},
			abort: async () => { parts.clear(); },
			complete: async (completedParts: { partNumber: number; etag: string }[]) => {
				const sorted = [...completedParts].sort((a, b) => a.partNumber - b.partNumber);
				const totalLen = sorted.reduce((sum, p) => sum + (parts.get(p.partNumber)?.byteLength ?? 0), 0);
				const combined = new Uint8Array(totalLen);
				let offset = 0;
				for (const p of sorted) {
					const part = parts.get(p.partNumber);
					if (part) {
						combined.set(part, offset);
						offset += part.byteLength;
					}
				}
				return this.put(key, combined, options);
			},
		};
	}

	resumeMultipartUpload(key: string, uploadId: string) {
		return this.createMultipartUpload(key);
	}
}

export function openTelegramBucket(config: TelegramConfig, getDb?: () => any): R2Bucket {
	return new TelegramBucket(config, getDb) as unknown as R2Bucket;
}
