import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * 注册请求（兼容两种流程）：
 * - 带 code：新流程（邮箱 + 验证码 + 密码，username 可缺省取邮箱前缀），password ≥8 位
 * - 不带 code：旧流程（桌面端兼容，email/username/password 全必填），password ≥6 位
 * 字段是否必填由 AuthService 按流程校验（class-validator 层全部放宽为可选）。
 */
export class RegisterDto {
  @IsEmail({}, { message: '邮箱格式不正确' })
  @IsOptional()
  email?: string;

  @IsString()
  @MinLength(2, { message: '用户名至少 2 个字符' })
  @MaxLength(50)
  @IsOptional()
  username?: string;

  @IsString()
  @MinLength(6, { message: '密码至少 6 位' })
  @MaxLength(64)
  @IsOptional()
  password?: string;

  /** 邮箱验证码（6 位数字；存在即走验证码注册流程） */
  @IsString()
  @IsOptional()
  code?: string;
}
