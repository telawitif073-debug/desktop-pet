import { IsJWT } from 'class-validator';

export class RefreshDto {
  @IsJWT({ message: 'refreshToken 格式不正确' })
  refreshToken: string;
}
