import * as assert from 'assert';
import axios from 'axios';

import {
	decideEnvAction,
	describeEnvironments,
	describeEnvironmentsWithStatus,
	waitForRunning,
	ENVIRONMENT_NAME,
	CsEnvironment,
	CsStatus
} from '../cloudShellClient';

const CREDS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', sessionToken: 'token' };

function env(id: string, status?: CsStatus, name?: string): CsEnvironment {
	return { EnvironmentId: id, Status: status, EnvironmentName: name };
}

describe('decideEnvAction', () => {
	it('creates when there are no environments', () => {
		assert.strictEqual(decideEnvAction([]).kind, 'create');
	});

	it('creates when the only environment is DELETED', () => {
		assert.strictEqual(decideEnvAction([env('a', 'DELETED')]).kind, 'create');
	});

	it('blocks when an environment is being deleted', () => {
		const action = decideEnvAction([env('a', 'DELETING')]);
		assert.strictEqual(action.kind, 'blocked');
	});

	it('reuses a RUNNING environment', () => {
		const action = decideEnvAction([env('a', 'RUNNING')]);
		assert.strictEqual(action.kind, 'reuse');
		assert.strictEqual((action as any).env.EnvironmentId, 'a');
	});

	it('resumes a SUSPENDED environment', () => {
		assert.strictEqual(decideEnvAction([env('a', 'SUSPENDED')]).kind, 'resume');
		assert.strictEqual(decideEnvAction([env('a', 'SUSPENDING')]).kind, 'resume');
	});

	it('waits on a transitioning environment', () => {
		assert.strictEqual(decideEnvAction([env('a', 'CREATING')]).kind, 'wait');
		assert.strictEqual(decideEnvAction([env('a', 'RESUMING')]).kind, 'wait');
	});

	it('prefers the extension-named environment when multiple exist', () => {
		const action = decideEnvAction([
			env('other', 'RUNNING', 'something-else'),
			env('mine', 'RUNNING', ENVIRONMENT_NAME)
		]);
		assert.strictEqual((action as any).env.EnvironmentId, 'mine');
	});

	it('ignores DELETED entries when picking a live environment', () => {
		const action = decideEnvAction([env('dead', 'DELETED'), env('live', 'RUNNING')]);
		assert.strictEqual(action.kind, 'reuse');
		assert.strictEqual((action as any).env.EnvironmentId, 'live');
	});
});

describe('describeEnvironments response coercion', () => {
	let originalPost: any;

	beforeEach(() => {
		originalPost = (axios as any).post;
	});

	afterEach(() => {
		(axios as any).post = originalPost;
	});

	function stubResponse(data: any) {
		(axios as any).post = async () => ({ data });
	}

	it('returns a top-level array as-is', async () => {
		stubResponse([{ EnvironmentId: 'a' }, { EnvironmentId: 'b' }]);
		const envs = await describeEnvironments('us-east-1', CREDS);
		assert.strictEqual(envs.length, 2);
	});

	it('unwraps an { Environments: [...] } shape', async () => {
		stubResponse({ Environments: [{ EnvironmentId: 'a' }] });
		const envs = await describeEnvironments('us-east-1', CREDS);
		assert.strictEqual(envs.length, 1);
		assert.strictEqual(envs[0].EnvironmentId, 'a');
	});

	it('wraps a single environment object', async () => {
		stubResponse({ EnvironmentId: 'solo', Status: 'RUNNING' });
		const envs = await describeEnvironments('us-east-1', CREDS);
		assert.strictEqual(envs.length, 1);
		assert.strictEqual(envs[0].EnvironmentId, 'solo');
	});

	it('returns an empty array for an unrecognized shape', async () => {
		stubResponse({ unexpected: true });
		const envs = await describeEnvironments('us-east-1', CREDS);
		assert.deepStrictEqual(envs, []);
	});
});

