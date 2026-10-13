import w from './worker.mjs';
const sub = (c)=>c;
const now = Date.now();
const pad=(n)=>String(n).padStart(2,'0');
function panamaParts(ms){const d=new Date(ms-5*3600e3);let h=d.getUTCHours();const ap=h>=12?'PM':'AM';h=h%12||12;return {f:`${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`,h:`${h}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${ap}`};}
function row(minAgo,lat,lon,dep,mag,est,reg){const p=panamaParts(now-minAgo*60000);return {...p,lat,lon,dep,mag,est,reg,link:`https://sismosgeociencias.up.ac.pa/ultimosismo.html?z=9&lt=${lat}&ln=${lon}&p=${dep}km&e=${est}&h=${p.h}&f=${p.f}&m=${mag}&r=${encodeURIComponent('Localizado en '+reg)}%0A`};}
const rows=[row(2,7.55661,-80.45518,5,5.5,'PRELIMINAR','Panamá a 16km al norte de Tonosí'),row(10,7.69064,-81.43221,10,3.8,'PRELIMINAR','Panamá a 35km al noreste de Coiba'),row(35,7.89583,-80.89983,19,2.8,'REVISADO','Panamá a 24km al sur de Santiago'),row(42,7.7373,-80.81522,6,3.6,'PRELIMINAR','Panamá a 43km al sureste de Santiago'),row(48,7.73117,-81.29025,10,4.3,'PRELIMINAR','Panamá a 30km al sur de Soná'),row(3000,9.1,-79.4,12,3.1,'REVISADO','a 33km al oeste de Tonosí')];
// Variante A: tabla HTML con enlaces (&lt= sin escapar)
const htmlA='<html><body><h1>Lista</h1><table>'+rows.map(r=>`<tr><td>${r.est}</td><td>${r.f}</td><td>${r.h}</td><td>${r.lat}</td><td>${r.lon}</td><td>${r.dep}km</td><td>${r.mag}</td><td>Localizado en ${r.reg.replace('ó','&oacute;')}</td><td><a href="${r.link}">Ver</a></td></tr>`).join('')+'</table></body></html>';
// Variante B: solo texto con pipes, sin enlaces, con duplicado y la 2da tabla vertical
const htmlB='<pre>'+rows.map(r=>`${r.est} | ${r.f} | ${r.h}  | ${r.lat} | ${r.lon} | ${r.dep}km | ${r.mag} | Localizado en ${r.reg} | Ver`).join('\n')+'\n'+`${rows[0].est} | ${rows[0].f} | ${rows[0].h}  | ${rows[0].lat} | ${rows[0].lon} | ${rows[0].dep}km | ${rows[0].mag} | Localizado en ${rows[0].reg} | Ver\n</pre><table><tr><td>Estado</td><td>PRELIMINAR</td></tr><tr><td>Fecha</td><td>${rows[0].f}</td></tr></table>`;
// Variante C: enlaces con &amp;
const htmlC='<div>'+rows.map(r=>`<a href="${r.link.replace(/&/g,'&amp;')}">Ver</a>`).join('<br>')+'</div>';
let IGC_HTML=htmlA, pushes=[];
const usgs={features:[{id:'us7000test',properties:{time:now-2*60000-3000,mag:5.3,place:'20 km N of Tonosi, Panama',status:'automatic',url:'https://earthquake.usgs.gov/earthquakes/eventpage/us7000test',tsunami:0,alert:null,felt:12,mmi:5.1,sig:420},geometry:{coordinates:[-80.5,7.6,10]}}]};
const emsc={features:[{id:'x',properties:{unid:'20261011_0000001',time:new Date(now-2*60000-8000).toISOString(),lat:7.58,lon:-80.47,depth:12,mag:5.4,flynn_region:'PANAMA',evtype:'ke'}}]};
const gfTime=(ms)=>new Date(ms).toISOString().slice(0,22);
const GEOF='#EventID|Time|Latitude|Longitude|Depth/km|Author|Catalog|Contributor|ContributorID|MagType|Magnitude|MagAuthor|EventLocationName|EventType\n'+
 'gfz2026abcd|'+gfTime(now-2*60000-5000)+'|7.60|-80.50|10.0|GFZ||GFZ|gfz2026abcd|mb|5.2|GFZ|Panama-Costa Rica border region|earthquake\n'+
 'gfz2026efgh|'+gfTime(now-50*60000)+'|9.05|-79.60|15.0|GFZ||GFZ|gfz2026efgh|ml|3.2|GFZ|Panama|earthquake\n'+
 'gfz2026blast|'+gfTime(now-40*60000)+'|9.00|-79.40|1.0|GFZ||GFZ|gfz2026blast|ml|2.9|GFZ|Panama|explosion\n';
