import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextCache, RemoteHost, type FactTransport } from '../src/remote-host.ts';
import { DirectoryCache, DirectoryChanged } from '../src/directory-cache.ts';
import type { ContextReply, Fact, Snapshot } from '../src/facts.ts';

const context = (): Snapshot => ({ prompt:1, pathsIncluded:false, key:'context', catalogKey:'catalog', home:'/fixture', discoveryKey:'discovery', catalog:{ cwd:'/fixture', commands:['cd','cat'], paths:[], history:['cd folder'] } });

test('wire context reuses catalogs and matching indexes across path updates', async () => {
  const initial = context(), replies: ContextReply[] = [initial, { ...initial, catalog:undefined }, { ...initial, catalogKey:'changed', catalog:{ ...initial.catalog, paths:['new-file'] } }];
  const transport: FactTransport = async <T>() => structuredClone(replies.shift()) as T;
  const cache = new ContextCache(), signal = AbortSignal.timeout(4000);
  const first = await cache.get(transport,signal), second = await cache.get(transport,signal);
  assert.equal(first.catalog,second.catalog);
  const third = await cache.get(transport,signal);
  assert.notEqual(third.catalogKey,first.catalogKey);
  assert.equal(third.key,first.key,'Filesystem changes must not invalidate an ongoing repair');
  assert.equal(third.catalog.commands,first.catalog.commands,'Keep matching indexes across path updates');
});

test('pushed lightweight context avoids foreground refresh and catalog deltas retain unchanged fields', async () => {
  const initial = context(), cache = new ContextCache(), signal = AbortSignal.timeout(4000);
  const first = cache.accept(initial)!;
  let requests = 0;
  const transport: FactTransport = async <T>() => { requests++; return { ...initial, prompt:2 } as T; };
  assert.equal(await cache.get(transport,signal,false,1),first);
  assert.equal(requests,0);
  const changed: ContextReply = { ...initial, catalog:undefined, base:initial.catalogKey, catalogKey:'delta', patch:{ history:['cd folder','cd another'] } };
  const updated = cache.accept(changed)!;
  assert.equal(updated.catalog.commands,first.catalog.commands);
  assert.deepEqual(updated.catalog.history,['cd folder','cd another']);
  assert.equal(new ContextCache().accept(changed),undefined,'Deltas without a base require a full refresh');
  cache.accept({ ...initial, pathsIncluded:true, catalogKey:'full' });
  assert.ok(cache.accept({ ...changed, base:'delta', catalogKey:'later', patch:{ history:['cd final'] } }));
  await cache.get(transport,signal,false,2);
  assert.equal(requests,1,'A changed prompt requires a foreground freshness check');
});

test('remote host batches duplicate syntax checks but rechecks live paths for each repair', async () => {
  const requests: Fact[][] = [], syntax = new Map<string,boolean>();
  const transport: FactTransport = async <T>(body:unknown) => {
    const operations=(body as {operations:Fact[]}).operations; requests.push(operations);
    return operations.map(operation => operation.kind==='syntax' ? true : {file:true,directory:false,executable:false}) as T;
  };
  const first = new RemoteHost(transport,context(),AbortSignal.timeout(4000),syntax);
  await Promise.all([first.syntax('ls -l'),first.syntax('ls -L'),first.syntax('ls -l')]);
  assert.equal(requests.length,1); assert.equal(requests[0].length,2);
  await first.stat('/fixture/notes.txt');
  const second = new RemoteHost(transport,context(),AbortSignal.timeout(4000),syntax);
  await second.syntax('ls -l'); assert.equal(requests.length,2,'Immutable syntax survives the next repair');
  await second.stat('/fixture/notes.txt'); assert.equal(requests.length,3,'Live paths are checked again');
});

test('cached browser directories require version verification even for speculative missing paths', async () => {
  const directories = new DirectoryCache();
  directories.remember('/fixture',{version:'before',complete:true,entries:[{name:'folder',directory:true,symlink:false}]});
  const requests: Fact[][] = [];
  const transport: FactTransport = async <T>(body:unknown) => {
    requests.push((body as {operations:Fact[]}).operations);
    return [{version:'after',complete:true,entries:[{name:'folder',directory:true,symlink:false},{name:'new',directory:true,symlink:false}]}] as T;
  };
  const host = new RemoteHost(transport,context(),AbortSignal.timeout(4000),undefined,directories);
  assert.equal(await host.stat('/fixture/new/target'),undefined);
  assert.equal(requests.length,0);
  await assert.rejects(host.verify(),DirectoryChanged);
  assert.deepEqual(requests,[[{kind:'directory',path:'/fixture',version:'before'}]]);
  assert.equal(directories.get('/fixture')?.version,'after');
});

test('cancelled remote repairs never start a fact request', async () => {
  let requests = 0;
  const transport: FactTransport = async <T>() => { requests++; return [] as T; };
  const host = new RemoteHost(transport,context(),AbortSignal.abort());
  await assert.rejects(host.syntax('echo ignored'),{name:'AbortError'});
  assert.equal(requests,0);
});
