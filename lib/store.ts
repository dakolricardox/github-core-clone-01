// The forge's in-memory store: repositories (with git refs/objects), issues, labels, pull requests
// and comments. All state lives in memory, keyed deterministically by owner/name; nothing reads the
// wall clock. Every mutation returns the shaped GitHub REST object. Identifiers are assigned from
// deterministic counters, never from Date.now() or Math.random().

import { buildCommit, buildTree, collectReachable, hashObject, parseCommit, parseTree, peelTag, readPack, ZERO_OID, type GitObject, type GitObjectType, type TreeEntry } from './gitlib.ts';

// ---------------------------------------------------------------- identities

/** The fixed commit author for any commit the forge itself creates (contents API, merges). */
const FORGE_NAME = 'Forge Bot';
const FORGE_EMAIL = 'forge@example.invalid';
const FORGE_AUTHOR = `${FORGE_NAME} <${FORGE_EMAIL}>`;
const FORGE_EPOCH = 1_700_000_000;

// ---------------------------------------------------------------- repository

interface BranchMap {
  // refs/heads/<name> -> oid; refs/tags/<name> -> oid kept separately
  heads: Map<string, string>;
  tags: Map<string, string>;
}

export class Repository {
  readonly id: number;
  owner: string;
  name: string;
  description: string;
  privateFlag: boolean;
  defaultBranch = 'main';
  readonly objects = new Map<string, GitObject>();
  readonly heads = new Map<string, string>(); // branch -> oid
  readonly tags = new Map<string, string>(); // tag -> oid

  // Monotonic counter bumped on every git-state mutation (objects/heads/tags); drives the
  // protocol-body caches below. Not a wall clock: purely a state-version.
  version = 0;
  // Cached smart-HTTP bodies, valid while protoVersion === version.
  protoVersion = -1;
  uploadV0: Buffer | null = null;
  receiveV0: Buffer | null = null;
  uploadInfoRefs: Buffer | null = null;
  receiveInfoRefs: Buffer | null = null;
  lsRefsCache: Map<string, Buffer> | null = null;
  fetchCache: Map<string, { pack: Buffer; shallowBoundaries: string[] }> | null = null;
  childOfCache: Map<string, string> | null = null;
  readonly labels = new Map<string, { name: string; color: string }>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, PullRequest>();
  readonly comments = new Map<number, Comment>();
  private nextIssueNumber = 1;
  private nextPullNumber = 1;
  private nextCommentId = 1;
  private nextLabelId = 1;

