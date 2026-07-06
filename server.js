const express = require('express');
const session = require('express-session');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');
const { db, hashPass } = require('./db');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'psg_planner_secret_2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

const WC_SEQUENCE = ['CT','GR','PE','BV','HL','PR','TG','BG','LG','FR','DG'];
const WC_NAMES = {
  CT:'Cutting', GR:'Grinding', PE:'Polish Edge', BV:'Beveling',
  HL:'Hole/Drilling', PR:'Printing', TG:'Tempering', BG:'Bending',
  LG:'Lamination', FR:'Frosting', DG:'Double Glazing', QC:'Quality Control'
};

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}
function sqft(o) {
  return ((o.height_mm||0)/304.8) * ((o.width_mm||0)/304.8) * (o.order_qty||0);
}
function sqftPerPiece(o) {
  return ((o.height_mm||0)/304.8) * ((o.width_mm||0)/304.8);
}
function wcLoad(activeOrders, wc) {
  // Load = balance qty (received - done) x sqft/piece at this WC
  const progress = db.prepare(
    'SELECT order_id, received_qty, done_qty FROM wc_progress WHERE work_center=? AND received_qty > done_qty'
  ).all(wc);
  return progress.reduce((sum, p) => {
    const o = activeOrders.find(a => a.id === p.order_id);
    if (!o || !o[wc.toLowerCase()]) return sum;
    const balance = p.received_qty - p.done_qty;
    return sum + sqftPerPiece(o) * balance;
  }, 0);
}
function todayStr() { return new Date().toISOString().split('T')[0]; }
function isLate(d) {
  if (!d) return false;
  const today = new Date(); today.setHours(0,0,0,0);
  return new Date(d) < today;
}
function getOrderWCs(order) {
  return WC_SEQUENCE.filter(wc => order[wc.toLowerCase()]);
}
function getNextWC(order, currentWC) {
  const wcs = getOrderWCs(order);
  const idx = wcs.indexOf(currentWC);
  if (idx === -1 || idx >= wcs.length - 1) return null;
  return wcs[idx + 1];
}
function initOrderFlow(order) {
  const wcs = getOrderWCs(order);
  if (!wcs.length) return;
  db.prepare(`
    INSERT INTO wc_progress (order_id,work_center,received_qty,done_qty,started_at,updated_at)
    VALUES (?,?,?,0,datetime('now'),datetime('now'))
    ON CONFLICT(order_id,work_center) DO UPDATE SET
      received_qty=MAX(received_qty,excluded.received_qty)
  `).run(order.id, wcs[0], order.order_qty);
}

// ── Debug ─────────────────────────────────────────────────────────────────────
app.get('/api/debug/capacity', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT order_id, work_center, received_qty, done_qty, (received_qty-done_qty) as balance FROM wc_progress ORDER BY order_id, work_center').all();
  res.json({ version:'v2-balance-fix', rows });
});

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!user || user.password_hash !== hashPass(password))
    return res.status(401).json({ error: 'Invalid username or password' });
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  res.json({ success: true, role: user.role, username: user.username });
});
app.post('/api/auth/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ id: req.session.userId, username: req.session.username, role: req.session.role });
});

