import {
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class CreateAgentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsIn(['chat', 'task', 'mixed'])
  type?: 'chat' | 'task' | 'mixed';

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? JSON.parse(value) : value)
  @IsObject()
  configSchema?: Record<string, unknown>;

  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? JSON.parse(value) : value)
  @IsArray()
  @IsString({ each: true })
  dependencies?: string[];

  @IsOptional()
  @IsString()
  fileUrl: string;

  @IsOptional()
  @IsString()
  previewUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  version?: string;
}

export class UpdateAgentDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100)
  name?: string;
  @IsOptional() @IsString()
  description?: string;
  @IsOptional() @IsIn(['chat', 'task', 'mixed'])
  type?: 'chat' | 'task' | 'mixed';
  @IsOptional() @Transform(({ value }) => typeof value === 'string' ? JSON.parse(value) : value) @IsObject()
  configSchema?: Record<string, unknown>;
  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? JSON.parse(value) : value)
  @IsArray() @IsString({ each: true })
  dependencies?: string[];
  @IsOptional() @IsString()
  previewUrl?: string;
  @IsOptional() @IsString() @MaxLength(20)
  version?: string;
}

export class ListAgentsQueryDto {
  @IsOptional() @IsIn(['pending', 'approved', 'rejected'])
  status?: 'pending' | 'approved' | 'rejected';
  @IsOptional() @IsString()
  search?: string;
  @IsOptional() @Type(() => Number)
  page?: number;
  @IsOptional() @Type(() => Number)
  limit?: number;
  @IsOptional() @IsIn(['downloads', 'rating', 'createdAt'])
  sort?: 'downloads' | 'rating' | 'createdAt';
}
