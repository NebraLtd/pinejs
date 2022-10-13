import * as supertest from 'supertest';
import { expect } from 'chai';
const fixturePath = __dirname + '/fixtures/04-permissions/config';
import { testInit, testDeInit, testLocalServer } from './lib/test-init';

const basicStudentAuthHeaderBase64 =
	Buffer.from('student;student').toString('base64');
const basicAdminAuthHeaderBase64 =
	Buffer.from('admin;admin').toString('base64');
describe('04 basic permission tests', function () {
	let pineServer: Awaited<ReturnType<typeof testInit>>;
	let request;
	before(async () => {
		pineServer = await testInit(fixturePath, true);
		request = supertest.agent(testLocalServer);
	});

	after(async () => {
		await testDeInit(pineServer);
	});

	describe('Basic', () => {
		it('check /ping route is OK', async () => {
			await request.get('/ping').expect(200, 'OK');
		});
	});

	describe.only('university vocabular', () => {
		it('check /university/student is served by pinejs', async () => {
			const res = await request
				.set('Authorization', 'Basic ' + basicStudentAuthHeaderBase64)
				.get('/university/student')
				.expect(200);
			expect(res.body)
				.to.be.an('object')
				.that.has.ownProperty('d')
				.to.be.an('array');
		});

		it('create a student', async () => {
			await request
				.set('Authorization', 'Basic ' + basicStudentAuthHeaderBase64)
				.post('/university/student')
				.send({
					matrix_number: 1,
					name: 'John',
					lastname: 'Doe',
					birthday: new Date(),
					semester_credits: 10,
				})
				.expect(201);
		});

		it('delete a student', async () => {
			await request
				.set('Authorization', 'Basic ' + basicStudentAuthHeaderBase64)
				.delete('/university/student(1)')
				.expect(401);
		});

		it('should fail to create a student with same matrix number ', async () => {
			await request
				.set('Authorization', 'Basic ' + basicStudentAuthHeaderBase64)
				.post('/university/student')
				.send({
					matrix_number: 1,
					name: 'John',
					lastname: 'Doe',
					birthday: new Date(),
					semester_credits: 10,
				})
				.expect(409);
		});

		it('should fail to create a student with too few semester credits ', async () => {
			const res = await request
				.set('Authorization', 'Basic ' + basicStudentAuthHeaderBase64)
				.post('/university/student')
				.send({
					matrix_number: 2,
					name: 'Jenny',
					lastname: 'Dea',
					birthday: new Date(),
					semester_credits: 2,
				})
				.expect(400);
			expect(res.body)
				.to.be.a('string')
				.that.equals(
					'It is necessary that each student that has a semester credits, has a semester credits that is greater than or equal to 4 and is less than or equal to 16.',
				);
		});
	});
});
