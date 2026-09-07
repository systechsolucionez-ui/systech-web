// ─── SISTEMA MULTI-TENANT — GESTIÓN DE TALLERES ──────────────────────────────
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const MASTER_DB_PATH = path.join(DATA_DIR, 'master.db');
const masterDb = new Database(MASTER_DB_PATH);

masterDb.exec(`
  CREATE TABLE IF NOT EXISTS talleres (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subdominio TEXT UNIQUE NOT NULL,
    nombre TEXT NOT NULL,
    plan TEXT DEFAULT 'local',
    email_contacto TEXT,
    telefono_contacto TEXT,
    activo INTEGER DEFAULT 1,
    fecha_alta DATETIME DEFAULT CURRENT_TIMESTAMP,
    fecha_vencimiento DATETIME,
    notas TEXT
  );

  CREATE TABLE IF NOT EXISTS distribuidor_usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    nombre TEXT,
    activo INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS distribuidor_sesiones (
    token TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL,
    usuario TEXT,
    expires DATETIME NOT NULL
  );
`);

// Migración: addon pago de Tecnibot por taller (para instalaciones ya existentes)
try { masterDb.exec(`ALTER TABLE talleres ADD COLUMN tecnibot_habilitado INTEGER DEFAULT 0`); } catch(e) {}

// Crear el usuario distribuidor por defecto si no existe ninguno todavía
const distribuidorExiste = masterDb.prepare('SELECT id FROM distribuidor_usuarios LIMIT 1').get();
if (!distribuidorExiste) {
  const hashDefault = crypto.createHash('sha256').update('systech2026').digest('hex');
  masterDb.prepare('INSERT INTO distribuidor_usuarios (usuario,password,nombre) VALUES (?,?,?)')
    .run('distribuidor', hashDefault, 'Administrador SysTech');
  console.log('🔑 Usuario distribuidor creado por defecto → usuario: distribuidor / contraseña: systech2026');
  console.log('   ⚠️  IMPORTANTE: cambiá esta contraseña antes de publicar el sistema.');
}

// Cache de conexiones abiertas (para no reabrir el archivo en cada request)
const connectionCache = new Map();

/**
 * Devuelve la ruta del archivo de base de datos de un taller específico
 */
function getDbPathForTenant(subdominio) {
  const safeName = subdominio.replace(/[^a-z0-9\-]/gi, '');
  return path.join(DATA_DIR, `taller_${safeName}.db`);
}

/**
 * Inicializa el esquema completo (tablas, migraciones y datos por defecto)
 * en la base de datos de UN taller específico. Se ejecuta automáticamente
 * la primera vez que se abre la conexión de cada taller (es seguro llamarla
 * múltiples veces — todo usa "IF NOT EXISTS" o verificación previa).
 */