  constructor(id: number, owner: string, name: string, description: string, privateFlag: boolean) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.privateFlag = privateFlag;
  }

  // ---- git objects ----
  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) {
      this.objects.set(oid, { type, data });
      this.invalidateProtocol();
    }
    return oid;
  }

  /** Drop every cached smart-HTTP body; call on any heads/tags/objects change. */
  invalidateProtocol(): void {
    this.version += 1;
    if (this.protoVersion !== this.version) {
      this.protoVersion = -1;
      this.uploadV0 = null;
      this.receiveV0 = null;
      this.uploadInfoRefs = null;
      this.receiveInfoRefs = null;
      this.lsRefsCache = null;
      this.fetchCache = null;
      this.childOfCache = null;
    }
  }

  hasObject(oid: string): boolean {
    return this.objects.has(oid);
  }

  branchOid(branch: string): string | undefined {
    return this.heads.get(branch);
  }

  allRefs(): Array<{ name: string; oid: string }> {
    const refs: Array<{ name: string; oid: string }> = [];
    for (const [branch, oid] of this.heads) refs.push({ name: `refs/heads/${branch}`, oid });
    for (const [tag, oid] of this.tags) refs.push({ name: `refs/tags/${tag}`, oid });
    return refs;
  }

  /** The commit graph reachable from the given tips (returns object oids). */
  reachable(tips: Iterable<string>): Set<string> {
    return collectReachable(tips, (oid) => this.objects.get(oid));
  }

  /** The tree entries of the tree at a commit/ref. */
  treeAt(refOrSha: string): TreeEntry[] {
    let oid = refOrSha;
    const head = this.heads.get(refOrSha);
    if (head !== undefined) oid = head;
    const commit = this.objects.get(oid);
    if (!commit || commit.type !== 'commit') throw new Error('not a commit');
    const treeOid = parseCommit(commit.data).tree;
    const tree = this.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') throw new Error('tree missing');
    return parseTree(tree.data);
  }

  /** Build a commit updating the tree at a branch: set/delete a path, add/remove refs. */
  commitTree(opts: {
    branch: string;
    parentSha?: string;
    message: string;
    changes: Array<{ path: string; blob?: Buffer; mode?: string }>; // blob set => put, else delete
  }): { sha: string; blobShas: Map<string, string> } {
    const parentSha = opts.parentSha ?? this.heads.get(opts.branch);
    const parentCommit = parentSha ? this.objects.get(parentSha) : undefined;
    const parentTree = parentCommit && parentCommit.type === 'commit' ? parseCommit(parentCommit.data).tree : undefined;
    const treeOid = parentTree ?? this.putObject('tree', buildTree([]));

    // Build a full tree in memory for simplicity (repo file trees are small).
    const treeData = this.collectTree(treeOid);
    for (const change of opts.changes) {
      const segments = change.path.split('/').filter((seg) => seg !== '');
      if (change.blob === undefined) {
        deleteTreePath(treeData, segments);
      } else {
        setTreePath(treeData, segments, change.blob, change.mode ?? '100644');
      }
    }
    const newTreeOid = this.writeTree(treeData);
    const parents = parentSha === undefined ? [] : [parentSha];
    const commit = buildCommit({
      tree: newTreeOid,
      parents,
      message: opts.message,
      author: FORGE_AUTHOR,
      committer: FORGE_AUTHOR,
      timestamp: FORGE_EPOCH,
    });
    const sha = this.putObject('commit', commit);
    this.heads.set(opts.branch, sha);
    this.invalidateProtocol();
    // Collect blob shas for the reply (git blob id per changed path).
    const blobShas = new Map<string, string>();
    for (const change of opts.changes) {
      if (change.blob !== undefined) blobShas.set(change.path, hashObject('blob', change.blob));
    }
    return { sha, blobShas };
  }

  private collectTree(treeOid: string): TreeData {
    return readTreeData(this, treeOid);
  }

  private writeTree(data: TreeData): string {
    return writeTreeData(this, data);
  }

  // ---- contents ----
  /** The blob oid at a path in a given ref, or undefined. Also returns the tree it lives in. */
  blobAtPath(refOrSha: string, path: string): { oid: string; data: Buffer } | undefined {
    let oid = refOrSha;
    const head = this.heads.get(refOrSha);
    if (head !== undefined) oid = head;
    const commit = this.objects.get(oid);
    if (!commit || commit.type !== 'commit') return undefined;
    const treeOid = parseCommit(commit.data).tree;
    const segments = path.split('/').filter((seg) => seg !== '');
    const found = findTreePath(this, treeOid, segments);
    if (found === undefined) return undefined;
    const blob = this.objects.get(found);
    if (!blob || blob.type !== 'blob') return undefined;
    return { oid: found, data: blob.data };
  }

  /** All entries of a directory path in a ref (for the directory listing). */
  dirEntries(refOrSha: string, path: string): Array<{ mode: string; name: string; oid: string }> {
    let oid = refOrSha;
    const head = this.heads.get(refOrSha);
    if (head !== undefined) oid = head;
    const commit = this.objects.get(oid);
    if (!commit || commit.type !== 'commit') return [];
    const treeOid = parseCommit(commit.data).tree;
    const segments = path.split('/').filter((seg) => seg !== '');
    const dirOid = findTreePath(this, treeOid, segments);
    if (dirOid === undefined) return [];
    const tree = this.objects.get(dirOid);
    if (!tree || tree.type !== 'tree') return [];
    return parseTree(tree.data);
  }

  /** Commit history reachable from a ref, newest first, bounded. */
  commitHistory(refOrSha: string, limit: number): string[] {
    let oid = refOrSha;
    const head = this.heads.get(refOrSha);
    if (head !== undefined) oid = head;
    const out: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [oid];
    while (queue.length && out.length < limit) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const commit = this.objects.get(current);
      if (!commit || commit.type !== 'commit') continue;
      out.push(current);
      for (const parent of parseCommit(commit.data).parents) queue.push(parent);
    }
    return out;
  }

  /** Direct parent of a commit, or undefined when absent/root/non-commit. */
  parentOf(oid: string): string | undefined {
    const commit = this.objects.get(oid);
    if (!commit || commit.type !== 'commit') return undefined;
    const parents = parseCommit(commit.data).parents;
    return parents.length > 0 ? parents[0] : undefined;
  }

  isAncestor(maybeAncestor: string, tip: string): boolean {
    if (this.childOfCache === null) this.childOfCache = new Map();
    const key = `${maybeAncestor}\u0000${tip}`;
    const cached = this.childOfCache.get(key);
    if (cached !== undefined) return cached === maybeAncestor;
    let cursor = tip;
    let hops = 0;
    while (cursor && cursor !== maybeAncestor && hops < 4096) {
      cursor = this.parentOf(cursor) ?? '';
      hops += 1;
    }
    const result = cursor === maybeAncestor;
    this.childOfCache.set(key, result ? maybeAncestor : '');
    return result;
  }

  // ---- labels / issues / pulls / comments ----
  addLabel(name: string, color: string): { name: string; color: string } {
    const label = { name, color };
    this.labels.set(name, label);
    return label;
  }

  createIssue(title: string, body: string, labels: string[]): Issue {
    const number = this.nextIssueNumber++;
    const createdAt = FORGE_EPOCH + number;
    const issue: Issue = {
      id: number,
      number,
      title,
      body,
      state: 'open',
      labels: labels.map((name) => ({ name, color: this.labels.get(name)?.color ?? 'ededed' })),
      createdAt,
      createdAtIso: new Date(createdAt * 1000).toISOString(),
    };
    this.issues.set(number, issue);
    return issue;
  }

  addComment(issueNumber: number, body: string): Comment {
    const id = this.nextCommentId++;
    const comment: Comment = { id, issueNumber, body };
    this.comments.set(id, comment);
    return comment;
  }

  commentsFor(issueNumber: number): Comment[] {
    return [...this.comments.values()].filter((comment) => comment.issueNumber === issueNumber);
  }

  createPull(opts: { title: string; body: string; head: string; base: string; headSha?: string; baseSha?: string }): PullRequest {
    const number = this.nextPullNumber++;
    const pull: PullRequest = {
      number,
      title: opts.title,
      body: opts.body,
      head: opts.head,
      base: opts.base,
      headSha: opts.headSha ?? '',
      baseSha: opts.baseSha ?? '',
      state: 'open',
      merged: false,
      mergedAt: undefined,
      mergeCommitSha: undefined,
      createdAt: FORGE_EPOCH + number,
    };
    this.pulls.set(number, pull);
    return pull;
  }
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Array<{ name: string; color: string }>;
  createdAt: number;
  createdAtIso: string;
}

