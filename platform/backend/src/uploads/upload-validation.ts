import { BadRequestException } from '@nestjs/common';
import * as path from 'path';

const MIME_BY_EXTENSION: Record<string, Set<string>> = {
  '.png': new Set(['image/png']),
  '.jpg': new Set(['image/jpeg']),
  '.jpeg': new Set(['image/jpeg']),
  '.gif': new Set(['image/gif']),
  '.webp': new Set(['image/webp']),
  '.svg': new Set(['image/svg+xml', 'application/xml', 'text/xml']),
  '.zip': new Set(['application/zip', 'application/x-zip-compressed', 'application/octet-stream']),
  '.tar': new Set(['application/x-tar', 'application/octet-stream']),
  '.gz': new Set(['application/gzip', 'application/x-gzip', 'application/octet-stream']),
  '.json': new Set(['application/json', 'text/json', 'text/plain']),
  '.txt': new Set(['text/plain']),
};

export const UPLOAD_EXTENSIONS = new Set(Object.keys(MIME_BY_EXTENSION));

export function validateUploadMetadata(originalname: string, mimetype: string) {
  const extension = path.extname(originalname).toLowerCase();
  const allowedMimes = MIME_BY_EXTENSION[extension];
  if (!allowedMimes) throw new BadRequestException(`不支持的文件扩展名: ${extension || '未知'}`);
  if (!allowedMimes.has(mimetype.toLowerCase())) {
    throw new BadRequestException(`文件 MIME 类型与扩展名不匹配: ${mimetype}`);
  }
  return extension;
}

export function validateUploadFile(file: Pick<Express.Multer.File, 'originalname' | 'mimetype' | 'buffer'>) {
  const extension = path.extname(file.originalname).toLowerCase();
  const allowedMimes = MIME_BY_EXTENSION[extension];
  if (!allowedMimes) {
    throw new BadRequestException(`不支持的文件扩展名: ${extension || '未知'}`);
  }
  if (!allowedMimes.has(file.mimetype.toLowerCase())) {
    throw new BadRequestException(`文件 MIME 类型与扩展名不匹配: ${file.mimetype}`);
  }

  const bytes = file.buffer;
  if (extension === '.png' && !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new BadRequestException('PNG 文件内容无效');
  }
  if ((extension === '.jpg' || extension === '.jpeg') && !(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) {
    throw new BadRequestException('JPEG 文件内容无效');
  }
  if (extension === '.gif' && bytes.subarray(0, 3).toString() !== 'GIF') {
    throw new BadRequestException('GIF 文件内容无效');
  }
  if (extension === '.webp' && (bytes.subarray(0, 4).toString() !== 'RIFF' || bytes.subarray(8, 12).toString() !== 'WEBP')) {
    throw new BadRequestException('WEBP 文件内容无效');
  }
  if (extension === '.zip' && bytes.subarray(0, 2).toString() !== 'PK') {
    throw new BadRequestException('ZIP 文件内容无效');
  }
  return extension;
}
