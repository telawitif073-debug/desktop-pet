import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';

export type CodePurpose = 'register' | 'login';

interface CodeEntry {
  code: string;
  purpose: CodePurpose;
  expiresAt: number;
}

/** 验证码有效期：10 分钟 */
const TTL_MS = 10 * 60 * 1000;
/** 同一邮箱重发冷却：60 秒 */
const RESEND_COOLDOWN_MS = 60 * 1000;
/** 同一邮箱每日发送上限（防轰炸） */
const DAILY_LIMIT = 10;

/**
 * 邮箱验证码服务（内存存储，重启即失效——验证码本就是短时效一次性凭证）。
 * 发送通道：配置了 SMTP_* 环境变量时用 nodemailer 发信；
 * 否则仅在 AUTH_DEV_CODE_ECHO=true 时把验证码回显在响应里（开发/联调用）；
 * 两者都没配则返回 503，绝不静默泄漏验证码。
 */
@Injectable()
export class EmailCodeService {
  private readonly codes = new Map<string, CodeEntry>();
  private readonly lastSentAt = new Map<string, number>();
  private readonly daily = new Map<string, { date: string; count: number }>();

  async issue(email: string, purpose: CodePurpose): Promise<{ sent: boolean; devCode?: string; devMode?: boolean }> {
    const key = email.trim().toLowerCase();
    const now = Date.now();
    const last = this.lastSentAt.get(key) ?? 0;
    if (now - last < RESEND_COOLDOWN_MS) {
      const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - last)) / 1000);
      throw new BadRequestException(`发送太频繁，请 ${wait} 秒后再试`);
    }
    const today = new Date().toISOString().slice(0, 10);
    const quota = this.daily.get(key);
    if (quota && quota.date === today && quota.count >= DAILY_LIMIT) {
      throw new BadRequestException('该邮箱今日验证码发送次数已达上限，请明天再试');
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    this.codes.set(key, { code, purpose, expiresAt: now + TTL_MS });
    this.lastSentAt.set(key, now);
    this.daily.set(key, quota && quota.date === today ? { date: today, count: quota.count + 1 } : { date: today, count: 1 });

    if (process.env.SMTP_HOST && process.env.SMTP_USER) {
      try {
        await this.sendMail(email.trim(), code);
        return { sent: true };
      } catch {
        this.codes.delete(key);
        throw new ServiceUnavailableException('验证码邮件发送失败，请稍后再试');
      }
    }
    if (process.env.AUTH_DEV_CODE_ECHO === 'true') {
      return { sent: true, devCode: code, devMode: true };
    }
    throw new ServiceUnavailableException('邮件服务未配置，请联系管理员');
  }

  /** 校验验证码：正确则消费（一次性）并返回；不存在/过期/用途不符/不匹配抛 400 */
  verify(email: string, purpose: CodePurpose, code: string): void {
    const key = email.trim().toLowerCase();
    const entry = this.codes.get(key);
    if (!entry || entry.purpose !== purpose) {
      throw new BadRequestException('请先获取邮箱验证码');
    }
    if (Date.now() > entry.expiresAt) {
      this.codes.delete(key);
      throw new BadRequestException('验证码已过期，请重新获取');
    }
    if (entry.code !== code.trim()) {
      throw new BadRequestException('验证码错误');
    }
    this.codes.delete(key);
  }

  private async sendMail(to: string, code: string): Promise<void> {
    // 延迟 require：SMTP 未配置时无需加载 nodemailer
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: process.env.SMTP_SECURE !== 'false',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject: '【掌上宠物】邮箱验证码',
      text: `你的验证码是 ${code}，10 分钟内有效。若非本人操作，请忽略本邮件。`,
      html: `<p>你的验证码是：<b style="font-size:20px;letter-spacing:4px">${code}</b>，10 分钟内有效。</p><p>若非本人操作，请忽略本邮件。</p>`,
    });
  }
}
