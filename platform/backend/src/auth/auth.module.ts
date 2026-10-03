import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { UsersModule } from '../users/users.module';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { EmailCodeService } from './email-code.service';

@Module({
  imports: [
    UsersModule,
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'dev-secret-change-me-in-production',
      signOptions: {},
    }),
  ],
  providers: [AuthService, JwtStrategy, EmailCodeService],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}
