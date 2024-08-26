(self.webpackChunk_N_E=self.webpackChunk_N_E||[]).push([[405],{73871:function(e,t,n){(window.__NEXT_P=window.__NEXT_P||[]).push(["/",function(){return n(10038)}])},10038:function(e,t,n){"use strict";n.r(t),n.d(t,{__N_SSG:function(){return k},default:function(){return S}});var a=n(52676),r=n(75271),s=n(409),o=n(40),l=n.n(o),c=n(69906);n(91336),n(33014);var i={dropbtn:"dropbtn",dropdown:"dropdown",dropdownContent:"dropdown-content",hamburger:"hamburger",hover:"hover",menu:"menu",open:"open",topnav:"_1626uu10"};function d({name:e,sections:t,hover:n=!0,log:a}){let[s,o]=(0,r.useState)("");return r.createElement("div",{className:`${i.dropdown} ${i.menu} ${s}`,onMouseEnter:e=>{a&&console.log("dropdown onMouseEnter"),o(n?i.open:i.hover),e.stopPropagation()},onMouseLeave:e=>{a&&console.log("dropdown onMouseLeave"),o("")}},r.createElement("button",{className:i.dropbtn,onClick:e=>{a&&console.log("dropdown onClick"),e.stopPropagation(),o(s==i.open?"":i.open)}},e," ",r.createElement("i",{className:`fa fa-caret-${s==i.open?"down":"right"}`})),r.createElement("div",{className:i.dropdownContent},t.map(({id:e,name:t})=>r.createElement("a",{key:e,href:`#${e}`},t))))}function u({id:e,classes:t="",theme:n="jfb5663",menus:a,hover:s,log:o,children:l}){let[c,u]=(0,r.useState)(0),[m,h]=(0,r.useState)(!1),[p,f]=(0,r.useState)(!1);return(0,r.useEffect)(()=>{let t=()=>{let t=document?.getElementById(e);if(!t)return;let n=t.offsetHeight,a=window.scrollY;c&&!m&&a>=c?t.style.top=`-${n}px`:(t.classList.remove("absolute"),t.style.top="0"),u(a),h(!1)};return window.removeEventListener("scroll",t),window.addEventListener("scroll",t,{passive:!0}),()=>window.removeEventListener("scroll",t)},[m,h,c,u]),r.createElement("div",{id:e,className:`${i.topnav} ${t} ${n} ${p?i.open:""}`,onClick:()=>{o&&console.log("nav onClick"),f(!p),h(!0)},onMouseEnter:()=>{o&&console.log("nav onMouseEnter"),f(!0)},onMouseLeave:()=>{o&&console.log("nav onMouseLeave"),f(!1)}},r.createElement("button",{key:"hamburger",className:i.hamburger},"☰"),a.map(({id:e,name:t,sections:n})=>n?r.createElement(d,{key:t,name:t,sections:n,hover:s,log:o}):r.createElement("a",{key:t,href:`#${e}`,className:i.menu},t)),l)}var m=n(44889),h=n(84737),p=n(42137),f=n(34273),j=n(21666),x=n(19418),w=n(22764),y=n(99197),g=n(95074),v=n(47557),N=n(17546),E=n(94001),b=n(27170),_=n(62249),k=!0,S=e=>{let{plotsDict:t,njspProps:n,urls:o,cc2mc2mn:i,crashes:d,totals:k}=e,S=(0,m.b)(),[C]=(0,r.useState)(65536),[J,...M]=f.Vv,T=(0,j.RY)(J,t[J.id]),$=(0,j.mB)(M,t),P=[T,{id:"recent-fatal-crashes",title:"Recent Fatal Crashes",dropdownSection:"NJSP"},...$].map(e=>{let{id:t,title:n,menuName:a,dropdownSection:r}=e;return{id:t,name:a||n,dropdownSection:r}}),D=[{id:"NJSP",name:"NJSP"},{id:"state-years",name:"State x Years"},{id:"county-years",name:"Counties x Years"},{id:"state-months",name:"State x Months"},{id:"county-months",name:"Counties x Months"}].map(e=>({...e,sections:P.filter(t=>{let{dropdownSection:n}=t;return e.name==n})})),L="NJ Traffic Crash Data",[O,Z]=(0,r.useState)(null),H=(0,N.Le)({id:"njsp-crashes"}),I=(0,E.I)({crashes:d,urls:o,cc:null,mc:null,cc2mc2mn:i,...H}),F=(0,E.t$)({totals:k,urls:o,cc:null,mc:null,requestChunkSize:C}),R=(0,N.lo)(F,e=>(0,b.Z)(e).total,H);return(0,a.jsxs)("div",{className:l().container,children:[(0,a.jsx)(s.F,{title:L,description:"Analysis & Visualization of traffic crash data published by NJ State Police and NJ DOT",url:h.H,thumbnail:"".concat(h.H,"/plots/fatalities_per_year_by_type.png")}),(0,a.jsx)(u,{id:"nav",classes:"collapsed",menus:D,hover:!1,children:(0,a.jsx)("link",{rel:"stylesheet",href:"https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css"})}),(0,a.jsxs)("main",{className:l().index,children:[(0,a.jsx)("h1",{className:l().title,children:L}),(0,a.jsxs)("p",{children:[(0,a.jsxs)(c.Z,{href:"#per-year",children:["The first ",D[0].sections.length," plots below"]})," come from ",(0,a.jsx)(c.Z,{title:"NJ State Police fatal crash data",href:w.jy,children:"NJ State Police fatal crash data"})," (2008-present). ","It's generally current to the previous day."]}),(0,a.jsxs)("p",{children:[(0,a.jsx)(c.Z,{href:"#njdot",children:"Below that"})," are plots of ",(0,a.jsx)(c.Z,{title:"NJ DOT raw crash data",href:w.Iv,children:"NJ DOT raw crash data"}),", which includes 6MM property-damage, injury, and fatal crashes from 2001-2021. ","It's a richer dataset, but less up to date."]}),(0,a.jsxs)("p",{children:[(0,a.jsx)("span",{className:l().bold,children:"Work in progress"})," map of NJDOT data: 5 years (2017-2021) of fatal and injury crashes in Hudson County:"]}),(0,a.jsx)("iframe",{src:"".concat(S,"/map/hudson"),className:l().map}),(0,a.jsxs)("ul",{style:{listStyle:"none"},children:[(0,a.jsx)("li",{children:(0,a.jsx)(c.Z,{href:"/map/hudson",children:"Full screen map here"})}),(0,a.jsxs)("li",{children:["Code and cleaned data are ",(0,a.jsx)(c.Z,{href:p.Tf.href,children:"here on GitHub"}),"."]})]}),(0,a.jsxs)("div",{className:l()["plot-container"],children:[(0,a.jsx)(x.l_,{...n,params:T.params,county:O,setCounty:Z,includeMoreInfoLink:!0}),(0,a.jsx)("hr",{})]}),(0,a.jsxs)("div",{className:l()["plot-container"],children:[(0,a.jsxs)("div",{className:l().section,children:[(0,a.jsx)(v.H2,{id:"recent-fatal-crashes",children:"Recent fatal crashes"}),I&&(0,a.jsx)(g.W,{result:I,pagination:R}),(0,a.jsx)(_.Zk,{})]}),(0,a.jsx)("hr",{})]}),$.map((e,t)=>{let{id:n,...s}=e;return(0,a.jsxs)(r.Fragment,{children:[t+2==D[0].sections.length&&(0,a.jsxs)(a.Fragment,{children:[(0,a.jsx)("h1",{id:"njdot",children:(0,a.jsx)("a",{href:"#njdot",children:"NJ DOT Raw Crash Data"})}),(0,a.jsxs)("p",{children:["NJ DOT ",(0,a.jsx)(c.Z,{title:"NJ DOT raw crash data",href:"https://www.state.nj.us/transportation/refdata/accident/rawdata01-current.shtm",children:"publishes raw crash data"}),", including property-damage, injury, and fatal crashes, going back to 2001 (≈6MM records)."]}),(0,a.jsx)("p",{children:"The data currently ends in 2021, after a drop in all types of crashes due to COVID, and mid-way through a spike in fatal crashes in 2021-2022 (based on the NJSP data above). 2022 data should land in early 2024."})]}),(0,a.jsxs)("div",{className:l()["plot-container"],children:[(0,a.jsx)(j.XN,{id:n,basePath:S,...s,margin:{t:10,b:30}}),(0,a.jsx)("hr",{})]},n)]},n)}),(0,a.jsx)(y.Z,{})]})]})}},84737:function(e,t,n){"use strict";n.d(t,{H:function(){return r},n:function(){return a}});let a="crashes.hudcostreets.org",r="https://".concat(a)},91336:function(){},33014:function(){},89350:function(e,t,n){e.exports=n(5037)},409:function(e,t,n){"use strict";n.d(t,{F:function(){return o}});var a=n(75271),r=n(89350),s=n(44889);function o({title:e,description:t,type:n="website",url:o,thumbnail:l,favicon:c,twitterCard:i="summary_large_image",children:d}){let u=(0,s.b)();return c=c||`${u}/favicon.ico`,a.createElement(r,null,a.createElement("title",null,e),a.createElement("link",{rel:"icon",href:c}),a.createElement("meta",{name:"description",content:t}),a.createElement("meta",{property:"og:title",content:e}),a.createElement("meta",{property:"og:description",content:t}),a.createElement("meta",{property:"og:type",content:n}),a.createElement("meta",{property:"og:url",content:o}),a.createElement("meta",{property:"og:image",content:l}),a.createElement("meta",{name:"twitter:title",content:e}),a.createElement("meta",{name:"twitter:description",content:t}),a.createElement("meta",{name:"twitter:image",content:l}),a.createElement("meta",{name:"twitter:card",content:i}),d)}}},function(e){e.O(0,[226,883,906,172,198,214,809,640,13,557,888,774,179],function(){return e(e.s=73871)}),_N_E=e.O()}]);