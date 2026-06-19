// Minimal `vscode` module stub so the extension's pure logic can be unit-tested
// under plain mocha (without the @vscode/test-electron Electron harness).
// Installed as a mocha `--require` so the hook is in place before any test file
// pulls in a module that `require('vscode')`.
const Module = require('module');

class TreeItem {
	constructor(label, collapsibleState) {
		this.label = label;
		this.collapsibleState = collapsibleState;
	}
}

class EventEmitter {
	constructor() {
		this._listeners = [];
		this.event = (listener) => {
			this._listeners.push(listener);
			return { dispose() {} };
		};
	}
	fire(e) {
		this._listeners.forEach(l => l(e));
	}
	dispose() {
		this._listeners = [];
	}
}

const vscodeStub = {
	TreeItem,
	EventEmitter,
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
	ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3 },
	window: {
		activeColorTheme: { kind: 2 }
	}
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') {
		return vscodeStub;
	}
	return originalLoad.apply(this, arguments);
};
