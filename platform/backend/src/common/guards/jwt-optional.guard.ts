import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** 可选认证：有有效 token 就注入 user，否则放行且 user 为 null */
@Injectable()
export class JwtOptionalGuard extends AuthGuard('jwt') {
  handleRequest<TUser = any>(err: any, user: any): TUser {
    return (user ?? null) as TUser;
  }
}