// ── Users ─────────────────────────────────────────────────────────────────────
app.get('/api/users', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id,username,role,created_at FROM users ORDER BY id').all());
});
app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const r = db.prepare('INSERT INTO users (username,password_hash,role) VALUES (?,?,?)').run(username, hashPass(password), role||'team');
    res.json({ id: r.lastInsertRowid, username, role: role||'team' });
  } catch(e) { res.status(400).json({ error: 'Username already exists' }); }
});
app.put('/api/users/:id/password', requireAdmin, (req, res) => {
  const pwd = (req.body.password||'').trim();
  if (!pwd) return res.status(400).json({ error: 'Password cannot be empty' });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPass(pwd), req.params.id);
  res.json({ success: true });
});
app.delete('/api/users/:id', requireAdmin, (req, res) => {
  if (parseInt(req.params.id) === req.session.userId) return res.status(400).json({ error: 'Cannot delete yourself' });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get('/api/dashboard', requireAuth, (req, res) => {
  const orders = db.prepare("SELECT * FROM orders WHERE status NOT IN ('Cancelled')").all();
  let onTime=0, late=0, inProgress=0, ready=0, onHold=0, qcPassed=0;
  for (const o of orders) {
    if (o.status==='On Hold'){onHold++;continue;}
    if (o.status==='QC Passed'){qcPassed++;continue;}
    if (isLate(o.delivery_date)) late++; else onTime++;
    const wcs = getOrderWCs(o);
    const lastWC = wcs[wcs.length-1];
    if (!lastWC){inProgress++;continue;}
    const prog = db.prepare('SELECT done_qty FROM wc_progress WHERE order_id=? AND work_center=?').get(o.id, lastWC);
    if (prog && prog.done_qty >= o.order_qty) ready++; else inProgress++;
  }
  const total = orders.filter(o=>!['Cancelled'].includes(o.status)).length;
  const otdPct = (onTime+late)>0 ? Math.round(onTime/(onTime+late)*1000)/10 : 100;
  const caps = db.prepare('SELECT * FROM capacity').all();
  const active = orders.filter(o=>o.status==='Active');
  // Auto-repair: ensure every active order has its first WC initialized
  for (const o of active) {
    const existing = db.prepare('SELECT COUNT(*) as cnt FROM wc_progress WHERE order_id=? AND received_qty>0').get(o.id);
    if (!existing || existing.cnt === 0) initOrderFlow(o);
  }
  const utilization = {};
  for (const wc of WC_SEQUENCE) {
    const cap = caps.find(c=>c.work_center===wc);
    const load = wcLoad(active, wc);
    utilization[wc] = { name:WC_NAMES[wc], load:Math.round(load*10)/10, capacity_sqft:cap?cap.capacity_sqft:0, pct:cap&&cap.capacity_sqft>0?Math.round(load/cap.capacity_sqft*1000)/10:0 };
  }
  const deptLate = {};
  for (const o of active.filter(o=>isLate(o.delivery_date))) {
    for (const wc of getOrderWCs(o)) {
      const prog = db.prepare('SELECT done_qty FROM wc_progress WHERE order_id=? AND work_center=?').get(o.id, wc);
      if (!prog || prog.done_qty < o.order_qty) { deptLate[wc]=(deptLate[wc]||0)+1; break; }
    }
  }
  res.json({ total, onTime, late, inProgress, ready, onHold, qcPassed, otdPct, utilization, deptLate, today:todayStr() });
});

// ── Orders ────────────────────────────────────────────────────────────────────
app.get('/api/orders', requireAuth, (req, res) => {
  const { status, search } = req.query;
  let q='SELECT * FROM orders WHERE 1=1'; const p=[];
  if (status){q+=' AND status=?';p.push(status);}
  if (search){q+=' AND (order_number LIKE ? OR client_name LIKE ?)';p.push(`%${search}%`,`%${search}%`);}
  q+=' ORDER BY delivery_date ASC';
  res.json(db.prepare(q).all(...p));
});
app.get('/api/orders/:id', requireAuth, (req, res) => {
  const o=db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if(!o) return res.status(404).json({error:'Not found'});
  res.json(o);
});
app.get('/api/orders/:id/progress', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM wc_progress WHERE order_id=?').all(req.params.id));
});
app.post('/api/orders', requireAdmin, (req, res) => {
  const o=req.body;
  const num=(o.order_number||'').trim();
  if(!num) return res.status(400).json({error:'Order number required'});
  const parent=num.includes('/')?num.split('/')[0]:null;
  try {
    const r=db.prepare(`INSERT INTO orders
      (order_number,parent_order,height_mm,width_mm,order_date,delivery_date,order_type,client_name,
       ct,gr,pe,bv,hl,pr,tg,bg,lg,fr,dg,qc,order_qty,status,notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(num,parent,o.height_mm||0,o.width_mm||0,o.order_date||null,o.delivery_date||null,
      o.order_type||'Architectural',o.client_name||'',
      o.ct?1:0,o.gr?1:0,o.pe?1:0,o.bv?1:0,o.hl?1:0,o.pr?1:0,
      o.tg?1:0,o.bg?1:0,o.lg?1:0,o.fr?1:0,o.dg?1:0,0,
      o.order_qty||0,o.status||'Active',o.notes||'');
    const newOrder=db.prepare('SELECT * FROM orders WHERE id=?').get(r.lastInsertRowid);
    initOrderFlow(newOrder);
    res.json({id:r.lastInsertRowid});
  } catch(e){res.status(400).json({error:'Order number already exists'});}
});
app.put('/api/orders/:id', requireAdmin, (req, res) => {
  const o=req.body;
  const num=(o.order_number||'').trim();
  const parent=num.includes('/')?num.split('/')[0]:null;
  db.prepare(`UPDATE orders SET
    order_number=?,parent_order=?,height_mm=?,width_mm=?,order_date=?,delivery_date=?,
    order_type=?,client_name=?,ct=?,gr=?,pe=?,bv=?,hl=?,pr=?,tg=?,bg=?,lg=?,fr=?,dg=?,qc=0,
    order_qty=?,status=?,notes=?,updated_at=datetime('now') WHERE id=?`
  ).run(num,parent,o.height_mm||0,o.width_mm||0,o.order_date||null,o.delivery_date||null,
    o.order_type||'Architectural',o.client_name||'',
    o.ct?1:0,o.gr?1:0,o.pe?1:0,o.bv?1:0,o.hl?1:0,o.pr?1:0,
    o.tg?1:0,o.bg?1:0,o.lg?1:0,o.fr?1:0,o.dg?1:0,
    o.order_qty||0,o.status||'Active',o.notes||'',req.params.id);
  res.json({success:true});
});
app.delete('/api/orders/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM wc_progress WHERE order_id=?').run(req.params.id);
  db.prepare('DELETE FROM ncr WHERE order_id=?').run(req.params.id);
  db.prepare('DELETE FROM orders WHERE id=?').run(req.params.id);
  res.json({success:true});
});

// ── Work Centers ──────────────────────────────────────────────────────────────
app.get('/api/workcenter/:wc', requireAuth, (req, res) => {
  const wc=req.params.wc.toUpperCase();
  const col=wc.toLowerCase();
  if (!WC_SEQUENCE.includes(wc)) return res.status(400).json({error:'Unknown work center'});
  const orders=db.prepare(`
    SELECT o.*, p.received_qty, p.done_qty, p.completed_at,
      (SELECT COUNT(*) FROM ncr WHERE order_id=o.id AND work_center=?) as ncr_count
    FROM orders o
    LEFT JOIN wc_progress p ON p.order_id=o.id AND p.work_center=?
    WHERE o.${col}=1 AND o.status NOT IN ('Cancelled')
    ORDER BY o.delivery_date ASC`).all(wc,wc);
  res.json(orders.map(o=>({...o, received_qty:o.received_qty||0, done_qty:o.done_qty||0, delivery_status:isLate(o.delivery_date)?'Late':'On Time'})));
});

app.post('/api/workcenter/:wc/process', requireAuth, (req, res) => {
  const wc=req.params.wc.toUpperCase();
  const {order_id, done_qty}=req.body;
  const order=db.prepare('SELECT * FROM orders WHERE id=?').get(order_id);
  if(!order) return res.status(404).json({error:'Order not found'});
  const prog=db.prepare('SELECT * FROM wc_progress WHERE order_id=? AND work_center=?').get(order_id,wc);
  const prevDone=prog?prog.done_qty:0;
  const received=prog?prog.received_qty:0;
  if(received===0) return res.status(400).json({error:'No qty received at this WC yet'});
  const newDone=Math.min(Math.max(done_qty,0),received);
  const delta=newDone-prevDone;
  const isComplete=newDone>=received;
  db.prepare(`
    INSERT INTO wc_progress (order_id,work_center,received_qty,done_qty,started_at,completed_at,updated_by,updated_at)
    VALUES (?,?,?,?,datetime('now'),?,?,datetime('now'))
    ON CONFLICT(order_id,work_center) DO UPDATE SET
      done_qty=excluded.done_qty, completed_at=excluded.completed_at,
      updated_by=excluded.updated_by, updated_at=excluded.updated_at`
  ).run(order_id,wc,received,newDone,isComplete?new Date().toISOString():null,req.session.username||'system');
  if(delta>0){
    const nextWC=getNextWC(order,wc);
    if(nextWC){
      db.prepare(`
        INSERT INTO wc_progress (order_id,work_center,received_qty,done_qty,started_at,updated_at)
        VALUES (?,?,?,0,datetime('now'),datetime('now'))
        ON CONFLICT(order_id,work_center) DO UPDATE SET
          received_qty=received_qty+?, started_at=COALESCE(started_at,excluded.started_at), updated_at=excluded.updated_at`
      ).run(order_id,nextWC,delta,delta);
    }
  }
  res.json({success:true,completed:isComplete&&!getNextWC(order,wc),delta});
});

// ── NCR ───────────────────────────────────────────────────────────────────────
app.post('/api/ncr', requireAuth, (req, res) => {
  const {order_id,work_center,qty_rejected,type,reason}=req.body;
  if(!order_id||!work_center||!qty_rejected||!type) return res.status(400).json({error:'Missing fields'});
  const order=db.prepare('SELECT * FROM orders WHERE id=?').get(order_id);
  if(!order) return res.status(404).json({error:'Order not found'});
  const wcs=getOrderWCs(order);
  db.prepare('INSERT INTO ncr (order_id,work_center,qty_rejected,type,reason,created_by) VALUES (?,?,?,?,?,?)').run(order_id,work_center,qty_rejected,type,reason||'',req.session.username||'system');
  if(type==='Rework'){
    db.prepare(`UPDATE wc_progress SET received_qty=received_qty+?, completed_at=NULL, updated_at=datetime('now') WHERE order_id=? AND work_center=?`).run(qty_rejected,order_id,work_center);
  } else {
    const firstWC=wcs[0]||'CT';
    db.prepare(`
      INSERT INTO wc_progress (order_id,work_center,received_qty,done_qty,started_at,updated_at)
      VALUES (?,?,?,0,datetime('now'),datetime('now'))
      ON CONFLICT(order_id,work_center) DO UPDATE SET received_qty=received_qty+?, completed_at=NULL, updated_at=datetime('now')`
    ).run(order_id,firstWC,qty_rejected,qty_rejected);
  }
  res.json({success:true});
});
app.get('/api/ncr', requireAuth, (req, res) => {
  res.json(db.prepare(`SELECT n.*,o.order_number,o.client_name,o.delivery_date,u.username
    FROM ncr n JOIN orders o ON o.id=n.order_id
    LEFT JOIN users u ON u.username=n.created_by
    ORDER BY n.created_at DESC`).all());
});

// ── Capacity ──────────────────────────────────────────────────────────────────
app.get('/api/capacity', requireAuth, (req, res) => {
  const caps=db.prepare('SELECT * FROM capacity ORDER BY work_center').all();
  const orders=db.prepare("SELECT * FROM orders WHERE status='Active'").all();
  for (const o of orders) {
    const existing = db.prepare('SELECT COUNT(*) as cnt FROM wc_progress WHERE order_id=? AND received_qty>0').get(o.id);
    if (!existing || existing.cnt === 0) initOrderFlow(o);
  }
  res.json(caps.map(c=>{
    const load = wcLoad(orders, c.work_center);
    return {...c,name:WC_NAMES[c.work_center]||c.work_center,load:Math.round(load*10)/10,pct:c.capacity_sqft>0?Math.round(load/c.capacity_sqft*1000)/10:0};
  }));
});
app.put('/api/capacity/:wc', requireAdmin, (req, res) => {
  db.prepare('UPDATE capacity SET capacity_sqft=? WHERE work_center=?').run(req.body.capacity_sqft||0,req.params.wc.toUpperCase());
  res.json({success:true});
});

// ── Holidays ──────────────────────────────────────────────────────────────────
app.get('/api/holidays', requireAuth, (req,res)=>res.json(db.prepare('SELECT * FROM holidays ORDER BY holiday_date').all()));
app.post('/api/holidays', requireAdmin, (req,res)=>{
  db.prepare('INSERT OR REPLACE INTO holidays (holiday_date,name) VALUES (?,?)').run(req.body.holiday_date,req.body.name);
  res.json({success:true});
});
app.delete('/api/holidays/:id', requireAdmin, (req,res)=>{
  db.prepare('DELETE FROM holidays WHERE id=?').run(req.params.id);
  res.json({success:true});
});

// ── Excel Import ──────────────────────────────────────────────────────────────
app.post('/api/import', requireAdmin, upload.single('file'), (req, res) => {
  try {
    const wb=XLSX.read(req.file.buffer,{type:'buffer',cellDates:true});
    const ws=wb.Sheets['Order Book']||wb.Sheets[wb.SheetNames[0]];
    if(!ws) return res.status(400).json({error:'No sheet found'});
    const rows=XLSX.utils.sheet_to_json(ws,{header:1,raw:false,dateNF:'yyyy-mm-dd'});
    let headerRow=-1;
    for(let i=0;i<rows.length;i++){
      const r=(rows[i]||[]).map(c=>(c||'').toString().toLowerCase());
      if(r.some(c=>c.includes('order number')||c.includes('order no')||c==='oblique')){headerRow=i;break;}
    }
    if(headerRow===-1) return res.status(400).json({error:'Header row not found'});
    const headers=rows[headerRow].map(h=>(h||'').toString().trim().toLowerCase());
    const g=(row,key)=>{const i=headers.indexOf(key);return i>=0?row[i]:null;};
    const pb=v=>(v===true||String(v).toLowerCase()==='true'||v==='1'||String(v).toLowerCase()==='yes')?1:0;
    const pd=v=>{if(!v)return null;if(v instanceof Date)return v.toISOString().split('T')[0];const s=v.toString();return s.includes('T')?s.split('T')[0]:s;};
    let imported=0,skipped=0;
    for(const row of rows.slice(headerRow+1)){
      const num=(g(row,'order number')||g(row,'order no')||g(row,'oblique')||'').toString().trim();
      if(!num||num.toLowerCase()==='s.no') continue;
      const parent=num.includes('/')?num.split('/')[0]:null;
      try {
        const r=db.prepare(`INSERT OR IGNORE INTO orders
          (order_number,parent_order,height_mm,width_mm,order_date,delivery_date,order_type,client_name,
           ct,gr,pe,bv,hl,pr,tg,bg,lg,fr,dg,qc,order_qty,status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`
        ).run(num,parent,parseFloat(g(row,'height'))||0,parseFloat(g(row,'width'))||0,
          pd(g(row,'order date')),pd(g(row,'delivery date')),
          g(row,'order type')||'Architectural',(g(row,'client name')||'').toString().trim(),
          pb(g(row,'ct')),pb(g(row,'gr')),pb(g(row,'pe')),pb(g(row,'bv')),pb(g(row,'hl')),
          pb(g(row,'pr')),pb(g(row,'tg')),pb(g(row,'bg')),pb(g(row,'lg')),pb(g(row,'fr')),pb(g(row,'dg')),
          parseInt(g(row,'order qty')||g(row,'qty')||0)||0,
          (g(row,'status')||'Active').toString().trim()||'Active');
        if(r.changes){const no=db.prepare('SELECT * FROM orders WHERE order_number=?').get(num);if(no)initOrderFlow(no);imported++;}else skipped++;
      } catch(e){skipped++;}
    }
    res.json({success:true,imported,skipped});
  } catch(e){res.status(500).json({error:e.message});}
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/login', (req,res)=>res.sendFile(path.join(__dirname,'public','login.html')));
app.get('/', (req,res)=>{
  if(!req.session.userId) return res.redirect('/login.html');
  res.sendFile(path.join(__dirname,'public','index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT=process.env.PORT||3000;
app.listen(PORT,'0.0.0.0',()=>{
  const os=require('os');
  let lanIp='localhost';
  for(const ifaces of Object.values(os.networkInterfaces()))
    for(const i of ifaces){if(i.family==='IPv4'&&!i.internal){lanIp=i.address;break;}}
  console.log(`\n✅  PSG Production Planner v2 running`);
  console.log(`   Local:  http://localhost:${PORT}`);
  console.log(`   LAN:    http://${lanIp}:${PORT}`);
  console.log(`   Login:  admin / admin123\n`);
});