describe('describeEnvironmentsWithStatus', () => {
	let originalPost: any;

	beforeEach(() => { originalPost = (axios as any).post; });
	afterEach(() => { (axios as any).post = originalPost; });

	it('enriches each environment with its real status, marking unresolvable ones DELETED', async () => {
		// Mirrors the real API: describeEnvironments returns only EnvironmentId,
		// and a lingering (deleted) environment fails getEnvironmentStatus.
		(axios as any).post = async (url: string, body: string) => {
			if (url.indexOf('/describeEnvironments') !== -1) {
				return { data: { Environments: [{ EnvironmentId: 'e1' }, { EnvironmentId: 'gone' }] } };
			}
			if (url.indexOf('/getEnvironmentStatus') !== -1) {
				const parsed = JSON.parse(body);
				if (parsed.EnvironmentId === 'e1') {
					return { data: { EnvironmentId: 'e1', Status: 'RUNNING' } };
				}
				const notFound: any = new Error('not found');
				notFound.response = { status: 404, data: {} };
				throw notFound;
			}
			throw new Error('unexpected path: ' + url);
		};

		const envs = await describeEnvironmentsWithStatus('us-east-1', CREDS);
		assert.strictEqual(envs.length, 2);
		const e1 = envs.find(e => e.EnvironmentId === 'e1')!;
		const gone = envs.find(e => e.EnvironmentId === 'gone')!;
		assert.strictEqual(e1.Status, 'RUNNING');
		assert.strictEqual(gone.Status, 'DELETED');

		// And decideEnvAction reuses the live one, ignoring the lingering deleted entry.
		const action = decideEnvAction(envs);
		assert.strictEqual(action.kind, 'reuse');
		assert.strictEqual((action as any).env.EnvironmentId, 'e1');
	});
});

describe('waitForRunning', () => {
	it('returns immediately when already RUNNING', async () => {
		let getCalls = 0;
		const result = await waitForRunning('us-east-1', CREDS, 'env-1', 'RUNNING', {
			intervalMs: 1,
			getStatus: async () => { getCalls++; return env('env-1', 'RUNNING'); },
			start: async () => env('env-1')
		});
		assert.strictEqual(result.Status, 'RUNNING');
		assert.strictEqual(getCalls, 0);
	});

	it('starts a SUSPENDED environment exactly once, then connects', async () => {
		let startCalls = 0;
		const statuses: CsStatus[] = ['SUSPENDED', 'RUNNING'];
		let i = 0;
		const result = await waitForRunning('us-east-1', CREDS, 'env-1', 'SUSPENDED', {
			intervalMs: 1,
			start: async () => { startCalls++; return env('env-1'); },
			getStatus: async () => env('env-1', statuses[Math.min(i++, statuses.length - 1)])
		});
		assert.strictEqual(result.Status, 'RUNNING');
		assert.strictEqual(startCalls, 1);
	});

	it('waits through CREATING until RUNNING', async () => {
		const statuses: CsStatus[] = ['CREATING', 'CREATING', 'RUNNING'];
		let i = 0;
		let startCalls = 0;
		const result = await waitForRunning('us-east-1', CREDS, 'env-1', 'CREATING', {
			intervalMs: 1,
			start: async () => { startCalls++; return env('env-1'); },
			getStatus: async () => env('env-1', statuses[Math.min(i++, statuses.length - 1)])
		});
		assert.strictEqual(result.Status, 'RUNNING');
		assert.strictEqual(startCalls, 0);
	});

	it('throws when the environment is being deleted', async () => {
		await assert.rejects(
			waitForRunning('us-east-1', CREDS, 'env-1', 'DELETING', {
				intervalMs: 1,
				getStatus: async () => env('env-1', 'DELETING'),
				start: async () => env('env-1')
			}),
			/deleting/i
		);
	});

	it('times out when the environment never becomes RUNNING', async () => {
		await assert.rejects(
			waitForRunning('us-east-1', CREDS, 'env-1', 'CREATING', {
				timeoutMs: 30,
				intervalMs: 5,
				getStatus: async () => env('env-1', 'CREATING'),
				start: async () => env('env-1')
			}),
			/timed out/i
		);
	});

	it('throws when cancellation is requested', async () => {
		await assert.rejects(
			waitForRunning('us-east-1', CREDS, 'env-1', 'CREATING', {
				intervalMs: 1,
				token: { isCancellationRequested: true },
				getStatus: async () => env('env-1', 'CREATING'),
				start: async () => env('env-1')
			}),
			/cancelled/i
		);
	});
});