function inicializarBaseTaller(db) {
  // ─── BASE DE DATOS ────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      usuario TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      rol TEXT NOT NULL DEFAULT 'taller',
      activo INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS config (
      clave TEXT PRIMARY KEY,
      valor TEXT
    );
    CREATE TABLE IF NOT EXISTS productos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT UNIQUE NOT NULL,
      nombre TEXT NOT NULL,
      categoria TEXT,
      stock INTEGER DEFAULT 0,
      stock_minimo INTEGER DEFAULT 1,
      precio_costo REAL DEFAULT 0,
      precio_venta REAL DEFAULT 0,
      visible INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sucursales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      direccion TEXT,
      telefono TEXT,
      es_deposito_central INTEGER DEFAULT 0,
      activa INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS stock_sucursal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      producto_id INTEGER NOT NULL,
      sucursal_id INTEGER NOT NULL,
      cantidad INTEGER DEFAULT 0,
      UNIQUE(producto_id, sucursal_id),
      FOREIGN KEY (producto_id) REFERENCES productos(id),
      FOREIGN KEY (sucursal_id) REFERENCES sucursales(id)
    );
    CREATE TABLE IF NOT EXISTS movimientos_sucursal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      producto_id INTEGER NOT NULL,
      sucursal_origen_id INTEGER,
      sucursal_destino_id INTEGER,
      cantidad INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      usuario TEXT,
      notas TEXT,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (producto_id) REFERENCES productos(id)
    );
    CREATE TABLE IF NOT EXISTS clientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      telefono TEXT,
      email TEXT,
      direccion TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS ordenes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT UNIQUE NOT NULL,
      cliente_id INTEGER,
      equipo TEXT NOT NULL,
      marca TEXT,
      modelo TEXT,
      serie TEXT,
      falla_reportada TEXT,
      diagnostico TEXT,
      estado TEXT DEFAULT 'recibido',
      prioridad TEXT DEFAULT 'normal',
      tecnico TEXT,
      fecha_ingreso DATETIME DEFAULT CURRENT_TIMESTAMP,
      fecha_entrega DATETIME,
      presupuesto REAL DEFAULT 0,
      total_repuestos REAL DEFAULT 0,
      mano_obra REAL DEFAULT 0,
      total REAL DEFAULT 0,
      notas TEXT,
      checklist TEXT,
      cobrado INTEGER DEFAULT 0,
      FOREIGN KEY (cliente_id) REFERENCES clientes(id)
    );
    CREATE TABLE IF NOT EXISTS orden_repuestos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      orden_id INTEGER NOT NULL,
      producto_id INTEGER NOT NULL,
      cantidad INTEGER NOT NULL,
      precio_unitario REAL NOT NULL,
      subtotal REAL NOT NULL,
      FOREIGN KEY (orden_id) REFERENCES ordenes(id),
      FOREIGN KEY (producto_id) REFERENCES productos(id)
    );
    CREATE TABLE IF NOT EXISTS movimientos_stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      producto_id INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      cantidad INTEGER NOT NULL,
      motivo TEXT,
      orden_id INTEGER,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (producto_id) REFERENCES productos(id)
    );
    CREATE TABLE IF NOT EXISTS notificaciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      orden_id INTEGER NOT NULL,
      medio TEXT NOT NULL,
      mensaje TEXT,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (orden_id) REFERENCES ordenes(id)
    );
    CREATE TABLE IF NOT EXISTS chat (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER NOT NULL,
      usuario_nombre TEXT NOT NULL,
      rol TEXT NOT NULL,
      mensaje TEXT NOT NULL,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sesiones (
      token TEXT PRIMARY KEY,
      usuario_id INTEGER NOT NULL,
      rol TEXT NOT NULL,
      nombre TEXT NOT NULL,
      expires DATETIME NOT NULL
    );
  `);

  // Migraciones seguras
  [
    ['checklist', 'TEXT'],
    ['cobrado', 'INTEGER DEFAULT 0'],
    ['presupuesto_aprobado', 'INTEGER DEFAULT -1'],
    ['comentario_cliente', 'TEXT']
  ].forEach(([col, type]) => {
    try { db.exec(`ALTER TABLE ordenes ADD COLUMN ${col} ${type}`); } catch(e) {}
  });
  // Migración foto producto
  try { db.exec(`ALTER TABLE productos ADD COLUMN foto_url TEXT`); } catch(e) {}
  // Migración sucursal en comprobantes
  try { db.exec(`ALTER TABLE comprobantes ADD COLUMN sucursal_id INTEGER`); } catch(e) {}

  // ─── SUCURSALES: crear depósito central por defecto ────────────────────────
  const depositoExiste = db.prepare("SELECT id FROM sucursales WHERE es_deposito_central=1").get();
  if (!depositoExiste) {
    db.prepare("INSERT INTO sucursales (nombre,es_deposito_central,activa) VALUES ('Depósito Central',1,1)").run();
  }

  // ─── DATOS INICIALES ──────────────────────────────────────────────────────────
  const adminExiste = db.prepare("SELECT id FROM usuarios WHERE rol='admin'").get();
  if (!adminExiste) {
    const hash = crypto.createHash('sha256').update('admin123').digest('hex');
    db.prepare("INSERT INTO usuarios (nombre,usuario,password,rol) VALUES (?,?,?,?)").run('Administrador','admin',hash,'admin');
  }

  const configDefaults = {
    empresa_nombre: 'Mi Servicio Técnico',
    empresa_direccion: '',
    empresa_telefono: '',
    empresa_email: '',
    empresa_whatsapp: '',
    color_accent: '#4f8ef7',
    color_accent2: '#38d9a9',
    columnas_ocultas: '[]',
    tipos_equipo_activos: '["celular","notebook","pc","tablet","consola"]'
  };
  Object.entries(configDefaults).forEach(([k,v]) => {
    const existe = db.prepare("SELECT clave FROM config WHERE clave=?").get(k);
    if (!existe) db.prepare("INSERT INTO config (clave,valor) VALUES (?,?)").run(k,v);
  });



  // ─── HERRAMIENTAS DEL TALLER ──────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS herramientas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT UNIQUE NOT NULL,
      nombre TEXT NOT NULL,
      categoria TEXT DEFAULT 'General',
      marca TEXT,
      modelo TEXT,
      estado TEXT DEFAULT 'disponible',
      ubicacion TEXT DEFAULT 'Taller',
      cantidad INTEGER DEFAULT 1,
      cantidad_minima INTEGER DEFAULT 1,
      descripcion TEXT,
      numero_serie TEXT,
      fecha_compra TEXT,
      valor_compra REAL DEFAULT 0,
      foto_url TEXT,
      activa INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS herramienta_movimientos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      herramienta_id INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      cantidad INTEGER DEFAULT 1,
      tecnico TEXT,
      motivo TEXT,
      orden_id INTEGER,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (herramienta_id) REFERENCES herramientas(id)
    );
  `);



  db.exec(`
    CREATE TABLE IF NOT EXISTS impresoras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'termica',
      ancho TEXT NOT NULL DEFAULT '80mm',
      ubicacion TEXT DEFAULT 'caja',
      predeterminada INTEGER DEFAULT 0,
      activa INTEGER DEFAULT 1
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS automatizacion (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      evento TEXT UNIQUE NOT NULL,
      activo INTEGER DEFAULT 0,
      canal TEXT DEFAULT 'ambos',
      modo TEXT DEFAULT 'manual',
      plantilla_wa TEXT,
      plantilla_email TEXT,
      asunto_email TEXT
    );
    CREATE TABLE IF NOT EXISTS log_automatizacion (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      orden_id INTEGER,
      evento TEXT,
      canal TEXT,
      estado TEXT,
      detalle TEXT,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Insertar eventos por defecto si no existen
  const eventosDefecto = [
    { evento: 'recibido',    plantilla_wa: 'Hola {nombre}! 📱 Confirmamos que recibimos tu *{equipo} {marca}* en {empresa}. Tu N° de orden es: *{numero}*. Podés consultar el estado en: {link_cliente} 🔧',
      plantilla_email: '<h2>Recibimos tu equipo</h2><p>Hola <b>{nombre}</b>,</p><p>Confirmamos el ingreso de tu <b>{equipo} {marca} {modelo}</b> a nuestro servicio técnico.</p><p><b>N° de Orden:</b> {numero}<br><b>Falla reportada:</b> {falla}</p><p>Podés consultar el estado en cualquier momento: <a href="{link_cliente}">{link_cliente}</a></p><p>Gracias por confiar en nosotros!<br><b>{empresa}</b></p>',
      asunto_email: 'Recibimos tu equipo - Orden {numero}' },
    { evento: 'diagnostico', plantilla_wa: 'Hola {nombre}! 🔍 Estamos realizando el diagnóstico de tu *{equipo} {marca}*. En breve te informamos el resultado. N° orden: *{numero}*',
      plantilla_email: '<h2>En diagnóstico</h2><p>Hola <b>{nombre}</b>,</p><p>Estamos analizando tu <b>{equipo} {marca}</b>. Pronto tendremos el diagnóstico completo.</p><p><b>N° Orden:</b> {numero}</p><p>Seguí el estado en: <a href="{link_cliente}">{link_cliente}</a></p><p><b>{empresa}</b></p>',
      asunto_email: 'Diagnóstico en proceso - Orden {numero}' },
    { evento: 'presupuesto', plantilla_wa: 'Hola {nombre}! 💰 Tenemos el diagnóstico de tu *{equipo} {marca}*. El costo de la reparación es *${total}*. Podés aprobar o rechazar desde: {link_cliente} N° orden: *{numero}*',
      plantilla_email: '<h2>Presupuesto listo</h2><p>Hola <b>{nombre}</b>,</p><p>Ya tenemos el diagnóstico de tu <b>{equipo} {marca}</b>.</p><p><b>Costo de reparación: ${total}</b></p><p>Por favor aprobá o rechazá el presupuesto desde: <a href="{link_cliente}">{link_cliente}</a></p><p><b>N° Orden:</b> {numero}<br><b>{empresa}</b></p>',
      asunto_email: 'Presupuesto listo - Orden {numero} - ${total}' },
    { evento: 'reparando',   plantilla_wa: 'Hola {nombre}! 🔧 Buenas noticias: comenzamos la reparación de tu *{equipo} {marca}*. Te avisamos cuando esté listo. N° orden: *{numero}*',
      plantilla_email: '<h2>Reparación en curso</h2><p>Hola <b>{nombre}</b>,</p><p>Comenzamos la reparación de tu <b>{equipo} {marca}</b>. Te notificaremos cuando esté listo.</p><p><b>N° Orden:</b> {numero}</p><p><a href="{link_cliente}">{link_cliente}</a></p><p><b>{empresa}</b></p>',
      asunto_email: 'Reparación iniciada - Orden {numero}' },
    { evento: 'listo',       plantilla_wa: 'Hola {nombre}! ✅ Tu *{equipo} {marca}* está *LISTO PARA RETIRAR*! 🎉 Monto a abonar: *${total}*. Te esperamos en {empresa}. N° orden: *{numero}*',
      plantilla_email: '<h2>¡Tu equipo está listo! ✅</h2><p>Hola <b>{nombre}</b>,</p><p>Tu <b>{equipo} {marca}</b> está listo para retirar.</p><p><b>Monto a abonar: ${total}</b></p><p>Podés pasar cuando quieras por el local.<br><b>N° Orden:</b> {numero}</p><p><b>{empresa}</b><br>{direccion}<br>{telefono}</p>',
      asunto_email: '✅ Tu equipo está listo - Orden {numero}' }
  ];

  eventosDefecto.forEach(e => {
    const existe = db.prepare('SELECT id FROM automatizacion WHERE evento=?').get(e.evento);
    if (!existe) db.prepare('INSERT INTO automatizacion (evento,canal,modo,plantilla_wa,plantilla_email,asunto_email) VALUES (?,?,?,?,?,?)').run(e.evento,'ambos','manual',e.plantilla_wa,e.plantilla_email,e.asunto_email);
  });

  db.exec(`
    CREATE TABLE IF NOT EXISTS comprobantes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT UNIQUE NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'presupuesto',
      letra TEXT DEFAULT 'X',
      punto_venta INTEGER DEFAULT 1,
      numero_comp INTEGER,
      orden_id INTEGER,
      cliente_id INTEGER,
      cliente_nombre TEXT,
      cliente_apellido TEXT,
      cliente_doc_tipo TEXT DEFAULT 'DNI',
      cliente_doc_numero TEXT,
      cliente_condicion_iva TEXT DEFAULT 'Consumidor Final',
      cliente_direccion TEXT,
      items TEXT NOT NULL DEFAULT '[]',
      subtotal REAL DEFAULT 0,
      descuento REAL DEFAULT 0,
      iva_porcentaje REAL DEFAULT 0,
      iva_monto REAL DEFAULT 0,
      total REAL DEFAULT 0,
      condicion_pago TEXT DEFAULT 'Contado',
      notas TEXT,
      estado TEXT DEFAULT 'borrador',
      cae TEXT,
      cae_vencimiento TEXT,
      sucursal_id INTEGER,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (orden_id) REFERENCES ordenes(id),
      FOREIGN KEY (cliente_id) REFERENCES clientes(id),
      FOREIGN KEY (sucursal_id) REFERENCES sucursales(id)
    );
    CREATE TABLE IF NOT EXISTS config_fiscal (
      clave TEXT PRIMARY KEY,
      valor TEXT
    );
  `);

  // Config fiscal por defecto
  const configFiscalDefecto = {
    razon_social: '',
    cuit: '',
    condicion_iva: 'Monotributo',
    punto_venta: '1',
    direccion_fiscal: '',
    inicio_actividades: '',
    ingresos_brutos: '',
    logo_factura: '',
    pie_factura: 'Gracias por su preferencia',
    proximo_numero_presupuesto: '1',
    proximo_numero_factura_a: '1',
    proximo_numero_factura_b: '1',
    proximo_numero_factura_c: '1',
    proximo_numero_nota_credito: '1',
    proximo_numero_nota_debito: '1',
    proximo_numero_nota_entrega: '1'
  };
  Object.entries(configFiscalDefecto).forEach(([k,v]) => {
    const existe = db.prepare('SELECT clave FROM config_fiscal WHERE clave=?').get(k);
    if (!existe) db.prepare('INSERT INTO config_fiscal (clave,valor) VALUES (?,?)').run(k,v);
  });



  db.exec(`
    CREATE TABLE IF NOT EXISTS garantia_config (
      clave TEXT PRIMARY KEY,
      valor TEXT
    );
    CREATE TABLE IF NOT EXISTS garantia_aceptaciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      orden_id INTEGER NOT NULL,
      cliente_nombre TEXT,
      fecha_aceptacion DATETIME DEFAULT CURRENT_TIMESTAMP,
      ip_origen TEXT,
      firma_digital TEXT,
      texto_aceptado TEXT,
      FOREIGN KEY (orden_id) REFERENCES ordenes(id)
    );
  `);

  // Texto de garantía por defecto (basado en el documento del local, editable)
  const garantiaDefault = `1. El presente remito es el único elemento válido para el retiro del equipo.
  2. La garantía es sobre los repuestos reemplazados expresados en la factura.
  3. La garantía es válida únicamente acompañada de su correspondiente factura.
  4. Transcurridos los 90 días de la fecha de emisión del comprobante, el equipo que no sea retirado se considerará abandonado, sin derecho de reclamo alguno.
  5. Los equipos que ingresen presentando humedad, roturas significativas, golpes en el marco y/o carcasa, estén desarmados, seriales con falla de fabricación, posean previas reparaciones de placa y/o cambios reiterados de periféricos; no serán cubiertos por esta garantía.
  6. Los equipos que ingresen para revisión por posible garantía y se encuentren despegados, rotos, modificados o mojados (sulfatado y/o sello de humedad activo) no serán cubiertos por esta garantía.
  7. La empresa no se hará cargo por fallas presentadas en los periféricos de los equipos que ingresen apagados, sin dar imagen, bloqueados o iniciados de fábrica y no se les puedan probar funciones.
  8. La empresa no se hace responsable por daños que puedan surgir por la inadecuada manipulación del equipo (caídas, roturas o afecciones en el LCD causadas por presión).
  9. En caso de equipos que requieran una intervención en placa, dada la complejidad del trabajo y la reacción de la placa frente al mismo, la empresa no se hace responsable si luego del proceso el equipo deja de funcionar total o parcialmente.
  10. Si el equipo, luego de ser reparado en nuestro servicio, es manipulado por otro servicio técnico ajeno a la empresa, perderá la garantía vigente.
  11. No se aceptan reclamos por fallas no descritas en la garantía, posteriores a las 48 horas de entrega del equipo. De presentarse, serán evaluadas por nuestro personal técnico verificando las mismas.
  12. Respondiendo a la Ley de Defensa del Consumidor (Capítulo IV, artículo 11), las garantías a partir del momento de entrega serán de: baterías 90 días; periféricos (cámaras, flex, pin de carga, botones y afines) 60 días; reparación de placas 30 días.
  13. Los tiempos de respuesta por cobertura de garantía no están estipulados; los mismos serán dispuestos por la empresa según corresponda.
  14. La calidad de los repuestos que manejamos es la mejor del mercado, así como también comercializamos algunos repuestos originales Samsung dependiendo el modelo y la distribución de la marca. En el caso de Apple, no trabajamos con repuestos originales ya que Apple no los distribuye directamente.
  15. La garantía de este servicio es intransferible.
  16. El cliente declara haber leído y aceptado en su totalidad las condiciones de garantía aquí expuestas al momento de retirar su equipo.`;

  if (!db.prepare("SELECT clave FROM garantia_config WHERE clave='texto_garantia'").get()) {
    db.prepare("INSERT INTO garantia_config (clave,valor) VALUES ('texto_garantia',?)").run(garantiaDefault);
  }
  if (!db.prepare("SELECT clave FROM garantia_config WHERE clave='exigir_aceptacion'").get()) {
    db.prepare("INSERT INTO garantia_config (clave,valor) VALUES ('exigir_aceptacion','1')").run();
  }



  db.exec(`
    CREATE TABLE IF NOT EXISTS recursos_accesos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      categoria TEXT DEFAULT 'Esquemáticos',
      url TEXT,
      usuario TEXT,
      password_enc TEXT,
      codigo_promo TEXT,
      descuento TEXT,
      notas TEXT,
      activo INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS recursos_planos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      titulo TEXT NOT NULL,
      marca TEXT,
      modelo TEXT,
      categoria TEXT DEFAULT 'Celular',
      archivo_url TEXT,
      archivo_nombre TEXT,
      descripcion TEXT,
      precio_creditos INTEGER DEFAULT 0,
      activo INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS plano_compras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER NOT NULL,
      plano_id INTEGER NOT NULL,
      precio_pagado INTEGER DEFAULT 0,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(usuario_id, plano_id),
      FOREIGN KEY (usuario_id) REFERENCES usuarios(id),
      FOREIGN KEY (plano_id) REFERENCES recursos_planos(id)
    );
    CREATE TABLE IF NOT EXISTS creditos_movimientos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      cantidad INTEGER NOT NULL,
      motivo TEXT,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (usuario_id) REFERENCES usuarios(id)
    );
  `);
  // Migración: créditos y precio por esquema (para sistemas ya instalados)
  try { db.exec(`ALTER TABLE usuarios ADD COLUMN creditos INTEGER DEFAULT 0`); } catch(e) {}
  try { db.exec(`ALTER TABLE recursos_planos ADD COLUMN precio_creditos INTEGER DEFAULT 0`); } catch(e) {}

  // ─── TECNIBOT: asistente de IA con base de conocimiento propia ─────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS tecnibot_articulos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      categoria TEXT DEFAULT 'General',
      marca TEXT DEFAULT 'Multimarca',
      titulo TEXT NOT NULL,
      contenido TEXT NOT NULL,
      modelo_aplicable TEXT DEFAULT 'Todos',
      palabras_clave TEXT DEFAULT '',
      activo INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_tecnibot_activo ON tecnibot_articulos(activo);
    -- Config separada de la tabla "config" general: NUNCA se expone en GET /api/config
    -- (que devuelve todo a cualquier usuario logueado). Acá vive la API key, solo admin.
    CREATE TABLE IF NOT EXISTS tecnibot_config (
      clave TEXT PRIMARY KEY,
      valor TEXT
    );
    CREATE TABLE IF NOT EXISTS tecnibot_conversaciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER NOT NULL,
      usuario_nombre TEXT,
      rol TEXT NOT NULL CHECK (rol IN ('usuario','asistente')),
      mensaje TEXT NOT NULL,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- Config del chequeo de IMEI robado/bloqueado (imeicheck.com) — separada de
    -- la config general por el mismo motivo que Tecnibot: nunca exponer la
    -- API key a través de GET /api/config.
    CREATE TABLE IF NOT EXISTS imeicheck_config (
      clave TEXT PRIMARY KEY,
      valor TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tecnibot_conv_usuario ON tecnibot_conversaciones(usuario_id);
  `);
  const tecnibotDefaults = { tecnibot_api_key: '', tecnibot_activo: '1', tecnibot_modelo: 'claude-sonnet-4-6' };
  Object.entries(tecnibotDefaults).forEach(([k,v]) => {
    if (!db.prepare('SELECT clave FROM tecnibot_config WHERE clave=?').get(k))
      db.prepare('INSERT INTO tecnibot_config (clave,valor) VALUES (?,?)').run(k,v);
  });

  const imeicheckDefaults = { api_key: '', activo: '0', service_id: '5' };
  Object.entries(imeicheckDefaults).forEach(([k,v]) => {
    if (!db.prepare('SELECT clave FROM imeicheck_config WHERE clave=?').get(k))
      db.prepare('INSERT INTO imeicheck_config (clave,valor) VALUES (?,?)').run(k,v);
  });



  const arcaDefaults = {
    arca_produccion:   '0',
    arca_cuit:         '',
    arca_punto_venta:  '1',
    arca_cert_path:    '',
    arca_key_path:     '',
    arca_condicion:    'monotributo',
    arca_habilitado:   '0'
  };
  Object.entries(arcaDefaults).forEach(([k,v])=>{
    if(!db.prepare('SELECT clave FROM config_fiscal WHERE clave=?').get(k))
      db.prepare('INSERT INTO config_fiscal (clave,valor) VALUES (?,?)').run(k,v);
  });

  // Tabla de log ARCA
  db.exec(`CREATE TABLE IF NOT EXISTS arca_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comprobante_id INTEGER,
    accion TEXT,
    request TEXT,
    response TEXT,
    resultado TEXT,
    fecha DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);


}

/**
 * Obtiene (o crea y cachea) la conexión de base de datos de un taller.
 * La primera vez que se abre, inicializa automáticamente su esquema completo.
 */
function getDbForTenant(subdominio) {
  if (connectionCache.has(subdominio)) {
    return connectionCache.get(subdominio);
  }
  const dbPath = getDbPathForTenant(subdominio);
  const esNueva = !fs.existsSync(dbPath);
  const db = new Database(dbPath);
  inicializarBaseTaller(db); // Seguro de llamar siempre — usa IF NOT EXISTS
  connectionCache.set(subdominio, db);
  if (esNueva) {
    console.log(`🆕 Base de datos creada e inicializada para el taller: ${subdominio}`);
  }
  return db;
}

/**
 * Busca un taller por su subdominio en la base maestra
 */
function findTaller(subdominio) {
  return masterDb.prepare('SELECT * FROM talleres WHERE subdominio = ? AND activo = 1').get(subdominio);
}

/**
 * Crea un nuevo taller (alta manual o automática) y deja su base de datos lista
 */
function crearTaller({ subdominio, nombre, plan, email_contacto, telefono_contacto, notas, fecha_vencimiento, tecnibot_habilitado }) {
  const existe = masterDb.prepare('SELECT id FROM talleres WHERE subdominio = ?').get(subdominio);
  if (existe) throw new Error(`El subdominio "${subdominio}" ya está en uso`);

  masterDb.prepare(`
    INSERT INTO talleres (subdominio, nombre, plan, email_contacto, telefono_contacto, notas, fecha_vencimiento, tecnibot_habilitado)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(subdominio, nombre, plan || 'local', email_contacto || '', telefono_contacto || '', notas || '', fecha_vencimiento || null, tecnibot_habilitado ? 1 : 0);

  // Crear e inicializar la base de datos del nuevo taller (con su admin/admin123 por defecto)
  const db = getDbForTenant(subdominio);
  return db;
}

