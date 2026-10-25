
(()=>{
const $=id=>document.getElementById(id);
let config={},me=null,contacts=[],active=null,socket=null,pc=null,localStream=null,activeCall=null,incoming=null,muted=false,cameraOff=false;
const rtc={iceServers:[{urls:"stun:stun.l.google.com:19302"}]};

function toast(t){
  const x=$("toast");
  if(!x){alert(t);return}
  x.textContent=t;
  x.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer=setTimeout(()=>x.classList.remove("show"),5000);
}

async function api(url,opts={}){
  const r=await fetch(url,{
    credentials:"same-origin",
    headers:{"Content-Type":"application/json"},
    ...opts
  });
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw Error(d.error||`Request failed (${r.status})`);
  return d;
}

async function boot(){
  try{
    config=await api("/api/config");
    const d=await api("/api/me");
    if(d.user){
      me=d.user;
      showMain();
      await loadContacts();
      connect();
      pushSetup();
      const id=new URLSearchParams(location.search).get("contact");
      if(id){
        const c=contacts.find(x=>String(x.id)===id);
        if(c)await open(c);
      }
    }else{
      showLogin();
      googleReady();
    }
  }catch(e){
    console.error("SlowTalk startup error:",e);
    showLogin(e.message);
    googleReady();
  }
}

function showLogin(e=""){
  $("loginView").hidden=false;
  $("mainView").hidden=true;
  $("loginError").textContent=e;
}

function showMain(){
  $("loginView").hidden=true;
  $("mainView").hidden=false;
  $("logoutBtn").hidden=false;
  $("meName").textContent=me.displayName||me.email;
  if(me.pictureUrl){
    $("mePic").src=me.pictureUrl;
    $("mePic").hidden=false;
  }
}

function googleReady(){
  let n=0;
  const t=setInterval(()=>{
    n++;
    if(window.google?.accounts?.id){
      clearInterval(t);
      if(!config.googleClientId){
        $("loginError").textContent="Set GOOGLE_CLIENT_ID in Render environment variables.";
        return;
      }
      google.accounts.id.initialize({
        client_id:config.googleClientId,
        callback:async r=>{
          try{
            me=(await api("/api/auth/google",{
              method:"POST",
              body:JSON.stringify({credential:r.credential})
            })).user;
            showMain();
            await loadContacts();
            connect();
            pushSetup();
          }catch(e){
            console.error("Google login error:",e);
            showLogin(e.message);
          }
        }
      });
      google.accounts.id.renderButton($("googleButton"),{
        theme:"filled_black",
        size:"large",
        shape:"pill",
        text:"signin_with",
        width:260
      });
    }
    if(n>100)clearInterval(t);
  },100);
}

async function loadContacts(){
  const d=await api("/api/contacts");
  contacts=d.contacts||[];
  renderContacts();
}

function renderContacts(){
  const box=$("contacts");
  box.innerHTML="";
  if(!contacts.length){
    box.textContent="Add a friend by Gmail address.";
    box.className="contacts muted";
    return;
  }
  box.className="contacts";
  contacts.forEach(c=>{
    const row=document.createElement("div");
    row.className="contact"+(String(active?.id)===String(c.id)?" active":"");
    const av=document.createElement("div");
    av.className="contact-avatar";
    av.textContent=(c.displayName||c.email||"?")[0].toUpperCase();
    const cp=document.createElement("div");
    cp.className="contact-copy";
    const b=document.createElement("strong");
    const s=document.createElement("span");
    b.textContent=c.displayName||c.email;
    s.textContent=c.email;
    cp.append(b,s);
    row.append(av,cp);
    row.onclick=()=>open(c).catch(e=>{
      console.error("Open conversation error:",e);
      toast(e.message);
    });
    box.append(row);
  });
}

async function open(c){
  active=c;
  renderContacts();
  $("welcome").hidden=true;
  $("chatView").hidden=false;
  $("activeAvatar").textContent=(c.displayName||c.email||"?")[0].toUpperCase();
  $("activeName").textContent=c.displayName||c.email;
  $("activeEmail").textContent=c.email;
  $("messages").innerHTML="";
  const d=await api("/api/conversations/"+encodeURIComponent(c.id)+"/messages");
  (d.messages||[]).forEach(renderMessage);
  const u=new URL(location.href);
  u.searchParams.set("contact",c.id);
  history.replaceState({},"",u);
}

function renderMessage(m){
  if(!active||
    (String(m.senderId)!==String(me.id)&&
     String(m.senderId)!==String(active.id)))return;
  const row=document.createElement("div");
  row.className="message "+(String(m.senderId)===String(me.id)?"mine":"theirs");
  const b=document.createElement("div");
  b.className="bubble";
  b.textContent=m.body;
  const meta=document.createElement("span");
  meta.className="meta";
  meta.textContent=new Date(m.createdAt).toLocaleTimeString([],{
    hour:"2-digit",minute:"2-digit"
  });
  row.append(b,meta);
  $("messages").append(row);
  $("messages").scrollTop=$("messages").scrollHeight;
}

/* Corrected Add Contact handler with visible diagnostics */
const addContactForm=$("addContactForm");

if(addContactForm){
  addContactForm.addEventListener("submit",async e=>{
    e.preventDefault();
    const input=$("contactEmail");
    const button=addContactForm.querySelector('button[type="submit"]')||
                 addContactForm.querySelector("button");
    const email=input?.value.trim();

    if(!email){
      toast("Enter your friend's Gmail address.");
      input?.focus();
      return;
    }

    if(button)button.disabled=true;
    toast("Adding contact…");

    try{
      const d=await api("/api/contacts",{
        method:"POST",
        body:JSON.stringify({email})
      });

      if(input)input.value="";
      await loadContacts();
      toast("Contact added: "+(d.contact?.email||email));
    }catch(err){
      console.error("Add contact error:",err);
      toast("Add contact failed: "+err.message);
    }finally{
      if(button)button.disabled=false;
    }
  });
}else{
  console.error("SlowTalk: #addContactForm was not found in the page.");
  window.addEventListener("DOMContentLoaded",()=>{
    const form=$("addContactForm");
    if(!form)return;
    form.addEventListener("submit",async e=>{
      e.preventDefault();
      toast("Form loaded late. Refresh the page and try again.");
    });
  });
}

$("messageForm").onsubmit=e=>{
  e.preventDefault();
  const body=$("messageInput").value.trim();
  if(!body||!active)return;
  if(!socket||!socket.connected){
    toast("Chat connection unavailable. Refresh and sign in again.");
    return;
  }
  socket.emit("chat:send",{to:active.id,body},r=>{
    if(!r?.ok)toast(r?.error||"Message failed");
    else $("messageInput").value="";
  });
};

function connect(){
  if(socket)socket.disconnect();
  socket=io();

  socket.on("connect_error",e=>{
    console.error("Socket connection error:",e);
    toast("Realtime connection failed; refresh and sign in again.");
  });

  socket.on("chat:new",m=>{
    const sender=String(m.senderId);
    const other=sender===String(me.id)?String(active?.id||""):sender;
    const c=contacts.find(x=>String(x.id)===other);
    if(active&&String(active.id)===other){
      renderMessage(m);
    }else if(sender!==String(me.id)){
      toast("New message from "+(c?.displayName||m.senderName||c?.email||"contact"));
    }
  });

  socket.on("call:incoming",showIncoming);

  socket.on("call:response",async r=>{
    if(!activeCall||r.callId!==activeCall.callId)return;
    if(!r.accepted){
      toast("Call declined");
      endCall(false);
      return;
    }
    try{
      await makeOffer();
    }catch(e){
      console.error(e);
      toast(e.message);
      endCall(false);
    }
  });

  socket.on("call:signal",async({from,callId,signal})=>{
    if(!activeCall||callId!==activeCall.callId||
      String(from.id)!==String(activeCall.contact.id))return;
    try{
      if(signal.type==="description"){
        if(!pc)await preparePeer();
        await pc.setRemoteDescription(signal.description);
        if(signal.description.type==="offer"){
          const a=await pc.createAnswer();
          await pc.setLocalDescription(a);
          signalTo({type:"description",description:pc.localDescription});
        }
      }else if(signal.type==="candidate"&&pc){
        await pc.addIceCandidate(signal.candidate);
      }
    }catch(e){
      console.error("Call signaling error:",e);
      toast("Call setup failed; try again.");
    }
  });
}

async function pushSetup(){
  if(!("serviceWorker"in navigator)||
     !("PushManager"in window)||!config.vapidPublicKey)return;
  try{
    const reg=await navigator.serviceWorker.register("/sw.js");
    $("notifyBtn").onclick=async()=>{
      try{
        const p=await Notification.requestPermission();
        if(p!=="granted")return toast("Notification permission denied");
        const sub=await reg.pushManager.subscribe({
          userVisibleOnly:true,
          applicationServerKey:b64(config.vapidPublicKey)
        });
        await api("/api/push/subscribe",{
          method:"POST",
          body:JSON.stringify({subscription:sub})
        });
        $("notifyBtn").textContent="Alerts enabled";
        toast("Notifications enabled");
      }catch(e){
        console.error("Push notification error:",e);
        toast("Notifications failed: "+e.message);
      }
    };
    if(Notification.permission==="granted"){
      $("notifyBtn").textContent="Alerts enabled";
    }
  }catch(e){
    console.warn("Service worker error:",e);
  }
}

function b64(s){
  const p="=".repeat((4-s.length%4)%4);
  const raw=atob((s+p).replace(/-/g,"+").replace(/_/g,"/"));
  return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)));
}

