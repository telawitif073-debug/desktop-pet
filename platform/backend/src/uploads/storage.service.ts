import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as net from 'net';
import { validateUploadFile } from './upload-validation';

@Injectable()
export class StorageService {
  private readonly driver: 'local' | 's3';
  private readonly uploadsDir: string;
  private readonly bucket: string;
  private readonly publicUrl: string;
  private readonly client?: S3Client;

  constructor(private readonly config: ConfigService) {
    this.driver = config.get<'local' | 's3'>('STORAGE_DRIVER', 'local');
    this.uploadsDir = path.resolve(process.cwd(), 'uploads');
    this.bucket = config.get<string>('S3_BUCKET', 'desktop-pet');
    this.publicUrl = config.get<string>('STORAGE_PUBLIC_URL', '').replace(/\/$/, '');
    if (this.driver === 's3') {
      this.client = new S3Client({
        region: config.get<string>('S3_REGION', 'us-east-1'),
        endpoint: config.get<string>('STORAGE_ENDPOINT') || undefined,
        forcePathStyle: Boolean(config.get<string>('STORAGE_ENDPOINT')),
        credentials: {
          accessKeyId: config.get<string>('S3_ACCESS_KEY', ''),
          secretAccessKey: config.get<string>('S3_SECRET_KEY', ''),
        },
      });
    }
  }

  async upload(file: Express.Multer.File): Promise<string> {
    const extension = validateUploadFile(file);
    await this.scanForVirus(file.buffer);
    const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${extension}`;
    if (this.driver === 's3' && this.client) {
      const key = `assets/${filename}`;
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      }));
      return this.publicUrl ? `${this.publicUrl}/${key}` : `${this.config.get<string>('STORAGE_ENDPOINT', '').replace(/\/$/, '')}/${this.bucket}/${key}`;
    }

    await fs.mkdir(this.uploadsDir, { recursive: true });
    await fs.writeFile(path.join(this.uploadsDir, filename), file.buffer);
    return `/uploads/${filename}`;
  }

  async remove(fileUrl?: string | null) {
    if (!fileUrl) return;
    if (this.driver === 's3' && this.client) {
      const marker = `${this.bucket}/`;
      const index = fileUrl.indexOf(marker);
      const key = index >= 0 ? fileUrl.slice(index + marker.length) : fileUrl.split('/').slice(-2).join('/');
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      return;
    }
    if (fileUrl.startsWith('/uploads/')) {
      await fs.rm(path.resolve(process.cwd(), fileUrl.slice(1)), { force: true });
    }
  }

  private async scanForVirus(buffer: Buffer) {
    const host = this.config.get<string>('CLAMAV_HOST');
    if (!host) return;
    const port = Number(this.config.get<string>('CLAMAV_PORT', '3310'));
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      let response = '';
      socket.setTimeout(30_000);
      socket.on('connect', () => {
        socket.write('zINSTREAM\\0');
        for (let offset = 0; offset < buffer.length; offset += 64 * 1024) {
          const chunk = buffer.subarray(offset, offset + 64 * 1024);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length, 0);
          socket.write(size);
          socket.write(chunk);
        }
        const end = Buffer.alloc(4);
        socket.write(end);
      });
      socket.on('data', (data) => { response += data.toString(); });
      socket.on('timeout', () => socket.destroy(new Error('ClamAV 扫描超时')));
      socket.on('error', reject);
      socket.on('close', () => {
        if (response.includes('OK')) resolve();
        else reject(new Error(`ClamAV 拒绝文件: ${response || '无响应'}`));
      });
    });
  }
}
