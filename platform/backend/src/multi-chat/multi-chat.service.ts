import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MultiAgentSession } from './multi-agent-session.entity';
import { MultiAgentMessage } from './multi-agent-message.entity';
import { SyncService } from '../sync/sync.service';
import { orchestrate, TraceItem } from './orchestrator';

interface ChatHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * 多智能体运行时：会话生命周期 + 编排执行 + 协同轨迹落库。
 * 编排配置取自用户云同步 config 中对应智能体档案（LlmProfile.multiConfig），
 * credentials 由 sync 解密后直接可用，运行时注入，不落明文（trace 不含密钥）。
 */
@Injectable()
export class MultiChatService {
  private readonly logger = new Logger(MultiChatService.name);

  constructor(
    @InjectRepository(MultiAgentSession)
    private readonly sessions: Repository<MultiAgentSession>,
    @InjectRepository(MultiAgentMessage)
    private readonly messages: Repository<MultiAgentMessage>,
    private readonly sync: SyncService,
  ) {}

  /** 幂等获取会话：同一用户的同一智能体档案复用一条会话 */
  async ensureSession(ownerId: string, agentProfileId: string, title?: string): Promise<MultiAgentSession> {
    if (!agentProfileId) throw new BadRequestException('缺少智能体档案 id');
    let row = await this.sessions.findOne({ where: { ownerId, agentProfileId } });
    if (!row) {
      row = await this.sessions.save(
        this.sessions.create({
          ownerId,
          agentProfileId,
          title: title ?? agentProfileId,
        }),
      );
    } else if (title) {
      this.sessions.update(row.id, { title });
    }
    return row;
  }

  /** 会话列表：携带消息条数 */
  async listSessions(ownerId: string): Promise<
    Array<{
      id: string;
      agentProfileId: string;
      title: string;
      createdAt: Date;
      updatedAt: Date;
      messageCount: number;
    }>
  > {
    const rows = await this.sessions.find({
      where: { ownerId },
      order: { updatedAt: 'DESC' },
    });
    const counts = await this.messages
      .createQueryBuilder('m')
      .select('m.sessionId', 'sessionId')
      .addSelect('COUNT(*)', 'cnt')
      .where('m.sessionId IN (:...ids)', { ids: rows.map((r) => r.id) })
      .groupBy('m.sessionId')
      .getRawMany<{ sessionId: string; cnt: string }>();
    const map = new Map(counts.map((c) => [c.sessionId, Number(c.cnt)]));
    return rows.map((r) => ({
      id: r.id,
      agentProfileId: r.agentProfileId,
      title: r.title,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      messageCount: map.get(r.id) ?? 0,
    }));
  }

  private async mustGetOwned(ownerId: string, sessionId: string): Promise<MultiAgentSession> {
    const row = await this.sessions.findOne({ where: { id: sessionId, ownerId } });
    if (!row) throw new NotFoundException('会话不存在');
    return row;
  }

  async listMessages(ownerId: string, sessionId: string): Promise<MultiAgentMessage[]> {
    await this.mustGetOwned(ownerId, sessionId);
    return this.messages.find({ where: { sessionId }, order: { createdAt: 'ASC' } });
  }

  /** 发消息并执行编排：返回 assistant 消息（含协同轨迹 meta） */
  async sendMessage(
    ownerId: string,
    sessionId: string,
    body: { content?: string; history?: ChatHistoryItem[] | null },
  ): Promise<MultiAgentMessage> {
    const session = await this.mustGetOwned(ownerId, sessionId);
    const rawContent = (body.content ?? '').trim();
    if (!rawContent) throw new BadRequestException('消息内容为空');

    // 读用户云同步 config，取该档案（LlmProfile=智能体）
    const { data } = await this.sync.getKind(ownerId, 'config');
    const cfg = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    const profiles = Array.isArray(cfg.llmProfiles) ? cfg.llmProfiles : [];
    const profile = profiles.find((p) => p && typeof p === 'object' && (p as Record<string, unknown>).id === session.agentProfileId) as
      | Record<string, unknown>
      | undefined;
    if (!profile) throw new BadRequestException('未找到该智能体档案（可能已在其他设备删除，请在客户端重新保存）');
    const multi = profile.multiConfig as
      | { raw?: string; format?: string; deps?: unknown[]; credentials?: Record<string, string> }
      | undefined;
    if (!multi || !multi.raw) {
      throw new BadRequestException('该智能体档案未配置多智能体编排（multiConfig 为空）');
    }

    // 分离当前问题与上文
    const history = Array.isArray(body.history) ? body.history : [];
    let question = rawContent;
    if (history.length > 0 && history[history.length - 1].role === 'user') {
      question = history[history.length - 1].content?.trim() || rawContent;
    }
    const contextText = history
      .slice(0, -1)
      .slice(-6)
      .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${(m.content ?? '').slice(0, 100)}`)
      .join('\n');

    // 执行编排
    const result = await orchestrate({
      profile: {
        name: String(profile.name ?? session.title ?? ''),
        baseUrl: typeof profile.baseUrl === 'string' ? profile.baseUrl : undefined,
        apiKey: typeof profile.apiKey === 'string' ? profile.apiKey : undefined,
        model: typeof profile.model === 'string' ? profile.model : undefined,
        systemPrompt: typeof profile.systemPrompt === 'string' ? profile.systemPrompt : undefined,
        role: typeof profile.role === 'string' ? profile.role : undefined,
        style: typeof profile.style === 'string' ? profile.style : undefined,
      },
      raw: multi.raw,
      format: multi.format === 'json' ? 'json' : 'yaml',
      deps: Array.isArray(multi.deps)
        ? (multi.deps as Array<{ key?: string; ref?: string }>).map((d) => ({ key: d.key ?? '', ref: d.ref ?? '' }))
        : [],
      credentials: multi.credentials ?? {},
      question,
      contextText,
    });

    // 落库：用户消息 + 助手消息（meta 存轨迹；截断避免单条过大）
    const userMsg = await this.messages.save(
      this.messages.create({ sessionId, role: 'user', agentId: null, content: question, latencyMs: null, error: null }),
    );
    const trimTrace = (result.trace ?? []).map((t: TraceItem) => ({ ...t }));
    const assistantMsg = await this.messages.save(
      this.messages.create({
        sessionId,
        role: 'assistant',
        agentId: null,
        content: result.content,
        latencyMs: result.latencyMs,
        error: null,
        meta: { trace: trimTrace, agents: profiles.length },
      }),
    );
    return assistantMsg;
  }
}