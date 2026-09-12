import { IsString } from 'class-validator';

export class LoginDto {
  @IsString()
  identifier: string; // 邮箱或用户名

  @IsString()
  password: string;
}
