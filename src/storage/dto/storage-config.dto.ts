import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class S3CredsDto {
  @IsString()
  @MaxLength(512)
  endpoint: string;

  @IsString()
  @MaxLength(128)
  region: string;

  @IsString()
  @MaxLength(256)
  bucket: string;

  @IsString()
  @MaxLength(256)
  accessKeyId: string;

  @IsString()
  @MaxLength(512)
  secretAccessKey: string;

  @IsOptional()
  @IsBoolean()
  forcePathStyle?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  prefix?: string;
}

export class WebdavCredsDto {
  @IsString()
  @MaxLength(1024)
  url: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  username?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  password?: string;

  @IsOptional()
  @IsIn(['auto', 'password', 'digest', 'none'])
  authType?: 'auto' | 'password' | 'digest' | 'none';

  @IsOptional()
  @IsString()
  @MaxLength(256)
  basePath?: string;
}

/** Body for testing or saving a user's own storage credentials. */
export class StorageConfigDto {
  @IsIn(['s3', 'webdav'])
  driver: 's3' | 'webdav';

  @ValidateIf((o) => o.driver === 's3')
  @IsObject()
  @ValidateNested()
  @Type(() => S3CredsDto)
  s3?: S3CredsDto;

  @ValidateIf((o) => o.driver === 'webdav')
  @IsObject()
  @ValidateNested()
  @Type(() => WebdavCredsDto)
  webdav?: WebdavCredsDto;

  /**
   * Optional self-imposed storage quota in GB. 0 (or omitted) means unlimited —
   * this is the user's own storage, so the cap is purely self-service. Only read
   * by the save endpoint, ignored by the test endpoint.
   */
  @IsOptional()
  @IsNumber()
  @Min(0)
  quotaGb?: number;
}