/**
 * Lista TODOS los talleres, activos e inactivos (para el panel de distribuidor)
 */
function listarTalleres() {
  return masterDb.prepare('SELECT * FROM talleres ORDER BY fecha_alta DESC').all();
}

/**
 * Actualiza datos de un taller (plan, vencimiento, notas, estado activo)
 */
function actualizarTaller(subdominio, cambios) {
  const campos = [];
  const valores = [];
  ['nombre', 'plan', 'email_contacto', 'telefono_contacto', 'notas', 'fecha_vencimiento', 'activo', 'tecnibot_habilitado'].forEach(campo => {
    if (cambios[campo] !== undefined) {
      campos.push(`${campo} = ?`);
      valores.push(cambios[campo]);
    }
  });
  if (!campos.length) return;
  valores.push(subdominio);
  masterDb.prepare(`UPDATE talleres SET ${campos.join(', ')} WHERE subdominio = ?`).run(...valores);
}

/**
 * Elimina por completo un taller: su registro en la base maestra y su archivo de base de datos.
 * Acción irreversible — pensada para cancelaciones definitivas, no para pausas temporales.
 */
function eliminarTaller(subdominio) {
  if (subdominio === 'default') throw new Error('No se puede eliminar el taller "default"');
  masterDb.prepare('DELETE FROM talleres WHERE subdominio = ?').run(subdominio);
  if (connectionCache.has(subdominio)) {
    connectionCache.get(subdominio).close();
    connectionCache.delete(subdominio);
  }
  const dbPath = getDbPathForTenant(subdominio);
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
}

