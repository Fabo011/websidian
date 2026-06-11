import { IsOptional, IsString, MaxLength } from 'class-validator';

export class WriteFileDto {
  @IsString()
  @MaxLength(4096)
  path: string;

  @IsString()
  content: string;

  /** Version token the client loaded; used to detect concurrent edits. */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  baseVersion?: string;
}

export class CreateFolderDto {
  @IsString()
  @MaxLength(4096)
  path: string;
}

export class RenameDto {
  @IsString()
  @MaxLength(4096)
  from: string;

  @IsString()
  @MaxLength(4096)
  to: string;
}

export class RenderDto {
  @IsString()
  @MaxLength(4096)
  path: string;

  @IsString()
  content: string;
}

export class UploadFolderDto {
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  folder?: string;
}
