import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail({}, { message: '邮箱格式不正确' })
  email: string;

  @IsString()
  @MinLength(2, { message: '用户名至少 2 个字符' })
  @MaxLength(50)
  username: string;

  @IsString()
  @MinLength(6, { message: '密码至少 6 位' })
  @MaxLength(64)
  password: string;
}
