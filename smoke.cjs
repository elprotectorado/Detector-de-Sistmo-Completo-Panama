const {JSDOM}=require('jsdom');const fs=require('fs');
const html=fs.readFileSync('c-index.html','utf8').replace(/<script[^>]*src=[^>]*><\/script>/g,'').replace(/<link[^>]*stylesheet[^>]*>/g,'');
const dom=new JSDOM(html,{url:'https://x.test/',runScripts:'dangerously',pretendToBeVisual:true});
const w=dom.window;const errs=[];
w.addEventListener('error',e=>errs.push('ERR '+e.message));
const chain=()=>new Proxy(function(){},{get:(t,k)=>k==='then'?undefined:k===Symbol.toPrimitive?()=>8:chain(),apply:()=>chain(),construct:()=>chain()});
w.L=chain();
const ctx=new Proxy({},{get:(t,k)=>k==='measureText'?()=>({width:5}):k==='createLinearGradient'||k==='createRadialGradient'?()=>({addColorStop(){}}):()=>{},set:()=>true});
w.HTMLCanvasElement.prototype.getContext=()=>ctx;
w.matchMedia=()=>({matches:false,addEventListener(){}});
class Node1{connect(){return this}disconnect(){}start(){}stop(){}setValueAtTime(){}exponentialRampToValueAtTime(){}linearRampToValueAtTime(){}setTargetAtTime(){}cancelScheduledValues(){}}
w.AudioContext=function(){const n=()=>{const o=new Node1();o.gain=new Node1();o.frequency=new Node1();o.Q=new Node1();o.detune=new Node1();o.delayTime={value:0};o.threshold={};o.ratio={};o.playbackRate=new Node1();return o};this.currentTime=0;this.sampleRate=44100;this.state='running';this.destination=n();['createGain','createOscillator','createBiquadFilter','createDelay','createDynamicsCompressor','createBufferSource','createStereoPanner','createWaveShaper'].forEach(k=>this[k]=n);this.createBuffer=(c,l)=>({getChannelData:()=>new Float32Array(l)});this.resume=()=>Promise.resolve()};
w.Notification=function(){};w.Notification.permission='granted';w.Notification.requestPermission=()=>Promise.resolve('granted');
w.caches={open:()=>Promise.resolve({put:()=>Promise.resolve()}),keys:()=>Promise.resolve([])};w.Response=Response;
const now=Date.now();
const qk=[{id:'a1',src:['IGC','USGS'],t:now-5*60e3,lat:7.3,lon:-81.9,depth:12,mag:5.5,place:'Panamá a 30 km al S de Tonosí',st:'P',mags:{IGC:5.5,USGS:5.3},links:{IGC:'https://x'}},
{id:'a2',src:['IGC'],t:now-2*60e3,lat:7.35,lon:-81.85,depth:10,mag:4.2,place:'Panamá a 28 km al S de Tonosí',st:'P',mags:{},links:{}},
{id:'a3',src:['USGS'],t:now-3600e3,lat:8.9,lon:-79.5,depth:20,mag:3.1,place:'Panamá a 5 km de Colón',st:'R',mags:{},links:{}},
{id:'a4',src:['EMSC'],t:now-5*864e5,lat:9.1,lon:-82.4,depth:30,mag:2.8,place:'Panamá Bocas',st:'R',mags:{},links:{}}];
w.fetch=async(u)=>{const s=String(u);let b={};
 if(s.includes('/api/quakes'))b={quakes:qk,sources:{IGC:{ok:true,n:2,ms:300,at:now},USGS:{ok:true,n:2,ms:200},EMSC:{ok:false,err:'timeout',n:0}}};
 else if(s.includes('push/key'))b={ok:false};else if(s.includes('status'))b={version:'t'};
 return {ok:true,status:200,json:async()=>b,text:async()=>''}};
w.WebSocket=function(){this.close=()=>{}};
Object.defineProperty(w.navigator,'serviceWorker',{value:{register:()=>Promise.resolve({addEventListener(){}}),addEventListener(){},ready:Promise.resolve({showNotification(){return Promise.resolve()},getNotifications:()=>Promise.resolve([]),pushManager:{getSubscription:()=>Promise.resolve(null)}}),controller:null}});
w.PushManager=function(){};w.speechSynthesis={speak(){},cancel(){},getVoices:()=>[]};w.SpeechSynthesisUtterance=function(){};
w.requestAnimationFrame=f=>setTimeout(f,16);
const EV=(c)=>{const sc=w.document.createElement('script');sc.textContent='window.__r=('+c.replace(/;\s*$/,'')+')';w.document.body.appendChild(sc);return w.__r};
const run=(f)=>{const sc=w.document.createElement('script');sc.textContent=fs.readFileSync(f,'utf8');w.document.body.appendChild(sc)};
run('c-shared.js');run('c-app.js');
(async()=>{
 await new Promise(r=>setTimeout(r,800));
 const $=s=>w.document.querySelector(s);
 console.log('Q len', EV('Q.length'), 'roles', EV('Q.map(q=>q.id+":"+q.role).join(",")'));
 console.log('hero:', $('#hero').textContent.slice(0,120));
 $('#go').click();
 for (const t of ['eventos','replicas','datos','guia','ajustes','radar']) { EV('goTab("'+t+'")'); const v=$('#v-'+t); console.log(t, 'len', v.innerHTML.length); }
 EV('goTab("ajustes")');
 EV('liveAjustes()');
 EV('selectEvent("a1",true)');console.log('sheet', $('#sheet').classList.contains('on'), $('#sheet').textContent.slice(0,80));
 EV('drill()');await new Promise(r=>setTimeout(r,700));console.log('alarm', $('#alarm').className, $('#alarm').textContent.slice(0,80));
 EV('closeAlarm()');
 EV('exportData("csv")');
 console.log('leds', $('#leds').textContent);
 console.log('errors', errs.length?errs:'none');
 process.exit(0);
})().catch(e=>{console.log('FAIL',e);process.exit(1)});
w.addEventListener('unhandledrejection',e=>errs.push('REJ '+e.reason));
