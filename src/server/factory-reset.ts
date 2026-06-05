import { rmSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { HypercoreStore } from '../store/hypercore.js';
import type { RelayQueryEngine } from '../relay/query.js';
import type { ReplicationManager } from '../replication/index.js';
import type { PhraseVaultClient } from '../pv/client.js';
import { clearAllStagedImports, listStagedImports } from '../import/staging.js';

export const FACTORY_RESET_PHRASE = 'DELETE ALL MEDIA DATA';

export interface FactoryResetBody {
  confirmation_phrase: string;
  acknowledge_irreversible: boolean;
  acknowledge_remove_all_members: boolean;
  acknowledge_remove_pvfs_inventory: boolean;
}

export function validateFactoryResetBody(body: FactoryResetBody | undefined): string | null {
  if (!body) return 'request body required';
  if (body.confirmation_phrase !== FACTORY_RESET_PHRASE) {
    return `confirmation_phrase must be exactly: ${FACTORY_RESET_PHRASE}`;
  }
  if (!body.acknowledge_irreversible) return 'acknowledge_irreversible must be true';
  if (!body.acknowledge_remove_all_members) return 'acknowledge_remove_all_members must be true';
  if (!body.acknowledge_remove_pvfs_inventory) return 'acknowledge_remove_pvfs_inventory must be true';
  return null;
}

export interface FactoryResetPreview {
  warning: string;
  confirmation_phrase_required: string;
  hypercore_nodes: number;
  member_accounts: number;
  invites_pending: number;
  staged_import_batches: number;
  followed_feeds: number;
  libraries_defined: number;
  actions: string[];
}

export interface UserRecord {
  pubKey: string;
  role: 'owner' | 'member';
}

export function buildFactoryResetPreview(opts: {
  engineSize: number;
  users: UserRecord[];
  inviteCount: number;
  stagedCount: number;
  followedCount: number;
  libraryCount: number;
}): FactoryResetPreview {
  const members = opts.users.filter(u => u.role === 'member').length;
  return {
    warning:
      'This permanently deletes the shared media catalog, all member accounts, invites, staged imports, '
      + 'followed feeds, and PhraseVault file registrations on this server. The owner account remains '
      + 'but loses catalog data and per-user settings. This cannot be undone. '
      + 'It does NOT delete media files from disk or NAS (file:// library paths are untouched); '
      + 'only metadata and any blobs in PhraseVault\'s PVFS store are cleared.',
    confirmation_phrase_required: FACTORY_RESET_PHRASE,
    hypercore_nodes: opts.engineSize,
    member_accounts: members,
    invites_pending: opts.inviteCount,
    staged_import_batches: opts.stagedCount,
    followed_feeds: opts.followedCount,
    libraries_defined: opts.libraryCount,
    actions: [
      'Clear Hypercore catalog feed and search index',
      'Remove all member users and invites',
      'Clear staged import batches and followed remote feeds',
      'Reset per-user settings (including owner TMDB/sections)',
      'Clear library definitions',
      'Factory-reset PhraseVault forest DB and PVFS store (not file:// media on disk)',
      'Invalidate all login sessions',
    ],
  };
}

export interface CatalogHandles {
  ownStore: HypercoreStore;
  engine: RelayQueryEngine;
  replication: ReplicationManager;
}

export async function reinitializeCatalog(
  dataDir: string,
  pubKeyHex: string,
  prev: CatalogHandles,
): Promise<CatalogHandles> {
  const feedsDir = path.join(dataDir, 'feeds');
  const ownFeedPath = path.join(feedsDir, pubKeyHex);

  // Close replication first (it closes all managed feeds, including ownStore).
  await prev.replication.close();

  if (existsSync(ownFeedPath)) {
    try {
      rmSync(ownFeedPath, { recursive: true, force: true });
    } catch (err) {
      throw new Error(
        `Could not remove catalog feed at ${ownFeedPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const { HypercoreStore } = await import('../store/hypercore.js');
  const { ReplicationManager } = await import('../replication/index.js');
  const { RelayQueryEngine } = await import('../relay/query.js');

  const replication = new ReplicationManager(feedsDir);
  const ownStore = new HypercoreStore(feedsDir, pubKeyHex);
  await ownStore.open();
  await replication.shareOwnFeed(ownStore);

  const engine = new RelayQueryEngine();
  engine.addFeed(pubKeyHex, ownStore);
  ownStore._core.on('append', () => { engine.refresh().catch(console.error); });
  await engine.refresh();

  return { ownStore, engine, replication };
}

export async function executeServerFactoryReset(opts: {
  dataDir: string;
  pubKeyHex: string;
  catalog: CatalogHandles;
  pv: PhraseVaultClient;
  body: FactoryResetBody;
  getUsers: () => UserRecord[];
  setUsers: (users: UserRecord[]) => void;
  getOwnerPubKey: () => string | null;
  clearInvites: () => number;
  clearFollowed: () => Promise<number>;
  clearServerSettings: (ownerPubKey: string) => void;
  clearSessions: () => void;
}): Promise<{ ok: true; catalog: CatalogHandles; summary: Record<string, unknown> }> {
  const err = validateFactoryResetBody(opts.body);
  if (err) throw new Error(err);

  const ownerPub = opts.getOwnerPubKey();
  if (!ownerPub) throw new Error('no owner configured');

  // PhraseVault first — if this fails, MediaForest catalog is left untouched.
  let pvSummary: unknown = null;
  if (opts.body.acknowledge_remove_pvfs_inventory) {
    try {
      pvSummary = await opts.pv.factoryReset({
        confirmation_phrase: opts.body.confirmation_phrase,
        acknowledge_irreversible: opts.body.acknowledge_irreversible,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `PhraseVault factory reset failed (${detail}). `
        + 'Ensure PhraseVault is running the latest image with POST /admin/factory-reset.',
      );
    }
  }

  const stagedRemoved = clearAllStagedImports(opts.dataDir);
  const followedBefore = await opts.clearFollowed();

  const usersBefore = opts.getUsers();
  const membersRemoved = usersBefore.filter(u => u.role === 'member').length;
  opts.setUsers(usersBefore.filter(u => u.role === 'owner'));
  opts.clearInvites();
  opts.clearServerSettings(ownerPub);
  opts.clearSessions();

  const newCatalog = await reinitializeCatalog(opts.dataDir, opts.pubKeyHex, opts.catalog);

  return {
    ok: true,
    catalog: newCatalog,
    summary: {
      hypercore_reinitialized: true,
      members_removed: membersRemoved,
      staged_batches_removed: stagedRemoved,
      followed_feeds_cleared: followedBefore,
      phrasevault: pvSummary,
      catalog_feed_key: newCatalog.ownStore.feedKey.toString('hex'),
    },
  };
}

export function countStaged(dataDir: string): number {
  return listStagedImports(dataDir).length;
}