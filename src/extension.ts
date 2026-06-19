import * as vscode from 'vscode';
import axios from 'axios';

import * as aws4 from 'aws4';
import * as Utils from './utils';
import * as ViewProviders from './viewProviders';
import * as fs from 'fs';
import * as FormData from 'form-data';
import { spawn } from 'child_process';

import * as Client from './cloudShellClient';
import { CsEnvironment, CsVpcConfig } from './cloudShellClient';
import { selectProfile, configureVpc, ensureCredentialsAvailable } from './configCommands';

function getSessionManagerPath(): string {
	if (process.platform == "win32") {
		return "C:\\Program Files\\Amazon\\SessionManagerPlugin\\bin\\session-manager-plugin.exe";
	}

	return "session-manager-plugin";
}

export function activate(context: vscode.ExtensionContext) {
	console.info('AWS CloudShell extension loaded');

	let sessionProvider = new ViewProviders.SessionProvider();

	context.subscriptions.push(vscode.window.onDidCloseTerminal(terminal => {
		sessionProvider.onTerminalDisposed(terminal);
	}));

	context.subscriptions.push(vscode.window.createTreeView('aws-cloudshell-view-1-sessions', {
		'treeDataProvider': sessionProvider
	}));

	context.subscriptions.push(vscode.commands.registerCommand('awscloudshell.startSession', async () => {
		try {
			await ensureCredentialsAvailable();
			await createSession(sessionProvider);
		} catch (err: any) {
			sessionProvider.onError();
			vscode.window.setStatusBarMessage("", 60000);
			vscode.window.showErrorMessage(err.toString());
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('awscloudshell.refresh', async () => {
		await refreshSessions(sessionProvider);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('awscloudshell.selectProfile', async () => {
		await selectProfile();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('awscloudshell.configureVpc', async () => {
		await configureVpc();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('awscloudshell.reapplyCredentials', async (item) => {
		await reapplyCredentials(sessionProvider, item);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('awscloudshell.terminateSession', async (item) => {
		await terminateSession(sessionProvider, item);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('awscloudshell.openSession', async (item) => {
		await openSession(sessionProvider, item);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('awscloudshell.uploadFile', async (file) => {
		uploadFile(file, sessionProvider);
	}));

	// Best-effort discovery on activation. Must not block activation and must not
	// trigger an interactive credential prompt (e.g. MFA).
	discoverExistingEnvironments(sessionProvider).catch(err => {
		console.info("AWS CloudShell: skipped activation discovery: " + err);
	});
}

export function deactivate() {
	// Disposables are tracked via context.subscriptions; nothing further required.
}

// Lists existing CloudShell environments and reflects them in the tree. Used by
// the explicit Refresh command (interactive credentials allowed here).
async function refreshSessions(sessionProvider: ViewProviders.SessionProvider) {
	const region = await Utils.ResolveRegion();
	let creds;
	try {
		creds = await Utils.GetSigningCredentials();
	} catch (err: any) {
		vscode.window.showErrorMessage("Could not resolve AWS credentials: " + err);
		return;
	}

	try {
		const envs = await Client.describeEnvironmentsWithStatus(region, creds);
		sessionProvider.reconcile(region, envs);
	} catch (err: any) {
		vscode.window.showErrorMessage("Could not list AWS CloudShell environments: " + err);
	}
}

// Activation-time discovery: silently resolves credentials and populates the
// tree if possible, never prompting and never throwing into activation.
async function discoverExistingEnvironments(sessionProvider: ViewProviders.SessionProvider) {
	const region = await Utils.ResolveRegion();
	const creds = await Utils.GetSigningCredentialsSilent();
	if (!creds) {
		return;
	}
	const envs = await Client.describeEnvironmentsWithStatus(region, creds);
	sessionProvider.reconcile(region, envs);
}

async function uploadFile(file: any, sessionProvider: ViewProviders.SessionProvider) {
	const session = sessionProvider.getLastSession();

	if (!session || session.state != "CONNECTED") {
		vscode.window.showWarningMessage("Session not connected, cannot proceed with upload");
		return;
	}

	const filename = file.path.split("/").pop().split("\\").pop(); // TODO: Find an actual util for this

	let statusBar = vscode.window.setStatusBarMessage("$(globe) Uploading '" + filename + "'...", 60000);

	let awsreq = aws4.sign({
		service: 'cloudshell',
		region: session.region,
		method: 'POST',
		path: '/getFileUploadUrls',
		headers: {},
		body: JSON.stringify({
			EnvironmentId: session.environmentId,
			FileUploadPath: filename
		})
	}, session.creds);

	const csFileUploadPaths = await axios.post("https://" + awsreq.hostname + awsreq.path, awsreq.body, {
		headers: awsreq.headers
	});

	const formData = Object.entries(csFileUploadPaths.data.FileUploadPresignedFields).reduce((fd, [ key, val ]) =>
      (fd.append(key, val), fd), new FormData());

	formData.append('File', fs.readFileSync(file.path));

	await axios.post(csFileUploadPaths.data.FileUploadPresignedUrl, formData, {
		headers: {
			"Content-Type": `multipart/form-data; boundary=${formData.getBoundary()}`,
			"Content-Length": formData.getLengthSync()
		}
	});

	console.info("Uploaded");

	// Reuse the already-connected environment instead of creating a new one.
	const envs = await Client.describeEnvironments(session.region, session.creds);
	const env = envs.find(e => e.EnvironmentId === session.environmentId) || { EnvironmentId: session.environmentId };

	let csSession = await startCsSession(env, session);

	const sideSession = spawn(getSessionManagerPath(), [JSON.stringify(csSession), session.region, "StartSession"]);

	console.log(csFileUploadPaths.data.FileDownloadPresignedUrl);
	await new Promise(resolve => setTimeout(resolve, 3000));

	sideSession.stdin.write("wget " + csFileUploadPaths.data.FileDownloadPresignedUrl + "\nexit\n");
	sideSession.stdin.end();

	statusBar.dispose();
}

async function createSession(sessionProvider: ViewProviders.SessionProvider, existing?: ViewProviders.Session) {
	const aws_creds = await Utils.GetSigningCredentials();

	if (!aws_creds.sessionToken) {
		vscode.window.showErrorMessage("The credentials provided do not have a session token. Please configure credentials which return a session token.");
		return;
	}

	// When connecting to a specific listed environment, use its own region.
	let awsregion = (existing && existing.environmentId) ? existing.region : await Utils.ResolveRegion();

	let statusBar = vscode.window.setStatusBarMessage("$(globe) Connecting to AWS CloudShell...", 60000);

	// Reuse the row the user activated (avoids a flickering placeholder row), or
	// create a fresh one for a brand-new session.
	let session = existing || sessionProvider.addSession(awsregion);

	session.setCreds(aws_creds);

	let env: CsEnvironment;
	let vpcId: string | undefined;

	if (existing && existing.environmentId) {
		// Connect to THIS specific environment (correct when multiple exist), rather
		// than re-deciding which environment to use.
		const status = await Client.getEnvironmentStatus(awsregion, aws_creds, existing.environmentId);
		if (status.Status === "DELETING" || status.Status === "DELETED") {
			throw new Error("That AWS CloudShell environment is no longer available.");
		}
		env = { EnvironmentId: existing.environmentId, Status: status.Status, VpcConfig: status.VpcConfig };
		vpcId = status.VpcConfig && status.VpcConfig.VpcId;
		console.info("Connecting to existing AWS CloudShell environment " + env.EnvironmentId + " (" + env.Status + ")");
	} else {
		// Discover existing environments and decide whether to reuse or create.
		// Discovery is status-resolved because describeEnvironments returns only
		// EnvironmentId.
		const envs = await Client.describeEnvironmentsWithStatus(awsregion, aws_creds);
		const action = Client.decideEnvAction(envs);

		if (action.kind === "blocked") {
			throw new Error("An existing AWS CloudShell environment is being deleted; please retry shortly.");
		} else if (action.kind === "create") {
			let vpcConfig = buildVpcConfig(awsregion);
			env = await Client.createEnvironment(awsregion, aws_creds, vpcConfig);
			vpcId = vpcConfig && vpcConfig.VpcId;
			console.log("createEnvironment response:");
			console.log(env);
		} else {
			// reuse | resume | wait — connect to the existing environment.
			env = action.env;
			vpcId = env.VpcConfig && env.VpcConfig.VpcId;
			console.info("Reusing existing AWS CloudShell environment " + env.EnvironmentId + " (" + env.Status + ")");

			let vpcConfig = buildVpcConfig(awsregion);
			if (vpcConfig && !vpcConfigMatches(vpcConfig, env.VpcConfig)) {
				vscode.window.showWarningMessage("Using the existing AWS CloudShell environment's VPC configuration; configured VPC settings are ignored. Delete the environment to change its VPC.");
			}
		}
	}

	// A VPC-attached environment can only reach what its VPC allows, so AWS calls
	// time out unless the subnet has egress. Credentials are not injected in this
	// case (see below) since they couldn't reach AWS without that egress anyway.
	if (vpcId) {
		vscode.window.showWarningMessage(
			`This CloudShell environment is attached to VPC ${vpcId}; credentials are not auto-injected. AWS API calls require the subnet to have internet egress (NAT/IGW) or VPC endpoints. Use "Configure VPC… → No VPC" for default networking with auto-injected credentials.`
		);
	}

	// On "+" (no specific row), reuse an available (terminal-less) row for this
	// environment for the first shell; if every row is already an active shell,
	// keep the new placeholder so we open an ADDITIONAL shell (CloudShell allows
	// multiple concurrent shells per environment). Never adopt a connected row.
	if (!existing) {
		const adoptable = sessionProvider.sessions.find(s =>
			s !== session && s.environmentId === env.EnvironmentId && !s.terminal);
		if (adoptable) {
			sessionProvider.remove(session);
			adoptable.setCreds(aws_creds);
			session = adoptable;
		}
	}

	session.setSessionName(env.EnvironmentId.split("-")[0]);
	session.setEnvironmentId(env.EnvironmentId);
	session.setCreds(aws_creds);

	sessionProvider.refresh();

	console.info("Connecting to " + env.EnvironmentId + " (" + env.Status + ")");

	let csSession = await startCsSession(env, session);

	// Tag the row with a short shell id so multiple shells on the same
	// environment are distinguishable.
	if (csSession && typeof csSession.SessionId === "string") {
		const token = csSession.SessionId.split("-").pop() || csSession.SessionId;
		session.setShellId(token.slice(0, 6));
	}

	const terminal = vscode.window.createTerminal("AWS CloudShell", getSessionManagerPath(), [JSON.stringify(csSession), awsregion, "StartSession"]);

	session.setTerminal(terminal);
	sessionProvider.refresh();

	terminal.show();

	// Opt-in auto-injection: a non-VPC environment created via the API has no
	// credentials of its own, so optionally push the caller's credentials into the
	// shell as environment variables (the AWS CLI/SDKs prefer these over the broken
	// container-role endpoint). Disabled by default. Skipped for VPC-attached
	// environments, whose connectivity is governed by the VPC. The "Re-apply
	// Credentials to Shell" command remains available for manual, on-demand use.
	if (!vpcId && Utils.GetInjectCredentials()) {
		injectShellCredentials(terminal, awsregion, aws_creds, 5000);
	}

	statusBar.dispose();

	session.setConnected();
	sessionProvider.refresh();

	vscode.window.setStatusBarMessage("$(globe) Connected to AWS CloudShell", 3000);
}

// Pushes the caller's credentials into the connected shell as environment
// variables. `delayMs` gives the session-manager connection time to be ready to
// accept input on a fresh session (use 0 to re-apply on an already-open shell).
// History is suppressed for the secret-bearing command and the screen is cleared
// so the values aren't left on display.
function injectShellCredentials(terminal: vscode.Terminal, region: string, creds: Utils.SigningCredentials, delayMs: number) {
	setTimeout(() => {
		let cmd = " export AWS_DEFAULT_REGION='" + region + "' AWS_REGION='" + region + "'"
			+ " AWS_ACCESS_KEY_ID='" + creds.accessKeyId + "'"
			+ " AWS_SECRET_ACCESS_KEY='" + creds.secretAccessKey + "'";
		if (creds.sessionToken) {
			cmd += " AWS_SESSION_TOKEN='" + creds.sessionToken + "'";
		}

		// `HISTCONTROL=ignorespace` + the leading space keep the credentials out of
		// the shell's persisted history.
		terminal.sendText("export HISTCONTROL=ignorespace", true);
		terminal.sendText(cmd, true);
		terminal.sendText(" clear", true);
	}, delayMs);
}

// Command: open a session chosen from the list (same popup pattern as Terminate).
// A connected session is focused; an available one is connected to. Accepts a
// session from the tree context menu, otherwise prompts among the listed sessions.
async function openSession(sessionProvider: ViewProviders.SessionProvider, item?: ViewProviders.Session) {
	const candidates = sessionProvider.sessions.filter(s => s.terminal || s.environmentId);

	if (candidates.length === 0) {
		vscode.window.showInformationMessage("No AWS CloudShell sessions to open. Use Start Session to create one.");
		return;
	}

	let target: ViewProviders.Session | undefined = item;
	if (!target) {
		if (candidates.length === 1) {
			target = candidates[0];
		} else {
			const picked = await vscode.window.showQuickPick(
				candidates.map(s => ({ label: s.label, session: s })),
				{ placeHolder: "Select an AWS CloudShell session to open" }
			);
			if (!picked) {
				return;
			}
			target = picked.session;
		}
	}

	if (!target) {
		return;
	}

	// Already connected — just focus its terminal.
	if (target.terminal) {
		target.terminal.show();
		return;
	}

	try {
		await ensureCredentialsAvailable();
		await createSession(sessionProvider, target);
	} catch (err: any) {
		sessionProvider.onError();
		vscode.window.setStatusBarMessage("", 60000);
		vscode.window.showErrorMessage(err.toString());
	}
}

// Command: re-injects fresh credentials into a connected CloudShell session,
// for when the originally-injected temporary credentials have expired. Accepts a
// session from the tree context menu, otherwise targets / prompts among the
// connected sessions.
async function reapplyCredentials(sessionProvider: ViewProviders.SessionProvider, item?: ViewProviders.Session) {
	const connected = sessionProvider.sessions.filter(s => s.terminal && s.state === "CONNECTED");

	if (connected.length === 0) {
		vscode.window.showWarningMessage("No connected AWS CloudShell session to apply credentials to.");
		return;
	}

	let target: ViewProviders.Session | undefined = item && item.terminal ? item : undefined;
	if (!target) {
		if (connected.length === 1) {
			target = connected[0];
		} else {
			const picked = await vscode.window.showQuickPick(
				connected.map(s => ({ label: s.label, session: s })),
				{ placeHolder: "Select the CloudShell session to re-apply credentials to" }
			);
			if (!picked) {
				return;
			}
			target = picked.session;
		}
	}

	if (!target || !target.terminal) {
		return;
	}

	let creds;
	try {
		creds = await Utils.GetSigningCredentials();
	} catch (err: any) {
		vscode.window.showErrorMessage("Could not resolve AWS credentials: " + err);
		return;
	}

	injectShellCredentials(target.terminal, target.region, creds, 0);
	target.terminal.show();
	vscode.window.showInformationMessage("Re-applied AWS credentials to the CloudShell session.");
}

// Command: terminate a session chosen from the list. Offers to either disconnect
// (close the terminal, keep the environment) or permanently delete the
// environment. Accepts a session from the tree context menu, otherwise prompts.
async function terminateSession(sessionProvider: ViewProviders.SessionProvider, item?: ViewProviders.Session) {
	const candidates = sessionProvider.sessions.filter(s => s.terminal || s.environmentId);

	if (candidates.length === 0) {
		vscode.window.showWarningMessage("No AWS CloudShell sessions to terminate.");
		return;
	}

	let target: ViewProviders.Session | undefined = item;
	if (!target) {
		if (candidates.length === 1) {
			target = candidates[0];
		} else {
			const picked = await vscode.window.showQuickPick(
				candidates.map(s => ({ label: s.label, session: s })),
				{ placeHolder: "Select an AWS CloudShell session to terminate" }
			);
			if (!picked) {
				return;
			}
			target = picked.session;
		}
	}

	if (!target) {
		return;
	}

	// Offer only the actions that make sense for this session's state.
	const actions: { label: string; description: string; action: "disconnect" | "delete" }[] = [];
	if (target.terminal) {
		actions.push({ label: "$(debug-disconnect) Disconnect session", description: "Close the terminal; keep the environment", action: "disconnect" });
	}
	if (target.environmentId) {
		actions.push({ label: "$(trash) Delete environment", description: "Permanently delete the environment and its storage", action: "delete" });
	}
	if (actions.length === 0) {
		vscode.window.showWarningMessage("This session cannot be terminated.");
		return;
	}

	const choice = await vscode.window.showQuickPick(actions, {
		placeHolder: target.label
	});
	if (!choice) {
		return;
	}

	if (choice.action === "disconnect") {
		// Disposing the terminal triggers onTerminalDisposed, which reverts the row
		// to "available" (the environment itself is kept).
		if (target.terminal) {
			target.terminal.dispose();
		}
		return;
	}

	// delete — confirm first (irreversible).
	const confirm = await vscode.window.showWarningMessage(
		`Permanently delete AWS CloudShell environment "${target.name || target.environmentId}"? This destroys its persistent storage and cannot be undone.`,
		{ modal: true },
		"Delete"
	);
	if (confirm !== "Delete") {
		return;
	}

	let statusBar = vscode.window.setStatusBarMessage("$(trash) Deleting AWS CloudShell environment…", 60000);
	try {
		const creds = await Utils.GetSigningCredentials();
		await Client.deleteEnvironment(target.region, creds, target.environmentId);
	} catch (err: any) {
		statusBar.dispose();
		vscode.window.showErrorMessage("Could not delete environment: " + err);
		return;
	}

	if (target.terminal) {
		target.terminal.dispose();
	}
	sessionProvider.remove(target);
	statusBar.dispose();
	vscode.window.showInformationMessage("Deleted AWS CloudShell environment.");
}

// Builds a VpcConfig from user settings only when all three values are present
// AND they were configured for the current region and profile. A VPC/subnet/SG
// is scoped to a single region and account, so saved settings are ignored (with
// a warning) when the session's region or profile differs from when they were set.
function buildVpcConfig(resolvedRegion: string): CsVpcConfig | undefined {
	let vpc_id = Utils.GetVPCId();
	let subnet_id = Utils.GetSubnetId();
	let security_group_id = Utils.GetSecurityGroupId();

	if (!(vpc_id && subnet_id && security_group_id)) {
		return undefined;
	}

	const savedRegion = Utils.GetVPCRegion() || "";
	const savedProfile = Utils.GetVPCProfile() || "";
	const currentProfile = Utils.GetProfile() || "";

	if (savedRegion !== resolvedRegion || savedProfile !== currentProfile) {
		vscode.window.showWarningMessage(
			`Ignoring saved VPC configuration: it was set for region "${savedRegion || "?"}" / profile "${savedProfile || "default"}", ` +
			`but this session uses region "${resolvedRegion}" / profile "${currentProfile || "default"}". ` +
			`Run "Configure VPC…" to set a VPC for the current context.`
		);
		return undefined;
	}

	return {
		VpcId: vpc_id,
		SecurityGroupIds: [security_group_id],
		SubnetIds: [subnet_id]
	};
}

function vpcConfigMatches(desired: CsVpcConfig, existing?: CsVpcConfig): boolean {
	if (!existing) {
		return false;
	}
	return desired.VpcId === existing.VpcId
		&& (existing.SubnetIds || []).includes(desired.SubnetIds[0])
		&& (existing.SecurityGroupIds || []).includes(desired.SecurityGroupIds[0]);
}

// Drives the environment to RUNNING (starting/waiting as needed) and returns a
// fresh CloudShell session payload for the session-manager-plugin.
async function startCsSession(env: CsEnvironment, session: ViewProviders.Session): Promise<any> {
	try {
		await Client.waitForRunning(session.region, session.creds, env.EnvironmentId, env.Status);

		const csSession = await Client.createCloudShellSession(session.region, session.creds, env.EnvironmentId);

		console.log("createSession response:");
		console.log(csSession);

		return csSession;
	} catch (err: any) {
		console.log(err.response);
		console.log(err.data);
		console.log(err);
		throw err;
	}
}
