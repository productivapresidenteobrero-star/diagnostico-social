// ============================================
// DIAGNOSTICO SOCIAL COMUNITARIO - APP.JS
// PWA Offline-First para trabajo de campo
// Version: 1.0.0
// ============================================

const CONFIG = {
  VERSION: '1.0.0',
  DB_NAME: 'DiagSocialDB',
  DB_VERSION: 1,
  SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbzLs9lJnuRauQIdiFitSrkQ_EFMHR8KcPkSzAabSVviANkvuffCG91cmRgFuNo3wmLE/exec'
  TOKEN_SEGURIDAD: 'diag-social-2024', // Cambiar en produccion
  GPS_TIMEOUT: 30000, // 30 segundos
  BORRADOR_INTERVAL: 30000, // 30 segundos
  MIN_CEDULA_DIGITOS: 6,
  MAX_VECINOS: 1000
};

// ============================================
// CLASE PRINCIPAL DE LA APLICACION
// ============================================

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
  }

  // ============================================
  // INICIALIZACION
  // ============================================

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
      console.log('[App] Inicializacion completada');
    } catch (error) {
      console.error('[App] Error en inicializacion:', error);
      this.mostrarToast('Error al iniciar la aplicacion', 'error');
    }
  }

  // ============================================
  // INDEXEDDB - GESTION DE BASE DE DATOS LOCAL
  // ============================================

  inicializarIndexedDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Store: Encuestas
        if (!db.objectStoreNames.contains('encuestas')) {
          const store = db.createObjectStore('encuestas', { keyPath: 'id' });
          store.createIndex('tipo', 'tipo', { unique: false });
          store.createIndex('estadoSync', 'estadoSync', { unique: false });
          store.createIndex('encuestador', 'encuestador', { unique: false });
          store.createIndex('fecha', 'fecha', { unique: false });
          store.createIndex('estadoCaso', 'estadoCaso', { unique: false });
        }

        // Store: Base de Vecinos
        if (!db.objectStoreNames.contains('vecinos')) {
          const store = db.createObjectStore('vecinos', { keyPath: 'Cedula' });
          store.createIndex('nombre', 'Nombre', { unique: false });
        }

        // Store: Encuestadores
        if (!db.objectStoreNames.contains('encuestadores')) {
          db.createObjectStore('encuestadores', { keyPath: 'id' });
        }

        // Store: Configuracion
        if (!db.objectStoreNames.contains('configuracion')) {
          db.createObjectStore('configuracion', { keyPath: 'clave' });
        }

        // Store: Session
        if (!db.objectStoreNames.contains('session')) {
          db.createObjectStore('session', { keyPath: 'id' });
        }

        // Store: Preguntas Adicionales
        if (!db.objectStoreNames.contains('preguntas')) {
          const store = db.createObjectStore('preguntas', { keyPath: 'id' });
          store.createIndex('cuestionario', 'cuestionario', { unique: false });
          store.createIndex('activa', 'activa', { unique: false });
        }

        // Store: Respuestas Adicionales
        if (!db.objectStoreNames.contains('respuestas_adicionales')) {
          const store = db.createObjectStore('respuestas_adicionales', { keyPath: 'id', autoIncrement: true });
          store.createIndex('idRegistro', 'idRegistro', { unique: false });
        }

        // Store: Metadatos
        if (!db.objectStoreNames.contains('metadatos')) {
          db.createObjectStore('metadatos', { keyPath: 'clave' });
        }
      };
    });
  }

  async dbOperation(storeName, mode, operation) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      const request = operation(store);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // ============================================
  // LOGIN Y SESION
  // ============================================

  async cargarSession() {
    try {
      const session = await this.dbOperation('session', 'readonly', store => store.get('current'));
      if (session && session.recordar) {
        this.session = session;
      }
    } catch (e) {
      console.log('[Session] No hay sesion guardada');
    }
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
    // Datos de ejemplo - en produccion se sincronizan desde Google Sheets
    return [
      { id: 1, nombre: 'Maria Garcia', password: '1234', activo: true },
      { id: 2, nombre: 'Jose Rodriguez', password: '5678', activo: true },
      { id: 3, nombre: 'Ana Martinez', password: '9012', activo: true }
    ];
  }

  actualizarSelectEncuestadores() {
    const select = document.getElementById('loginNombre');
    select.innerHTML = '<option value="">-- Seleccione su nombre --</option>';
    this.encuestadores.filter(e => e.activo).forEach(e => {
      const option = document.createElement('option');
      option.value = e.id;
      option.textContent = e.nombre;
      select.appendChild(option);
    });
  }

  async login() {
    const nombreId = document.getElementById('loginNombre').value;
    const pin = document.getElementById('loginPin').value;
    const recordar = document.getElementById('loginRecordar').checked;

    if (!nombreId || !pin) {
      this.mostrarToast('Ingrese nombre y PIN', 'error');
      return;
    }

    const encuestador = this.encuestadores.find(e => e.id == nombreId);
    if (!encuestador || encuestador.password !== pin) {
      this.mostrarToast('PIN incorrecto', 'error');
      return;
    }

    this.session = {
      id: 'current',
      encuestadorId: encuestador.id,
      nombre: encuestador.nombre,
      fechaLogin: new Date().toISOString(),
      recordar: recordar
    };

    await this.dbOperation('session', 'readwrite', store => store.put(this.session));
    this.mostrarToast(`Bienvenido, ${encuestador.nombre}`, 'success');
    this.mostrarMenu();
  }

  async cerrarSesion() {
    if (confirm('¿Esta seguro de cerrar sesion?')) {
      await this.dbOperation('session', 'readwrite', store => store.delete('current'));
      this.session = null;
      this.mostrarPantalla('screenLogin');
      this.mostrarToast('Sesion cerrada', 'info');
    }
  }

  // ============================================
  // NAVEGACION Y PANTALLAS
  // ============================================

  mostrarPantallaInicial() {
    if (this.session && this.session.recordar) {
      this.mostrarMenu();
    } else {
      this.mostrarPantalla('screenLogin');
    }
  }

  mostrarPantalla(pantallaId) {
    document.querySelectorAll('.screen, .login-screen').forEach(s => {
      s.classList.add('hidden');
      s.classList.remove('active');
    });
    const pantalla = document.getElementById(pantallaId);
    if (pantalla) {
      pantalla.classList.remove('hidden');
      pantalla.classList.add('active');
    }
  }

  mostrarMenu() {
    this.mostrarPantalla('screenMenu');
    document.getElementById('menuEncuestador').textContent = `Bienvenido, ${this.session.nombre}`;
    this.actualizarEstadisticasMenu();
  }

  volverMenu() {
    this.mostrarMenu();
    this.resetearFormularios();
  }

  // ============================================
  // CONFIGURACION GEOGRAFICA
  // ============================================

  async cargarConfiguracion() {
    try {
      const config = await this.dbOperation('configuracion', 'readonly', store => store.get('geografica'));
      if (config) {
        this.configGeo = config;
        this.llenarConfiguracion();
      }
    } catch (e) {
      console.log('[Config] No hay configuracion guardada');
    }
  }

  llenarConfiguracion() {
    if (!this.configGeo) return;
    document.getElementById('cfgEstado').value = this.configGeo.estado || '';
    document.getElementById('cfgMunicipio').value = this.configGeo.municipio || '';
    document.getElementById('cfgParroquia').value = this.configGeo.parroquia || '';
    document.getElementById('cfgCircuito').value = this.configGeo.circuito || '';
    document.getElementById('cfgConsejo').value = this.configGeo.consejo || '';
    document.getElementById('cfgCalle').value = this.configGeo.calle || '';
  }

  abrirConfiguracion() {
    this.llenarConfiguracion();
    this.mostrarPantalla('screenConfig');
  }

  async guardarConfiguracion() {
    const config = {
      clave: 'geografica',
      estado: document.getElementById('cfgEstado').value.trim(),
      municipio: document.getElementById('cfgMunicipio').value.trim(),
      parroquia: document.getElementById('cfgParroquia').value.trim(),
      circuito: document.getElementById('cfgCircuito').value.trim(),
      consejo: document.getElementById('cfgConsejo').value.trim(),
      calle: document.getElementById('cfgCalle').value.trim()
    };

    if (!config.estado || !config.municipio || !config.parroquia || !config.consejo || !config.calle) {
      this.mostrarToast('Complete todos los campos obligatorios', 'error');
      return;
    }

    this.configGeo = config;
    await this.dbOperation('configuracion', 'readwrite', store => store.put(config));
    this.mostrarToast('Configuracion guardada', 'success');
    this.volverMenu();
  }

  // ============================================
  // GPS - CAPTURA AUTOMATICA
  // ============================================

  async capturarGPS(pantalla) {
    const indicator = document.getElementById(`gps${pantalla}`);
    if (!indicator) return;

    indicator.className = 'gps-indicator obtaining';
    indicator.innerHTML = '<span class="status-indicator syncing"></span> Obteniendo GPS...';

    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        indicator.className = 'gps-indicator failed';
        indicator.innerHTML = '❌ GPS no disponible';
        this.currentGPS = { latitud: '', longitud: '', precision: '' };
        resolve(this.currentGPS);
        return;
      }

      const timeout = setTimeout(() => {
        indicator.className = 'gps-indicator failed';
        indicator.innerHTML = '⚠️ GPS no obtenido (timeout)';
        this.currentGPS = { latitud: '', longitud: '', precision: '' };
        resolve(this.currentGPS);
      }, CONFIG.GPS_TIMEOUT);

      navigator.geolocation.getCurrentPosition(
        (position) => {
          clearTimeout(timeout);
          this.currentGPS = {
            latitud: position.coords.latitude,
            longitud: position.coords.longitude,
            precision: position.coords.accuracy
          };
          indicator.className = 'gps-indicator obtained';
          indicator.innerHTML = `✅ GPS OK (${this.currentGPS.precision.toFixed(0)}m)`;
          resolve(this.currentGPS);
        },
        (error) => {
          clearTimeout(timeout);
          indicator.className = 'gps-indicator failed';
          indicator.innerHTML = '⚠️ GPS no disponible';
          this.currentGPS = { latitud: '', longitud: '', precision: '' };
          resolve(this.currentGPS);
        },
        { enableHighAccuracy: true, timeout: CONFIG.GPS_TIMEOUT, maximumAge: 0 }
      );
    });
  }

  // ============================================
  // AUTOCOMPLETADO POR CEDULA
  // ============================================

  async cargarBaseVecinos() {
    try {
      const vecinos = await this.dbOperation('vecinos', 'readonly', store => store.getAll());
      this.baseVecinos = vecinos;
      const fecha = await this.dbOperation('metadatos', 'readonly', store => store.get('vecinos_fecha'));
      this.actualizarIndicadorVecinos(vecinos.length, fecha ? fecha.valor : null);
    } catch (e) {
      console.log('[Vecinos] Error cargando:', e);
    }
  }

  actualizarIndicadorVecinos(cantidad, fecha) {
    const el = document.getElementById('loginDbStatus');
    const elMenu = document.getElementById('statVecinos');
    const elFecha = document.getElementById('lastVecinosUpdate');

    if (el) el.textContent = `Base vecinos: ${cantidad} registros`;
    if (elMenu) elMenu.textContent = cantidad;
    if (elFecha) {
      elFecha.textContent = fecha ? this.formatearFecha(fecha) : 'Sin datos';
    }
  }

  buscarVecino(tipo) {
    const inputId = tipo === 'am' ? 'amCedula' : tipo === 'nna' ? 'nnaCedula' : 'repCedula';
    const cedula = document.getElementById(inputId).value;
    const resultadoId = tipo === 'am' ? 'amBusquedaResultado' : tipo === 'nna' ? 'nnaBusquedaResultado' : 'repBusquedaResultado';
    const contenedor = document.getElementById(resultadoId);

    if (cedula.length < CONFIG.MIN_CEDULA_DIGITOS) {
      contenedor.innerHTML = '';
      return;
    }

    // Busqueda exacta primero, luego parcial
    let vecino = this.baseVecinos.find(v => v.Cedula === cedula);
    if (!vecino) {
      vecino = this.baseVecinos.find(v => v.Cedula && v.Cedula.includes(cedula));
    }

    if (vecino) {
      this.autocompletarCampos(tipo, vecino);
      contenedor.innerHTML = `
        <div class="alert alert-success">
          <span>✅</span>
          <span>Datos encontrados. <strong>Verifique la informacion</strong> y edite si esta desactualizada.</span>
        </div>
      `;
    } else {
      this.limpiarAutocompletado(tipo);
      contenedor.innerHTML = `
        <div class="alert alert-warning">
          <span>⚠️</span>
          <span>Cedula no registrada. <strong>Complete los datos manualmente</strong>.</span>
        </div>
      `;
    }
  }

  autocompletarCampos(tipo, vecino) {
    const campos = {
      am: ['amNombre', 'amApellido', 'amTelefono', 'amSector', 'amCalle', 'amNroCasa', 'amReferencia'],
      nna: ['nnaNombre', 'nnaApellido', 'nnaSector', 'nnaCalle', 'nnaNroCasa', 'nnaReferencia'],
      rep: ['repNombre', 'repApellido', 'repTelefono']
    };

    const mapeo = {
      amNombre: 'Nombre_y_Apellido', amApellido: 'Nombre_y_Apellido', amTelefono: 'Telefono',
      amSector: 'Sector', amCalle: 'Calle_Avenida', amNroCasa: 'Nro_Casa', amReferencia: 'Referencia',
      nnaNombre: 'Nombre_y_Apellido', nnaApellido: 'Nombre_y_Apellido', nnaSector: 'Sector',
      nnaCalle: 'Calle_Avenida', nnaNroCasa: 'Nro_Casa', nnaReferencia: 'Referencia',
      repNombre: 'Nombre_y_Apellido', repApellido: 'Nombre_y_Apellido', repTelefono: 'Telefono'
    };

    campos[tipo].forEach(campoId => {
      const el = document.getElementById(campoId);
      if (el && vecino[mapeo[campoId]]) {
        el.value = vecino[mapeo[campoId]];
        el.classList.add('autocomplete-field');
      }
    });
  }

  limpiarAutocompletado(tipo) {
    const campos = {
      am: ['amNombre', 'amApellido', 'amTelefono', 'amSector'],
      nna: ['nnaNombre', 'nnaApellido'],
      rep: ['repNombre', 'repApellido', 'repTelefono']
    };

    campos[tipo].forEach(campoId => {
      const el = document.getElementById(campoId);
      if (el) {
        el.value = '';
        el.classList.remove('autocomplete-field');
      }
    });
  }

  // ============================================
  // FORMULARIOS - ADULTOS MAYORES
  // ============================================

  abrirFormulario(tipo) {
    if (tipo === 'adultos') {
      this.mostrarPantalla('screenAdultos');
      this.resetearFormularioAdultos();
      this.capturarGPS('Adultos');
    } else if (tipo === 'nna') {
      this.mostrarPantalla('screenNNA');
      this.resetearFormularioNNA();
      this.capturarGPS('NNA');
    }
  }

  resetearFormularioAdultos() {
    this.currentEncuesta = { tipo: 'adultos', datos: {} };
    this.currentSeccion = null;

    // Resetear todos los campos
    ['amCedula', 'amNombre', 'amApellido', 'amTelefono', 'amSector', 'amCalle', 'amNroCasa', 'amReferencia',
     'amNecesidad', 'amBNecesidad'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.value = ''; el.classList.remove('autocomplete-field'); }
    });

    // Resetear selects
    ['amEstadoCaso', 'amBEstadoCaso'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.selectedIndex = 0;
    });

    // Resetear botones de opcion
    document.querySelectorAll('.option-btn').forEach(btn => btn.classList.remove('selected-yes', 'selected-no'));

    // Resetear radios
    document.querySelectorAll('.radio-item').forEach(item => item.classList.remove('selected'));
    document.querySelectorAll('input[type="radio"]').forEach(r => r.checked = false);

    // Resetear checkboxes
    document.querySelectorAll('.checkbox-item').forEach(item => item.classList.remove('checked'));
    document.querySelectorAll('input[type="checkbox"]').forEach(c => c.checked = false);

    // Ocultar campos "Otro"
    ['amB_SaludOtro'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });

    // Mostrar paso 1
    document.getElementById('pasoAdultos1').classList.remove('hidden');
    document.getElementById('pasoAdultos2').classList.add('hidden');
    document.getElementById('pasoAdultos3A').classList.add('hidden');
    document.getElementById('pasoAdultos3B').classList.add('hidden');

    // Resetear progreso
    document.getElementById('progressAdultos').style.width = '33%';
    document.getElementById('progressTextAdultos').textContent = 'Paso 1 de 3: Datos personales';
    document.getElementById('adultosPaso').textContent = 'Paso 1 de 3';
    document.getElementById('adultosSubtitle').textContent = 'Datos personales';

    document.getElementById('amBusquedaResultado').innerHTML = '';
  }

  adultosSiguiente(paso) {
    if (paso === 2) {
      // Validar datos personales
      if (!document.getElementById('amCedula').value.trim()) {
        this.mostrarToast('Ingrese la cedula', 'error');
        return;
      }
      if (!document.getElementById('amNombre').value.trim() || !document.getElementById('amApellido').value.trim()) {
        this.mostrarToast('Ingrese nombre y apellido', 'error');
        return;
      }

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

    if (seccion === 'A') {
      document.getElementById('pasoAdultos3A').classList.remove('hidden');
      document.getElementById('adultosSubtitle').textContent = 'Seccion A - Verificacion';
    } else {
      document.getElementById('pasoAdultos3B').classList.remove('hidden');
      document.getElementById('adultosSubtitle').textContent = 'Seccion B - Registro Nuevo';
    }

    document.getElementById('progressAdultos').style.width = '100%';
    document.getElementById('progressTextAdultos').textContent = `Paso 3 de 3: Seccion ${seccion}`;
    document.getElementById('adultosPaso').textContent = 'Paso 3 de 3';
  }

  // ============================================
  // FORMULARIOS - NNA
  // ============================================

  resetearFormularioNNA() {
    this.currentEncuesta = { tipo: 'nna', datos: {} };

    // Resetear campos de texto
    ['nnaCedula', 'nnaNombre', 'nnaApellido', 'nnaEdad', 'nnaGrado',
     'repCedula', 'repNombre', 'repApellido', 'repTelefono', 'repParentesco',
     'nnaFechaInscripcion', 'nnaNotas'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.value = ''; el.classList.remove('autocomplete-field'); }
    });

    // Resetear selects
    document.getElementById('nnaEstadoCaso').selectedIndex = 0;

    // Resetear botones
    document.querySelectorAll('#screenNNA .option-btn').forEach(btn => btn.classList.remove('selected-yes', 'selected-no'));

    // Resetear checkboxes
    document.querySelectorAll('#screenNNA .checkbox-item').forEach(item => item.classList.remove('checked'));
    document.querySelectorAll('#screenNNA input[type="checkbox"]').forEach(c => c.checked = false);

    // Ocultar campos "Otro"
    ['nnaDocOtro', 'nnaAccOtro', 'nnaLabOtro', 'nnaTutOtro', 'nnaEcoOtro'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });

    // Mostrar paso 1
    ['pasoNNA1', 'pasoNNA2', 'pasoNNA3', 'pasoNNA4'].forEach((id, i) => {
      document.getElementById(id).classList.toggle('hidden', i !== 0);
    });

    // Resetear progreso
    document.getElementById('progressNNA').style.width = '25%';
    document.getElementById('progressTextNNA').textContent = 'Paso 1 de 4: Datos del NNA';
    document.getElementById('nnaPaso').textContent = 'Paso 1 de 4';
    document.getElementById('nnaSubtitle').textContent = 'Datos del NNA';

    document.getElementById('nnaBusquedaResultado').innerHTML = '';
    document.getElementById('repBusquedaResultado').innerHTML = '';
  }

  nnaSiguiente(paso) {
    if (paso === 2) {
      if (!document.getElementById('nnaNombre').value.trim() || !document.getElementById('nnaApellido').value.trim()) {
        this.mostrarToast('Ingrese nombre y apellido del NNA', 'error');
        return;
      }
      if (!document.getElementById('nnaEdad').value) {
        this.mostrarToast('Ingrese la edad del NNA', 'error');
        return;
      }
      if (!document.getElementById('nnaGrado').value) {
        this.mostrarToast('Seleccione el ultimo grado cursado', 'error');
        return;
      }

      document.getElementById('pasoNNA1').classList.add('hidden');
      document.getElementById('pasoNNA2').classList.remove('hidden');
      document.getElementById('progressNNA').style.width = '50%';
      document.getElementById('progressTextNNA').textContent = 'Paso 2 de 4: Datos del representante';
      document.getElementById('nnaPaso').textContent = 'Paso 2 de 4';
      document.getElementById('nnaSubtitle').textContent = 'Datos del representante';
    } else if (paso === 3) {
      if (!document.getElementById('repNombre').value.trim() || !document.getElementById('repApellido').value.trim()) {
        this.mostrarToast('Ingrese nombre y apellido del representante', 'error');
        return;
      }
      if (!document.getElementById('repParentesco').value) {
        this.mostrarToast('Seleccione el parentesco', 'error');
        return;
      }

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

  // ============================================
  // INTERACCION DE FORMULARIOS (UI)
  // ============================================

  selectOption(btn) {
    const name = btn.dataset.name;
    const value = btn.dataset.value;

    // Remover seleccion previa del mismo grupo
    document.querySelectorAll(`[data-name="${name}"]`).forEach(b => {
      b.classList.remove('selected-yes', 'selected-no');
    });

    // Aplicar nueva seleccion
    btn.classList.add(value === 'SI' ? 'selected-yes' : 'selected-no');
  }

  selectRadio(item, name) {
    // Remover seleccion previa
    document.querySelectorAll(`input[name="${name}"]`).forEach(r => {
      r.checked = false;
      r.closest('.radio-item')?.classList.remove('selected');
    });

    // Seleccionar nuevo
    const radio = item.querySelector('input[type="radio"]');
    radio.checked = true;
    item.classList.add('selected');
  }

  toggleCheckbox(item) {
    const checkbox = item.querySelector('input[type="checkbox"]');
    checkbox.checked = !checkbox.checked;
    item.classList.toggle('checked', checkbox.checked);
  }

  toggleOtro(campoId) {
    const checkbox = event.target;
    const campo = document.getElementById(campoId);
    if (campo) {
      campo.classList.toggle('hidden', !checkbox.checked);
    }
  }

  // ============================================
  // GUARDADO DE ENCUESTAS
  // ============================================

  async guardarEncuesta(tipo, seccion = null) {
    const id = this.generarId();
    const fechaHora = new Date().toISOString();
    const datos = this.recolectarDatos(tipo, seccion);

    if (!datos) return; // Validacion fallo

    const encuesta = {
      id: id,
      tipo: tipo,
      seccion: seccion,
      encuestador: this.session.nombre,
      encuestadorId: this.session.encuestadorId,
      fecha: fechaHora,
      fechaSincronizacion: null,
      estadoSync: 'pendiente',
      versionApp: CONFIG.VERSION,
      datos: datos
    };

    await this.dbOperation('encuestas', 'readwrite', store => store.put(encuesta));
    this.mostrarToast('Encuesta guardada correctamente', 'success');
    this.volverMenu();
  }

  async guardarBorrador(tipo) {
    const id = this.currentEncuesta && this.currentEncuesta.id ? this.currentEncuesta.id : this.generarId();
    const datos = this.recolectarDatos(tipo, this.currentSeccion, true);

    const borrador = {
      id: id,
      tipo: tipo,
      seccion: this.currentSeccion,
      encuestador: this.session.nombre,
      encuestadorId: this.session.encuestadorId,
      fecha: new Date().toISOString(),
      estadoSync: 'borrador',
      versionApp: CONFIG.VERSION,
      datos: datos
    };

    this.currentEncuesta = borrador;
    await this.dbOperation('encuestas', 'readwrite', store => store.put(borrador));
    this.mostrarToast('Borrador guardado', 'info');
  }

  recolectarDatos(tipo, seccion, esBorrador = false) {
    const datos = {
      gps: this.currentGPS || { latitud: '', longitud: '', precision: '' },
      geograficos: this.configGeo || {}
    };

    if (tipo === 'adultos') {
      // Datos personales
      datos.cedula = document.getElementById('amCedula').value.trim();
      datos.nombre = (document.getElementById('amNombre').value.trim() + ' ' + document.getElementById('amApellido').value.trim()).trim();  // Nombre_y_Apellido completo
      datos.apellido = '';  // Ahora vacio, incluido en nombre
      datos.telefono = document.getElementById('amTelefono').value.trim();
      datos.sector = document.getElementById('amSector').value.trim();
      datos.calle = document.getElementById('amCalle').value.trim();
      datos.nroCasa = document.getElementById('amNroCasa').value.trim();
      datos.referencia = document.getElementById('amReferencia').value.trim();
      datos.autocompletado = document.getElementById('amNombre').classList.contains('autocomplete-field') ? 'SI' : 'NO';

      if (!esBorrador) {
        if (!datos.cedula || !datos.nombre || !datos.apellido) {
          this.mostrarToast('Complete los datos personales obligatorios', 'error');
          return null;
        }
      }

      if (seccion === 'A') {
        datos.viveSolo = this.getOptionValue('amViveSolo');
        datos.sosten = this.getOptionValue('amSosten');
        datos.ingresos = this.getOptionValue('amIngresos');
        datos.saludDependencia = this.getOptionValue('amSaludDependencia');
        datos.necesidad = document.getElementById('amNecesidad').value.trim();
        datos.estadoCaso = document.getElementById('amEstadoCaso').value;
        datos.necesidadResuelta = 'NO';
        datos.fechaResolucion = '';
        datos.notasSeguimiento = '';
      } else if (seccion === 'B') {
        datos.sosten = this.getOptionValue('amB_Sosten');
        datos.situacionVivienda = this.getRadioValue('amB_Vivienda');
        datos.cantMiembros = this.getRadioValue('amB_Miembros');
        datos.miembrosIngreso = this.getRadioValue('amB_IngresosMiembro');
        datos.saludEncamado = document.getElementById('amB_Encamado').checked ? 'SI' : 'NO';
        datos.saludParkinson = document.getElementById('amB_Parkinson').checked ? 'SI' : 'NO';
        datos.saludAlzheimer = document.getElementById('amB_Alzheimer').checked ? 'SI' : 'NO';
        datos.saludTrastorno = document.getElementById('amB_Trastorno').checked ? 'SI' : 'NO';
        datos.saludInsufRenal = document.getElementById('amB_InsufRenal').checked ? 'SI' : 'NO';
        datos.saludCancer = document.getElementById('amB_Cancer').checked ? 'SI' : 'NO';
        datos.saludInsufCardiaca = document.getElementById('amB_InsufCardiaca').checked ? 'SI' : 'NO';
        datos.saludArtritis = document.getElementById('amB_Artritis').checked ? 'SI' : 'NO';
        datos.saludEsclerosis = document.getElementById('amB_Esclerosis').checked ? 'SI' : 'NO';
        datos.saludOtro = document.getElementById('amB_SaludOtroCheck').checked ? 
          (document.querySelector('#amB_SaludOtro input')?.value || 'SI') : 'NO';
        datos.situacionEconomica = this.getRadioValue('amB_Economica');
        datos.necesidad = document.getElementById('amBNecesidad').value.trim();
        datos.estadoCaso = document.getElementById('amBEstadoCaso').value;
        datos.necesidadResuelta = 'NO';
        datos.fechaResolucion = '';
        datos.notasSeguimiento = '';
      }
    } else if (tipo === 'nna') {
      datos.nnaCedula = document.getElementById('nnaCedula').value.trim();
      datos.nnaNombre = (document.getElementById('nnaNombre').value.trim() + ' ' + document.getElementById('nnaApellido').value.trim()).trim();  // Nombre_y_Apellido NNA completo
      datos.nnaApellido = '';  // Ahora vacio, incluido en nombre
      datos.nnaEdad = document.getElementById('nnaEdad').value;
      datos.nnaGrado = document.getElementById('nnaGrado').value;
      datos.nnaAutocompletado = document.getElementById('nnaNombre').classList.contains('autocomplete-field') ? 'SI' : 'NO';

      datos.repCedula = document.getElementById('repCedula').value.trim();
      datos.repNombre = (document.getElementById('repNombre').value.trim() + ' ' + document.getElementById('repApellido').value.trim()).trim();  // Nombre_y_Apellido representante completo
      datos.repApellido = '';  // Ahora vacio, incluido en nombre
      datos.repTelefono = document.getElementById('repTelefono').value.trim();
      datos.repParentesco = document.getElementById('repParentesco').value;
      datos.repAutocompletado = document.getElementById('repNombre').classList.contains('autocomplete-field') ? 'SI' : 'NO';

      if (!esBorrador) {
        if (!datos.nnaNombre || !datos.nnaApellido || !datos.nnaEdad || !datos.nnaGrado) {
          this.mostrarToast('Complete los datos del NNA', 'error');
          return null;
        }
        if (!datos.repNombre || !datos.repApellido || !datos.repParentesco) {
          this.mostrarToast('Complete los datos del representante', 'error');
          return null;
        }
      }

      // Documentos
      datos.docFaltaCedula = document.getElementById('nnaDocCedula').checked ? 'SI' : 'NO';
      datos.docFaltaPartida = document.getElementById('nnaDocPartida').checked ? 'SI' : 'NO';
      datos.docFaltaConstancia = document.getElementById('nnaDocConstancia').checked ? 'SI' : 'NO';
      datos.docOtro = document.getElementById('nnaDocOtroCheck').checked ? 
        (document.querySelector('#nnaDocOtro input')?.value || 'SI') : 'NO';

      // Acceso
      datos.accesoLejania = document.getElementById('nnaAccLejania').checked ? 'SI' : 'NO';
      datos.accesoTransporte = document.getElementById('nnaAccTransporte').checked ? 'SI' : 'NO';
      datos.accesoRiesgos = document.getElementById('nnaAccRiesgos').checked ? 'SI' : 'NO';
      datos.accesoOtro = document.getElementById('nnaAccOtroCheck').checked ? 
        (document.querySelector('#nnaAccOtro input')?.value || 'SI') : 'NO';

      // Laboral
      datos.laboralAportar = document.getElementById('nnaLabAportar').checked ? 'SI' : 'NO';
      datos.laboralInformal = document.getElementById('nnaLabInformal').checked ? 'SI' : 'NO';
      datos.laboralRep = document.getElementById('nnaLabRep').checked ? 'SI' : 'NO';
      datos.laboralHermanos = document.getElementById('nnaLabHermanos').checked ? 'SI' : 'NO';
      datos.laboralOtro = document.getElementById('nnaLabOtroCheck').checked ? 
        (document.querySelector('#nnaLabOtro input')?.value || 'SI') : 'NO';

      // Tutelaje
      datos.tutelajeAusencia = document.getElementById('nnaTutAusencia').checked ? 'SI' : 'NO';
      datos.tutelajeDesconocimiento = document.getElementById('nnaTutDesconocimiento').checked ? 'SI' : 'NO';
      datos.tutelajeAcompanamiento = document.getElementById('nnaTutAcompanamiento').checked ? 'SI' : 'NO';
      datos.tutelajeOtro = document.getElementById('nnaTutOtroCheck').checked ? 
        (document.querySelector('#nnaTutOtro input')?.value || 'SI') : 'NO';

      // Economico
      datos.economicoUtiles = document.getElementById('nnaEcoUtiles').checked ? 'SI' : 'NO';
      datos.economicoAlimentacion = document.getElementById('nnaEcoAlimentacion').checked ? 'SI' : 'NO';
      datos.economicoDeudas = document.getElementById('nnaEcoDeudas').checked ? 'SI' : 'NO';
      datos.economicoInestabilidad = document.getElementById('nnaEcoInestabilidad').checked ? 'SI' : 'NO';
      datos.economicoApoyo = document.getElementById('nnaEcoApoyo').checked ? 'SI' : 'NO';
      datos.economicoOtro = document.getElementById('nnaEcoOtroCheck').checked ? 
        (document.querySelector('#nnaEcoOtro input')?.value || 'SI') : 'NO';

      // Seguimiento
      datos.inscritoEscuela = this.getOptionValue('nnaInscrito');
      datos.fechaInscripcion = document.getElementById('nnaFechaInscripcion').value;
      datos.notasSeguimiento = document.getElementById('nnaNotas').value.trim();
      datos.estadoCaso = document.getElementById('nnaEstadoCaso').value;
    }

    return datos;
  }

  getOptionValue(name) {
    const selected = document.querySelector(`[data-name="${name}"].selected-yes, [data-name="${name}"].selected-no`);
    return selected ? selected.dataset.value : '';
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
  // SINCRONIZACION
  // ============================================

  detectarConexion() {
    const updateStatus = () => {
      const online = navigator.onLine;
      const indicator = document.getElementById('statusOnline');
      const text = document.getElementById('statusText');

      if (indicator) {
        indicator.className = online ? 'status-indicator online' : 'status-indicator offline';
      }
      if (text) {
        text.textContent = online ? 'Conectado' : 'Sin conexion';
      }

      if (online) {
        this.sincronizarAutomatica();
      }
    };

    window.addEventListener('online', updateStatus);
    window.addEventListener('offline', updateStatus);
    updateStatus();
  }

  async sincronizarAutomatica() {
    if (!CONFIG.SCRIPT_URL) {
      console.log('[Sync] URL del script no configurada');
      return;
    }

    try {
      this.mostrarLoading('Sincronizando datos...');

      // 1. Descargar Base de Vecinos actualizada
      await this.descargarBaseVecinos();

      // 2. Enviar encuestas pendientes
      await this.enviarEncuestasPendientes();

      // 3. Descargar preguntas adicionales
      await this.descargarPreguntasAdicionales();

      // 4. Actualizar encuestadores
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
    if (!navigator.onLine) {
      this.mostrarToast('No hay conexion a internet', 'warning');
      return;
    }
    await this.sincronizarAutomatica();
  }

  async descargarBaseVecinos() {
    try {
      const response = await fetch(`${CONFIG.SCRIPT_URL}?action=getVecinos&token=${CONFIG.TOKEN_SEGURIDAD}`);
      if (!response.ok) throw new Error('Error al descargar vecinos');

      const data = await response.json();
      if (data.success && data.vecinos) {
        // Limpiar y reinsertar
        await this.dbOperation('vecinos', 'readwrite', store => store.clear());
        for (const vecino of data.vecinos) {
          await this.dbOperation('vecinos', 'readwrite', store => store.put(vecino));
        }
        this.baseVecinos = data.vecinos;
        await this.guardarMetadato('vecinos_fecha', new Date().toISOString());
        this.actualizarIndicadorVecinos(data.vecinos.length, new Date().toISOString());
        console.log(`[Sync] ${data.vecinos.length} vecinos descargados`);
      }
    } catch (e) {
      console.error('[Sync] Error descargando vecinos:', e);
    }
  }

  async enviarEncuestasPendientes() {
    try {
      const pendientes = await this.dbOperation('encuestas', 'readonly', 
        store => store.index('estadoSync').getAll('pendiente'));

      if (pendientes.length === 0) {
        console.log('[Sync] No hay encuestas pendientes');
        return;
      }

      console.log(`[Sync] Enviando ${pendientes.length} encuestas...`);

      for (const encuesta of pendientes) {
        try {
          const response = await fetch(CONFIG.SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              token: CONFIG.TOKEN_SEGURIDAD,
              action: 'guardarEncuesta',
              encuesta: encuesta
            })
          });

          const result = await response.json();
          if (result.success) {
            encuesta.estadoSync = 'sincronizado';
            encuesta.fechaSincronizacion = new Date().toISOString();
            await this.dbOperation('encuestas', 'readwrite', store => store.put(encuesta));
          } else {
            console.error('[Sync] Error del servidor:', result.error);
          }
        } catch (e) {
          console.error('[Sync] Error enviando encuesta:', e);
        }
      }
    } catch (e) {
      console.error('[Sync] Error en envio:', e);
    }
  }

  async descargarPreguntasAdicionales() {
    try {
      const response = await fetch(`${CONFIG.SCRIPT_URL}?action=getPreguntas&token=${CONFIG.TOKEN_SEGURIDAD}`);
      if (!response.ok) return;

      const data = await response.json();
      if (data.success && data.preguntas) {
        await this.dbOperation('preguntas', 'readwrite', store => store.clear());
        for (const pregunta of data.preguntas) {
          await this.dbOperation('preguntas', 'readwrite', store => store.put(pregunta));
        }
        this.preguntasAdicionales = data.preguntas;
      }
    } catch (e) {
      console.error('[Sync] Error descargando preguntas:', e);
    }
  }

  async descargarEncuestadores() {
    try {
      const response = await fetch(`${CONFIG.SCRIPT_URL}?action=getEncuestadores&token=${CONFIG.TOKEN_SEGURIDAD}`);
      if (!response.ok) return;

      const data = await response.json();
      if (data.success && data.encuestadores) {
        await this.dbOperation('encuestadores', 'readwrite', store => store.clear());
        for (const enc of data.encuestadores) {
          await this.dbOperation('encuestadores', 'readwrite', store => store.put(enc));
        }
        this.encuestadores = data.encuestadores;
        this.actualizarSelectEncuestadores();
      }
    } catch (e) {
      console.error('[Sync] Error descargando encuestadores:', e);
    }
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

      // Filtrar por encuestador actual
      casos = casos.filter(c => c.encuestadorId === this.session.encuestadorId);

      // Aplicar filtros adicionales
      if (filtro === 'adultos') casos = casos.filter(c => c.tipo === 'adultos');
      else if (filtro === 'nna') casos = casos.filter(c => c.tipo === 'nna');
      else if (filtro === 'pendiente') casos = casos.filter(c => c.datos.estadoCaso === 'pendiente');
      else if (filtro === 'proceso') casos = casos.filter(c => c.datos.estadoCaso === 'proceso');
      else if (filtro === 'resuelto') casos = casos.filter(c => c.datos.estadoCaso === 'resuelto');

      const contenedor = document.getElementById('casosLista');

      if (casos.length === 0) {
        contenedor.innerHTML = '<div class="alert alert-info"><span>📋</span><span>No hay casos registrados</span></div>';
        return;
      }

      contenedor.innerHTML = casos.map(caso => this.renderizarCaso(caso)).join('');
    } catch (e) {
      console.error('[Casos] Error cargando:', e);
    }
  }

  renderizarCaso(caso) {
    const estado = caso.datos.estadoCaso || 'pendiente';
    const nombre = caso.tipo === 'adultos' 
      ? `${caso.datos.nombre} ${caso.datos.apellido}`
      : `${caso.datos.nnaNombre} ${caso.datos.nnaApellido}`;
    const tipo = caso.tipo === 'adultos' ? '👴 Adulto Mayor' : '👦 NNA';
    const seccion = caso.seccion ? ` - Sec. ${caso.seccion}` : '';
    const fecha = this.formatearFecha(caso.fecha);
    const sync = caso.estadoSync === 'sincronizado' ? '✅' : '🔴';

    return `
      <div class="caso-item ${estado}" onclick="app.editarCaso('${caso.id}')">
        <div class="caso-header">
          <div class="caso-nombre">${nombre}</div>
          <div class="caso-estado ${estado}">${estado.toUpperCase()}</div>
        </div>
        <div class="caso-info">
          ${tipo}${seccion} | ${sync} ${fecha} | ${caso.encuestador}
        </div>
      </div>
    `;
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

      const nombre = caso.tipo === 'adultos'
        ? `${caso.datos.nombre} ${caso.datos.apellido}`
        : `${caso.datos.nnaNombre} ${caso.datos.nnaApellido}`;

      titulo.textContent = `Editar: ${nombre}`;

      if (caso.tipo === 'adultos') {
        contenido.innerHTML = `
          <div class="form-group">
            <label class="form-label">Necesidad detectada</label>
            <textarea class="form-textarea" id="editNecesidad">${caso.datos.necesidad || ''}</textarea>
          </div>
          <div class="form-group">
            <label class="form-label">Fue resuelta la necesidad?</label>
            <div class="option-group">
              <button type="button" class="option-btn ${caso.datos.necesidadResuelta === 'SI' ? 'selected-yes' : ''}" data-name="editResuelta" data-value="SI" onclick="app.selectOption(this)">SI</button>
              <button type="button" class="option-btn ${caso.datos.necesidadResuelta === 'NO' ? 'selected-no' : ''}" data-name="editResuelta" data-value="NO" onclick="app.selectOption(this)">NO</button>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Fecha de resolucion</label>
            <input type="date" class="form-input" id="editFechaResolucion" value="${caso.datos.fechaResolucion || ''}">
          </div>
          <div class="form-group">
            <label class="form-label">Notas de seguimiento</label>
            <textarea class="form-textarea" id="editNotas">${caso.datos.notasSeguimiento || ''}</textarea>
          </div>
          <div class="form-group">
            <label class="form-label">Estado del caso</label>
            <select class="form-select" id="editEstadoCaso">
              <option value="pendiente" ${caso.datos.estadoCaso === 'pendiente' ? 'selected' : ''}>🔴 Pendiente</option>
              <option value="proceso" ${caso.datos.estadoCaso === 'proceso' ? 'selected' : ''}>🟡 En proceso</option>
              <option value="resuelto" ${caso.datos.estadoCaso === 'resuelto' ? 'selected' : ''}>🟢 Resuelto</option>
            </select>
          </div>
        `;
      } else {
        contenido.innerHTML = `
          <div class="form-group">
            <label class="form-label">Fue inscrito en la escuela?</label>
            <div class="option-group">
              <button type="button" class="option-btn ${caso.datos.inscritoEscuela === 'SI' ? 'selected-yes' : ''}" data-name="editInscrito" data-value="SI" onclick="app.selectOption(this)">SI</button>
              <button type="button" class="option-btn ${caso.datos.inscritoEscuela === 'NO' ? 'selected-no' : ''}" data-name="editInscrito" data-value="NO" onclick="app.selectOption(this)">NO</button>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Fecha de inscripcion</label>
            <input type="date" class="form-input" id="editFechaInscripcion" value="${caso.datos.fechaInscripcion || ''}">
          </div>
          <div class="form-group">
            <label class="form-label">Notas de seguimiento</label>
            <textarea class="form-textarea" id="editNotas">${caso.datos.notasSeguimiento || ''}</textarea>
          </div>
          <div class="form-group">
            <label class="form-label">Estado del caso</label>
            <select class="form-select" id="editEstadoCaso">
              <option value="pendiente" ${caso.datos.estadoCaso === 'pendiente' ? 'selected' : ''}>🔴 Pendiente</option>
              <option value="proceso" ${caso.datos.estadoCaso === 'proceso' ? 'selected' : ''}>🟡 En proceso</option>
              <option value="resuelto" ${caso.datos.estadoCaso === 'resuelto' ? 'selected' : ''}>🟢 Resuelto</option>
            </select>
          </div>
        `;
      }

      modal.classList.add('active');
    } catch (e) {
      console.error('[Casos] Error editando:', e);
    }
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
      if (ultimaSync) {
        document.getElementById('lastSync').textContent = this.formatearFecha(ultimaSync.valor);
      }
    } catch (e) {
      console.error('[Stats] Error:', e);
    }
  }

  formatearFecha(fechaISO) {
    if (!fechaISO) return 'Nunca';
    try {
      const fecha = new Date(fechaISO);
      return fecha.toLocaleString('es-VE', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
    } catch (e) {
      return fechaISO;
    }
  }

  mostrarToast(mensaje, tipo = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${tipo}`;
    toast.textContent = mensaje;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
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

  // ============================================
  // AUTO-GUARDADO DE BORRADORES
  // ============================================

  iniciarAutoGuardado() {
    setInterval(() => {
      if (this.currentEncuesta && (this.currentEncuesta.estadoSync === 'borrador' || !this.currentEncuesta.estadoSync)) {
        const tipo = this.currentEncuesta.tipo;
        const seccion = this.currentSeccion;
        this.guardarBorrador(tipo, seccion);
      }
    }, CONFIG.BORRADOR_INTERVAL);
  }

  // ============================================
  // CONFIGURACION DE EVENTOS
  // ============================================

  configurarEventos() {
    // Registrar Service Worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('service-worker.js')
        .then(reg => console.log('[SW] Registrado:', reg.scope))
        .catch(err => console.error('[SW] Error:', err));
    }

    // Prevenir zoom en inputs numericos en iOS
    document.addEventListener('focusin', (e) => {
      if (e.target.tagName === 'INPUT' && e.target.type === 'number') {
        e.target.style.fontSize = '16px';
      }
    });

    // Manejar tecla Enter en login
    document.getElementById('loginPin')?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.login();
    });

    // Cerrar modal al hacer click fuera
    document.getElementById('modalEditarCaso')?.addEventListener('click', (e) => {
      if (e.target.id === 'modalEditarCaso') this.cerrarModal();
    });
  }

  // ============================================
  // VALIDACION DE CEDULA (Algoritmo Modulo 10)
  // ============================================

  validarCedulaVenezuela(cedula) {
    if (!cedula || cedula.length < 6 || cedula.length > 9) return false;
    if (!/^\d+$/.test(cedula)) return false;

    // Para cedulas venezolanas, validacion basica de formato
    // Las cedulas venezolanas son numericas, tipicamente 7-8 digitos
    // V (Venezolano) o E (Extranjero) + 6-8 digitos
    // En este sistema trabajamos solo con el numero
    return true;
  }

  // ============================================
  // EXPORTACION DE RESPALDO (CSV)
  // ============================================

  async exportarRespaldoCSV() {
    try {
      const encuestas = await this.dbOperation('encuestas', 'readonly', store => store.getAll());
      if (encuestas.length === 0) {
        this.mostrarToast('No hay datos para exportar', 'warning');
        return;
      }

      let csv = 'ID,Tipo,Seccion,Encuestador,Fecha,EstadoSync,Cedula,Nombre,Apellido\n';
      encuestas.forEach(e => {
        const nombre = e.tipo === 'adultos' 
          ? `${e.datos.nombre || ''} ${e.datos.apellido || ''}`
          : `${e.datos.nnaNombre || ''} ${e.datos.nnaApellido || ''}`;
        const cedula = e.tipo === 'adultos' ? (e.datos.cedula || '') : (e.datos.nnaCedula || '');
        csv += `${e.id},${e.tipo},${e.seccion || ''},${e.encuestador},${e.fecha},${e.estadoSync},${cedula},"${nombre}"\n`;
      });

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `respaldo_diagnostico_${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();

      this.mostrarToast('Respaldo descargado', 'success');
    } catch (e) {
      console.error('[Respaldo] Error:', e);
      this.mostrarToast('Error al exportar', 'error');
    }
  }
}

// ============================================
// INICIALIZACION GLOBAL
// ============================================

const app = new DiagSocialApp();

// Esperar a que DOM este listo
document.addEventListener('DOMContentLoaded', () => {
  app.init();
});

// Exponer app globalmente para debugging
window.app = app;
