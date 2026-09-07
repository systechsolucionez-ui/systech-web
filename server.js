const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const { tenantMiddleware, masterDb, getDbForTenant, findTaller, crearTaller, listarTalleres, actualizarTaller, eliminarTaller, loginDistribuidor, validarSesionDistribuidor, cambiarPasswordDistribuidor } = require('./tenancy');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
// El middleware de tenant NO aplica a rutas del distribuidor ni a archivos estáticos
app.use((req, res, next) => {
  const esDistribuidor = req.path === '/distribuidor.html' ||
    req.path.startsWith('/api/distribuidor/');
  if (esDistribuidor) return next();
  return tenantMiddleware(req, res, next);
});
app.use(express.static('public'));

// ─── UPLOAD DE LOGO EMPRESA ───────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = UPLOADS_DIR;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `logo_empresa${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
  if (file.mimetype.startsWith('image/')) cb(null, true);
  else cb(new Error('Solo imágenes'));
}});

// Endpoint para subir logo empresa (NO el logo de SysTech)
// Subir foto de producto
const storageFoto = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = require('path').join(UPLOADS_DIR, 'productos');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `prod_${req.params.id}_${Date.now()}${ext}`);
  }
});
const uploadFoto = multer({ storage: storageFoto, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (req, file, cb) => {
  if (file.mimetype.startsWith('image/')) cb(null, true);
  else cb(new Error('Solo imágenes'));
}});

app.post('/api/productos/:id/foto', authMiddleware, (req, res, next) => {
  uploadFoto.single('foto')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No se recibió imagen' });
    const url = `/uploads/productos/${req.file.filename}`;
    // Borrar foto anterior si existe
    const prod = req.db.prepare('SELECT foto_url FROM productos WHERE id=?').get(req.params.id);
    if (prod && prod.foto_url) {
      const oldPath = path.join(__dirname, 'public', prod.foto_url);
      try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch(e) {}
    }
    req.db.prepare('UPDATE productos SET foto_url=? WHERE id=?').run(url, req.params.id);
    res.json({ ok: true, url });
  });
});

app.delete('/api/productos/:id/foto', authMiddleware, (req, res) => {
  const prod = req.db.prepare('SELECT foto_url FROM productos WHERE id=?').get(req.params.id);
  if (prod && prod.foto_url) {
    const oldPath = path.join(__dirname, 'public', prod.foto_url);
    try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch(e) {}
    req.db.prepare('UPDATE productos SET foto_url=NULL WHERE id=?').run(req.params.id);
  }
  res.json({ ok: true });
});

// Datos de orden para facturación (caja puede facturar desde orden)
app.get('/api/facturar-orden/:id', authMiddleware, (req, res) => {
  const o = req.db.prepare(`
    SELECT o.*, c.nombre as cliente_nombre, c.apellido as cliente_apellido,
           c.telefono as cliente_telefono, c.email as cliente_email,
           c.direccion as cliente_direccion
    FROM ordenes o LEFT JOIN clientes c ON o.cliente_id = c.id
    WHERE o.id = ?
  `).get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Orden no encontrada' });
  const repuestos = req.db.prepare(`
    SELECT or2.cantidad, or2.precio_unitario, or2.subtotal, p.nombre as descripcion
    FROM orden_repuestos or2 JOIN productos p ON or2.producto_id = p.id
    WHERE or2.orden_id = ?
  `).all(req.params.id);
  // Armar items para factura
  const items = [];
  if (o.mano_obra > 0) items.push({ descripcion: `Mano de obra técnica - ${o.equipo} ${o.marca||''}`.trim(), cantidad: 1, precio_unitario: o.mano_obra });
  repuestos.forEach(r => items.push({ descripcion: r.descripcion, cantidad: r.cantidad, precio_unitario: r.precio_unitario }));
  res.json({
    orden: { numero: o.numero, equipo: o.equipo, marca: o.marca, modelo: o.modelo },
    cliente: {
      nombre: (o.cliente_nombre || '').split(' ')[0] || '',
      apellido: (o.cliente_nombre || '').split(' ').slice(1).join(' ') || '',
      telefono: o.cliente_telefono || '',
      email: o.cliente_email || '',
      direccion: o.cliente_direccion || ''
    },
    items
  });
});

app.post('/api/upload/logo-empresa', upload.single('logo'), authMiddlewareUpload, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió archivo' });
  const url = `/uploads/${req.file.filename}`;
  // Guardar en config
  req.db.prepare("INSERT OR REPLACE INTO config (clave,valor) VALUES ('logo_empresa',?)").run(url);
  req.db.prepare("INSERT OR REPLACE INTO config_fiscal (clave,valor) VALUES ('logo_factura',?)").run(url);
  res.json({ ok: true, url });
});

// Eliminar logo empresa
app.delete('/api/upload/logo-empresa', authMiddlewareUpload, (req, res) => {
  req.db.prepare("INSERT OR REPLACE INTO config (clave,valor) VALUES ('logo_empresa','')").run();
  req.db.prepare("INSERT OR REPLACE INTO config_fiscal (clave,valor) VALUES ('logo_factura','')").run();
  const filePath = require('path').join(UPLOADS_DIR, 'logo_empresa.png');
  ['png','jpg','jpeg','webp'].forEach(ext => {
    const f = require('path').join(UPLOADS_DIR,`logo_empresa.${ext}`);
    if(fs.existsSync(f)) try { fs.unlinkSync(f); } catch(e) {}
  });
  res.json({ ok: true });
});