$("audioBtn").onclick=()=>startCall("audio");
$("videoBtn").onclick=()=>startCall("video");

async function startCall(mode){
  if(!active)return toast("Select a contact first.");
  if(!socket||!socket.connected)return toast("Realtime connection unavailable.");
  try{
    localStream=await navigator.mediaDevices.getUserMedia({
      audio:true,video:mode==="video"
    });
    activeCall={mode,contact:active,callId:null};
    showCall(mode,active.displayName||active.email,"Calling…");
    socket.emit("call:invite",{to:active.id,mode},r=>{
      if(!r?.ok){
        toast(r?.error||"Call failed");
        endCall(false);
      }else if(activeCall){
        activeCall.callId=r.callId;
      }
    });
  }catch(e){
    console.error("Start call error:",e);
    toast("Allow camera/microphone and use Render HTTPS.");
    endCall(false);
  }
}

function showIncoming(c){
  incoming=c;
  $("callOverlay").hidden=false;
  $("callLabel").textContent="INCOMING "+c.mode.toUpperCase()+" CALL";
  $("callName").textContent=c.from.displayName||c.from.email;
  $("callAvatar").textContent=(c.from.displayName||c.from.email)[0].toUpperCase();
  $("callStatus").textContent="Answer or decline";
  $("answerBtn").hidden=false;
  $("muteBtn").hidden=true;
  $("cameraBtn").hidden=true;
  $("endCallBtn").textContent="Decline";
  $("endCallBtn").onclick=()=>{
    socket?.emit("call:respond",{
      to:c.from.id,callId:c.callId,accepted:false
    });
    endCall(false);
  };
}

