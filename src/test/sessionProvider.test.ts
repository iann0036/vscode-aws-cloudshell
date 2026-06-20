import * as assert from 'assert';

import { SessionProvider, Session } from '../viewProviders';

function fakeTerminal(processId: number): any {
	return { processId, exitStatus: undefined };
}

describe('SessionProvider', () => {
	it('adoptOrCreate reuses an existing row for the same environment id', () => {
		const provider = new SessionProvider();
		const first = provider.addSession('us-east-1');
		first.setEnvironmentId('env-abc');

		const adopted = provider.adoptOrCreate('us-east-1', 'env-abc');
		assert.strictEqual(adopted, first);
		assert.strictEqual(provider.sessions.length, 1);
	});

	it('adoptOrCreate creates a new row when the environment is unknown', () => {
		const provider = new SessionProvider();
		provider.adoptOrCreate('us-east-1', 'env-1');
		provider.adoptOrCreate('us-east-1', 'env-2');
		assert.strictEqual(provider.sessions.length, 2);
	});

	it('findByEnvironmentId locates the right session', () => {
		const provider = new SessionProvider();
		const s = provider.addSession('eu-west-1');
		s.setEnvironmentId('env-xyz');
		assert.strictEqual(provider.findByEnvironmentId('env-xyz'), s);
		assert.strictEqual(provider.findByEnvironmentId('missing'), undefined);
	});

	it('reconcile adds discovered environments without duplicating', () => {
		const provider = new SessionProvider();
		provider.reconcile('us-east-1', [
			{ EnvironmentId: 'env-1', Status: 'RUNNING' },
			{ EnvironmentId: 'env-2', Status: 'SUSPENDED' }
		]);
		assert.strictEqual(provider.sessions.length, 2);

		// Re-running discovery must not create duplicates.
		provider.reconcile('us-east-1', [
			{ EnvironmentId: 'env-1', Status: 'RUNNING' },
			{ EnvironmentId: 'env-2', Status: 'SUSPENDED' }
		]);
		assert.strictEqual(provider.sessions.length, 2);
	});

	it('reconcile skips environments that are going away', () => {
		const provider = new SessionProvider();
		provider.reconcile('us-east-1', [
			{ EnvironmentId: 'gone', Status: 'DELETING' },
			{ EnvironmentId: 'dead', Status: 'DELETED' }
		]);
		assert.strictEqual(provider.sessions.length, 0);
	});

	it('remove deletes a specific session instance', () => {
		const provider = new SessionProvider();
		const a = provider.addSession('us-east-1');
		a.setEnvironmentId('a');
		const b = provider.addSession('us-east-1');
		b.setEnvironmentId('b');

		provider.remove(a);

		assert.strictEqual(provider.sessions.length, 1);
		assert.strictEqual(provider.sessions[0].environmentId, 'b');
	});

	it('onTerminalDisposed reverts an environment-backed session to available', () => {
		const provider = new SessionProvider();
		const a = provider.addSession('us-east-1');
		a.setEnvironmentId('a');
		a.setTerminal(fakeTerminal(100));
		const b = provider.addSession('us-east-1');
		b.setEnvironmentId('b');
		b.setTerminal(fakeTerminal(200));

		provider.onTerminalDisposed(fakeTerminal(100));

		// Both stay listed (environments still exist); 'a' reverts to available.
		assert.strictEqual(provider.sessions.length, 2);
		assert.ok(provider.sessions.every((s: Session) => s !== undefined));
		const reverted = provider.findByEnvironmentId('a')!;
		assert.strictEqual(reverted.state, 'DISCOVERED');
		assert.strictEqual(reverted.terminal, undefined);
		assert.ok(provider.findByEnvironmentId('b')!.terminal, 'b keeps its terminal');
	});

	it('onTerminalDisposed avoids duplicate available rows for the same environment', () => {
		const provider = new SessionProvider();
		// Two shells against the same environment.
		const a = provider.addSession('eu-west-1');
		a.setEnvironmentId('env');
		a.setTerminal(fakeTerminal(1));
		const b = provider.addSession('eu-west-1');
		b.setEnvironmentId('env');
		b.setTerminal(fakeTerminal(2));

		// Closing the first shell reverts its row to available.
		provider.onTerminalDisposed(fakeTerminal(1));
		assert.strictEqual(provider.sessions.length, 2);

		// Closing the second shell removes it, since an available row already exists.
		provider.onTerminalDisposed(fakeTerminal(2));
		assert.strictEqual(provider.sessions.length, 1);
		assert.strictEqual(provider.sessions[0].environmentId, 'env');
		assert.strictEqual(provider.sessions[0].terminal, undefined);
	});

	it('onTerminalDisposed removes a session that has no environment', () => {
		const provider = new SessionProvider();
		const a = provider.addSession('us-east-1');
		a.setTerminal(fakeTerminal(1));

		provider.onTerminalDisposed(fakeTerminal(1));

		assert.strictEqual(provider.sessions.length, 0);
	});

	it('getLastSession stays valid after a disposal', () => {
		const provider = new SessionProvider();
		const a = provider.addSession('us-east-1');
		a.setTerminal(fakeTerminal(1));
		const b = provider.addSession('us-east-1');
		b.setEnvironmentId('keep');
		b.setTerminal(fakeTerminal(2));

		provider.onTerminalDisposed(fakeTerminal(1));

		const last = provider.getLastSession();
		assert.ok(last);
		assert.strictEqual(last.environmentId, 'keep');
	});
});
