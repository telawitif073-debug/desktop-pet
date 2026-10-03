import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';
import { User } from '../users/user.entity';
import * as bcrypt from 'bcryptjs';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { SendCodeDto } from './dto/send-code.dto';
import { LoginCodeDto } from './dto/login-code.dto';
import { EmailCodeService, CodePurpose } from './email-code.service';

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
    private readonly emailCode: EmailCodeService,
  ) {}

  /** 发送邮箱验证码（注册前检查邮箱未占用 / 登录前检查已注册，DeepSeek 同款「不隐瞒」策略） */
  async sendCode(dto: SendCodeDto) {
    const email = dto.email.trim();
    const exists = await this.usersService.findByEmailOrUsername(email);
    if (dto.purpose === 'register' && exists) {
      throw new ConflictException('该邮箱已注册，请直接登录');
    }
    if (dto.purpose === 'login' && !exists) {
      throw new BadRequestException('该邮箱尚未注册，请先注册');
    }
    return this.emailCode.issue(email, dto.purpose);
  }

  async register(dto: RegisterDto) {
    if (dto.code) {
      // 新流程：邮箱 + 验证码 + 密码（App 端 DeepSeek 式注册）
      if (!dto.email) throw new BadRequestException('请填写邮箱');
      if (!dto.password || dto.password.length < 8) {
        throw new BadRequestException('密码至少 8 位');
      }
      const email = dto.email.trim();
      const exists = await this.usersService.findByEmailOrUsername(email);
      if (exists) throw new ConflictException('该邮箱已注册，请直接登录');
      // 用户名缺省取邮箱前缀；前缀被占用时自动追加短随机后缀，避免卡住注册
      let username = (dto.username?.trim() || email.split('@')[0]).slice(0, 50);
      if (!dto.username?.trim()) {
        const taken = await this.usersService.findByEmailOrUsername(username);
        if (taken) username = `${username.slice(0, 46)}${Math.floor(1000 + Math.random() * 9000)}`;
      }
      this.emailCode.verify(email, 'register' as CodePurpose, dto.code);
      const user = await this.usersService.create(email, username, dto.password);
      return this.buildAuthResponse(user);
    }
    // 旧流程：桌面端兼容（email/username/password 全必填）
    if (!dto.email || !dto.username || !dto.password) {
      throw new BadRequestException('email、username、password 均为必填');
    }
    const user = await this.usersService.create(dto.email, dto.username, dto.password);
    return this.buildAuthResponse(user);
  }

  /** 验证码登录：无需密码，验证码验证通过即发双令牌 */
  async loginCode(dto: LoginCodeDto) {
    const email = dto.email.trim();
    this.emailCode.verify(email, 'login' as CodePurpose, dto.code);
    const user = await this.usersService.findByEmailOrUsername(email);
    if (!user) throw new UnauthorizedException('该邮箱尚未注册，请先注册');
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
