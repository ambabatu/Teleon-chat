const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const multer = require('multer');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 8e6 });
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const STORE_FILE = path.join(DATA_DIR, 'store.json');
if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, JSON.stringify({ users: {}, conversations: {}, messages: {}, groups: {}, bannedUsers: {}, bannedGroups: {}, reports: [] }, null, 2));
let store;
try { store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch { store = { users: {}, conversations: {}, messages: {}, groups: {}, bannedUsers: {}, bannedGroups: {}, reports: [] }; }
store.users ||= {}; store.conversations ||= {}; store.messages ||= {}; store.groups ||= {}; store.bannedUsers ||= {}; store.bannedGroups ||= {}; store.reports ||= [];
let writeQueued = false;
function persist() {
  if (writeQueued) return;
  writeQueued = true;
  setTimeout(() => {
    writeQueued = false;
    const tmp = STORE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, STORE_FILE);
  }, 40);
}
// Seed the reserved Developer account only when it does not exist. Existing accounts keep their current password.
(() => {
  if (!store.users.developer) {
    store.users.developer = {
      username: 'developer',
      passwordHash: bcrypt.hashSync('Aripganteng', 10),
      bio: 'TELEON Developer', avatar: '', role: 'owner', verified: true,
      createdAt: Date.now(), lastSeenAt: Date.now()
    };
    persist();
    console.log('Akun awal Developer dibuat. Ganti password sebelum hosting publik.');
  } else {
    store.users.developer.role = 'owner';
    store.users.developer.verified = true;
    persist();
  }
})();
function safeUser(u) { return { username: u.username, bio: u.bio || '', avatar: u.avatar || '', role: u.role || 'member', verified: !!u.verified, createdAt: u.createdAt, lastSeenAt: u.lastSeenAt || u.createdAt, online: onlineUsers.has(u.username) }; }
function cleanUsername(s) { return String(s || '').trim().replace(/^@/, '').toLowerCase(); }
const sessionMiddleware = session({
  store: new FileStore({ path: path.join(DATA_DIR, 'sessions'), retries: 0, logFn: () => {} }),
  secret: process.env.SESSION_SECRET || 'change-this-secret-before-public-hosting-teleon',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000, secure: process.env.NODE_ENV === 'production' }
});
app.use(sessionMiddleware);
app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(ROOT, 'public')));
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (req, file, cb) => cb(null, /^image\/(png|jpeg|webp|gif)$/.test(file.mimetype)) });
const audioUpload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 8 * 1024 * 1024 }, fileFilter: (req, file, cb) => cb(null, /^audio\/(webm|ogg|mp4|mpeg|wav|x-m4a)/.test(file.mimetype) || file.mimetype === 'application/octet-stream') });
const onlineUsers = new Set();
function requireAuth(req, res, next) {
  const key = req.session && req.session.username;
  if (!key || !store.users[key]) return res.status(401).json({ error: 'Silakan login lagi.' });
  if (store.bannedUsers[key] && store.users[key].role !== 'owner') { req.session.destroy(() => {}); return res.status(403).json({ error: 'Akun ini diblokir oleh Developer.' }); }
  req.user = store.users[key]; next();
}
function activeGroup(id) { const c=store.conversations[id], g=store.groups[id]; return c && g && c.type==='group' && !store.bannedGroups[id] ? {c,g} : null; }
function conversationId(a, b) { return [a, b].sort().join('::'); }
function touchConversation(a, b) {
  const id = conversationId(a, b);
  if (!store.conversations[id]) store.conversations[id] = { id, type: 'direct', members: [a, b], createdAt: Date.now(), updatedAt: Date.now() };
  if (!store.messages[id]) store.messages[id] = [];
  persist(); return store.conversations[id];
}
function chatSummary(c, username) {
  const msgs = store.messages[c.id] || []; const last = msgs[msgs.length - 1] || null;
  if (c.type === 'group') { const g = store.groups[c.id] || {}; return { id:c.id, type:'group', group:{ id:c.id, name:g.name || 'Grup', bio:g.bio || '', avatar:g.avatar || '', admins:g.admins || [], members:[...c.members], createdBy:g.createdBy }, user:{ username:g.name || 'Grup', bio:g.bio || '', avatar:g.avatar || '', online:c.members.some(m=>onlineUsers.has(m)) }, lastMessage:last, updatedAt:c.updatedAt }; }
  const otherName = c.members.find(x => x !== username); const other = store.users[otherName];
  return { id:c.id, type:'direct', user:other ? safeUser(other) : { username:otherName }, lastMessage:last, updatedAt:c.updatedAt };
}
app.get('/api/me', (req, res) => {
  const u = req.session.username && store.users[req.session.username];
  res.json({ user: u ? safeUser(u) : null });
});
app.post('/api/register', async (req, res) => {
  const username = cleanUsername(req.body.username);
  const password = String(req.body.password || '');
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Username harus 3–20 karakter: huruf, angka, underscore.' });
  if (password.length < 6 || password.length > 100) return res.status(400).json({ error: 'Password minimal 6 karakter.' });
  if (store.users[username]) return res.status(409).json({ error: 'Username sudah digunakan.' });
  const passwordHash = await bcrypt.hash(password, 10);
  store.users[username] = { username, passwordHash, bio: '', avatar: '', role: 'member', verified: false, createdAt: Date.now(), lastSeenAt: Date.now() };
  req.session.username = username; store.users[username].lastSeenAt = Date.now(); persist();
  res.json({ user: safeUser(store.users[username]) });
});
app.post('/api/login', async (req, res) => {
  const username = cleanUsername(req.body.username);
  const u = store.users[username];
  if (store.bannedUsers[username]) return res.status(403).json({ error: 'Akun ini diblokir oleh Developer.' });
  if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.passwordHash))) return res.status(401).json({ error: 'Username atau password salah.' });
  req.session.username = username; u.lastSeenAt = Date.now(); persist();
  res.json({ user: safeUser(u) });
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/users/search', requireAuth, (req, res) => {
  const q = cleanUsername(req.query.q || '');
  if (q.length < 2) return res.json({ users: [] });
  const users = Object.values(store.users).filter(u => u.username !== req.user.username && u.username.includes(q) && !store.bannedUsers[u.username]).slice(0, 25).map(safeUser);
  res.json({ users });
});
function requireOwner(req, res, next) {
  if (!req.user || req.user.role !== 'owner') return res.status(403).json({ error: 'Khusus Owner.' });
  next();
}
function requireDeveloper(req,res,next) { if(!req.user || req.user.username!=='developer') return res.status(403).json({error:'Fitur ban hanya dapat digunakan akun Developer.'}); next(); }
app.get('/api/admin/users', requireAuth, requireOwner, (req, res) => {
  const users = Object.values(store.users).map(u => ({
    username: u.username,
    role: u.role || 'member',
    verified: !!u.verified,
    createdAt: u.createdAt,
    lastSeenAt: u.lastSeenAt || u.createdAt,
    online: onlineUsers.has(u.username),
    banned: !!store.bannedUsers[u.username]
  })).sort((a, b) => (a.username === 'developer' ? -1 : b.username === 'developer' ? 1 : a.username.localeCompare(b.username)));
  res.json({ users, total: users.length, online: users.filter(u => u.online).length });
});
app.patch('/api/admin/users/:username/access', requireAuth, requireOwner, (req, res) => {
  const targetName = cleanUsername(req.params.username);
  const target = store.users[targetName];
  if (!target) return res.status(404).json({ error: 'Akun tidak ditemukan.' });
  if (targetName === req.user.username && req.body.role === 'member') return res.status(400).json({ error: 'Kamu tidak bisa mencabut role Owner milik sendiri.' });
  if (targetName === 'developer') {
    target.role = 'owner'; target.verified = true; persist();
    return res.json({ user: safeUser(target), notice: 'Akun Developer utama selalu Owner dan terverifikasi.' });
  }
  if (req.body.role !== undefined) {
    if (!['owner', 'member'].includes(req.body.role)) return res.status(400).json({ error: 'Role tidak valid.' });
    target.role = req.body.role;
  }
  if (req.body.verified !== undefined) target.verified = !!req.body.verified;
  persist();
  res.json({ user: safeUser(target) });
});

