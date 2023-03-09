import {
	IncomingFile,
	UploadResponse,
	WebResourceHandler,
} from '../webresource-handler';

export class NoopHandler implements WebResourceHandler {
	public async handleFile(resource: IncomingFile): Promise<UploadResponse> {
		// handleFile must consume the file stream
		resource.stream.resume();
		return {
			filename: 'noop',
			size: 0,
		};
	}

	public async removeFile(_fileReference: string): Promise<void> {
		return;
	}
}
