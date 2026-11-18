// The forge's HTTP surface: git smart HTTP, GitHub REST v3, GraphQL v4 and MCP over Streamable HTTP,
// all on one node:http server. main.ts binds and drives the lifecycle; this file owns every route.
//
// Everything served is derived from in-memory state keyed deterministically. Nothing reads the wall
// clock or a random source: ids come from counters, commit timestamps are fixed constants, and the
// request-id header is a counter. Two runs on the same data answer byte-for-byte the same.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTree,
  ZERO_OID,
  type GitObject,
} from './lib/gitlib.ts';
import { Repository, Store, type Issue, type PullRequest } from './lib/store.ts';
import {
  applyPush,
  buildFetchV0,
  buildFetchV2,
  buildLsRefs,
  buildPushReport,
  buildV0Advertisement,
  buildV2Advertisement,
  parseFetchArgs,
  parsePushCommands,
  pktFlush,
  pktLine,
  tokenize,
  type PushReportResult,
} from './lib/git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

interface ForgeContext {
  token: string;
  store: Store;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return requestCounter.toString(16);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- read-response cache
// A read reply is a pure function of the store state it derives from. We memoize
// (state-fingerprint -> serialized body) so repeated reads of unchanged state skip
// re-shaping / re-pack-building. Any mutation changes the fingerprint, so a cache hit
// is always byte-identical to a fresh compute — we never serve stale bytes. Bounded.
const issueCache = new Map<string, Buffer>();
const fetchCache = new Map<string, Buffer>();
const ISSUE_CACHE_MAX = 8192;
const FETCH_CACHE_MAX = 512;

function issueFingerprint(repo: Repository, issue: Issue): string {
  const labels = issue.labels.map((l) => l.name + ':' + l.color).join(',');
  return repo.owner + '|' + issue.id + '|' + issue.number + '|' + issue.title + '|' +
    issue.body + '|' + issue.state + '|' + issue.createdAt + '|' + labels;
}

/** Serialized issue JSON (\n-terminated, exactly as sendJson emits) or a cached copy. */
function issueJsonBody(repo: Repository, issue: Issue): Buffer {
  const key = 'i|' + issueFingerprint(repo, issue);
  const hit = issueCache.get(key);
  if (hit !== undefined) return hit;
  const body = Buffer.from(JSON.stringify(issueJson(repo, issue)) + '\n', 'utf8');
  if (issueCache.size > ISSUE_CACHE_MAX) issueCache.clear();
  issueCache.set(key, body);
  return body;
}

function repoRefSignature(repo: Repository): string {
  const heads = [...repo.heads.entries()].map(([k, v]) => k + '=' + v).sort().join(',');
  const tags = [...repo.tags.entries()].map(([k, v]) => k + '=' + v).sort().join(',');
  return repo.owner + '/' + repo.name + '|h:' + heads + '|t:' + tags;
}

function fetchCacheKey(repo: Repository, kind: 'v2' | 'v0', req: { wants: string[]; haves: string[]; shallow: string[]; depth?: number }): string {
  const sort = (a: string[]) => [...a].sort().join(',');
  // objects.size is in the key: a push can add objects (a pack ships every object the
  // client wants) while keeping the same ref, so ref sig alone would miss the growth.
  return 'f|' + kind + '|' + repoRefSignature(repo) + '|o:' + repo.objects.size +
    '|w:' + sort(req.wants) + '|hv:' + sort(req.haves) + '|sh:' + sort(req.shallow) + '|d:' + (req.depth ?? -1);
}

function authToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header === undefined) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- REST shaping

function repoJson(repo: Repository): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.id + 1000 },
    private: repo.privateFlag,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `http://entry/${repo.owner}/${repo.name}`,
    has_issues: true,
  };
}

function labelJson(label: { name: string; color: string }): Record<string, unknown> {
  return { id: 0, name: label.name, color: label.color };
}

function issueJson(repo: Repository, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: repo.owner },
    created_at: new Date(issue.createdAt * 1000).toISOString(),
  };
}

function commentJson(comment: { id: number; body: string }): Record<string, unknown> {
  return { id: comment.id, body: comment.body };
}

