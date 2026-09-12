import {
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { StorageService } from './storage.service';
import { validateUploadMetadata } from './upload-validation';

@Controller('uploads')
@UseGuards(JwtAuthGuard)
export class UploadsController {
  constructor(private readonly storage: StorageService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: {
        fileSize: Number(process.env.UPLOAD_MAX_SIZE || 52428800), // 50MB
      },
      fileFilter: (_req, file, cb) => {
        try { validateUploadMetadata(file.originalname, file.mimetype); cb(null, true); }
        catch (error) { cb(error as Error, false); }
      },
    }),
  )
  async upload(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      return { success: false, error: '未收到文件' };
    }
    const url = await this.storage.upload(file);
    return {
      success: true,
      url,
      originalName: file.originalname,
      size: file.size,
    };
  }
}
