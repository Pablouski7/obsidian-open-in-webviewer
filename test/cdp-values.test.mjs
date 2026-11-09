import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startHarness} from './browser-harness.mjs';

test('CDP values preserve -0, NaN, infinities and BigInt instead of silently returning undefined',async()=>{
 const h=await startHarness();
 try{
  assert(Object.is(await h.evaluate('-0'),-0));
  assert(Number.isNaN(await h.evaluate('NaN')));
  assert.equal(await h.evaluate('Infinity'),Infinity);
  assert.equal(await h.evaluate('-Infinity'),-Infinity);
  assert.equal(await h.evaluate('42n'),42n);
 }finally{await h.stop()}
});
