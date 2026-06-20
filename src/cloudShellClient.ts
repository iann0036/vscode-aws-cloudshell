import axios from 'axios';
import * as aws4 from 'aws4';

// AWS CloudShell environment lifecycle statuses (unofficial API).
export type CsStatus =
	| "CREATING"
	| "RUNNING"
	| "SUSPENDED"
	| "SUSPENDING"
	| "RESUMING"
	| "DELETING"
	| "DELETED";

// Credentials handed to aws4.sign for CloudShell API requests. In practice this
// is the raw response from the CloudShell console `tb/creds` endpoint, whose
// exact field set is provider-defined — hence the open index signature.
export interface CsCreds {
	accessKeyId?: string;
	secretAccessKey?: string;
	sessionToken?: string;
	[key: string]: any;
}

export interface CsVpcConfig {
	VpcId: string;
	SecurityGroupIds: string[];
	SubnetIds: string[];
}

export interface CsEnvironment {
	EnvironmentId: string;
	Status?: CsStatus;
	EnvironmentName?: string;
	VpcConfig?: CsVpcConfig;
	StatusReason?: string;
}

// Structural subset of vscode.CancellationToken so this module stays vscode-free.
export interface CancellationLike {
	readonly isCancellationRequested: boolean;
}

// The well-known environment name this extension uses when creating environments.
export const ENVIRONMENT_NAME = "vscode-aws-cloudshell";

const STATUS_SUSPENDED: CsStatus[] = ["SUSPENDED", "SUSPENDING"];
const STATUS_TRANSITIONING: CsStatus[] = ["CREATING", "RESUMING"];
const STATUS_GONE: CsStatus[] = ["DELETING", "DELETED"];

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// Low-level SigV4-signed POST to the CloudShell JSON API. Mirrors the exact
// request shape the extension has always used (aws4.sign + axios.post).
async function csPost<T>(region: string, creds: CsCreds, path: string, body: object): Promise<T> {
	const awsreq = aws4.sign({
		service: 'cloudshell',
		region: region,
		method: 'POST',
		path: path,
		headers: {},
		body: JSON.stringify(body)
	}, creds);

	try {
		const response = await axios.post("https://" + awsreq.hostname + awsreq.path, awsreq.body, {
			headers: awsreq.headers
		});
		return response.data as T;
	} catch (err: any) {
		const status = err && err.response && err.response.status;
		const body = err && err.response && err.response.data;
		const detail = body ? (typeof body === "string" ? body : JSON.stringify(body)) : (err && err.message);
		throw new Error("CloudShell " + path + " failed" + (status ? " (" + status + ")" : "") + ": " + detail);
	}
}

// Lists existing CloudShell environments for the account/region.
// NOTE: unofficial API. The response shape is coerced defensively because it
// has been observed both as an array and (in some docs) as a single object.
export async function describeEnvironments(region: string, creds: CsCreds): Promise<CsEnvironment[]> {
	const data = await csPost<any>(region, creds, '/describeEnvironments', {});

	if (Array.isArray(data)) {
		return data as CsEnvironment[];
	}
	if (data && Array.isArray(data.Environments)) {
		return data.Environments as CsEnvironment[];
	}
	if (data && typeof data.EnvironmentId === "string") {
		return [data as CsEnvironment];
	}
	return [];
}

// describeEnvironments only reliably returns EnvironmentId (no Status / name /
// VpcConfig), and a deleted environment can linger in the list. This enriches
// each entry with a getEnvironmentStatus call so callers get real statuses, and
// marks any environment that can no longer be resolved as DELETED so it is
// treated as gone rather than blocking new sessions.
export async function describeEnvironmentsWithStatus(region: string, creds: CsCreds): Promise<CsEnvironment[]> {
	const envs = await describeEnvironments(region, creds);
	return Promise.all(envs.map(async (e) => {
		try {
			const s = await getEnvironmentStatus(region, creds, e.EnvironmentId);
			return {
				EnvironmentId: e.EnvironmentId,
				Status: s.Status,
				EnvironmentName: s.EnvironmentName !== undefined ? s.EnvironmentName : e.EnvironmentName,
				VpcConfig: s.VpcConfig !== undefined ? s.VpcConfig : e.VpcConfig,
				StatusReason: s.StatusReason
			} as CsEnvironment;
		} catch (err) {
			return { EnvironmentId: e.EnvironmentId, Status: "DELETED" } as CsEnvironment;
		}
	}));
}

export async function createEnvironment(region: string, creds: CsCreds, vpcConfig?: CsVpcConfig): Promise<CsEnvironment> {
	const body: any = {};
	if (vpcConfig) {
		body.EnvironmentName = ENVIRONMENT_NAME;
		body.VpcConfig = vpcConfig;
	}
	return csPost<CsEnvironment>(region, creds, '/createEnvironment', body);
}

