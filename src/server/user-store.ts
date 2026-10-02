/**
 * The UserStore Durable Object: one per user (named by user ID), holding
 * that user's synced data in its own SQLite database. The Worker talks to
 * it with fetch():
 *
 *   POST /sync     {since, push} → {rows, cursor, more}
 *   GET  /export   everything stored
 *   POST /delete   erase it all
 */
import {SyncError} from './schema.ts';
import {UserData, type Storage} from './user-data.ts';

interface State {
  storage: Storage & {deleteAll(): Promise<void>};
}

export class UserStore {
  private readonly state: State;
  private data?: UserData;

  constructor(state: State) {
    this.state = state;
  }

  private get userData() {
    return (this.data ??= new UserData(this.state.storage));
  }

  async fetch(request: Request): Promise<Response> {
    const {pathname} = new URL(request.url);
    try {
      if (pathname === '/sync' && request.method === 'POST') {
        const body = await request.json().catch(() => {
          throw new SyncError('not JSON');
        });
        return Response.json(this.userData.sync(body));
      }
      if (pathname === '/export' && request.method === 'GET') {
        return Response.json(this.userData.export());
      }
      if (pathname === '/delete' && request.method === 'POST') {
        await this.state.storage.deleteAll();
        this.data = undefined;
        return Response.json({ok: true});
      }
      return Response.json({error: 'not found'}, {status: 404});
    } catch (e) {
      if (e instanceof SyncError) {
        return Response.json({error: e.message}, {status: e.status});
      }
      throw e;
    }
  }
}
