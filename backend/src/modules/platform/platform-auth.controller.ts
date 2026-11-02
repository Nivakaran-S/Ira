import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { LoginSchema, MfaVerifySchema, SetupPasswordSchema } from '@pos/shared';
import type { Response } from 'express';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { Public, Realm } from '../access/decorators.js';
import { requestMeta } from '../audit/audit-context.js';
import { clearRefreshCookie, PLATFORM_COOKIE_PATH, REFRESH_COOKIE, setRefreshCookie } from '../identity/cookies.js';
import { PlatformAuthService } from './platform-auth.service.js';
import { PlatformSessionService } from './platform-session.service.js';

@Realm('platform')
@Controller('platform/auth')
export class PlatformAuthController {
  constructor(
    private readonly auth: PlatformAuthService,
    private readonly sessions: PlatformSessionService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Req() req: RequestWithContext, @Body(new ZodPipe(LoginSchema)) body: z.infer<typeof LoginSchema>) {
    return this.auth.login(body, requestMeta(req));
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(200)
  async verify(
    @Req() req: RequestWithContext,
    @Body(new ZodPipe(MfaVerifySchema)) body: z.infer<typeof MfaVerifySchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.auth.verifyMfa(body, requestMeta(req));
    setRefreshCookie(res, session.refreshToken, PLATFORM_COOKIE_PATH);
    return { status: 'ok', accessToken: session.accessToken };
  }

  @Public()
  @Post('setup-password')
  @HttpCode(204)
  async setupPassword(@Req() req: RequestWithContext, @Body(new ZodPipe(SetupPasswordSchema)) body: z.infer<typeof SetupPasswordSchema>) {
    await this.auth.setupPassword(body, requestMeta(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: RequestWithContext, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!token) throw AppError.unauthenticated('No session');
    const session = await this.sessions.rotate(token);
    setRefreshCookie(res, session.refreshToken, PLATFORM_COOKIE_PATH);
    return { accessToken: session.accessToken };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: RequestWithContext, @Res({ passthrough: true }) res: Response) {
    if (req.principal?.sessionId) await this.sessions.revoke(req.principal.sessionId);
    clearRefreshCookie(res, PLATFORM_COOKIE_PATH);
  }
}
