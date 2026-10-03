import { IsEmail, IsIn } from 'class-validator';

export class SendCodeDto {
  @IsEmail({}, { message: '邮箱格式不正确' })
  email: string;

  /** register=注册验证码；login=验证码登录 */
  @IsIn(['register', 'login'], { message: 'purpose 只能是 register 或 login' })
  purpose: 'register' | 'login';
}