export interface Comment {
  id: number;
  issueNumber: number;
  body: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt?: number;
  mergeCommitSha?: string;
  createdAt: number;
}

// ---------------------------------------------------------------- tree data model

type TreeData = Map<string, { mode: string; blob?: Buffer; children?: TreeData }>;

function readTreeData(repo: Repository, treeOid: string): TreeData {
  const data: TreeData = new Map();
  const tree = repo.objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return data;
  for (const entry of parseTree(tree.data)) {
    if (entry.mode === '40000') {
      data.set(entry.name, { mode: '40000', children: readTreeData(repo, entry.oid) });
    } else {
      const blob = repo.objects.get(entry.oid);
      data.set(entry.name, { mode: entry.mode, blob: blob ? blob.data : Buffer.alloc(0) });
    }
  }
  return data;
}

function setTreePath(data: TreeData, segments: string[], blob: Buffer, mode: string): void {
  const name = segments[0];
  if (segments.length === 1) {
    data.set(name, { mode, blob });
    return;
  }
  let node = data.get(name);
  if (!node || node.children === undefined) {
    node = { mode: '40000', children: new Map() };
    data.set(name, node);
  }
  setTreePath(node.children!, segments.slice(1), blob, mode);
}

function deleteTreePath(data: TreeData, segments: string[]): void {
  const name = segments[0];
  if (segments.length === 1) {
    data.delete(name);
    return;
  }
  const node = data.get(name);
  if (!node || node.children === undefined) return;
  deleteTreePath(node.children, segments.slice(1));
  if (node.children.size === 0) data.delete(name);
}

function writeTreeData(repo: Repository, data: TreeData): string {
  const entries: TreeEntry[] = [];
  for (const [name, node] of [...data.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (node.children !== undefined) {
      entries.push({ mode: '40000', name, oid: writeTreeData(repo, node.children) });
    } else {
      entries.push({ mode: node.mode, name, oid: repo.putObject('blob', node.blob ?? Buffer.alloc(0)) });
    }
  }
  return repo.putObject('tree', buildTree(entries));
}

function findTreePath(repo: Repository, treeOid: string, segments: string[]): string | undefined {
  if (segments.length === 0) return treeOid;
  const tree = repo.objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return undefined;
  const name = segments[0];
  for (const entry of parseTree(tree.data)) {
    if (entry.name !== name) continue;
    if (segments.length === 1) return entry.oid;
    if (entry.mode !== '40000') return undefined;
    return findTreePath(repo, entry.oid, segments.slice(1));
  }
  return undefined;
}

// ---------------------------------------------------------------- the store

export class Store {
  readonly viewer: string;
  private repos = new Map<string, Repository>();
  private nextRepoId = 1;

  constructor(viewer: string) {
    this.viewer = viewer;
  }

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  get(owner: string, name: string): Repository | undefined {
    return this.repos.get(this.key(owner, name));
  }

  allRepos(): Repository[] {
    return [...this.repos.values()];
  }

  createRepo(owner: string, name: string, opts: { description?: string; privateFlag?: boolean }): Repository {
    const existing = this.repos.get(this.key(owner, name));
    if (existing) return existing;
    const repo = new Repository(this.nextRepoId++, owner, name, opts.description ?? '', opts.privateFlag ?? false);
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }
}