// ─── AUTENTICACIÓN DEL DISTRIBUIDOR ───────────────────────────────────────────

/**
 * Login del distribuidor (vos, dueño del negocio). Devuelve un token de sesión
 * válido por 12 horas, totalmente separado de los logins de cada taller.
 */
function loginDistribuidor(usuario, password) {
  const hash = crypto.createHash('sha256').update(password).digest('hex');
  const user = masterDb.prepare('SELECT * FROM distribuidor_usuarios WHERE usuario = ? AND password = ? AND activo = 1').get(usuario, hash);
  if (!user) return null;

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  masterDb.prepare('INSERT INTO distribuidor_sesiones (token, usuario_id, usuario, expires) VALUES (?, ?, ?, ?)')
    .run(token, user.id, user.usuario, expires);
  return { token, nombre: user.nombre, usuario: user.usuario };
}

/**
 * Valida un token de sesión del distribuidor
 */
function validarSesionDistribuidor(token) {
  if (!token) return null;
  return masterDb.prepare("SELECT * FROM distribuidor_sesiones WHERE token = ? AND expires > datetime('now')").get(token);
}

/**
 * Cambia la contraseña del usuario distribuidor
 */
function cambiarPasswordDistribuidor(usuario, passwordActual, passwordNueva) {
  const hashActual = crypto.createHash('sha256').update(passwordActual).digest('hex');
  const user = masterDb.prepare('SELECT * FROM distribuidor_usuarios WHERE usuario = ? AND password = ?').get(usuario, hashActual);
  if (!user) throw new Error('La contraseña actual es incorrecta');
  const hashNuevo = crypto.createHash('sha256').update(passwordNueva).digest('hex');
  masterDb.prepare('UPDATE distribuidor_usuarios SET password = ? WHERE id = ?').run(hashNuevo, user.id);
}

