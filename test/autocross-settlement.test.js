(function(){
 var X=AX.autocross,id='0x'+'ab'.repeat(32),response={status:true,response:[{coinid:id,spent:false,created:'100'}]};
 T.ok('cross stays held before depth three',!X.confirmedOutput(response,id,102));
 T.ok('exact live output confirms at depth three',X.confirmedOutput(response,id,103));
 T.ok('unrelated output cannot release cross',!X.confirmedOutput(response,'0x'+'cd'.repeat(32),103));
 T.ok('pending lookup cannot release cross',!X.confirmedOutput({status:true,pending:true,response:response.response},id,103));
 var record={phase:'posting',outs:[]},writes=0,ctx={mds:{sql:function(q,cb){cb({status:true,rows:[{V:JSON.stringify(record)}]});},kvSet:function(k,v,cb){writes++;record=JSON.parse(v);cb(null);}},svc:{block:103,fillMeta:null,cmd:function(q,cb){cb(response);}}};
 var settled;X.previousSettled(ctx,function(ok){settled=ok;});T.eq('restart with unknown broadcast stays blocked',settled,false);T.eq('unknown outcome is never erased',writes,0);
 record={phase:'submitted',outs:[id]};ctx.svc.block=102;X.previousSettled(ctx,function(ok){settled=ok;});T.eq('posted is not settled',settled,false);
 ctx.svc.block=103;X.previousSettled(ctx,function(ok){settled=ok;});T.eq('verified output releases cross',settled,true);T.eq('release is persisted',record,null);
 var oldLoad=AX.maker.load;AX.maker.load=function(m,cb){cb(null,[{status:'cancelled',coins:[id]}]);};
 ctx.price={fresh:function(){return true;},mid:function(){return 0.0037;}};ctx.mds.kvGet=function(k,d,cb){cb(JSON.stringify({enabled:true,autoCross:true}));};
 X.stillEnabled(ctx,{coins:[id]},function(ok){settled=ok;});T.eq('cancelled backing orders stop queued cross',settled,false);
 ctx.mds.kvGet=function(k,d,cb){cb(JSON.stringify({enabled:false,autoCross:true}));};X.stillEnabled(ctx,{coins:[id]},function(ok){settled=ok;});T.eq('disabled maker stops queued cross',settled,false);AX.maker.load=oldLoad;
})();
(function(){
 var X=AX.autocross,a='0x'+'a1'.repeat(32),b='0x'+'b2'.repeat(32),settled,record,writes;
 function ctxFor(rec,cmd){record=rec;writes=0;return {mds:{sql:function(q,cb){cb({status:true,rows:record===undefined?[]:[{V:JSON.stringify(record)}]});},kvSet:function(k,v,cb){writes++;record=JSON.parse(v);cb(null);}},
   svc:{block:500,fillMeta:{txpowid:'0x'+'cc'.repeat(32)},fillBlock:0,SWEEP_DEADLINE_BLOCKS:6,fillCoins:null,cmd:cmd||function(q,cb){cb({status:true,response:[]});}},log:function(){}};}
 X.previousSettled(ctxFor({phase:'building',own:[a],outs:[]}),function(ok){settled=ok;});
 T.eq('a cross interrupted before posting is released',settled,true);T.eq('and its record is cleared',record,null);
 X.previousSettled(ctxFor({phase:'refused',own:[a],outs:[]}),function(ok){settled=ok;});T.eq('a cross the node refused is released',settled,true);
 X.previousSettled(ctxFor(undefined),function(ok){settled=ok;});T.eq('no record is settled even while a PandaDEX fill runs',settled,true);
 // coin states: checkmempool lookup first, then the plain lookup
 function node(map){return function(q,cb){var id=q.split('coinid:')[1],st=map[id],mem=q.indexOf('checkmempool:true')>=0;
   if(st==='unknown')return cb(null);
   if(st==='unspent'||(st==='mempool'&&!mem))return cb({status:true,response:[{coinid:id,spent:false}]});
   cb({status:true,response:[]});};}
 var got;['unspent','mempool','spent','unknown'].forEach(function(st){var m={};m[a]=st;X.coinState(node(m),a,function(v){got=v;});T.eq('coin state '+st,got,st);});
 T.eq('all unspent is safe and frees coins',X.verdictOf([{coinid:a,state:'unspent'}]).unspent,true);
 T.eq('mempool is not releasable',X.verdictOf([{coinid:a,state:'mempool'},{coinid:b,state:'spent'}]).safe,false);
 T.eq('no answer is not releasable',X.verdictOf([{coinid:a,state:'unknown'}]).safe,false);
 T.eq('spent is releasable',X.verdictOf([{coinid:a,state:'spent'}]).safe,true);
 // release: unspent cross frees only its own transaction's claims
 var freed=null,oldClaims=globalThis.PoolInputClaims;globalThis.PoolInputClaims={release:function(ids,h,cb){freed={ids:ids,h:h};cb(true);}};
 var m={};m[a]='unspent';var c=ctxFor({phase:'submitted',handle:'dexcomp_7',own:[a],ins:[a,b],outs:[],txpowid:'0x'+'dd'.repeat(32)},node(m)),err='x';
 X.release(c,'cross',function(e){err=e;});T.eq('release succeeds',err,null);T.eq('record cleared',record,null);
 T.eq('claims of that handle freed',freed&&freed.h,'dexcomp_7');T.eq('all its inputs passed',freed&&freed.ids.join(','),[a,b,a].join(','));
 m[a]='mempool';c=ctxFor({phase:'submitted',handle:'dexcomp_8',own:[a],ins:[a],outs:[]},node(m));freed=null;
 X.release(c,'cross',function(e){err=e;});T.ok('a pending cross cannot be released',!!err&&record!==null&&freed===null);
 globalThis.PoolInputClaims=oldClaims;
})();
