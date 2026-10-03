import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PetPackBodyKind } from '../pet-pack.entity';

/** 商店列表查询（status 仅管理员可见生效，普通用户恒定只看 approved） */
export class ListPetPacksQueryDto {
  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected'])
  status?: 'pending' | 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  category?: string;

  /** 只看包含指定本体类型的包（body-model / body-animation / body-still） */
  @IsOptional()
  @IsIn(['body-model', 'body-animation', 'body-still'])
  bodyKind?: PetPackBodyKind;

  @IsOptional()
  @Type(() => Number)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @IsIn(['downloads', 'rating', 'createdAt'])
  sort?: 'downloads' | 'rating' | 'createdAt';
}

/**
 * 更新宠物包元信息。
 * 注意：`packUrl` / `packSha256` / `bodyKinds` / `manifest` **不在可更新字段内**——
 * 它们由服务端校验派生，只能通过重新发布（传新的包）变更，避免作者自述与包内容不一致。
 */
export class UpdatePetPackDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100)
  name?: string;

  @IsOptional() @IsString()
  description?: string;

  @IsOptional() @IsString() @MaxLength(50)
  category?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional() @IsString()
  previewUrl?: string;

  @IsOptional() @IsString() @MaxLength(20)
  version?: string;
}
