import { optionalVar, requiredVar } from '@balena/env-parsing';
import {
	IncomingFile,
	UploadResponse,
	WebResourceHandler,
} from '../webresource-handler';
import {
	S3Client,
	S3ClientConfig,
	DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { v4 as uuidv4 } from 'uuid';

export interface S3HandlerConfig {
	bucket?: string;
	region?: string;
	accessKeyId?: string;
	secretAccessKey?: string;
	endpoint?: string;
}

export class S3Handler implements WebResourceHandler {
	private readonly bucket: string;
	private readonly region: string;
	private readonly accessKeyId: string;
	private readonly secretAccessKey: string;
	private readonly endpoint: string;
	private client: S3Client;

	constructor(config?: S3HandlerConfig) {
		this.bucket =
			config?.bucket ??
			optionalVar('S3_STORAGE_ADAPTER_BUCKET', 'balena-pine-web-resources');
		this.region =
			config?.region ?? optionalVar('S3_STORAGE_ADAPTER_REGION', 'us-east-1');
		this.accessKeyId = config?.accessKeyId ?? requiredVar('S3_ACCESS_KEY');
		this.secretAccessKey =
			config?.secretAccessKey ?? requiredVar('S3_SECRET_KEY');
		this.endpoint = config?.endpoint ?? requiredVar('S3_ENDPOINT');

		this.client = this.getS3Client();
	}

	public async handleFile(resource: IncomingFile): Promise<UploadResponse> {
		let size = 0;
		const key = `${resource.fieldname}_${uuidv4()}_${resource.originalname}`;
		const params = {
			Bucket: this.bucket,
			ACL: 'public-read',
			StorageClass: 'STANDARD',
			Key: key,
			Body: resource.stream,
			ContentType: resource.mimetype,
		};
		const client = this.getS3Client();
		const upload = new Upload({ client, params });

		upload.on('httpUploadProgress', (ev) => {
			size = ev.total ? ev.total : ev.loaded!;
		});

		await upload.done();
		const filename = this.getS3URL(key);
		return { size, filename };
	}

	public async removeFile(fileReference: string): Promise<void> {
		const client = this.getS3Client();
		const fileKey = fileReference.split('/').slice(-1)[0];

		const command = new DeleteObjectCommand({
			Bucket: this.bucket,
			Key: fileKey,
		});

		await client.send(command);
	}

	private getS3Client(): S3Client {
		if (!this.client) {
			this.client = new S3Client(this.getS3ClientConfig());
		}
		return this.client;
	}

	private getS3ClientConfig(): S3ClientConfig {
		return {
			region: this.region,
			credentials: {
				accessKeyId: this.accessKeyId,
				secretAccessKey: this.secretAccessKey,
			},
			endpoint: this.endpoint,
			forcePathStyle: true,
		};
	}

	private getS3URL(key: string) {
		return this.endpoint
			? `${this.endpoint}/${this.bucket}/${key}`
			: `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;
	}
}
