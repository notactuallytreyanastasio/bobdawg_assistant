(function(){
  // Everything is captured first and called through Reflect.apply, because the code that runs after
  // this can rewrite any prototype, and a guard that looks a method up at call time obeys that rewrite.
  var apply=Reflect.apply, Str=String, exec=RegExp.prototype.exec, lastIndexOf=String.prototype.lastIndexOf, slice=String.prototype.slice;
  var TAGS='link|iframe|frame|frameset|object|embed|fencedframe|portal|base|meta|script|a|area';
  var DENY=new RegExp('^(?:'+TAGS+')$','i');
  var HTML_DENY=new RegExp('<(?:[^\\s/>:]*:)?(?:'+TAGS+')\\b','i');
  var hit=function(re,s){return apply(exec,re,[s])!==null;};
  var refuse=function(n){throw new Error('<'+n+'> is not available in an artifact');};
  var local=function(s){return apply(slice,s,[apply(lastIndexOf,s,[':'])+1]);};
  var ce=Document.prototype.createElement, cens=Document.prototype.createElementNS;
  Document.prototype.createElement=function(n,o){var s=Str(n);if(hit(DENY,local(s)))refuse(s);return apply(ce,this,[s,o]);};
  Document.prototype.createElementNS=function(ns,n,o){var s=Str(n);if(hit(DENY,local(s)))refuse(s);return apply(cens,this,[ns,s,o]);};
  trustedTypes.createPolicy('default',{
    createHTML:function(s){if(hit(HTML_DENY,s))refuse('markup');return s;},
    createScript:function(s){return s;},
    createScriptURL:function(){refuse('script url');}
  });
  // Chrome keeps adding ways to parse markup, and some skip Trusted Types, so any name with HTML in it
  // goes unless it is one of the three the policy above is known to guard.
  var KEEP={innerHTML:1,outerHTML:1,insertAdjacentHTML:1};
  [Document,Document.prototype,Element.prototype,ShadowRoot.prototype,CharacterData.prototype,Range.prototype].forEach(function(o){
    Object.getOwnPropertyNames(o).forEach(function(k){if(/HTML|Fragment$/.test(k)&&k!=='createDocumentFragment'&&!KEEP[k])delete o[k];});});
  ['implementation','write','writeln','open','execCommand'].forEach(function(k){delete Document.prototype[k];});
  ['RTCPeerConnection','webkitRTCPeerConnection','HTMLLinkElement','HTMLIFrameElement','HTMLFrameElement','HTMLObjectElement','HTMLEmbedElement','HTMLBaseElement','HTMLMetaElement','HTMLAnchorElement','HTMLAreaElement','HTMLScriptElement','XSLTProcessor','DOMParser','customElements','CustomElementRegistry'].forEach(function(k){delete window[k];});
  var active=Object.getOwnPropertyDescriptor(UserActivation.prototype,'isActive').get, ua=navigator.userActivation;
  var gate=function(f){return function(o){if(apply(active,ua,[]))return apply(f,this,[o]);};};
  [HTMLElement,SVGElement].forEach(function(C){C.prototype.focus=gate(C.prototype.focus);});
  [HTMLInputElement,HTMLTextAreaElement].forEach(function(C){C.prototype.select=gate(C.prototype.select);});
  window.focus=function(){};
})();
