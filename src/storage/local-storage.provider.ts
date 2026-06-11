import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream, promises as fs, Stats } from 'fs';
import { dirname, join, sep } from 'path';
import { safeResolve } from '../common/path-safety';
import { AppConfig } from '../config/configuration';
import {
    StorageEntry,
    StorageProvider,
    StorageReadStream,
    StorageStat,
} from './storage.interface';

/**
 * Stores vault data on the server's local filesystem under
 * `dataRoot/<username>/`. This is the default provider.
 */
@Injectable()
export class LocalStorageProvider implements StorageProvider {
  constructor(private readonly config: ConfigService) {}

  private get dataRoot(): string {
    return this.config.get<AppConfig>('app').dataRoot;
  }

  private userRoot(username: string): string {
    return join(this.dataRoot, username);
  }

  private resolve(username: string, relPath = ''): string {
    return safeResolve(this.userRoot(username), relPath);
  }

  async ensureUser(username: string): Promise<void> {
    await fs.mkdir(this.userRoot(username), { recursive: true });
  }

  async list(username: string, relPath: string): Promise<StorageEntry[]> {
    await this.ensureUser(username);
    const abs = this.resolve(username, relPath);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const out: StorageEntry[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue; // hide dotfiles (e.g. .obsidian)
      }
      if (entry.isDirectory()) {
        out.push({ name: entry.name, type: 'dir' });
      } else if (entry.isFile()) {
        out.push({ name: entry.name, type: 'file' });
      }
    }
    return out;
  }

  async readText(username: string, relPath: string): Promise<string> {
    const abs = this.resolve(username, relPath);
    await this.assertFile(abs);
    return fs.readFile(abs, 'utf8');
  }

  async readBytes(username: string, relPath: string): Promise<Buffer> {
    const abs = this.resolve(username, relPath);
    await this.assertFile(abs);
    return fs.readFile(abs);
  }

  async openReadStream(
    username: string,
    relPath: string,
  ): Promise<StorageReadStream> {
    const abs = this.resolve(username, relPath);
    const stat = await this.statSafe(abs);
    if (!stat.isFile()) {
      throw new BadRequestException('Not a file.');
    }
    return { stream: createReadStream(abs), size: stat.size };
  }

  async writeBytes(
    username: string,
    relPath: string,
    data: Buffer,
  ): Promise<void> {
    const abs = this.resolve(username, relPath);
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, data);
  }

  async makeDir(username: string, relPath: string): Promise<void> {
    const abs = this.resolve(username, relPath);
    await fs.mkdir(abs, { recursive: true });
  }

  async move(username: string, from: string, to: string): Promise<void> {
    const fromAbs = this.resolve(username, from);
    const toAbs = this.resolve(username, to);
    if (fromAbs === toAbs) {
      return;
    }
    if (toAbs.startsWith(fromAbs + sep)) {
      throw new BadRequestException('Cannot move a folder into itself.');
    }
    await this.statSafe(fromAbs);
    await fs.mkdir(dirname(toAbs), { recursive: true });
    try {
      await fs.access(toAbs);
      throw new BadRequestException('Target already exists.');
    } catch (err) {
      if (err instanceof BadRequestException) {
        throw err;
      }
      // target does not exist -> proceed
    }
    await fs.rename(fromAbs, toAbs);
  }

  async remove(username: string, relPath: string): Promise<void> {
    const abs = this.resolve(username, relPath);
    const stat = await this.statSafe(abs);
    if (stat.isDirectory()) {
      await fs.rm(abs, { recursive: true, force: true });
    } else {
      await fs.unlink(abs);
    }
  }

  async statFile(username: string, relPath: string): Promise<StorageStat> {
    const abs = this.resolve(username, relPath);
    const stat = await this.statSafe(abs);
    if (!stat.isFile()) {
      throw new BadRequestException('Not a file.');
    }
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  }

  async isFile(username: string, relPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(this.resolve(username, relPath));
      return stat.isFile();
    } catch {
      return false;
    }
  }

  async isDir(username: string, relPath: string): Promise<boolean> {
    try {
      const stat = await fs.stat(this.resolve(username, relPath));
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  async usage(username: string): Promise<number> {
    const root = this.userRoot(username);
    let total = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries: import('fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // directory may not exist yet
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) {
          continue;
        }
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
        } else if (entry.isFile()) {
          try {
            total += (await fs.stat(abs)).size;
          } catch {
            // ignore
          }
        }
      }
    };
    await walk(root);
    return total;
  }

  async removeUser(username: string): Promise<void> {
    await fs.rm(this.userRoot(username), { recursive: true, force: true });
  }

  private async statSafe(abs: string): Promise<Stats> {
    try {
      return await fs.stat(abs);
    } catch {
      throw new NotFoundException('File or folder not found.');
    }
  }

  private async assertFile(abs: string): Promise<void> {
    const stat = await this.statSafe(abs);
    if (!stat.isFile()) {
      throw new BadRequestException('Not a file.');
    }
  }
}