/**
 * Middleware de Express: resuelve el tenant según el subdominio del Host header
 * y lo deja disponible en req.db y req.tenant
 */
function tenantMiddleware(req, res, next) {
  const host = req.headers.host || '';
  const hostname = host.split(':')[0]; // quita el puerto si existe

  let subdominio;

  // Modo desarrollo local: localhost o IP → usar taller "default"
  if (hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    subdominio = 'default';
  } else {
    // Producción: tallerperez.systech.com → "tallerperez"
    const partes = hostname.split('.');
    subdominio = partes.length > 2 ? partes[0] : 'default';
  }

  // Asegurar que el taller "default" siempre exista (para desarrollo/instalación local)
  let taller = findTaller(subdominio);
  if (!taller && subdominio === 'default') {
    crearTaller({ subdominio: 'default', nombre: 'Mi Taller', plan: 'local' });
    taller = findTaller(subdominio);
  }

  if (!taller) {
    return res.status(404).json({ error: 'Este taller no existe o no está activo. Verificá la dirección.' });
  }

  req.tenant = taller;
  req.db = getDbForTenant(subdominio);
  next();
}

module.exports = {
  masterDb,
  tenantMiddleware,
  getDbForTenant,
  findTaller,
  crearTaller,
  listarTalleres,
  actualizarTaller,
  eliminarTaller,
  loginDistribuidor,
  validarSesionDistribuidor,
  cambiarPasswordDistribuidor
};
