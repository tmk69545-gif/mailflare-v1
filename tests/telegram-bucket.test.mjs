import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-telegram-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

async function bundle(entry, outfile) {
	await build({
		entryPoints: [join(root, entry)],
		outfile: join(outDir, outfile),
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
		alias: { "@": join(root, "src") },
	});
	return import(pathToFileURL(join(outDir, outfile)).href);
}

const { getTelegramConfig, describeB2Problem, getStorageStatus } = await bundle("src/lib/storage/b2-config.ts", "config.mjs");
const { TelegramBucket, openTelegramBucket } = await bundle("src/lib/storage/telegram-bucket.ts", "telegram-bucket.mjs");
const { withStorage } = await bundle("src/lib/storage/index.ts", "index.mjs");

test("getTelegramConfig detects bot token and chat id", () => {
	assert.equal(getTelegramConfig({}), null);
	assert.equal(getTelegramConfig({ TELEGRAM_BOT_TOKEN: "tok" }), null);
	assert.equal(getTelegramConfig({ TELEGRAM_CHAT_ID: "-1001" }), null);

	const config = getTelegramConfig({ TELEGRAM_BOT_TOKEN: "123:ABC", TELEGRAM_CHAT_ID: "-100123" });
	assert.deepEqual(config, {
		botToken: "123:ABC",
		chatId: "-100123",
		apiRoot: "https://api.telegram.org",
	});

	const custom = getTelegramConfig({
		TELEGRAM_STORAGE_TOKEN: "456:DEF",
		TELEGRAM_STORAGE_CHAT_ID: "@my_channel",
		TELEGRAM_API_ROOT: "http://localhost:8081/",
	});
	assert.deepEqual(custom, {
		botToken: "456:DEF",
		chatId: "@my_channel",
		apiRoot: "http://localhost:8081",
	});

	assert.equal(describeB2Problem({ TELEGRAM_BOT_TOKEN: "123:ABC", TELEGRAM_CHAT_ID: "-100123" }), null);
	assert.match(describeB2Problem({ TELEGRAM_BOT_TOKEN: "123:ABC" }), /Telegram storage/);
	assert.equal(getStorageStatus({ TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHAT_ID: "chat" }).provider, "telegram");
});

test("withStorage swaps BUCKET when Telegram is configured", () => {
	const plain = { BUCKET: "r2", DB: "d1" };
	assert.equal(withStorage(plain), plain);

	const configured = { BUCKET: "r2", DB: "d1", TELEGRAM_BOT_TOKEN: "tok", TELEGRAM_CHAT_ID: "chat" };
	const env = withStorage(configured);
	assert.equal(env.DB, "d1");
	assert.notEqual(env.BUCKET, "r2");
	assert.equal(withStorage(env), env);
});

