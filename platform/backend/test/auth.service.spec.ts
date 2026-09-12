import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthService } from '../src/auth/auth.service';

describe('AuthService', () => {
  const user = {
    id: 'user-1',
    email: 'user@example.com',
    username: 'user1',
    passwordHash: 'hash',
    role: 'user' as const,
  };

  it('logs in and returns access and refresh tokens', async () => {
    const users = { findByEmailOrUsername: jest.fn().mockResolvedValue(user), sanitize: jest.fn().mockReturnValue({ id: user.id, username: user.username }) };
    const jwt = { sign: jest.fn().mockReturnValueOnce('access').mockReturnValueOnce('refresh') };
    const loginUser = { ...user, passwordHash: await bcrypt.hash('secret', 1) };
    users.findByEmailOrUsername.mockResolvedValue(loginUser);
    const service = new AuthService(users as never, jwt as never);

    const result = await service.login({ identifier: 'user1', password: 'secret' });
    expect(result.accessToken).toBe('access');
    expect(result.refreshToken).toBe('refresh');
    expect(users.findByEmailOrUsername).toHaveBeenCalledWith('user1');
  });

  it('rejects invalid credentials', async () => {
    const users = { findByEmailOrUsername: jest.fn().mockResolvedValue(null) };
    const service = new AuthService(users as never, { sign: jest.fn() } as never);
    await expect(service.login({ identifier: 'missing', password: 'secret' })).rejects.toThrow(UnauthorizedException);
  });
});
