import * as vscode from 'vscode';
import axios, { AxiosRequestConfig, AxiosPromise } from 'axios';
import * as axiosCookieJarSupport from 'axios-cookiejar-support';
import * as tough from 'tough-cookie';

import * as aws4 from 'aws4';
import * as Utils from './Utils';
import * as ViewProviders from './ViewProviders';

export function activate(context: vscode.ExtensionContext) {
	console.info('AWS CloudShell extension loaded');

	let sessionProvider = new ViewProviders.SessionProvider();

	vscode.window.onDidCloseTerminal(terminal => {
		sessionProvider.onTerminalDisposed(terminal);
	})

	let sessionView = vscode.window.createTreeView('aws-cloudshell-view-1-sessions', {
        'treeDataProvider': sessionProvider
    });

	const disposable = vscode.commands.registerCommand('awscloudshell.startSession', async () => {
		try {
			await createSession(sessionProvider);
		} catch(err) {
			sessionProvider.onError();
			vscode.window.setStatusBarMessage("", 60000);
			vscode.window.showErrorMessage(err.toString());
		}
	});

	context.subscriptions.push(disposable);
}

async function createSession(sessionProvider) {
	let awsregion = Utils.GetRegion();
	let aws_creds = await Utils.GetAWSCreds();

	if (!aws_creds.sessionToken) {
		vscode.window.showErrorMessage("The credentials provided do not have a session token. Please configure credentials which return a session token.");
		return;
	}

	axiosCookieJarSupport.default(axios);

	const cookieJar = new tough.CookieJar();

	let statusBar = vscode.window.setStatusBarMessage("$(globe) Connecting to AWS CloudShell...", 60000);

	let session = sessionProvider.addSession(awsregion);

	let signintoken = await axios.get('https://signin.aws.amazon.com/federation?Action=getSigninToken&SessionDuration=3600&Session=' + encodeURIComponent(JSON.stringify({
		'sessionId': aws_creds.accessKey,
		'sessionKey': aws_creds.secretKey,
		'sessionToken': aws_creds.sessionToken,
	})), {
		jar: cookieJar,
		withCredentials: true
	});

	await axios.get('https://signin.aws.amazon.com/federation?Action=login&Destination=' + encodeURIComponent('https://console.aws.amazon.com/console/home') + '&SigninToken=' + signintoken.data['SigninToken'], {
		jar: cookieJar,
		withCredentials: true
	});

	let consoleHtmlResponse = await axios.get('https://' + (awsregion == 'us-east-1' ? '' : (awsregion + ".")) + 'console.aws.amazon.com/cloudshell/home?region=' + awsregion + '&state=hashArgs%23&hashArgs=%23', {
		jar: cookieJar,
		withCredentials: true
	});

	const messyTagPrefix = '<meta name="tb-data" content="';
	const startTag = consoleHtmlResponse.data.indexOf(messyTagPrefix);
	const endTag = consoleHtmlResponse.data.indexOf('">', startTag);

	const tbdata = JSON.parse(consoleHtmlResponse.data.substr(startTag + messyTagPrefix.length, endTag - startTag - messyTagPrefix.length).replace(/\&quot\;/g, "\""));

	let credsResp = await axios.post('https://' + (awsregion == 'us-east-1' ? '' : (awsregion + ".")) + 'console.aws.amazon.com/cloudshell/tb/creds', null, {
		jar: cookieJar,
		withCredentials: true,
		headers: {
			'x-csrf-token': tbdata.csrfToken,
			'Accept': '*/*',
			'Referer': 'https://' + (awsregion == 'us-east-1' ? '' : (awsregion + ".")) + 'console.aws.amazon.com/cloudshell/home?region=us-east-1'
		}
	});

	aws_creds = credsResp.data;

	let awsreq = aws4.sign({
		service: 'cloudshell',
		region: awsregion,
		method: 'POST',
		path: '/createEnvironment',
		headers: {},
		body: JSON.stringify({})
	}, aws_creds);

	const csEnvironment = await axios.post("https://" + awsreq.hostname + awsreq.path, awsreq.body, {
		headers: awsreq.headers
	});

	session.setSessionName(csEnvironment.data.EnvironmentId.split("-")[0]);
	sessionProvider.refresh();

	console.info("Connecting to " + csEnvironment.data.EnvironmentId + " (" + csEnvironment.data.Status + ")");

	if (csEnvironment.data.Status == "SUSPENDED") {
		awsreq = aws4.sign({
			service: 'cloudshell',
			region: awsregion,
			method: 'POST',
			path: '/startEnvironment',
			headers: {},
			body: JSON.stringify({
				EnvironmentId: csEnvironment.data.EnvironmentId
			})
		}, aws_creds);
	
		const csEnvironmentStart = await axios.post("https://" + awsreq.hostname + awsreq.path, awsreq.body, {
			headers: awsreq.headers
		});

		let environmentStatus = "RESUMING";
		while (environmentStatus == "RESUMING") {
			await new Promise(resolve => setTimeout(resolve, 2000));

			awsreq = aws4.sign({
				service: 'cloudshell',
				region: awsregion,
				method: 'POST',
				path: '/getEnvironmentStatus',
				headers: {},
				body: JSON.stringify({
					EnvironmentId: csEnvironment.data.EnvironmentId
				})
			}, aws_creds);
		
			let csEnvironmentStatus = await axios.post("https://" + awsreq.hostname + awsreq.path, awsreq.body, {
				headers: awsreq.headers
			});

			environmentStatus = csEnvironmentStatus.data.Status;
		}
	}

	awsreq = aws4.sign({
		service: 'cloudshell',
		region: awsregion,
		method: 'POST',
		path: '/createSession',
		headers: {},
		body: JSON.stringify({
			'EnvironmentId': csEnvironment.data.EnvironmentId
		})
	}, aws_creds);

	try {
		const csSession = await axios.post("https://" + awsreq.hostname + awsreq.path, awsreq.body, {
			headers: awsreq.headers
		});

		const terminal = vscode.window.createTerminal("AWS CloudShell", "session-manager-plugin", [JSON.stringify(csSession.data), awsregion, "StartSession"]);

		session.setTerminal(terminal);
		sessionProvider.refresh();

		terminal.show();
	} catch(err) {
		console.log(err.response);
	}

	statusBar.dispose();

	session.setConnected();
	sessionProvider.refresh();

	vscode.window.setStatusBarMessage("$(globe) Connected to AWS CloudShell", 3000);
}