app.get('/api/chats', requireAuth, (req, res) => {
  const chats = Object.values(store.conversations).filter(c => c.members.includes(req.user.username) && !(c.type==='group' && store.bannedGroups[c.id])).map(c => chatSummary(c, req.user.username)).sort((a, b) => b.updatedAt - a.updatedAt);
  res.json({ chats });
});
app.post('/api/groups', requireAuth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 50);
  const bio = String(req.body.bio || '').trim().slice(0, 160);
  const members = Array.isArray(req.body.members) ? [...new Set(req.body.members.map(cleanUsername).filter(n => store.users[n] && n !== req.user.username))].slice(0, 100) : [];
  if (name.length < 2) return res.status(400).json({ error: 'Nama grup minimal 2 karakter.' });
  const id = 'group_' + require('crypto').randomUUID();
  const allMembers = [req.user.username, ...members];
  store.conversations[id] = { id, type:'group', members:allMembers, createdAt:Date.now(), updatedAt:Date.now() };
  store.groups[id] = { id, name, bio, avatar:'', createdBy:req.user.username, admins:[req.user.username], inviteCode:require('crypto').randomBytes(12).toString('hex'), kicked:[] };
  store.messages[id] = [];
  persist();
  for (const member of allMembers) io.to('user:' + member).emit('chats:refresh');
  res.json({ chat: chatSummary(store.conversations[id], req.user.username) });
});
app.patch('/api/groups/:id', requireAuth, (req, res) => {
  const active = activeGroup(req.params.id); const c=active?.c, g=active?.g;
  if (!c || !c.members.includes(req.user.username)) return res.status(404).json({ error:'Grup tidak ditemukan atau sudah diblokir Developer.' });
  if (!g.admins.includes(req.user.username)) return res.status(403).json({ error:'Hanya admin grup yang dapat mengubah grup.' });
  if (req.body.name !== undefined) { const name=String(req.body.name).trim().slice(0,50); if(name.length<2) return res.status(400).json({error:'Nama grup minimal 2 karakter.'}); g.name=name; }
  if (req.body.bio !== undefined) g.bio=String(req.body.bio).trim().slice(0,160);
  if (Array.isArray(req.body.addMembers)) { for (const n of req.body.addMembers.map(cleanUsername)) if(store.users[n] && !c.members.includes(n) && c.members.length<100) c.members.push(n); }
  if (Array.isArray(req.body.removeMembers)) { for (const n of req.body.removeMembers.map(cleanUsername)) { if(n!==g.createdBy && c.members.includes(n)) { c.members=c.members.filter(m=>m!==n); g.admins=g.admins.filter(a=>a!==n); g.kicked ||= []; if(!g.kicked.includes(n)) g.kicked.push(n); io.to('user:'+n).emit('chats:refresh'); } } }
  if (Array.isArray(req.body.admins)) { if(req.user.username!==g.createdBy) return res.status(403).json({error:'Hanya pemilik grup yang dapat mengatur admin.'}); g.admins=[...new Set([g.createdBy,...req.body.admins.map(cleanUsername).filter(n=>c.members.includes(n))])]; }
  c.updatedAt=Date.now(); persist(); for(const m of c.members) io.to('user:'+m).emit('chats:refresh');
  res.json({ chat:chatSummary(c,req.user.username), members:c.members, admins:g.admins });
});
app.post('/api/groups/:id/avatar', requireAuth, upload.single('photo'), (req, res) => {
  const active=activeGroup(req.params.id); const c=active?.c, g=active?.g;
  if(!c || !c.members.includes(req.user.username)) return res.status(404).json({error:'Grup tidak ditemukan atau sudah diblokir Developer.'});
  if(!g.admins.includes(req.user.username)) return res.status(403).json({error:'Hanya admin grup yang dapat mengganti foto.'});
  if(!req.file) return res.status(400).json({error:'Pilih gambar grup.'});
  const ext=({'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','image/gif':'.gif'})[req.file.mimetype];
  const dest=path.join(UPLOAD_DIR,req.file.filename+ext); fs.renameSync(req.file.path,dest); g.avatar='/uploads/'+path.basename(dest); persist();
  for(const m of c.members) io.to('user:'+m).emit('chats:refresh'); res.json({chat:chatSummary(c,req.user.username)});
});
app.get('/api/groups/:id/invite', requireAuth, (req,res) => {
  const active=activeGroup(req.params.id); if(!active || !active.c.members.includes(req.user.username)) return res.status(404).json({error:'Grup tidak ditemukan.'});
  res.json({code:active.g.inviteCode, link:`${req.protocol}://${req.get('host')}/?join=${encodeURIComponent(active.g.inviteCode)}`});
});
app.post('/api/groups/join', requireAuth, (req,res) => {
  const code=String(req.body.code||'').trim();
  const entry=Object.values(store.groups).find(g=>g.inviteCode===code);
  if(!entry || store.bannedGroups[entry.id]) return res.status(404).json({error:'Link grup tidak valid atau grup sudah diblokir.'});
  const c=store.conversations[entry.id]; if(!c) return res.status(404).json({error:'Grup tidak tersedia.'});
  entry.kicked ||= []; if(entry.kicked.includes(req.user.username)) return res.status(403).json({error:'Kamu dikeluarkan dari grup ini dan tidak bisa bergabung kembali.'});
  if(!c.members.includes(req.user.username)){ if(c.members.length>=100) return res.status(400).json({error:'Grup sudah mencapai 100 anggota.'}); c.members.push(req.user.username); c.updatedAt=Date.now(); persist(); for(const m of c.members) io.to('user:'+m).emit('chats:refresh'); }
  res.json({chat:chatSummary(c,req.user.username)});
});
app.post('/api/groups/:id/report', requireAuth, (req,res) => {
  const active=activeGroup(req.params.id); if(!active || !active.c.members.includes(req.user.username)) return res.status(404).json({error:'Grup tidak ditemukan.'});
  const reason=String(req.body.reason||'').trim().slice(0,300); if(reason.length<3) return res.status(400).json({error:'Isi alasan laporan minimal 3 karakter.'});
  const report={id:require('crypto').randomUUID(), type:'group', groupId:active.g.id, groupName:active.g.name, reporter:req.user.username, reason, createdAt:Date.now(), status:'open'};
  store.reports.unshift(report); store.reports=store.reports.slice(0,500); persist();
  io.to('user:developer').emit('admin:report',report); res.json({ok:true,message:'Laporan dikirim ke Developer.'});
});
app.get('/api/admin/reports', requireAuth, requireDeveloper, (req,res) => res.json({reports:store.reports.filter(r=>r.status==='open')}));
app.post('/api/admin/groups/:id/ban', requireAuth, requireDeveloper, (req,res) => {
  const id=String(req.params.id); const active=activeGroup(id); if(!active) return res.status(404).json({error:'Grup tidak ditemukan atau sudah diblokir.'});
  store.bannedGroups[id]={id,name:active.g.name,createdBy:active.g.createdBy,bannedBy:req.user.username,bannedAt:Date.now(),reason:String(req.body.reason||'Melanggar aturan').slice(0,300)};
  for(const member of active.c.members) io.to('user:'+member).emit('chats:refresh');
  for(const r of store.reports) if(r.groupId===id && r.status==='open') r.status='resolved';
  persist(); res.json({ok:true,message:'Grup diblokir. Anggota harus membuat grup baru.'});
});
app.post('/api/admin/users/:username/ban', requireAuth, requireDeveloper, (req,res) => {
  const name=cleanUsername(req.params.username); if(!store.users[name]) return res.status(404).json({error:'Akun tidak ditemukan.'});
  if(name==='developer' || name===req.user.username) return res.status(400).json({error:'Akun Developer tidak dapat diblokir dari panel ini.'});
  store.bannedUsers[name]={username:name,bannedBy:req.user.username,bannedAt:Date.now(),reason:String(req.body.reason||'Diblokir Developer').slice(0,300)};
  for(const sock of io.sockets.sockets.values()) if(sock.username===name) sock.disconnect(true);
  persist(); res.json({ok:true,message:`@${name} diblokir.`});
});
app.post('/api/admin/users/:username/unban', requireAuth, requireDeveloper, (req,res) => { const name=cleanUsername(req.params.username); if(!store.bannedUsers[name]) return res.status(404).json({error:'Akun tidak sedang diblokir.'}); delete store.bannedUsers[name]; persist(); res.json({ok:true,message:`Blokir @${name} dicabut.`}); });
app.post('/api/voice-note', requireAuth, audioUpload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error:'Rekaman suara tidak diterima.' });
  const ext = ({'audio/webm':'.webm','audio/ogg':'.ogg','audio/mp4':'.m4a','audio/mpeg':'.mp3','audio/wav':'.wav','audio/x-m4a':'.m4a'})[req.file.mimetype] || '.webm';
  const dest=path.join(UPLOAD_DIR,req.file.filename+ext); fs.renameSync(req.file.path,dest); res.json({ audio:'/uploads/'+path.basename(dest) });
});
app.post('/api/chats', requireAuth, (req, res) => {
  const target = cleanUsername(req.body.username);
  if (!store.users[target]) return res.status(404).json({ error: 'Username tidak ditemukan.' });
  if (target === req.user.username) return res.status(400).json({ error: 'Tidak bisa membuat chat dengan akun sendiri.' });
  const c = touchConversation(req.user.username, target);
  io.to('user:' + target).emit('chats:refresh');
  res.json({ chat: { id: c.id, user: safeUser(store.users[target]) } });
});
app.get('/api/chats/:id/messages', requireAuth, (req, res) => {
  const c = store.conversations[req.params.id];
  if (!c || !c.members.includes(req.user.username)) return res.status(404).json({ error: 'Chat tidak ditemukan.' });
  res.json({ messages: store.messages[c.id] || [] });
});
app.post('/api/profile', requireAuth, (req, res) => {
  const bio = String(req.body.bio || '').slice(0, 160);
  req.user.bio = bio; persist(); res.json({ user: safeUser(req.user) });
});
app.post('/api/avatar', requireAuth, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Pilih file gambar JPG, PNG, WEBP, atau GIF.' });
  const ext = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' })[req.file.mimetype];
  const dest = path.join(UPLOAD_DIR, req.file.filename + ext);
  fs.renameSync(req.file.path, dest);
  req.user.avatar = '/uploads/' + path.basename(dest); persist(); res.json({ user: safeUser(req.user) });
});
app.post('/api/chat-photo', requireAuth, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Pilih file gambar JPG, PNG, WEBP, atau GIF.' });
  const ext = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' })[req.file.mimetype];
  const dest = path.join(UPLOAD_DIR, req.file.filename + ext);
  fs.renameSync(req.file.path, dest);
  res.json({ photo: '/uploads/' + path.basename(dest) });
});

