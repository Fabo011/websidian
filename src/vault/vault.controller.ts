import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { diskStorage } from 'multer';
import { createReadStream } from 'fs';
import { unlink } from 'fs/promises';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards';
import { mimeForExt } from '../common/mime';
import { CreateFolderDto, RenameDto, WriteFileDto } from './dto/vault.dto';
import { VaultService } from './vault.service';

// Per-file upload cap applied by multer to /upload and /import. Files are
// disk-spooled and streamed to storage (not buffered in RAM), so this mainly
// bounds temp-disk usage. Override with MAX_UPLOAD_FILE_MB; defaults to 2 GB.
const MAX_UPLOAD_FILE_MB = Math.max(
  1,
  Number(process.env.MAX_UPLOAD_FILE_MB) || 2048,
);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_FILE_MB * 1024 * 1024;

// Max number of files accepted in a single import. multer rejects anything past
// this as LIMIT_UNEXPECTED_FILE ("Unexpected field"), which surfaces as a 400 —
// so a large vault/zip with many files needs a high ceiling. Override with
// MAX_IMPORT_FILES.
const MAX_IMPORT_FILES = Math.max(
  1,
  Number(process.env.MAX_IMPORT_FILES) || 20000,
);

// The client sends every file's relative path in one `paths` JSON field. multer
// caps a single field at 1 MB by default, which a large import would exceed, so
// raise it generously.
const MAX_FIELD_BYTES = 64 * 1024 * 1024;

// Total size cap for a single import (sum of all files). Separate from the
// per-file cap above. Override with MAX_IMPORT_TOTAL_MB; defaults to 2 GB.
const MAX_IMPORT_TOTAL_MB = Math.max(
  1,
  Number(process.env.MAX_IMPORT_TOTAL_MB) || 2048,
);
const MAX_IMPORT_TOTAL_BYTES = MAX_IMPORT_TOTAL_MB * 1024 * 1024;

@Controller('api')
@UseGuards(JwtAuthGuard)
export class VaultController {
  constructor(private readonly vault: VaultService) {}

  @Get('tree')
  tree(@CurrentUser() user: AuthenticatedUser) {
    return this.vault.listTree(user.username);
  }

  @Get('file')
  file(@CurrentUser() user: AuthenticatedUser, @Query('path') path: string) {
    if (!path) {
      throw new BadRequestException('path is required.');
    }
    return this.vault.readTextFile(user.username, path);
  }

  @Put('file')
  writeFile(@CurrentUser() user: AuthenticatedUser, @Body() dto: WriteFileDto) {
    return this.vault.writeTextFile(
      user.username,
      dto.path,
      dto.content,
      dto.baseVersion,
    );
  }

  @Post('folder')
  async folder(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateFolderDto,
  ) {
    await this.vault.createFolder(user.username, dto.path);
    return { ok: true };
  }

  @Post('rename')
  async rename(@CurrentUser() user: AuthenticatedUser, @Body() dto: RenameDto) {
    await this.vault.rename(user.username, dto.from, dto.to);
    return { ok: true };
  }

  @Delete('entry')
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Query('path') path: string,
  ) {
    if (!path) {
      throw new BadRequestException('path is required.');
    }
    await this.vault.deleteEntry(user.username, path);
    return { ok: true };
  }

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      // Spool to a temp file on disk instead of RAM so a multi-GB upload never
      // buffers fully in memory. We stream it to storage and delete the temp.
      storage: diskStorage({}),
      limits: { fileSize: MAX_UPLOAD_BYTES },
    }),
  )
  async upload(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File,
    @Body('folder') folder = '',
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded.');
    }
    try {
      const path = await this.vault.saveUploadStream(
        user.username,
        folder,
        file.originalname,
        createReadStream(file.path),
        file.size,
      );
      return { ok: true, path };
    } finally {
      await unlink(file.path).catch(() => {});
    }
  }

  @Post('import')
  @UseInterceptors(
    FilesInterceptor('files', MAX_IMPORT_FILES, {
      // See upload(): disk-spooled so large imports don't sit in RAM.
      storage: diskStorage({}),
      limits: {
        fileSize: MAX_UPLOAD_BYTES,
        files: MAX_IMPORT_FILES,
        fieldSize: MAX_FIELD_BYTES,
      },
    }),
  )
  async import(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFiles() files: Express.Multer.File[],
    @Body('base') base = '',
    @Body('paths') pathsRaw?: string,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files uploaded.');
    }

    // The client sends an explicit relative path per file (in upload order) so
    // the original folder structure is preserved, since multipart filenames are
    // flattened to their basename in transit.
    let relPaths: string[] = [];
    if (pathsRaw) {
      try {
        const parsed = JSON.parse(pathsRaw);
        if (Array.isArray(parsed)) {
          relPaths = parsed.map((p) => String(p));
        }
      } catch {
        relPaths = [];
      }
    }

    let written = 0;

    try {
      // Enforce the total-size cap server-side (the client checks too, but the
      // server is the authority). Temp files are cleaned up in finally.
      const totalBytes = files.reduce((n, f) => n + f.size, 0);
      if (totalBytes > MAX_IMPORT_TOTAL_BYTES) {
        throw new BadRequestException(
          `Import is ${Math.ceil(totalBytes / (1024 * 1024))} MB but the limit is ${MAX_IMPORT_TOTAL_MB} MB per import.`,
        );
      }
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const relName = relPaths[i] || file.originalname || 'file';
        // Each uploaded file is opaque ciphertext produced in the browser. Zip
        // archives are expanded client-side (the server cannot read encrypted
        // contents), so here we only ever write individual files.
        const rel = this.joinImportPath(base, relName);
        await this.vault.writeStreamAtPath(
          user.username,
          rel,
          createReadStream(file.path),
          file.size,
        );
        written += 1;
      }
      return { ok: true, written };
    } finally {
      // Always remove the temp spool files, even if a write fails partway.
      await Promise.all(files.map((f) => unlink(f.path).catch(() => {})));
    }
  }

  private joinImportPath(base: string, name: string): string {
    const cleanName = name.replace(/\\/g, '/').replace(/^\/+/, '');
    const cleanBase = base.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    return cleanBase ? `${cleanBase}/${cleanName}` : cleanName;
  }

  @Get('search')
  search(@CurrentUser() user: AuthenticatedUser, @Query('q') q = '') {
    return this.vault.search(user.username, q);
  }

  /**
   * List every file in the vault (flat, with sizes). Used by the client to
   * build an export archive locally: it fetches each file's ciphertext, decrypts
   * it in the browser, and zips the plaintext. The server can no longer build a
   * useful export itself because it only holds ciphertext.
   */
  @Get('files')
  async listFiles(@CurrentUser() user: AuthenticatedUser) {
    const files = await this.vault.listAllFiles(user.username);
    return files.map((f) => ({ path: f.relPath, version: f.version }));
  }

  @Get('attachment')
  async attachment(
    @CurrentUser() user: AuthenticatedUser,
    @Query('path') path: string,
    @Res() res: Response,
  ) {
    if (!path) {
      throw new BadRequestException('path is required.');
    }
    const { stream, size, ext, name } = await this.vault.resolveAttachment(
      user.username,
      path,
    );
    res.setHeader('Content-Type', mimeForExt(ext));
    res.setHeader('Content-Length', String(size));
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(name)}"`,
    );
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    stream.pipe(res);
  }
}
