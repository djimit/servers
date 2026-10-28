const assert = require('node:assert/strict');
const test = require('node:test');
const {createRequire} = require('node:module');
const {gzipSync} = require('node:zlib');
const requireOwner = createRequire(process.cwd() + '/package.json');
const express = requireOwner('express');
const requireExpress = createRequire(requireOwner.resolve('express'));
const version = requireExpress('body-parser/package.json').version.split('.').map(Number);
assert.ok(version[0]===1 && (version[1]>20 || version[1]===20 && version[2]>=9) || version[0]===2 && version[1]>=4);
const qs = requireExpress('qs');
const qsv = requireExpress('qs/package.json').version.split('.').map(Number);
assert.ok(qsv[0]===6 && (qsv[1]>16 || qsv[1]===16 && qsv[2]>=1));
test('ordinary JSON, valid gzip JSON and nested forms retain their parser behavior', async () => {
 const app = express();
 app.use(express.json());app.use(express.urlencoded({extended:true}));
 app.post('/echo',(req,res)=>res.json(req.body));
 const server = await new Promise(resolve => { const active=app.listen(0,'127.0.0.1',()=>resolve(active)); });
 try {
  const url='http://127.0.0.1:'+server.address().port+'/echo';
  const input={name:'ordinary',enabled:true};
  let response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),input);
  response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','content-encoding':'gzip'},body:gzipSync(JSON.stringify(input))});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),input);
  response=await fetch(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:qs.stringify({user:{name:'ordinary'}})});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{user:{name:'ordinary'}});
 } finally { server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); }
});
