import * as vscode from 'vscode';

import * as Utils from './utils';
import { listProfiles, getProfileRegion } from './awsConfig';
import { listVpcs, listSubnets, listSecurityGroups } from './ec2';

interface ProfileItem extends vscode.QuickPickItem {
	profileValue: string;
}

interface IdItem extends vscode.QuickPickItem {
	id: string;
}

function getConfig() {
	return vscode.workspace.getConfiguration('awscloudshell');
}

// Command: lets the user pick an AWS CLI profile (or the default credential
// chain) from a QuickPick and persists it to the `awscloudshell.profile` setting.
export async function selectProfile(): Promise<void> {
	const profiles = await listProfiles();

	const items: ProfileItem[] = [
		{
			label: "$(account) Use default credential chain",
			description: "Environment variables, default profile, SSO, instance role…",
			profileValue: ""
		},
		...profiles.map(p => ({
			label: "$(key) " + p,
			description: "AWS CLI profile",
			profileValue: p
		}))
	];

	const picked = await vscode.window.showQuickPick(items, {
		placeHolder: "Select an AWS profile for CloudShell",
		ignoreFocusOut: true
	});

	if (!picked) {
		return;
	}

	await getConfig().update('profile', picked.profileValue, vscode.ConfigurationTarget.Global);

	// Adopt the profile's configured region so the session lands in the expected
	// region rather than the us-east-1 default.
	let regionNote = "";
	if (picked.profileValue) {
		const region = await getProfileRegion(picked.profileValue);
		if (region) {
			await getConfig().update('region', region, vscode.ConfigurationTarget.Global);
			regionNote = ` (region: ${region})`;
		}
	}

	vscode.window.showInformationMessage(picked.profileValue
		? `AWS CloudShell will use profile "${picked.profileValue}"${regionNote}.`
		: "AWS CloudShell will use the default credential chain.");
}

function withProgress<T>(title: string, task: () => Promise<T>): Thenable<T> {
	return vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title },
		task
	);
}

// Command: cascading VPC → Subnet → Security Group picker backed by live EC2
// describe calls, persisting the three `awscloudshell.*` VPC settings. Choosing
// "No VPC" clears them so CloudShell uses default networking.
export async function configureVpc(): Promise<void> {
	const region = await Utils.ResolveRegion();

	let sdkCreds;
	try {
		sdkCreds = await Utils.GetSigningCredentials();
	} catch (err) {
		vscode.window.showErrorMessage("Could not resolve AWS credentials: " + err);
		return;
	}

	let vpcs;
	try {
		vpcs = await withProgress("Loading VPCs…", () => listVpcs(region, sdkCreds));
	} catch (err) {
		vscode.window.showErrorMessage("Could not list VPCs in " + region + ": " + err);
		return;
	}

	const vpcItems: IdItem[] = [
		{ label: "$(circle-slash) No VPC", description: "Use default CloudShell networking", id: "" },
		...vpcs.map(v => ({
			label: "$(globe) " + (v.name ? v.name + " — " : "") + v.id,
			description: [v.cidr, v.isDefault ? "(default)" : ""].filter(Boolean).join(" "),
			id: v.id
		}))
	];

	const pickedVpc = await vscode.window.showQuickPick(vpcItems, {
		placeHolder: "Select a VPC for the CloudShell environment (" + region + ")",
		ignoreFocusOut: true
	});
	if (!pickedVpc) {
		return;
	}

	const config = getConfig();

	if (!pickedVpc.id) {
		await config.update('vpcid', '', vscode.ConfigurationTarget.Global);
		await config.update('subnetid', '', vscode.ConfigurationTarget.Global);
		await config.update('securitygroupid', '', vscode.ConfigurationTarget.Global);
		await config.update('vpcRegion', '', vscode.ConfigurationTarget.Global);
		await config.update('vpcProfile', '', vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage("AWS CloudShell VPC configuration cleared.");
		return;
	}

	let subnets;
	try {
		subnets = await withProgress("Loading subnets…", () => listSubnets(region, sdkCreds, pickedVpc.id));
	} catch (err) {
		vscode.window.showErrorMessage("Could not list subnets: " + err);
		return;
	}
	if (subnets.length === 0) {
		vscode.window.showWarningMessage("No subnets found in " + pickedVpc.id + ".");
		return;
	}

	const pickedSubnet = await vscode.window.showQuickPick<IdItem>(subnets.map(s => ({
		label: "$(server) " + (s.name ? s.name + " — " : "") + s.id,
		description: [s.cidr, s.availabilityZone].filter(Boolean).join(" "),
		id: s.id
	})), {
		placeHolder: "Select a subnet",
		ignoreFocusOut: true
	});
	if (!pickedSubnet) {
		return;
	}

	let groups;
	try {
		groups = await withProgress("Loading security groups…", () => listSecurityGroups(region, sdkCreds, pickedVpc.id));
	} catch (err) {
		vscode.window.showErrorMessage("Could not list security groups: " + err);
		return;
	}
	if (groups.length === 0) {
		vscode.window.showWarningMessage("No security groups found in " + pickedVpc.id + ".");
		return;
	}

	const pickedGroup = await vscode.window.showQuickPick<IdItem>(groups.map(g => ({
		label: "$(shield) " + (g.name ? g.name + " — " : "") + g.id,
		description: g.description,
		id: g.id
	})), {
		placeHolder: "Select a security group",
		ignoreFocusOut: true
	});
	if (!pickedGroup) {
		return;
	}

	await config.update('vpcid', pickedVpc.id, vscode.ConfigurationTarget.Global);
	await config.update('subnetid', pickedSubnet.id, vscode.ConfigurationTarget.Global);
	await config.update('securitygroupid', pickedGroup.id, vscode.ConfigurationTarget.Global);
	// Record the region and profile this VPC belongs to so it can be ignored if
	// the session's region or profile (account) later changes — a VPC/subnet/SG
	// is only valid within its own region and account.
	await config.update('vpcRegion', region, vscode.ConfigurationTarget.Global);
	await config.update('vpcProfile', Utils.GetProfile(), vscode.ConfigurationTarget.Global);

	const profileNote = Utils.GetProfile() || "default";
	vscode.window.showInformationMessage(`AWS CloudShell VPC configured for ${region} / profile "${profileNote}": ${pickedVpc.id} / ${pickedSubnet.id} / ${pickedGroup.id}.`);
}

// Before starting a session: if no profile is set and no credentials can be
// resolved silently, offer to pick a profile so the user isn't met with a bare
// failure. Returns once the user has chosen (or declined).
export async function ensureCredentialsAvailable(): Promise<void> {
	const profile = getConfig().get<string>('profile');
	if (profile) {
		return;
	}

	const silent = await Utils.GetSigningCredentialsSilent();
	if (silent) {
		return;
	}

	const profiles = await listProfiles();
	if (profiles.length === 0) {
		return;
	}

	const choice = await vscode.window.showInformationMessage(
		"No AWS credentials were found for CloudShell. Select a profile?",
		"Select Profile"
	);
	if (choice === "Select Profile") {
		await selectProfile();
	}
}
