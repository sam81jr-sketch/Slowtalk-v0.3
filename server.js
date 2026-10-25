require("dotenv").config();
const express=require("express"), http=require("http"), path=require("path"), crypto=require("crypto");
const session=require("express-session"), pg=require("pg"), {OAuth2Client}=require("google-auth-library");
const {Server}=require("socket.io"), webpush=require("web-push");
const app=express(), server=http.createServer(app), io=new Server(server), Pool=pg.Pool;
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL?.includes("localhost")?false:{rejectUnauthorized:false}});
const OAuth=new OAuth2Client(process.env.GOOGLE_CLIENT_ID), PORT=process.env.PORT||3000, prod=process.env.NODE_ENV==="production";
app.set("trust proxy",1); app.use(express.json({limit:"100kb"}));
const sessionMw=session({store:process.env.DATABASE_URL?new (require("connect-pg-simple")(session))({pool,createTableIfMissing:true,tableName:"user_sessions"}):undefined,secret:process.env.SESSION_SECRET||"dev-only-change-me",resave:false,saveUninitialized:false,cookie:{httpOnly:true,secure:prod,sameSite:"lax",maxAge:1209600000}});
app.use(sessionMw); app.use(express.static(path.join(__dirname,"public")));
if(process.env.VAPID_PUBLIC_KEY&&process.env.VAPID_PRIVATE_KEY) webpush.setVapidDetails(process.env.VAPID_SUBJECT||"mailto:admin@example.com",process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);
async function init(){
await pool.query(`
CREATE TABLE IF NOT EXISTS users(id BIGSERIAL PRIMARY KEY,google_sub TEXT UNIQUE NOT NULL,email TEXT UNIQUE NOT NULL,display_name TEXT NOT NULL,picture_url TEXT,created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS contacts(owner_id BIGINT REFERENCES users(id) ON DELETE CASCADE,contact_id BIGINT REFERENCES users(id) ON DELETE CASCADE,created_at TIMESTAMPTZ DEFAULT NOW(),PRIMARY KEY(owner_id,contact_id),CHECK(owner_id<>contact_id));
CREATE TABLE IF NOT EXISTS conversations(id BIGSERIAL PRIMARY KEY,user_a BIGINT REFERENCES users(id) ON DELETE CASCADE,user_b BIGINT REFERENCES users(id) ON DELETE CASCADE,created_at TIMESTAMPTZ DEFAULT NOW(),UNIQUE(user_a,user_b),CHECK(user_a<user_b));
CREATE TABLE IF NOT EXISTS messages(id BIGSERIAL PRIMARY KEY,conversation_id BIGINT REFERENCES conversations(id) ON DELETE CASCADE,sender_id BIGINT REFERENCES users(id) ON DELETE CASCADE,body TEXT NOT NULL CHECK(char_length(body)<=4000),created_at TIMESTAMPTZ DEFAULT NOW());
CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages(conversation_id,id);
CREATE TABLE IF NOT EXISTS push_subscriptions(id BIGSERIAL PRIMARY KEY,user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,subscription JSONB NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW(),UNIQUE(user_id,subscription));`);
}
const auth=(req,res,next)=>req.session.user?next():res.status(401).json({error:"Sign in with Google first."});
const me=req=>req.session.user;
app.get("/api/config",(_,res)=>res.json({googleClientId:process.env.GOOGLE_CLIENT_ID||"",vapidPublicKey:process.env.VAPID_PUBLIC_KEY||""}));
app.get("/api/me",(req,res)=>res.json({user:req.session.user||null}));
app.post("/api/auth/google",async(req,res)=>{try{
const ticket=await OAuth.verifyIdToken({idToken:String(req.body.credential||""),audience:process.env.GOOGLE_CLIENT_ID}),p=ticket.getPayload();
if(!p?.sub||!p.email||p.email_verified!==true)return res.status(401).json({error:"Use a verified Google account."});
const q=await pool.query(`INSERT INTO users(google_sub,email,display_name,picture_url) VALUES($1,$2,$3,$4) ON CONFLICT(google_sub) DO UPDATE SET email=EXCLUDED.email,display_name=EXCLUDED.display_name,picture_url=EXCLUDED.picture_url RETURNING id,email,display_name AS "displayName",picture_url AS "pictureUrl"`,[p.sub,p.email.toLowerCase(),p.name||p.email,p.picture||null]);
req.session.user=q.rows[0];req.session.save(e=>e?res.status(500).json({error:"Session save failed"}):res.json({user:req.session.user}));
}catch(e){console.error("OAuth:",e.message);res.status(401).json({error:"Google login failed. Check OAuth settings."});}});
app.post("/api/logout",(req,res)=>req.session.destroy(()=>{res.clearCookie("connect.sid");res.json({ok:true});}));
app.get("/api/contacts",auth,async(req,res)=>{const q=await pool.query(`SELECT u.id,u.email,u.display_name AS "displayName",u.picture_url AS "pictureUrl" FROM contacts c JOIN users u ON u.id=c.contact_id WHERE c.owner_id=$1 ORDER BY u.display_name`,[me(req).id]);res.json({contacts:q.rows});});
app.post("/api/contacts",auth,async(req,res)=>{const email=String(req.body.email||"").trim().toLowerCase();if(!/^[^\\s@]+@gmail\\.com$/.test(email))return res.status(400).json({error:"Enter a Gmail address."});
const q=await pool.query('SELECT id,email,display_name AS "displayName",picture_url AS "pictureUrl" FROM users WHERE lower(email)=$1',[email]);if(!q.rowCount)return res.status(404).json({error:"This Gmail user must sign in to SlowTalk first."});
const c=q.rows[0];if(String(c.id)===String(me(req).id))return res.status(400).json({error:"You cannot add yourself."});
await pool.query("INSERT INTO contacts(owner_id,contact_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[me(req).id,c.id]);res.json({contact:c});});
async function conversation(a,b){a=String(a);b=String(b);const low=BigInt(a)<BigInt(b)?a:b,high=BigInt(a)<BigInt(b)?b:a;const q=await pool.query("INSERT INTO conversations(user_a,user_b) VALUES($1,$2) ON CONFLICT(user_a,user_b) DO UPDATE SET user_a=EXCLUDED.user_a RETURNING id,user_a AS a,user_b AS b",[low,high]);return q.rows[0];}
app.get("/api/conversations/:id/messages",auth,async(req,res)=>{const other=String(req.params.id),uid=String(me(req).id);const c=await pool.query("SELECT 1 FROM contacts WHERE owner_id=$1 AND contact_id=$2 UNION SELECT 1 FROM contacts WHERE owner_id=$2 AND contact_id=$1",[uid,other]);if(!c.rowCount)return res.status(403).json({error:"Not a saved contact."});const low=BigInt(uid)<BigInt(other)?uid:other,high=BigInt(uid)<BigInt(other)?other:uid;const cv=await pool.query("SELECT id FROM conversations WHERE user_a=$1 AND user_b=$2",[low,high]);if(!cv.rowCount)return res.json({messages:[]});const q=await pool.query('SELECT id,sender_id AS "senderId",body,created_at AS "createdAt" FROM messages WHERE conversation_id=$1 ORDER BY id DESC LIMIT 100',[cv.rows[0].id]);res.json({messages:q.rows.reverse()});});
app.post("/api/push/subscribe",auth,async(req,res)=>{const s=req.body.subscription;if(!s?.endpoint||!s?.keys)return res.status(400).json({error:"Invalid subscription"});await pool.query("INSERT INTO push_subscriptions(user_id,subscription) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING",[me(req).id,JSON.stringify(s)]);res.json({ok:true});});
async function push(userId,payload){if(!process.env.VAPID_PUBLIC_KEY||!process.env.VAPID_PRIVATE_KEY)return;const q=await pool.query("SELECT id,subscription FROM push_subscriptions WHERE user_id=$1",[userId]);for(const r of q.rows){try{await webpush.sendNotification(r.subscription,JSON.stringify(payload));}catch(e){if([404,410].includes(e.statusCode))await pool.query("DELETE FROM push_subscriptions WHERE id=$1",[r.id]);}}}
io.use((socket,next)=>sessionMw(socket.request,{},next));
io.use((socket,next)=>socket.request.session?.user?(socket.data.user=socket.request.session.user,next()):next(new Error("Authentication required")));
io.on("connection",socket=>{
const user=socket.data.user,uid=String(user.id);socket.join("user:"+uid);
socket.on("chat:send",async({to,body}={},ack=()=>{})=>{try{const text=String(body||"").trim().slice(0,4000),recipient=String(to||"");if(!text||!/^[0-9]+$/.test(recipient)||recipient===uid)return ack({ok:false,error:"Invalid message or recipient."});
const c=await pool.query("SELECT 1 FROM contacts WHERE (owner_id=$1 AND contact_id=$2) OR (owner_id=$2 AND contact_id=$1)",[uid,recipient]);if(!c.rowCount)return ack({ok:false,error:"Save each other as contacts first."});
const cv=await conversation(uid,recipient),q=await pool.query('INSERT INTO messages(conversation_id,sender_id,body) VALUES($1,$2,$3) RETURNING id,sender_id AS "senderId",body,created_at AS "createdAt"', [cv.id,uid,text]);
const msg={...q.rows[0],senderName:user.displayName,senderEmail:user.email};io.to("user:"+recipient).emit("chat:new",msg);socket.emit("chat:new",msg);await push(recipient,{type:"message",title:user.displayName,body:text.slice(0,120),url:"/?contact="+uid});ack({ok:true});}catch(e){console.error(e);ack({ok:false,error:"Could not send message."});}});
socket.on("call:invite",async({to,mode}={},ack=()=>{})=>{const recipient=String(to||"");if(!/^[0-9]+$/.test(recipient)||!["audio","video"].includes(mode))return ack({ok:false,error:"Invalid call."});const c=await pool.query("SELECT 1 FROM contacts WHERE (owner_id=$1 AND contact_id=$2) OR (owner_id=$2 AND contact_id=$1)",[uid,recipient]);if(!c.rowCount)return ack({ok:false,error:"Save each other as contacts first."});const callId=crypto.randomUUID(),event={callId,from:user,mode};io.to("user:"+recipient).emit("call:incoming",event);await push(recipient,{type:"call",title:"Incoming "+mode+" call",body:user.displayName+" is calling you",url:"/?call="+callId+"&from="+uid+"&mode="+mode,tag:"call-"+callId,requireInteraction:true});ack({ok:true,callId});});
socket.on("call:respond",({to,callId,accepted}={})=>{if(to)io.to("user:"+String(to)).emit("call:response",{callId,from:user,accepted:!!accepted});});
socket.on("call:signal",({to,callId,signal}={})=>{if(to&&signal)io.to("user:"+String(to)).emit("call:signal",{from:user,callId,signal});});
});
app.get("*",(req,res,next)=>req.path.startsWith("/api/")?next():res.sendFile(path.join(__dirname,"public/index.html")));
init().then(()=>server.listen(PORT,"0.0.0.0",()=>console.log("SlowTalk v0.2 on port "+PORT))).catch(e=>{console.error(e);process.exit(1);});
