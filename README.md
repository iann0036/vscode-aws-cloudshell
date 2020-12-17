# AWS CloudShell plugin for VS Code

[![](https://img.shields.io/badge/-VS%20Code%20Marketplace-brightgreen)](https://marketplace.visualstudio.com/items?itemName=iann0036.aws-cloudshell)

An unofficial AWS CloudShell plugin for VS Code. Open multiple AWS CloudShell terminals within VS Code on demand.

>**Note:** This extension is still in alpha stages. Please [raise an issue](https://github.com/iann0036/vscode-aws-cloudshell/issues) if you experience any problems.

![AWS CloudShell plugin for VS Code Screenshot](https://raw.githubusercontent.com/iann0036/vscode-aws-cloudshell/master/resources/screenshot.png)

## Setup

In order to use this extension, you will need:

* The [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html) installed
* The [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) installed
* A profile configured that meets the below requirements

Once you have installed the extension, you should go to your VS Code preferences (hit F1 then enter "Preferences: Open Settings (UI)") and specify your `region` and `profile`. Once the settings are updated, you may click the sidebar icon and then the "Start Session" button (+).

Currently, you **MUST** either use a profile with a session token attached to it, or use the `assumeRole` property to assume a role with the [necessary permissions](https://console.aws.amazon.com/iam/home?region=us-east-1#/policies/arn:aws:iam::aws:policy/AWSCloudShellFullAccess$jsonEditor). Alternatives may be provided in a future release.


## Settings

Here is the list of all [settings](https://code.visualstudio.com/docs/getstarted/settings) you can set within this extension:

Setting | Description
------- | -----------
`awscloudshell.profile` | The profile (usually as specified in `~/.aws/credentials`) name
`awscloudshell.region` | The AWS region to connect to
`awscloudshell.assumeRole` | The role ARN to assume

