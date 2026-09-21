import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { UserSyncData, SyncKind } from './user-sync-data.entity';
import { DownloadRecord } from '../reviews/download-record.entity';

interface LibraryItem {
  assetType: 'pet' | 'agent';
  assetId: string;
  downloadedAt: Date;
}

/**
 * 用户数据云同步：config / pet_state / chat_history 三类数据按用户存储。
 * config 中的 LLM API Key 等敏感字段以 AES-256-GCM 加密落库（密钥来自 SYNC_ENCRYPTION_KEY），
 * 响应时解密，防止拖库明文泄露。
 */
@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private readonly encryptionKey: Buffer;

  constructor(
    @InjectRepository(UserSyncData)
    private readonly repo: Repository<UserSyncData>,
    @InjectRepository(DownloadRecord)
    private readonly downloads: Repository<DownloadRecord>,
    private readonly config: ConfigService,
  ) {
    const secret = config.get<string>('SYNC_ENCRYPTION_KEY');
    if (!secret) {
      this.logger.warn('SYNC_ENCRYPTION_KEY 未设置，正在使用开发默认密钥（生产环境必须配置）');
    }
    // 任意长度口令派生为 256 位密钥
    this.encryptionKey = crypto
      .createHash('sha256')
      .update(secret ?? 'dev-sync-encryption-key-change-me')
      .digest();
  }

  /** 读取某类同步数据（config 的敏感字段已解密） */
  async getKind(userId: string, kind: SyncKind): Promise<{ data: unknown; updatedAt: Date | null }> {
    const row = await this.repo.findOne({ where: { userId, kind } });
    if (!row) return { data: null, updatedAt: null };
    const data = kind === 'config' ? this.unprotectConfig(row.data) : row.data;
    return { data, updatedAt: row.updatedAt };
  }

  /** 覆盖写入某类同步数据（config 的敏感字段加密后落库），返回服务端时间戳 */
  async putKind(userId: string, kind: SyncKind, data: unknown): Promise<{ updatedAt: Date }> {
    const stored = kind === 'config' ? this.protectConfig(data) : data;
    let row = await this.repo.findOne({ where: { userId, kind } });
    if (row) {
      row.data = stored;
    } else {
      row = this.repo.create({ userId, kind, data: stored });
    }
    await this.repo.save(row);
    return { updatedAt: row.updatedAt };
  }

  /** 用户资源库：下载记录去重（同资产取最近一次），供换设备重新下载 */
  async getLibrary(userId: string): Promise<LibraryItem[]> {
    const rows = await this.downloads
      .createQueryBuilder('d')
      .where('d.userId = :userId', { userId })
      .orderBy('d.downloadedAt', 'DESC')
      .getMany();
    const seen = new Set<string>();
    const items: LibraryItem[] = [];
    for (const row of rows) {
      const key = `${row.assetType}:${row.assetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ assetType: row.assetType, assetId: row.assetId, downloadedAt: row.downloadedAt });
    }
    return items;
  }

  // --- config 敏感字段加密（llmProfiles[].key 等） ---

  /** 判断是否为已加密密文 */
  private isCiphertext(value: string): boolean {
    return typeof value === 'string' && value.startsWith('enc:v1:');
  }

  private encryptString(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
  }

  private decryptString(value: string): string {
    if (!this.isCiphertext(value)) return value;
    const [, , ivB64, tagB64, dataB64] = value.split(':');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString(
      'utf8',
    );
  }

  /** 落库前：加密 config 中各 LLM profile 的 apiKey（幂等，已是密文则跳过） */
  private protectConfig(data: unknown): unknown {
    if (!data || typeof data !== 'object') return data;
    const clone = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
    if (Array.isArray(clone.llmProfiles)) {
      clone.llmProfiles = (clone.llmProfiles as Array<Record<string, unknown>>).map((profile) =>
        profile && typeof profile === 'object' &&
        typeof profile.apiKey === 'string' && profile.apiKey && !this.isCiphertext(profile.apiKey)
          ? { ...profile, apiKey: this.encryptString(profile.apiKey) }
          : profile,
      );
    }
    return clone;
  }

  /** 响应前：解密 config 中各 LLM profile 的 apiKey（明文原样返回） */
  private unprotectConfig(data: unknown): unknown {
    if (!data || typeof data !== 'object') return data;
    const clone = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
    if (Array.isArray(clone.llmProfiles)) {
      clone.llmProfiles = (clone.llmProfiles as Array<Record<string, unknown>>).map((profile) =>
        profile && typeof profile === 'object' &&
        typeof profile.apiKey === 'string' && this.isCiphertext(profile.apiKey)
          ? { ...profile, apiKey: this.decryptString(profile.apiKey) }
          : profile,
      );
    }
    return clone;
  }
}
