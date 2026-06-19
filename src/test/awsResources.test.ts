import * as assert from 'assert';

import { mergeProfileNames } from '../awsConfig';
import { nameFromTags, mapVpc, mapSubnet, mapSecurityGroup } from '../ec2';

describe('mergeProfileNames', () => {
	it('merges and de-duplicates names across both files, sorted', () => {
		const names = mergeProfileNames({
			configFile: { default: {}, dev: {}, prod: {} },
			credentialsFile: { default: {}, ci: {} }
		});
		assert.deepStrictEqual(names, ['ci', 'default', 'dev', 'prod']);
	});

	it('handles missing files', () => {
		assert.deepStrictEqual(mergeProfileNames({}), []);
		assert.deepStrictEqual(mergeProfileNames({ configFile: { only: {} } }), ['only']);
	});
});

describe('EC2 mappers', () => {
	it('nameFromTags extracts the Name tag', () => {
		assert.strictEqual(nameFromTags([{ Key: 'Name', Value: 'my-vpc' }]), 'my-vpc');
		assert.strictEqual(nameFromTags([{ Key: 'Other', Value: 'x' }]), undefined);
		assert.strictEqual(nameFromTags(undefined), undefined);
		assert.strictEqual(nameFromTags([{ Key: 'Name' }]), undefined);
	});

	it('mapVpc projects the fields of interest', () => {
		const vpc = mapVpc({ VpcId: 'vpc-1', CidrBlock: '10.0.0.0/16', IsDefault: true, Tags: [{ Key: 'Name', Value: 'main' }] });
		assert.deepStrictEqual(vpc, { id: 'vpc-1', name: 'main', cidr: '10.0.0.0/16', isDefault: true });
	});

	it('mapSubnet projects the fields of interest', () => {
		const subnet = mapSubnet({ SubnetId: 'subnet-1', CidrBlock: '10.0.1.0/24', AvailabilityZone: 'us-east-1a', Tags: [] });
		assert.deepStrictEqual(subnet, { id: 'subnet-1', name: undefined, cidr: '10.0.1.0/24', availabilityZone: 'us-east-1a' });
	});

	it('mapSecurityGroup projects the fields of interest', () => {
		const sg = mapSecurityGroup({ GroupId: 'sg-1', GroupName: 'default', Description: 'default VPC SG' });
		assert.deepStrictEqual(sg, { id: 'sg-1', name: 'default', description: 'default VPC SG' });
	});
});
