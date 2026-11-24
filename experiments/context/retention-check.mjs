/** Offline retention cost/space gate: no provider requests or agent runs. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { LiveTailRetention, MAX_RETAINED_LIVE_TAILS } from '../../extensions/goal-live-retention.ts';

const median = values => values.sort((a,b) => a-b)[Math.floor(values.length / 2)];
const rows = [];
for (const shape of ['text', 'tool-output', 'image']) for (const bytes of [64 * 1024, 1024 * 1024, 4 * 1024 * 1024]) {
 const base = Array.from({length: 64}, (_,i) => {
  const data = 'x'.repeat(bytes / 64);
  return shape === 'text' ? {role:i % 2 ? 'assistant' : 'user',content:data}
   : shape === 'tool-output' ? {role:'toolResult',toolCallId:`call-${i}`,content:[{type:'text',text:data}]}
   : {role:'user',content:[{type:'image',mimeType:'image/png',data}]};
 });
 const retention = new LiveTailRetention();
 const serialize = [], retained = [];
 for (let i=0;i<45;i++) {
  let start=performance.now(); JSON.stringify(base); const plain=performance.now()-start;
  start=performance.now(); const result=retention.apply('fixture',base,{state:'current policy',counters:`snapshot ${i}`}); const elapsed=performance.now()-start;
  assert.ok(result.transientContents.length<=MAX_RETAINED_LIVE_TAILS);
  assert.ok(result.transientContents.reduce((n,text)=>n+Buffer.byteLength(text),0)<=4096+14);
  if(i>=5) {serialize.push(plain);retained.push(elapsed);}
 }
 const baselineMs=median(serialize), retentionMs=median(retained);
 // Existing project's absolute 10ms allowance protects the noise floor.
 assert.ok(retentionMs<=Math.max(baselineMs*1.5,baselineMs+10), `retention CPU regression: ${bytes} bytes, ${retentionMs}ms`);
 rows.push({shape,historyBytes:bytes,serializationMedianMs:+baselineMs.toFixed(3),retentionMedianMs:+retentionMs.toFixed(3)});
}
console.log(JSON.stringify({retention:rows},null,2));
