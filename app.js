// ============================================
// DIAGNOSTICO SOCIAL COMUNITARIO - APP.JS
// PWA Offline-First para trabajo de campo
// Version: 2.0.0 - CORREGIDO Y PRODUCCION-READY
// ============================================

const CONFIG = {
  VERSION: '2.1.0',
  DB_NAME: 'DiagSocialDB',
  DB_VERSION: 2,
  SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbwRTT1AkykxkwYnZ3H1YCwxLPScwJ0HLLs5_etasKwg-3wq-P4wFA3BulSCAoCDOJwb/exec',
  TOKEN_SEGURIDAD: 'diag-social-2024-secure',
  GPS_TIMEOUT: 30000,
  BORRADOR_INTERVAL: 30000,
  MIN_CEDULA_DIGITOS: 6,
  MAX_VECINOS: 5000,
  MAX_SYNC_RETRIES: 3,
  SYNC_RETRY_DELAY: 2000,
  LOGIN_MAX_ATTEMPTS: 5,
  LOGIN_LOCKOUT_MINUTES: 15
};

class DiagSocialApp {
  constructor() {
    this.db = null;
    this.session = null;
    this.configGeo = null;
    this.encuestadores = [];
    this.baseVecinos = [];
    this.preguntasAdicionales = [];
    this.currentGPS = null;
    this.borradorTimer = null;
    this.currentEncuesta = null;
    this.currentSeccion = null;
    this.casoEditando = null;
    this.loginAttempts = 0;
    this.loginLockedUntil = null;
  }

  async init() {
    try {
      await this.inicializarIndexedDB();
      await this.cargarSession();
      await this.cargarConfiguracion();
      await this.cargarEncuestadores();
      await this.cargarBaseVecinos();
      this.configurarEventos();
      this.detectarConexion();
      this.mostrarPantallaInicial();
      this.iniciarAutoGuardado();
      console.log('[App] Inicializacion completada v' + CONFIG.VERSION);
    } catch (error) {
      console.error('[App] Error en inicializacion:', error);
      this.mostrarToast('Error al iniciar la aplicacion', 'error');
    }
  }

  inicializarIndexedDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
      request.onerror = () => {
        console.error('[DB] Error al abrir:', request.error);
        this.mostrarToast('Error al abrir base de datos local', 'error');
        reject(request.error);
      };
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('encuestas')) {
          const store = db.createObjectStore('encuestas', { keyPath: 'id' });
          store.createIndex('tipo', 'tipo', { unique: false });
          store.createIndex('estadoSync', 'estadoSync', { unique: false });
          store.createIndex('encuestador', 'encuestador', { unique: false });
          store.createIndex('fecha', 'fecha', { unique: false });
          store.createIndex('estadoCaso', 'estadoCaso', { unique: false });
        }
        if (!db.objectStoreNames.contains('vecinos')) {
          const store = db.createObjectStore('vecinos', { keyPath: 'Cedula' });
          store.createIndex('nombre', 'Nombre_y_Apellido', { unique: false });
        }
        if (!db.objectStoreNames.contains('encuestadores')) db.createObjectStore('encuestadores', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('configuracion')) db.createObjectStore('configuracion', { keyPath: 'clave' });
        if (!db.objectStoreNames.contains('session')) db.createObjectStore('session', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('preguntas')) {
          const store = db.createObjectStore('preguntas', { keyPath: 'id' });
          store.createIndex('cuestionario', 'cuestionario', { unique: false });
          store.createIndex('activa', 'activa', { unique: false });
        }
        if (!db.objectStoreNames.contains('respuestas_adicionales')) {
          const store = db.createObjectStore('respuestas_adicionales', { keyPath: 'id', autoIncrement: true });
          store.createIndex('idRegistro', 'idRegistro', { unique: false });
        }
        if (!db.objectStoreNames.contains('metadatos')) db.createObjectStore('metadatos', { keyPath: 'clave' });
        if (!db.objectStoreNames.contains('login_attempts')) db.createObjectStore('login_attempts', { keyPath: 'id' });
      };
    });
  }

  async dbOperation(storeName, mode, operation) {
    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        const request = operation(store);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.onerror = () => reject(transaction.error);
      } catch (error) { reject(error); }
    });
  }

  async cargarSession() {
    try {
      const session = await this.dbOperation('session', 'readonly', store => store.get('current'));
      if (session && session.recordar) this.session = session;
      const attempts = await this.dbOperation('login_attempts', 'readonly', store => store.get('current'));
      if (attempts) {
        this.loginAttempts = attempts.count || 0;
        this.loginLockedUntil = attempts.lockedUntil || null;
      }
    } catch (e) { console.log('[Session] No hay sesion guardada'); }
  }

  async cargarEncuestadores() {
    try {
      const data = await this.dbOperation('encuestadores', 'readonly', store => store.getAll());
      this.encuestadores = data.length > 0 ? data : this.getEncuestadoresDefault();
      this.actualizarSelectEncuestadores();
    } catch (e) {
      this.encuestadores = this.getEncuestadoresDefault();
      this.actualizarSelectEncuestadores();
    }
  }

  getEncuestadoresDefault() {
    return [
      { id: 1, nombre: 'Maria Garcia', password: '1234', activo: true },
      { id: 2, nombre: 'Jose Rodriguez', password: '5678', activo: true },
      { id: 3, nombre: 'Ana Martinez', password: '9012', activo: true }
    ];
  }

  actualizarSelectEncuestadores() {
    const select = document.getElementById('loginNombre');
    if (!select) return;
    select.innerHTML = '<option value="">-- Seleccione su nombre --</option>';
    this.encuestadores.filter(e => e.activo).forEach(e => {
      const option = document.createElement('option');
      option.value = e.id;
      option.textContent = e.nombre;
      select.appendChild(option);
    });
  }

  async login() {
    if (this.loginLockedUntil && new Date() < new Date(this.loginLockedUntil)) {
      const minRestantes = Math.ceil((new Date(this.loginLockedUntil) - new Date()) / 60000);
      this.mostrarToast(`Cuenta bloqueada. Intente en ${minRestantes} minutos.`, 'error');
      return;
    }
    const nombreId = document.getElementById('loginNombre').value;
    const pin = document.getElementById('loginPin').value;
    const recordar = document.getElementById('loginRecordar').checked;
    if (!nombreId || !pin) { this.mostrarToast('Ingrese nombre y PIN', 'error'); return; }
    if (!/^\d{4}$/.test(pin)) { this.mostrarToast('El PIN debe ser de 4 digitos', 'error'); return; }
    const encuestador = this.encuestadores.find(e => e.id == nombreId);
    if (!encuestador || encuestador.password !== pin) {
      this.loginAttempts++;
      const remaining = CONFIG.LOGIN_MAX_ATTEMPTS - this.loginAttempts;
      if (this.loginAttempts >= CONFIG.LOGIN_MAX_ATTEMPTS) {
        const lockedUntil = new Date(Date.now() + CONFIG.LOGIN_LOCKOUT_MINUTES * 60000);
        this.loginLockedUntil = lockedUntil.toISOString();
        await this.dbOperation('login_attempts', 'readwrite', store => store.put({ id: 'current', count: this.loginAttempts, lockedUntil: this.loginLockedUntil }));
        this.mostrarToast(`Cuenta bloqueada por ${CONFIG.LOGIN_LOCKOUT_MINUTES} minutos.`, 'error');
      } else {
        await this.dbOperation('login_attempts', 'readwrite', store => store.put({ id: 'current', count: this.loginAttempts, lockedUntil: null }));
        this.mostrarToast(`PIN incorrecto. ${remaining} intentos restantes.`, 'error');
      }
      return;
    }
    this.loginAttempts = 0;
    this.loginLockedUntil = null;
    await this.dbOperation('login_attempts', 'readwrite', store => store.put({ id: 'current', count: 0, lockedUntil: null }));
    this.session = { id: 'current', encuestadorId: encuestador.id, nombre: encuestador.nombre, fechaLogin: new Date().toISOString(), recordar: recordar };
    await this.dbOperation('session', 'readwrite', store => store.put(this.session));
    this.mostrarToast(`Bienvenido, ${encuestador.nombre}`, 'success');
    this.mostrarMenu();
  }

  abrirModalCrearEncuestador() {
    const modal = document.getElementById('modalCrearEncuestador');
    if (modal) modal.classList.add('active');
  }

  cerrarModalCrearEncuestador() {
    const modal = document.getElementById('modalCrearEncuestador');
    if (modal) modal.classList.remove('active');
    const nombre = document.getElementById('nuevoEncNombre');
    const pin = document.getElementById('nuevoEncPin');
    if (nombre) nombre.value = '';
    if (pin) pin.value = '';
  }

  async crearEncuestadorLocal() {
    const nombre = document.getElementById('nuevoEncNombre').value.trim();
    const pin = document.getElementById('nuevoEncPin').value.trim();
    if (!nombre) { this.mostrarToast('Ingrese el nombre del encuestador', 'error'); return; }
    if (!pin || !/^\d{4}$/.test(pin)) { this.mostrarToast('El PIN debe ser de 4 digitos numericos', 'error'); return; }
    const existe = this.encuestadores.find(e => e.nombre.toLowerCase() === nombre.toLowerCase());
    if (existe) { this.mostrarToast('Ya existe un encuestador con ese nombre', 'error'); return; }
    const nuevoId = Math.max(...this.encuestadores.map(e => e.id), 0) + 1;
    const nuevoEncuestador = { id: nuevoId, nombre: nombre, password: pin, pin: pin, activo: true };
    this.encuestadores.push(nuevoEncuestador);
    await this.dbOperation('encuestadores', 'readwrite', store => store.put(nuevoEncuestador));
    this.actualizarSelectEncuestadores();
    this.cerrarModalCrearEncuestador();
    this.mostrarToast(`Encuestador "${nombre}" creado. PIN: ${pin}`, 'success');
  }

  async cerrarSesion() {
    if (confirm('Esta seguro de cerrar sesion?')) {
      await this.dbOperation('session', 'readwrite', store => store.delete('current'));
      this.session = null;
      this.mostrarPantalla('screenLogin');
      this.mostrarToast('Sesion cerrada', 'info');
    }
  }

  mostrarPantallaInicial() {
    if (this.session && this.session.recordar) this.mostrarMenu();
    else this.mostrarPantalla('screenLogin');
  }

  mostrarPantalla(pantallaId) {
    document.querySelectorAll('.screen, .login-screen').forEach(s => { s.classList.add('hidden'); s.classList.remove('active'); });
    const pantalla = document.getElementById(pantallaId);
    if (pantalla) { pantalla.classList.remove('hidden'); pantalla.classList.add('active'); window.scrollTo(0, 0); }
  }

  mostrarMenu() {
    this.mostrarPantalla('screenMenu');
    document.getElementById('menuEncuestador').textContent = `Bienvenido, ${this.session.nombre}`;
    this.actualizarEstadisticasMenu();
  }

  volverMenu() { this.mostrarMenu(); this.resetearFormularios(); }

  async cargarConfiguracion() {
    try {
      const config = await this.dbOperation('configuracion', 'readonly', store => store.get('geografica'));
      if (config) { this.configGeo = config; this.llenarConfiguracion(); }
    } catch (e) { console.log('[Config] No hay configuracion guardada'); }
  }

  llenarConfiguracion() {
    if (!this.configGeo) return;
    const campos = ['cfgEstado', 'cfgMunicipio', 'cfgParroquia', 'cfgCircuito', 'cfgConsejo', 'cfgCalle'];
    campos.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = this.configGeo[id.replace('cfg', '').toLowerCase()] || '';
    });
  }

  abrirConfiguracion() { this.llenarConfiguracion(); this.mostrarPantalla('screenConfig'); }

  async guardarConfiguracion() {
    const config = { clave: 'geografica', estado: document.getElementById('cfgEstado').value.trim(), municipio: document.getElementById('cfgMunicipio').value.trim(), parroquia: document.getElementById('cfgParroquia').value.trim(), circuito: document.getElementById('cfgCircuito').value.trim(), consejo: document.getElementById('cfgConsejo').value.trim(), calle: document.getElementById('cfgCalle').value.trim() };
    const obligatorios = ['estado', 'municipio', 'parroquia', 'consejo', 'calle'];
    for (const campo of obligatorios) { if (!config[campo]) { this.mostrarToast(`Complete todos los campos obligatorios`, 'error'); return; } }
    this.configGeo = config;
    await this.dbOperation('configuracion', 'readwrite', store => store.put(config));
    this.mostrarToast('Configuracion guardada', 'success');
    this.volverMenu();
  }

  async capturarGPS(pantalla) {
    const indicator = document.getElementById(`gps${pantalla}`);
    if (!indicator) return;
    indicator.className = 'gps-indicator obtaining';
    indicator.innerHTML = '📡 Obteniendo GPS...';
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        indicator.className = 'gps-indicator failed'; indicator.innerHTML = '❌ GPS no disponible';
        this.currentGPS = { latitud: '', longitud: '', precision: '' }; resolve(this.currentGPS); return;
      }
      const timeout = setTimeout(() => {
        indicator.className = 'gps-indicator failed'; indicator.innerHTML = '⚠️ GPS no obtenido (timeout)';
        this.currentGPS = { latitud: '', longitud: '', precision: '' }; resolve(this.currentGPS);
      }, CONFIG.GPS_TIMEOUT);
      navigator.geolocation.getCurrentPosition(
        (position) => {
          clearTimeout(timeout);
          this.currentGPS = { latitud: position.coords.latitude, longitud: position.coords.longitude, precision: position.coords.accuracy };
          indicator.className = 'gps-indicator obtained'; indicator.innerHTML = `✅ GPS OK (${this.currentGPS.precision.toFixed(0)}m)`;
          resolve(this.currentGPS);
        },
        (error) => {
          clearTimeout(timeout); indicator.className = 'gps-indicator failed';
          let msg = '⚠️ GPS no disponible';
          if (error.code === 1) msg = '⚠️ Permiso de GPS denegado';
          if (error.code === 2) msg = '⚠️ GPS no puede determinar posicion';
          indicator.innerHTML = msg;
          this.currentGPS = { latitud: '', longitud: '', precision: '' }; resolve(this.currentGPS);
        },
        { enableHighAccuracy: true, timeout: CONFIG.GPS_TIMEOUT, maximumAge: 0 }
      );
    });
  }

  async cargarBaseVecinos() {
    try {
      const vecinos = await this.dbOperation('vecinos', 'readonly', store => store.getAll());
      this.baseVecinos = vecinos;
      const fecha = await this.dbOperation('metadatos', 'readonly', store => store.get('vecinos_fecha'));
      this.actualizarIndicadorVecinos(vecinos.length, fecha ? fecha.valor : null);
    } catch (e) { console.log('[Vecinos] Error cargando:', e); }
  }

  actualizarIndicadorVecinos(cantidad, fecha) {
    const el = document.getElementById('loginDbStatus');
    const elMenu = document.getElementById('statVecinos');
    const elFecha = document.getElementById('lastVecinosUpdate');
    if (el) el.textContent = `Base vecinos: ${cantidad} registros`;
    if (elMenu) elMenu.textContent = cantidad;
    if (elFecha) elFecha.textContent = fecha ? this.formatearFecha(fecha) : 'Sin datos';
  }

  buscarVecino(tipo) {
    const inputId = tipo === 'am' ? 'amCedula' : tipo === 'nna' ? 'nnaCedula' : 'repCedula';
    const cedula = document.getElementById(inputId).value.trim();
    const resultadoId = tipo === 'am' ? 'amBusquedaResultado' : tipo === 'nna' ? 'nnaBusquedaResultado' : 'repBusquedaResultado';
    const contenedor = document.getElementById(resultadoId);
    if (!contenedor) return;
    if (cedula.length < CONFIG.MIN_CEDULA_DIGITOS) { contenedor.innerHTML = ''; return; }
    let vecino = this.baseVecinos.find(v => v.Cedula === cedula);
    if (!vecino) vecino = this.baseVecinos.find(v => v.Cedula && v.Cedula.includes(cedula));
    if (vecino) {
      this.autocompletarCampos(tipo, vecino);
      contenedor.innerHTML = `<div class="alert alert-success">✅ <strong>Datos encontrados.</strong> Verifique la informacion y edite si esta desactualizada.</div>`;
    } else {
      this.limpiarAutocompletado(tipo);
      contenedor.innerHTML = `<div class="alert alert-warning">⚠️ <strong>Cedula no registrada.</strong> Complete los datos manualmente.</div>`;
    }
  }

  autocompletarCampos(tipo, vecino) {
    const campos = { am: ['amNombre', 'amTelefono', 'amSector', 'amCalle', 'amNroCasa', 'amReferencia'], nna: ['nnaNombre', 'nnaSector', 'nnaCalle', 'nnaNroCasa', 'nnaReferencia'], rep: ['repNombre', 'repTelefono'] };
    const mapeo = { amNombre: 'Nombre_y_Apellido', amTelefono: 'Telefono', amSector: 'Sector', amCalle: 'Calle_Avenida', amNroCasa: 'Nro_Casa', amReferencia: 'Referencia', nnaNombre: 'Nombre_y_Apellido', nnaSector: 'Sector', nnaCalle: 'Calle_Avenida', nnaNroCasa: 'Nro_Casa', nnaReferencia: 'Referencia', repNombre: 'Nombre_y_Apellido', repTelefono: 'Telefono' };
    campos[tipo].forEach(campoId => {
      const el = document.getElementById(campoId);
      if (el && vecino[mapeo[campoId]]) { el.value = vecino[mapeo[campoId]]; el.classList.add('autocomplete-field'); }
    });
  }

  limpiarAutocompletado(tipo) {
    const campos = { am: ['amNombre', 'amTelefono', 'amSector', 'amCalle', 'amNroCasa', 'amReferencia'], nna: ['nnaNombre', 'nnaSector', 'nnaCalle', 'nnaNroCasa', 'nnaReferencia'], rep: ['repNombre', 'repTelefono'] };
    campos[tipo].forEach(campoId => { const el = document.getElementById(campoId); if (el) { el.value = ''; el.classList.remove('autocomplete-field'); } });
  }

  abrirFormulario(tipo) {
    if (tipo === 'adultos') { this.mostrarPantalla('screenAdultos'); this.resetearFormularioAdultos(); this.capturarGPS('Adultos'); }
    else if (tipo === 'nna') { this.mostrarPantalla('screenNNA'); this.resetearFormularioNNA(); this.capturarGPS('NNA'); }
  }

  resetearFormularioAdultos() {
    this.currentEncuesta = { tipo: 'adultos', datos: {} }; this.currentSeccion = null;
    ['amCedula', 'amNombre', 'amTelefono', 'amSector', 'amCalle', 'amNroCasa', 'amReferencia', 'amNecesidad', 'amBNecesidad'].forEach(id => { const el = document.getElementById(id); if (el) { el.value = ''; el.classList.remove('autocomplete-field'); } });
    ['amEstadoCaso', 'amBEstadoCaso'].forEach(id => { const el = document.getElementById(id); if (el) el.selectedIndex = 0; });
    document.querySelectorAll('.option-btn').forEach(btn => btn.classList.remove('selected-yes', 'selected-no'));
    document.querySelectorAll('.radio-item').forEach(item => item.classList.remove('selected'));
    document.querySelectorAll('input[type="radio"]').forEach(r => r.checked = false);
    document.querySelectorAll('.checkbox-item').forEach(item => item.classList.remove('checked'));
    document.querySelectorAll('input[type="checkbox"]').forEach(c => c.checked = false);
    ['amB_SaludOtro'].forEach(id => { const el = document.getElementById(id); if (el) el.classList.add('hidden'); });
    document.getElementById('pasoAdultos1').classList.remove('hidden');
    document.getElementById('pasoAdultos2').classList.add('hidden');
    document.getElementById('pasoAdultos3A').classList.add('hidden');
    document.getElementById('pasoAdultos3B').classList.add('hidden');
    document.getElementById('progressAdultos').style.width = '33%';
    document.getElementById('progressTextAdultos').textContent = 'Paso 1 de 3: Datos personales';
    document.getElementById('adultosPaso').textContent = 'Paso 1 de 3';
    document.getElementById('adultosSubtitle').textContent = 'Datos personales';
    const busqueda = document.getElementById('amBusquedaResultado'); if (busqueda) busqueda.innerHTML = '';
  }

  adultosSiguiente(paso) {
    if (paso === 2) {
      const cedula = document.getElementById('amCedula').value.trim();
      const nombre = document.getElementById('amNombre').value.trim();
      if (!cedula) { this.mostrarToast('Ingrese la cedula', 'error'); return; }
      if (!this.validarCedulaVenezuela(cedula)) { this.mostrarToast('Cedula invalida. Use solo numeros (6-9 digitos).', 'error'); return; }
      if (!nombre) { this.mostrarToast('Ingrese nombre y apellido', 'error'); return; }
      document.getElementById('pasoAdultos1').classList.add('hidden');
      document.getElementById('pasoAdultos2').classList.remove('hidden');
      document.getElementById('progressAdultos').style.width = '66%';
      document.getElementById('progressTextAdultos').textContent = 'Paso 2 de 3: Seleccion de seccion';
      document.getElementById('adultosPaso').textContent = 'Paso 2 de 3';
      document.getElementById('adultosSubtitle').textContent = 'Seleccion de seccion';
    }
  }

  adultosAnterior(paso) {
    if (paso === 1) {
      document.getElementById('pasoAdultos2').classList.add('hidden');
      document.getElementById('pasoAdultos1').classList.remove('hidden');
      document.getElementById('progressAdultos').style.width = '33%';
      document.getElementById('progressTextAdultos').textContent = 'Paso 1 de 3: Datos personales';
      document.getElementById('adultosPaso').textContent = 'Paso 1 de 3';
      document.getElementById('adultosSubtitle').textContent = 'Datos personales';
    } else if (paso === 2) {
      document.getElementById('pasoAdultos3A').classList.add('hidden');
      document.getElementById('pasoAdultos3B').classList.add('hidden');
      document.getElementById('pasoAdultos2').classList.remove('hidden');
      document.getElementById('progressAdultos').style.width = '66%';
      document.getElementById('progressTextAdultos').textContent = 'Paso 2 de 3: Seleccion de seccion';
      document.getElementById('adultosPaso').textContent = 'Paso 2 de 3';
      document.getElementById('adultosSubtitle').textContent = 'Seleccion de seccion';
    }
  }

  seleccionarSeccionAdultos(seccion) {
    this.currentSeccion = seccion;
    document.getElementById('pasoAdultos2').classList.add('hidden');
    if (seccion === 'A') { document.getElementById('pasoAdultos3A').classList.remove('hidden'); document.getElementById('adultosSubtitle').textContent = 'Seccion A - Verificacion'; }
    else { document.getElementById('pasoAdultos3B').classList.remove('hidden'); document.getElementById('adultosSubtitle').textContent = 'Seccion B - Registro Nuevo'; }
    document.getElementById('progressAdultos').style.width = '100%';
    document.getElementById('progressTextAdultos').textContent = `Paso 3 de 3: Seccion ${seccion}`;
    document.getElementById('adultosPaso').textContent = 'Paso 3 de 3';
  }

  resetearFormularioNNA() {
    this.currentEncuesta = { tipo: 'nna', datos: {} };
    ['nnaCedula', 'nnaNombre', 'nnaEdad', 'nnaGrado', 'repCedula', 'repNombre', 'repTelefono', 'repParentesco', 'nnaFechaInscripcion', 'nnaNotas'].forEach(id => { const el = document.getElementById(id); if (el) { el.value = ''; el.classList.remove('autocomplete-field'); } });
    const estadoCaso = document.getElementById('nnaEstadoCaso'); if (estadoCaso) estadoCaso.selectedIndex = 0;
    document.querySelectorAll('#screenNNA .option-btn').forEach(btn => btn.classList.remove('selected-yes', 'selected-no'));
    document.querySelectorAll('#screenNNA .checkbox-item').forEach(item => item.classList.remove('checked'));
    document.querySelectorAll('#screenNNA input[type="checkbox"]').forEach(c => c.checked = false);
    ['nnaDocOtro', 'nnaAccOtro', 'nnaLabOtro', 'nnaTutOtro', 'nnaEcoOtro'].forEach(id => { const el = document.getElementById(id); if (el) el.classList.add('hidden'); });
    ['pasoNNA1', 'pasoNNA2', 'pasoNNA3', 'pasoNNA4'].forEach((id, i) => { const el = document.getElementById(id); if (el) el.classList.toggle('hidden', i !== 0); });
    document.getElementById('progressNNA').style.width = '25%';
    document.getElementById('progressTextNNA').textContent = 'Paso 1 de 4: Datos del NNA';
    document.getElementById('nnaPaso').textContent = 'Paso 1 de 4';
    document.getElementById('nnaSubtitle').textContent = 'Datos del NNA';
    const busquedaNNA = document.getElementById('nnaBusquedaResultado');
    const busquedaRep = document.getElementById('repBusquedaResultado');
    if (busquedaNNA) busquedaNNA.innerHTML = '';
    if (busquedaRep) busquedaRep.innerHTML = '';
  }

  nnaSiguiente(paso) {
    if (paso === 2) {
      const nnaNombre = document.getElementById('nnaNombre').value.trim();
      const nnaEdad = document.getElementById('nnaEdad').value;
      const nnaGrado = document.getElementById('nnaGrado').value;
      if (!nnaNombre) { this.mostrarToast('Ingrese nombre y apellido del NNA', 'error'); return; }
      if (!nnaEdad || nnaEdad < 0 || nnaEdad > 18) { this.mostrarToast('Ingrese una edad valida del NNA (0-18)', 'error'); return; }
      if (!nnaGrado) { this.mostrarToast('Seleccione el ultimo grado cursado', 'error'); return; }
      document.getElementById('pasoNNA1').classList.add('hidden');
      document.getElementById('pasoNNA2').classList.remove('hidden');
      document.getElementById('progressNNA').style.width = '50%';
      document.getElementById('progressTextNNA').textContent = 'Paso 2 de 4: Datos del representante';
      document.getElementById('nnaPaso').textContent = 'Paso 2 de 4';
      document.getElementById('nnaSubtitle').textContent = 'Datos del representante';
    } else if (paso === 3) {
      const repNombre = document.getElementById('repNombre').value.trim();
      const repParentesco = document.getElementById('repParentesco').value;
      if (!repNombre) { this.mostrarToast('Ingrese nombre y apellido del representante', 'error'); return; }
      if (!repParentesco) { this.mostrarToast('Seleccione el parentesco', 'error'); return; }
      document.getElementById('pasoNNA2').classList.add('hidden');
      document.getElementById('pasoNNA3').classList.remove('hidden');
      document.getElementById('progressNNA').style.width = '75%';
      document.getElementById('progressTextNNA').textContent = 'Paso 3 de 4: Causas de desescolarizacion';
      document.getElementById('nnaPaso').textContent = 'Paso 3 de 4';
      document.getElementById('nnaSubtitle').textContent = 'Causas de desescolarizacion';
    } else if (paso === 4) {
      document.getElementById('pasoNNA3').classList.add('hidden');
      document.getElementById('pasoNNA4').classList.remove('hidden');
      document.getElementById('progressNNA').style.width = '100%';
      document.getElementById('progressTextNNA').textContent = 'Paso 4 de 4: Seguimiento';
      document.getElementById('nnaPaso').textContent = 'Paso 4 de 4';
      document.getElementById('nnaSubtitle').textContent = 'Seguimiento del caso';
    }
  }

  nnaAnterior(paso) {
    if (paso === 1) {
      document.getElementById('pasoNNA2').classList.add('hidden');
      document.getElementById('pasoNNA1').classList.remove('hidden');
      document.getElementById('progressNNA').style.width = '25%';
      document.getElementById('progressTextNNA').textContent = 'Paso 1 de 4: Datos del NNA';
      document.getElementById('nnaPaso').textContent = 'Paso 1 de 4';
      document.getElementById('nnaSubtitle').textContent = 'Datos del NNA';
    } else if (paso === 2) {
      document.getElementById('pasoNNA3').classList.add('hidden');
      document.getElementById('pasoNNA2').classList.remove('hidden');
      document.getElementById('progressNNA').style.width = '50%';
      document.getElementById('progressTextNNA').textContent = 'Paso 2 de 4: Datos del representante';
      document.getElementById('nnaPaso').textContent = 'Paso 2 de 4';
      document.getElementById('nnaSubtitle').textContent = 'Datos del representante';
    } else if (paso === 3) {
      document.getElementById('pasoNNA4').classList.add('hidden');
      document.getElementById('pasoNNA3').classList.remove('hidden');
      document.getElementById('progressNNA').style.width = '75%';
      document.getElementById('progressTextNNA').textContent = 'Paso 3 de 4: Causas de desescolarizacion';
      document.getElementById('nnaPaso').textContent = 'Paso 3 de 4';
      document.getElementById('nnaSubtitle').textContent = 'Causas de desescolarizacion';
    }
  }

  selectOption(btn) {
    const name = btn.dataset.name; const value = btn.dataset.value;
    document.querySelectorAll(`[data-name="${name}"]`).forEach(b => { b.classList.remove('selected-yes', 'selected-no'); });
    btn.classList.add(value === 'SI' ? 'selected-yes' : 'selected-no');
  }

  selectRadio(item, name) {
    document.querySelectorAll(`input[name="${name}"]`).forEach(r => { r.checked = false; const parent = r.closest('.radio-item'); if (parent) parent.classList.remove('selected'); });
    const radio = item.querySelector('input[type="radio"]');
    if (radio) { radio.checked = true; item.classList.add('selected'); }
  }

  toggleCheckbox(item) {
    const checkbox = item.querySelector('input[type="checkbox"]');
    if (checkbox) { checkbox.checked = !checkbox.checked; item.classList.toggle('checked', checkbox.checked); }
  }

  toggleOtro(campoId) {
    const checkbox = event.target;
    const campo = document.getElementById(campoId);
    if (campo) campo.classList.toggle('hidden', !checkbox.checked);
  }

  // Botones toggle para NNA (mejor UX en móviles)
  toggleBtn(btn, checkboxId) {
    const checkbox = document.getElementById(checkboxId);
    if (!checkbox) return;
    checkbox.checked = !checkbox.checked;
    btn.classList.toggle('selected', checkbox.checked);
    btn.textContent = checkbox.checked ? '✅ ' + btn.textContent.replace('❌ ', '').replace('✅ ', '') : '❌ ' + btn.textContent.replace('❌ ', '').replace('✅ ', '');
  }

  toggleBtnOtro(btn, checkboxId, campoId) {
    const checkbox = document.getElementById(checkboxId);
    const campo = document.getElementById(campoId);
    if (!checkbox) return;
    checkbox.checked = !checkbox.checked;
    btn.classList.toggle('selected', checkbox.checked);
    btn.textContent = checkbox.checked ? '✅ ' + btn.textContent.replace('❌ ', '').replace('✅ ', '') : '❌ ' + btn.textContent.replace('❌ ', '').replace('✅ ', '');
    if (campo) campo.classList.toggle('hidden', !checkbox.checked);
  }

  async guardarEncuesta(tipo, seccion = null) {
    const id = this.generarId();
    const fechaHora = new Date().toISOString();
    const datos = this.recolectarDatos(tipo, seccion);
    if (!datos) return;
    const encuesta = { id: id, tipo: tipo, seccion: seccion, encuestador: this.session.nombre, encuestadorId: this.session.encuestadorId, fecha: fechaHora, fechaSincronizacion: null, estadoSync: 'pendiente', versionApp: CONFIG.VERSION, datos: datos };
    try {
      await this.dbOperation('encuestas', 'readwrite', store => store.put(encuesta));
      this.mostrarToast('Encuesta guardada correctamente', 'success');
      this.volverMenu();
    } catch (error) {
      console.error('[Guardar] Error:', error);
      this.mostrarToast('Error al guardar encuesta. Intente de nuevo.', 'error');
    }
  }

  async guardarBorrador(tipo, seccion = null) {
    const id = this.currentEncuesta && this.currentEncuesta.id ? this.currentEncuesta.id : this.generarId();
    const datos = this.recolectarDatos(tipo, seccion, true);
    const borrador = { id: id, tipo: tipo, seccion: seccion, encuestador: this.session.nombre, encuestadorId: this.session.encuestadorId, fecha: new Date().toISOString(), estadoSync: 'borrador', versionApp: CONFIG.VERSION, datos: datos };
    this.currentEncuesta = borrador;
    try { await this.dbOperation('encuestas', 'readwrite', store => store.put(borrador)); this.mostrarToast('Borrador guardado', 'info'); }
    catch (error) { console.error('[Borrador] Error:', error); }
  }

