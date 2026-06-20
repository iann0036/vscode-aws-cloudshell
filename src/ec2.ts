import {
	EC2Client,
	DescribeVpcsCommand,
	DescribeSubnetsCommand,
	DescribeSecurityGroupsCommand,
	Tag
} from '@aws-sdk/client-ec2';

export interface AwsCredentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

export interface VpcInfo {
	id: string;
	name?: string;
	cidr?: string;
	isDefault?: boolean;
}

export interface SubnetInfo {
	id: string;
	name?: string;
	cidr?: string;
	availabilityZone?: string;
}

export interface SecurityGroupInfo {
	id: string;
	name?: string;
	description?: string;
}

// Returns the value of the `Name` tag, if present. Pure helper, unit-tested.
export function nameFromTags(tags?: Tag[]): string | undefined {
	if (!tags) {
		return undefined;
	}
	const tag = tags.find(t => t.Key === 'Name');
	return tag && tag.Value ? tag.Value : undefined;
}

export function mapVpc(v: any): VpcInfo {
	return {
		id: v.VpcId,
		name: nameFromTags(v.Tags),
		cidr: v.CidrBlock,
		isDefault: v.IsDefault
	};
}

export function mapSubnet(s: any): SubnetInfo {
	return {
		id: s.SubnetId,
		name: nameFromTags(s.Tags),
		cidr: s.CidrBlock,
		availabilityZone: s.AvailabilityZone
	};
}

export function mapSecurityGroup(g: any): SecurityGroupInfo {
	return {
		id: g.GroupId,
		name: g.GroupName,
		description: g.Description
	};
}

function makeClient(region: string, credentials: AwsCredentials): EC2Client {
	return new EC2Client({ region, credentials });
}

export async function listVpcs(region: string, credentials: AwsCredentials): Promise<VpcInfo[]> {
	const client = makeClient(region, credentials);
	const res = await client.send(new DescribeVpcsCommand({}));
	return (res.Vpcs || []).filter(v => v.VpcId).map(mapVpc);
}

export async function listSubnets(region: string, credentials: AwsCredentials, vpcId: string): Promise<SubnetInfo[]> {
	const client = makeClient(region, credentials);
	const res = await client.send(new DescribeSubnetsCommand({
		Filters: [{ Name: 'vpc-id', Values: [vpcId] }]
	}));
	return (res.Subnets || []).filter(s => s.SubnetId).map(mapSubnet);
}

export async function listSecurityGroups(region: string, credentials: AwsCredentials, vpcId: string): Promise<SecurityGroupInfo[]> {
	const client = makeClient(region, credentials);
	const res = await client.send(new DescribeSecurityGroupsCommand({
		Filters: [{ Name: 'vpc-id', Values: [vpcId] }]
	}));
	return (res.SecurityGroups || []).filter(g => g.GroupId).map(mapSecurityGroup);
}