const PTWC='<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Tsunami Threat Message Number 1 - Panama</title><updated>'+new Date(now-3600e3).toISOString()+'</updated><link href="https://www.tsunami.gov/events/PHEB/2026/10/12/x/1/WEPA40/WEPA40.txt"/><summary>Tsunami warning for the coast of Panama</summary></entry><entry><title>Tsunami Information Statement</title><updated>'+new Date(now-7200e3).toISOString()+'</updated><link href="https://www.tsunami.gov/x"/><summary>No tsunami threat exists. Hawaii</summary></entry></feed>';
globalThis.fetch=async(url,init)=>{
  url=String(url);
  if(url.includes('geofon.gfz')&&url.includes('format=text')) return new Response(url.includes('minmagnitude=2&')?GEOF:'',{status:url.includes('minmagnitude=2&')?200:204});
  if(url.includes('tsunami.gov')) return new Response(PTWC,{status:200,headers:{'content-type':'application/atom+xml'}});
  if(url.includes('sismosgeociencias')) return new Response(IGC_HTML,{status:200,headers:{'content-type':'text/html'}});
  if(url.includes('usgs.gov')) return new Response(JSON.stringify(url.includes('minmagnitude=1&')?usgs:{features:[]}),{status:200});
  if(url.includes('seismicportal')) return new Response(JSON.stringify(url.includes('minmag=1.5')?emsc:{features:[]}),{status:200});
  if(init&&init.method==='POST'){pushes.push({url,init});return new Response('',{status:201});}
  return new Response('x',{status:404});
};
const req=(p,o)=>new Request('https://sismo.test'+p,o);
const env={};const ctx={waitUntil(){}};
let ok=0,bad=0;const T=(c,m)=>{if(c){ok++}else{bad++;console.log('FAIL:',m)}};
for(const [name,html] of [['A tabla+links',htmlA],['B texto/pipes',htmlB],['C links &amp;',htmlC]]){
  IGC_HTML=html; const r=await w.fetch(req('/api/igc?fresh=1'),env,ctx); const j=await r.json();
  T(r.status===200,name+' status'); T(j.count===6,name+' count '+j.count);
  const q=j.quakes.find(x=>Math.abs(x.lat-7.55661)<1e-6);
  T(q&&q.mag===5.5&&q.st==='P'&&q.depth===5,name+' M5.5 fields '+JSON.stringify(q&&{m:q.mag,st:q.st,d:q.depth}));
  T(q&&Math.abs(q.t-(now-2*60000))<1500,name+' tiempo UTC: diff '+(q&&q.t-(now-2*60000)));
  T(q&&/^Panamá a 16km al norte de Tonosí$/.test(q.place),name+' place: '+(q&&q.place));
  const rv=j.quakes.find(x=>Math.abs(x.lat-7.89583)<1e-6);T(rv&&rv.st==='R',name+' revisado');
  if(name.startsWith('A')) T(j.quakes.some(x=>/a 33km al oeste de Tonosí/.test(x.place)),name+' región sin país');
}
IGC_HTML=htmlA;
// fusión + réplicas
let r=await w.fetch(req('/api/quakes?fresh=1'),env,ctx);let j=await r.json();
const m=j.quakes.find(x=>x.mag===5.5);
T(m&&m.src.join()==='IGC,USGS,EMSC,GEOFON','fusión 4 fuentes: '+(m&&m.src));
T(m&&m.mags.IGC===5.5&&m.mags.USGS===5.3&&m.mags.EMSC===5.4,'mags por fuente '+JSON.stringify(m&&m.mags));
T(m&&m.felt===12&&m.links.USGS,'datos USGS');
T(j.count===7,'dedupe total (6 + 1 solo GEOFON) '+j.count);
T(m.role==='main'&&(m.nrep>=2||m.nfore>=1),'principal con réplicas: '+m.role+' '+m.nrep);
const after=j.quakes.filter(x=>x.role==='after');T(after.length>=1,'hay réplicas');
const fore=j.quakes.filter(x=>x.role==='fore');console.log('roles',j.quakes.map(x=>x.mag+':'+x.role).join(' '));
for(const p of ['/api/igc.geojson','/api/quakes.geojson?min=4','/api/latest','/api/stats','/api/sequences','/api/status','/api','/','/app.js','/shared.js','/sw.js','/manifest.webmanifest','/icon.svg','/health','/nope']){
  const x=await w.fetch(req(p),env,ctx);const t=await x.text();
  console.log(p.padEnd(26),x.status,x.headers.get('content-type'),t.length);
}
const st=await (await w.fetch(req('/api/status'),env,ctx)).json();T(st.sources.IGC.ok&&st.sources.USGS.ok&&st.sources.EMSC.ok,'status fuentes');
const seq=await (await w.fetch(req('/api/sequences'),env,ctx)).json();console.log('seq',JSON.stringify(seq.sequences[0]));
// IGC caído → usa último dato bueno
IGC_HTML='<html>cambio de formato</html>';
const jj=await (await w.fetch(req('/api/status?fresh=1'),env,ctx)).json();
T(jj.sources.IGC.stale===true&&jj.sources.IGC.n===6,'IGC stale fallback '+JSON.stringify(jj.sources.IGC));
IGC_HTML=htmlA;
// iconos
for(const s of ['/icon-192.png','/icon-512.png','/apple-touch-icon.png']){const x=await w.fetch(req(s),env,ctx);const b=Buffer.from(await x.arrayBuffer());
  const{writeFileSync}=await import('fs');writeFileSync('.'+s.replace(/\//g,'_'),b);T(b.slice(0,8).toString('hex')==='89504e470d0a1a0a','png sig '+s);console.log(s,b.length);}
// ---------- Push ----------
class KV{constructor(){this.m=new Map()}async get(k,t){const v=this.m.get(k);if(!v)return null;return t==='json'?JSON.parse(v.v):v.v}async put(k,v,o){this.m.set(k,{v,meta:o&&o.metadata})}async delete(k){this.m.delete(k)}async list(o){const keys=[...this.m.entries()].filter(([k])=>k.startsWith(o.prefix||'')).map(([k,v])=>({name:k,metadata:v.meta}));return{keys,list_complete:true}}}
const env2={SISMO_KV:new KV(),PUSH_BUDGET:'40'};
const kj=await (await w.fetch(req('/api/push/key'),env2,ctx)).json();T(kj.ok&&kj.key.length>80,'vapid key');
const ua=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
const uaPub=new Uint8Array(await crypto.subtle.exportKey('raw',ua.publicKey));const auth=crypto.getRandomValues(new Uint8Array(16));
const b64=(u)=>Buffer.from(u).toString('base64url');
const subObj={endpoint:'https://fcm.googleapis.com/fcm/send/TESTTOKEN',keys:{p256dh:b64(uaPub),auth:b64(auth)}};
let sr=await w.fetch(req('/api/push/subscribe',{method:'POST',body:JSON.stringify({sub:subObj,prefs:{m1:3.5,m2:5,la:8.98,lo:-79.52,r:1}})}),env2,ctx);T((await sr.json()).ok,'subscribe');
let bad2=await w.fetch(req('/api/push/subscribe',{method:'POST',body:JSON.stringify({sub:{...subObj,endpoint:'https://evil.example.com/x'},prefs:{}})}),env2,ctx);T(bad2.status===400,'allowlist rechaza host ajeno');
// primer cron: inicializa sin enviar
globalThis.__x=1;await w.scheduled({},env2,{waitUntil:(p)=>p});await new Promise(r=>setTimeout(r,200));T(pushes.length===0,'init no inunda');
// nuevo sismo fuerte aparece en USGS
usgs.features.push({id:'us7000new',properties:{time:Date.now()-30000,mag:6.1,place:'Panama',status:'automatic',tsunami:1},geometry:{coordinates:[-79.8,8.3,15]}});
await w.fetch(req('/api/status?fresh=1'),env2,ctx);
let jobP;await w.scheduled({},env2,{waitUntil:(p)=>{jobP=p}});await jobP;
T(pushes.length===1,'push enviado: '+pushes.length);
if(pushes.length){const{url,init}=pushes[0];const h=init.headers;T(url===subObj.endpoint,'endpoint');T(h['content-encoding']==='aes128gcm','CE');
  const body=new Uint8Array(init.body);const salt=body.slice(0,16);const idlen=body[20];const asPub=body.slice(21,21+idlen);const ct=body.slice(21+idlen);
  T(idlen===65&&body[16]===0&&body[17]===0&&body[18]===16&&body[19]===0,'cabecera RFC8188');
  const peer=await crypto.subtle.importKey('raw',asPub,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const secret=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:peer},ua.privateKey,256));
  const hk=async(s,i,inf,l)=>{const k=await crypto.subtle.importKey('raw',i,'HKDF',false,['deriveBits']);return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt:s,info:inf},k,l*8))};
  const te=new TextEncoder(),cat=(...a)=>{const o=new Uint8Array(a.reduce((n,x)=>n+x.length,0));let i=0;for(const x of a){o.set(x,i);i+=x.length}return o};
  const ikm=await hk(auth,secret,cat(te.encode('WebPush: info\0'),uaPub,asPub),32);
  const cek=await hk(salt,ikm,te.encode('Content-Encoding: aes128gcm\0'),16),nonce=await hk(salt,ikm,te.encode('Content-Encoding: nonce\0'),12);
  const aes=await crypto.subtle.importKey('raw',cek,'AES-GCM',false,['decrypt']);
  const pt=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce},aes,ct));
  T(pt[pt.length-1]===2,'delimitador de relleno');const payload=JSON.parse(new TextDecoder().decode(pt.slice(0,-1)));console.log('PUSH payload:',JSON.stringify(payload));
  T(payload.lvl===3&&/M6\.1/.test(payload.title),'payload nivel 3');
  // JWT VAPID
  const m=/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h.authorization);T(!!m,'formato vapid');
  const pub=await crypto.subtle.importKey('raw',Buffer.from(m[4],'base64url'),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
  const okSig=await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},pub,Buffer.from(m[3],'base64url'),te.encode(m[1]+'.'+m[2]));T(okSig,'firma ES256 válida');
  const claims=JSON.parse(Buffer.from(m[2],'base64url').toString());T(claims.aud==='https://fcm.googleapis.com'&&claims.exp>Date.now()/1000,'claims '+JSON.stringify(claims));
}
// segundo cron: no repite
pushes.length=0;await w.scheduled({},env2,{waitUntil:(p)=>{jobP=p}});await jobP;T(pushes.length===0,'no duplica envíos');
{ // GEOFON y PTWC
  IGC_HTML=htmlA; const r=await w.fetch(req('/api/quakes?fresh=1'),env,ctx); const j=await r.json();
  T(j.sources.GEOFON&&j.sources.GEOFON.ok,'GEOFON ok '+JSON.stringify(j.sources.GEOFON));
  T(j.sources.GEOFON&&j.sources.GEOFON.n===2,'GEOFON n (excluye explosión) '+(j.sources.GEOFON&&j.sources.GEOFON.n));
  const m=j.quakes.find(q=>q.src.includes('GEOFON')&&q.src.includes('IGC'));
  T(!!m&&m.src.includes('USGS')&&m.src.includes('EMSC'),'GEOFON fusionado con el principal: '+(m&&m.src));
  T(j.quakes.some(q=>q.src.length===1&&q.src[0]==='GEOFON'&&Math.abs(q.mag-3.2)<0.01),'evento solo GEOFON visible');
  const r2=await w.fetch(req('/api/quakes?src=GEOFON&fresh=1'),env,ctx); const j2=await r2.json(); T(j2.count>=2,'filtro src=GEOFON '+j2.count);
  const r3=await w.fetch(req('/api/tsunami'),env,ctx); const t=await r3.json();
  T(t.ok&&t.messages.length===2,'PTWC mensajes '+(t.messages&&t.messages.length));
  T(t.messages[0].level===3&&t.messages[0].panama===true,'PTWC nivel/panamá '+JSON.stringify(t.messages[0]));
  T(t.messages[1].level===0,'PTWC sin amenaza nivel 0 '+t.messages[1].level);
}
console.log(`\nOK ${ok}  FAIL ${bad}`);
