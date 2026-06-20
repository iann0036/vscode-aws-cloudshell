import * as vscode from 'vscode';
import * as path from 'path';

import { CsCreds, CsEnvironment } from './cloudShellClient';

export class Session extends vscode.TreeItem {

	public label: string;
	public state: string;
	public name!: string;
	public terminal: vscode.Terminal | undefined;
	public creds!: CsCreds;
	public environmentId!: string;
	public shellId: string | undefined;

	constructor(
		public region: string,
		public collapsibleState: vscode.TreeItemCollapsibleState,
		public command?: vscode.Command
	) {
		super("<new session>", collapsibleState);
		this.region = region;
		this.label = region + " - <new session> (connecting)";
		this.state = "CONNECTING";
	}

	setSessionName(name: string): void {
		this.name = name;
		this.label = this.region + " - " + this.name + " (connecting)";
	}

	// Identifies a specific shell (session) so multiple shells on the same
	// environment are distinguishable in the tree.
	setShellId(shellId: string): void {
		this.shellId = shellId;
	}

	setConnected(): void {
		this.state = "CONNECTED";
		this.contextValue = "connectedSession";
		const suffix = this.shellId ? " [" + this.shellId + "]" : "";
		this.label = this.region + " - " + this.name + suffix + " (connected)";
	}

	// Marks a session that was discovered (not yet attached to a terminal).
	setDiscovered(): void {
		this.state = "DISCOVERED";
		this.contextValue = "discoveredSession";
		this.shellId = undefined;
		this.label = this.region + " - " + this.name + " (available)";
	}

	setTerminal(terminal: vscode.Terminal): void {
		this.terminal = terminal;
	}

	setCreds(creds: CsCreds): void {
		this.creds = creds;
	}

	setEnvironmentId(environmentId: string): void {
		this.environmentId = environmentId;
	}

	iconPath = path.join(__filename, '..', '..', 'resources', 'icons', (vscode.window.activeColorTheme.kind == vscode.ColorThemeKind.Light ? 'session-light.png' : 'session-dark.png'));

	contextValue = 'connectingSession';
}

export class SessionProvider implements vscode.TreeDataProvider<Session> {

	private _onDidChangeTreeData: vscode.EventEmitter<Session | undefined> = new vscode.EventEmitter<Session | undefined>();
	readonly onDidChangeTreeData: vscode.Event<Session | undefined> = this._onDidChangeTreeData.event;

	public sessions: Session[];

	constructor() {
		this.sessions = [];
	}

	addSession(region: string): Session {
		let session = new Session(region, vscode.TreeItemCollapsibleState.None);
		this.sessions.push(session);
		this.refresh();

		return session;
	}

	findByEnvironmentId(environmentId: string): Session | undefined {
		return this.sessions.find(s => s.environmentId === environmentId);
	}

	// Reuses an existing tree row for the given environment id if one exists,
	// otherwise creates a fresh row. Prevents duplicate rows on reconnect.
	adoptOrCreate(region: string, environmentId?: string): Session {
		if (environmentId) {
			const existing = this.findByEnvironmentId(environmentId);
			if (existing) {
				this.refresh();
				return existing;
			}
		}
		return this.addSession(region);
	}

	// Populates the tree from a describeEnvironments result, leaving any
	// already-connected sessions intact.
	reconcile(region: string, envs: CsEnvironment[]): void {
		for (const env of envs) {
			if (!env || !env.EnvironmentId) {
				continue;
			}
			if (env.Status === "DELETING" || env.Status === "DELETED") {
				continue;
			}
			let session = this.findByEnvironmentId(env.EnvironmentId);
			if (!session) {
				session = this.addSession(region);
				session.setEnvironmentId(env.EnvironmentId);
				session.setSessionName(env.EnvironmentId.split("-")[0]);
				session.setDiscovered();
			}
		}
		this.refresh();
	}

	remove(session: Session): void {
		this.sessions = this.sessions.filter(s => s !== session);
		this.refresh();
	}

	clearAll(): void {
		this.sessions = [];
		this.refresh();
	}

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: Session): vscode.TreeItem {
		return element;
	}

	getChildren(_element?: Session): Thenable<Session[]> {
		return new Promise(resolve => {
			resolve(this.sessions);
		});
	}

	getLastSession(): Session {
		return this.sessions[this.sessions.length - 1];
	}

	onError(): void {
		setTimeout(() => {
			// Drop only failed placeholders (no live terminal AND no environment).
			// Environment-backed rows are kept so they remain listed as available.
			this.sessions = this.sessions.filter(s => {
				const liveTerminal = !!(s.terminal && !(s.terminal.exitStatus && s.terminal.exitStatus.code));
				return liveTerminal || !!s.environmentId;
			});
			this.refresh();
		}, 1000);
	}

	onTerminalDisposed(terminal: vscode.Terminal): void {
		const match = this.sessions.find(s =>
			s.terminal && s.terminal.processId === terminal.processId);

		if (!match) {
			this.onError();
			return;
		}

		if (match.environmentId) {
			// The CloudShell environment still exists (closing the terminal only
			// ends this shell), so keep it listed as available — unless another
			// available row for the same environment already exists (avoid dupes).
			const dupAvailable = this.sessions.some(s =>
				s !== match && s.environmentId === match.environmentId && !s.terminal);
			if (dupAvailable) {
				this.sessions = this.sessions.filter(s => s !== match);
			} else {
				match.terminal = undefined;
				match.setDiscovered();
			}
		} else {
			this.sessions = this.sessions.filter(s => s !== match);
		}

		this.refresh();
	}
}
