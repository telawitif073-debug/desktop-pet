import {
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { User } from '../users/user.entity';
import * as bcrypt from 'bcryptjs';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

export type TokenType = 'access' | 'refresh';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
  ) {}

  async register(dto: RegisterDto) {
    const user = await this.usersService.create(
      dto.email,
      dto.username,
      dto.password,
    );
    return this.buildAuthResponse(user);
  }

  async login(dto: LoginDto) {
    const user = await this.usersService.findByEmailOrUsername(dto.identifier);
    if (!user) throw new UnauthorizedException('账号或密码错误');
    const ok = await bcrypt.compare(dto.password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('账号或密码错误');
    return this.buildAuthResponse(user);
  }

  async refresh(refreshToken: string) {
    let payload: { sub: string; type: TokenType };
    try {
      payload = this.jwtService.verify(refreshToken);
    } catch {
      throw new UnauthorizedException('refreshToken 无效或已过期');
    }
    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('token 类型错误');
    }
    const user = await this.usersService.findById(payload.sub);
    return this.buildAuthResponse(user);
  }

  private buildAuthResponse(user: User) {
    return {
      user: this.usersService.sanitize(user),
      ...(this.signTokens(user)),
    };
  }

  private signTokens(user: User): TokenPair {
    const base = { sub: user.id, role: user.role };
    return {
      accessToken: this.jwtService.sign(
        { ...base, type: 'access' },
        { expiresIn: process.env.JWT_ACCESS_EXPIRES || '12h' },
      ),
      refreshToken: this.jwtService.sign(
        { ...base, type: 'refresh' },
        { expiresIn: process.env.JWT_REFRESH_EXPIRES || '7d' },
      ),
    };
  }
}
