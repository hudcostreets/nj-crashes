(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[294],{8588:function(e,t,r){e.exports=r(3035)},1159:function(e,t,r){(window.__NEXT_P=window.__NEXT_P||[]).push(["/sql",function(){return r(698)}])},698:function(e,t,r){"use strict";r.r(t),r.d(t,{default:function(){return m}});var n=r(1527),a=r(959),o=r(1358),i=r(3413);let{time:l,timeEnd:u}=console;async function s(e,t={}){let n=new r.U(r(8777)),a=new r.U(r(3289)),o=Array.isArray(e)?e:[{from:"inline",config:{serverMode:"full",...e,requestChunkSize:e.requestChunkSize??4096}}],s="Created db worker";t.time&&(console.log("Creating db worker:",o),l(s));let c=await (0,i.createDbWorker)(o,n.toString(),a.toString(),t.maxBytesToRead);return t.time&&u(s),c}async function c(e,t={}){return(await s(e,t)).db}var f=r(7253);let{time:d,timeEnd:p}=console;function m(){let e=(0,o.b)(),t="time to first query result",r=function(e,t={}){let r=(0,a.useRef)(null),[n,o]=(0,a.useState)(!1);return(0,a.useEffect)(()=>{(async function(){t.openTimeMsg&&l(t.openTimeMsg),r.current=await c(e,t),o(!0)})()},[]),(0,a.useMemo)(()=>r.current,[n])}({url:"".concat(e,"/njsp/year-type-county.db")},{time:!0,openTimeMsg:t}),[i,u]=(0,a.useState)(null);return(0,a.useEffect)(()=>{console.log("effect:",r),async function(){if(!r)return;let e="select * from ytc",n="ran query: ".concat(e);d(n);let a=await r.query(e);p(n),p(t),console.log("result:",a),u(a)}()},[r]),(0,n.jsx)("div",{children:(0,n.jsxs)("table",{children:[(0,n.jsx)("thead",{children:(0,n.jsx)("tr",{children:(null==i?void 0:i.length)?(0,f.XP)(i[0]).map((e,t)=>(0,n.jsx)("th",{children:e},t)):null})}),(0,n.jsx)("tbody",{children:null==i?void 0:i.map((e,t)=>(0,n.jsx)("tr",{children:(0,f.VO)(e).map((e,t)=>(0,n.jsx)("td",{children:e},t))},t))})]})})}},3413:function(e){e.exports=(()=>{"use strict";var e={870:(e,t,r)=>{r.r(t),r.d(t,{createEndpoint:()=>a,expose:()=>s,proxy:()=>y,proxyMarker:()=>n,releaseProxy:()=>o,transfer:()=>h,transferHandlers:()=>u,windowEndpoint:()=>g,wrap:()=>f});let n=Symbol("Comlink.proxy"),a=Symbol("Comlink.endpoint"),o=Symbol("Comlink.releaseProxy"),i=Symbol("Comlink.thrown"),l=e=>"object"==typeof e&&null!==e||"function"==typeof e,u=new Map([["proxy",{canHandle:e=>l(e)&&e[n],serialize(e){let{port1:t,port2:r}=new MessageChannel;return s(e,t),[r,[r]]},deserialize:e=>(e.start(),f(e))}],["throw",{canHandle:e=>l(e)&&i in e,serialize:({value:e})=>[e instanceof Error?{isError:!0,value:{message:e.message,name:e.name,stack:e.stack}}:{isError:!1,value:e},[]],deserialize(e){if(e.isError)throw Object.assign(Error(e.value.message),e.value);throw e.value}}]]);function s(e,t=self){t.addEventListener("message",function r(n){let a;if(!n||!n.data)return;let{id:o,type:l,path:u}=Object.assign({path:[]},n.data),f=(n.data.argumentList||[]).map(b);try{let t=u.slice(0,-1).reduce((e,t)=>e[t],e),r=u.reduce((e,t)=>e[t],e);switch(l){case 0:a=r;break;case 1:t[u.slice(-1)[0]]=b(n.data.value),a=!0;break;case 2:a=r.apply(t,f);break;case 3:a=y(new r(...f));break;case 4:{let{port1:t,port2:r}=new MessageChannel;s(e,r),a=h(t,[t])}break;case 5:a=void 0}}catch(e){a={value:e,[i]:0}}Promise.resolve(a).catch(e=>({value:e,[i]:0})).then(e=>{let[n,a]=v(e);t.postMessage(Object.assign(Object.assign({},n),{id:o}),a),5===l&&(t.removeEventListener("message",r),c(t))})}),t.start&&t.start()}function c(e){"MessagePort"===e.constructor.name&&e.close()}function f(e,t){return function e(t,r=[],n=function(){}){let i=!1,l=new Proxy(n,{get(n,a){if(d(i),a===o)return()=>w(t,{type:5,path:r.map(e=>e.toString())}).then(()=>{c(t),i=!0});if("then"===a){if(0===r.length)return{then:()=>l};let e=w(t,{type:0,path:r.map(e=>e.toString())}).then(b);return e.then.bind(e)}return e(t,[...r,a])},set(e,n,a){d(i);let[o,l]=v(a);return w(t,{type:1,path:[...r,n].map(e=>e.toString()),value:o},l).then(b)},apply(n,o,l){d(i);let u=r[r.length-1];if(u===a)return w(t,{type:4}).then(b);if("bind"===u)return e(t,r.slice(0,-1));let[s,c]=p(l);return w(t,{type:2,path:r.map(e=>e.toString()),argumentList:s},c).then(b)},construct(e,n){d(i);let[a,o]=p(n);return w(t,{type:3,path:r.map(e=>e.toString()),argumentList:a},o).then(b)}});return l}(e,[],t)}function d(e){if(e)throw Error("Proxy has been released and is not useable")}function p(e){var t;let r=e.map(v);return[r.map(e=>e[0]),(t=r.map(e=>e[1]),Array.prototype.concat.apply([],t))]}let m=new WeakMap;function h(e,t){return m.set(e,t),e}function y(e){return Object.assign(e,{[n]:!0})}function g(e,t=self,r="*"){return{postMessage:(t,n)=>e.postMessage(t,r,n),addEventListener:t.addEventListener.bind(t),removeEventListener:t.removeEventListener.bind(t)}}function v(e){for(let[t,r]of u)if(r.canHandle(e)){let[n,a]=r.serialize(e);return[{type:3,name:t,value:n},a]}return[{type:0,value:e},m.get(e)||[]]}function b(e){switch(e.type){case 3:return u.get(e.name).deserialize(e.value);case 0:return e.value}}function w(e,t,r){return new Promise(n=>{let a=[,,,,].fill(0).map(()=>Math.floor(Math.random()*Number.MAX_SAFE_INTEGER).toString(16)).join("-");e.addEventListener("message",function t(r){r.data&&r.data.id&&r.data.id===a&&(e.removeEventListener("message",t),n(r.data))}),e.start&&e.start(),e.postMessage(Object.assign({id:a},t),r)})}},162:function(e,t,r){var n=this&&this.__createBinding||(Object.create?function(e,t,r,n){void 0===n&&(n=r),Object.defineProperty(e,n,{enumerable:!0,get:function(){return t[r]}})}:function(e,t,r,n){void 0===n&&(n=r),e[n]=t[r]}),a=this&&this.__setModuleDefault||(Object.create?function(e,t){Object.defineProperty(e,"default",{enumerable:!0,value:t})}:function(e,t){e.default=t}),o=this&&this.__importStar||function(e){if(e&&e.__esModule)return e;var t={};if(null!=e)for(var r in e)"default"!==r&&Object.prototype.hasOwnProperty.call(e,r)&&n(t,e,r);return a(t,e),t};Object.defineProperty(t,"__esModule",{value:!0}),t.createDbWorker=void 0;let i=o(r(870));async function l(e){if(e.data&&"eval"===e.data.action){let t;let r=new Int32Array(e.data.notify,0,2),n=new Uint8Array(e.data.notify,8);try{t={ok:await c(e.data.request)}}catch(r){console.error("worker request error",e.data.request,r),t={err:String(r)}}let a=(new TextEncoder).encode(JSON.stringify(t));n.set(a,0),r[1]=a.length,Atomics.notify(r,0)}}function u(e){if("BODY"===e.tagName)return"body";let t=[];for(;e.parentElement&&"BODY"!==e.tagName;){if(e.id){t.unshift("#"+e.id);break}{let r=1,n=e;for(;n.previousElementSibling;)n=n.previousElementSibling,r++;t.unshift(e.tagName.toLowerCase()+":nth-child("+r+")")}e=e.parentElement}return t.join(" > ")}function s(e){return Object.keys(e)}async function c(e){if(console.log("dom vtable request",e),"select"===e.type)return[...document.querySelectorAll(e.selector)].map(t=>{let r={};for(let n of e.columns)"selector"===n?r.selector=u(t):"parent"===n?t.parentElement&&(r.parent=t.parentElement?u(t.parentElement):null):"idx"===n||(r[n]=t[n]);return r});if("insert"===e.type){if(!e.value.parent)throw Error('"parent" column must be set when inserting');let t=document.querySelectorAll(e.value.parent);if(0===t.length)throw Error(`Parent element ${e.value.parent} could not be found`);if(t.length>1)throw Error(`Parent element ${e.value.parent} ambiguous (${t.length} results)`);let r=t[0];if(!e.value.tagName)throw Error("tagName must be set for inserting");let n=document.createElement(e.value.tagName);for(let t of s(e.value))if(null!==e.value[t]){if("tagName"===t||"parent"===t)continue;if("idx"===t||"selector"===t)throw Error(`${t} can't be set`);n[t]=e.value[t]}return r.appendChild(n),null}if("update"===e.type){let t=document.querySelector(e.value.selector);if(!t)throw Error(`Element ${e.value.selector} not found!`);let r=[];for(let n of s(e.value)){let a=e.value[n];if("parent"!==n){if("idx"!==n&&"selector"!==n&&a!==t[n]){if(console.log("SETTING ",n,t[n],"->",a),"tagName"===n)throw Error("can't change tagName");r.push(n)}}else if(a!==u(t.parentElement)){let e=document.querySelectorAll(a);if(1!==e.length)throw Error(`Invalid target parent: found ${e.length} matches`);e[0].appendChild(t)}}for(let n of r)t[n]=e.value[n];return null}throw Error(`unknown request ${e.type}`)}i.transferHandlers.set("WORKERSQLPROXIES",{canHandle:e=>!1,serialize(e){throw Error("no")},deserialize:e=>(e.start(),i.wrap(e))}),t.createDbWorker=async function(e,t,r,n=1/0){let a=new Worker(t),o=i.wrap(a),u=await o.SplitFileHttpDatabase(r,e,void 0,n);return a.addEventListener("message",l),{db:u,worker:o,configs:e}}},432:function(e,t,r){var n=this&&this.__createBinding||(Object.create?function(e,t,r,n){void 0===n&&(n=r),Object.defineProperty(e,n,{enumerable:!0,get:function(){return t[r]}})}:function(e,t,r,n){void 0===n&&(n=r),e[n]=t[r]}),a=this&&this.__exportStar||function(e,t){for(var r in e)"default"===r||Object.prototype.hasOwnProperty.call(t,r)||n(t,e,r)};Object.defineProperty(t,"__esModule",{value:!0}),a(r(162),t)}},t={};function r(n){var a=t[n];if(void 0!==a)return a.exports;var o=t[n]={exports:{}};return e[n].call(o.exports,o,o.exports,r),o.exports}return r.d=(e,t)=>{for(var n in t)r.o(t,n)&&!r.o(e,n)&&Object.defineProperty(e,n,{enumerable:!0,get:t[n]})},r.o=(e,t)=>Object.prototype.hasOwnProperty.call(e,t),r.r=e=>{"undefined"!=typeof Symbol&&Symbol.toStringTag&&Object.defineProperty(e,Symbol.toStringTag,{value:"Module"}),Object.defineProperty(e,"__esModule",{value:!0})},r(432)})()},3289:function(e,t,r){"use strict";e.exports=r.p+"static/media/sql-wasm.9b4392f6.wasm"},8777:function(e,t,r){"use strict";e.exports=r.p+"static/media/sqlite.worker.b8507771.js"},7253:function(e,t,r){"use strict";r.d(t,{Q8:function(){return s},V7:function(){return u},VO:function(){return a},XP:function(){return o},_I:function(){return l},qh:function(){return n},sq:function(){return i}});let{entries:n,values:a,keys:o,fromEntries:i}=Object;function l(e,t){return n(e).map(([e,r],n)=>t(e,r,n))}function u(e,t,r){let a=n(e).map(([e,r],n)=>t(e,r,n));return r&&a.reverse(),i(a)}function s(e,t){return u(e,(e,r)=>[e,t(e,r)])}},1358:function(e,t,r){"use strict";r.d(t,{b:function(){return o}});var n=r(8588);let a=n.default||n;function o(){let{publicRuntimeConfig:e}=a();if(!e)return"";let{basePath:t=""}=e;return t}}},function(e){e.O(0,[774,888,179],function(){return e(e.s=1159)}),_N_E=e.O()}]);