test("TelegramBucket stores, retrieves, ranges, deletes and lists objects", async () => {
	const storedFiles = new Map();
	let nextMessageId = 100;
	let nextFileId = 1;

	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const body = Buffer.concat(chunks);
		const url = new URL(req.url, "http://x");

		const sendJson = (status, data) => {
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end(JSON.stringify(data));
		};

		if (req.method === "POST" && url.pathname.includes("/sendDocument")) {
			const fileId = `file_${nextFileId++}`;
			const messageId = nextMessageId++;
			const filePath = `documents/${fileId}.bin`;

			// Extract boundary
			const contentType = req.headers["content-type"] || "";
			const boundaryMatch = /boundary=(.+)$/.exec(contentType);
			let fileData = body;
			if (boundaryMatch) {
				const boundary = boundaryMatch[1];
				// Simple boundary extraction for testing
				const parts = body.toString("binary").split(`--${boundary}`);
				for (const part of parts) {
					if (part.includes('filename="')) {
						const headerEnd = part.indexOf("\r\n\r\n");
						if (headerEnd !== -1) {
							const content = part.slice(headerEnd + 4, part.lastIndexOf("\r\n"));
							fileData = Buffer.from(content, "binary");
						}
					}
				}
			}

			storedFiles.set(fileId, { fileData, filePath, messageId });

			return sendJson(200, {
				ok: true,
				result: {
					message_id: messageId,
					document: {
						file_id: fileId,
						file_size: fileData.length,
						mime_type: "text/plain",
						file_name: "test.txt",
					},
				},
			});
		}

		if (req.method === "GET" && url.pathname.includes("/getFile")) {
			const fileId = url.searchParams.get("file_id");
			const stored = storedFiles.get(fileId);
			if (!stored) {
				return sendJson(404, { ok: false, description: "File not found" });
			}
			return sendJson(200, {
				ok: true,
				result: {
					file_id: fileId,
					file_path: stored.filePath,
					file_size: stored.fileData.length,
				},
			});
		}

		if (req.method === "GET" && url.pathname.includes("/file/bot")) {
			const subPath = url.pathname.split("/file/bot123/")[1];
			let found = null;
			for (const item of storedFiles.values()) {
				if (item.filePath === subPath) found = item;
			}
			if (!found) {
				res.writeHead(404);
				return res.end("Not found");
			}

			const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? "");
			if (range) {
				const start = Number(range[1]);
				const end = Number(range[2]);
				res.writeHead(206, {
					"Content-Type": "application/octet-stream",
					"Content-Range": `bytes ${start}-${end}/${found.fileData.length}`,
				});
				return res.end(found.fileData.subarray(start, end + 1));
			}

			res.writeHead(200, {
				"Content-Type": "application/octet-stream",
				"Content-Length": String(found.fileData.length),
			});
			return res.end(found.fileData);
		}

		if (req.method === "POST" && url.pathname.includes("/deleteMessage")) {
			return sendJson(200, { ok: true, result: true });
		}

		res.writeHead(404);
		res.end("Not found");
	});

	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	const port = server.address().port;
	const apiRoot = `http://127.0.0.1:${port}`;

	try {
		const bucket = openTelegramBucket({
			botToken: "123",
			chatId: "-100",
			apiRoot,
		});

		// 1. Put
		const put = await bucket.put("test/doc.txt", "hello telegram", {
			httpMetadata: { contentType: "text/plain" },
			customMetadata: { author: "alice" },
		});
		assert.equal(put.key, "test/doc.txt");
		assert.equal(put.size, 14);
		assert.equal(put.httpMetadata.contentType, "text/plain");
		assert.equal(put.customMetadata.author, "alice");

		// 2. Get
		const got = await bucket.get("test/doc.txt");
		assert.notEqual(got, null);
		assert.equal(await got.text(), "hello telegram");
		assert.equal(got.size, 14);

		// 3. Range Get
		const ranged = await bucket.get("test/doc.txt", { range: { offset: 6, length: 8 } });
		assert.notEqual(ranged, null);
		assert.equal(await ranged.text(), "telegram");

		// 4. Head
		const head = await bucket.head("test/doc.txt");
		assert.notEqual(head, null);
		assert.equal(head.size, 14);

		// 5. List
		const listed = await bucket.list({ prefix: "test/" });
		assert.equal(listed.objects.length, 1);
		assert.equal(listed.objects[0].key, "test/doc.txt");

		// 6. Multipart upload
		const multipart = await bucket.createMultipartUpload("big/part.bin");
		const p1 = await multipart.uploadPart(1, new Uint8Array([1, 2, 3]));
		const p2 = await multipart.uploadPart(2, new Uint8Array([4, 5]));
		assert.equal(p1.etag, "part-1");
		const completed = await multipart.complete([p1, p2]);
		assert.equal(completed.size, 5);
		const readMulti = await bucket.get("big/part.bin");
		assert.deepEqual([...new Uint8Array(await readMulti.arrayBuffer())], [1, 2, 3, 4, 5]);

		// 7. Delete
		await bucket.delete("test/doc.txt");
		assert.equal(await bucket.get("test/doc.txt"), null);
		assert.equal(await bucket.head("test/doc.txt"), null);
	} finally {
		server.close();
	}
});
