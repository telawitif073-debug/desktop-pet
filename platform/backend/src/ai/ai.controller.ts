import { Body, Controller, Post } from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { AiService } from './ai.service';

class GeneratePetDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  description!: string;
}

/** AI 生成接口：文字描述 → 宠物形象参数（前端 Canvas 绘制成图片后走上传流程） */
@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('generate-pet')
  async generatePet(@Body() dto: GeneratePetDto) {
    const design = await this.aiService.generatePetDesign(dto.description);
    return { design };
  }
}
