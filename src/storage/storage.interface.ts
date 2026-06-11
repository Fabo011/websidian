import { Readable } from 'stream';

/** A single directory entry as reported by a storage provider. */
export interface StorageEntry {
  name: string;
  type: 'file' | 'dir';
}

/** Metadata for a stored file. */
export interface StorageStat {
  size: number;
  /** Last-modified time in epoch milliseconds (0 if unknown). */
  mtimeMs: number;
}

/** A file as needed to stream it back to a client. */
export interface StorageReadStream {
  stream: Readable;
  size: number;
}

/**
 * Abstraction over where user vault data physically lives. Implementations
 * receive forward-slash relative paths already scoped to a single user (the
 * caller passes the username separately) and must keep users isolated.
 *
 * The default {@link LocalStorageProvider} stores files on the server's disk.
 * The {@link S3StorageProvider} (stub) targets S3-compatible object storage.
 */
export interface StorageProvider {
  /** Ensure the user's storage namespace exists (no-op for object stores). */
  ensureUser(username: string): Promise<void>;

  /** List immediate children of a directory (relPath '' is the root). */
  list(username: string, relPath: string): Promise<StorageEntry[]>;

  /** Read a UTF-8 text file. */
  readText(username: string, relPath: string): Promise<string>;

  /** Read a file as raw bytes. */
  readBytes(username: string, relPath: string): Promise<Buffer>;

  /** Open a file for streaming (attachments). */
  openReadStream(username: string, relPath: string): Promise<StorageReadStream>;

  /** Write raw bytes (creates parent folders as needed). */
  writeBytes(username: string, relPath: string, data: Buffer): Promise<void>;

  /** Create a (possibly nested) folder. */
  makeDir(username: string, relPath: string): Promise<void>;

  /** Move/rename a file or folder (recursively for folders). */
  move(username: string, from: string, to: string): Promise<void>;

  /** Delete a file or folder (recursively for folders). */
  remove(username: string, relPath: string): Promise<void>;

  /** Stat a single file. Throws if it is not a file. */
  statFile(username: string, relPath: string): Promise<StorageStat>;

  /** Whether the given path exists and is a file. */
  isFile(username: string, relPath: string): Promise<boolean>;

  /** Whether the given path exists and is a directory. */
  isDir(username: string, relPath: string): Promise<boolean>;

  /** Total bytes consumed by the user across all files. */
  usage(username: string): Promise<number>;

  /** Remove all data belonging to a user (account deletion). */
  removeUser(username: string): Promise<void>;
}

/** DI token for the active storage provider. */
export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');