$("answerBtn").onclick=async()=>{
  if(!incoming)return;
  const c=incoming;
  try{
    active=contacts.find(x=>String(x.id)===String(c.from.id))||
      {id:c.from.id,email:c.from.email,displayName:c.from.displayName};
    activeCall={mode:c.mode,contact:active,callId:c.callId};
    localStream=await navigator.mediaDevices.getUserMedia({
      audio:true,video:c.mode==="video"
    });
    showCall(c.mode,c.from.displayName||c.from.email,"Connecting…");
    socket.emit("call:respond",{
      to:c.from.id,callId:c.callId,accepted:true
    });
    await preparePeer();
    incoming=null;
  }catch(e){
    console.error("Answer call error:",e);
    toast("Cannot access microphone/camera");
    endCall(false);
  }
};

function showCall(mode,name,status){
  $("callOverlay").hidden=false;
  $("callLabel").textContent=mode.toUpperCase()+" CALL";
  $("callName").textContent=name;
  $("callStatus").textContent=status;
  $("localVideo").srcObject=localStream;
  $("localVideo").style.display=mode==="video"?"block":"none";
  $("remoteVideo").srcObject=null;
  $("answerBtn").hidden=true;
  $("muteBtn").hidden=false;
  $("cameraBtn").hidden=mode!=="video";
  $("endCallBtn").textContent="End call";
  $("endCallBtn").onclick=()=>endCall(true);
}

