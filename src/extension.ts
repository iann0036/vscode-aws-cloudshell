import * as vscode from 'vscode';
import axios, { AxiosRequestConfig, AxiosPromise } from 'axios';
import * as axiosCookieJarSupport from 'axios-cookiejar-support';
import * as tough from 'tough-cookie';

import * as aws4 from 'aws4';
import * as Utils from './Utils';
import * as ViewProviders from './ViewProviders';
import * as fs from 'fs';
import * as FormData from 'form-data'
import { GetSessionTokenCommand } from '@aws-sdk/client-sts';
import { spawn } from 'child_process';

export function activate(context: vscode.ExtensionContext) {
	console.info('AWS CloudShell extension loaded');

	let sessionProvider = new ViewProviders.SessionProvider();

	vscode.window.onDidCloseTerminal(terminal => {
		sessionProvider.onTerminalDisposed(terminal);
	})

	let sessionView = vscode.window.createTreeView('aws-cloudshell-view-1-sessions', {
        'treeDataProvider': sessionProvider
    });

	context.subscriptions.push(vscode.commands.registerCommand('awscloudshell.startSession', async () => {
		try {
			await createSession(sessionProvider);
		} catch(err) {
			sessionProvider.onError();
			vscode.window.setStatusBarMessage("", 60000);
			vscode.window.showErrorMessage(err.toString());
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('awscloudshell.uploadFile', async (file) => {
		uploadFile(file, sessionProvider);
	}));
}

async function uploadFile(file, sessionProvider: ViewProviders.SessionProvider) {
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
	
	const fileUpload = await axios.post(csFileUploadPaths.data.FileUploadPresignedUrl, formData, {
		headers: {
			"Content-Type": `multipart/form-data; boundary=${formData.getBoundary()}`,
			"Content-Length": formData.getLengthSync()
		}
	});

	console.info("Uploaded");

	awsreq = aws4.sign({
		service: 'cloudshell',
		region: session.region,
		method: 'POST',
		path: '/createEnvironment',
		headers: {},
		body: JSON.stringify({})
	}, session.creds);

	const csEnvironment = await axios.post("https://" + awsreq.hostname + awsreq.path, awsreq.body, {
		headers: awsreq.headers
	});

	let csSession = await startCsSession(csEnvironment, session);

	const sideSession = spawn("session-manager-plugin", [JSON.stringify(csSession.data), session.region, "StartSession"]);

	console.log(csFileUploadPaths.data.FileDownloadPresignedUrl);
	await new Promise(resolve => setTimeout(resolve, 3000));

	sideSession.stdin.write("wget " + csFileUploadPaths.data.FileDownloadPresignedUrl + "\nexit\n");
	sideSession.stdin.end();

	statusBar.dispose();
}

async function createSession(sessionProvider: ViewProviders.SessionProvider) {
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

	let messyTagPrefix = '<meta name="tb-data" content="';
	let startTag = consoleHtmlResponse.data.indexOf(messyTagPrefix);
	let endTag = consoleHtmlResponse.data.indexOf('">', startTag);

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

	session.setCreds(aws_creds);

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
	session.setEnvironmentId(csEnvironment.data.EnvironmentId);

	sessionProvider.refresh();

	console.info("Connecting to " + csEnvironment.data.EnvironmentId + " (" + csEnvironment.data.Status + ")");

	let csSession = await startCsSession(csEnvironment, session);

	// creds put

	try {
		awsreq = aws4.sign({
			service: 'cloudshell',
			host: 'auth.cloudshell.' + awsregion + '.aws.amazon.com',
			region: awsregion,
			method: 'GET',
			signQuery: true,
			path: "/oauth?EnvironmentId=" + csEnvironment.data.EnvironmentId + "&codeVerifier=R0r-XINZhRJqEkRk-2EjocwI2aqrhcjO6IlGRPYcIo0&redirectUri=" + encodeURIComponent('https://auth.cloudshell.' + awsregion + '.aws.amazon.com/callback.js?state=1')
		}, aws_creds);

		const csOAuth = await axios.get("https://auth.cloudshell." + awsregion + ".aws.amazon.com" + awsreq.path, {
			jar: cookieJar,
			withCredentials: true
		});

		messyTagPrefix = 'main("';
		startTag = csOAuth.data.indexOf(messyTagPrefix);
		endTag = csOAuth.data.indexOf('", "', startTag);

		const authcode = csOAuth.data.substr(startTag + messyTagPrefix.length, endTag - startTag - messyTagPrefix.length);

		let cookies = cookieJar.getCookiesSync("https://auth.cloudshell." + awsregion + ".aws.amazon.com/");

		let keybase = '';
		for (let cookie of cookies) {
			if (cookie.key == "aws-userInfo") {
				keybase = JSON.parse(decodeURIComponent(cookie.value))['keybase'];
			}
		}

		awsreq = aws4.sign({
			service: 'cloudshell',
			region: awsregion,
			method: 'POST',
			path: '/redeemCode',
			headers: {},
			body: JSON.stringify({
				AuthCode: authcode,
				CodeVerifier: "cfd87ed2-16b3-432e-8278-e3afdfc6b235c1a6b90c-33e3-43a6-9801-02d742274b9c",
				EnvironmentId: csEnvironment.data.EnvironmentId,
				KeyBase: keybase,
				RedirectUri: "https://auth.cloudshell." + awsregion + ".aws.amazon.com/callback.js?state=1"
			})
		}, aws_creds);

		const csRedeem = await axios.post("https://" + awsreq.hostname + awsreq.path, awsreq.body, {
			headers: awsreq.headers
		});

		awsreq = aws4.sign({
			service: 'cloudshell',
			region: awsregion,
			method: 'POST',
			path: '/putCredentials',
			headers: {},
			body: JSON.stringify({
				EnvironmentId: csEnvironment.data.EnvironmentId,
				KeyBase: keybase,
				RefreshToken: csRedeem.data.RefreshToken
			})
		}, aws_creds);

		await axios.post("https://" + awsreq.hostname + awsreq.path, awsreq.body, {
			headers: awsreq.headers
		});
	} catch(err) {
		console.log(err.response);
		console.log(err.data);
		console.log(err);
		vscode.window.showWarningMessage("Could not apply AWS credentials to environment");
	}

	//

	const terminal = vscode.window.createTerminal("AWS CloudShell", "session-manager-plugin", [JSON.stringify(csSession.data), awsregion, "StartSession"]);

	session.setTerminal(terminal);
	sessionProvider.refresh();

	terminal.show();

	statusBar.dispose();

	session.setConnected();
	sessionProvider.refresh();

	vscode.window.setStatusBarMessage("$(globe) Connected to AWS CloudShell", 3000);
}

async function startCsSession(csEnvironment, session) {
	try {
		if (csEnvironment.data.Status != "RUNNING") {
			let awsreq = aws4.sign({
				service: 'cloudshell',
				region: session.region,
				method: 'POST',
				path: '/startEnvironment',
				headers: {},
				body: JSON.stringify({
					EnvironmentId: csEnvironment.data.EnvironmentId
				})
			}, session.creds);
		
			const csEnvironmentStart = await axios.post("https://" + awsreq.hostname + awsreq.path, awsreq.body, {
				headers: awsreq.headers
			});

			let environmentStatus = "RESUMING";
			while (environmentStatus == "RESUMING") {
				await new Promise(resolve => setTimeout(resolve, 2000));

				awsreq = aws4.sign({
					service: 'cloudshell',
					region: session.region,
					method: 'POST',
					path: '/getEnvironmentStatus',
					headers: {},
					body: JSON.stringify({
						EnvironmentId: csEnvironment.data.EnvironmentId
					})
				}, session.creds);
			
				let csEnvironmentStatus = await axios.post("https://" + awsreq.hostname + awsreq.path, awsreq.body, {
					headers: awsreq.headers
				});

				environmentStatus = csEnvironmentStatus.data.Status;
			}
		}

		let awsreq = aws4.sign({
			service: 'cloudshell',
			region: session.region,
			method: 'POST',
			path: '/createSession',
			headers: {},
			body: JSON.stringify({
				'EnvironmentId': csEnvironment.data.EnvironmentId
			})
		}, session.creds);
		
		const csSession = await axios.post("https://" + awsreq.hostname + awsreq.path, awsreq.body, {
			headers: awsreq.headers
		});

		return csSession;
	} catch(err) {
		console.log(err.response);
		console.log(err.data);
		console.log(err);
		throw err;
	}
}