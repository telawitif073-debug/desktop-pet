import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateActionDto {
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

  /** clip 动作标识（Live2D motion 分组名 / 3D 动画 clip 名）；提供时动作 kind=clip，无需 zip 文件 */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  clipName?: string;
}

export class UpdateActionDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100)
  name?: string;

  @IsOptional() @IsString()
  description?: string;

  @IsOptional()
  @IsIn(['none', 'feed', 'rest', 'play'])
  interaction?: 'none' | 'feed' | 'rest' | 'play';
}
