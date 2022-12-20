import type * as Express from 'express';
import * as multer from 'multer';

/**
 * Convert files created by multer to properties on the body
 *
 * @param app Express app
 */
export const handleMultipartRequest: Express.Handler = (req, _res, next) => {
	if (req.files && Array.isArray(req.files)) {
		for (const file of req.files) {
			req.body[file.fieldname] = {
				filename: file.originalname,
				contentType: file.mimetype,
				size: file.size,
				data: file.buffer,
				storage: process.env.PINEJS_STORAGE_ENGINE,
			};
		}
	}
	next();
};

let maxFileSize: number;
if (process.env.PINEJS_MAX_FILE_SIZE) {
	maxFileSize = parseInt(process.env.PINEJS_MAX_FILE_SIZE, 10);
	if (Number.isNaN(maxFileSize) || maxFileSize <= 0) {
		throw new Error(
			`Invalid value for PINEJS_MAX_FILE_SIZE: ${process.env.PINEJS_MAX_FILE_SIZE}`,
		);
	}
} else {
	maxFileSize = 1024 * 1024 * 1024 * 2; // 2GB
}

export const multerPinejs = multer({
	limits: {
		fileSize: maxFileSize,
	},
}).any();
