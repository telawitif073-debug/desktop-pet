import { ForbiddenException } from '@nestjs/common';
import { PetsService } from '../src/pets/pets.service';

describe('PetsService', () => {
  it('blocks non-owner edits', async () => {
    const pet = { id: 'pet-1', authorId: 'owner-1', status: 'approved' };
    const repo = { findOne: jest.fn().mockResolvedValue(pet), save: jest.fn() };
    const service = new PetsService(repo as never, { recordDownload: jest.fn() } as never, { remove: jest.fn() } as never);

    await expect(service.update('pet-1', { name: 'changed' }, 'other-user', false)).rejects.toThrow(ForbiddenException);
  });

  it('increments downloads and records the download', async () => {
    const repo = { increment: jest.fn().mockResolvedValue(undefined) };
    const reviews = { recordDownload: jest.fn().mockResolvedValue(undefined) };
    const service = new PetsService(repo as never, reviews as never, { remove: jest.fn() } as never);

    await service.recordDownload('pet-1', 'user-1');
    expect(reviews.recordDownload).toHaveBeenCalledWith('pet', 'pet-1', 'user-1');
    expect(repo.increment).toHaveBeenCalledWith({ id: 'pet-1' }, 'downloads', 1);
  });
});
