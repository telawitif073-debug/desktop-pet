import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, ExceptionFilter, Catch, ArgumentsHost, HttpException } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { AppModule } from './app.module';

@Catch()
class LogAllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    if (exception instanceof HttpException) {
      res.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    // multer 上传错误（超限/文件数超限等）应返回 400 而非 500
    if (exception instanceof Error && exception.name === 'MulterError') {
      const code = (exception as any).code || '';
      const msg =
        code === 'LIMIT_FILE_SIZE'
          ? '文件大小超出限制'
          : `上传失败: ${exception.message}`;
      res.status(400).json({ statusCode: 400, message: msg });
      return;
    }
    console.error('[Uncaught]', exception);
    res.status(500).json({ statusCode: 500, message: 'Internal server error' });
  }
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });

  app.setGlobalPrefix('api');
  // JSON body 上限 15MB：抠图智能体回传 dataUrl（1024 图 base64 约 1-2MB）需要超过默认 100kb
  app.use(json({ limit: '15mb' }));
  app.enableCors({
    origin: [
      'http://localhost:5173',
      'http://localhost:5174',
      'http://localhost:4173',
      'http://127.0.0.1:5173',
      'http://127.0.0.1:5174',
    ],
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
  app.useGlobalFilters(new LogAllExceptionsFilter());

  // 静态服务上传文件目录
  const uploadsDir = path.join(__dirname, '..', 'uploads');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  app.useStaticAssets(uploadsDir, { prefix: '/uploads/' });

  const port = process.env.PORT || 3001;
  await app.listen(port);
  console.log(`Platform API listening on http://localhost:${port}/api`);
}
bootstrap();
