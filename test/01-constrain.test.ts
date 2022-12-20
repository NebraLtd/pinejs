import * as supertest from 'supertest';
import axios from 'axios';
import { expect } from 'chai';
const fixturePath = __dirname + '/fixtures/01-constrain/config';
import { testInit, testDeInit, testLocalServer } from './lib/test-init';
import * as fsBase from 'fs';
const fs = fsBase.promises;

describe('01 basic constrain tests', function () {
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

	describe('university vocabular', () => {
		it('check /university/student is served by pinejs', async () => {
			const res = await supertest(testLocalServer)
				.get('/university/student')
				.expect(200);
			expect(res.body)
				.to.be.an('object')
				.that.has.ownProperty('d')
				.to.be.an('array');
		});

		it('create a student', async () => {
			await supertest(testLocalServer)
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

		it('should fail to create a student with same matrix number ', async () => {
			await supertest(testLocalServer)
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
			const res = await supertest(testLocalServer)
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

		it('create a student with a picture', async () => {
			const filePath = 'test/fixtures/resources/avatar-profile.png';
			const filename = 'john_doe_small.png';
			const fileInfo = await fs.stat(filePath);
			const fileSize = fileInfo.size;

			const contentType = 'image/png';
			const res = await supertest(testLocalServer)
				.post('/university/student')
				.field('name','John')
				.field('lastname','Doe')
				.field('matrix_number',2)
				.field('birthday', '2022-09-14')
				.field('semester_credits',10)
				.attach('picture', filePath, { filename: filename, contentType: contentType});
			expect(res.status).to.equals(201);							
			const student = res.body;

			expect(student.picture.size).to.equals(fileSize);
			expect(student.picture.filename).to.equals(filename);
			expect(student.picture.contentType).to.equals(contentType);

			const photoRes = await axios.get(student.picture.href, {
        responseType: 'arraybuffer',
        headers: {
					'Accept': '*/*'            
        }
    	});
			expect(photoRes.status).to.equals(200);
			const receivedSize = photoRes.data.length;
			expect(receivedSize).to.equals(fileSize);
		});

	});
});
