import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { PetFormat } from '../pet-asset.entity';

/** 上传宠物时附带动作的元数据（multipart 中为 JSON 字符串，与 actionFiles 按下标对应） */
export class PetActionMetaDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsIn(['none', 'feed', 'rest', 'play'])
  interaction?: 'none' | 'feed' | 'rest' | 'play';

  /** clip 动作标识（Live2D motion 分组名 / 3D 动画 clip 名）；提供时无需 zip 文件 */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  clipName?: string;
}

export class CreatePetDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? JSON.parse(value) : value)
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsIn(['image', 'pack', 'live2d', 'model3d', 'sprite'])
  format?: PetFormat;

  @IsOptional()
  @IsString()
  previewUrl?: string;

  /** 可选背景场景图 URL（独立于主体文件的背景，由后端 storage 上传后回填） */
  @IsOptional()
  @IsString()
  backgroundUrl?: string;

  @IsOptional()
  @IsString()
  fileUrl: string;

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? JSON.parse(value) : value)
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PetActionMetaDto)
  actionsMeta?: PetActionMetaDto[];

  @IsOptional()
  @IsString()
  @MaxLength(20)
  version?: string;
}

export class UpdatePetDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? JSON.parse(value) : value)
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  previewUrl?: string;

  /** 可选背景场景图 URL（独立于主体文件的背景，由后端 storage 上传后回填） */
  @IsOptional()
  @IsString()
  backgroundUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  version?: string;
}

export class ListPetsQueryDto {
  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected'])
  status?: 'pending' | 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @IsIn(['downloads', 'rating', 'createdAt'])
  sort?: 'downloads' | 'rating' | 'createdAt';

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? JSON.parse(value) : value)
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class AssetIdParamDto {
  @IsUUID()
  id: string;
}
