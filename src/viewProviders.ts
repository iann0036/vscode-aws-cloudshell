import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

class Session extends vscode.TreeItem {

	public label: string
    public state: string
    public name: string
    public terminal: vscode.Terminal

	constructor(
		public region: string,
		public collapsibleState: vscode.TreeItemCollapsibleState,
		public command?: vscode.Command
	) {
        super("<new session>", collapsibleState);
        this.region = region;
		this.label = region + " - <new session> (connecting)";
		this.state = "CONNECTING";
		console.log(this.iconPath);
    }
    
    setSessionName(name: string): void {
        this.name = name;
        this.label = this.region + " - " + this.name + " (connecting)";
    }

	setConnected(): void {
		this.state = "CONNECTED";
		this.contextValue = "connectedSession";
		this.label = this.region + " - " + this.name + " (connected)";
    }
    
    setTerminal(terminal: vscode.Terminal): void {
		this.terminal = terminal;
		vscode.window.activeColorTheme.kind
    }

	iconPath = path.join(__filename, '..', '..', 'resources', 'icons', (vscode.window.activeColorTheme.kind == vscode.ColorThemeKind.Light ? 'session-light.png' : 'session-dark.png'));

	contextValue = 'connectingSession';
}

export class SessionProvider implements vscode.TreeDataProvider<Session> {

	private _onDidChangeTreeData: vscode.EventEmitter<Session | undefined> = new vscode.EventEmitter<Session | undefined>();
	readonly onDidChangeTreeData: vscode.Event<Session | undefined> = this._onDidChangeTreeData.event;

	private sessions: Session[]

	constructor() {
		this.sessions = []
	}

	addSession(region: string): Session {
		let session = new Session(region, vscode.TreeItemCollapsibleState.None);
		this.sessions.push(session);
        this.refresh();
        
        return session;
	}

	clearAll(): void {
		this.sessions = [];
		this.refresh();
	}

	refresh(): void {
		this._onDidChangeTreeData.fire(null);
	}

	getTreeItem(element: Session): vscode.TreeItem {
		return element;
	}

	getChildren(element?: Session): Thenable<Session[]> {
		return new Promise(resolve => {
			resolve(this.sessions);
		});
	}

	onError(): void {
		setTimeout((that) => {
			for (let i=0; i<that.sessions.length; i++) {
				if (!that.sessions[i].terminal || (that.sessions[i].terminal.exitStatus && that.sessions[i].terminal.exitStatus.code)) {
					delete that.sessions[i];
				}
			}
	
			that.refresh();
		}, 1000, this);
	}

	onTerminalDisposed(terminal: vscode.Terminal): void {
		let found = false;

		for (let i=0; i<this.sessions.length; i++) {
			if (this.sessions[i].terminal && this.sessions[i].terminal.processId == terminal.processId) {
				delete this.sessions[i];
				found = true;
			}
		}

		this.refresh();

		if (!found) {
			this.onError();
		}
	}
}