function authMiddlewareUpload(req, res, next) {
  const token = req.headers['x-token'];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  const sesion = req.db.prepare("SELECT * FROM sesiones WHERE token=? AND expires > datetime('now')").get(token);
  if (!sesion) return res.status(401).json({ error: 'Sesión expirada' });
  if (sesion.rol !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
  req.user = sesion;
  next();
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers['x-token'];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  const sesion = req.db.prepare("SELECT * FROM sesiones WHERE token=? AND expires > datetime('now')").get(token);
  if (!sesion) return res.status(401).json({ error: 'Sesión expirada' });
  req.user = sesion;
  next();
}

function adminOnly(req, res, next) {
  if (req.user.rol !== 'admin') return res.status(403).json({ error: 'Solo administradores' });
  next();
}

app.post('/api/login', (req, res) => {
  const { usuario, password } = req.body;
  const hash = crypto.createHash('sha256').update(password).digest('hex');
  const user = req.db.prepare("SELECT * FROM usuarios WHERE usuario=? AND password=? AND activo=1").get(usuario, hash);
  if (!user) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  const token = crypto.randomBytes(32).toString('hex');
  req.db.prepare("INSERT INTO sesiones (token,usuario_id,rol,nombre,expires) VALUES (?,?,?,?,datetime('now','+8 hours'))").run(token, user.id, user.rol, user.nombre);
  res.json({ token, rol: user.rol, nombre: user.nombre, id: user.id });
});

app.post('/api/logout', authMiddleware, (req, res) => {
  req.db.prepare("DELETE FROM sesiones WHERE token=?").run(req.headers['x-token']);
  res.json({ ok: true });
});

app.get('/api/me', authMiddleware, (req, res) => res.json(req.user));

// ─── CONFIG ───────────────────────────────────────────────────────────────────
app.get('/api/config', authMiddleware, (req, res) => {
  const rows = req.db.prepare("SELECT * FROM config").all();
  const cfg = {};
  rows.forEach(r => cfg[r.clave] = r.valor);
  res.json(cfg);
});

app.put('/api/config', authMiddleware, adminOnly, (req, res) => {
  const entries = Object.entries(req.body);
  const stmt = req.db.prepare("INSERT OR REPLACE INTO config (clave,valor) VALUES (?,?)");
  entries.forEach(([k,v]) => stmt.run(k, v));
  res.json({ ok: true });
});

// ─── USUARIOS (solo admin) ────────────────────────────────────────────────────
app.get('/api/usuarios', authMiddleware, adminOnly, (req, res) => {
  res.json(req.db.prepare("SELECT id,nombre,usuario,rol,activo,created_at FROM usuarios").all());
});

app.post('/api/usuarios', authMiddleware, adminOnly, (req, res) => {
  const { nombre, usuario, password, rol } = req.body;
  const hash = crypto.createHash('sha256').update(password).digest('hex');
  try {
    const r = req.db.prepare("INSERT INTO usuarios (nombre,usuario,password,rol) VALUES (?,?,?,?)").run(nombre,usuario,hash,rol);
    res.json({ id: r.lastInsertRowid });
  } catch(e) { res.status(400).json({ error: 'Usuario ya existe' }); }
});

app.put('/api/usuarios/:id', authMiddleware, adminOnly, (req, res) => {
  const { nombre, usuario, password, rol, activo } = req.body;
  if (password) {
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    req.db.prepare("UPDATE usuarios SET nombre=?,usuario=?,password=?,rol=?,activo=? WHERE id=?").run(nombre,usuario,hash,rol,activo,req.params.id);
  } else {
    req.db.prepare("UPDATE usuarios SET nombre=?,usuario=?,rol=?,activo=? WHERE id=?").run(nombre,usuario,rol,activo,req.params.id);
  }
  res.json({ ok: true });
});

// ─── PRODUCTOS ────────────────────────────────────────────────────────────────
app.get('/api/productos', authMiddleware, (req, res) => {
  res.json(req.db.prepare('SELECT * FROM productos ORDER BY nombre').all());
});
// Búsqueda por código exacto (usada por el lector de código de barras/QR)
app.get('/api/productos/buscar-codigo/:codigo', authMiddleware, (req, res) => {
  const codigo = req.params.codigo.trim();
  let p = req.db.prepare('SELECT * FROM productos WHERE codigo=?').get(codigo);
  if (!p) p = req.db.prepare('SELECT * FROM productos WHERE codigo LIKE ? ORDER BY nombre LIMIT 1').get(`%${codigo}%`);
  if (!p) return res.status(404).json({ error: 'No se encontró ningún producto con ese código' });
  res.json(p);
});
app.get('/api/productos/:id', authMiddleware, (req, res) => {
  const p = req.db.prepare('SELECT * FROM productos WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'No encontrado' });
  res.json(p);
});
app.post('/api/productos', authMiddleware, (req, res) => {
  const { codigo, nombre, categoria, stock, stock_minimo, precio_costo, precio_venta } = req.body;
  try {
    const r = req.db.prepare(`INSERT INTO productos (codigo,nombre,categoria,stock,stock_minimo,precio_costo,precio_venta) VALUES (?,?,?,?,?,?,?)`).run(codigo,nombre,categoria||'',stock||0,stock_minimo||1,precio_costo||0,precio_venta||0);
    if (stock>0) req.db.prepare(`INSERT INTO movimientos_stock (producto_id,tipo,cantidad,motivo) VALUES (?,'entrada',?,'Stock inicial')`).run(r.lastInsertRowid,stock);
    res.json({ id: r.lastInsertRowid });
  } catch(e) { res.status(400).json({ error: e.message.includes('UNIQUE') ? 'El código ya existe' : 'Error al crear el producto: '+e.message }); }
});
app.put('/api/productos/:id', authMiddleware, (req, res) => {
  const { codigo, nombre, categoria, stock_minimo, precio_costo, precio_venta } = req.body;
  req.db.prepare(`UPDATE productos SET codigo=?,nombre=?,categoria=?,stock_minimo=?,precio_costo=?,precio_venta=? WHERE id=?`).run(codigo,nombre,categoria||'',stock_minimo||1,precio_costo||0,precio_venta||0,req.params.id);
  res.json({ ok: true });
});
app.post('/api/productos/:id/ajustar-stock', authMiddleware, (req, res) => {
  const { cantidad, tipo, motivo } = req.body;
  const p = req.db.prepare('SELECT * FROM productos WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'No encontrado' });
  const nuevo = tipo==='entrada' ? p.stock+cantidad : p.stock-cantidad;
  if (nuevo<0) return res.status(400).json({ error: 'Stock insuficiente' });
  req.db.prepare('UPDATE productos SET stock=? WHERE id=?').run(nuevo,req.params.id);
  req.db.prepare(`INSERT INTO movimientos_stock (producto_id,tipo,cantidad,motivo) VALUES (?,?,?,?)`).run(req.params.id,tipo,cantidad,motivo||'');
  res.json({ nuevo_stock: nuevo });
});
app.delete('/api/productos/:id', authMiddleware, adminOnly, (req, res) => {
  req.db.prepare('DELETE FROM productos WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ─── CLIENTES ─────────────────────────────────────────────────────────────────
app.get('/api/clientes', authMiddleware, (req, res) => res.json(req.db.prepare('SELECT * FROM clientes ORDER BY nombre').all()));
app.post('/api/clientes', authMiddleware, (req, res) => {
  const { nombre, telefono, email, direccion } = req.body;
  const r = req.db.prepare(`INSERT INTO clientes (nombre,telefono,email,direccion) VALUES (?,?,?,?)`).run(nombre||'',telefono||'',email||'',direccion||'');
  res.json({ id: r.lastInsertRowid });
});
app.put('/api/clientes/:id', authMiddleware, (req, res) => {
  const { nombre, telefono, email, direccion } = req.body;
  req.db.prepare(`UPDATE clientes SET nombre=?,telefono=?,email=?,direccion=? WHERE id=?`).run(nombre,telefono,email,direccion,req.params.id);
  res.json({ ok: true });
});

// ─── ÓRDENES ──────────────────────────────────────────────────────────────────
app.get('/api/ordenes', authMiddleware, (req, res) => {
  const { q } = req.query;
  if (q && q.trim()) {
    const busq = `%${q.trim()}%`;
    res.json(req.db.prepare(`
      SELECT o.*,c.nombre as cliente_nombre,c.telefono as cliente_telefono
      FROM ordenes o LEFT JOIN clientes c ON o.cliente_id=c.id
      WHERE o.numero LIKE ? OR c.nombre LIKE ? OR o.equipo LIKE ? OR o.marca LIKE ?
      ORDER BY o.fecha_ingreso DESC
    `).all(busq,busq,busq,busq));
  } else {
    res.json(req.db.prepare(`SELECT o.*,c.nombre as cliente_nombre,c.telefono as cliente_telefono FROM ordenes o LEFT JOIN clientes c ON o.cliente_id=c.id ORDER BY o.fecha_ingreso DESC`).all());
  }
});
app.get('/api/ordenes/:id', authMiddleware, (req, res) => {
  const o = req.db.prepare(`SELECT o.*,c.nombre as cliente_nombre,c.telefono as cliente_telefono,c.email as cliente_email FROM ordenes o LEFT JOIN clientes c ON o.cliente_id=c.id WHERE o.id=?`).get(req.params.id);
  if (!o) return res.status(404).json({ error: 'No encontrado' });
  o.repuestos = req.db.prepare(`SELECT or2.*,p.nombre as producto_nombre,p.codigo as producto_codigo FROM orden_repuestos or2 JOIN productos p ON or2.producto_id=p.id WHERE or2.orden_id=?`).all(req.params.id);
  res.json(o);
});
app.post('/api/ordenes', authMiddleware, (req, res) => {
  const { cliente_id,equipo,marca,modelo,serie,falla_reportada,tecnico,prioridad,notas,mano_obra,checklist } = req.body;
  const fecha = new Date();
  const numero = `OT-${fecha.getFullYear()}${String(fecha.getMonth()+1).padStart(2,'0')}${String(fecha.getDate()).padStart(2,'0')}-${String(Math.floor(Math.random()*9000)+1000)}`;
  const r = req.db.prepare(`INSERT INTO ordenes (numero,cliente_id,equipo,marca,modelo,serie,falla_reportada,tecnico,prioridad,notas,mano_obra,checklist) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(numero,cliente_id||null,equipo||'',marca||'',modelo||'',serie||'',falla_reportada||'',tecnico||'',prioridad||'normal',notas||'',mano_obra||0,checklist||null);
  res.json({ id: r.lastInsertRowid, numero });
});
app.put('/api/ordenes/:id', authMiddleware, (req, res) => {
  const { estado,diagnostico,tecnico,mano_obra,notas,fecha_entrega,prioridad,cobrado } = req.body;
  const o = req.db.prepare('SELECT * FROM ordenes WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'No encontrado' });
  const tr = req.db.prepare('SELECT SUM(subtotal) as t FROM orden_repuestos WHERE orden_id=?').get(req.params.id);
  const total_repuestos = tr.t||0;
  const total = total_repuestos + (mano_obra||o.mano_obra||0);
  req.db.prepare(`UPDATE ordenes SET estado=?,diagnostico=?,tecnico=?,mano_obra=?,notas=?,fecha_entrega=?,prioridad=?,total_repuestos=?,total=?,cobrado=? WHERE id=?`).run(estado,diagnostico,tecnico,mano_obra,notas,fecha_entrega,prioridad,total_repuestos,total,cobrado||0,req.params.id);
  res.json({ ok: true });
});
app.post('/api/ordenes/:id/repuestos', authMiddleware, (req, res) => {
  const { producto_id, cantidad } = req.body;
  const p = req.db.prepare('SELECT * FROM productos WHERE id=?').get(producto_id);
  if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
  if (p.stock < cantidad) return res.status(400).json({ error: `Stock insuficiente. Disponible: ${p.stock}` });
  const subtotal = p.precio_venta * cantidad;
  req.db.prepare(`INSERT INTO orden_repuestos (orden_id,producto_id,cantidad,precio_unitario,subtotal) VALUES (?,?,?,?,?)`).run(req.params.id,producto_id,cantidad,p.precio_venta,subtotal);
  req.db.prepare('UPDATE productos SET stock=stock-? WHERE id=?').run(cantidad,producto_id);
  req.db.prepare(`INSERT INTO movimientos_stock (producto_id,tipo,cantidad,motivo,orden_id) VALUES (?,'salida',?,'Usado en orden',?)`).run(producto_id,cantidad,req.params.id);
  const tr = req.db.prepare('SELECT SUM(subtotal) as t FROM orden_repuestos WHERE orden_id=?').get(req.params.id);
  const oa = req.db.prepare('SELECT mano_obra FROM ordenes WHERE id=?').get(req.params.id);
  req.db.prepare('UPDATE ordenes SET total_repuestos=?,total=? WHERE id=?').run(tr.t||0,(tr.t||0)+(oa.mano_obra||0),req.params.id);
  res.json({ ok: true });
});
app.delete('/api/ordenes/:oid/repuestos/:rid', authMiddleware, (req, res) => {
  const rep = req.db.prepare('SELECT * FROM orden_repuestos WHERE id=?').get(req.params.rid);
  if (!rep) return res.status(404).json({ error: 'No encontrado' });
  req.db.prepare('UPDATE productos SET stock=stock+? WHERE id=?').run(rep.cantidad,rep.producto_id);
  req.db.prepare(`INSERT INTO movimientos_stock (producto_id,tipo,cantidad,motivo,orden_id) VALUES (?,'entrada',?,'Devuelto por anulación',?)`).run(rep.producto_id,rep.cantidad,rep.orden_id);
  req.db.prepare('DELETE FROM orden_repuestos WHERE id=?').run(req.params.rid);
  const tr = req.db.prepare('SELECT SUM(subtotal) as t FROM orden_repuestos WHERE orden_id=?').get(req.params.oid);
  const oa = req.db.prepare('SELECT mano_obra FROM ordenes WHERE id=?').get(req.params.oid);
  req.db.prepare('UPDATE ordenes SET total_repuestos=?,total=? WHERE id=?').run(tr.t||0,(tr.t||0)+(oa.mano_obra||0),req.params.oid);
  res.json({ ok: true });
});

// ─── NOTIFICACIONES ───────────────────────────────────────────────────────────
app.post('/api/ordenes/:id/notificacion', authMiddleware, (req, res) => {
  const { medio, mensaje } = req.body;
  req.db.prepare(`INSERT INTO notificaciones (orden_id,medio,mensaje) VALUES (?,?,?)`).run(req.params.id,medio,mensaje);
  res.json({ ok: true });
});
app.get('/api/ordenes/:id/notificaciones', authMiddleware, (req, res) => {
  res.json(req.db.prepare(`SELECT * FROM notificaciones WHERE orden_id=? ORDER BY fecha DESC`).all(req.params.id));
});

// ─── CHAT INTERNO ─────────────────────────────────────────────────────────────
app.get('/api/chat', authMiddleware, (req, res) => {
  res.json(req.db.prepare("SELECT * FROM chat ORDER BY fecha DESC LIMIT 100").all().reverse());
});
app.post('/api/chat', authMiddleware, (req, res) => {
  const { mensaje } = req.body;
  if (!mensaje || !mensaje.trim()) return res.status(400).json({ error: 'Mensaje vacío' });
  const r = req.db.prepare("INSERT INTO chat (usuario_id,usuario_nombre,rol,mensaje) VALUES (?,?,?,?)").run(req.user.usuario_id,req.user.nombre,req.user.rol,mensaje.trim());
  res.json({ id: r.lastInsertRowid });
});

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
app.get('/api/dashboard', authMiddleware, (req, res) => {
  res.json({
    ordenes_activas: req.db.prepare(`SELECT COUNT(*) as c FROM ordenes WHERE estado NOT IN ('entregado','cancelado')`).get().c,
    ordenes_hoy: req.db.prepare(`SELECT COUNT(*) as c FROM ordenes WHERE date(fecha_ingreso)=date('now')`).get().c,
    productos_bajo_stock: req.db.prepare(`SELECT COUNT(*) as c FROM productos WHERE stock<=stock_minimo`).get().c,
    total_productos: req.db.prepare(`SELECT COUNT(*) as c FROM productos`).get().c,
    ordenes_por_estado: req.db.prepare(`SELECT estado,COUNT(*) as cantidad FROM ordenes GROUP BY estado`).all(),
    productos_criticos: req.db.prepare(`SELECT * FROM productos WHERE stock<=stock_minimo ORDER BY stock ASC LIMIT 5`).all(),
    ultimas_ordenes: req.db.prepare(`SELECT o.numero,o.equipo,o.estado,o.fecha_ingreso,c.nombre as cliente FROM ordenes o LEFT JOIN clientes c ON o.cliente_id=c.id ORDER BY o.fecha_ingreso DESC LIMIT 5`).all(),
    cobros_pendientes: req.db.prepare(`SELECT COUNT(*) as c FROM ordenes WHERE estado='listo' AND cobrado=0`).get().c
  });
});

app.get('/api/movimientos', authMiddleware, (req, res) => {
  res.json(req.db.prepare(`SELECT m.*,p.nombre as producto_nombre,p.codigo as producto_codigo FROM movimientos_stock m JOIN productos p ON m.producto_id=p.id ORDER BY m.fecha DESC LIMIT 100`).all());
});

// ─── INICIAR ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// Directorio de uploads persistente para Railway
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'public', 'uploads');
if (!require('fs').existsSync(UPLOADS_DIR)) require('fs').mkdirSync(UPLOADS_DIR, { recursive: true });
['productos','herramientas','planos'].forEach(sub => {
  const d = require('path').join(UPLOADS_DIR, sub);
  if (!require('fs').existsSync(d)) require('fs').mkdirSync(d, { recursive: true });
});

// Detectar IP de red local automáticamente
function getLocalIP() {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}
const LOCAL_IP = getLocalIP();
app.get('/api/herramientas', authMiddleware, (req, res) => {
  const { q, estado, categoria } = req.query;
  let sql = 'SELECT * FROM herramientas WHERE activa=1';
  const params = [];
  if (q) { sql += ' AND (nombre LIKE ? OR codigo LIKE ? OR marca LIKE ? OR modelo LIKE ?)'; const busq = `%${q}%`; params.push(busq,busq,busq,busq); }
  if (estado) { sql += ' AND estado=?'; params.push(estado); }
  if (categoria) { sql += ' AND categoria=?'; params.push(categoria); }
  sql += ' ORDER BY nombre ASC';
  res.json(req.db.prepare(sql).all(...params));
});

// Búsqueda por código exacto (usada por el lector de código de barras/QR)
app.get('/api/herramientas/buscar-codigo/:codigo', authMiddleware, (req, res) => {
  const codigo = req.params.codigo.trim();
  let h = req.db.prepare('SELECT * FROM herramientas WHERE codigo=? AND activa=1').get(codigo);
  if (!h) h = req.db.prepare('SELECT * FROM herramientas WHERE codigo LIKE ? AND activa=1 ORDER BY nombre LIMIT 1').get(`%${codigo}%`);
  if (!h) return res.status(404).json({ error: 'No se encontró ninguna herramienta con ese código' });
  res.json(h);
});
app.get('/api/herramientas/:id', authMiddleware, (req, res) => {
  const h = req.db.prepare('SELECT * FROM herramientas WHERE id=?').get(req.params.id);
  if (!h) return res.status(404).json({ error: 'No encontrada' });
  h.movimientos = req.db.prepare('SELECT * FROM herramienta_movimientos WHERE herramienta_id=? ORDER BY fecha DESC LIMIT 20').all(req.params.id);
  res.json(h);
});

app.post('/api/herramientas', authMiddleware, adminOnly, (req, res) => {
  const { codigo, nombre, categoria, marca, modelo, estado, ubicacion, cantidad, cantidad_minima, descripcion, numero_serie, fecha_compra, valor_compra } = req.body;
  if (!codigo || !nombre) return res.status(400).json({ error: 'Código y nombre obligatorios' });
  const r = req.db.prepare(`INSERT INTO herramientas (codigo,nombre,categoria,marca,modelo,estado,ubicacion,cantidad,cantidad_minima,descripcion,numero_serie,fecha_compra,valor_compra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(codigo,nombre,categoria||'General',marca||'',modelo||'',estado||'disponible',ubicacion||'Taller',cantidad||1,cantidad_minima||1,descripcion||'',numero_serie||'',fecha_compra||'',valor_compra||0);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/herramientas/:id', authMiddleware, adminOnly, (req, res) => {
  const { nombre, categoria, marca, modelo, estado, ubicacion, cantidad, cantidad_minima, descripcion, numero_serie, fecha_compra, valor_compra } = req.body;
  req.db.prepare(`UPDATE herramientas SET nombre=?,categoria=?,marca=?,modelo=?,estado=?,ubicacion=?,cantidad=?,cantidad_minima=?,descripcion=?,numero_serie=?,fecha_compra=?,valor_compra=? WHERE id=?`).run(nombre,categoria,marca,modelo,estado,ubicacion,cantidad,cantidad_minima,descripcion,numero_serie,fecha_compra,valor_compra,req.params.id);
  res.json({ ok: true });
});

app.delete('/api/herramientas/:id', authMiddleware, adminOnly, (req, res) => {
  req.db.prepare('UPDATE herramientas SET activa=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Registrar uso/préstamo de herramienta
app.post('/api/herramientas/:id/movimiento', authMiddleware, adminOnly, (req, res) => {
  const { tipo, cantidad, tecnico, motivo, orden_id } = req.body;
  const h = req.db.prepare('SELECT * FROM herramientas WHERE id=?').get(req.params.id);
  if (!h) return res.status(404).json({ error: 'No encontrada' });
  req.db.prepare('INSERT INTO herramienta_movimientos (herramienta_id,tipo,cantidad,tecnico,motivo,orden_id) VALUES (?,?,?,?,?,?)').run(req.params.id,tipo,cantidad||1,tecnico||'',motivo||'',orden_id||null);
  // Actualizar estado si se presta/devuelve
  if (tipo === 'prestamo') req.db.prepare("UPDATE herramientas SET estado='en_uso' WHERE id=?").run(req.params.id);
  if (tipo === 'devolucion') req.db.prepare("UPDATE herramientas SET estado='disponible' WHERE id=?").run(req.params.id);
  if (tipo === 'mantenimiento') req.db.prepare("UPDATE herramientas SET estado='mantenimiento' WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// Upload foto herramienta
const storageHerr = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = require('path').join(UPLOADS_DIR, 'herramientas');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `herr_${req.params.id}_${Date.now()}${path.extname(file.originalname)}`)
});
const uploadHerr = multer({ storage: storageHerr, limits: { fileSize: 5*1024*1024 }, fileFilter:(req,file,cb)=>file.mimetype.startsWith('image/')?cb(null,true):cb(new Error('Solo imágenes')) });

app.post('/api/herramientas/:id/foto', authMiddleware, adminOnly, (req,res,next) => {
  uploadHerr.single('foto')(req,res,(err)=>{
    if(err) return res.status(400).json({error:err.message});
    if(!req.file) return res.status(400).json({error:'No se recibió imagen'});
    const url = `/uploads/herramientas/${req.file.filename}`;
    const h = req.db.prepare('SELECT foto_url FROM herramientas WHERE id=?').get(req.params.id);
    if(h?.foto_url){ try { const op=path.join(__dirname,'public',h.foto_url); if(fs.existsSync(op)) fs.unlinkSync(op); } catch(e){} }
    req.db.prepare('UPDATE herramientas SET foto_url=? WHERE id=?').run(url,req.params.id);
    res.json({ok:true,url});
  });
});

// Export herramientas CSV
app.get('/api/export/herramientas', authMiddleware, adminOnly, (req, res) => {
  const data = req.db.prepare('SELECT * FROM herramientas WHERE activa=1 ORDER BY nombre').all();
  const headers = ['Código','Nombre','Categoría','Marca','Modelo','Estado','Ubicación','Cantidad','Cantidad Mínima','N° Serie','Fecha Compra','Valor Compra'];
  const rows = data.map(h=>[h.codigo,h.nombre,h.categoria,h.marca,h.modelo,h.estado,h.ubicacion,h.cantidad,h.cantidad_minima,h.numero_serie,h.fecha_compra,h.valor_compra]);
  const escape = v => { if(!v&&v!==0) return ''; const s=String(v); return s.includes(',')||s.includes('"')||s.includes('\n')?`"${s.replace(/"/g,'""')}`:s; };
  const csv = [headers,...rows].map(r=>r.map(escape).join(',')).join('\r\n');
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="herramientas.csv"');
  res.send('\uFEFF'+csv);
});

// ─── SUCURSALES Y STOCK POR SUCURSAL ─────────────────────────────────────────

// Listar sucursales (incluye depósito central)
app.get('/api/sucursales', authMiddleware, (req, res) => {
  res.json(req.db.prepare('SELECT * FROM sucursales WHERE activa=1 ORDER BY es_deposito_central DESC, nombre ASC').all());
});

app.post('/api/sucursales', authMiddleware, adminOnly, (req, res) => {
  const { nombre, direccion, telefono } = req.body;
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  const r = req.db.prepare('INSERT INTO sucursales (nombre,direccion,telefono) VALUES (?,?,?)').run(nombre, direccion||'', telefono||'');
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/sucursales/:id', authMiddleware, adminOnly, (req, res) => {
  const { nombre, direccion, telefono } = req.body;
  const suc = req.db.prepare('SELECT * FROM sucursales WHERE id=?').get(req.params.id);
  if (suc?.es_deposito_central) return res.status(400).json({ error: 'El Depósito Central no se puede editar' });
  req.db.prepare('UPDATE sucursales SET nombre=?,direccion=?,telefono=? WHERE id=?').run(nombre, direccion, telefono, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/sucursales/:id', authMiddleware, adminOnly, (req, res) => {
  const suc = req.db.prepare('SELECT * FROM sucursales WHERE id=?').get(req.params.id);
  if (suc?.es_deposito_central) return res.status(400).json({ error: 'El Depósito Central no se puede eliminar' });
  req.db.prepare('UPDATE sucursales SET activa=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Ver stock de un producto distribuido en todas las sucursales
app.get('/api/productos/:id/stock-sucursales', authMiddleware, (req, res) => {
  const producto = req.db.prepare('SELECT * FROM productos WHERE id=?').get(req.params.id);
  if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });
  const sucursales = req.db.prepare('SELECT * FROM sucursales WHERE activa=1 ORDER BY es_deposito_central DESC, nombre ASC').all();
  const distribuido = req.db.prepare('SELECT sucursal_id, cantidad FROM stock_sucursal WHERE producto_id=?').all(req.params.id);
  const mapaDistribuido = {};
  distribuido.forEach(d => mapaDistribuido[d.sucursal_id] = d.cantidad);

  const resultado = sucursales.map(s => ({
    sucursal_id: s.id,
    sucursal_nombre: s.nombre,
    es_deposito_central: !!s.es_deposito_central,
    // El depósito central muestra el stock SIN distribuir (producto.stock), las demás su cantidad distribuida
    cantidad: s.es_deposito_central ? producto.stock : (mapaDistribuido[s.id] || 0)
  }));
  res.json({ producto: { id: producto.id, codigo: producto.codigo, nombre: producto.nombre }, distribucion: resultado });
});

// Distribuir stock del depósito central hacia una sucursal
app.post('/api/productos/:id/distribuir', authMiddleware, adminOnly, (req, res) => {
  const { sucursal_id, cantidad, notas } = req.body;
  const cant = parseInt(cantidad);
  if (!sucursal_id || !cant || cant <= 0) return res.status(400).json({ error: 'Sucursal y cantidad son obligatorios' });

  const producto = req.db.prepare('SELECT * FROM productos WHERE id=?').get(req.params.id);
  if (!producto) return res.status(404).json({ error: 'Producto no encontrado' });
  if (producto.stock < cant) return res.status(400).json({ error: `Stock insuficiente en el depósito central (disponible: ${producto.stock})` });

  const sucursalDestino = req.db.prepare('SELECT * FROM sucursales WHERE id=?').get(sucursal_id);
  if (!sucursalDestino) return res.status(404).json({ error: 'Sucursal no encontrada' });
  if (sucursalDestino.es_deposito_central) return res.status(400).json({ error: 'No se puede distribuir hacia el depósito central' });

  // Descontar del depósito central
  req.db.prepare('UPDATE productos SET stock = stock - ? WHERE id=?').run(cant, req.params.id);

  // Sumar a la sucursal destino (UPSERT)
  const existe = req.db.prepare('SELECT id FROM stock_sucursal WHERE producto_id=? AND sucursal_id=?').get(req.params.id, sucursal_id);
  if (existe) {
    req.db.prepare('UPDATE stock_sucursal SET cantidad = cantidad + ? WHERE producto_id=? AND sucursal_id=?').run(cant, req.params.id, sucursal_id);
  } else {
    req.db.prepare('INSERT INTO stock_sucursal (producto_id,sucursal_id,cantidad) VALUES (?,?,?)').run(req.params.id, sucursal_id, cant);
  }

  // Registrar movimiento
  req.db.prepare(`INSERT INTO movimientos_sucursal (producto_id,sucursal_origen_id,sucursal_destino_id,cantidad,tipo,usuario,notas) VALUES (?,NULL,?,?,'distribucion',?,?)`)
    .run(req.params.id, sucursal_id, cant, req.user?.nombre||'', notas||'');

  res.json({ ok: true });
});

// Devolver stock de una sucursal al depósito central
app.post('/api/productos/:id/devolver-deposito', authMiddleware, adminOnly, (req, res) => {
  const { sucursal_id, cantidad, notas } = req.body;
  const cant = parseInt(cantidad);
  if (!sucursal_id || !cant || cant <= 0) return res.status(400).json({ error: 'Sucursal y cantidad son obligatorios' });

  const stockActual = req.db.prepare('SELECT cantidad FROM stock_sucursal WHERE producto_id=? AND sucursal_id=?').get(req.params.id, sucursal_id);
  if (!stockActual || stockActual.cantidad < cant) {
    return res.status(400).json({ error: `Stock insuficiente en la sucursal (disponible: ${stockActual?.cantidad||0})` });
  }

  req.db.prepare('UPDATE stock_sucursal SET cantidad = cantidad - ? WHERE producto_id=? AND sucursal_id=?').run(cant, req.params.id, sucursal_id);
  req.db.prepare('UPDATE productos SET stock = stock + ? WHERE id=?').run(cant, req.params.id);

  req.db.prepare(`INSERT INTO movimientos_sucursal (producto_id,sucursal_origen_id,sucursal_destino_id,cantidad,tipo,usuario,notas) VALUES (?,?,NULL,?,'devolucion',?,?)`)
    .run(req.params.id, sucursal_id, cant, req.user?.nombre||'', notas||'');

  res.json({ ok: true });
});

// Transferir stock entre dos sucursales (no depósito)
app.post('/api/productos/:id/transferir', authMiddleware, adminOnly, (req, res) => {
  const { sucursal_origen_id, sucursal_destino_id, cantidad, notas } = req.body;
  const cant = parseInt(cantidad);
  if (!sucursal_origen_id || !sucursal_destino_id || !cant || cant <= 0) {
    return res.status(400).json({ error: 'Origen, destino y cantidad son obligatorios' });
  }
  if (sucursal_origen_id === sucursal_destino_id) return res.status(400).json({ error: 'Origen y destino no pueden ser iguales' });

  const stockOrigen = req.db.prepare('SELECT cantidad FROM stock_sucursal WHERE producto_id=? AND sucursal_id=?').get(req.params.id, sucursal_origen_id);
  if (!stockOrigen || stockOrigen.cantidad < cant) {
    return res.status(400).json({ error: `Stock insuficiente en la sucursal de origen (disponible: ${stockOrigen?.cantidad||0})` });
  }

  req.db.prepare('UPDATE stock_sucursal SET cantidad = cantidad - ? WHERE producto_id=? AND sucursal_id=?').run(cant, req.params.id, sucursal_origen_id);
  const existeDestino = req.db.prepare('SELECT id FROM stock_sucursal WHERE producto_id=? AND sucursal_id=?').get(req.params.id, sucursal_destino_id);
  if (existeDestino) {
    req.db.prepare('UPDATE stock_sucursal SET cantidad = cantidad + ? WHERE producto_id=? AND sucursal_id=?').run(cant, req.params.id, sucursal_destino_id);
  } else {
    req.db.prepare('INSERT INTO stock_sucursal (producto_id,sucursal_id,cantidad) VALUES (?,?,?)').run(req.params.id, sucursal_destino_id, cant);
  }

  req.db.prepare(`INSERT INTO movimientos_sucursal (producto_id,sucursal_origen_id,sucursal_destino_id,cantidad,tipo,usuario,notas) VALUES (?,?,?,?,'transferencia',?,?)`)
    .run(req.params.id, sucursal_origen_id, sucursal_destino_id, cant, req.user?.nombre||'', notas||'');

  res.json({ ok: true });
});

// Historial de movimientos entre sucursales (para el dashboard del dueño)
app.get('/api/sucursales/movimientos', authMiddleware, (req, res) => {
  const movs = req.db.prepare(`
    SELECT m.*, p.codigo, p.nombre as producto_nombre,
           so.nombre as sucursal_origen_nombre, sd.nombre as sucursal_destino_nombre
    FROM movimientos_sucursal m
    JOIN productos p ON m.producto_id = p.id
    LEFT JOIN sucursales so ON m.sucursal_origen_id = so.id
    LEFT JOIN sucursales sd ON m.sucursal_destino_id = sd.id
    ORDER BY m.fecha DESC LIMIT 200
  `).all();
  res.json(movs);
});

// Dashboard consolidado por sucursal — ventas, totales, gráficos (vista del dueño)
app.get('/api/sucursales/dashboard', authMiddleware, adminOnly, (req, res) => {
  const { desde, hasta } = req.query;
  let filtroFecha = '';
  const params = [];
  if (desde && hasta) {
    filtroFecha = 'AND date(c.fecha) BETWEEN ? AND ?';
    params.push(desde, hasta);
  }

  const ventasPorSucursal = req.db.prepare(`
    SELECT s.id as sucursal_id, s.nombre as sucursal_nombre,
           COUNT(c.id) as cantidad_ventas,
           COALESCE(SUM(c.total),0) as total_facturado
    FROM sucursales s
    LEFT JOIN comprobantes c ON c.sucursal_id = s.id AND c.estado != 'anulado' ${filtroFecha}
    WHERE s.activa = 1 AND s.es_deposito_central = 0
    GROUP BY s.id ORDER BY total_facturado DESC
  `).all(...params);

  const stockPorSucursal = req.db.prepare(`
    SELECT s.id as sucursal_id, s.nombre as sucursal_nombre,
           COALESCE(SUM(ss.cantidad),0) as total_unidades,
           COUNT(DISTINCT ss.producto_id) as productos_distintos
    FROM sucursales s
    LEFT JOIN stock_sucursal ss ON ss.sucursal_id = s.id
    WHERE s.activa = 1 AND s.es_deposito_central = 0
    GROUP BY s.id
  `).all();

  res.json({ ventasPorSucursal, stockPorSucursal });
});

// ─── EXPORTAR A EXCEL (CSV compatible con Excel) ─────────────────────────────

function toCSV(headers, rows) {
  const escape = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map(r => r.map(escape).join(',')).join('\r\n');
}

app.get('/api/export/ordenes', authMiddleware, (req, res) => {
  const data = req.db.prepare(`
    SELECT o.numero, c.nombre as cliente, c.telefono, o.equipo, o.marca, o.modelo,
           o.serie, o.estado, o.prioridad, o.tecnico, o.falla_reportada, o.diagnostico,
           o.mano_obra, o.total_repuestos, o.total, o.cobrado,
           o.fecha_ingreso, o.fecha_entrega, o.notas
    FROM ordenes o LEFT JOIN clientes c ON o.cliente_id = c.id
    ORDER BY o.fecha_ingreso DESC
  `).all();
  const headers = ['N° Orden','Cliente','Teléfono','Equipo','Marca','Modelo','Serie','Estado','Prioridad','Técnico','Falla Reportada','Diagnóstico','Mano de Obra','Total Repuestos','Total','Cobrado','Fecha Ingreso','Fecha Entrega','Notas'];
  const rows = data.map(o => [o.numero,o.cliente,o.telefono,o.equipo,o.marca,o.modelo,o.serie,o.estado,o.prioridad,o.tecnico,o.falla_reportada,o.diagnostico,o.mano_obra,o.total_repuestos,o.total,o.cobrado?'Sí':'No',o.fecha_ingreso,o.fecha_entrega,o.notas]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ordenes.csv"');
  res.send('\uFEFF' + toCSV(headers, rows));
});

app.get('/api/export/stock', authMiddleware, (req, res) => {
  const data = req.db.prepare('SELECT * FROM productos ORDER BY nombre').all();
  const headers = ['Código','Nombre','Categoría','Stock','Stock Mínimo','Precio Costo','Precio Venta'];
  const rows = data.map(p => [p.codigo,p.nombre,p.categoria,p.stock,p.stock_minimo,p.precio_costo,p.precio_venta]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="stock.csv"');
  res.send('\uFEFF' + toCSV(headers, rows));
});

app.get('/api/export/clientes', authMiddleware, (req, res) => {
  const data = req.db.prepare('SELECT * FROM clientes ORDER BY nombre').all();
  const headers = ['Nombre','Teléfono','Email','Dirección','Fecha Alta'];
  const rows = data.map(c => [c.nombre,c.telefono,c.email,c.direccion,c.created_at]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="clientes.csv"');
  res.send('\uFEFF' + toCSV(headers, rows));
});

app.get('/api/export/movimientos', authMiddleware, (req, res) => {
  const data = req.db.prepare(`
    SELECT m.fecha, p.codigo, p.nombre, m.tipo, m.cantidad, m.motivo
    FROM movimientos_stock m JOIN productos p ON m.producto_id = p.id
    ORDER BY m.fecha DESC
  `).all();
  const headers = ['Fecha','Código','Producto','Tipo','Cantidad','Motivo'];
  const rows = data.map(m => [m.fecha,m.codigo,m.nombre,m.tipo,m.cantidad,m.motivo]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="movimientos.csv"');
  res.send('\uFEFF' + toCSV(headers, rows));
});

// ─── IMPRESORAS ───────────────────────────────────────────────────────────────


app.get('/api/impresoras', authMiddleware, (req, res) => {
  res.json(req.db.prepare('SELECT * FROM impresoras WHERE activa=1 ORDER BY predeterminada DESC').all());
});

app.post('/api/impresoras', authMiddleware, adminOnly, (req, res) => {
  const { nombre, tipo, ancho, ubicacion, predeterminada } = req.body;
  if (predeterminada) req.db.prepare("UPDATE impresoras SET predeterminada=0 WHERE tipo=?").run(tipo);
  const r = req.db.prepare('INSERT INTO impresoras (nombre,tipo,ancho,ubicacion,predeterminada) VALUES (?,?,?,?,?)').run(nombre,tipo,ancho||'80mm',ubicacion||'caja',predeterminada?1:0);
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/impresoras/:id', authMiddleware, adminOnly, (req, res) => {
  const { nombre, tipo, ancho, ubicacion, predeterminada } = req.body;
  if (predeterminada) req.db.prepare("UPDATE impresoras SET predeterminada=0 WHERE tipo=?").run(tipo);
  req.db.prepare('UPDATE impresoras SET nombre=?,tipo=?,ancho=?,ubicacion=?,predeterminada=? WHERE id=?').run(nombre,tipo,ancho,ubicacion,predeterminada?1:0,req.params.id);
  res.json({ ok: true });
});

app.delete('/api/impresoras/:id', authMiddleware, adminOnly, (req, res) => {
  req.db.prepare('UPDATE impresoras SET activa=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Datos para imprimir orden
app.get('/api/print/orden/:id', authMiddleware, (req, res) => {
  const o = req.db.prepare(`SELECT o.*,c.nombre as cliente_nombre,c.telefono as cliente_telefono,c.email as cliente_email,c.direccion as cliente_direccion FROM ordenes o LEFT JOIN clientes c ON o.cliente_id=c.id WHERE o.id=?`).get(req.params.id);
  if (!o) return res.status(404).json({ error: 'No encontrado' });
  o.repuestos = req.db.prepare(`SELECT or2.*,p.nombre as producto_nombre,p.codigo as producto_codigo FROM orden_repuestos or2 JOIN productos p ON or2.producto_id=p.id WHERE or2.orden_id=?`).all(req.params.id);
  const cfg = {};
  req.db.prepare('SELECT * FROM config').all().forEach(r => cfg[r.clave]=r.valor);
  o.empresa = { nombre: cfg.empresa_nombre||'Servicio Técnico', direccion: cfg.empresa_direccion||'', telefono: cfg.empresa_telefono||'', email: cfg.empresa_email||'', whatsapp: cfg.empresa_whatsapp||'' };
  res.json(o);
});

// ─── AUTOMATIZACIÓN DE MENSAJES ──────────────────────────────────────────────
const nodemailer = require('nodemailer');

// Tabla de configuración de automatización


// Función para reemplazar variables en plantilla
function procesarPlantilla(texto, datos) {
  return texto
    .replace(/{nombre}/g, datos.cliente_nombre || 'Cliente')
    .replace(/{equipo}/g, datos.equipo || '')
    .replace(/{marca}/g, datos.marca || '')
    .replace(/{modelo}/g, datos.modelo || '')
    .replace(/{numero}/g, datos.numero || '')
    .replace(/{falla}/g, datos.falla_reportada || '')
    .replace(/{total}/g, (datos.total || 0).toFixed(0))
    .replace(/{empresa}/g, datos.empresa_nombre || 'Servicio Técnico')
    .replace(/{direccion}/g, datos.empresa_direccion || '')
    .replace(/{telefono}/g, datos.empresa_telefono || '')
    .replace(/{link_cliente}/g, datos.link_cliente || '')
    .replace(/\s+/g, ' ').trim();
}

// Función enviar email
async function enviarEmail(destino, asunto, htmlBody, config) {
  if (!config.smtp_host || !config.smtp_user || !config.smtp_pass) throw new Error('SMTP no configurado');
  const transporter = nodemailer.createTransport({
    host: config.smtp_host,
    port: parseInt(config.smtp_port) || 587,
    secure: config.smtp_port === '465',
    auth: { user: config.smtp_user, pass: config.smtp_pass }
  });
  await transporter.sendMail({
    from: `"${config.empresa_nombre || 'Servicio Técnico'}" <${config.smtp_user}>`,
    to: destino, subject: asunto,
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;border:1px solid #eee;border-radius:8px">${htmlBody}<hr style="margin-top:30px;border:none;border-top:1px solid #eee"><p style="font-size:11px;color:#888;text-align:center">${config.empresa_nombre || ''} · ${config.empresa_direccion || ''} · ${config.empresa_telefono || ''}</p></div>`
  });
}

// GET config automatización
app.get('/api/automatizacion', authMiddleware, (req, res) => {
  res.json(req.db.prepare('SELECT * FROM automatizacion ORDER BY id').all());
});

// PUT actualizar config de un evento
app.put('/api/automatizacion/:evento', authMiddleware, adminOnly, (req, res) => {
  const { activo, canal, modo, plantilla_wa, plantilla_email, asunto_email } = req.body;
  req.db.prepare('UPDATE automatizacion SET activo=?,canal=?,modo=?,plantilla_wa=?,plantilla_email=?,asunto_email=? WHERE evento=?')
    .run(activo?1:0, canal, modo, plantilla_wa, plantilla_email, asunto_email, req.params.evento);
  res.json({ ok: true });
});

// POST disparar automatización manualmente (con preview)
app.post('/api/automatizacion/preview', authMiddleware, (req, res) => {
  const { orden_id, evento } = req.body;
  const o = req.db.prepare(`SELECT o.*,c.nombre as cliente_nombre,c.telefono as cliente_telefono,c.email as cliente_email FROM ordenes o LEFT JOIN clientes c ON o.cliente_id=c.id WHERE o.id=?`).get(orden_id);
  if (!o) return res.status(404).json({ error: 'Orden no encontrada' });
  const cfg = {};
  req.db.prepare('SELECT * FROM config').all().forEach(r => cfg[r.clave]=r.valor);
  const auto = req.db.prepare('SELECT * FROM automatizacion WHERE evento=?').get(evento);
  if (!auto) return res.status(404).json({ error: 'Evento no encontrado' });
  const datos = { ...o, empresa_nombre: cfg.empresa_nombre, empresa_direccion: cfg.empresa_direccion, empresa_telefono: cfg.empresa_telefono, link_cliente: `http://${LOCAL_IP}:${PORT}/cliente/` };
  res.json({
    wa: procesarPlantilla(auto.plantilla_wa || '', datos),
    email: procesarPlantilla(auto.plantilla_email || '', datos),
    asunto: procesarPlantilla(auto.asunto_email || '', datos),
    cliente_telefono: o.cliente_telefono,
    cliente_email: o.cliente_email,
    canal: auto.canal,
    modo: auto.modo
  });
});

// POST enviar automáticamente
app.post('/api/automatizacion/enviar', authMiddleware, async (req, res) => {
  const { orden_id, evento, canal_override } = req.body;
  const o = req.db.prepare(`SELECT o.*,c.nombre as cliente_nombre,c.telefono as cliente_telefono,c.email as cliente_email FROM ordenes o LEFT JOIN clientes c ON o.cliente_id=c.id WHERE o.id=?`).get(orden_id);
  if (!o) return res.status(404).json({ error: 'Orden no encontrada' });
  const cfg = {};
  req.db.prepare('SELECT * FROM config').all().forEach(r => cfg[r.clave]=r.valor);
  const auto = req.db.prepare('SELECT * FROM automatizacion WHERE evento=?').get(evento);
  if (!auto || !auto.activo) return res.json({ ok: false, msg: 'Automatización inactiva' });
  const datos = { ...o, empresa_nombre: cfg.empresa_nombre, empresa_direccion: cfg.empresa_direccion, empresa_telefono: cfg.empresa_telefono, link_cliente: `http://${LOCAL_IP}:${PORT}/cliente/` };
  const canal = canal_override || auto.canal;
  const resultados = [];

  // WhatsApp
  if ((canal === 'whatsapp' || canal === 'ambos') && o.cliente_telefono) {
    const msg = procesarPlantilla(auto.plantilla_wa || '', datos);
    const tel = (o.cliente_telefono || '').replace(/[\s\-\(\)]/g,'');
    const telF = tel.startsWith('0') ? '54'+tel.slice(1) : tel.startsWith('+') ? tel.slice(1) : '54'+tel;
    const waUrl = `https://wa.me/${telF}?text=${encodeURIComponent(msg)}`;
    req.db.prepare('INSERT INTO log_automatizacion (orden_id,evento,canal,estado,detalle) VALUES (?,?,?,?,?)').run(orden_id,evento,'whatsapp','enviado',msg);
    req.db.prepare('INSERT INTO notificaciones (orden_id,medio,mensaje) VALUES (?,?,?)').run(orden_id,'whatsapp',msg);
    resultados.push({ canal: 'whatsapp', url: waUrl, mensaje: msg });
  }

  // Email
  if ((canal === 'email' || canal === 'ambos') && o.cliente_email) {
    const htmlBody = procesarPlantilla(auto.plantilla_email || '', datos);
    const asunto = procesarPlantilla(auto.asunto_email || '', datos);
    try {
      await enviarEmail(o.cliente_email, asunto, htmlBody, { ...cfg });
      req.db.prepare('INSERT INTO log_automatizacion (orden_id,evento,canal,estado,detalle) VALUES (?,?,?,?,?)').run(orden_id,evento,'email','enviado',asunto);
      req.db.prepare('INSERT INTO notificaciones (orden_id,medio,mensaje) VALUES (?,?,?)').run(orden_id,'email',asunto);
      resultados.push({ canal: 'email', estado: 'enviado' });
    } catch(e) {
      req.db.prepare('INSERT INTO log_automatizacion (orden_id,evento,canal,estado,detalle) VALUES (?,?,?,?,?)').run(orden_id,evento,'email','error',e.message);
      resultados.push({ canal: 'email', estado: 'error', error: e.message });
    }
  }
  res.json({ ok: true, resultados });
});

// GET log
app.get('/api/automatizacion/log', authMiddleware, (req, res) => {
  res.json(req.db.prepare('SELECT l.*,o.numero FROM log_automatizacion l LEFT JOIN ordenes o ON l.orden_id=o.id ORDER BY l.fecha DESC LIMIT 100').all());
});

// ─── FACTURACIÓN / PRESUPUESTOS ──────────────────────────────────────────────
// GET config fiscal
app.get('/api/fiscal/config', authMiddleware, (req, res) => {
  const rows = req.db.prepare('SELECT * FROM config_fiscal').all();
  const cfg = {};
  rows.forEach(r => cfg[r.clave] = r.valor);
  res.json(cfg);
});

// PUT config fiscal
app.put('/api/fiscal/config', authMiddleware, adminOnly, (req, res) => {
  Object.entries(req.body).forEach(([k,v]) => {
    req.db.prepare('INSERT OR REPLACE INTO config_fiscal (clave,valor) VALUES (?,?)').run(k,v);
  });
  res.json({ ok: true });
});

// GET comprobantes
app.get('/api/comprobantes', authMiddleware, (req, res) => {
  res.json(req.db.prepare('SELECT * FROM comprobantes ORDER BY fecha DESC').all());
});

app.get('/api/comprobantes/:id', authMiddleware, (req, res) => {
  const c = req.db.prepare('SELECT * FROM comprobantes WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'No encontrado' });
  c.items = JSON.parse(c.items || '[]');
  res.json(c);
});

// POST crear comprobante
app.post('/api/comprobantes', authMiddleware, (req, res) => {
  const { tipo, letra, orden_id, cliente_id, cliente_nombre, cliente_apellido,
    cliente_doc_tipo, cliente_doc_numero, cliente_condicion_iva, cliente_direccion,
    items, descuento, condicion_pago, notas, condicion_iva_emisor, sucursal_id } = req.body;

  // Calcular totales
  const itemsArr = items || [];
  const subtotal = itemsArr.reduce((sum, i) => sum + (i.cantidad * i.precio_unitario), 0);
  const desc = descuento || 0;
  const baseImponible = subtotal - desc;
  let iva_porcentaje = 0;
  let iva_monto = 0;
  // Nota de Entrega tampoco calcula IVA — no es un comprobante de venta, es
  // solo constancia de qué se entregó (como un presupuesto en ese sentido)
  if (condicion_iva_emisor === 'Responsable Inscripto' && tipo !== 'presupuesto' && tipo !== 'nota_entrega') {
    iva_porcentaje = 21;
    iva_monto = baseImponible * 0.21;
  }
  const total = baseImponible + iva_monto;

  // Número correlativo — cada tipo de comprobante lleva su propio contador,
  // independiente (antes, Factura C y Nota de Débito caían por error en el
  // mismo contador que Nota de Crédito, pisándose los números entre sí).
  const tipoKey = tipo === 'presupuesto' ? 'proximo_numero_presupuesto' :
    tipo === 'nota_entrega' ? 'proximo_numero_nota_entrega' :
    tipo === 'factura' && letra === 'A' ? 'proximo_numero_factura_a' :
    tipo === 'factura' && letra === 'B' ? 'proximo_numero_factura_b' :
    tipo === 'factura' && letra === 'C' ? 'proximo_numero_factura_c' :
    tipo === 'nota_debito' ? 'proximo_numero_nota_debito' :
    tipo === 'nota_credito' ? 'proximo_numero_nota_credito' :
    'proximo_numero_presupuesto'; // resguardo: nunca compartir contador con Notas de Crédito por error
  const proximoRec = req.db.prepare('SELECT valor FROM config_fiscal WHERE clave=?').get(tipoKey);
  const numComp = parseInt(proximoRec?.valor || '1');
  const pv = req.db.prepare('SELECT valor FROM config_fiscal WHERE clave=?').get('punto_venta')?.valor || '1';
  const pvPad = String(pv).padStart(4,'0');
  const numPad = String(numComp).padStart(8,'0');
  // El prefijo tiene que distinguir tipo de comprobante, no solo letra — antes,
  // una Factura C y una Nota de Crédito C podían generar el mismo número interno
  // (ej: las dos primeras de cada tipo daban "C0001-00000001"), y como el campo
  // es único en la base, la segunda fallaba con error de SQLite.
  const TIPO_ABREV = { presupuesto: 'PRES', factura: 'FC', nota_credito: 'NC', nota_debito: 'ND', nota_entrega: 'ENT' };
  const prefijo = tipo === 'presupuesto' ? 'PRES' : `${TIPO_ABREV[tipo] || tipo.toUpperCase()}-${letra}${pvPad}`;
  const numero = `${prefijo}-${numPad}`;

  // Actualizar próximo número (INSERT OR REPLACE: nunca falla en silencio
  // aunque la fila no exista todavía, a diferencia de un UPDATE simple)
  req.db.prepare('INSERT OR REPLACE INTO config_fiscal (clave,valor) VALUES (?,?)').run(tipoKey, String(numComp+1));

  const r = req.db.prepare(`INSERT INTO comprobantes
    (numero,tipo,letra,punto_venta,numero_comp,orden_id,cliente_id,cliente_nombre,cliente_apellido,
     cliente_doc_tipo,cliente_doc_numero,cliente_condicion_iva,cliente_direccion,
     items,subtotal,descuento,iva_porcentaje,iva_monto,total,condicion_pago,notas,estado,sucursal_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'borrador',?)`
  ).run(numero,tipo,letra||'X',parseInt(pv),numComp,orden_id||null,cliente_id||null,
    cliente_nombre||'',cliente_apellido||'',cliente_doc_tipo||'DNI',cliente_doc_numero||'',
    cliente_condicion_iva||'Consumidor Final',cliente_direccion||'',
    JSON.stringify(itemsArr),subtotal,desc,iva_porcentaje,iva_monto,total,
    condicion_pago||'Contado',notas||'',sucursal_id||null);

  res.json({ id: r.lastInsertRowid, numero, total });
});

app.put('/api/comprobantes/:id', authMiddleware, (req, res) => {
  const { estado, notas, cae, cae_vencimiento } = req.body;
  req.db.prepare('UPDATE comprobantes SET estado=?,notas=?,cae=?,cae_vencimiento=? WHERE id=?')
    .run(estado,notas,cae,cae_vencimiento,req.params.id);
  res.json({ ok: true });
});

app.delete('/api/comprobantes/:id', authMiddleware, adminOnly, (req, res) => {
  req.db.prepare('DELETE FROM comprobantes WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Datos para imprimir comprobante
app.get('/api/fiscal/print/:id', authMiddleware, (req, res) => {
  const c = req.db.prepare('SELECT * FROM comprobantes WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'No encontrado' });
  c.items = JSON.parse(c.items || '[]');
  const cfg = {};
  req.db.prepare('SELECT * FROM config_fiscal').all().forEach(r => cfg[r.clave]=r.valor);
  const cfgGen = {};
  req.db.prepare('SELECT * FROM config').all().forEach(r => cfgGen[r.clave]=r.valor);
  c.emisor = { ...cfg, empresa_nombre: cfgGen.empresa_nombre, empresa_telefono: cfgGen.empresa_telefono, empresa_email: cfgGen.empresa_email, logo_empresa: cfgGen.logo_empresa };
  res.json(c);
});

// ─── GENERAR EXCEL CON GRÁFICOS ───────────────────────────────────────────────
const { execSync } = require('child_process');

app.get('/api/reportes/excel', authMiddleware, (req, res) => {
  try {
    const { desde, hasta } = req.query;
    const filtroFecha = desde && hasta
      ? `AND date(fecha_ingreso) BETWEEN '${desde}' AND '${hasta}'` : '';

    const datos = {
      ordenesPorEstado: req.db.prepare(`SELECT estado, COUNT(*) as cantidad FROM ordenes WHERE 1=1 ${filtroFecha} GROUP BY estado`).all(),
      ordenesPorMes: req.db.prepare(`SELECT strftime('%Y-%m', fecha_ingreso) as mes, COUNT(*) as cantidad, SUM(total) as total FROM ordenes WHERE 1=1 ${filtroFecha} GROUP BY mes ORDER BY mes DESC LIMIT 12`).all().reverse(),
      repuestosMasUsados: req.db.prepare(`SELECT p.nombre, p.codigo, SUM(or2.cantidad) as total_usado, SUM(or2.subtotal) as total_facturado FROM orden_repuestos or2 JOIN productos p ON or2.producto_id=p.id GROUP BY p.id ORDER BY total_usado DESC LIMIT 10`).all(),
      ingresosPorTecnico: req.db.prepare(`SELECT tecnico, COUNT(*) as ordenes, SUM(total) as total FROM ordenes WHERE tecnico IS NOT NULL AND tecnico != '' ${filtroFecha} GROUP BY tecnico ORDER BY total DESC`).all(),
      stockCritico: req.db.prepare(`SELECT nombre, codigo, stock, stock_minimo FROM productos WHERE stock <= stock_minimo ORDER BY stock ASC`).all(),
      resumen: req.db.prepare(`SELECT COUNT(*) as total_ordenes, SUM(total) as total_facturado, AVG(total) as ticket_promedio, COUNT(CASE WHEN cobrado=1 THEN 1 END) as cobradas, COUNT(CASE WHEN estado='entregado' THEN 1 END) as entregadas FROM ordenes WHERE 1=1 ${filtroFecha}`).get(),
      ordenesPorEquipo: req.db.prepare(`SELECT equipo, COUNT(*) as cantidad FROM ordenes WHERE 1=1 ${filtroFecha} GROUP BY equipo ORDER BY cantidad DESC LIMIT 8`).all(),
      movimientosStock: req.db.prepare(`SELECT strftime('%Y-%m', fecha) as mes, tipo, SUM(cantidad) as cantidad FROM movimientos_stock GROUP BY mes, tipo ORDER BY mes DESC LIMIT 24`).all()
    };

    const fecha = new Date().toISOString().split('T')[0];
    const outputPath = require('path').join(UPLOADS_DIR, `reporte_${fecha}.xlsx`);
    const scriptPath = path.join(__dirname, 'generar_reporte.py');
    const jsonData = JSON.stringify(datos).replace(/'/g, "\\'");

    execSync(`python3 "${scriptPath}" '${jsonData}' "${outputPath}"`, { timeout: 30000 });

    res.download(outputPath, `Reporte_SysTech_${fecha}.xlsx`, () => {
      try { require('fs').unlinkSync(outputPath); } catch(e) {}
    });
  } catch(e) {
    console.error('Error generando reporte:', e.message);
    res.status(500).json({ error: 'Error al generar el reporte: ' + e.message });
  }
});

// Datos para etiqueta de producto
app.get('/api/print/producto/:id', authMiddleware, (req, res) => {
  const p = req.db.prepare('SELECT * FROM productos WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'No encontrado' });
  const cfg = {};
  req.db.prepare('SELECT * FROM config').all().forEach(r => cfg[r.clave]=r.valor);
  p.empresa = cfg.empresa_nombre || 'Servicio Técnico';
  p.logo    = cfg.logo_empresa || '';
  res.json(p);
});

// ─── GARANTÍA Y CONDICIONES DE ENTREGA ───────────────────────────────────────
// GET texto de garantía (admin)
app.get('/api/garantia/config', authMiddleware, (req, res) => {
  const rows = req.db.prepare('SELECT * FROM garantia_config').all();
  const cfg = {};
  rows.forEach(r => cfg[r.clave] = r.valor);
  res.json(cfg);
});

// PUT actualizar texto de garantía (solo admin)
app.put('/api/garantia/config', authMiddleware, adminOnly, (req, res) => {
  const { texto_garantia, exigir_aceptacion } = req.body;
  if (texto_garantia !== undefined) req.db.prepare("INSERT OR REPLACE INTO garantia_config (clave,valor) VALUES ('texto_garantia',?)").run(texto_garantia);
  if (exigir_aceptacion !== undefined) req.db.prepare("INSERT OR REPLACE INTO garantia_config (clave,valor) VALUES ('exigir_aceptacion',?)").run(exigir_aceptacion?'1':'0');
  res.json({ ok: true });
});

// GET texto de garantía (público, para el cliente que va a aceptar)
app.get('/api/garantia/texto/:ordenId', (req, res) => {
  const o = req.db.prepare('SELECT id,numero,estado FROM ordenes WHERE id=?').get(req.params.ordenId);
  if (!o) return res.status(404).json({ error: 'Orden no encontrada' });
  const texto = req.db.prepare("SELECT valor FROM garantia_config WHERE clave='texto_garantia'").get();
  const yaAcepto = req.db.prepare('SELECT id, fecha_aceptacion FROM garantia_aceptaciones WHERE orden_id=?').get(req.params.ordenId);
  res.json({
    numero: o.numero,
    estado: o.estado,
    texto: texto?.valor || '',
    ya_acepto: !!yaAcepto,
    fecha_aceptacion: yaAcepto?.fecha_aceptacion || null
  });
});

// POST aceptar garantía (el cliente firma digitalmente al retirar)
app.post('/api/garantia/aceptar/:ordenId', (req, res) => {
  const { cliente_nombre, firma_digital } = req.body;
  const o = req.db.prepare('SELECT id FROM ordenes WHERE id=?').get(req.params.ordenId);
  if (!o) return res.status(404).json({ error: 'Orden no encontrada' });

  const yaAcepto = req.db.prepare('SELECT id FROM garantia_aceptaciones WHERE orden_id=?').get(req.params.ordenId);
  if (yaAcepto) return res.json({ ok: true, ya_existia: true });

  const texto = req.db.prepare("SELECT valor FROM garantia_config WHERE clave='texto_garantia'").get();
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

  req.db.prepare(`INSERT INTO garantia_aceptaciones (orden_id,cliente_nombre,ip_origen,firma_digital,texto_aceptado) VALUES (?,?,?,?,?)`)
    .run(req.params.ordenId, cliente_nombre || '', ip, firma_digital || '', texto?.valor || '');

  res.json({ ok: true });
});

// GET ver aceptación de una orden (para admin/caja)
app.get('/api/garantia/aceptacion/:ordenId', authMiddleware, (req, res) => {
  const a = req.db.prepare('SELECT * FROM garantia_aceptaciones WHERE orden_id=?').get(req.params.ordenId);
  res.json(a || null);
});

// ─── RECURSOS TÉCNICOS — ACCESOS RÁPIDOS Y PLANOS ESQUEMÁTICOS ───────────────
const ENCRYPT_KEY = crypto.createHash('sha256').update('systech-recursos-2026').digest();

function encryptPass(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPT_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}
function decryptPass(encrypted) {
  if (!encrypted || !encrypted.includes(':')) return '';
  try {
    const [ivHex, dataHex] = encrypted.split(':');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPT_KEY, Buffer.from(ivHex, 'hex'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
    return decrypted.toString('utf8');
  } catch(e) { return ''; }
}

// ── ACCESOS RÁPIDOS (herramientas con login) ──
app.get('/api/recursos/accesos', authMiddleware, adminOnly, (req, res) => {
  const data = req.db.prepare('SELECT * FROM recursos_accesos WHERE activo=1 ORDER BY nombre').all();
  res.json(data.map(r => ({ ...r, password: decryptPass(r.password_enc), password_enc: undefined })));
});

app.post('/api/recursos/accesos', authMiddleware, adminOnly, (req, res) => {
  const { nombre, categoria, url, usuario, password, codigo_promo, descuento, notas } = req.body;
  if (!nombre) return res.status(400).json({ error: 'El nombre es obligatorio' });
  const r = req.db.prepare(`INSERT INTO recursos_accesos (nombre,categoria,url,usuario,password_enc,codigo_promo,descuento,notas) VALUES (?,?,?,?,?,?,?,?)`)
    .run(nombre, categoria||'Esquemáticos', url||'', usuario||'', encryptPass(password), codigo_promo||'', descuento||'', notas||'');
  res.json({ id: r.lastInsertRowid });
});

app.put('/api/recursos/accesos/:id', authMiddleware, adminOnly, (req, res) => {
  const { nombre, categoria, url, usuario, password, codigo_promo, descuento, notas } = req.body;
  // Si no envían password nueva, mantener la actual
  const actual = req.db.prepare('SELECT password_enc FROM recursos_accesos WHERE id=?').get(req.params.id);
  const passEnc = password ? encryptPass(password) : (actual?.password_enc || '');
  req.db.prepare(`UPDATE recursos_accesos SET nombre=?,categoria=?,url=?,usuario=?,password_enc=?,codigo_promo=?,descuento=?,notas=? WHERE id=?`)
    .run(nombre, categoria, url, usuario, passEnc, codigo_promo, descuento, notas, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/recursos/accesos/:id', authMiddleware, adminOnly, (req, res) => {
  req.db.prepare('UPDATE recursos_accesos SET activo=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── PLANOS ESQUEMÁTICOS (archivos) ──
const storagePlanos = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = require('path').join(UPLOADS_DIR, 'planos');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `plano_${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g,'_')}`)
});
const uploadPlano = multer({ storage: storagePlanos, limits: { fileSize: 20*1024*1024 } });

app.get('/api/recursos/planos', authMiddleware, adminOnly, (req, res) => {
  const { q, categoria } = req.query;
  let sql = 'SELECT * FROM recursos_planos WHERE activo=1';
  const params = [];
  if (q) { sql += ' AND (titulo LIKE ? OR marca LIKE ? OR modelo LIKE ?)'; const b=`%${q}%`; params.push(b,b,b); }
  if (categoria) { sql += ' AND categoria=?'; params.push(categoria); }
  sql += ' ORDER BY created_at DESC';
  res.json(req.db.prepare(sql).all(...params));
});

// Catálogo para técnicos/caja: NO devuelve archivo_url salvo que ya esté comprado (o sea admin).
// Así el esquema no se puede "ver" sin pagar, aunque se liste en el catálogo.
app.get('/api/recursos/planos/catalogo', authMiddleware, (req, res) => {
  const { q, categoria } = req.query;
  let sql = 'SELECT * FROM recursos_planos WHERE activo=1';
  const params = [];
  if (q) { sql += ' AND (titulo LIKE ? OR marca LIKE ? OR modelo LIKE ?)'; const b=`%${q}%`; params.push(b,b,b); }
  if (categoria) { sql += ' AND categoria=?'; params.push(categoria); }
  sql += ' ORDER BY created_at DESC';
  const planos = req.db.prepare(sql).all(...params);
  const comprados = new Set(
    req.db.prepare('SELECT plano_id FROM plano_compras WHERE usuario_id=?').all(req.user.usuario_id).map(c => c.plano_id)
  );
  res.json(planos.map(p => {
    const desbloqueado = req.user.rol === 'admin' || comprados.has(p.id);
    const { archivo_url, archivo_nombre, ...resto } = p;
    return { ...resto, desbloqueado, ...(desbloqueado ? { archivo_url, archivo_nombre } : {}) };
  }));
});

// Comprar/desbloquear un esquema con créditos
app.post('/api/recursos/planos/:id/comprar', authMiddleware, (req, res) => {
  const plano = req.db.prepare('SELECT * FROM recursos_planos WHERE id=? AND activo=1').get(req.params.id);
  if (!plano) return res.status(404).json({ error: 'Esquema no encontrado' });

  const yaComprado = req.db.prepare('SELECT id FROM plano_compras WHERE usuario_id=? AND plano_id=?').get(req.user.usuario_id, plano.id);
  if (yaComprado || req.user.rol === 'admin') return res.json({ ok: true, ya_desbloqueado: true });

  const usuario = req.db.prepare('SELECT creditos FROM usuarios WHERE id=?').get(req.user.usuario_id);
  if ((usuario?.creditos || 0) < plano.precio_creditos) {
    return res.status(402).json({ error: `Créditos insuficientes. Necesitás ${plano.precio_creditos}, tenés ${usuario?.creditos || 0}` });
  }

  const tx = req.db.transaction(() => {
    req.db.prepare('UPDATE usuarios SET creditos = creditos - ? WHERE id=?').run(plano.precio_creditos, req.user.usuario_id);
    req.db.prepare('INSERT INTO plano_compras (usuario_id,plano_id,precio_pagado) VALUES (?,?,?)').run(req.user.usuario_id, plano.id, plano.precio_creditos);
    req.db.prepare(`INSERT INTO creditos_movimientos (usuario_id,tipo,cantidad,motivo) VALUES (?,'gasto',?,?)`).run(req.user.usuario_id, plano.precio_creditos, `Esquema: ${plano.titulo}`);
  });
  tx();
  res.json({ ok: true });
});

// Saldo de créditos del usuario logueado
app.get('/api/mis-creditos', authMiddleware, (req, res) => {
  const u = req.db.prepare('SELECT creditos FROM usuarios WHERE id=?').get(req.user.usuario_id);
  res.json({ creditos: u?.creditos || 0 });
});

// Cargar créditos a un usuario (solo admin — hasta integrar pasarela de pago real)
app.post('/api/usuarios/:id/creditos', authMiddleware, adminOnly, (req, res) => {
  const cantidad = parseInt(req.body.cantidad);
  const motivo = req.body.motivo || 'Carga manual';
  if (!cantidad || cantidad === 0) return res.status(400).json({ error: 'Cantidad inválida' });
  const tx = req.db.transaction(() => {
    req.db.prepare('UPDATE usuarios SET creditos = MAX(0, creditos + ?) WHERE id=?').run(cantidad, req.params.id);
    req.db.prepare(`INSERT INTO creditos_movimientos (usuario_id,tipo,cantidad,motivo) VALUES (?,?,?,?)`).run(req.params.id, cantidad > 0 ? 'carga' : 'ajuste', Math.abs(cantidad), motivo);
  });
  tx();
  const u = req.db.prepare('SELECT creditos FROM usuarios WHERE id=?').get(req.params.id);
  res.json({ ok: true, creditos: u.creditos });
});

app.post('/api/recursos/planos', authMiddleware, adminOnly, (req, res, next) => {
  uploadPlano.single('archivo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const { titulo, marca, modelo, categoria, descripcion, precio_creditos } = req.body;
    if (!titulo) return res.status(400).json({ error: 'El título es obligatorio' });
    const archivo_url = req.file ? `/uploads/planos/${req.file.filename}` : '';
    const archivo_nombre = req.file ? req.file.originalname : '';
    const r = req.db.prepare(`INSERT INTO recursos_planos (titulo,marca,modelo,categoria,archivo_url,archivo_nombre,descripcion,precio_creditos) VALUES (?,?,?,?,?,?,?,?)`)
      .run(titulo, marca||'', modelo||'', categoria||'Celular', archivo_url, archivo_nombre, descripcion||'', parseInt(precio_creditos)||0);
    res.json({ id: r.lastInsertRowid });
  });
});

app.delete('/api/recursos/planos/:id', authMiddleware, adminOnly, (req, res) => {
  const p = req.db.prepare('SELECT archivo_url FROM recursos_planos WHERE id=?').get(req.params.id);
  if (p?.archivo_url) { try { const fp=path.join(__dirname,'public',p.archivo_url); if(fs.existsSync(fp)) fs.unlinkSync(fp); } catch(e){} }
  req.db.prepare('UPDATE recursos_planos SET activo=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ─── TECNIBOT: asistente de IA con base de conocimiento propia ────────────────
// Addon PAGO por taller: lo habilita el distribuidor (vos) desde el panel de
// gestión de talleres. Sin esto activado en el taller, el módulo entero queda
// bloqueado — no importa el rol del usuario dentro del taller.
function tecnibotHabilitado(req, res, next) {
  if (!req.tenant || req.tenant.tecnibot_habilitado !== 1) {
    return res.status(402).json({ error: 'Tecnibot no está incluido en tu plan actual. Contactá a SysTech para contratar el addon.' });
  }
  next();
}

// Info pública (para que el frontend sepa si mostrar el módulo en el menú, sin
// exponer nada sensible del taller)
app.get('/api/tecnibot/estado', authMiddleware, (req, res) => {
  res.json({ habilitado: req.tenant?.tecnibot_habilitado === 1 });
});

function tecnibotCfg(db) {
  const rows = db.prepare('SELECT clave,valor FROM tecnibot_config').all();
  const cfg = {}; rows.forEach(r => cfg[r.clave] = r.valor);
  return cfg;
}

// Config (solo admin) — la API key nunca sale de acá, nunca pasa por /api/config
app.get('/api/tecnibot/config', authMiddleware, tecnibotHabilitado, adminOnly, (req, res) => {
  const cfg = tecnibotCfg(req.db);
  res.json({
    tecnibot_activo: cfg.tecnibot_activo || '0',
    tecnibot_modelo: cfg.tecnibot_modelo || 'claude-sonnet-4-6',
    api_key_configurada: !!(cfg.tecnibot_api_key && cfg.tecnibot_api_key.length > 10),
    api_key_preview: cfg.tecnibot_api_key ? `${cfg.tecnibot_api_key.slice(0,10)}••••••••${cfg.tecnibot_api_key.slice(-4)}` : ''
  });
});
app.put('/api/tecnibot/config', authMiddleware, tecnibotHabilitado, adminOnly, (req, res) => {
  const { tecnibot_api_key, tecnibot_activo, tecnibot_modelo } = req.body;
  const stmt = req.db.prepare('INSERT OR REPLACE INTO tecnibot_config (clave,valor) VALUES (?,?)');
  if (tecnibot_api_key) stmt.run('tecnibot_api_key', tecnibot_api_key.trim()); // solo pisa si mandaron una nueva
  if (tecnibot_activo !== undefined) stmt.run('tecnibot_activo', tecnibot_activo ? '1' : '0');
  if (tecnibot_modelo) stmt.run('tecnibot_modelo', tecnibot_modelo);
  res.json({ ok: true });
});

// Base de conocimiento — CRUD (solo admin la edita; todos los roles la consultan a través del chat)
app.get('/api/tecnibot/articulos', authMiddleware, tecnibotHabilitado, adminOnly, (req, res) => {
  const { q } = req.query;
  let sql = 'SELECT * FROM tecnibot_articulos WHERE activo=1';
  const params = [];
  if (q) { sql += ' AND (titulo LIKE ? OR contenido LIKE ? OR palabras_clave LIKE ?)'; const b=`%${q}%`; params.push(b,b,b); }
  sql += ' ORDER BY categoria, titulo';
  res.json(req.db.prepare(sql).all(...params));
});
app.post('/api/tecnibot/articulos', authMiddleware, tecnibotHabilitado, adminOnly, (req, res) => {
  const { categoria, marca, titulo, contenido, modelo_aplicable, palabras_clave } = req.body;
  if (!titulo || !contenido) return res.status(400).json({ error: 'Título y contenido son obligatorios' });
  const r = req.db.prepare(`INSERT INTO tecnibot_articulos (categoria,marca,titulo,contenido,modelo_aplicable,palabras_clave) VALUES (?,?,?,?,?,?)`)
    .run(categoria||'General', marca||'Multimarca', titulo, contenido, modelo_aplicable||'Todos', palabras_clave||'');
  res.json({ id: r.lastInsertRowid });
});
app.put('/api/tecnibot/articulos/:id', authMiddleware, tecnibotHabilitado, adminOnly, (req, res) => {
  const { categoria, marca, titulo, contenido, modelo_aplicable, palabras_clave } = req.body;
  if (!titulo || !contenido) return res.status(400).json({ error: 'Título y contenido son obligatorios' });
  req.db.prepare(`UPDATE tecnibot_articulos SET categoria=?,marca=?,titulo=?,contenido=?,modelo_aplicable=?,palabras_clave=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(categoria||'General', marca||'Multimarca', titulo, contenido, modelo_aplicable||'Todos', palabras_clave||'', req.params.id);
  res.json({ ok: true });
});
app.delete('/api/tecnibot/articulos/:id', authMiddleware, tecnibotHabilitado, adminOnly, (req, res) => {
  req.db.prepare('UPDATE tecnibot_articulos SET activo=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Búsqueda simple por palabras clave en la base de conocimiento (igual idea que el Tecnibot original)
function buscarConocimientoTecnibot(db, mensaje) {
  const palabras = mensaje.toLowerCase()
    .split(/\s+/).map(p => p.replace(/[.,;:!?¿¡]/g, '')).filter(p => p.length > 3);
  if (!palabras.length) return [];
  const condiciones = palabras.map(() => '(titulo LIKE ? OR contenido LIKE ? OR palabras_clave LIKE ?)').join(' OR ');
  const params = [];
  palabras.forEach(p => { const b = `%${p}%`; params.push(b,b,b); });
  const candidatos = db.prepare(`SELECT * FROM tecnibot_articulos WHERE activo=1 AND (${condiciones})`).all(...params);
  // Relevancia simple: cuántas palabras clave de la consulta matchean cada artículo
  const puntuados = candidatos.map(a => {
    const texto = `${a.titulo} ${a.contenido} ${a.palabras_clave}`.toLowerCase();
    const score = palabras.reduce((acc,p) => acc + (texto.includes(p) ? 1 : 0), 0);
    return { ...a, score };
  }).sort((a,b) => b.score - a.score);
  return puntuados.slice(0, 6);
}

const TECNIBOT_SYSTEM_PROMPT = `Sos Tecnibot, un asistente técnico especializado en diagnóstico y reparación de
dispositivos electrónicos (celulares, tablets, notebooks, PC), con foco en Apple y marcas Android.
Trabajás para técnicos de taller reales.

- Respondés como un colega técnico con experiencia real, directo y práctico.
- Si el síntoma es vago, pedís el dato clave que falta (modelo exacto, mensaje que muestra el
  equipo, historial de reparaciones previas) antes de tirar un diagnóstico.
- Cuando corresponda, das el protocolo de diagnóstico paso a paso, con valores exactos de
  voltaje/corriente a medir.
- Sos claro sobre qué ES reparable y qué NO. Nunca prometés recuperar algo (como Face ID o Touch
  ID pareado) si la base de conocimiento indica que no tiene solución de terceros.
- Si la consulta excede tu base de conocimiento actual, lo decís con honestidad en vez de inventar.
- Además del diagnóstico técnico, podés responder consultas administrativas del taller (órdenes,
  stock, clientes, comprobantes) usando las herramientas disponibles.
- Respuestas concisas, en español rioplatense, con terminología técnica real. Sin asteriscos de
  Markdown para negritas — tu respuesta se muestra en una burbuja de chat de texto plano.`;

// Versión para Caja: SIN conocimiento técnico de reparación a propósito — Caja
// no diagnostica equipos, solo necesita el lado administrativo (facturación,
// estado de órdenes, clientes). Si le preguntan algo técnico, tiene que decir
// que no es su función, no inventar ni improvisar un diagnóstico.
const ASISTENTE_CAJA_SYSTEM_PROMPT = `Sos el Asistente de SysTech para el sector de Caja/Facturación de un
taller técnico. NO sos un asistente de diagnóstico técnico — no tenés conocimiento de reparación de
dispositivos y no debés intentar responder sobre eso.

- Ayudás con consultas administrativas: estado de órdenes, comprobantes/facturas emitidos, datos de
  clientes, y resumen general del taller (cobros pendientes, etc.) usando las herramientas disponibles.
- Si te preguntan algo técnico de reparación (diagnóstico, qué falla tiene un equipo, cómo arreglar
  algo), respondé con amabilidad que eso lo maneja Tecnibot en el sector de Taller, no vos.
- Solo CONSULTÁS información, nunca la modificás. Si piden crear/editar algo, explicás que hay que
  hacerlo desde el sistema directamente.
- Respuestas concisas, en español rioplatense. Sin asteriscos de Markdown — se muestra en una
  burbuja de chat de texto plano.`;

// ─── HERRAMIENTAS PARA EL ASISTENTE (Tecnibot y Asistente de Caja comparten estas) ─
// Solo lectura a propósito: le da datos reales del taller sin riesgo de que
// modifique algo por error o por una consulta mal interpretada. Si más adelante
// querés que también cree/edite cosas, se puede sumar como acción con
// confirmación explícita del usuario antes de ejecutarla.
const TECNIBOT_TOOLS = [
  {
    name: 'buscar_orden',
    description: 'Busca órdenes de trabajo por número, nombre de cliente o equipo. Usar cuando pregunten por el estado de una reparación.',
    input_schema: { type: 'object', properties: {
      texto: { type: 'string', description: 'Número de orden, nombre de cliente o modelo de equipo a buscar' }
    }, required: ['texto'] }
  },
  {
    name: 'consultar_stock',
    description: 'Busca productos/repuestos en el stock por nombre o código. Usar para saber si hay stock de un repuesto y su precio.',
    input_schema: { type: 'object', properties: {
      texto: { type: 'string', description: 'Nombre o código del producto a buscar' }
    }, required: ['texto'] }
  },
  {
    name: 'consultar_cliente',
    description: 'Busca datos de contacto de un cliente por nombre o teléfono.',
    input_schema: { type: 'object', properties: {
      texto: { type: 'string', description: 'Nombre o teléfono del cliente' }
    }, required: ['texto'] }
  },
  {
    name: 'consultar_comprobante',
    description: 'Busca facturas, presupuestos y notas emitidas por número o nombre de cliente. Usar para consultas de facturación: si se emitió, el total, el estado, la fecha.',
    input_schema: { type: 'object', properties: {
      texto: { type: 'string', description: 'Número de comprobante o nombre de cliente' }
    }, required: ['texto'] }
  },
  {
    name: 'resumen_taller',
    description: 'Trae un resumen general del estado del taller ahora mismo: órdenes activas, cobros pendientes, productos con stock bajo. Usar para preguntas generales tipo "cómo estamos hoy" o "qué hay pendiente".',
    input_schema: { type: 'object', properties: {} }
  }
];

function ejecutarHerramientaTecnibot(db, nombre, input) {
  const b = `%${(input.texto||'').trim()}%`;
  switch (nombre) {
    case 'buscar_orden': {
      const rows = db.prepare(`
        SELECT o.numero,o.equipo,o.marca,o.modelo,o.estado,o.total,o.cobrado,o.fecha_ingreso,c.nombre as cliente
        FROM ordenes o LEFT JOIN clientes c ON o.cliente_id=c.id
        WHERE o.numero LIKE ? OR o.equipo LIKE ? OR c.nombre LIKE ?
        ORDER BY o.fecha_ingreso DESC LIMIT 8
      `).all(b,b,b);
      return rows.length ? rows : { mensaje: 'No se encontraron órdenes con ese criterio.' };
    }
    case 'consultar_stock': {
      const rows = db.prepare(`SELECT codigo,nombre,categoria,stock,stock_minimo,precio_venta FROM productos WHERE nombre LIKE ? OR codigo LIKE ? ORDER BY nombre LIMIT 8`).all(b,b);
      return rows.length ? rows : { mensaje: 'No se encontraron productos con ese criterio.' };
    }
    case 'consultar_cliente': {
      const rows = db.prepare(`SELECT nombre,telefono,email,direccion FROM clientes WHERE nombre LIKE ? OR telefono LIKE ? LIMIT 8`).all(b,b);
      return rows.length ? rows : { mensaje: 'No se encontraron clientes con ese criterio.' };
    }
    case 'consultar_comprobante': {
      const rows = db.prepare(`
        SELECT numero,tipo,letra,cliente_nombre,cliente_apellido,total,estado,fecha
        FROM comprobantes WHERE numero LIKE ? OR cliente_nombre LIKE ? OR cliente_apellido LIKE ?
        ORDER BY fecha DESC LIMIT 8
      `).all(b,b,b);
      return rows.length ? rows : { mensaje: 'No se encontraron comprobantes con ese criterio.' };
    }
    case 'resumen_taller': {
      return {
        ordenes_activas: db.prepare(`SELECT COUNT(*) as c FROM ordenes WHERE estado NOT IN ('entregado','cancelado')`).get().c,
        cobros_pendientes: db.prepare(`SELECT COUNT(*) as c FROM ordenes WHERE estado='listo' AND cobrado=0`).get().c,
        productos_bajo_stock: db.prepare(`SELECT COUNT(*) as c FROM productos WHERE stock<=stock_minimo`).get().c,
        ordenes_por_estado: db.prepare(`SELECT estado,COUNT(*) as cantidad FROM ordenes GROUP BY estado`).all()
      };
    }
    default:
      return { error: 'Herramienta desconocida' };
  }
}

app.post('/api/tecnibot/chat', authMiddleware, tecnibotHabilitado, async (req, res) => {
  try {
    const cfg = tecnibotCfg(req.db);
    if (cfg.tecnibot_activo !== '1') return res.status(403).json({ error: 'Tecnibot está desactivado. Activalo desde Configuración.' });
    if (!cfg.tecnibot_api_key) return res.status(500).json({ error: 'Falta configurar la clave de API de Claude (Configuración → Tecnibot).' });

    const { messages } = req.body;
    if (!messages || !Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'Faltan mensajes' });

    // Taller y Admin tienen el diagnóstico técnico completo. Caja tiene la misma
    // "cabeza" (Claude + mismas herramientas de consulta), pero sin la base de
    // conocimiento técnica — así no puede improvisar un diagnóstico de reparación.
    const tieneAccesoTecnico = ['taller', 'admin'].includes(req.user.rol);

    const ultimoMensaje = messages[messages.length - 1];
    let systemPrompt;
    let articulos = [];

    if (tieneAccesoTecnico) {
      articulos = buscarConocimientoTecnibot(req.db, ultimoMensaje.content || '');
      const conocimiento = articulos.length
        ? articulos.map(a => `### ${a.titulo}\n${a.contenido}`).join('\n\n---\n\n')
        : '(Sin artículos relevantes en la base de conocimiento para esta consulta.)';
      systemPrompt = `${TECNIBOT_SYSTEM_PROMPT}\n\nADEMÁS DE DIAGNÓSTICO TÉCNICO, PODÉS AYUDAR CON TAREAS ADMINISTRATIVAS del taller:\n` +
        `estado de órdenes, stock de repuestos, datos de clientes, comprobantes y resúmenes generales,\n` +
        `usando las herramientas disponibles. Solo podés consultar información, no modificarla — si te\n` +
        `piden crear, editar o borrar algo, explicá que eso todavía hay que hacerlo desde el sistema.\n\n` +
        `BASE DE CONOCIMIENTO TÉCNICO RELEVANTE PARA ESTA CONSULTA:\n${conocimiento}`;
    } else {
      systemPrompt = ASISTENTE_CAJA_SYSTEM_PROMPT;
    }

    let conversacion = messages.map(m => ({ role: m.role, content: m.content }));
    let replyText = '';
    const MAX_TURNOS_HERRAMIENTA = 4;

    for (let turno = 0; turno < MAX_TURNOS_HERRAMIENTA; turno++) {
      const respuesta = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.tecnibot_api_key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: cfg.tecnibot_modelo || 'claude-sonnet-4-6',
          max_tokens: 800,
          system: systemPrompt,
          tools: TECNIBOT_TOOLS,
          messages: conversacion
        })
      });
      const data = await respuesta.json();
      if (!respuesta.ok) {
        console.error('Error de la API de Claude:', data);
        return res.status(502).json({ error: data?.error?.message || 'Error al contactar a Claude' });
      }

      replyText = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');

      if (data.stop_reason !== 'tool_use') break; // respuesta final, sin más herramientas que ejecutar

      const bloquesHerramienta = data.content.filter(b => b.type === 'tool_use');
      conversacion.push({ role: 'assistant', content: data.content });
      conversacion.push({
        role: 'user',
        content: bloquesHerramienta.map(tb => ({
          type: 'tool_result',
          tool_use_id: tb.id,
          content: JSON.stringify(ejecutarHerramientaTecnibot(req.db, tb.name, tb.input))
        }))
      });
      // el próximo ciclo del for vuelve a llamar a Claude con el resultado de la herramienta
    }

    // Guardamos el historial (útil para revisar qué preguntan los técnicos y qué le falta a la base)
    const insertConv = req.db.prepare(`INSERT INTO tecnibot_conversaciones (usuario_id,usuario_nombre,rol,mensaje) VALUES (?,?,?,?)`);
    insertConv.run(req.user.usuario_id, req.user.nombre, 'usuario', ultimoMensaje.content);
    insertConv.run(req.user.usuario_id, req.user.nombre, 'asistente', replyText);

    res.json({ reply: replyText, fuentes: articulos.map(a => a.titulo) });
  } catch (e) {
    console.error('Error en /api/tecnibot/chat:', e);
    res.status(500).json({ error: 'Hubo un problema generando la respuesta. Intentá de nuevo.' });
  }
});

// Historial de conversaciones (admin) — para ver qué preguntan los técnicos
app.get('/api/tecnibot/historial', authMiddleware, tecnibotHabilitado, adminOnly, (req, res) => {
  res.json(req.db.prepare('SELECT * FROM tecnibot_conversaciones ORDER BY fecha DESC LIMIT 200').all());
});

// ─── CHEQUEO DE IMEI ROBADO/BLOQUEADO (imeicheck.com) ──────────────────────────
function imeicheckCfg(db) {
  const rows = db.prepare('SELECT clave,valor FROM imeicheck_config').all();
  const cfg = {}; rows.forEach(r => cfg[r.clave] = r.valor);
  return cfg;
}

app.get('/api/imeicheck/config', authMiddleware, adminOnly, (req, res) => {
  const cfg = imeicheckCfg(req.db);
  res.json({
    activo: cfg.activo, service_id: cfg.service_id,
    api_key_configurada: !!(cfg.api_key && cfg.api_key.length > 8),
    api_key_preview: cfg.api_key ? `${cfg.api_key.slice(0,6)}••••••••${cfg.api_key.slice(-4)}` : ''
  });
});
app.put('/api/imeicheck/config', authMiddleware, adminOnly, (req, res) => {
  const { api_key, activo, service_id } = req.body;
  const stmt = req.db.prepare('INSERT OR REPLACE INTO imeicheck_config (clave,valor) VALUES (?,?)');
  if (api_key) stmt.run('api_key', api_key.trim());
  if (activo !== undefined) stmt.run('activo', activo ? '1' : '0');
  if (service_id) stmt.run('service_id', String(service_id).trim());
  res.json({ ok: true });
});

// Consulta el estado del equipo (cualquier rol logueado puede usarlo, se
// necesita al ingreso). Devuelve un resultado simplificado además del
// original completo, por si el formato de respuesta real difiere del
// documentado y hay que ajustar el parseo más adelante.
app.get('/api/imeicheck/saldo', authMiddleware, adminOnly, async (req, res) => {
  try {
    const cfg = imeicheckCfg(req.db);
    if (!cfg.api_key) return res.status(500).json({ error: 'Falta configurar la clave de API' });
    const resp = await fetch(`https://alpha.imeicheck.com/api/php-api/balance?key=${encodeURIComponent(cfg.api_key)}`);
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'No se pudo consultar el saldo' });
  }
});

app.post('/api/imeicheck/verificar', authMiddleware, async (req, res) => {
  try {
    const { imei } = req.body;
    if (!imei || !/^\d{14,16}$/.test(imei.replace(/\s/g,''))) {
      return res.status(400).json({ error: 'IMEI inválido — tiene que ser un número de 14 a 16 dígitos' });
    }
    const cfg = imeicheckCfg(req.db);
    if (cfg.activo !== '1') return res.status(403).json({ error: 'El chequeo de IMEI está desactivado. Activalo desde Configuración.' });
    if (!cfg.api_key) return res.status(500).json({ error: 'Falta configurar la clave de API de IMEICheck en Configuración.' });

    // API real de imeicheck.com (confirmada con su documentación): GET con la
    // clave y el servicio como parámetros de URL. Servicio 5 = "Blacklist
    // Status (GSMA)", que es justo el chequeo de robo/bloqueo.
    const url = `https://alpha.imeicheck.com/api/php-api/create?key=${encodeURIComponent(cfg.api_key)}&service=${encodeURIComponent(cfg.service_id || '5')}&imei=${encodeURIComponent(imei.replace(/\s/g,''))}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.status === 'error') {
      console.error('Error de IMEICheck:', data);
      const msg = (data.result || '').includes('IP') ? 'IP no autorizada — andá a tu panel de imeicheck.com → "Linked IP" → Disable o Reset IP'
        : (data.result || '').includes('redit') ? 'Sin crédito suficiente en tu cuenta de imeicheck.com'
        : data.result || 'Error del servicio de IMEI';
      return res.status(502).json({ error: msg });
    }
    if (data.status === 'failed') {
      return res.status(502).json({ error: data.result || 'La consulta fue rechazada' });
    }

    // "object" trae los datos estructurados (confirmado que el servicio 5 lo
    // incluye). Buscamos el campo de blacklist con varios nombres posibles,
    // ya que no tengo el schema exacto de ESTE servicio en particular — si no
    // matchea ninguno, igual mandamos "result" (texto HTML) para mostrar algo útil.
    const obj = data.object || {};
    const camposPosibles = ['blacklisted','blacklist','isBlacklisted','black_list_status'];
    let robado = null;
    for (const campo of camposPosibles) {
      if (obj[campo] !== undefined) {
        robado = obj[campo] === true || /clean|no|false/i.test(String(obj[campo])) ? (/clean/i.test(String(obj[campo])) ? false : !!obj[campo]) : true;
        break;
      }
    }

    res.json({
      robado,
      resultadoTexto: data.result || null, // texto/HTML tal cual lo manda el servicio, siempre útil de mostrar
      object: obj,
      precio: data.price || null,
      orderId: data.orderId || null
    });
  } catch (e) {
    console.error('Error en /api/imeicheck/verificar:', e);
    res.status(500).json({ error: 'No se pudo completar la consulta. Intentá de nuevo.' });
  }
});

// ─── REPORTES ─────────────────────────────────────────────────────────────────
app.get('/api/reportes/datos', authMiddleware, (req, res) => {
  const { desde, hasta } = req.query;
  const filtroFecha = desde && hasta ? `AND date(o.fecha_ingreso) BETWEEN '${desde}' AND '${hasta}'` : '';

  const ordenesPorEstado = req.db.prepare(`SELECT estado, COUNT(*) as cantidad FROM ordenes WHERE 1=1 ${filtroFecha.replace('o.','').replace('date(o.fecha_ingreso)','date(fecha_ingreso)')} GROUP BY estado`).all();
  const ordenesPorMes = req.db.prepare(`SELECT strftime('%Y-%m', fecha_ingreso) as mes, COUNT(*) as cantidad, SUM(total) as total FROM ordenes WHERE 1=1 ${filtroFecha.replace('o.','').replace('date(o.fecha_ingreso)','date(fecha_ingreso)')} GROUP BY mes ORDER BY mes DESC LIMIT 12`).all().reverse();
  const repuestosMasUsados = req.db.prepare(`SELECT p.nombre, p.codigo, SUM(or2.cantidad) as total_usado, SUM(or2.subtotal) as total_facturado FROM orden_repuestos or2 JOIN productos p ON or2.producto_id=p.id GROUP BY p.id ORDER BY total_usado DESC LIMIT 10`).all();
  const ingresosPorTecnico = req.db.prepare(`SELECT tecnico, COUNT(*) as ordenes, SUM(total) as total FROM ordenes WHERE tecnico IS NOT NULL AND tecnico != '' ${filtroFecha.replace('o.','').replace('date(o.fecha_ingreso)','date(fecha_ingreso)')} GROUP BY tecnico ORDER BY total DESC`).all();
  const stockCritico = req.db.prepare(`SELECT nombre, codigo, stock, stock_minimo FROM productos WHERE stock <= stock_minimo ORDER BY stock ASC`).all();
  const resumen = req.db.prepare(`SELECT COUNT(*) as total_ordenes, SUM(total) as total_facturado, AVG(total) as ticket_promedio, COUNT(CASE WHEN cobrado=1 THEN 1 END) as cobradas, COUNT(CASE WHEN estado='entregado' THEN 1 END) as entregadas FROM ordenes WHERE 1=1 ${filtroFecha.replace('o.','').replace('date(o.fecha_ingreso)','date(fecha_ingreso)')}`).get();
  const ordenesPorEquipo = req.db.prepare(`SELECT equipo, COUNT(*) as cantidad FROM ordenes WHERE 1=1 ${filtroFecha.replace('o.','').replace('date(o.fecha_ingreso)','date(fecha_ingreso)')} GROUP BY equipo ORDER BY cantidad DESC LIMIT 8`).all();
  const movimientosStock = req.db.prepare(`SELECT strftime('%Y-%m', fecha) as mes, tipo, SUM(cantidad) as cantidad FROM movimientos_stock GROUP BY mes, tipo ORDER BY mes DESC LIMIT 24`).all();

  res.json({ ordenesPorEstado, ordenesPorMes, repuestosMasUsados, ingresosPorTecnico, stockCritico, resumen, ordenesPorEquipo, movimientosStock });
});

// ─── ARCA / AFIP — FACTURACIÓN ELECTRÓNICA ───────────────────────────────────
const { obtenerToken }                       = require('./arca/wsaa');
const { solicitarCAE, ultimoComprobante, serverStatus, TIPO_COMP, TIPO_DOC } = require('./arca/wsfe');
const multerArca = require('multer');

// Config ARCA por defecto
// Subir certificado (.crt) y clave (.key)
const storageArca = multerArca.diskStorage({
  destination:(req,file,cb)=>{
    const d=path.join(__dirname,'arca','certs');
    if(!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true});
    cb(null,d);
  },
  filename:(req,file,cb)=>cb(null,file.fieldname+path.extname(file.originalname))
});
const uploadArca = multerArca({storage:storageArca, limits:{fileSize:1024*1024}});

app.post('/api/arca/upload-cert', uploadArca.fields([
  {name:'cert',maxCount:1},{name:'key',maxCount:1}
]), authMiddleware, adminOnly, (req,res)=>{
  const files = req.files;
  if(files.cert) req.db.prepare("INSERT OR REPLACE INTO config_fiscal (clave,valor) VALUES ('arca_cert_path',?)").run(files.cert[0].path);
  if(files.key)  req.db.prepare("INSERT OR REPLACE INTO config_fiscal (clave,valor) VALUES ('arca_key_path',?)").run(files.key[0].path);
  res.json({ok:true, cert:!!files.cert, key:!!files.key});
});

// Helper: obtener config ARCA (recibe la base del taller actual)
function getArcaCfg(tenantDb) {
  const rows = tenantDb.prepare('SELECT * FROM config_fiscal').all();
  const c={};rows.forEach(r=>c[r.clave]=r.valor);
  return c;
}

// Helper: leer cert y key
function leerCreds(cfg) {
  if(!cfg.arca_cert_path||!cfg.arca_key_path) throw new Error('Certificado o clave no configurados');
  if(!fs.existsSync(cfg.arca_cert_path)) throw new Error('Archivo de certificado no encontrado');
  if(!fs.existsSync(cfg.arca_key_path))  throw new Error('Archivo de clave no encontrado');
  return {
    cert: fs.readFileSync(cfg.arca_cert_path,'utf8'),
    key:  fs.readFileSync(cfg.arca_key_path,'utf8')
  };
}

// Test de conexión con ARCA
app.get('/api/arca/test', authMiddleware, adminOnly, async(req,res)=>{
  try {
    const cfg  = getArcaCfg(req.db);
    const prod = cfg.arca_produccion==='1';
    const {cert,key} = leerCreds(cfg);
    const auth = await obtenerToken(cert,key,'wsfe',prod);
    const status = await serverStatus(auth,cfg.arca_cuit,prod);
    req.db.prepare("INSERT INTO arca_log (accion,response,resultado) VALUES (?,?,?)").run('test',JSON.stringify(status),'OK');
    res.json({ok:true, ambiente:prod?'PRODUCCIÓN':'HOMOLOGACIÓN (prueba)', ...status});
  } catch(e) {
    res.status(500).json({ok:false,error:e.message});
  }
});

// Emitir factura electrónica con CAE
app.post('/api/arca/emitir/:compId', authMiddleware, async(req,res)=>{
  try {
    const cfg  = getArcaCfg(req.db);
    if(cfg.arca_habilitado!=='1') return res.status(400).json({error:'ARCA no está habilitado en la configuración'});

    const comp = req.db.prepare('SELECT * FROM comprobantes WHERE id=?').get(req.params.compId);
    if(!comp) return res.status(404).json({error:'Comprobante no encontrado'});
    if(comp.tipo==='presupuesto') return res.status(400).json({error:'Los presupuestos no se envían a ARCA'});
    if(comp.cae) return res.status(400).json({error:'Este comprobante ya tiene CAE: '+comp.cae});

    const prod = cfg.arca_produccion==='1';
    const {cert,key} = leerCreds(cfg);
    const cuit = cfg.arca_cuit.replace(/[-]/g,'');
    const ptoVenta = parseInt(cfg.arca_punto_venta||'1');
    const condicion = cfg.arca_condicion||'monotributo';

    // Determinar tipo de comprobante
    let tipoComp;
    if(condicion==='monotributo') {
      tipoComp = TIPO_COMP['factura_c_monotributo']; // 11
    } else {
      tipoComp = comp.letra==='A' ? TIPO_COMP['factura_a'] : TIPO_COMP['factura_b'];
    }
    if(comp.tipo==='nota_credito') {
      tipoComp = condicion==='monotributo' ? TIPO_COMP['nota_credito_c'] :
                 comp.letra==='A' ? TIPO_COMP['nota_credito_a'] : TIPO_COMP['nota_credito_b'];
    }

    // Autenticar
    const auth = await obtenerToken(cert,key,'wsfe',prod);

    // Obtener próximo número
    const ultimoNro = await ultimoComprobante(auth,cuit,ptoVenta,tipoComp,prod);
    const cbteNro   = ultimoNro + 1;

    // Tipo de documento del cliente
    const docTipo = TIPO_DOC[comp.cliente_doc_tipo] || 99;
    const docNro  = comp.cliente_doc_numero || '0';

    // Importes
    const importeTotal = parseFloat(comp.total)||0;
    const importeIVA   = parseFloat(comp.iva_monto)||0;
    const importeNeto  = importeTotal - importeIVA;

    const datos = {
      cuit, ptoVenta, tipoComp,
      cbteNro, cbteDesde:cbteNro, cbteHasta:cbteNro,
      docTipo, docNro: parseInt(docNro.replace(/\D/g,''))||0,
      importeTotal, importeNeto, importeIVA,
      condicionIVA: comp.cliente_condicion_iva, concepto:1
    };

    req.db.prepare("INSERT INTO arca_log (comprobante_id,accion,request,resultado) VALUES (?,?,?,?)").run(comp.id,'solicitar_cae',JSON.stringify(datos),'ENVIANDO');

    const resultado = await solicitarCAE(auth,datos,prod);

    if(resultado.ok) {
      // Formatear fecha vencimiento CAE: 20260630 → 30/06/2026
      const v = resultado.vencimientoCAE;
      const vFmt = v ? `${v.slice(6,8)}/${v.slice(4,6)}/${v.slice(0,4)}` : '';
      req.db.prepare('UPDATE comprobantes SET cae=?,cae_vencimiento=?,estado=? WHERE id=?').run(resultado.cae,vFmt,'emitido',comp.id);
      req.db.prepare("UPDATE arca_log SET response=?,resultado=? WHERE comprobante_id=? ORDER BY id DESC LIMIT 1").run(JSON.stringify(resultado),'APROBADO',comp.id);
      res.json({ok:true, cae:resultado.cae, vencimiento:vFmt, numero:cbteNro});
    } else {
      req.db.prepare("UPDATE arca_log SET response=?,resultado=? WHERE comprobante_id=? ORDER BY id DESC LIMIT 1").run(JSON.stringify(resultado),'RECHAZADO',comp.id);
      res.status(400).json({ok:false, error:resultado.error});
    }
  } catch(e) {
    res.status(500).json({ok:false,error:e.message});
  }
});

// Log de operaciones ARCA
app.get('/api/arca/log', authMiddleware, adminOnly, (req,res)=>{
  res.json(req.db.prepare('SELECT l.*,c.numero as comp_numero FROM arca_log l LEFT JOIN comprobantes c ON l.comprobante_id=c.id ORDER BY l.fecha DESC LIMIT 100').all());
});

// Config ARCA
app.get('/api/arca/config', authMiddleware, adminOnly, (req,res)=>{
  const cfg=getArcaCfg(req.db);
  res.json({
    produccion:  cfg.arca_produccion==='1',
    cuit:        cfg.arca_cuit||'',
    punto_venta: cfg.arca_punto_venta||'1',
    condicion:   cfg.arca_condicion||'monotributo',
    habilitado:  cfg.arca_habilitado==='1',
    tiene_cert:  !!(cfg.arca_cert_path && fs.existsSync(cfg.arca_cert_path)),
    tiene_key:   !!(cfg.arca_key_path  && fs.existsSync(cfg.arca_key_path))
  });
});

app.put('/api/arca/config', authMiddleware, adminOnly, (req,res)=>{
  const {produccion,cuit,punto_venta,condicion,habilitado}=req.body;
  const updates={
    arca_produccion:  produccion?'1':'0',
    arca_cuit:        cuit||'',
    arca_punto_venta: String(punto_venta||1),
    arca_condicion:   condicion||'monotributo',
    arca_habilitado:  habilitado?'1':'0'
  };
  Object.entries(updates).forEach(([k,v])=>req.db.prepare('INSERT OR REPLACE INTO config_fiscal (clave,valor) VALUES (?,?)').run(k,v));
  res.json({ok:true});
});

// Endpoint para que el frontend sepa la IP correcta del servidor
app.get('/api/server-info', (req, res) => {
  res.json({ ip: LOCAL_IP, port: PORT, url: `http://${LOCAL_IP}:${PORT}` });
});

// ─── PORTAL CLIENTE (público, sin auth) ──────────────────────────────────────

// Buscar orden por número
app.get('/api/cliente/orden/:numero', (req, res) => {
  const o = req.db.prepare(`
    SELECT o.numero, o.equipo, o.marca, o.modelo, o.estado, o.prioridad,
           o.falla_reportada, o.diagnostico, o.mano_obra, o.total_repuestos,
           o.total, o.fecha_ingreso, o.fecha_entrega, o.tecnico, o.cobrado,
           o.presupuesto_aprobado, o.comentario_cliente,
           c.nombre as cliente_nombre
    FROM ordenes o
    LEFT JOIN clientes c ON o.cliente_id = c.id
    WHERE o.numero = ?
  `).get(req.params.numero.toUpperCase());
  if (!o) return res.status(404).json({ error: 'Orden no encontrada' });
  res.json(o);
});

// Buscar órdenes por teléfono
app.get('/api/cliente/telefono/:tel', (req, res) => {
  const tel = req.params.tel.replace(/\D/g, '');
  const ordenes = req.db.prepare(`
    SELECT o.numero, o.equipo, o.marca, o.modelo, o.estado, o.prioridad,
           o.fecha_ingreso, o.total, o.cobrado
    FROM ordenes o
    JOIN clientes c ON o.cliente_id = c.id
    WHERE REPLACE(REPLACE(REPLACE(c.telefono,'-',''),' ',''),'(','') LIKE ?
    ORDER BY o.fecha_ingreso DESC
  `).all(`%${tel}%`);
  if (!ordenes.length) return res.status(404).json({ error: 'No se encontraron órdenes para ese teléfono' });
  res.json(ordenes);
});

// Cliente aprueba o rechaza presupuesto
app.post('/api/cliente/orden/:numero/presupuesto', (req, res) => {
  const { aprobado, comentario } = req.body;
  const o = req.db.prepare('SELECT id FROM ordenes WHERE numero = ?').get(req.params.numero.toUpperCase());
  if (!o) return res.status(404).json({ error: 'Orden no encontrada' });
  req.db.prepare('UPDATE ordenes SET presupuesto_aprobado = ?, comentario_cliente = ? WHERE id = ?')
    .run(aprobado ? 1 : 0, comentario || '', o.id);
  res.json({ ok: true });
});

// Cliente deja comentario
app.post('/api/cliente/orden/:numero/comentario', (req, res) => {
  const { comentario } = req.body;
  const o = req.db.prepare('SELECT id FROM ordenes WHERE numero = ?').get(req.params.numero.toUpperCase());
  if (!o) return res.status(404).json({ error: 'Orden no encontrada' });
  req.db.prepare('UPDATE ordenes SET comentario_cliente = ? WHERE id = ?').run(comentario, o.id);
  res.json({ ok: true });
});

// Config pública (nombre empresa, colores)
app.get('/api/cliente/config', (req, res) => {
  const rows = req.db.prepare("SELECT * FROM config").all();
  const cfg = {};
  rows.forEach(r => cfg[r.clave] = r.valor);
  res.json({
    empresa_nombre: cfg.empresa_nombre || 'Servicio Técnico',
    empresa_telefono: cfg.empresa_telefono || '',
    empresa_whatsapp: cfg.empresa_whatsapp || '',
    color_accent: cfg.color_accent || '#4f8ef7',
    color_accent2: cfg.color_accent2 || '#38d9a9'
  });
});

// ─── DISTRIBUIDOR: PANEL DE CONTROL MULTI-TENANT ─────────────────────────────
// Sistema separado del login de cada taller — es exclusivamente para vos,
// el dueño del negocio, para ver y administrar todos los talleres dados de alta.

function distribuidorAuth(req, res, next) {
  const token = req.headers['x-distribuidor-token'];
  const sesion = validarSesionDistribuidor(token);
  if (!sesion) return res.status(401).json({ error: 'Sesión de distribuidor inválida o expirada' });
  req.distribuidorUser = sesion;
  next();
}

// Login del distribuidor
app.post('/api/distribuidor/login', (req, res) => {
  const { usuario, password } = req.body;
  if (!usuario || !password) return res.status(400).json({ error: 'Usuario y contraseña son obligatorios' });
  const sesion = loginDistribuidor(usuario, password);
  if (!sesion) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  res.json(sesion);
});

// Cambiar contraseña del distribuidor
app.post('/api/distribuidor/cambiar-password', distribuidorAuth, (req, res) => {
  const { password_actual, password_nueva } = req.body;
  if (!password_actual || !password_nueva) return res.status(400).json({ error: 'Faltan datos' });
  if (password_nueva.length < 6) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
  try {
    cambiarPasswordDistribuidor(req.distribuidorUser.usuario, password_actual, password_nueva);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Listar todos los talleres con info calculada (días para vencer, estado)
app.get('/api/distribuidor/talleres', distribuidorAuth, (req, res) => {
  const talleres = listarTalleres().map(t => {
    let diasParaVencer = null;
    let vencido = false;
    if (t.fecha_vencimiento) {
      const hoy = new Date();
      const venc = new Date(t.fecha_vencimiento);
      diasParaVencer = Math.ceil((venc - hoy) / (1000 * 60 * 60 * 24));
      vencido = diasParaVencer < 0;
    }
    return { ...t, dias_para_vencer: diasParaVencer, vencido };
  });
  res.json(talleres);
});

// Crear un nuevo taller (alta manual al confirmar el pago de un cliente)
app.post('/api/distribuidor/talleres', distribuidorAuth, (req, res) => {
  const { subdominio, nombre, plan, email_contacto, telefono_contacto, notas, fecha_vencimiento, tecnibot_habilitado } = req.body;
  if (!subdominio || !nombre) return res.status(400).json({ error: 'Subdominio y nombre son obligatorios' });
  if (!/^[a-z0-9-]+$/.test(subdominio)) {
    return res.status(400).json({ error: 'El subdominio solo puede tener letras minúsculas, números y guiones' });
  }
  try {
    crearTaller({ subdominio, nombre, plan, email_contacto, telefono_contacto, notas, fecha_vencimiento, tecnibot_habilitado });
    res.json({
      ok: true,
      subdominio,
      url: `https://${subdominio}.systech.com`,
      mensaje: `Taller "${nombre}" creado correctamente. Usuario admin por defecto: admin / admin123`
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Editar datos de un taller (plan, vencimiento, contacto, notas)
app.put('/api/distribuidor/talleres/:subdominio', distribuidorAuth, (req, res) => {
  if (req.params.subdominio === 'default') {
    return res.status(400).json({ error: 'El taller "default" (instalación local) no se gestiona desde aquí' });
  }
  try {
    actualizarTaller(req.params.subdominio, req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Activar / desactivar un taller (pausa por falta de pago, reactivación, etc.)
app.put('/api/distribuidor/talleres/:subdominio/estado', distribuidorAuth, (req, res) => {
  const { activo } = req.body;
  actualizarTaller(req.params.subdominio, { activo: activo ? 1 : 0 });
  res.json({ ok: true });
});

// Eliminar un taller definitivamente (cancelación, borra todos sus datos)
app.delete('/api/distribuidor/talleres/:subdominio', distribuidorAuth, (req, res) => {
  try {
    eliminarTaller(req.params.subdominio);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── INICIAR SERVIDOR ─────────────────────────────────────────────────────────
// ─── ACTUALIZACIONES AUTOMÁTICAS (solo para instalaciones locales) ────────────
// Chequea contra un archivo público (version.json) si hay una versión más
// nueva, y si el admin confirma, descarga el zip y lo aplica — SIN TOCAR
// NUNCA la carpeta data/ ni arca/certs/ (ahí vive todo lo del cliente).
const AdmZip = require('adm-zip');
const VERSION_URL = process.env.UPDATE_VERSION_URL || 'https://raw.githubusercontent.com/systechsolucionez-ui/systech-web/main/updates/sistema-tecnico/version.json';
const VERSION_ACTUAL = (() => {
  try { return require('fs').readFileSync(require('path').join(__dirname, 'VERSION'), 'utf-8').trim(); }
  catch { return '0.0.0'; }
})();

function versionEsMasNueva(remota, local) {
  const a = remota.split('.').map(Number), b = local.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i]||0) > (b[i]||0)) return true; if ((a[i]||0) < (b[i]||0)) return false; }
  return false;
}

app.get('/api/sistema/version', authMiddleware, (req, res) => {
  res.json({ version_actual: VERSION_ACTUAL });
});

app.get('/api/sistema/buscar-actualizacion', authMiddleware, adminOnly, async (req, res) => {
  try {
    const r = await fetch(VERSION_URL);
    if (!r.ok) return res.status(502).json({ error: 'No se pudo consultar el servidor de actualizaciones' });
    const remoto = await r.json();
    const hayNueva = versionEsMasNueva(remoto.version, VERSION_ACTUAL);
    res.json({ version_actual: VERSION_ACTUAL, version_disponible: remoto.version, hay_actualizacion: hayNueva, notas: remoto.notas || '' });
  } catch (e) {
    console.error('Error buscando actualización:', e);
    res.status(500).json({ error: 'No se pudo conectar al servidor de actualizaciones. Revisá tu conexión a internet.' });
  }
});

app.post('/api/sistema/aplicar-actualizacion', authMiddleware, adminOnly, async (req, res) => {
  try {
    const r = await fetch(VERSION_URL);
    const remoto = await r.json();
    if (!versionEsMasNueva(remoto.version, VERSION_ACTUAL)) return res.json({ ok: true, mensaje: 'Ya estás en la última versión.' });
    if (!remoto.zip_url) return res.status(500).json({ error: 'El servidor de actualizaciones no informó dónde bajar el zip.' });

    const zipResp = await fetch(remoto.zip_url);
    if (!zipResp.ok) return res.status(502).json({ error: 'No se pudo descargar el archivo de actualización' });
    const buffer = Buffer.from(await zipResp.arrayBuffer());

    const tmpZipPath = require('path').join(__dirname, '_update_tmp.zip');
    require('fs').writeFileSync(tmpZipPath, buffer);

    // Extraemos, pero SALTEAMOS a propósito todo lo que es del cliente:
    // datos, certificados, y node_modules (eso se reinstala solo si hace falta).
    const CARPETAS_PROTEGIDAS = ['data/', 'arca/certs/', 'node_modules/'];
    const zip = new AdmZip(tmpZipPath);
    const entries = zip.getEntries();
    let aplicados = 0;
    entries.forEach(entry => {
      const esProtegido = CARPETAS_PROTEGIDAS.some(p => entry.entryName.startsWith(p));
      if (esProtegido || entry.isDirectory) return;
      zip.extractEntryTo(entry, __dirname, true, true);
      aplicados++;
    });
    require('fs').unlinkSync(tmpZipPath);

    res.json({ ok: true, mensaje: `Actualización aplicada (${aplicados} archivos). Cerrá esta ventana y volvé a abrir INICIAR.bat para que tome los cambios.`, version_nueva: remoto.version });
  } catch (e) {
    console.error('Error aplicando actualización:', e);
    res.status(500).json({ error: 'No se pudo aplicar la actualización. No se modificó nada.' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Sistema SysTech iniciado (multi-tenant)`);
  console.log(`📡 Acceso en esta PC: http://localhost:${PORT}`);
  console.log(`🌐 Acceso en red (celulares/otras PCs): http://${LOCAL_IP}:${PORT}`);
  console.log(`👤 Usuario admin del taller local: admin / admin123`);
  console.log(`🏢 Talleres registrados: ${listarTalleres().length}\n`);
});
