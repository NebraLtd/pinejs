import * as supertest from 'supertest';
import { expect } from 'chai';
const fixturePath = __dirname + '/fixtures/04-webresource/config';
import * as fsBase from 'fs';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline as pipelineRaw, Readable } from 'stream';
import * as util from 'util';
import { v4 as uuidv4 } from 'uuid';
import { tmpdir } from 'os';
import * as path from 'path';
import { testInit, testDeInit, testLocalServer } from './lib/test-init';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

const pipeline = util.promisify(pipelineRaw);
const fs = fsBase.promises;

describe('04 webresources tests', function () {
	let pineServer: Awaited<ReturnType<typeof testInit>>;

	const filePath = 'test/fixtures/04-webresource/resources/avatar-profile.png';
	const filename = filePath.split('/').pop();
	const contentType = 'image/png';
	let fileSize: number;

	before(async () => {
		pineServer = await testInit(fixturePath, true);
		const fileInfo = await fs.stat(filePath);
		fileSize = fileInfo.size;
	});

	after(async () => {
		await testDeInit(pineServer);
	});

	describe('Basic', () => {
		it('check /ping route is OK', async () => {
			await supertest(testLocalServer).get('/ping').expect(200, 'OK');
		});
	});

	describe('webresource', () => {
		it('creates a organization with a logo image', async () => {
			const res = await supertest(testLocalServer)
				.post('/example/organization')
				.field('name', 'John')
				.attach('logo_image', filePath, { filename, contentType });
			expect(res.status).to.equals(201);
			const organization = res.body;

			const res2 = await supertest(testLocalServer)
				.get(res.headers.location)
				.expect(200);
			expect(res2.body)
				.to.be.an('object')
				.that.has.ownProperty('d')
				.to.be.an('array');

			expect(organization.logo_image.size).to.equals(fileSize);
			expect(organization.logo_image.filename).to.equals(filename);
			expect(organization.logo_image.contentType).to.equals(contentType);

			const { body: photoRes } = await supertest(organization.logo_image.href)
				.get('')
				.set({
					responseType: 'arraybuffer',
					headers: {
						Accept: '*/*',
					},
				})
				.expect(200);

			const receivedSize = photoRes.length;
			expect(receivedSize).to.equals(fileSize);
			const realImage = await fs.readFile(filePath);
			const diff = realImage.compare(photoRes);
			expect(diff).to.be.eq(0);
		});

		it('creates a organization with a large logo image', async () => {
			// Create a large file by using an image at the head ( so that filetype can identify it as an image ),
			// and then appending a large chunk
			const { largeStream, largeFileSize } = await getLargeFileStream(
				1024 * 1024 * 512 - fileSize,
				filePath,
			);

			const res = await supertest(testLocalServer)
				.post('/example/organization')
				.field('name', 'John')
				.attach('logo_image', largeStream, { filename, contentType });
			expect(res.status).to.equals(201);
			const organization = res.body;

			const res2 = await supertest(testLocalServer)
				.get(res.headers.location)
				.expect(200);
			expect(res2.body)
				.to.be.an('object')
				.that.has.ownProperty('d')
				.to.be.an('array');

			expect(organization.logo_image.size).to.equals(largeFileSize);
			expect(organization.logo_image.filename).to.equals(filename);
			expect(organization.logo_image.contentType).to.equals(contentType);
		});

		it('deletes the resource in storage engine after deleting in the DB', async () => {
			const res = await supertest(testLocalServer)
				.post('/example/organization')
				.field('name', 'John')
				.attach('logo_image', filePath, { filename, contentType });
			expect(res.status).to.equals(201);

			const fileKey = res.body.logo_image.href.split('/').slice(-1)[0];

			const delRes = await supertest(testLocalServer).delete(
				`/example/organization(${res.body.id})`,
			);

			expect(delRes.status).to.equals(200);

			await expectNotToExist(fileKey);
		});

		it('deletes old resource in storage engine after updating webresource', async () => {
			const res = await supertest(testLocalServer)
				.post('/example/organization')
				.field('name', 'John')
				.attach('logo_image', filePath, { filename, contentType });
			expect(res.status).to.equals(201);

			const fileKey = res.body.logo_image.href.split('/').slice(-1)[0];
			const newFilePath =
				'test/fixtures/04-webresource/resources/other-image.png';
			const newFileName = 'other-image.png';

			const fileInfo = await fs.stat(newFilePath);
			const newFileSize = fileInfo.size;

			await supertest(testLocalServer)
				.patch(`/example/organization(${res.body.id})`)
				.attach('logo_image', newFilePath, {
					filename: newFileName,
					contentType,
				});

			const res2 = await supertest(testLocalServer)
				.get(`/example/organization(${res.body.id})`)
				.expect(200);

			const { body: photoRes } = await supertest(res2.body.d[0].logo_image.href)
				.get('')
				.set({
					responseType: 'arraybuffer',
					headers: {
						Accept: '*/*',
					},
				})
				.expect(200);

			const receivedSize = photoRes.length;
			expect(receivedSize).to.equals(newFileSize);
			const realImage = await fs.readFile(newFilePath);
			const diff = realImage.compare(photoRes);
			expect(diff).to.be.eq(0);

			await expectNotToExist(fileKey);
		});

		it('does not change old resource in storage updating other field that is not webresource', async () => {
			const res = await supertest(testLocalServer)
				.post('/example/organization')
				.field('name', 'John')
				.attach('logo_image', filePath, { filename, contentType });
			expect(res.status).to.equals(201);

			await supertest(testLocalServer)
				.patch(`/example/organization(${res.body.id})`)
				.field('name', 'Peter')
				.expect(200);

			const res2 = await supertest(testLocalServer)
				.get(`/example/organization(${res.body.id})`)
				.expect(200);

			expect(res2.body.d[0].name).to.equals('Peter');

			const { body: photoRes } = await supertest(res2.body.d[0].logo_image.href)
				.get('')
				.set({
					responseType: 'arraybuffer',
					headers: {
						Accept: '*/*',
					},
				})
				.expect(200);

			const receivedSize = photoRes.length;
			expect(receivedSize).to.equals(fileSize);
			const realImage = await fs.readFile(filePath);
			const diff = realImage.compare(photoRes);
			expect(diff).to.be.eq(0);
		});

		it('deletes file if creation db transaction fails', async () => {
			const uniqueFilename = `${uuidv4()}_${filename}`;
			const { largeStream } = await getLargeFileStream(
				1024 * 1024 * 600,
				filePath,
			);
			await supertest(testLocalServer)
				.post('/example/organization')
				.field('name', 'John')
				.attach('logo_image', largeStream, {
					filename: uniqueFilename,
					contentType,
				})
				.expect(400);

			await expectNotToExist(uniqueFilename);
		});

		it('ignores files in not post or patch requests', async () => {
			const uniqueFilename = `${uuidv4()}_${filename}`;
			await supertest(testLocalServer)
				.get('/example/organization')
				.field('name', 'John')
				.attach('logo_image', filePath, {
					filename: uniqueFilename,
					contentType,
				});

			await expectNotToExist(uniqueFilename);
		});

		it('ignores files if they are not in a valid resource field', async () => {
			const uniqueFilename = `${uuidv4()}_${filename}`;
			await supertest(testLocalServer)
				.post('/example/organization')
				.field('name', 'John')
				.attach('another_logo_image', filePath, {
					filename: uniqueFilename,
					contentType,
				});

			await expectNotToExist(uniqueFilename);
		});
	});
});

