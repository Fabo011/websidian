export interface TreeNode {
  name: string;
  /** Relative path within the user vault, forward slashes. */
  path: string;
  type: 'file' | 'dir';
  /** Lowercased extension without the dot, for files. */
  ext?: string;
  children?: TreeNode[];
}

export interface SearchHit {
  path: string;
  name: string;
  matchedName: boolean;
  matchedContent: boolean;
  snippet?: string;
}

export interface FileContent {
  path: string;
  name: string;
  ext: string;
  content: string;
  /** Opaque token (mtime + size) used to detect concurrent edits. */
  version: string;
}
