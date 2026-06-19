import * as vscode from 'vscode';

import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { STS } from '@aws-sdk/client-sts';
import { getProfileRegion } from './awsConfig';

function promptForMFAIfRequired(_serial: string): Promise<string> {
    return new Promise((resolve) => {
        vscode.window.showInputBox({
            placeHolder: "",
            prompt: "Enter your MFA code.",
            value: "",
            ignoreFocusOut: false
        }).then(function (mfa_token) {
            resolve(mfa_token || "");
        });
    });
}

// Credentials in the AWS SDK / aws4 shape, used to SigV4-sign CloudShell API
// requests and to construct EC2 clients.
export interface SigningCredentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
}

// Single source of truth for credential resolution: resolves via the configured
// profile (honoring SSO), optionally assuming a role. `allowPrompt` controls
// whether an MFA prompt may appear.
async function resolveCredentials(allowPrompt: boolean): Promise<SigningCredentials> {
    let extensionConfig = vscode.workspace.getConfiguration('awscloudshell');
    let assumeRole = extensionConfig.get('assumeRole');

    let creds = await defaultProvider({
        profile: extensionConfig.get<string>('profile') || undefined,
        mfaCodeProvider: allowPrompt
            ? promptForMFAIfRequired
            : () => Promise.reject(new Error("MFA required; skipping silent discovery"))
    })();

    if (assumeRole) {
        const stsclient = new STS({ credentials: creds });
        const assumedSession = await stsclient.assumeRole({
            RoleArn: assumeRole.toString(),
            RoleSessionName: 'VSCode'
        });
        if (!assumedSession.Credentials) {
            throw new Error("AssumeRole did not return credentials.");
        }
        return {
            accessKeyId: assumedSession.Credentials.AccessKeyId!,
            secretAccessKey: assumedSession.Credentials.SecretAccessKey!,
            sessionToken: assumedSession.Credentials.SessionToken
        };
    }

    return {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        sessionToken: creds.sessionToken
    };
}

// SigV4-signing credentials for CloudShell/EC2 API calls (may prompt for MFA).
export function GetSigningCredentials(): Promise<SigningCredentials> {
    return resolveCredentials(true);
}

// As above but never prompts; returns null on any failure. For activation-time
// discovery that must not interrupt the user.
export async function GetSigningCredentialsSilent(): Promise<SigningCredentials | null> {
    try {
        return await resolveCredentials(false);
    } catch (err) {
        return null;
    }
}

// Resolves the region to use, preferring (in order): the explicit
// `awscloudshell.region` setting, the configured profile's region (so a session
// lands in the profile's region without extra setup), the AWS_REGION /
// AWS_DEFAULT_REGION environment, then us-east-1.
export async function ResolveRegion(): Promise<string> {
    const extensionConfig = vscode.workspace.getConfiguration('awscloudshell');

    const configured = extensionConfig.get<string>('region');
    if (configured) {
        return configured;
    }

    const profile = extensionConfig.get<string>('profile') || process.env.AWS_PROFILE || 'default';
    const profileRegion = await getProfileRegion(profile);
    if (profileRegion) {
        return profileRegion;
    }

    return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
}

export function GetVPCId(): string | null {
    let extensionConfig = vscode.workspace.getConfiguration('awscloudshell');
    return extensionConfig.get<string>('vpcid') || null;
}

export function GetSubnetId(): string | null {
    let extensionConfig = vscode.workspace.getConfiguration('awscloudshell');
    return extensionConfig.get<string>('subnetid') || null;
}

export function GetSecurityGroupId(): string | null {
    let extensionConfig = vscode.workspace.getConfiguration('awscloudshell');
    return extensionConfig.get<string>('securitygroupid') || null;
}

// The currently configured AWS named profile (empty string => default chain).
export function GetProfile(): string {
    let extensionConfig = vscode.workspace.getConfiguration('awscloudshell');
    return extensionConfig.get<string>('profile') || "";
}

// Whether to automatically inject credentials into the shell on connect.
// Disabled by default — injection writes temporary credentials into the
// environment's shell session.
export function GetInjectCredentials(): boolean {
    let extensionConfig = vscode.workspace.getConfiguration('awscloudshell');
    return extensionConfig.get<boolean>('injectCredentials') === true;
}

// The region the saved VPC settings were configured for (used to ignore them
// when the session region differs).
export function GetVPCRegion(): string | null {
    let extensionConfig = vscode.workspace.getConfiguration('awscloudshell');
    return extensionConfig.get<string>('vpcRegion') || null;
}

// The profile the saved VPC settings were configured for (used to ignore them
// when the session profile/account differs).
export function GetVPCProfile(): string | null {
    let extensionConfig = vscode.workspace.getConfiguration('awscloudshell');
    return extensionConfig.get<string>('vpcProfile') || null;
}

export function GetProxy(): string | null {
    let extensionConfig = vscode.workspace.getConfiguration('awscloudshell');
    let proxy = extensionConfig.get<string>('proxy') || "";

    if (proxy == "") {
        return null;
    }

    return proxy;
}

export function ReducePromises(array: any[], fn: (item: any) => Promise<any>): Promise<any> {
    var results: any[] = [];
    return array.reduce(function (p: Promise<any>, item: any) {
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
