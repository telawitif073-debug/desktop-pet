import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

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
  @IsString()
  previewUrl?: string;

  @IsOptional()
  @IsString()
  fileUrl: string;

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