export async function getEnvironmentStatus(region: string, creds: CsCreds, environmentId: string): Promise<CsEnvironment> {
	return csPost<CsEnvironment>(region, creds, '/getEnvironmentStatus', { EnvironmentId: environmentId });
}

export async function startEnvironment(region: string, creds: CsCreds, environmentId: string): Promise<CsEnvironment> {
	return csPost<CsEnvironment>(region, creds, '/startEnvironment', { EnvironmentId: environmentId });
}

// Creates a CloudShell session for a RUNNING environment. The returned payload
// is handed verbatim to the session-manager-plugin.
export async function createCloudShellSession(region: string, creds: CsCreds, environmentId: string): Promise<any> {
	return csPost<any>(region, creds, '/createSession', { EnvironmentId: environmentId });
}

// Permanently deletes a CloudShell environment and its persistent storage.
export async function deleteEnvironment(region: string, creds: CsCreds, environmentId: string): Promise<void> {
	await csPost<any>(region, creds, '/deleteEnvironment', { EnvironmentId: environmentId });
}

export type EnvAction =
	| { kind: "reuse"; env: CsEnvironment }
	| { kind: "resume"; env: CsEnvironment }
	| { kind: "wait"; env: CsEnvironment }
	| { kind: "create" }
	| { kind: "blocked"; env: CsEnvironment };

// Picks the relevant environment from a describeEnvironments result and decides
// how to reach a connectable (RUNNING) state without ever creating a duplicate.
export function decideEnvAction(envs: CsEnvironment[]): EnvAction {
	const live = (envs || []).filter(e => e && e.EnvironmentId && !STATUS_GONE.includes(e.Status as CsStatus));

	// A DELETING environment blocks creation until it finishes going away.
	const deleting = (envs || []).find(e => e && e.Status === "DELETING");

	if (live.length === 0) {
		return deleting ? { kind: "blocked", env: deleting } : { kind: "create" };
	}

	if (live.length > 1) {
		console.warn(`AWS CloudShell: ${live.length} environments found; picking deterministically.`);
	}

	// Prefer the environment this extension creates, else the first live one.
	const env = live.find(e => e.EnvironmentName === ENVIRONMENT_NAME) || live[0];

	if (env.Status === "RUNNING") {
		return { kind: "reuse", env };
	}
	if (STATUS_SUSPENDED.includes(env.Status as CsStatus)) {
		return { kind: "resume", env };
	}
	if (STATUS_TRANSITIONING.includes(env.Status as CsStatus)) {
		return { kind: "wait", env };
	}
	// Unknown status: treat as something to poll on rather than create over.
	return { kind: "wait", env };
}

export interface PollOptions {
	timeoutMs?: number;
	intervalMs?: number;
	token?: CancellationLike;
	// Injectable status fetcher for testing; defaults to getEnvironmentStatus.
	getStatus?: (region: string, creds: CsCreds, environmentId: string) => Promise<CsEnvironment>;
	// Injectable starter for testing; defaults to startEnvironment.
	start?: (region: string, creds: CsCreds, environmentId: string) => Promise<CsEnvironment>;
}

// Drives an environment to RUNNING: starts it if SUSPENDED, waits through
// CREATING/RESUMING, throws on DELETING/DELETED, on timeout, or on cancellation.
// Transient errors are retried within the timeout window (never infinitely).
export async function waitForRunning(
	region: string,
	creds: CsCreds,
	environmentId: string,
	initialStatus: CsStatus | undefined,
	opts: PollOptions = {}
): Promise<CsEnvironment> {
	const timeoutMs = opts.timeoutMs ?? 180000;
	const intervalMs = opts.intervalMs ?? 2000;
	const getStatus = opts.getStatus ?? getEnvironmentStatus;
	const start = opts.start ?? startEnvironment;
	const deadline = Date.now() + timeoutMs;

	let status: CsStatus | undefined = initialStatus;
	let startIssued = false;

	while (true) {
		if (opts.token && opts.token.isCancellationRequested) {
			throw new Error("AWS CloudShell connection cancelled.");
		}

		if (status === "RUNNING") {
			return { EnvironmentId: environmentId, Status: status };
		}

		if (status && STATUS_GONE.includes(status)) {
			throw new Error(`AWS CloudShell environment is ${status.toLowerCase()}; cannot connect.`);
		}

		if (status && STATUS_SUSPENDED.includes(status)) {
			if (!startIssued) {
				try {
					await start(region, creds, environmentId);
					startIssued = true;
				} catch (err) {
					// Transient start failure: fall through to retry on next tick.
				}
			}
		} else {
			// Left the suspended family; allow a fresh start if it suspends again.
			startIssued = false;
		}

		if (Date.now() >= deadline) {
			throw new Error("Timed out waiting for AWS CloudShell environment to become available.");
		}

		await delay(intervalMs);

		try {
			const env = await getStatus(region, creds, environmentId);
			status = env.Status;
		} catch (err) {
			// Transient status failure: keep status as-is and retry until deadline.
		}
	}
}