function pullJson(repo: Repository, pull: PullRequest): Record<string, unknown> {
  const headSha = pull.headSha || repo.heads.get(pull.head) || '';
  const baseSha = pull.baseSha || repo.heads.get(pull.base) || '';
  const merged = pull.merged;
  const mergeable = merged ? true : null;
  return {
    id: pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged,
    mergeable,
    merge_commit_sha: pull.mergeCommitSha ?? null,
    merged_at: merged && pull.mergedAt !== undefined ? new Date(pull.mergedAt * 1000).toISOString() : null,
    head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}` },
    user: { login: repo.owner },
  };
}

// ---------------------------------------------------------------- GraphQL

interface GqlContext {
  ctx: ForgeContext;
}

function gqlId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64').replace(/=+$/, '');
}

function parseGqlId(value: string): { kind: string; id: number } | null {
  let s = value;
  while (s.length % 4 !== 0) s += '=';
  const decoded = Buffer.from(s, 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  if (idx <= 0) return null;
  const id = Number(decoded.slice(idx + 1));
  if (!Number.isInteger(id)) return null;
  return { kind: decoded.slice(0, idx), id };
}

interface IssueNode {
  kind: 'issue';
  id: string;
  number: number;
  title: string;
  state: string;
  body: string;
  labels: Array<{ name: string; color: string }>;
  createdAt: number;
}

interface PullNode {
  kind: 'pull';
  id: string;
  number: number;
  title: string;
  body: string;
  headRefName: string;
  baseRefName: string;
  mergeable: string;
  state: string;
  merged: boolean;
  files: string[];
  createdAt: number;
}

interface RepoNode {
  kind: 'repo';
  id: string;
  databaseId: number;
  name: string;
  nameWithOwner: string;
  ownerLogin: string;
  defaultBranchRef: string;
  viewerPermission: string;
  hasIssuesEnabled: boolean;
}

interface CommentNode {
  kind: 'comment';
  id: string;
  body: string;
}

type Node = IssueNode | PullNode | RepoNode | CommentNode;

function collectIssues(repo: Repository, order: 'asc' | 'desc'): IssueNode[] {
  const issues = [...repo.issues.values()];
  issues.sort((a, b) => (order === 'asc' ? a.number - b.number : b.number - a.number));
  return issues.map((issue) => ({
    kind: 'issue',
    id: gqlId('Issue', issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    labels: issue.labels,
    createdAt: issue.createdAt,
  }));
}

function collectPulls(repo: Repository): PullNode[] {
  const pulls = [...repo.pulls.values()];
  pulls.sort((a, b) => b.number - a.number);
  return pulls.map((pull) => ({
    kind: 'pull',
    id: gqlId('PullRequest', pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    headRefName: pull.head,
    baseRefName: pull.base,
    mergeable: pull.merged ? 'MERGEABLE' : 'UNKNOWN',
    state: pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED',
    merged: pull.merged,
    files: pullFiles(repo, pull),
    createdAt: pull.createdAt,
  }));
}

function pullFiles(repo: Repository, pull: PullRequest): string[] {
  const baseTip = pull.baseSha || repo.heads.get(pull.base) || '';
  const headTip = pull.headSha || repo.heads.get(pull.head) || '';
  const changed = new Set<string>();
  try {
    const baseTree = collectAllPaths(repo, baseTip);
    const headTree = collectAllPaths(repo, headTip);
    for (const [path, oid] of headTree) {
      if (baseTree.get(path) !== oid) changed.add(path);
    }
    for (const [path] of baseTree) {
      if (!headTree.has(path)) changed.add(path);
    }
  } catch {
    // a missing ref means no files can be diffed
  }
  return [...changed].sort();
}

function collectAllPaths(repo: Repository, tip: string): Map<string, string> {
  const out = new Map<string, string>();
  if (tip === '') return out;
  const commit = repo.objects.get(tip);
  if (!commit || commit.type !== 'commit') return out;
  const treeOid = parseCommit(commit.data).tree;
  walkTree(repo, treeOid, '', out);
  return out;
}

function walkTree(repo: Repository, treeOid: string, prefix: string, out: Map<string, string>): void {
  const tree = repo.objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') walkTree(repo, entry.oid, path, out);
    else out.set(path, entry.oid);
  }
}

interface GqlTypeRef {
  kind: string;
  name?: string;
  ofType?: GqlTypeRef;
}

// ---------------------------------------------------------------- GraphQL executor

interface GqlField {
  name: string;
  alias: string | null;
  args: Record<string, unknown>;
  sub: GqlSelection | null;
}
interface GqlSelection {
  fields: GqlField[];
}

interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: GqlSelection;
}

interface GqlExecutionError {
  message: string;
}

interface GqlResult {
  data: Record<string, unknown> | null;
  errors: GqlExecutionError[];
}

// ---------------------------------------------------------------- GraphQL parser

class GqlParser {
  private text: string;
  private pos = 0;

  constructor(text: string) {
    this.text = text;
  }

  skipWs(): void {
    while (this.pos < this.text.length) {
      const c = this.text[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') this.pos += 1;
      else if (c === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
      } else break;
    }
  }

  peek(): string {
    return this.text[this.pos] ?? '';
  }

  expectWord(): string {
    this.skipWs();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.text.slice(this.pos));
    if (!m) throw new Error('expected a name');
    this.pos += m[0].length;
    return m[0];
  }

  expectPunct(punct: string): void {
    this.skipWs();
    if (this.text[this.pos] === punct) {
      this.pos += 1;
      return;
    }
    throw new Error(`expected ${punct}`);
  }

  peekPunct(punct: string): boolean {
    this.skipWs();
    return this.text[this.pos] === punct;
  }

  parseValue(): unknown {
    this.skipWs();
    const c = this.peek();
    if (c === '$') {
      this.pos += 1;
      return { var: this.expectWord() };
    }
    if (c === '{') return this.parseInlineObject();
    if (c === '[') return this.parseInlineArray();
    if (c === '"') return this.parseString();
    if (c === '-' || /^[0-9]/.test(c)) return this.parseNumber();
    return this.expectWord(); // enum
  }

  parseInlineObject(): Record<string, unknown> {
    this.expectPunct('{');
    const obj: Record<string, unknown> = {};
    while (!this.peekPunct('}')) {
      const key = this.expectWord();
      this.expectPunct(':');
      obj[key] = this.parseValue();
    }
    this.expectPunct('}');
    return obj;
  }

  parseInlineArray(): unknown[] {
    this.expectPunct('[');
    const arr: unknown[] = [];
    while (!this.peekPunct(']')) {
      arr.push(this.parseValue());
    }
    this.expectPunct(']');
    return arr;
  }

  parseString(): string {
    this.expectPunct('"');
    let out = '';
    while (this.pos < this.text.length) {
      const c = this.text[this.pos++];
      if (c === '"') return out;
      if (c === '\\') {
        const esc = this.text[this.pos++];
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else if (esc === '"') out += '"';
        else if (esc === '\\') out += '\\';
        else if (esc === 'u') {
          out += String.fromCharCode(Number.parseInt(this.text.slice(this.pos, this.pos + 4), 16));
          this.pos += 4;
        } else out += esc;
      } else out += c;
    }
    throw new Error('unterminated string');
  }

  parseNumber(): number {
    this.skipWs();
    const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.pos));
    if (!m) throw new Error('expected number');
    this.pos += m[0].length;
    return Number(m[0]);
  }

  parseSelection(): GqlSelection {
    this.expectPunct('{');
    const fields: GqlField[] = [];
    while (!this.peekPunct('}')) {
      fields.push(this.parseField());
    }
    this.expectPunct('}');
    return { fields };
  }

  parseField(): GqlField {
    this.skipWs();
    if (this.text.startsWith('...', this.pos)) {
      this.pos += 3;
      if (this.peek() === ' ') {
        // inline fragment ... on Type { }
        this.skipWs();
        if (this.text.startsWith('on ', this.pos)) {
          this.pos += 3;
          this.expectWord();
          const sub = this.parseSelection();
          return { name: '__inline', alias: null, args: {}, sub };
        }
        this.expectWord(); // fragment spread name
        return { name: '__spread', alias: null, args: {}, sub: null };
      }
      this.expectWord();
      return { name: '__spread', alias: null, args: {}, sub: null };
    }
    const first = this.expectWord();
    let name = first;
    let alias: string | null = null;
    if (this.peekPunct(':')) {
      this.expectPunct(':');
      alias = first;
      name = this.expectWord();
    }
    const args: Record<string, unknown> = {};
    if (this.peekPunct('(')) {
      this.expectPunct('(');
      while (!this.peekPunct(')')) {
        const argName = this.expectWord();
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
      this.expectPunct(')');
    }
    let sub: GqlSelection | null = null;
    if (this.peekPunct('{')) sub = this.parseSelection();
    return { name, alias, args, sub };
  }

  parseVariableDefs(): void {
    this.expectPunct('(');
    while (!this.peekPunct(')')) {
      this.expectPunct('$');
      this.expectWord();
      this.expectPunct(':');
      this.parseType();
      if (this.peekPunct('=')) {
        this.expectPunct('=');
        this.parseValue();
      }
    }
    this.expectPunct(')');
  }

  parseType(): void {
    if (this.peekPunct('[')) {
      this.expectPunct('[');
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectWord();
    }
    if (this.peekPunct('!')) this.expectPunct('!');
  }

  parse(): GqlOperation[] {
    const ops: GqlOperation[] = [];
    for (;;) {
      this.skipWs();
      if (this.pos >= this.text.length) break;
      const type = this.expectWord();
      if (type === 'fragment') {
        // skip fragment definitions
        this.expectWord();
        this.skipWs();
        if (this.text.startsWith('on ', this.pos)) {
          this.pos += 3;
          this.expectWord();
        }
        this.parseSelection();
        continue;
      }
      if (type === 'query' || type === 'mutation') {
        let name: string | null = null;
        if (this.peekPunct('(')) {
          this.parseVariableDefs();
        }
        if (!this.peekPunct('{')) {
          name = this.expectWord();
          if (this.peekPunct('(')) this.parseVariableDefs();
        }
        const selection = this.parseSelection();
        ops.push({ type: type === 'query' ? 'query' : 'mutation', name, selection });
      } else if (type === '{') {
        this.pos -= 1;
        const selection = this.parseSelection();
        ops.push({ type: 'query', name: null, selection });
      } else {
        throw new Error(`unexpected ${type}`);
      }
    }
    return ops;
  }
}

// ---------------------------------------------------------------- GraphQL resolver

function resolveValue(value: unknown, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if ('var' in record) {
      const name = record.var as string;
      return variables[name];
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) out[k] = resolveValue(v, variables);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, variables));
  return value;
}

interface ResolveEnv {
  ctx: ForgeContext;
  variables: Record<string, unknown>;
  errors: GqlExecutionError[];
}

/** Resolve a document against the store. Returns data + errors. */
function resolveDocument(op: GqlOperation, ctx: ForgeContext, variables: Record<string, unknown>): GqlResult {
  const env: ResolveEnv = { ctx, variables, errors: [] };
  const root = resolveSelection(op.selection, {}, env, rootResolvers(env));
  return { data: env.errors.length > 0 ? { ...root, __errors: undefined } : root, errors: env.errors };
}

function rootResolvers(env: ResolveEnv): Record<string, (args: Record<string, unknown>) => unknown> {
  const { ctx } = env;
  return {
    viewer(): Record<string, unknown> {
      return { login: ctx.store.viewer };
    },
    repository(args: Record<string, unknown>): Record<string, unknown> | null {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      const repo = ctx.store.get(owner, name);
      if (!repo) return null;
      return repoNode(ctx, repo);
    },
    node(args: Record<string, unknown>): Record<string, unknown> | null {
      const id = String(args.id ?? '');
      const parsed = parseGqlId(id);
      if (!parsed) return null;
      const node = nodeById(ctx, parsed.kind, parsed.id);
      if (!node) return null;
      return nodeJson(ctx, node);
    },
  };
}

function repoNode(ctx: ForgeContext, repo: Repository): Record<string, unknown> {
  return {
    __repo: repo,
    __kind: 'repo',
    id: gqlId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    defaultBranchRef: repo.heads.has(repo.defaultBranch) ? { name: repo.defaultBranch } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function issueNodeJson(ctx: ForgeContext, repo: Repository, issue: Issue): Record<string, unknown> {
  return {
    __kind: 'issue',
    __repo: repo,
    id: gqlId('Issue', issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
  };
}

function pullNodeJson(ctx: ForgeContext, repo: Repository, pull: PullRequest): Record<string, unknown> {
  return {
    __kind: 'pull',
    __repo: repo,
    id: gqlId('PullRequest', pull.number),
    number: pull.number,
    state: pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.head,
    baseRefName: pull.base,
    mergeable: pull.merged ? 'MERGEABLE' : 'UNKNOWN',
    files: { nodes: pullFiles(repo, pull).map((path) => ({ path })) },
  };
}

function nodeById(ctx: ForgeContext, kind: string, id: number): Node | null {
  if (kind === 'Repository') {
    const repo = ctx.store.allRepos().find((r) => r.id === id);
    return repo ? { kind: 'repo', id: gqlId('Repository', repo.id), databaseId: repo.id, name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}`, ownerLogin: repo.owner, defaultBranchRef: repo.defaultBranch, viewerPermission: 'ADMIN', hasIssuesEnabled: true } : null;
  }
  return null;
}

