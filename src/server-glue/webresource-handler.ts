import type * as Express from 'express';
import * as busboy from 'busboy';
import * as is from 'type-is';
import * as stream from 'stream';
import * as uriParser from '../sbvr-api/uri-parser';
import { getApiRoot, getModels } from '../sbvr-api/sbvr-utils';
import { checkPermissions } from '../sbvr-api/permissions';
import * as sbvrUtils from '../sbvr-api/sbvr-utils';
import { S3Handler } from './webresource-handlers/S3Handler';
import { NoopHandler } from './webresource-handlers/NoopHandler';
import {
	odataNameToSqlName,
	sqlNameToODataName,
} from '@balena/odata-to-abstract-sql';
import { permissions } from './module';

export interface IncomingFile {
	fieldname: string;
	originalname: string;
	encoding: string;
	mimetype: string;
	stream: stream.Readable;
}

export interface UploadResponse {
	size: number;
	filename: string;
}

export interface WebResourceHandler {
	handleFile: (resource: IncomingFile) => Promise<UploadResponse>;
	removeFile: (fileReference: string) => Promise<void>;
}

type WebResourcesDbResponse =
	| {
			[fieldname: string]: { href: string } | undefined;
	  }
	| undefined;

const ifFileInValidPath = async (
	fieldname: string,
	req: Express.Request,
): Promise<boolean> => {
	if (req.method !== 'POST' && req.method !== 'PATCH') {
		return false;
	}

	const models = getModels();
	const apiRoot = getApiRoot(req);
	const { resourceName } = await uriParser.parseOData({
		url: req.url,
		method: req.method,
	});
	if (apiRoot === null || models[apiRoot] === null) {
		return false;
	}

	const permission = req.method === 'POST' ? 'create' : 'update';
	const vocab = models[apiRoot].translateTo ?? models[apiRoot].vocab;
	const hasPermissions = await checkPermissions(
		req,
		permission,
		resourceName,
		vocab,
	);

	if (!hasPermissions) {
		return false;
	}

	// TODO: This could be cached
	const fields = models[apiRoot].abstractSql.tables[resourceName].fields;
	const dbFieldName = odataNameToSqlName(fieldname);
	for (const field of fields) {
		if (field.fieldName === dbFieldName && field.dataType === 'WebResource') {
			return true;
		}
	}

	// TODO: We could do a pre-check if there is a SBVR rule specifying file max size
	// This would avoid needing the roundtrip to DB and uploading a file just to remove it

	return false;
};

export const getUploaderMiddlware = (
	handler: WebResourceHandler,
): Express.RequestHandler => {
	const completeUploads: Array<Promise<void>> = [];
	const filesUploaded: string[] = [];

	return async (req, _res, next) => {
		if (!is(req, ['multipart'])) {
			return next();
		}

		const bb = busboy({ headers: req.headers });
		let isAborting = false;

		const done = () => {
			req.unpipe(bb);
			req.on('readable', req.read.bind(req));
			bb.removeAllListeners();
		};

		const clearFiles = () => {
			isAborting = true;
			const deletions = filesUploaded.map((file) => handler.removeFile(file));
			// Best effort: We try to remove all uploaded files, but if this fails, there is not much to do
			return Promise.all(deletions).catch((err) =>
				console.error('Error deleting file', err),
			);
		};

		bb.on('file', async (fieldname, filestream, info) => {
			if (!isAborting && (await ifFileInValidPath(fieldname, req))) {
				const file: IncomingFile = {
					originalname: info.filename,
					encoding: info.encoding,
					mimetype: info.mimeType,
					stream: filestream,
					fieldname,
				};
				const promise = handler.handleFile(file).then((result) => {
					req.body[fieldname] = {
						filename: info.filename,
						contentType: info.mimeType,
						contentDisposition: undefined,
						size: result.size,
						href: result.filename,
					};
					filesUploaded.push(result.filename);
				});
				completeUploads.push(promise);
			} else {
				filestream.resume();
			}
		});

		bb.on('field', (name, val, _info) => {
			req.body[name] = val;
		});

		bb.on('finish', async () => {
			try {
				await Promise.all(completeUploads);
				done();
				next();
			} catch (err) {
				console.error('Error uploading file', err);
				await clearFiles();
				next(err);
			}
		});

		bb.on('error', async (err) => {
			await clearFiles();
			done();
			next(err);
		});
		req.pipe(bb);
	};
};