io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  const username = socket.request.session && socket.request.session.username;
  if (!username || !store.users[username]) return next(new Error('unauthorized'));
  if (store.bannedUsers[username] && store.users[username].role !== 'owner') return next(new Error('banned'));
  socket.username = username; next();
});
io.on('connection', socket => {
  const username = socket.username;
  onlineUsers.add(username); store.users[username].lastSeenAt=Date.now(); persist(); io.emit('presence', { username, online: true });
  socket.join('user:' + username);
  socket.on('chat:join', id => {
    const c = store.conversations[id];
    if (c && c.members.includes(username) && !(c.type==='group' && store.bannedGroups[c.id])) socket.join('chat:' + id);
  });
  socket.on('call:signal', data => {
    const target = cleanUsername(data && data.to);
    if (!target || !store.users[target] || target === username) return;
    const callType = ['offer','answer','ice','hangup','reject'].includes(data.type) ? data.type : null;
    if (!callType) return;
    io.to('user:' + target).emit('call:signal', { from: username, type: callType, payload: data.payload || null });
  });
  socket.on('typing', data => {
    const c = store.conversations[data && data.chatId];
    if (!c || !c.members.includes(username) || (c.type==='group' && store.bannedGroups[c.id])) return;
    socket.to('chat:' + c.id).emit('typing', { chatId: c.id, username, typing: !!data.typing });
  });
  socket.on('message:send', data => {
    const c = store.conversations[data && data.chatId];
    if (!c || !c.members.includes(username) || (c.type==='group' && store.bannedGroups[c.id])) return;
    const text = String(data.text || '').trim().slice(0, 4000);
    const photo = typeof data.photo === 'string' && /^\/uploads\/[a-zA-Z0-9_-]+\.(jpg|png|webp|gif)$/.test(data.photo) ? data.photo : '';
    const audio = typeof data.audio === 'string' && /^\/uploads\/[a-zA-Z0-9_-]+\.(webm|ogg|m4a|mp3|wav)$/.test(data.audio) ? data.audio : '';
    if (!text && !photo && !audio) return;
    const message = { id: require('crypto').randomUUID(), chatId: c.id, sender: username, text, photo, audio, createdAt: Date.now() };
    store.messages[c.id] ||= []; store.messages[c.id].push(message); c.updatedAt = Date.now(); persist();
    io.to('chat:' + c.id).emit('message:new', message);
    for (const member of c.members) io.to('user:' + member).emit('chats:refresh');
  });
  socket.on('disconnect', () => {
    const stillConnected = [...io.sockets.sockets.values()].some(s => s.username === username);
    if (!stillConnected) { onlineUsers.delete(username); io.emit('presence', { username, online: false }); }
  });
});
app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
server.listen(PORT, '0.0.0.0', () => console.log(`TELEON berjalan di http://0.0.0.0:${PORT}`));
