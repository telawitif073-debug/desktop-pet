import { BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import { PetPacksService } from '../src/pet-packs/pet-packs.service';
import { makeIconOnlyPackZip, makePng, makeValidPackZip } from './pack-fixtures';

/** 最小 multer 文件替身（memoryStorage 形态：带 buffer） */
const fileOf = (originalname: string, mimetype: string, buffer: Buffer): Express.Multer.File =>
  ({ originalname, mimetype, buffer, size: buffer.length } as Express.Multer.File);

function makeService() {
  const repo = {
    create: jest.fn((value: unknown) => value),
    save: jest.fn(async (value: unknown) => ({ id: 'pack-1', ...(value as object) })),
  };
  const storage = {
    upload: jest.fn(async () => '/uploads/stored.zip'),
    remove: jest.fn(async () => undefined),
  };
  const reviews = {};
  const service = new PetPacksService(repo as never, reviews as never, storage as never);
  return { service, repo, storage };
}

const dto = { name: '测试宠物' };

describe('PetPacksService.publish · 发布门禁与派生字段', () => {
  it('不合格包：上游校验即 400，且不落盘、不写库（无孤儿文件）', async () => {
    const { service, repo, storage } = makeService();
    const pack = fileOf('pack.zip', 'application/zip', makeIconOnlyPackZip());

    await expect(service.publish({ pack, dto, authorId: 'admin-1' })).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('合格包：写库为 pending，sha256/body_kinds/manifest 全部由服务端派生', async () => {
    const { service, repo, storage } = makeService();
    const zip = makeValidPackZip();
    const pack = fileOf('pack.zip', 'application/zip', zip);

    const saved = (await service.publish({
      pack,
      dto: { ...dto, description: '一只测试猫', category: 'cat', tags: '["可爱","像素"]', version: '1.2.0' },
      authorId: 'admin-1',
    })) as unknown as Record<string, unknown>;

    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(saved.status).toBe('pending');
    expect(saved.packUrl).toBe('/uploads/stored.zip');
    expect(saved.packSha256).toBe(crypto.createHash('sha256').update(zip).digest('hex'));
    expect(saved.packBytes).toBe(zip.length);
    expect(saved.bodyKinds).toEqual(['body-still']);
    expect(saved.tags).toEqual(['可爱', '像素']);
    expect(saved.version).toBe('1.2.0');
    expect(saved.packSchemaVersion).toBe(1);
    const manifest = saved.manifest as { entryCount: number; entry: { path: string } | null };
    expect(manifest.entryCount).toBe(1);
    expect(manifest.entry?.path).toBe('pet/body.png');
  });

  it('默认值：version 回落到 1.0.0；tags 支持逗号分隔', async () => {
    const { service } = makeService();
    const saved = (await service.publish({
      pack: fileOf('pack.zip', 'application/zip', makeValidPackZip()),
      dto: { ...dto, tags: 'a, b ,, c' },
      authorId: 'admin-1',
    })) as unknown as Record<string, unknown>;
    expect(saved.version).toBe('1.0.0');
    expect(saved.tags).toEqual(['a', 'b', 'c']);
  });

  it('带封面：封面单独上传并写入 preview_url', async () => {
    const { service, storage } = makeService();
    storage.upload
      .mockResolvedValueOnce('/uploads/pack.zip')
      .mockResolvedValueOnce('/uploads/preview.png');

    const saved = (await service.publish({
      pack: fileOf('pack.zip', 'application/zip', makeValidPackZip()),
      preview: fileOf('preview.png', 'image/png', makePng(256, 256)),
      dto,
      authorId: 'admin-1',
    })) as unknown as Record<string, unknown>;

    expect(storage.upload).toHaveBeenCalledTimes(2);
    expect(saved.packUrl).toBe('/uploads/pack.zip');
    expect(saved.previewUrl).toBe('/uploads/preview.png');
  });

  it('落盘失败：向上抛错且不写库', async () => {
    const { service, repo, storage } = makeService();
    storage.upload.mockRejectedValueOnce(new Error('磁盘写入失败'));

    await expect(
      service.publish({ pack: fileOf('pack.zip', 'application/zip', makeValidPackZip()), dto, authorId: 'admin-1' }),
    ).rejects.toThrow('磁盘写入失败');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('写库失败：回滚已上传的包体与封面（不留孤儿文件）', async () => {
    const { service, repo, storage } = makeService();
    storage.upload
      .mockResolvedValueOnce('/uploads/pack.zip')
      .mockResolvedValueOnce('/uploads/preview.png');
    repo.save.mockRejectedValueOnce(new Error('DB down'));

    await expect(
      service.publish({
        pack: fileOf('pack.zip', 'application/zip', makeValidPackZip()),
        preview: fileOf('preview.png', 'image/png', makePng(256, 256)),
        dto,
        authorId: 'admin-1',
      }),
    ).rejects.toThrow('DB down');

    expect(storage.remove).toHaveBeenCalledWith('/uploads/pack.zip');
    expect(storage.remove).toHaveBeenCalledWith('/uploads/preview.png');
  });
});
