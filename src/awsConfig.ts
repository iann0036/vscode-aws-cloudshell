import { loadSharedConfigFiles } from '@smithy/shared-ini-file-loader';

// Merges and de-duplicates profile names found across the shared AWS `config`
// and `credentials` files. Pure (no I/O) so it can be unit-tested.
export function mergeProfileNames(files: { configFile?: { [key: string]: any }, credentialsFile?: { [key: string]: any } }): string[] {
	const names = new Set<string>();
	Object.keys(files.configFile || {}).forEach(n => names.add(n));
	Object.keys(files.credentialsFile || {}).forEach(n => names.add(n));
	return Array.from(names).sort();
}

// Lists the AWS CLI profiles configured on this machine (from ~/.aws/config and
// ~/.aws/credentials, honoring AWS_CONFIG_FILE / AWS_SHARED_CREDENTIALS_FILE).
// Returns an empty array if the files are missing or unreadable.
export async function listProfiles(): Promise<string[]> {
	try {
		const files = await loadSharedConfigFiles();
		return mergeProfileNames(files);
	} catch (err) {
		return [];
	}
}

// Returns the `region` configured for the given profile (from the shared config
// file), or undefined if not set / unreadable.
export async function getProfileRegion(profile: string): Promise<string | undefined> {
	try {
		const files = await loadSharedConfigFiles();
		const entry = (files.configFile && files.configFile[profile]) || (files.credentialsFile && files.credentialsFile[profile]);
		return entry && entry.region ? entry.region : undefined;
	} catch (err) {
		return undefined;
	}
}
