import { BadRequestException } from '@nestjs/common';
import { validateUploadFile } from '../src/uploads/upload-validation';

describe('upload validation', () => {
  it('accepts a valid PNG with matching MIME and signature', () => {
    expect(validateUploadFile({
      originalname: 'pet.png',
      mimetype: 'image/png',
      buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    })).toBe('.png');
  });

  it('rejects a mismatched MIME type', () => {
    expect(() => validateUploadFile({
      originalname: 'pet.png',
      mimetype: 'text/plain',
      buffer: Buffer.alloc(8),
    })).toThrow(BadRequestException);
  });

  it('rejects a spoofed image signature', () => {
    expect(() => validateUploadFile({
      originalname: 'pet.jpg',
      mimetype: 'image/jpeg',
      buffer: Buffer.from('not an image'),
    })).toThrow('JPEG 文件内容无效');
  });
});
