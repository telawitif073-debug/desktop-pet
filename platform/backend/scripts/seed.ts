import 'reflect-metadata';
import * as bcrypt from 'bcryptjs';
import { DataSource } from 'typeorm';
import { User } from '../src/users/user.entity';
import { PetAsset } from '../src/pets/pet-asset.entity';
import { AgentAsset } from '../src/agents/agent-asset.entity';

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

  let creator = await usersRepo.findOne({ where: { email: 'creator@platform.local' } });
  if (!creator) {
    creator = await usersRepo.save(
      usersRepo.create({
        email: 'creator@platform.local',
        username: 'creator',
        passwordHash: await bcrypt.hash('creator123', 10),
        role: 'user',
      }),
    );
    console.log('seeded creator: creator@platform.local / creator123');
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
  }

  await dataSource.destroy();
  console.log('seed done.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