const expectNotToExist = async (filename: string) => {
	// Inspects minio bucket to ensure no file with this uuid_filename exists

	const files = await listAllFilesInBucket(
		process.env.S3_STORAGE_ADAPTER_BUCKET,
	);

	for (const file of files) {
		expect(file).not.to.contain(filename);
	}
};

const getLargeFileStream = async (size: number, filePathToRepeat: string) => {
	// File is too large will make DB transaction fail
	const fillerSize = Math.round(size);
	const chunkSize = 10 * 1024 * 1024;
	const chunks = Math.floor(fillerSize / chunkSize);
	const filler = Buffer.alloc(chunkSize);

	async function* generate() {
		yield await fs.readFile(filePathToRepeat);
		for (let i = 0; i < chunks; i++) {
			yield filler;
		}
	}

	const tmpFileName = path.join(tmpdir(), uuidv4());
	await pipeline(Readable.from(generate()), createWriteStream(tmpFileName));

	const fileInfo = await fs.stat(tmpFileName);
	const largeFileSize = fileInfo.size;

	return {
		largeStream: createReadStream(tmpFileName),
		largeFileSize,
	};
};

const listAllFilesInBucket = async (
	bucket: string = 'balena-pine-web-resources',
): Promise<string[]> => {
	const endpoint = `${process.env.S3_ENDPOINT}/${bucket}`;
	const s3client = new S3Client({
		region: 'us-east-1',
		credentials: {
			accessKeyId: process.env.S3_ACCESS_KEY as string,
			secretAccessKey: process.env.S3_SECRET_KEY as string,
		},
		endpoint,
	});

	const command = new ListObjectsV2Command({ Bucket: bucket });
	let isTruncated = true;

	const files: string[] = [];
	while (isTruncated) {
		const { Contents, IsTruncated, NextContinuationToken } =
			await s3client.send(command);
		if (Contents) {
			Contents.forEach((c) => c.Key && files.push(c.Key));
		}
		isTruncated = !!IsTruncated;
		command.input.ContinuationToken = NextContinuationToken;
	}
	return files;
};
