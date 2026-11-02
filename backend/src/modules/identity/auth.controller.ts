import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { LoginSchema, MfaVerifySchema, PinLoginSchema, SetupPasswordSchema, StepUpSchema } from '@pos/shared';
import type { Response } from 'express';
import type { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import type { RequestWithContext } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { Public, RequiresDevice } from '../access/decorators.js';
import { auditContext, requestMeta } from '../audit/audit-context.js';
import { AuthService } from './auth.service.js';
import { clearRefreshCookie, REFRESH_COOKIE, setRefreshCookie, TENANT_COOKIE_PATH } from './cookies.js';
import { SessionService } from './session.service.js';
import { StepUpService } from './step-up.service.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly stepUp: StepUpService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Req() req: RequestWithContext,
    @Body(new ZodPipe(LoginSchema)) body: z.infer<typeof LoginSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(req.tenant!, body, requestMeta(req));
    if (result.status !== 'ok') return result;
    setRefreshCookie(res, result.session.refreshToken, TENANT_COOKIE_PATH);
    return { status: 'ok', accessToken: result.session.accessToken };
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(200)
  async verifyMfa(
    @Req() req: RequestWithContext,
    @Body(new ZodPipe(MfaVerifySchema)) body: z.infer<typeof MfaVerifySchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.auth.verifyMfa(req.tenant!, body, requestMeta(req));
    setRefreshCookie(res, session.refreshToken, TENANT_COOKIE_PATH);
    return { status: 'ok', accessToken: session.accessToken };
  }

  @Public()
  @Post('setup-password')
  @HttpCode(204)
  async setupPassword(@Req() req: RequestWithContext, @Body(new ZodPipe(SetupPasswordSchema)) body: z.infer<typeof SetupPasswordSchema>) {
    await this.auth.setupPassword(req.tenant!, body, requestMeta(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: RequestWithContext, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (!token) throw AppError.unauthenticated('No session');
    const session = await this.sessions.rotate(req.tenant!.id, token, req.device?.id ?? null);
    setRefreshCookie(res, session.refreshToken, TENANT_COOKIE_PATH);
    return { accessToken: session.accessToken };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: RequestWithContext, @Res({ passthrough: true }) res: Response) {
    if (req.principal?.sessionId) await this.sessions.revoke(req.tenant!.id, req.principal.sessionId);
    clearRefreshCookie(res, TENANT_COOKIE_PATH);
  }

  @Public()
  @RequiresDevice()
  @Post('pin')
  @HttpCode(200)
  async pin(
    @Req() req: RequestWithContext,
    @Body(new ZodPipe(PinLoginSchema)) body: z.infer<typeof PinLoginSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.auth.pinLogin(req.tenant!, req.device!, body, requestMeta(req));
    setRefreshCookie(res, session.refreshToken, TENANT_COOKIE_PATH);
    return { status: 'ok', accessToken: session.accessToken };
  }

  @RequiresDevice()
  @Post('step-up')
  @HttpCode(200)
  stepUpApprove(@Req() req: RequestWithContext, @Body(new ZodPipe(StepUpSchema)) body: z.infer<typeof StepUpSchema>) {
    return this.stepUp.approve(req.tenant!, req.device!, req.principal!.userId, body, auditContext(req));
  }
}