async function preparePeer(){
  if(pc)return;
  pc=new RTCPeerConnection(rtc);
  const remote=new MediaStream();
  $("remoteVideo").srcObject=remote;
  pc.ontrack=e=>e.streams[0].getTracks().forEach(t=>remote.addTrack(t));
  pc.onicecandidate=e=>{
    if(e.candidate)signalTo({type:"candidate",candidate:e.candidate});
  };
  pc.onconnectionstatechange=()=>{
    if(pc?.connectionState==="connected"){
      $("callStatus").textContent="Connected";
    }else if(pc&&["failed","disconnected"].includes(pc.connectionState)){
      $("callStatus").textContent="Connection unstable";
    }
  };
  localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
}

async function makeOffer(){
  await preparePeer();
  const o=await pc.createOffer();
  await pc.setLocalDescription(o);
  signalTo({type:"description",description:pc.localDescription});
}

function signalTo(signal){
  if(!socket||!activeCall)return;
  socket.emit("call:signal",{
    to:activeCall.contact.id,
    callId:activeCall.callId,
    signal
  });
}

$("muteBtn").onclick=()=>{
  if(!localStream)return;
  muted=!muted;
  localStream.getAudioTracks().forEach(t=>t.enabled=!muted);
  $("muteBtn").textContent=muted?"Unmute":"Mute";
};

$("cameraBtn").onclick=()=>{
  if(!localStream)return;
  cameraOff=!cameraOff;
  localStream.getVideoTracks().forEach(t=>t.enabled=!cameraOff);
  $("cameraBtn").textContent=cameraOff?"Camera on":"Camera off";
};

function endCall(notify=true){
  if(notify&&activeCall){
    socket?.emit("call:respond",{
      to:activeCall.contact.id,
      callId:activeCall.callId,
      accepted:false
    });
  }
  if(pc){pc.close();pc=null}
  if(localStream){
    localStream.getTracks().forEach(t=>t.stop());
    localStream=null;
  }
  $("localVideo").srcObject=null;
  $("remoteVideo").srcObject=null;
  $("callOverlay").hidden=true;
  $("answerBtn").hidden=true;
  $("muteBtn").hidden=false;
  $("cameraBtn").hidden=false;
  $("endCallBtn").textContent="End call";
  $("endCallBtn").onclick=()=>endCall(true);
  activeCall=null;
  incoming=null;
  muted=cameraOff=false;
  $("muteBtn").textContent="Mute";
  $("cameraBtn").textContent="Camera off";
}

$("logoutBtn").onclick=async()=>{
  try{
    socket?.disconnect();
    await api("/api/logout",{method:"POST"});
    location.href="/";
  }catch(e){
    console.error("Logout error:",e);
    toast(e.message);
  }
};

boot();
})();