function nodeJson(ctx: ForgeContext, node: Node): Record<string, unknown> {
  if (node.kind === 'repo') {
    return { id: node.id, name: node.name, nameWithOwner: node.nameWithOwner, databaseId: node.databaseId, __kind: 'repo', __repo: repoById(ctx, node.databaseId) };
  }
  return { id: node.id, __kind: node.kind };
}

function repoById(ctx: ForgeContext, id: number): Repository | undefined {
  return ctx.store.allRepos().find((r) => r.id === id);
}

interface ConnResolve {
  nodes: unknown[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

function paginate(list: unknown[], first: number | undefined, after: string | null): { slice: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } {
  let start = 0;
  if (after !== null && after !== undefined) {
    const parsed = parseGqlId(after);
    if (parsed) {
      start = list.findIndex((item, i) => cursorOf(item) === after);
      if (start >= 0) start += 1;
      else start = 0;
    }
  }
  const limit = first === undefined || first === null ? list.length : first;
  const slice = list.slice(start, start + limit);
  const hasNextPage = start + limit < list.length;
  const endCursor = slice.length > 0 ? cursorOf(slice[slice.length - 1]) : null;
  return { slice, pageInfo: { hasNextPage, endCursor } };
}

function cursorOf(item: unknown): string | null {
  if (item !== null && typeof item === 'object') {
    const record = item as Record<string, unknown>;
    if (typeof record.id === 'string') return record.id;
  }
  return null;
}

function resolveSelection(selection: GqlSelection | null, parent: Record<string, unknown>, env: ResolveEnv, resolvers: Record<string, (args: Record<string, unknown>) => unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!selection) return out;
  for (const field of selection.fields) {
    const args = resolveValue(field.args, env.variables) as Record<string, unknown>;
    let value: unknown;
    let handled = false;
    if (field.name === '__inline') {
      // An inline fragment (... on Type { }) spreads its fields into the parent selection.
      if (field.sub) {
        const merged = resolveSelection(field.sub, parent, env, resolvers);
        for (const [k, v] of Object.entries(merged)) out[k] = v;
      }
      handled = true;
      continue;
    }
    if (field.name === '__typename' && parent.__kind !== undefined) {
      const kind = parent.__kind as string;
      value = kind === 'repo' ? 'Repository' : kind === 'issue' ? 'Issue' : kind === 'pull' ? 'PullRequest' : 'Node';
      handled = true;
    }
    if (field.name === '__type') {
      value = resolveIntrospectionType(String(args.name ?? ''));
      handled = true;
    }
    if (!handled) {
      const resolver = resolvers[field.name];
      if (resolver) {
        value = resolver(args);
        handled = true;
      }
    }
    if (!handled && parent !== null && parent !== undefined) {
      const existing = parent[field.name];
      if (existing !== undefined) {
        value = existing;
        handled = true;
      }
    }
    if (!handled) {
      const err: GqlExecutionError = { message: `Cannot query field "${field.name}" on type "${parent.__kind ?? 'Query'}"` };
      env.errors.push(err);
      value = null;
    }
    // Recurse into a sub-selection for whatever resolved (resolver or direct key).
    if (field.sub && value !== null && value !== undefined) {
      if (Array.isArray(value)) {
        value = value.map((item) =>
          typeof item === 'object' && item !== null
            ? resolveSelection(field.sub, item as Record<string, unknown>, env, childResolvers(env, item as Record<string, unknown>, field.name))
            : item,
        );
      } else if (typeof value === 'object') {
        value = resolveSelection(field.sub, value as Record<string, unknown>, env, childResolvers(env, value as Record<string, unknown>, field.name));
      }
    }
    const key = field.alias ?? field.name;
    out[key] = value;
  }
  return out;
}

function childResolvers(env: ResolveEnv, parent: Record<string, unknown>, fieldName: string): Record<string, (args: Record<string, unknown>) => unknown> {
  const kind = parent.__kind as string | undefined;
  const ctx = env.ctx;
  const repo = parent.__repo as Repository | undefined;
  const resolvers: Record<string, (args: Record<string, unknown>) => unknown> = {};
  if (kind === 'repo' && repo) {
    resolvers.issue = (args) => {
      const number = Number(args.number);
      const issue = repo.issues.get(number);
      return issue ? issueNodeJson(ctx, repo, issue) : null;
    };
    resolvers.issues = (args) => {
      const states = args.states as string[] | undefined;
      const orderBy = args.orderBy as Record<string, unknown> | undefined;
      const direction = orderBy ? String(orderBy.direction ?? 'DESC') : 'DESC';
      const first = args.first === undefined ? undefined : Number(args.first);
      const after = args.after === undefined ? null : String(args.after);
      let nodes: IssueNode[] = collectIssues(repo, direction === 'ASC' ? 'asc' : 'desc');
      if (states && Array.isArray(states)) {
        const openOnly = states.includes('OPEN') && !states.includes('CLOSED');
        if (openOnly) nodes = nodes.filter((n) => n.state === 'OPEN');
      }
      const { slice, pageInfo } = paginate(nodes, first, after);
      return { nodes: slice, pageInfo };
    };
    resolvers.pullRequests = (args) => {
      const first = args.first === undefined ? undefined : Number(args.first);
      const nodes = collectPulls(repo);
      const { slice } = paginate(nodes, first, null);
      return { nodes: slice };
    };
    resolvers.pullRequest = (args) => {
      const number = Number(args.number);
      const pull = repo.pulls.get(number);
      return pull ? pullNodeJson(ctx, repo, pull) : null;
    };
  }
  if (kind === 'pull' && repo) {
    resolvers.files = (args) => {
      const pull = repo.pulls.get(parent.number as number);
      if (!pull) return { nodes: [] };
      return { nodes: pullFiles(repo, pull).map((path) => ({ path })) };
    };
  }
  return resolvers;
}

function resolveIntrospectionType(name: string): Record<string, unknown> {
  const types: Record<string, { fields: string[]; enumValues: string[] }> = {
    Issue: { fields: ['id', 'number', 'title', 'state', 'body'], enumValues: [] },
    PullRequest: { fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'], enumValues: [] },
    Repository: { fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'], enumValues: [] },
    SearchType: { fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
    IssueState: { fields: [], enumValues: ['OPEN', 'CLOSED'] },
    PullRequestState: { fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
    MergeableState: { fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
    PullRequestMergeMethod: { fields: [], enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
    RepositoryPermission: { fields: [], enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
    IssueOrderField: { fields: [], enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
    OrderDirection: { fields: [], enumValues: ['ASC', 'DESC'] },
  };
  const spec = types[name];
  if (!spec) return null as unknown as Record<string, unknown>;
  return {
    name,
    fields: spec.fields.map((fieldName) => ({ name: fieldName })),
    enumValues: spec.enumValues.map((valueName) => ({ name: valueName })),
  };
}

function runMutation(ctx: ForgeContext, op: GqlOperation, variables: Record<string, unknown>): GqlResult {
  const env: ResolveEnv = { ctx, variables, errors: [] };
  const mutations: Record<string, (args: Record<string, unknown>) => unknown> = {
    createIssue: (args) => {
      const input = (args.input !== undefined && typeof args.input === 'object' ? args.input : args) as Record<string, unknown>;
      const repositoryId = String(input.repositoryId ?? '');
      const parsed = parseGqlId(repositoryId);
      if (!parsed || parsed.kind !== 'Repository') return null;
      const repo = ctx.store.allRepos().find((r) => r.id === parsed.id);
      if (!repo) return null;
      const title = String(input.title ?? '');
      const body = input.body === undefined ? '' : String(input.body);
      const issue = repo.createIssue(title, body, []);
      return { issue: issueNodeJson(ctx, repo, issue) };
    },
    closeIssue: (args) => {
      const input = (args.input !== undefined && typeof args.input === 'object' ? args.input : args) as Record<string, unknown>;
      const issueId = String(input.issueId ?? '');
      const parsed = parseGqlId(issueId);
      if (!parsed || parsed.kind !== 'Issue') return null;
      for (const repo of ctx.store.allRepos()) {
        const issue = repo.issues.get(parsed.id);
        if (issue) {
          issue.state = 'closed';
          return { issue: issueNodeJson(ctx, repo, issue) };
        }
      }
      return null;
    },
    createPullRequest: (args) => {
      const input = (args.input !== undefined && typeof args.input === 'object' ? args.input : args) as Record<string, unknown>;
      const repositoryId = String(input.repositoryId ?? '');
      const parsed = parseGqlId(repositoryId);
      if (!parsed || parsed.kind !== 'Repository') return null;
      const repo = ctx.store.allRepos().find((r) => r.id === parsed.id);
      if (!repo) return null;
      const title = String(input.title ?? '');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const pull = repo.createPull({ title, body: '', head, base });
      return { pullRequest: pullNodeJson(ctx, repo, pull) };
    },
    mergePullRequest: (args) => {
      const input = (args.input !== undefined && typeof args.input === 'object' ? args.input : args) as Record<string, unknown>;
      const pullRequestId = String(input.pullRequestId ?? '');
      const parsed = parseGqlId(pullRequestId);
      if (!parsed || parsed.kind !== 'PullRequest') return null;
      for (const repo of ctx.store.allRepos()) {
        const pull = repo.pulls.get(parsed.id);
        if (pull) {
          mergePullInternal(repo, pull);
          return { pullRequest: pullNodeJson(ctx, repo, pull) };
        }
      }
      return null;
    },
    addComment: (args) => {
      const input = (args.input !== undefined && typeof args.input === 'object' ? args.input : args) as Record<string, unknown>;
      const subjectId = String(input.subjectId ?? '');
      const parsed = parseGqlId(subjectId);
      if (!parsed || parsed.kind !== 'Issue') return null;
      for (const repo of ctx.store.allRepos()) {
        const issue = repo.issues.get(parsed.id);
        if (issue) {
          const comment = repo.addComment(issue.number, String(input.body ?? ''));
          return { commentEdge: { node: { id: gqlId('IssueComment', comment.id), body: comment.body } } };
        }
      }
      return null;
    },
  };
  const result = resolveSelection(op.selection, {}, env, mutations);
  return { data: result, errors: env.errors };
}

function mergePullInternal(repo: Repository, pull: PullRequest): void {
  const headSha = pull.headSha || repo.heads.get(pull.head);
  const baseSha = pull.baseSha || repo.heads.get(pull.base);
  const mergeSha = makeMergeCommit(repo, pull, headSha ?? '', baseSha ?? '');
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = 1_700_000_100 + pull.number;
  pull.mergeCommitSha = mergeSha;
  if (pull.base && mergeSha) repo.heads.set(pull.base, mergeSha);
}

function makeMergeCommit(repo: Repository, pull: PullRequest, headSha: string, baseSha: string): string {
  const baseTree = baseSha && repo.objects.get(baseSha) ? parseCommit(repo.objects.get(baseSha)!.data).tree : undefined;
  const headTree = headSha && repo.objects.get(headSha) ? parseCommit(repo.objects.get(headSha)!.data).tree : undefined;
  const treeOid = headTree ?? baseTree ?? repo.putObject('tree', buildTree([]));
  const parents = baseSha ? [baseSha] : [];
  const commit = buildCommit({
    tree: treeOid,
    parents,
    message: `Merge pull request #${pull.number} ${pull.title}\n`,
    author: 'Forge Bot <forge@example.invalid>',
    committer: 'Forge Bot <forge@example.invalid>',
    timestamp: 1_700_000_100 + pull.number,
  });
  return repo.putObject('commit', commit);
}

// ---------------------------------------------------------------- MCP

const MCP_TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository in the forge.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, description: { type: 'string' }, private: { type: 'boolean' } },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function toolResult(content: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: content }], structuredContent: undefined, isError: false };
}

function mcpCallTool(ctx: ForgeContext, name: string, args: Record<string, unknown>): { result?: Record<string, unknown>; error?: string } {
  const repo = (args: Record<string, unknown>): Repository | null => {
    const owner = String(args.owner ?? '');
    const name = String(args.repo ?? '');
    return ctx.store.get(owner, name);
  };
  switch (name) {
    case 'create_repo': {
      const name = String(args.name ?? '');
      const description = args.description === undefined ? '' : String(args.description);
      const privateFlag = args.private === true;
      const created = ctx.store.createRepo(ctx.store.viewer, name, { description, privateFlag });
      return { result: toolResult(JSON.stringify({ name: created.name, full_name: `${created.owner}/${created.name}`, private: created.privateFlag })) };
    }
    case 'get_repo': {
      const r = repo(args);
      if (!r) return { error: 'repository not found' };
      return { result: toolResult(JSON.stringify({ name: r.name, full_name: `${r.owner}/${r.name}`, private: r.privateFlag, description: r.description })) };
    }
    case 'create_issue': {
      const r = repo(args);
      if (!r) return { error: 'repository not found' };
      const title = String(args.title ?? '');
      const body = args.body === undefined ? '' : String(args.body);
      const issue = r.createIssue(title, body, []);
      return { result: toolResult(JSON.stringify({ number: issue.number, title: issue.title, state: issue.state })) };
    }
    case 'list_issues': {
      const r = repo(args);
      if (!r) return { error: 'repository not found' };
      const state = args.state === undefined ? undefined : String(args.state);
      let issues = [...r.issues.values()];
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      issues.sort((a, b) => b.number - a.number);
      return { result: toolResult(JSON.stringify(issues.map((i) => ({ number: i.number, title: i.title, state: i.state })))) };
    }
    case 'create_pull_request': {
      const r = repo(args);
      if (!r) return { error: 'repository not found' };
      const pull = r.createPull({ title: String(args.title ?? ''), body: '', head: String(args.head ?? ''), base: String(args.base ?? '') });
      return { result: toolResult(JSON.stringify({ number: pull.number, state: 'open', head: pull.head, base: pull.base })) };
    }
    case 'merge_pull_request': {
      const r = repo(args);
      if (!r) return { error: 'repository not found' };
      const number = Number(args.pull_number ?? args.number);
      const pull = r.pulls.get(number);
      if (!pull) return { error: 'pull request not found' };
      mergePullInternal(r, pull);
      return { result: toolResult(JSON.stringify({ number: pull.number, merged: true, state: 'closed' })) };
    }
    default:
      return { error: 'unknown tool' };
  }
}

// ---------------------------------------------------------------- REST handlers

interface RestRoute {
  segments: string[];
  query: URLSearchParams;
  method: string;
}

function parseRestPath(path: string): string[] {
  const without = path.replace(/^\/api\/v3\/?/, '');
  if (without === '') return [];
  return without.split('/').map((seg) => {
    try {
      return decodeURIComponent(seg);
    } catch {
      return seg;
    }
  });
}

function handleRest(ctx: ForgeContext, req: IncomingMessage, res: ServerResponse, path: string): void {
  const method = req.method ?? 'GET';
  const query = queryOf(req);
  const segs = parseRestPath(path);

  // GET /api/v3/ and /api/v3
  if (path === '/api/v3' || path === '/api/v3/') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  void (async () => {
    // meta
    if (method === 'GET' && segs.length === 1 && segs[0] === 'meta') {
      sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
      return;
    }
    // GET /api/v3/user
    if (method === 'GET' && segs.length === 1 && segs[0] === 'user') {
      sendJson(res, 200, { login: ctx.store.viewer, id: 1000 });
      return;
    }
    // POST /api/v3/user/repos
    if (method === 'POST' && segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
      const body = await readJsonBody(req, res);
      if (body === null) return;
      const name = String((body as Record<string, unknown>).name ?? '');
      if (name === '') {
        sendError(res, 422, 'name is required');
        return;
      }
      const repo = ctx.store.createRepo(ctx.store.viewer, name, {
        description: (body as Record<string, unknown>).description !== undefined ? String((body as Record<string, unknown>).description) : '',
        privateFlag: (body as Record<string, unknown>).private === true,
      });
      sendJson(res, 201, repoJson(repo));
      return;
    }
    // GET /api/v3/user/repos
    if (method === 'GET' && segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
      const repos = ctx.store.allRepos();
      const perPage = Number(query.get('per_page') ?? '30');
      const page = Number(query.get('page') ?? '1');
      const start = (page - 1) * perPage;
      const slice = repos.slice(start, start + perPage);
      const host = req.headers.host ?? 'entry';
      const origin = `http://${host}`;
      const linkParts: string[] = [];
      if (page > 1) linkParts.push(`<${origin}/api/v3/user/repos?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
      if (start + perPage < repos.length) linkParts.push(`<${origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`);
      const headers: Record<string, string> = {};
      if (linkParts.length > 0) headers.link = linkParts.join(', ');
      sendJson(res, 200, slice.map(repoJson), headers);
      return;
    }
    // /repos/{owner}/{repo}...
    if (segs.length >= 2 && segs[0] === 'repos') {
      const owner = segs[1];
      const repoName = segs[2];
      const repo = ctx.store.get(owner, repoName);
      const sub = segs.slice(3);

      if (sub.length === 0) {
        if (method === 'GET') {
          if (!repo) {
            sendError(res, 404, 'Not Found');
            return;
          }
          sendJson(res, 200, repoJson(repo));
          return;
        }
        if (method === 'PATCH') {
          if (!repo) {
            sendError(res, 404, 'Not Found');
            return;
          }
          const body = await readJsonBody(req, res);
          if (body === null) return;
          const desc = (body as Record<string, unknown>).description;
          if (desc !== undefined) repo.description = String(desc);
          sendJson(res, 200, repoJson(repo));
          return;
        }
        if (method === 'DELETE') {
          if (!repo) {
            sendError(res, 404, 'Not Found');
            return;
          }
          ctx.store.deleteRepo(owner, repoName);
          res.writeHead(204, { 'x-github-request-id': requestId() });
          res.end();
          return;
        }
      }

      // contents
      if (sub[0] === 'contents' && sub.length >= 2) {
        const filePath = sub.slice(1).join('/');
        if (method === 'PUT') {
          if (!repo) {
            sendError(res, 404, 'Not Found');
            return;
          }
          const body = await readJsonBody(req, res);
          if (body === null) return;
          const record = body as Record<string, unknown>;
          const content = String(record.content ?? '');
          const message = String(record.message ?? '');
          const branch = record.branch === undefined ? undefined : String(record.branch);
          const sha = record.sha === undefined ? undefined : String(record.sha);
          const targetBranch = branch ?? repo.defaultBranch;
          const existing = repo.blobAtPath(targetBranch, filePath);
          if (sha !== undefined) {
            if (!existing || existing.oid !== sha) {
              sendError(res, 409, 'the file has changed');
              return;
            }
          }
          const blob = Buffer.from(content, 'base64');
          const { sha: commitSha, blobShas } = repo.commitTree({
            branch: targetBranch,
            message,
            changes: [{ path: filePath, blob }],
          });
          const contentSha = blobShas.get(filePath) ?? hashObject('blob', blob);
          const created = existing === undefined;
          sendJson(res, created ? 201 : 200, {
            content: { sha: contentSha, encoding: 'base64' },
            commit: { sha: commitSha },
          });
          return;
        }
        if (method === 'GET') {
          if (!repo) {
            sendError(res, 404, 'Not Found');
            return;
          }
          const ref = query.get('ref') ?? repo.defaultBranch;
          const found = repo.blobAtPath(ref, filePath);
          if (found) {
            sendJson(res, 200, {
              type: 'file',
              encoding: 'base64',
              content: found.data.toString('base64'),
              sha: found.oid,
              size: found.data.length,
              path: filePath,
              name: filePath.split('/').pop(),
            });
            return;
          }
          const dirEntries = repo.dirEntries(ref, filePath);
          if (dirEntries.length > 0 || dirProbe(repo, ref, filePath)) {
            const entries = dirEntries.map((entry) => ({
              type: entry.mode === '40000' ? 'dir' : 'file',
              name: entry.name,
              path: filePath === '' ? entry.name : `${filePath}/${entry.name}`,
              sha: entry.oid,
              size: entry.mode === '40000' ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
            }));
            sendJson(res, 200, entries);
            return;
          }
          sendError(res, 404, 'Not Found');
          return;
        }
        if (method === 'DELETE') {
          if (!repo) {
            sendError(res, 404, 'Not Found');
            return;
          }
          const body = await readJsonBody(req, res);
          if (body === null) return;
          const message = String((body as Record<string, unknown>).message ?? '');
          const branch = (body as Record<string, unknown>).branch === undefined ? repo.defaultBranch : String((body as Record<string, unknown>).branch);
          const existing = repo.blobAtPath(branch, filePath);
          if (!existing) {
            sendError(res, 404, 'Not Found');
            return;
          }
          const { sha: commitSha } = repo.commitTree({ branch, message, changes: [{ path: filePath }] });
          sendJson(res, 200, { commit: { sha: commitSha } });
          return;
        }
      }

      // labels
      if (sub[0] === 'labels' && sub.length === 1) {
        if (method === 'POST') {
          if (!repo) {
            sendError(res, 404, 'Not Found');
            return;
          }
          const body = await readJsonBody(req, res);
          if (body === null) return;
          const name = String((body as Record<string, unknown>).name ?? '');
          const color = String((body as Record<string, unknown>).color ?? 'ededed');
          const label = repo.addLabel(name, color);
          sendJson(res, 201, labelJson(label));
          return;
        }
      }

      // git/refs and branches
      if (sub[0] === 'git' && sub[1] === 'refs' && sub.length === 2 && method === 'POST') {
        if (!repo) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const body = await readJsonBody(req, res);
        if (body === null) return;
        const ref = String((body as Record<string, unknown>).ref ?? '');
        const sha = String((body as Record<string, unknown>).sha ?? '');
        if (ref.startsWith('refs/heads/')) {
          const branch = ref.slice('refs/heads/'.length);
          repo.heads.set(branch, sha);
          sendJson(res, 201, { ref, object: { sha } });
          return;
        }
        sendError(res, 422, 'invalid ref');
        return;
      }
      if (sub[0] === 'git' && sub[1] === 'refs' && sub.length >= 3 && method === 'GET') {
        // /git/refs/heads/{branch} or /git/refs/{...}
        if (!repo) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const fullRef = `refs/${sub.slice(2).join('/')}`;
        const branch = fullRef.replace(/^refs\/heads\//, '');
        const oid = repo.heads.get(branch);
        if (oid) {
          sendJson(res, 200, { ref: fullRef, object: { sha: oid } });
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }
      if (sub[0] === 'branches' && sub.length === 1 && method === 'GET') {
        if (!repo) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const branches = [...repo.heads.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, oid]) => ({ name, commit: { sha: oid } }));
        sendJson(res, 200, branches);
        return;
      }
      if (sub[0] === 'branches' && sub.length === 2 && method === 'GET') {
        if (!repo) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const oid = repo.heads.get(sub[1]);
        if (!oid) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, { name: sub[1], commit: { sha: oid } });
        return;
      }
      if (sub[0] === 'commits' && sub.length === 1 && method === 'GET') {
        if (!repo) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const sha = query.get('sha') ?? repo.defaultBranch;
        const commits = repo.commitHistory(sha, 100).map((oid) => {
          const commit = repo.objects.get(oid)!;
          const message = parseCommit(commit.data).message;
          return { sha: oid, commit: { message: message.replace(/\n$/, '') } };
        });
        sendJson(res, 200, commits);
        return;
      }
      // issues
      if (sub[0] === 'issues' && sub.length === 1 && method === 'POST') {
        if (!repo) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const body = await readJsonBody(req, res);
        if (body === null) return;
        const record = body as Record<string, unknown>;
        const title = String(record.title ?? '');
        const issueBody = record.body === undefined ? '' : String(record.body);
        const labels = Array.isArray(record.labels) ? record.labels.map((l) => String(l)) : [];
        for (const label of labels) {
          if (!repo.labels.has(label)) {
            sendError(res, 422, 'Validation Failed: the label does not exist');
            return;
          }
        }
        const issue = repo.createIssue(title, issueBody, labels);
        sendJson(res, 201, issueJson(repo, issue));
        return;
      }
      if (sub[0] === 'issues' && sub.length === 1 && method === 'GET') {
        if (!repo) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let issues = [...repo.issues.values()];
        if (state === 'open') issues = issues.filter((i) => i.state === 'open');
        else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
        if (sort === 'created') issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        const perPage = Number(query.get('per_page') ?? '30');
        sendJson(res, 200, issues.slice(0, perPage).map((i) => issueJson(repo, i)));
        return;
      }
      if (sub[0] === 'issues' && sub.length === 2 && method === 'GET') {
        if (!repo) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const number = Number(sub[1]);
        const issue = repo.issues.get(number);
        if (!issue) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const body = issueJsonBody(repo, issue);
        res.writeHead(200, { 'content-type': JSON_TYPE, 'content-length': String(body.length), 'x-github-request-id': requestId() });
        res.end(body);
        return;
      }
      if (sub[0] === 'issues' && sub.length === 2 && method === 'PATCH') {
        if (!repo) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const body = await readJsonBody(req, res);
        if (body === null) return;
        const number = Number(sub[1]);
        const issue = repo.issues.get(number);
        if (!issue) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const state = (body as Record<string, unknown>).state;
        if (state === 'closed' || state === 'open') issue.state = state;
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      if (sub[0] === 'issues' && sub.length === 3 && sub[2] === 'comments' && method === 'POST') {
        if (!repo) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const body = await readJsonBody(req, res);
        if (body === null) return;
        const number = Number(sub[1]);
        if (!repo.issues.has(number)) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const comment = repo.addComment(number, String((body as Record<string, unknown>).body ?? ''));
        sendJson(res, 201, commentJson(comment));
        return;
      }
      if (sub[0] === 'issues' && sub.length === 3 && sub[2] === 'comments' && method === 'GET') {
        if (!repo) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const number = Number(sub[1]);
        sendJson(res, 200, repo.commentsFor(number).map(commentJson));
        return;
      }
      // pulls
      if (sub[0] === 'pulls' && sub.length === 1 && method === 'POST') {
        if (!repo) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const body = await readJsonBody(req, res);
        if (body === null) return;
        const record = body as Record<string, unknown>;
        const head = String(record.head ?? '');
        const base = String(record.base ?? '');
        if (!repo.heads.has(head) || !repo.heads.has(base)) {
          sendError(res, 422, 'Validation Failed: head or base branch does not exist');
          return;
        }
        const pull = repo.createPull({
          title: String(record.title ?? ''),
          body: record.body === undefined ? '' : String(record.body),
          head,
          base,
          headSha: repo.heads.get(head) ?? '',
          baseSha: repo.heads.get(base) ?? '',
        });
        sendJson(res, 201, pullJson(repo, pull));
        return;
      }
      if (sub[0] === 'pulls' && sub.length === 1 && method === 'GET') {
        if (!repo) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        pulls.sort((a, b) => b.number - a.number);
        if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
        const perPage = Number(query.get('per_page') ?? '30');
        sendJson(res, 200, pulls.slice(0, perPage).map((p) => pullJson(repo, p)));
        return;
      }
      if (sub[0] === 'pulls' && sub.length === 2 && method === 'GET') {
        if (!repo) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const pull = repo.pulls.get(Number(sub[1]));
        if (!pull) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, pullJson(repo, pull));
        return;
      }
      if (sub[0] === 'pulls' && sub.length === 3 && sub[2] === 'files' && method === 'GET') {
        if (!repo) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const pull = repo.pulls.get(Number(sub[1]));
        if (!pull) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const files = pullFiles(repo, pull).map((filename) => {
          const status = fileStatus(repo, pull, filename);
          return { filename, status, additions: 1, deletions: 0, changes: 1 };
        });
        sendJson(res, 200, files);
        return;
      }
      if (sub[0] === 'pulls' && sub.length === 3 && sub[2] === 'merge' && method === 'PUT') {
        if (!repo) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const pull = repo.pulls.get(Number(sub[1]));
        if (!pull) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const conflicted = isConflicted(repo, pull);
        if (conflicted) {
          sendError(res, 405, 'Merge conflict');
          return;
        }
        const body = await readJsonBody(req, res);
        if (body === null) return;
        const headSha = pull.headSha || repo.heads.get(pull.head) || '';
        const baseSha = pull.baseSha || repo.heads.get(pull.base) || '';
        const mergeSha = makeMergeCommit(repo, pull, headSha, baseSha);
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = 1_700_000_100 + pull.number;
        pull.mergeCommitSha = mergeSha;
        if (pull.base && mergeSha) repo.heads.set(pull.base, mergeSha);
        sendJson(res, 200, { sha: mergeSha, merged: true, message: `Pull request successfully merged and closed` });
        return;
      }
    }

    sendError(res, 404, 'Not Found');
  })().catch(() => {
    sendError(res, 500, 'internal error');
  });
}

function dirProbe(repo: Repository, ref: string, path: string): boolean {
  const prefix = path === '' ? '' : `${path}/`;
  for (const entry of collectAllPaths(repo, repo.heads.get(ref) ?? ref).keys()) {
    if (entry.startsWith(prefix)) return true;
  }
  return false;
}

function fileStatus(repo: Repository, pull: PullRequest, filename: string): string {
  const baseTip = pull.baseSha || repo.heads.get(pull.base) || '';
  const baseTree = collectAllPaths(repo, baseTip);
  const headTree = collectAllPaths(repo, pull.headSha || repo.heads.get(pull.head) || '');
  const baseOid = baseTree.get(filename);
  const headOid = headTree.get(filename);
  if (baseOid === undefined) return 'added';
  if (headOid === undefined) return 'removed';
  return 'modified';
}

function isConflicted(repo: Repository, pull: PullRequest): boolean {
  const currentBaseTip = repo.heads.get(pull.base) ?? pull.baseSha ?? '';
  const headTip = pull.headSha || repo.heads.get(pull.head) || '';
  if (!currentBaseTip || !headTip) return false;
  const mergeBaseTree = collectAllPaths(repo, pull.baseSha || currentBaseTip);
  const oursTree = collectAllPaths(repo, currentBaseTip);
  const theirsTree = collectAllPaths(repo, headTip);
  const paths = new Set<string>([...mergeBaseTree.keys(), ...oursTree.keys(), ...theirsTree.keys()]);
  for (const path of paths) {
    const b = mergeBaseTree.get(path);
    const o = oursTree.get(path);
    const t = theirsTree.get(path);
    if (o === t) continue;
    if (t === b) continue;
    if (o === b) continue;
    return true;
  }
  return false;
}

async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req);
  if (raw.length === 0) {
    sendError(res, 400, 'request body is required');
    return null;
  }
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendError(res, 400, 'request body must be a JSON object');
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    sendError(res, 400, 'Problems parsing JSON');
    return null;
  }
}

// ---------------------------------------------------------------- git smart HTTP

function handleGit(ctx: ForgeContext, req: IncomingMessage, res: ServerResponse, path: string, owner: string, repoName: string): void {
  const repo = ctx.store.get(owner, repoName);
  const method = req.method ?? 'GET';
  const isInfoRefs = path.endsWith('/info/refs');
  const suffix = isInfoRefs ? 'info/refs' : path.split('/').pop() ?? '';
  const service = isInfoRefs
    ? ((queryOf(req).get('service') ?? '') as string)
    : suffix === 'git-upload-pack'
      ? 'git-upload-pack'
      : suffix === 'git-receive-pack'
        ? 'git-receive-pack'
        : '';

  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendError(res, 404, 'Not Found');
    return;
  }

  if (isInfoRefs) {
    if (method !== 'GET') {
      sendError(res, 405, 'method not allowed');
      return;
    }
    if (!repo) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const query = queryOf(req);
    if (query.get('service') !== service) {
      sendError(res, 400, 'bad service');
      return;
    }
    if (service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2')) {
      const body = buildV2Advertisement();
      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-advertisement',
        'content-length': String(body.length),
      });
      res.end(body);
      return;
    }
    let body: Buffer;
    if (service === 'git-upload-pack') {
      body = Buffer.concat([pktLine('# service=git-upload-pack\n'), pktFlush(), buildV0Advertisement(repo, 'git-upload-pack')]);
      res.writeHead(200, {
        'content-type': 'application/x-git-upload-pack-advertisement',
        'content-length': String(body.length),
      });
    } else {
      body = Buffer.concat([pktLine('# service=git-receive-pack\n'), pktFlush(), buildV0Advertisement(repo, 'git-receive-pack')]);
      res.writeHead(200, {
        'content-type': 'application/x-git-receive-pack-advertisement',
        'content-length': String(body.length),
      });
    }
    res.end(body);
    return;
  }

  // POST service endpoint
  if (method !== 'POST') {
    sendError(res, 405, 'method not allowed');
    return;
  }
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }

  void (async () => {
    const body = await readBody(req);
    const { tokens, rest } = tokenize(body);
    if (service === 'git-upload-pack') {
      const v2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      if (v2) {
        // find the command=ls-refs or command=fetch
        let command = '';
        for (const t of tokens) {
          if (t.kind !== 'data') continue;
          const line = t.payload.toString('utf8').replace(/\n$/, '');
          if (line.startsWith('command=')) command = line.slice('command='.length);
        }
        if (command === 'ls-refs') {
          const args = { prefixes: [] as string[], peel: false, symrefs: false, unborn: false };
          for (const t of tokens) {
            if (t.kind !== 'data') continue;
            const line = t.payload.toString('utf8').replace(/\n$/, '');
            if (line === 'peel') args.peel = true;
            else if (line === 'symrefs') args.symrefs = true;
            else if (line === 'unborn') args.unborn = true;
            else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
          }
          const out = buildLsRefs(repo, args);
          res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': String(out.length) });
          res.end(out);
          return;
        }
        if (command === 'fetch') {
          const req2 = parseFetchArgs(tokens);
          const key = fetchCacheKey(repo, 'v2', req2);
          let out = fetchCache.get(key);
          if (out === undefined) {
            out = buildFetchV2(repo, req2);
            if (fetchCache.size > FETCH_CACHE_MAX) fetchCache.clear();
            fetchCache.set(key, out);
          }
          res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': String(out.length) });
          res.end(out);
          return;
        }
        sendError(res, 400, 'unknown command');
        return;
      }
      // v0 fetch
      const req2 = parseFetchArgs(tokens);
      const key = fetchCacheKey(repo, 'v0', req2);
      let out = fetchCache.get(key);
      if (out === undefined) {
        out = buildFetchV0(repo, req2);
        if (fetchCache.size > FETCH_CACHE_MAX) fetchCache.clear();
        fetchCache.set(key, out);
      }
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': String(out.length) });
      res.end(out);
      return;
    }
    // receive-pack
    const { commands, capabilities } = parsePushCommands(tokens, rest);
    const report = applyPush(repo, commands, rest.length > 0 ? rest : null);
    const sideband = capabilities.includes('side-band-64k');
    const out = buildPushReport(report, sideband);
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': String(out.length) });
    res.end(out);
  })().catch(() => {
    sendError(res, 500, 'internal error');
  });
}

function restLen(body: Buffer, tokens: { kind: string; payload: Buffer }[]): number {
  // The pack starts after the first flush; tokenize already captured it, so recompute.
  const { rest } = tokenize(body);
  return rest.length;
}

// ---------------------------------------------------------------- GraphQL HTTP

function handleGraphql(ctx: ForgeContext, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'POST') {
    sendError(res, 405, 'method not allowed');
    return;
  }
  void (async () => {
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendError(res, 400, 'Problems parsing JSON');
      return;
    }
    // Batched: array of operation documents
    if (Array.isArray(parsed)) {
      const results = parsed.map((entry) => runGraphqlDocument(ctx, entry as Record<string, unknown>));
      sendJson(res, 200, results);
      return;
    }
    const result = runGraphqlDocument(ctx, parsed as Record<string, unknown>);
    sendJson(res, 200, result);
  })().catch(() => {
    sendError(res, 500, 'internal error');
  });
}

function runGraphqlDocument(ctx: ForgeContext, entry: Record<string, unknown>): { data: unknown; errors?: unknown[] } {
  const query = String(entry.query ?? '');
  const variables = (entry.variables !== undefined && entry.variables !== null && typeof entry.variables === 'object' ? entry.variables : {}) as Record<string, unknown>;
  try {
    const parser = new GqlParser(query);
    const ops = parser.parse();
    if (ops.length === 0) {
      return { data: null, errors: [{ message: 'no operation' }] };
    }
    const op = ops[0];
    if (op.type === 'mutation') {
      const result = runMutation(ctx, op, variables);
      return result.errors.length > 0 ? { data: result.data, errors: result.errors } : { data: result.data };
    }
    const result = resolveDocument(op, ctx, variables);
    return result.errors.length > 0 ? { data: result.data, errors: result.errors } : { data: result.data };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

// ---------------------------------------------------------------- MCP HTTP

function handleMcp(ctx: ForgeContext, req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'POST') {
    sendError(res, 405, 'method not allowed');
    return;
  }
  void (async () => {
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    const record = body as Record<string, unknown>;
    const id = record.id === undefined ? null : (record.id as string | number | null);
    const method = String(record.method ?? '');
    const params = (record.params !== undefined && record.params !== null && typeof record.params === 'object' ? record.params : {}) as Record<string, unknown>;

    if (method === 'server/discover') {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          resultType: 'discover',
          supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
          capabilities: { tools: {} },
          serverInfo: { name: 'github-forge', version: '1.0.0' },
        },
      });
      return;
    }
    if (method === 'initialize') {
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: String((params as Record<string, unknown>).protocolVersion ?? '2026-07-28'),
          capabilities: { tools: {} },
          serverInfo: { name: 'github-forge', version: '1.0.0' },
        },
      });
      return;
    }
    if (method === 'notifications/initialized') {
      sendJson(res, 200, { jsonrpc: '2.0', id: null, result: {} });
      return;
    }
    if (method === 'tools/list') {
      sendJson(res, 200, { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
      return;
    }
    if (method === 'tools/call') {
      const name = String(params.name ?? '');
      const args = (params.arguments !== undefined && params.arguments !== null && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      const known = MCP_TOOLS.some((t) => t.name === name);
      if (!known) {
        sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } });
        return;
      }
      const tool = MCP_TOOLS.find((t) => t.name === name)!;
      const required = tool.inputSchema.required as string[];
      const missing = required.filter((r) => !(r in args));
      if (missing.length > 0) {
        sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32602, message: `Missing required arguments: ${missing.join(', ')}` } });
        return;
      }
      const outcome = mcpCallTool(ctx, name, args);
      if (outcome.error !== undefined) {
        sendJson(res, 200, { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: outcome.error }], isError: true } });
        return;
      }
      sendJson(res, 200, { jsonrpc: '2.0', id, result: outcome.result });
      return;
    }
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  })().catch(() => {
    sendError(res, 500, 'internal error');
  });
}

// ---------------------------------------------------------------- createApp

export function createApp(): Server {
  const ctx: ForgeContext = {
    token: process.env.MAKEFUN_SHOP_TOKEN ?? '',
    store: new Store(process.env.MAKEFUN_SHOP_TOKEN === undefined ? 'adaiversen' : 'adaiversen'),
  };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // git smart HTTP: /{owner}/{repo}.git/...
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
    if (gitMatch) {
      const owner = decodeURIComponent(gitMatch[1]);
      const repoName = decodeURIComponent(gitMatch[2]);
      // Auth is required for git too (the suite presents it), but the rules only gate the API.
      handleGit(ctx, req, res, path, owner, repoName);
      return;
    }

    if (path.startsWith('/api/v3')) {
      const token = authToken(req);
      if (token !== ctx.token || token === null) {
        sendError(res, 401, 'Requires authentication');
        return;
      }
      handleRest(ctx, req, res, path);
      return;
    }

    if (path === '/api/graphql') {
      const token = authToken(req);
      if (token !== ctx.token || token === null) {
        sendError(res, 401, 'Requires authentication');
        return;
      }
      handleGraphql(ctx, req, res);
      return;
    }

    if (path === '/mcp') {
      const token = authToken(req);
      if (token !== ctx.token || token === null) {
        sendError(res, 401, 'Unauthorized');
        return;
      }
      handleMcp(ctx, req, res);
      return;
    }

    sendError(res, 404, 'Not Found');
  });
}
