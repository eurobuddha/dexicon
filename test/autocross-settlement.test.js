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
 ctx.price={fresh:function(){return true;}};ctx.mds.kvGet=function(k,d,cb){cb(JSON.stringify({enabled:true,autoCross:true}));};
 X.stillEnabled(ctx,{coins:[id]},function(ok){settled=ok;});T.eq('cancelled backing orders stop queued cross',settled,false);
 ctx.mds.kvGet=function(k,d,cb){cb(JSON.stringify({enabled:false,autoCross:true}));};X.stillEnabled(ctx,{coins:[id]},function(ok){settled=ok;});T.eq('disabled maker stops queued cross',settled,false);AX.maker.load=oldLoad;
})();
