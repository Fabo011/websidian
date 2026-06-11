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
import {
    FileInterceptor,
    FilesInterceptor,
} from '@nestjs/platform-express';
import AdmZip from 'adm-zip';
import { Response } from 'express';
import { memoryStorage } from 'multer';
import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards';
import { mimeForExt } from '../common/mime';
import {
    CreateFolderDto,
    RenameDto,
    RenderDto,
    WriteFileDto,
} from './dto/vault.dto';
import { MarkdownService } from './markdown.service';
import { VaultService } from './vault.service';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB per file

@Controller('api')
@UseGuards(JwtAuthGuard)
export class VaultController {
  constructor(
    private readonly vault: VaultService,
    private readonly markdown: MarkdownService,
  ) {}

  @Get('tree')
  tree(@CurrentUser() user: AuthenticatedUser) {
    return this.vault.listTree(user.username);
  }

  @Get('file')
  file(
    @CurrentUser() user: AuthenticatedUser,
    @Query('path') path: string,
  ) {
    if (!path) {
      throw new BadRequestException('path is required.');
    }
    return this.vault.readTextFile(user.username, path);
  }

  @Put('file')
  writeFile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: WriteFileDto,
  ) {
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
  async rename(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RenameDto,
  ) {
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
      storage: memoryStorage(),
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
    const path = await this.vault.saveUpload(
      user.username,
      folder,
      file.originalname,
      file.buffer,
    );
    return { ok: true, path };
  }

  @Post('import')
  @UseInterceptors(
    FilesInterceptor('files', 2000, {
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_BYTES },
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

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const relName = relPaths[i] || file.originalname || 'file';
      if (relName.toLowerCase().endsWith('.zip')) {
        written += await this.extractZip(user.username, base, file.buffer);
        continue;
      }
      // relName carries the relative path (e.g. "MyVault/sub/note.md").
      const rel = this.joinImportPath(base, relName);
      await this.vault.writeAtPath(user.username, rel, file.buffer);
      written += 1;
    }
    return { ok: true, written };
  }

  private async extractZip(
    username: string,
    base: string,
    buffer: Buffer,
  ): Promise<number> {
    const zip = new AdmZip(buffer);
    let count = 0;
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) {
        continue;
      }
      const entryName = entry.entryName.replace(/\\/g, '/');
      if (entryName.split('/').some((seg) => seg === '..')) {
        continue; // skip traversal attempts inside the archive
      }
      const rel = this.joinImportPath(base, entryName);
      await this.vault.writeAtPath(username, rel, entry.getData());
      count += 1;
    }
    return count;
  }

  private joinImportPath(base: string, name: string): string {
    const cleanName = name.replace(/\\/g, '/').replace(/^\/+/, '');
    const cleanBase = base.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    return cleanBase ? `${cleanBase}/${cleanName}` : cleanName;
  }

  @Post('render')
  async render(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RenderDto,
  ) {
    const html = await this.markdown.render(user.username, dto.path, dto.content);
    return { html };
  }

  @Get('search')
  search(
    @CurrentUser() user: AuthenticatedUser,
    @Query('q') q = '',
  ) {
    return this.vault.search(user.username, q);
  }

  @Get('export')
  async exportVault(
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: Response,
  ) {
    const files = await this.vault.listAllFiles(user.username);
    const zip = new AdmZip();
    for (const file of files) {
      const data = await this.vault.readBytes(user.username, file.relPath);
      zip.addFile(file.relPath, data);
    }
    const buffer = zip.toBuffer();
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `${user.username}-vault-${stamp}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(filename)}"`,
    );
    res.end(buffer);
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
