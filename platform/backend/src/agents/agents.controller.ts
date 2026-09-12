import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AgentsService } from './agents.service';
import { CreateAgentDto, ListAgentsQueryDto, UpdateAgentDto } from './dto/agent.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { JwtOptionalGuard } from '../common/guards/jwt-optional.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '../users/user.entity';
import { ReviewsService } from '../reviews/reviews.service';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { StorageService } from '../uploads/storage.service';
import { validateUploadMetadata } from '../uploads/upload-validation';

class AgentReviewDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @IsOptional()
  @IsString()
  comment?: string;
}

@Controller('agents')
export class AgentsController {
  constructor(
    private readonly agentsService: AgentsService,
    private readonly reviewsService: ReviewsService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  @UseGuards(JwtOptionalGuard)
  list(
    @Query() query: ListAgentsQueryDto,
    @CurrentUser() user: User | null,
  ) {
    return this.agentsService.list({
      status: query.status,
      search: query.search,
      page: query.page,
      limit: query.limit,
      sort: query.sort,
      isAdmin: user?.role === 'admin',
    });
  }

  @Get('mine')
  @UseGuards(JwtAuthGuard)
  mine(@CurrentUser() user: User) {
    return this.agentsService.findMine(user.id);
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: Number(process.env.UPLOAD_MAX_SIZE || 52428800) },
    fileFilter: (_req, file, cb) => {
      try { validateUploadMetadata(file.originalname, file.mimetype); cb(null, true); }
      catch (error) { cb(error as Error, false); }
    },
  }))
  async create(@Body() dto: CreateAgentDto, @UploadedFile() file: Express.Multer.File, @CurrentUser() user: User) {
    if (!file && !dto.fileUrl) throw new BadRequestException('必须上传资源文件');
    const fileUrl = dto.fileUrl ?? await this.storage.upload(file);
    return this.agentsService.create({ ...dto, fileUrl }, user.id);
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard)
  update(@Param('id') id: string, @Body() dto: UpdateAgentDto, @CurrentUser() user: User) {
    return this.agentsService.update(id, dto, user.id, user.role === 'admin');
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  remove(@Param('id') id: string, @CurrentUser() user: User) {
    return this.agentsService.remove(id, user.id, user.role === 'admin');
  }

  @Get(':id')
  @UseGuards(JwtOptionalGuard)
  findOne(@Param('id') id: string, @CurrentUser() user: User | null) {
    return this.agentsService.findOneVisible(id, user?.id, user?.role === 'admin');
  }

  @Patch(':id/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  approve(@Param('id') id: string) {
    return this.agentsService.updateStatus(id, 'approved');
  }

  @Patch(':id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  reject(@Param('id') id: string) {
    return this.agentsService.updateStatus(id, 'rejected');
  }

  @Post(':id/download')
  @UseGuards(JwtOptionalGuard)
  async download(
    @Param('id') id: string,
    @CurrentUser() user: User | null,
  ) {
    const agent = await this.agentsService.findOneVisible(id, user?.id, user?.role === 'admin');
    if (agent.status !== 'approved') {
      throw new ForbiddenException('资源未通过审核');
    }
    await this.agentsService.recordDownload(id, user?.id ?? null);
    return { url: agent.fileUrl, downloads: agent.downloads + 1 };
  }

  @Post(':id/review')
  @UseGuards(JwtAuthGuard)
  review(@Param('id') id: string, @Body() body: AgentReviewDto, @CurrentUser() user: User) {
    return this.reviewsService.upsertReview({
      userId: user.id, assetType: 'agent', assetId: id, rating: body.rating, comment: body.comment,
    });
  }
}
