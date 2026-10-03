import { IsEmail, IsString, Length } from 'class-validator';

export class LoginCodeDto {
  @IsEmail({}, { message: '邮箱格式不正确' })
  email: string;

  @IsString()
  @Length(6, 6, { message: '验证码为 6 位数字' })
  code: string;
}
