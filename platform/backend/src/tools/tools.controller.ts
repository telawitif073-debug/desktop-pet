import { Controller, Get, HttpException, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { ToolsService } from './tools.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '../users/user.entity';

/**
 * 智能体技能网关：登录用户可用（智能体的隐藏指令由 App 解析后调这里）。
 * 单实例内存限流：每用户每分钟最多 30 次（t2.micro 资源有限，也防失控模型刷接口）。
 */
const WINDOW_MS = 60_000;
const MAX_HITS = 30;
const hits = new Map<string, number[]>();

function checkRate(userId: string): void {
  const now = Date.now();
  const recent = (hits.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_HITS) {
    throw new HttpException('技能调用过于频繁，请稍后再试（每分钟最多 30 次）', HttpStatus.TOO_MANY_REQUESTS);
  }
  recent.push(now);
  hits.set(userId, recent);
}

@Controller('tools')
@UseGuards(JwtAuthGuard)
export class ToolsController {
  constructor(private readonly tools: ToolsService) {}

  @Get('weather')
  weather(@CurrentUser() user: User, @Query('city') city = '', @Query('day') day?: string) {
    checkRate(user.id);
    const dayOffset = day === '明天' || day === '1' ? 1 : day === '后天' || day === '2' ? 2 : 0;
    return this.tools.weather(city, dayOffset);
  }

  @Get('stock')
  stock(@CurrentUser() user: User, @Query('q') q = '') {
    checkRate(user.id);
    return this.tools.stock(q);
  }

  @Get('football')
  football(@CurrentUser() user: User, @Query('date') date?: string) {
    checkRate(user.id);
    return this.tools.football(date);
  }
}
