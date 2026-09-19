import 'reflect-metadata';
import * as bcrypt from 'bcryptjs';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { User } from '../src/users/user.entity';
import { PetAsset } from '../src/pets/pet-asset.entity';
import { AgentAsset } from '../src/agents/agent-asset.entity';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

async function main() {
  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    username: process.env.DB_USERNAME || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_DATABASE || 'desktop_pet_platform',
    entities: [User, PetAsset, AgentAsset],
    synchronize: false,
  });
  await dataSource.initialize();

  // 启用 UUID 扩展
  await dataSource.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
  await dataSource.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

  const usersRepo = dataSource.getRepository(User);
  const petsRepo = dataSource.getRepository(PetAsset);
  const agentsRepo = dataSource.getRepository(AgentAsset);

  // ---- 用户 ----
  let admin = await usersRepo.findOne({ where: { email: 'admin@platform.local' } });
  if (!admin) {
    admin = await usersRepo.save(
      usersRepo.create({
        email: 'admin@platform.local',
        username: 'admin',
        passwordHash: await bcrypt.hash('admin123', 10),
        role: 'admin',
      }),
    );
    console.log('seeded admin: admin@platform.local / admin123');
  }
  let demo = await usersRepo.findOne({ where: { email: 'demo@platform.local' } });
  if (!demo) {
    demo = await usersRepo.save(
      usersRepo.create({
        email: 'demo@platform.local',
        username: 'demo',
        passwordHash: await bcrypt.hash('demo123', 10),
        role: 'user',
      }),
    );
    console.log('seeded demo: demo@platform.local / demo123');
  }

  // ---- 示例宠物资源 ----
  if ((await petsRepo.count()) === 0) {
    await petsRepo.save(
      petsRepo.create({
        name: '示例橘猫宠物',
        description: '平台自带的示例宠物资源，用于验证下载与安装流程。',
        authorId: admin.id,
        category: '动画',
        tags: ['示例', '猫'],
        fileUrl: '/uploads/sample-pet-asset.txt',
        version: '1.0.0',
        status: 'approved',
      }),
    );
    console.log('seeded sample pet asset');
  }

  // ---- 示例智能体资源 ----
  if ((await agentsRepo.count()) === 0) {
    await agentsRepo.save(
      agentsRepo.create({
        name: '示例闲聊智能体',
        description: '平台自带的示例智能体资源，包含基础对话配置。',
        authorId: admin.id,
        type: 'chat',
        configSchema: {
          systemPrompt: '你是桌面宠物助手，回答简洁友好。',
          temperature: 0.7,
        },
        dependencies: [],
        fileUrl: '/uploads/sample-agent-config.json',
        version: '1.0.0',
        status: 'approved',
      }),
    );
    console.log('seeded sample agent asset');

    // 自带语音识别的示例：安装后无需下载语音模型包即可对宠物说话（Key 留空，安装者在客户端填自己的）
    await agentsRepo.save(
      agentsRepo.create({
        name: '语音陪伴智能体（自带语音识别）',
        description: '自带语音识别的示例智能体，安装后不用下载语音模型包就能和它说话。首次使用请在聊天设置里替换成自己的识别 Key。',
        authorId: admin.id,
        type: 'chat',
        configSchema: {
          name: '语音陪伴小助手',
          systemPrompt: '你是桌面宠物的语音陪伴助手，回答口语化、简短，适合朗读。',
          temperature: 0.7,
          asr: {
            mode: 'transcribe',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: '',
            model: 'whisper-1',
            language: 'zh',
          },
        },
        dependencies: [],
        fileUrl: '/uploads/sample-voice-agent-config.json',
        version: '1.0.0',
        status: 'approved',
      }),
    );
    console.log('seeded sample voice agent asset');
  }

  await dataSource.destroy();
  console.log('seed done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
