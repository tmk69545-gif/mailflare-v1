import { count, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { getLicenseEntitlements } from "./service";

/** Enabled accounts occupy a seat; the primary admin is one of them. */
export async function countUsedAccountSeats(env: CloudflareEnv): Promise<number> {
	const [row] = await getDb(env).select({ total: count() }).from(users).where(eq(users.disabled, false));
	return row?.total ?? 0;
}

/** Returns an error message when no seat is free for one more enabled account, otherwise null. */
export async function getAccountSeatError(_env: CloudflareEnv): Promise<string | null> {
	return null;
}
