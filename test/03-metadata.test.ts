import { expect } from 'chai';
import * as supertest from 'supertest';
const fixturePath = __dirname + '/fixtures/03-metadata/config';
import { testInit, testDeInit, testLocalServer } from './lib/test-init';

describe('00 basic tests', function () {
	let pineServer: Awaited<ReturnType<typeof testInit>>;
	before(async () => {
		pineServer = await testInit(fixturePath, true);
	});

	after(async () => {
		await testDeInit(pineServer);
	});

	describe('Basic', () => {
		it('check /ping route is OK', async () => {
			await supertest(testLocalServer).get('/ping').expect(200, 'OK');
		});
	});

	// TODO Check deprecation for endpoints

	describe('get metadata', () => {
		it('check /example/$metadata is served by pinejs', async () => {
			const res = await supertest(testLocalServer)
				.get('/example/$metadata')
				.send({ openapi: true })
				.expect(200);
			expect(res.body.paths).to.be.an('object');

			// full CRUD access for device resource

			expect(res.body.paths).to.have.property('/device');
			const devicePath = res.body.paths['/device'];
			expect(devicePath).to.have.all.keys(['get', 'post']);

			expect(res.body.paths).to.have.property('/device({id})');
			const deviceIdPath = res.body.paths['/device({id})'];
			expect(deviceIdPath).to.have.all.keys([
				'get',
				'patch',
				'delete',
				'parameters',
			]);

			// only CRU access for application resource - no delete
			expect(res.body.paths).to.have.property('/application');
			const applicationPath = res.body.paths['/application'];
			expect(applicationPath).to.have.all.keys(['get', 'post']);

			expect(res.body.paths).to.have.property('/application({id})');
			const applicationIdPath = res.body.paths['/application({id})'];
			expect(applicationIdPath).to.have.all.keys([
				'get',
				'patch',
				'parameters',
			]);

			// Read only access for gateway resource
			expect(res.body.paths).to.have.property('/gateway');
			const gatewayPath = res.body.paths['/gateway'];
			expect(gatewayPath).to.have.keys(['get']);
			expect(gatewayPath).to.not.have.any.keys(['post']);
		});
	});
});