// TODO: this can be cached
const getWebResourceFields = (request: uriParser.ODataRequest): string[] => {
	if (!request.abstractSqlModel?.tables[request.resourceName]?.fields) {
		return [];
	}

	return request.abstractSqlModel?.tables[request.resourceName].fields
		.filter((f) => f.dataType === 'WebResource')
		.map((f) => sqlNameToODataName(f.fieldName));
};

const getModifiedFields = (request: uriParser.ODataRequest): string[] => {
	const modifiedFields = request.modifiedFields;

	const allModifiedFields: string[] = [];
	if (modifiedFields) {
		if (Array.isArray(modifiedFields)) {
			for (const modifiedField of modifiedFields) {
				if (modifiedField?.fields) {
					modifiedField.fields.forEach((f) => allModifiedFields.push(f));
				}
			}
		} else {
			if (modifiedFields.fields) {
				modifiedFields.fields.forEach((f) => allModifiedFields.push(f));
			}
		}
	}

	return allModifiedFields;
};

const deleteFiles = async (
	keysToDelete: string[],
	webResourceHandler: WebResourceHandler,
) => {
	const promises = keysToDelete.map((r) => webResourceHandler.removeFile(r));
	await Promise.all(promises);
};

const getCreateWebResourceHook = (webResourceHandler: WebResourceHandler) => {
	return {
		'POSTRUN-ERROR': async ({ tx, request }) => {
			tx?.on('rollback', async () => {
				const fields = getWebResourceFields(request);

				if (!fields || fields.length === 0) {
					return;
				}

				const keysToDelete: string[] = fields.map(
					(f) => request.values[f].href,
				);
				await deleteFiles(keysToDelete, webResourceHandler);
			});
		},
	} as sbvrUtils.Hooks;
};

const getWebResourcesHrefs = (webResources?: WebResourcesDbResponse[]) => {
	const hrefs: string[] = [];
	if (webResources && webResources.length > 0) {
		for (const resource of webResources) {
			if (resource) {
				for (const resourceKey of Object.values(resource)) {
					if (resourceKey) {
						hrefs.push(resourceKey.href);
					}
				}
			}
		}
	}
	return hrefs;
};

const getRemoveWebResourceHook = (webResourceHandler: WebResourceHandler) => {
	return {
		PRERUN: async (args) => {
			const { api, request } = args;
			let fields = getWebResourceFields(request);

			if (!fields || fields.length === 0) {
				return;
			}

			if (request.method === 'PATCH') {
				const allFields = getModifiedFields(request).map(sqlNameToODataName);
				fields = fields.filter((f) => allFields.includes(f));
			}

			if (!fields || fields.length === 0) {
				return;
			}

			const ids = await sbvrUtils.getAffectedIds(args);
			if (ids.length === 0) {
				return;
			}

			const webResources = (await api.get({
				resource: request.resourceName,
				passthrough: {
					tx: args.tx,
					req: permissions.root,
				},
				options: {
					$select: fields,
					$filter: {
						id: {
							$in: ids,
						},
					},
				},
			})) as WebResourcesDbResponse[] | undefined;

			request.custom.$pineWebResourcesToDelete =
				getWebResourcesHrefs(webResources);
		},
		POSTRUN: async ({ tx, request }) => {
			tx.on('end', async () => {
				const keysToDelete: string[] =
					request.custom.$pineWebResourcesToDelete || [];
				await deleteFiles(keysToDelete, webResourceHandler);
			});
		},
	} as sbvrUtils.Hooks;
};

export const getDefaultHandler = (): WebResourceHandler => {
	let handler: WebResourceHandler;
	try {
		handler = new S3Handler();
	} catch (e) {
		console.warn(`Failed to initialize S3 handler, using noop ${e}`);
		handler = new NoopHandler();
	}
	return handler;
};

export const setupUploadHooks = (
	handler: WebResourceHandler,
	apiRoot?: string,
) => {
	if (apiRoot) {
		sbvrUtils.addPureHook(
			'PATCH',
			apiRoot,
			'all',
			getRemoveWebResourceHook(handler),
		);

		sbvrUtils.addPureHook(
			'DELETE',
			apiRoot,
			'all',
			getRemoveWebResourceHook(handler),
		);

		sbvrUtils.addPureHook(
			'POST',
			apiRoot,
			'all',
			getCreateWebResourceHook(handler),
		);
	}
};
