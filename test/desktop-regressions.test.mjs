import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
import {build} from 'esbuild';
import {startDesktopServer} from '../dist/desktop-server.js';
import {pluginBuildOptions} from '../esbuild.shared.mjs';

test('desktop encoded literal #/? filenames and hidden/symlink defenses',async()=>{
	fs.mkdirSync('.test-runtime',{recursive:true});
 const root=fs.mkdtempSync(path.resolve('.test-runtime/encoded-'));const vault=path.join(root,'vault');fs.mkdirSync(vault);fs.writeFileSync(path.join(vault,'a#b?c.html'),'literal');fs.writeFileSync(path.join(root,'secret.html'),'secret');fs.symlinkSync(path.join(root,'secret.html'),path.join(vault,'escape.html'));fs.mkdirSync(path.join(vault,'.hidden'));fs.writeFileSync(path.join(vault,'.hidden','a.html'),'hidden');fs.symlinkSync(path.join(vault,'.hidden','a.html'),path.join(vault,'alias.html'));
 const server=await startDesktopServer(vault);try {
 const base=`http://127.0.0.1:${server.port}`;
 const r=await fetch(base+'/a%23b%3Fc.html?v=1');assert.equal(r.status,200);assert.equal(await r.text(),'literal');
 for(const p of ['escape.html','alias.html','.hidden/a.html'])assert.equal((await fetch(base+'/'+p)).status,403);
 } finally {server.close();fs.rmSync(root,{recursive:true,force:true});}
});
/** Loads the SHIPPING bundle (dev and minified production options) in a context with no Node globals. */
async function loadBundle(prod,isMobile){
 const result=await build({...pluginBuildOptions({prod}),write:false,logLevel:'silent'});
 const module={exports:{}};const required=[];
 const registered={views:[],extensions:[],commands:[],events:0};
 class Plugin{registerView(type){registered.views.push(type)}registerExtensions(exts,type){registered.extensions.push([exts,type])}registerEvent(){registered.events++}addCommand(c){registered.commands.push(c.id)}}
 // Deliberately no process, Buffer, window, document or require beyond a recording 'obsidian' stub.
 vm.runInNewContext(result.outputFiles[0].text,{module,exports:module.exports,require:name=>{required.push(name);if(name!=='obsidian')throw Error('Eager Node/Electron load: '+name);return {Plugin,FileView:class{},TFile:class{},Notice:class{},WorkspaceLeaf:class{},setIcon(){},Platform:{isMobile}}}});
 const plugin=new module.exports.default();
 plugin.app={workspace:{on(){}},vault:{adapter:{},on(){},offref(){}}};
 return {plugin,required,registered,bundle:result.outputFiles[0].text};
}
for(const prod of [false,true]){
 test(`mobile entry (${prod?'minified production':'development'} bundle) loads with no Node/Electron/process and registers one view id and one html handler`,async()=>{
  const {plugin,required,registered,bundle}=await loadBundle(prod,true);
  await plugin.onload();
  assert(required.length>0&&required.every(name=>name==='obsidian'),'only obsidian is required: '+required);
  assert.deepEqual(registered.views,['open-in-webviewer-mobile']);
  assert.deepEqual(JSON.parse(JSON.stringify(registered.extensions)),[[['html','htm','json'],'open-in-webviewer-mobile']]);
  assert.deepEqual(registered.commands,['open-active-file-in-webviewer']);
  assert.match(bundle,/open-in-webviewer-mobile/,'the bundle contains the mobile view');
  assert.doesNotMatch(bundle,/html-viewer-view/,'no second (upstream) view id and no competing html handler is bundled');
  plugin.serverHandle={port:1234,close(){}};assert.equal(plugin.buildFileUrl({path:'café folder/a#b?c%.html'}),'http://127.0.0.1:1234/caf%C3%A9%20folder/a%23b%3Fc%25.html');
  plugin.onunload();
 });
}
test('desktop path keeps its redirect view and core web viewer behaviour; no mobile view is registered there',async()=>{
 const {plugin,registered}=await loadBundle(true,false);
 await plugin.onload();
 assert.deepEqual(registered.views,['open-in-webviewer-redirect']);
 assert.deepEqual(JSON.parse(JSON.stringify(registered.extensions)),[[['html','htm','json'],'open-in-webviewer-redirect']]);
 assert.deepEqual(registered.commands,['open-active-file-in-webviewer']);
 const calls=[];plugin.serverHandle={port:99,close(){calls.push('close')}};
 await plugin.openInWebViewer({path:'a b/c.html'},{setViewState:async s=>calls.push(s)});
 assert.deepEqual(JSON.parse(JSON.stringify(calls[0])),{type:'webviewer',state:{url:'http://127.0.0.1:99/a%20b/c.html',navigate:true},active:true});
 plugin.onunload();assert.equal(calls.at(-1),'close');
});
test('desktop listen errors reject rather than hang',async()=>{
 const original=http.createServer;const emitter=new EventEmitter();emitter.listen=()=>queueMicrotask(()=>emitter.emit('error',new Error('listen denied')));http.createServer=()=>emitter;
 try { await assert.rejects(Promise.race([startDesktopServer('.'),new Promise((_,reject)=>setTimeout(()=>reject(Error('hung waiting for listen')),500))]),/listen denied/); } finally {http.createServer=original;}
});
