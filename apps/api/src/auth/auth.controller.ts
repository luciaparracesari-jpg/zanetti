import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { changePasswordSchema, loginSchema } from '@erp/shared';
import { CurrentActor, type Actor, type ErpRequest } from '../common/actor';
import { parse } from '../common/zod';
import { AllowPendingPassword, AuthOnly, Public } from './decorators';
import { AuthService } from './auth.service';
import { SESSION_COOKIE, sessionTtlMs } from './session.service';

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.COOKIE_SECURE === 'true',
  path: '/',
});

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async login(@Body() body: unknown, @Req() req: ErpRequest, @Res({ passthrough: true }) res: Response) {
    const { email, password } = parse(loginSchema, body);
    const { token, mustChangePassword } = await this.auth.login(
      email,
      password,
      req.ip ?? null,
      req.get('user-agent') ?? null,
    );
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), maxAge: sessionTtlMs() });
    return { ok: true, mustChangePassword };
  }

  @Post('logout')
  @AuthOnly()
  @AllowPendingPassword()
  @HttpCode(200)
  async logout(@CurrentActor() actor: Actor, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(actor);
    res.clearCookie(SESSION_COOKIE, cookieOptions());
    return { ok: true };
  }

  @Get('me')
  @AuthOnly()
  @AllowPendingPassword()
  me(@CurrentActor() actor: Actor) {
    return {
      id: actor.id,
      email: actor.email,
      name: actor.name,
      roles: actor.roles,
      permissions: [...actor.permissions].sort(),
      warehouseIds: actor.warehouseIds,
      mustChangePassword: actor.mustChangePassword,
    };
  }

  @Post('password')
  @AuthOnly()
  @AllowPendingPassword()
  @HttpCode(200)
  async changePassword(@CurrentActor() actor: Actor, @Body() body: unknown) {
    const { currentPassword, newPassword } = parse(changePasswordSchema, body);
    await this.auth.changePassword(actor, currentPassword, newPassword);
    return { ok: true };
  }
}
