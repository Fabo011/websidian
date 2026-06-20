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
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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
    @Query('stream') stream: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    if (!path) {
      throw new BadRequestException('path is required.');
    }
    // Default (back-compatible) behaviour: do the delete and return JSON.
    if (stream !== '1' || !res) {
      await this.vault.deleteEntry(user.username, path);
      return { ok: true };
    }
    // Streaming mode: emit NDJSON progress lines so the client can render a real
    // progress bar while a large folder's files are moved/removed one by one.
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no'); // don't let nginx buffer the stream
    const write = (obj: Record<string, unknown>) =>
      res.write(`${JSON.stringify(obj)}\n`);
    try {
      await this.vault.deleteEntryProgress(user.username, path, (done, total) =>
        write({ done, total }),
      );
      write({ ok: true });
    } catch (err) {
      write({ error: (err as Error)?.message || 'Delete failed.' });
    } finally {
      res.end();
    }
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

  // Bulk folder/zip imports were previously POSTed here as one large multipart
  // request, which broke the Cloudflare 100 MB body limit. Folder uploads now go
  // through the resumable, 50 MB-chunked tus endpoint (/files) instead — see
  // src/upload/tus.setup.ts and client/upload-entry.js. The single-file
  // /api/upload above is kept for small inline editor attachments.

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
