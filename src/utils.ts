import * as vscode from 'vscode';

import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { STS } from '@aws-sdk/client-sts';

function promptForMFAIfRequired(serial: string): Promise<string> {
    return new Promise((resolve, reject) => {
        vscode.window.showInputBox({
            placeHolder: "",
            prompt: "Enter your MFA code.",
            value: "",
            ignoreFocusOut: false
        }).then(function(mfa_token){
            resolve(mfa_token);
        });
    });
}

export function GetAWSCreds(): Thenable<any> {
    return new Promise(async (resolve, reject) => {
        let extensionConfig = vscode.workspace.getConfiguration('awscloudshell');
        let awsregion = extensionConfig.get('region');
        let assumeRole = extensionConfig.get('assumeRole');

        let creds = await defaultProvider({
            profile: extensionConfig.get('profile') || null,
            mfaCodeProvider: promptForMFAIfRequired
        })();

        if (assumeRole) {
            const stsclient = new STS({ credentials: creds });

            const assumedSession = await stsclient.assumeRole({
                RoleArn: assumeRole.toString(),
                RoleSessionName: 'VSCode'
            });
            
            resolve({
                'accessKey': assumedSession.Credentials.AccessKeyId,
                'secretKey': assumedSession.Credentials.SecretAccessKey,
                'sessionToken': assumedSession.Credentials.SessionToken
            });
        } else {
            resolve({
                'accessKey': creds.accessKeyId,
                'secretKey': creds.secretAccessKey,
                'sessionToken': creds.sessionToken
            });
        }
    });
}

export function GetRegion(): string {
    let extensionConfig = vscode.workspace.getConfiguration('awscloudshell');
    return extensionConfig.get('region') || "us-east-1";
}

export function GetVPCId(): string | null {
    let extensionConfig = vscode.workspace.getConfiguration('awscloudshell');
    return extensionConfig.get('vpcid');
}

export function GetSubnetId(): string | null {
    let extensionConfig = vscode.workspace.getConfiguration('awscloudshell');
    return extensionConfig.get('subnetid');
}

export function GetSecurityGroupId(): string | null {
    let extensionConfig = vscode.workspace.getConfiguration('awscloudshell');
    return extensionConfig.get('securitygroupid');
}

export function GetProxy(): string | null {
    let extensionConfig = vscode.workspace.getConfiguration('awscloudshell');
    let proxy: string = extensionConfig.get('proxy');

    if (proxy == "")
        return null;

    return proxy;
}

export function ReducePromises(array, fn) {
    var results = [];
    return array.reduce(function(p, item) {
        return p.then(function () {
            return fn(item).then(function (data) {
                results.push(data);
                return results;
            }).catch((y) => {
                console.error(y);
            });
        }).catch((x) => {
            console.error(x);
        });
    }, Promise.resolve());
}