recolectarDatos(tipo, seccion, esBorrador = false) {
    const datos = {
      gps: this.currentGPS || { latitud: '', longitud: '', precision: '' },
      geograficos: this.configGeo || {}
    };

    if (tipo === 'adultos') {
      datos.cedula = document.getElementById('amCedula').value.trim();
      datos.nombre_apellido = document.getElementById('amNombre').value.trim();
      datos.telefono = document.getElementById('amTelefono').value.trim();
      datos.sector = document.getElementById('amSector').value.trim();
      datos.calle = document.getElementById('amCalle').value.trim();
      datos.nroCasa = document.getElementById('amNroCasa').value.trim();
      datos.referencia = document.getElementById('amReferencia').value.trim();
      datos.autocompletado = document.getElementById('amNombre').classList.contains('autocomplete-field') ? 'SI' : 'NO';

      if (!esBorrador) {
        if (!datos.cedula || !datos.nombre_apellido) {
          this.mostrarToast('Complete los datos personales obligatorios', 'error');
          return null;
        }
      }

      if (seccion === 'A') {
        datos.vive_solo = this.getOptionValue('amViveSolo');
        datos.sosten = this.getOptionValue('amSosten');
        datos.ingresos_suficientes = this.getOptionValue('amIngresos');
        datos.salud_dependencia = this.getOptionValue('amSaludDependencia');
        datos.necesidad = document.getElementById('amNecesidad').value.trim();
        datos.estadoCaso = document.getElementById('amEstadoCaso').value || 'pendiente';
      } else if (seccion === 'B') {
        datos.sosten = this.getOptionValue('amB_Sosten');
        datos.situacion_vivienda = this.getRadioValue('amB_Vivienda');
        datos.cant_miembros = this.getRadioValue('amB_Miembros');
        datos.miembros_ingreso = this.getRadioValue('amB_IngresosMiembro');
        datos.salud_encamado = document.getElementById('amB_Encamado').checked ? 'SI' : 'NO';
        datos.salud_parkinson = document.getElementById('amB_Parkinson').checked ? 'SI' : 'NO';
        datos.salud_alzheimer = document.getElementById('amB_Alzheimer').checked ? 'SI' : 'NO';
        datos.salud_trastorno = document.getElementById('amB_Trastorno').checked ? 'SI' : 'NO';
        datos.salud_insuf_renal = document.getElementById('amB_InsufRenal').checked ? 'SI' : 'NO';
        datos.salud_cancer = document.getElementById('amB_Cancer').checked ? 'SI' : 'NO';
        datos.salud_insuf_cardiaca = document.getElementById('amB_InsufCardiaca').checked ? 'SI' : 'NO';
        datos.salud_artritis = document.getElementById('amB_Artritis').checked ? 'SI' : 'NO';
        datos.salud_esclerosis = document.getElementById('amB_Esclerosis').checked ? 'SI' : 'NO';
        datos.salud_otro = document.getElementById('amB_SaludOtroCheck').checked ?
          (document.querySelector('#amB_SaludOtro input')?.value || 'SI') : 'NO';
        datos.situacion_economica = this.getRadioValue('amB_Economica');
        datos.necesidad = document.getElementById('amBNecesidad').value.trim();
        datos.estadoCaso = document.getElementById('amBEstadoCaso').value || 'pendiente';
      }
    } else if (tipo === 'nna') {
      datos.nna_cedula = document.getElementById('nnaCedula').value.trim();
      datos.nna_nombre_apellido = document.getElementById('nnaNombre').value.trim();
      datos.nna_edad = document.getElementById('nnaEdad').value;
      datos.nna_grado = document.getElementById('nnaGrado').value;
      datos.nna_autocompletado = document.getElementById('nnaNombre').classList.contains('autocomplete-field') ? 'SI' : 'NO';

      datos.rep_cedula = document.getElementById('repCedula').value.trim();
      datos.rep_nombre_apellido = document.getElementById('repNombre').value.trim();
      datos.rep_telefono = document.getElementById('repTelefono').value.trim();
      datos.rep_parentesco = document.getElementById('repParentesco').value;
      datos.rep_autocompletado = document.getElementById('repNombre').classList.contains('autocomplete-field') ? 'SI' : 'NO';

      if (!esBorrador) {
        if (!datos.nna_nombre_apellido || !datos.nna_edad || !datos.nna_grado) {
          this.mostrarToast('Complete los datos del NNA', 'error');
          return null;
        }
        if (!datos.rep_nombre_apellido || !datos.rep_parentesco) {
          this.mostrarToast('Complete los datos del representante', 'error');
          return null;
        }
      }

      datos.doc_falta_cedula = document.getElementById('nnaDocCedula').checked ? 'SI' : 'NO';
      datos.doc_falta_partida = document.getElementById('nnaDocPartida').checked ? 'SI' : 'NO';
      datos.doc_falta_constancia = document.getElementById('nnaDocConstancia').checked ? 'SI' : 'NO';
      datos.doc_otro = document.getElementById('nnaDocOtroCheck').checked ?
        (document.querySelector('#nnaDocOtro input')?.value || 'SI') : 'NO';

      datos.acceso_lejania = document.getElementById('nnaAccLejania').checked ? 'SI' : 'NO';
      datos.acceso_transporte = document.getElementById('nnaAccTransporte').checked ? 'SI' : 'NO';
      datos.acceso_riesgos = document.getElementById('nnaAccRiesgos').checked ? 'SI' : 'NO';
      datos.acceso_otro = document.getElementById('nnaAccOtroCheck').checked ?
        (document.querySelector('#nnaAccOtro input')?.value || 'SI') : 'NO';

      datos.laboral_aportar = document.getElementById('nnaLabAportar').checked ? 'SI' : 'NO';
      datos.laboral_informal = document.getElementById('nnaLabInformal').checked ? 'SI' : 'NO';
      datos.laboral_rep = document.getElementById('nnaLabRep').checked ? 'SI' : 'NO';
      datos.laboral_hermanos = document.getElementById('nnaLabHermanos').checked ? 'SI' : 'NO';
      datos.laboral_otro = document.getElementById('nnaLabOtroCheck').checked ?
        (document.querySelector('#nnaLabOtro input')?.value || 'SI') : 'NO';

      datos.tutelaje_ausencia = document.getElementById('nnaTutAusencia').checked ? 'SI' : 'NO';
      datos.tutelaje_desconocimiento = document.getElementById('nnaTutDesconocimiento').checked ? 'SI' : 'NO';
      datos.tutelaje_acompanamiento = document.getElementById('nnaTutAcompanamiento').checked ? 'SI' : 'NO';
      datos.tutelaje_otro = document.getElementById('nnaTutOtroCheck').checked ?
        (document.querySelector('#nnaTutOtro input')?.value || 'SI') : 'NO';

      datos.economico_utiles = document.getElementById('nnaEcoUtiles').checked ? 'SI' : 'NO';
      datos.economico_alimentacion = document.getElementById('nnaEcoAlimentacion').checked ? 'SI' : 'NO';
      datos.economico_deudas = document.getElementById('nnaEcoDeudas').checked ? 'SI' : 'NO';
      datos.economico_inestabilidad = document.getElementById('nnaEcoInestabilidad').checked ? 'SI' : 'NO';
      datos.economico_apoyo = document.getElementById('nnaEcoApoyo').checked ? 'SI' : 'NO';
      datos.economico_otro = document.getElementById('nnaEcoOtroCheck').checked ?
        (document.querySelector('#nnaEcoOtro input')?.value || 'SI') : 'NO';

      datos.inscrito_escuela = this.getOptionValue('nnaInscrito');
      datos.fecha_inscripcion = document.getElementById('nnaFechaInscripcion').value;
      datos.notas_seguimiento = document.getElementById('nnaNotas').value.trim();
      datos.estadoCaso = document.getElementById('nnaEstadoCaso').value || 'pendiente';
    }

    return datos;
  }

  getOptionValue(name) {
    const selected = document.querySelector(`[data-name="${name}"].selected-yes, [data-name="${name}"].selected-no`);
    return selected ? selected.dataset.value : 'NO';
  }

  getRadioValue(name) {
    const selected = document.querySelector(`input[name="${name}"]:checked`);
    return selected ? selected.value : '';
  }

  generarId() {
    const encuestador = this.session.encuestadorId || '0';
    const fecha = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    return `${encuestador}_${fecha}_${random}`;
  }

  // ============================================
  // SINCRONIZACION CON REINTENTOS Y MANEJO DE ERRORES
  // ============================================

  detectarConexion() {
    const updateStatus = () => {
      const online = navigator.onLine;
      const indicator = document.getElementById('statusOnline');
      const text = document.getElementById('statusText');
      if (indicator) indicator.className = online ? 'status-indicator online' : 'status-indicator offline';
      if (text) text.textContent = online ? 'Conectado' : 'Sin conexion';
      if (online) this.sincronizarAutomatica();
    };
    window.addEventListener('online', updateStatus);
    window.addEventListener('offline', updateStatus);
    updateStatus();
  }

  async sincronizarAutomatica() {
    if (!CONFIG.SCRIPT_URL) { console.log('[Sync] URL del script no configurada'); return; }
    try {
      this.mostrarLoading('Sincronizando datos...');
      await this.descargarBaseVecinos();
      await this.enviarEncuestasPendientes();
      await this.descargarPreguntasAdicionales();
      await this.descargarEncuestadores();
      await this.guardarMetadato('ultima_sync', new Date().toISOString());
      this.actualizarEstadisticasMenu();
      this.mostrarToast('Sincronizacion completada', 'success');
    } catch (error) {
      console.error('[Sync] Error:', error);
      this.mostrarToast('Error en sincronizacion. Se reintentara.', 'warning');
    } finally {
      this.ocultarLoading();
    }
  }

  async sincronizarManual() {
    if (!navigator.onLine) { this.mostrarToast('No hay conexion a internet', 'warning'); return; }
    await this.sincronizarAutomatica();
  }

  async fetchConReintentos(url, options = {}, maxRetries = CONFIG.MAX_SYNC_RETRIES) {
    let lastError;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await fetch(url, {
          ...options,
          headers: { 'Content-Type': 'application/json', ...options.headers }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        const data = await response.json();
        if (typeof data !== 'object' || data === null) throw new Error('Respuesta invalida del servidor');
        return data;
      } catch (error) {
        lastError = error;
        console.warn(`[Fetch] Intento ${i + 1} fallido:`, error.message);
        if (i < maxRetries - 1) await new Promise(r => setTimeout(r, CONFIG.SYNC_RETRY_DELAY * (i + 1)));
      }
    }
    throw lastError;
  }

  async descargarBaseVecinos() {
    try {
      const data = await this.fetchConReintentos(CONFIG.SCRIPT_URL, {
        method: 'POST',
        body: JSON.stringify({ token: CONFIG.TOKEN_SEGURIDAD, action: 'getVecinos' })
      });
      if (data.success && data.vecinos) {
        await this.dbOperation('vecinos', 'readwrite', store => store.clear());
        for (const vecino of data.vecinos) await this.dbOperation('vecinos', 'readwrite', store => store.put(vecino));
        this.baseVecinos = data.vecinos;
        await this.guardarMetadato('vecinos_fecha', new Date().toISOString());
        this.actualizarIndicadorVecinos(data.vecinos.length, new Date().toISOString());
        console.log(`[Sync] ${data.vecinos.length} vecinos descargados`);
      }
    } catch (e) { console.error('[Sync] Error descargando vecinos:', e); throw e; }
  }

  async enviarEncuestasPendientes() {
    try {
      const pendientes = await this.dbOperation('encuestas', 'readonly', store => store.index('estadoSync').getAll('pendiente'));
      if (pendientes.length === 0) { console.log('[Sync] No hay encuestas pendientes'); return; }
      console.log(`[Sync] Enviando ${pendientes.length} encuestas...`);
      let exitosos = 0, fallidos = 0;
      for (const encuesta of pendientes) {
        try {
          const result = await this.fetchConReintentos(CONFIG.SCRIPT_URL, {
            method: 'POST',
            body: JSON.stringify({ token: CONFIG.TOKEN_SEGURIDAD, action: 'guardarEncuesta', encuesta: encuesta })
          });
          if (result.success) {
            encuesta.estadoSync = 'sincronizado';
            encuesta.fechaSincronizacion = new Date().toISOString();
            await this.dbOperation('encuestas', 'readwrite', store => store.put(encuesta));
            exitosos++;
          } else { console.error('[Sync] Error del servidor:', result.error); fallidos++; }
        } catch (e) { console.error('[Sync] Error enviando encuesta:', e); fallidos++; }
      }
      console.log(`[Sync] Resultado: ${exitosos} exitosos, ${fallidos} fallidos`);
      if (fallidos > 0) this.mostrarToast(`${fallidos} encuestas no pudieron sincronizarse`, 'warning');
    } catch (e) { console.error('[Sync] Error en envio:', e); throw e; }
  }

  async descargarPreguntasAdicionales() {
    try {
      const data = await this.fetchConReintentos(CONFIG.SCRIPT_URL, {
        method: 'POST',
        body: JSON.stringify({ token: CONFIG.TOKEN_SEGURIDAD, action: 'getPreguntas' })
      });
      if (data.success && data.preguntas) {
        await this.dbOperation('preguntas', 'readwrite', store => store.clear());
        for (const pregunta of data.preguntas) await this.dbOperation('preguntas', 'readwrite', store => store.put(pregunta));
        this.preguntasAdicionales = data.preguntas;
      }
    } catch (e) { console.error('[Sync] Error descargando preguntas:', e); }
  }

  async descargarEncuestadores() {
    try {
      const data = await this.fetchConReintentos(CONFIG.SCRIPT_URL, {
        method: 'POST',
        body: JSON.stringify({ token: CONFIG.TOKEN_SEGURIDAD, action: 'getEncuestadores' })
      });
      if (data.success && data.encuestadores) {
        await this.dbOperation('encuestadores', 'readwrite', store => store.clear());
        for (const enc of data.encuestadores) await this.dbOperation('encuestadores', 'readwrite', store => store.put(enc));
        this.encuestadores = data.encuestadores;
        this.actualizarSelectEncuestadores();
      }
    } catch (e) { console.error('[Sync] Error descargando encuestadores:', e); }
  }

  async guardarMetadato(clave, valor) {
    await this.dbOperation('metadatos', 'readwrite', store => store.put({ clave, valor }));
  }

  // ============================================
  // SEGUIMIENTO DE CASOS
  // ============================================

  async abrirSeguimiento() {
    this.mostrarPantalla('screenSeguimiento');
    await this.cargarCasos('todos');
  }

  async cargarCasos(filtro) {
    try {
      let casos = await this.dbOperation('encuestas', 'readonly', store => store.getAll());
      casos = casos.filter(c => c.encuestadorId === this.session.encuestadorId);
      if (filtro === 'adultos') casos = casos.filter(c => c.tipo === 'adultos');
      else if (filtro === 'nna') casos = casos.filter(c => c.tipo === 'nna');
      else if (filtro === 'pendiente') casos = casos.filter(c => c.datos.estadoCaso === 'pendiente');
      else if (filtro === 'proceso') casos = casos.filter(c => c.datos.estadoCaso === 'proceso');
      else if (filtro === 'resuelto') casos = casos.filter(c => c.datos.estadoCaso === 'resuelto');

      const contenedor = document.getElementById('casosLista');
      if (casos.length === 0) { contenedor.innerHTML = '<div class="alert alert-info">📋 No hay casos registrados</div>'; return; }
      contenedor.innerHTML = casos.map(caso => this.renderizarCaso(caso)).join('');
    } catch (e) { console.error('[Casos] Error cargando:', e); }
  }

  renderizarCaso(caso) {
    const estado = caso.datos.estadoCaso || 'pendiente';
    const nombre = caso.tipo === 'adultos' ? (caso.datos.nombre_apellido || 'Sin nombre') : (caso.datos.nna_nombre_apellido || 'Sin nombre');
    const tipo = caso.tipo === 'adultos' ? '👴 Adulto Mayor' : '👦 NNA';
    const seccion = caso.seccion ? ` - Sec. ${caso.seccion}` : '';
    const fecha = this.formatearFecha(caso.fecha);
    const sync = caso.estadoSync === 'sincronizado' ? '✅' : '🔴';
    return `<div class="caso-item ${estado}" onclick="app.editarCaso('${caso.id}')"><div class="caso-header"><span class="caso-nombre">${nombre}</span><span class="caso-estado ${estado}">${estado.toUpperCase()}</span></div><div class="caso-info">${tipo}${seccion} | ${sync} ${fecha} | ${caso.encuestador}</div></div>`;
  }

  filtrarCasos(filtro, btn) {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    this.cargarCasos(filtro);
  }

  async editarCaso(id) {
    try {
      const caso = await this.dbOperation('encuestas', 'readonly', store => store.get(id));
      if (!caso) return;
      this.casoEditando = caso;
      const modal = document.getElementById('modalEditarCaso');
      const titulo = document.getElementById('modalCasoTitulo');
      const contenido = document.getElementById('modalCasoContent');
      const nombre = caso.tipo === 'adultos' ? (caso.datos.nombre_apellido || 'Sin nombre') : (caso.datos.nna_nombre_apellido || 'Sin nombre');
      titulo.textContent = `Editar: ${nombre}`;

      if (caso.tipo === 'adultos') {
        contenido.innerHTML = `<div class="form-group"><label class="form-label">Necesidad detectada</label><textarea id="editNecesidad" class="form-textarea">${caso.datos.necesidad || ''}</textarea></div><div class="form-group"><label class="form-label">Fue resuelta la necesidad?</label><div class="option-group"><button type="button" class="option-btn ${caso.datos.necesidadResuelta === 'SI' ? 'selected-yes' : ''}" data-name="editResuelta" data-value="SI" onclick="app.selectOption(this)">SI</button><button type="button" class="option-btn ${caso.datos.necesidadResuelta === 'NO' ? 'selected-no' : ''}" data-name="editResuelta" data-value="NO" onclick="app.selectOption(this)">NO</button></div></div><div class="form-group"><label class="form-label">Fecha de resolucion</label><input type="date" id="editFechaResolucion" class="form-input" value="${caso.datos.fechaResolucion || ''}"></div><div class="form-group"><label class="form-label">Notas de seguimiento</label><textarea id="editNotas" class="form-textarea">${caso.datos.notasSeguimiento || ''}</textarea></div><div class="form-group"><label class="form-label">Estado del caso</label><select id="editEstadoCaso" class="form-select"><option value="pendiente" ${caso.datos.estadoCaso === 'pendiente' ? 'selected' : ''}>Pendiente</option><option value="proceso" ${caso.datos.estadoCaso === 'proceso' ? 'selected' : ''}>En proceso</option><option value="resuelto" ${caso.datos.estadoCaso === 'resuelto' ? 'selected' : ''}>Resuelto</option></select></div>`;
      } else {
        contenido.innerHTML = `<div class="form-group"><label class="form-label">Fue inscrito en la escuela?</label><div class="option-group"><button type="button" class="option-btn ${caso.datos.inscritoEscuela === 'SI' ? 'selected-yes' : ''}" data-name="editInscrito" data-value="SI" onclick="app.selectOption(this)">SI</button><button type="button" class="option-btn ${caso.datos.inscritoEscuela === 'NO' ? 'selected-no' : ''}" data-name="editInscrito" data-value="NO" onclick="app.selectOption(this)">NO</button></div></div><div class="form-group"><label class="form-label">Fecha de inscripcion</label><input type="date" id="editFechaInscripcion" class="form-input" value="${caso.datos.fechaInscripcion || ''}"></div><div class="form-group"><label class="form-label">Notas de seguimiento</label><textarea id="editNotas" class="form-textarea">${caso.datos.notasSeguimiento || ''}</textarea></div><div class="form-group"><label class="form-label">Estado del caso</label><select id="editEstadoCaso" class="form-select"><option value="pendiente" ${caso.datos.estadoCaso === 'pendiente' ? 'selected' : ''}>Pendiente</option><option value="proceso" ${caso.datos.estadoCaso === 'proceso' ? 'selected' : ''}>En proceso</option><option value="resuelto" ${caso.datos.estadoCaso === 'resuelto' ? 'selected' : ''}>Resuelto</option></select></div>`;
      }
      modal.classList.add('active');
    } catch (e) { console.error('[Casos] Error editando:', e); }
  }

  async guardarCasoEditado() {
    if (!this.casoEditando) return;
    const caso = this.casoEditando;
    if (caso.tipo === 'adultos') {
      caso.datos.necesidad = document.getElementById('editNecesidad').value.trim();
      caso.datos.necesidadResuelta = this.getOptionValue('editResuelta');
      caso.datos.fechaResolucion = document.getElementById('editFechaResolucion').value;
      caso.datos.notasSeguimiento = document.getElementById('editNotas').value.trim();
      caso.datos.estadoCaso = document.getElementById('editEstadoCaso').value;
    } else {
      caso.datos.inscritoEscuela = this.getOptionValue('editInscrito');
      caso.datos.fechaInscripcion = document.getElementById('editFechaInscripcion').value;
      caso.datos.notasSeguimiento = document.getElementById('editNotas').value.trim();
      caso.datos.estadoCaso = document.getElementById('editEstadoCaso').value;
    }
    caso.estadoSync = 'pendiente';
    caso.fecha = new Date().toISOString();
    await this.dbOperation('encuestas', 'readwrite', store => store.put(caso));
    this.cerrarModal();
    this.mostrarToast('Caso actualizado', 'success');
    this.cargarCasos('todos');
  }

  cerrarModal() {
    document.getElementById('modalEditarCaso').classList.remove('active');
    this.casoEditando = null;
  }

  // ============================================
  // UTILIDADES Y UI
  // ============================================

  async actualizarEstadisticasMenu() {
    try {
      const todas = await this.dbOperation('encuestas', 'readonly', store => store.getAll());
      const pendientes = todas.filter(e => e.estadoSync === 'pendiente').length;
      const sincronizadas = todas.filter(e => e.estadoSync === 'sincronizado').length;
      const total = todas.length;
      const vecinos = this.baseVecinos.length;
      document.getElementById('statPendientes').textContent = pendientes;
      document.getElementById('statSincronizadas').textContent = sincronizadas;
      document.getElementById('statTotal').textContent = total;
      document.getElementById('statVecinos').textContent = vecinos;
      document.getElementById('statusPendientes').textContent = `🔴 ${pendientes} pendientes`;
      const ultimaSync = await this.dbOperation('metadatos', 'readonly', store => store.get('ultima_sync'));
      if (ultimaSync) document.getElementById('lastSync').textContent = this.formatearFecha(ultimaSync.valor);
    } catch (e) { console.error('[Stats] Error:', e); }
  }

  formatearFecha(fechaISO) {
    if (!fechaISO) return 'Nunca';
    try {
      const fecha = new Date(fechaISO);
      return fecha.toLocaleString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return fechaISO; }
  }

  mostrarToast(mensaje, tipo = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${tipo}`;
    toast.textContent = mensaje;
    container.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 3000);
  }

  mostrarLoading(texto) {
    document.getElementById('loadingText').textContent = texto || 'Cargando...';
    document.getElementById('loadingOverlay').classList.remove('hidden');
  }

  ocultarLoading() {
    document.getElementById('loadingOverlay').classList.add('hidden');
  }

  resetearFormularios() {
    this.currentEncuesta = null;
    this.currentSeccion = null;
    this.currentGPS = null;
  }

  iniciarAutoGuardado() {
    setInterval(() => {
      if (this.currentEncuesta && (this.currentEncuesta.estadoSync === 'borrador' || !this.currentEncuesta.estadoSync)) {
        this.guardarBorrador(this.currentEncuesta.tipo, this.currentSeccion);
      }
    }, CONFIG.BORRADOR_INTERVAL);
  }

  configurarEventos() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('service-worker.js')
        .then(reg => console.log('[SW] Registrado:', reg.scope))
        .catch(err => console.error('[SW] Error:', err));
    }
    document.addEventListener('focusin', (e) => {
      if (e.target.tagName === 'INPUT' && e.target.type === 'number') e.target.style.fontSize = '16px';
    });
    document.getElementById('loginPin')?.addEventListener('keypress', (e) => { if (e.key === 'Enter') this.login(); });
    document.getElementById('modalEditarCaso')?.addEventListener('click', (e) => { if (e.target.id === 'modalEditarCaso') this.cerrarModal(); });
  }

  validarCedulaVenezuela(cedula) {
    if (!cedula || cedula.length < 6 || cedula.length > 9) return false;
    if (!/^\d+$/.test(cedula)) return false;
    return true;
  }

  async exportarRespaldoCSV() {
    try {
      const encuestas = await this.dbOperation('encuestas', 'readonly', store => store.getAll());
      if (encuestas.length === 0) { this.mostrarToast('No hay datos para exportar', 'warning'); return; }
      let csv = 'ID,Tipo,Seccion,Encuestador,Fecha,EstadoSync,Cedula,Nombre\n';
      encuestas.forEach(e => {
        const nombre = e.tipo === 'adultos' ? (e.datos.nombre_apellido || '') : (e.datos.nna_nombre_apellido || '');
        const cedula = e.tipo === 'adultos' ? (e.datos.cedula || '') : (e.datos.nna_cedula || '');
        csv += `${e.id},${e.tipo},${e.seccion || ''},${e.encuestador},${e.fecha},${e.estadoSync},${cedula},"${nombre}"\n`;
      });
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `respaldo_diagnostico_${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      this.mostrarToast('Respaldo descargado', 'success');
    } catch (e) { console.error('[Respaldo] Error:', e); this.mostrarToast('Error al exportar', 'error'); }
  }
}

const app = new DiagSocialApp();
document.addEventListener('DOMContentLoaded', () => { app.init(); });
window.app = app;