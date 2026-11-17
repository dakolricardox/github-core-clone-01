// git smart-HTTP protocol: pkt-line codec, v0/v2 ref advertisements, v2 ls-refs, v2/v0 fetch
// (with shallow support) and v0 receive-pack. This is erasable TypeScript only.

import { collectReachable, parseCommit, parseTree, peelTag, readPack, writePack, ZERO_OID, type GitObject } from './gitlib.ts';
import type { Repository, Store } from './store.ts';

export const PKT_MAX = 65520;

export function pktLine(data: string | Uint8Array): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  if (payload.length > PKT_MAX - 4) throw new Error('pkt-line payload too long');
  const header = Buffer.allocUnsafe(4);
  header.write((payload.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

interface Token {
  kind: 'data' | 'delim' | 'flush';
  payload: Buffer;
}

/** Tokenize a pkt-line stream. Stops after the first flush; returns leftover bytes (e.g. a pack). */
export function tokenize(buf: Buffer): { tokens: Token[]; rest: Buffer } {
  const tokens: Token[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const header = buf.subarray(off, off + 4).toString('ascii');
    const len = Number.parseInt(header, 16);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    if (len === 0) {
      tokens.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
      return { tokens, rest: buf.subarray(off) };
    }
    if (len === 1) {
      tokens.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 2) {
      off += 4;
      continue;
    }
    if (len < 4 || len > PKT_MAX) break;
    const end = off + len;
    if (end > buf.length) break;
    tokens.push({ kind: 'data', payload: buf.subarray(off + 4, end) });
    off = end;
  }
  return { tokens, rest: buf.subarray(off) };
}

function text(t: Token): string {
  return t.payload.toString('utf8').replace(/\n$/, '');
}

// ---------------------------------------------------------------- advertisement

const UPLOAD_V0_CAPS = 'multi_ack multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-progress include-tag agent=github-forge/1.0 object-format=sha1';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=github-forge/1.0 object-format=sha1';

function sortedHeads(repo: Repository): Array<[string, string]> {
  return [...repo.heads.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
function sortedTags(repo: Repository): Array<[string, string]> {
  return [...repo.tags.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** v0 ref advertisement body (pkt-lines), without the smart preamble. */
export function buildV0Advertisement(repo: Repository, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [];
  const headOid = repo.heads.get(repo.defaultBranch);
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  if (service === 'git-upload-pack') {
    const fullCaps = headOid !== undefined ? `${caps} symref=HEAD:refs/heads/${repo.defaultBranch}` : caps;
    if (headOid !== undefined) {
      parts.push(pktLine(`${headOid} HEAD\0${fullCaps}\n`));
    } else {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${fullCaps}\n`));
    }
  } else {
    const refs = repo.allRefs();
    if (refs.length === 0) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      const first = refs[0];
      parts.push(pktLine(`${first.oid} ${first.name}\0${caps}\n`));
      for (const ref of refs.slice(1)) parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
    }
  }
  if (service === 'git-upload-pack') {
    for (const [branch, oid] of sortedHeads(repo)) {
      parts.push(pktLine(`${oid} refs/heads/${branch}\n`));
    }
    for (const [tag, oid] of sortedTags(repo)) {
      parts.push(pktLine(`${oid} refs/tags/${tag}\n`));
      const peeled = peelTag((x) => repo.objects.get(x), oid);
      if (peeled !== oid) parts.push(pktLine(`${peeled} refs/tags/${tag}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** v2 capability advertisement body (starts with "version 2"). */
export function buildV2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('agent=github-forge/1.0\n'),
    pktLine('object-format=sha1\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('server-option\n'),
    pktFlush(),
  ]);
}

// ---------------------------------------------------------------- ls-refs (v2)

export function buildLsRefs(repo: Repository, args: { prefixes: string[]; peel: boolean; symrefs: boolean; unborn: boolean }): Buffer {
  const parts: Buffer[] = [];
  const matches = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  if (args.prefixes.length === 0) {
    const headOid = repo.heads.get(repo.defaultBranch);
    if (headOid !== undefined) {
      parts.push(pktLine(`${headOid} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    } else if (args.unborn || args.symrefs) {
      parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  }
  for (const [branch, oid] of sortedHeads(repo)) {
    const name = `refs/heads/${branch}`;
    if (!matches(name)) continue;
    parts.push(pktLine(`${oid} ${name}\n`));
  }
  for (const [tag, oid] of sortedTags(repo)) {
    const name = `refs/tags/${tag}`;
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const peeled = peelTag((x) => repo.objects.get(x), oid);
      if (peeled !== oid) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- fetch

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

export function parseFetchArgs(tokens: Token[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [] };
  for (const t of tokens) {
    if (t.kind !== 'data') continue;
    const line = text(t);
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'want') req.wants.push(value);
    else if (key === 'have') req.haves.push(value);
    else if (key === 'shallow') req.shallow.push(value);
    else if (key === 'deepen' && value !== '') req.depth = Number(value);
  }
  return req;
}

interface FetchComputed {
  objects: GitObject[];
  shallowBoundaries: string[];
}

export function computeFetchObjects(repo: Repository, req: FetchRequest): FetchComputed {
  const haveClosure = new Set<string>(collectReachable(req.haves, (oid) => repo.objects.get(oid)));
  for (const have of req.haves) haveClosure.add(have);
  const send = new Map<string, GitObject>();
  const boundaries: string[] = [];

  const addTreeClosure = (treeOid: string): void => {
    if (haveClosure.has(treeOid) || send.has(treeOid)) return;
    const obj = repo.objects.get(treeOid);
    if (!obj) return;
    send.set(treeOid, obj);
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '160000') continue;
        addTreeClosure(entry.oid);
      }
    }
  };

  const addCommitOnly = (commitOid: string): void => {
    if (haveClosure.has(commitOid) || send.has(commitOid)) return;
    const obj = repo.objects.get(commitOid);
    if (!obj) return;
    send.set(commitOid, obj);
    addTreeClosure(parseCommit(obj.data).tree);
  };

  if (req.depth !== undefined && req.depth >= 1) {
    const included = new Set<string>();
    let frontier = [...req.wants];
    for (let level = 0; level < req.depth; level += 1) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (included.has(oid)) continue;
        const commit = repo.objects.get(oid);
        if (!commit || commit.type !== 'commit') continue;
        included.add(oid);
        if (level === req.depth - 1) {
          if (!haveClosure.has(oid)) boundaries.push(oid);
        } else {
          for (const parent of parseCommit(commit.data).parents) next.push(parent);
        }
      }
      frontier = next;
    }
    for (const oid of included) addCommitOnly(oid);
  } else {
    const reachable = collectReachable(req.wants, (oid) => repo.objects.get(oid));
    for (const oid of reachable) {
      if (haveClosure.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj) send.set(oid, obj);
    }
  }

  const order: GitObject[] = [];
  const push = (type: string): void => {
    for (const [oid, obj] of send) if (obj.type === type) order.push(obj);
  };
  push('commit');
  push('tag');
  push('tree');
  push('blob');
  return { objects: order, shallowBoundaries: boundaries };
}

function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const chunk = 65515;
  for (let off = 0; off < pack.length; off += chunk) {
    const slice = pack.subarray(off, off + chunk);
    out.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return out;
}

/** Build a v2 fetch response body. */
export function buildFetchV2(repo: Repository, req: FetchRequest): Buffer {
  const { objects, shallowBoundaries } = computeFetchObjects(repo, req);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  if (shallowBoundaries.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallowBoundaries) parts.push(pktLine(`shallow ${oid}\n`));
    parts.push(pktFlush());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Build a v0 fetch response body (NAK + shallow lines + sideband pack). */
export function buildFetchV0(repo: Repository, req: FetchRequest): Buffer {
  const { objects, shallowBoundaries } = computeFetchObjects(repo, req);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  for (const oid of shallowBoundaries) parts.push(pktLine(`shallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(...sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

interface PushReportRef {
  ref: string;
  ok: boolean;
  reason: string;
}

export interface PushReportResult {
  unpackOk: boolean;
  unpackDetail: string;
  refs: PushReportRef[];
  sideband: boolean;
}

/** Parse the receive-pack command list; returns commands + the leftover pack bytes. */
export function parsePushCommands(tokens: Token[], rest: Buffer): { commands: PushCommand[]; capabilities: string[]; pack: Buffer | null } {
  const commands: PushCommand[] = [];
  const capabilities: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.kind !== 'data') continue;
    let line = t.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    if (nul >= 0 && i === 0) {
      capabilities.push(...line.slice(nul + 1).split(' ').filter(Boolean));
      line = line.slice(0, nul);
    }
    const space = line.indexOf(' ');
    const space2 = line.indexOf(' ', space + 1);
    if (space < 0 || space2 < 0) continue;
    commands.push({ oldOid: line.slice(0, space), newOid: line.slice(space + 1, space2), ref: line.slice(space2 + 1) });
  }
  const pack = rest.length > 0 ? rest : null;
  return { commands, capabilities, pack };
}

/** Apply a receive-pack: unpack objects, fast-forward-check each ref, build the report. */
export function applyPush(repo: Repository, commands: PushCommand[], pack: Buffer | null): PushReportResult {
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack !== null && pack.length > 0) {
    try {
      const result = readPack(pack);
      for (const [oid, obj] of result.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }

  const refs: PushReportRef[] = [];
  for (const command of commands) {
    if (!unpackOk) {
      refs.push({ ref: command.ref, ok: false, reason: unpackDetail });
      continue;
    }
    if (command.ref.startsWith('refs/tags/')) {
      const tag = command.ref.slice('refs/tags/'.length);
      const current = repo.tags.get(tag);
      if (command.newOid === ZERO_OID) {
        if (current !== undefined && current === command.oldOid) {
          repo.tags.delete(tag);
          refs.push({ ref: command.ref, ok: true, reason: '' });
        } else {
          refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        }
      } else if (command.oldOid === ZERO_OID) {
        if (current === undefined) {
          repo.tags.set(tag, command.newOid);
          refs.push({ ref: command.ref, ok: true, reason: '' });
        } else {
          refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        }
      } else {
        // Tags may be moved by force in git; accept any update to an existing tag.
        if (current !== command.oldOid) {
          refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.tags.set(tag, command.newOid);
          refs.push({ ref: command.ref, ok: true, reason: '' });
        }
      }
      continue;
    }
    const current = repo.heads.get(command.ref.replace(/^refs\/heads\//, ''));
    if (command.newOid === ZERO_OID) {
      // delete
      if (current !== undefined && current === command.oldOid) {
        repo.heads.delete(command.ref.replace(/^refs\/heads\//, ''));
        refs.push({ ref: command.ref, ok: true, reason: '' });
      } else {
        refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      }
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // create
      if (current === undefined) {
        if (command.ref.startsWith('refs/heads/')) repo.heads.set(command.ref.slice('refs/heads/'.length), command.newOid);
        refs.push({ ref: command.ref, ok: true, reason: '' });
      } else {
        refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      }
      continue;
    }
    // update
    if (current !== command.oldOid) {
      refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    const isFf = repo.isAncestor(command.oldOid, command.newOid);
    if (!isFf) {
      refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (command.ref.startsWith('refs/heads/')) repo.heads.set(command.ref.slice('refs/heads/'.length), command.newOid);
    refs.push({ ref: command.ref, ok: true, reason: '' });
  }

  return { unpackOk, unpackDetail, refs, sideband: false };
}

/** Build the receive-pack report body (pkt-framed report, sideband when requested). */
export function buildPushReport(report: PushReportResult, sideband: boolean): Buffer {
  const frames: Buffer[] = [];
  frames.push(pktLine(`unpack ${report.unpackDetail}\n`));
  for (const ref of report.refs) {
    frames.push(pktLine(ref.ok ? `ok ${ref.ref}\n` : `ng ${ref.ref} ${ref.reason}\n`));
  }
  frames.push(pktFlush());
  const reportBody = Buffer.concat(frames);
  if (!sideband) return reportBody;
  const band1 = Buffer.concat([Buffer.from([1]), reportBody]);
  return Buffer.concat([pktLine(band1), pktFlush()]);
}
