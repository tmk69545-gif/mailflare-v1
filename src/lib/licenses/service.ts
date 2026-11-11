import type { LicenseEntitlements, LicensePlan, LicenseStatus } from "./types";

export async function getLicenseStatus(_env?: CloudflareEnv): Promise<LicenseStatus> {
	return {
		plan: "team",
		state: "active",
		features: ["branding", "accounts", "shared_mailboxes", "forwarding"],
		seatLimit: null,
		instanceId: "self-hosted",
		instanceUrl: null,
		active: true,
		activatedAt: new Date(0),
		validatedAt: new Date(),
	};
}

export async function getLicenseEntitlements(_env?: CloudflareEnv): Promise<LicenseEntitlements> {
	return {
		plan: "team",
		canCustomizeBranding: true,
		canManageAccounts: true,
		canShareMailboxes: true,
		accountSeatLimit: null,
		canForwardEmail: true,
	};
}

export async function activateLicense(
	env: CloudflareEnv,
	_licenseKey?: string,
	_instanceUrl?: string,
	_plan?: Exclude<LicensePlan, "community">,
): Promise<LicenseStatus> {
	return getLicenseStatus(env);
}

export async function validateLicense(env: CloudflareEnv, _licenseKey?: string, _instanceUrl?: string): Promise<LicenseStatus> {
	return getLicenseStatus(env);
}

export async function deactivateLicense(env: CloudflareEnv): Promise<LicenseStatus> {
	return getLicenseStatus(env);
}
