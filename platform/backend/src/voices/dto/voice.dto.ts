import { IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class CreateVoiceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  /** 音色配置（multipart 时以 JSON 字符串传入）；不含 API Key */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? JSON.parse(value) : value))
  @IsObject()
  configSchema?: Record<string, unknown>;

  /** 可选试听样本直链（无 multipart 文件时，由后端拉取并校验，≤5MB） */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  sampleUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  version?: string;
}

export class UpdateVoiceDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100)
  name?: string;
  @IsOptional() @IsString()
  description?: string;
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? JSON.parse(value) : value))
  @IsObject()
  configSchema?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(20)
  version?: string;
}

export class ListVoicesQueryDto {
  @IsOptional() @IsString()
  search?: string;
  @IsOptional() @Type(() => Number)
  page?: number;
  @IsOptional() @Type(() => Number)
  limit?: number;
  @IsOptional() @IsString()
  sort?: string;
}
