// ============================================
// DIAGNOSTICO SOCIAL COMUNITARIO - APP.JS
// Version: 1.0.5
// ============================================

const CONFIG = {
  VERSION: '1.0.5',
  DB_NAME: 'DiagSocialDB',
  DB_VERSION: 5,
  SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbzLs9lJnuRauQIdiFitSrkQ_EFMHR8KcPkSzAabSVviANkvuffCG91cmRgFuNo3wmLE/exec',
  TOKEN_SEGURIDAD: 'diag-social-2024',
  GPS_TIMEOUT: 30000,
  BORRADOR_INTERVAL: 30000,
  MIN_CEDULA_DIGITOS: 6,
  MAX_VECINOS: 1000
};

class DiagSocialApp {
  constructor() {
    this.db = null;
    this.session = null;
    this.configGeo = null;
    this.encuestadores = [];
    this.baseVecinos = [];
    this.currentGPS = null;
    this.borradorTimer = null;
    this.currentEncuesta = null;
    this.currentSeccion = null;
    this.casoEditando = null;
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

      if (navigator.onLine && CONFIG.SCRIPT_URL) {
        setTimeout(() => this.sincronizarEncuestadores(), 2000);
      }
    } catch (error) {
      console.error('[App] Error en inicializacion:', error);
      this.mostrarToast('Error al iniciar la aplicacion', 'error');
    }
  }

  inicializarIndexedDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { this.db = request.result; resolve(); };
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
        if (!db.objectStoreNames.contains('metadatos')) db.createObjectStore('metadatos', { keyPath: 'clave' });
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
      if (session && session.recordar) this.session = session;
    } catch (e) { console.log('[Session] No hay sesion guardada'); }
  }

  async cargarEncuestadores() {
    try {
      const data = await this.dbOperation('encuestadores', 'readonly', store => store.getAll());
      this.encuestadores = data.length > 0 ? data : [];
      this.actualizarSelectEncuestadores();
    } catch (e) {
      this.encuestadores = [];
      this.actualizarSelectEncuestadores();
    }
  }

  getEncuestadoresDefault() {
    return [];
  }

  agregarEncuestadorManual() {
    const nombre = prompt('Nombre completo del encuestador:');
    if (!nombre) return;
    const pin = prompt('PIN de 4 digitos:');
    if (!pin || pin.length !== 4) {
      this.mostrarToast('PIN debe tener 4 digitos', 'error');
      return;
    }
    const id = Date.now();
    const encuestador = { id, nombre, password: pin, activo: true };
    this.encuestadores.push(encuestador);
    this.dbOperation('encuestadores', 'readwrite', store => store.put(encuestador));
    this.actualizarSelectEncuestadores();
    this.mostrarToast('Encuestador agregado', 'success');
  }

  actualizarSelectEncuestadores() {
    const select = document.getElementById('loginNombre');
    select.innerHTML = '<option value="">-- Seleccione su nombre --</option>';

    if (this.encuestadores.length === 0) {
      select.innerHTML += '<option value="__empty__" disabled>⚠️ Sincronice para cargar encuestadores</option>';
    } else {
      this.encuestadores.filter(e => e.activo).forEach(e => {
        const option = document.createElement('option');
        option.value = e.id;
        option.textContent = e.nombre;
        select.appendChild(option);
      });
    }

    const manualOption = document.createElement('option');
    manualOption.value = '__manual__';
    manualOption.textContent = '➕ Agregar encuestador manual...';
    select.appendChild(manualOption);

    select.onchange = (e) => {
      if (e.target.value === '__manual__') {
        this.agregarEncuestadorManual();
        e.target.value = '';
      }
    };
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
  // NAVEGACION
  // ============================================

  mostrarPantallaInicial() {
    if (this.session && this.session.recordar) this.mostrarMenu();
    else this.mostrarPantalla('screenLogin');
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
  // CONFIGURACION
  // ============================================

  async cargarConfiguracion() {
    try {
      const config = await this.dbOperation('configuracion', 'readonly', store => store.get('geografica'));
      if (config) {
        this.configGeo = config;
        this.llenarConfiguracion();
      }
    } catch (e) { console.log('[Config] No hay configuracion guardada'); }
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
  // GPS
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
  // CALCULAR EDAD AUTOMATICA
  // ============================================

  calcularEdad(tipo) {
    const fechaInputId = tipo === 'am' ? 'amFechaNacimiento' : 'nnaFechaNacimiento';
    const edadInputId = tipo === 'am' ? 'amEdad' : 'nnaEdad';

    const fechaNacimiento = document.getElementById(fechaInputId).value;
    const edadInput = document.getElementById(edadInputId);

    if (!fechaNacimiento) {
      edadInput.value = '';
      return;
    }

    const hoy = new Date();
    const nacimiento = new Date(fechaNacimiento);

    let edad = hoy.getFullYear() - nacimiento.getFullYear();
    const mes = hoy.getMonth() - nacimiento.getMonth();

    if (mes < 0 || (mes === 0 && hoy.getDate() < nacimiento.getDate())) {
      edad--;
    }

    if (edad < 0 || edad > 120) {
      edadInput.value = '';
      this.mostrarToast('Verifique la fecha de nacimiento', 'warning');
      return;
    }

    edadInput.value = edad;

    if (tipo === 'nna' && edad >= 18) {
      this.mostrarToast('El NNA debe ser menor de 18 anos', 'warning');
    }
    if (tipo === 'am' && edad < 60) {
      this.mostrarToast('El adulto mayor debe tener 60+ anos', 'warning');
    }
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
    const inputId = tipo === 'am' ? 'amCedula' : 'nnaCedulaRep';
    const cedula = document.getElementById(inputId).value;
    const resultadoId = tipo === 'am' ? 'amBusquedaResultado' : 'nnaBusquedaResultado';
    const contenedor = document.getElementById(resultadoId);

    if (cedula.length < CONFIG.MIN_CEDULA_DIGITOS) {
      contenedor.innerHTML = '';
      return;
    }

    let vecino = this.baseVecinos.find(v => v.Cedula === cedula);
    if (!vecino) vecino = this.baseVecinos.find(v => v.Cedula && v.Cedula.includes(cedula));

    if (vecino) {
      this.autocompletarCampos(tipo, vecino);
      contenedor.innerHTML = '<div class="alert alert-success"><span>✅</span><span>Datos encontrados. <strong>Verifique la informacion</strong> y edite si esta desactualizada.</span></div>';
    } else {
      this.limpiarAutocompletado(tipo);
      contenedor.innerHTML = '<div class="alert alert-warning"><span>⚠️</span><span>Cedula no registrada. <strong>Complete los datos manualmente</strong>.</span></div>';
    }
  }

  autocompletarCampos(tipo, vecino) {
    if (tipo === 'am') {
      const nombreEl = document.getElementById('amNombre');
      const apellidoEl = document.getElementById('amApellido');

      if (nombreEl && vecino.Nombre_y_Apellido) {
        const partes = vecino.Nombre_y_Apellido.split(' ');
        nombreEl.value = partes[0] || vecino.Nombre_y_Apellido;
        if (apellidoEl) apellidoEl.value = partes.slice(1).join(' ') || '';
        nombreEl.classList.add('autocomplete-field');
        if (apellidoEl) apellidoEl.classList.add('autocomplete-field');
      }

      const campos = [
        { id: 'amTelefono', campo: 'Telefono' },
        { id: 'amSector', campo: 'Sector' },
        { id: 'amCalle', campo: 'Calle_Avenida' },
        { id: 'amNroCasa', campo: 'Nro_Casa' },
        { id: 'amReferencia', campo: 'Referencia' }
      ];

      campos.forEach(c => {
        const el = document.getElementById(c.id);
        if (el && vecino[c.campo]) {
          el.value = vecino[c.campo];
          el.classList.add('autocomplete-field');
        }
      });

      if (vecino.Fecha_Nacimiento) {
        const fechaEl = document.getElementById('amFechaNacimiento');
        if (fechaEl) {
          fechaEl.value = vecino.Fecha_Nacimiento;
          fechaEl.classList.add('autocomplete-field');
          this.calcularEdad('am');
        }
      }
    } else if (tipo === 'nna') {
      const nombreRepEl = document.getElementById('nnaNombreRep');
      if (nombreRepEl && vecino.Nombre_y_Apellido) {
        nombreRepEl.value = vecino.Nombre_y_Apellido;
        nombreRepEl.classList.add('autocomplete-field');
      }
      const telefonoRepEl = document.getElementById('nnaTelefonoRep');
      if (telefonoRepEl && vecino.Telefono) {
        telefonoRepEl.value = vecino.Telefono;
        telefonoRepEl.classList.add('autocomplete-field');
      }
      const direccionRepEl = document.getElementById('nnaDireccionRep');
      if (direccionRepEl && vecino.Calle_Avenida) {
        direccionRepEl.value = vecino.Calle_Avenida;
        direccionRepEl.classList.add('autocomplete-field');
      }
    }
  }

  limpiarAutocompletado(tipo) {
    const campos = tipo === 'am' 
      ? ['amNombre', 'amApellido', 'amTelefono', 'amSector', 'amCalle', 'amNroCasa', 'amReferencia', 'amFechaNacimiento', 'amEdad']
      : ['nnaNombreRep', 'nnaTelefonoRep', 'nnaDireccionRep'];

    campos.forEach(campoId => {
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

    const campos = ['amCedula', 'amNombre', 'amApellido', 'amFechaNacimiento', 'amEdad', 'amTelefono', 
                    'amSector', 'amCalle', 'amNroCasa', 'amReferencia', 'amNecesidad', 'amBNecesidad'];
    campos.forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.value = ''; el.classList.remove('autocomplete-field'); }
    });

    ['amEstadoCaso', 'amBEstadoCaso'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.selectedIndex = 0;
    });

    document.querySelectorAll('#screenAdultos .option-btn').forEach(btn => btn.classList.remove('selected-yes', 'selected-no'));
    document.querySelectorAll('#screenAdultos .radio-item').forEach(item => item.classList.remove('selected'));
    document.querySelectorAll('#screenAdultos input[type="radio"]').forEach(r => r.checked = false);
    document.querySelectorAll('#screenAdultos .checkbox-item').forEach(item => item.classList.remove('checked'));
    document.querySelectorAll('#screenAdultos input[type="checkbox"]').forEach(c => c.checked = false);

    document.getElementById('amB_SaludOtro')?.classList.add('hidden');

    document.getElementById('pasoAdultos1').classList.remove('hidden');
    document.getElementById('pasoAdultos2').classList.add('hidden');
    document.getElementById('pasoAdultos3A').classList.add('hidden');
    document.getElementById('pasoAdultos3B').classList.add('hidden');

    document.getElementById('progressAdultos').style.width = '33%';
    document.getElementById('progressTextAdultos').textContent = 'Paso 1 de 3: Datos personales';
    document.getElementById('adultosPaso').textContent = 'Paso 1 de 3';
    document.getElementById('adultosSubtitle').textContent = 'Datos personales';
    document.getElementById('amBusquedaResultado').innerHTML = '';
  }

  adultosSiguiente(paso) {
    if (paso === 2) {
      if (!document.getElementById('amCedula').value.trim()) {
        this.mostrarToast('Ingrese la cedula', 'error');
        return;
      }
      if (!document.getElementById('amNombre').value.trim() || !document.getElementById('amApellido').value.trim()) {
        this.mostrarToast('Ingrese nombre y apellido', 'error');
        return;
      }
      if (!document.getElementById('amFechaNacimiento').value) {
        this.mostrarToast('Ingrese la fecha de nacimiento', 'error');
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

    const campos = ['nnaCedulaRep', 'nnaNombreRep', 'nnaTelefonoRep', 'nnaDireccionRep',
                    'nnaNombre', 'nnaFechaNacimiento', 'nnaEdad', 'nnaNecesidad'];
    campos.forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.value = ''; el.classList.remove('autocomplete-field'); }
    });

    document.getElementById('nnaEstadoCaso').selectedIndex = 0;
    document.querySelectorAll('#screenNNA .option-btn').forEach(btn => btn.classList.remove('selected-yes', 'selected-no'));
    document.querySelectorAll('#screenNNA .checkbox-item').forEach(item => item.classList.remove('checked'));
    document.querySelectorAll('#screenNNA input[type="checkbox"]').forEach(c => c.checked = false);
    document.querySelectorAll('#screenNNA .radio-item').forEach(item => item.classList.remove('selected'));
    document.querySelectorAll('#screenNNA input[type="radio"]').forEach(r => r.checked = false);

    document.getElementById('nnaMotivoOtro')?.classList.add('hidden');
    document.getElementById('nnaEscolarizacionDetalle')?.classList.add('hidden');

    document.getElementById('pasoNNA1').classList.remove('hidden');
    document.getElementById('pasoNNA2').classList.add('hidden');

    document.getElementById('progressNNA').style.width = '50%';
    document.getElementById('progressTextNNA').textContent = 'Paso 1 de 2: Datos personales';
    document.getElementById('nnaPaso').textContent = 'Paso 1 de 2';
    document.getElementById('nnaSubtitle').textContent = 'Datos personales';
    document.getElementById('nnaBusquedaResultado').innerHTML = '';
  }

  nnaSiguiente(paso) {
    if (paso === 2) {
      if (!document.getElementById('nnaNombre').value.trim()) {
        this.mostrarToast('Ingrese nombre del NNA', 'error');
        return;
      }
      if (!document.getElementById('nnaFechaNacimiento').value) {
        this.mostrarToast('Ingrese la fecha de nacimiento del NNA', 'error');
        return;
      }
      const edad = parseInt(document.getElementById('nnaEdad').value);
      if (!edad || edad < 0 || edad >= 18) {
        this.mostrarToast('El NNA debe ser menor de 18 anos', 'error');
        return;
      }
      if (!this.getOptionValue('nnaSexo')) {
        this.mostrarToast('Seleccione el sexo del NNA', 'error');
        return;
      }

      document.getElementById('pasoNNA1').classList.add('hidden');
      document.getElementById('pasoNNA2').classList.remove('hidden');
      document.getElementById('progressNNA').style.width = '100%';
      document.getElementById('progressTextNNA').textContent = 'Paso 2 de 2: Situacion de escolarizacion';
      document.getElementById('nnaPaso').textContent = 'Paso 2 de 2';
      document.getElementById('nnaSubtitle').textContent = 'Situacion de escolarizacion';
    }
  }

  nnaAnterior(paso) {
    if (paso === 1) {
      document.getElementById('pasoNNA2').classList.add('hidden');
      document.getElementById('pasoNNA1').classList.remove('hidden');
      document.getElementById('progressNNA').style.width = '50%';
      document.getElementById('progressTextNNA').textContent = 'Paso 1 de 2: Datos personales';
      document.getElementById('nnaPaso').textContent = 'Paso 1 de 2';
      document.getElementById('nnaSubtitle').textContent = 'Datos personales';
    }
  }

  toggleEscolarizacion(escolarizado) {
    const detalle = document.getElementById('nnaEscolarizacionDetalle');
    if (detalle) detalle.classList.toggle('hidden', !escolarizado);
  }

  // ============================================
  // INTERACCION UI
  // ============================================

  selectOption(btn) {
    const name = btn.dataset.name;
    const value = btn.dataset.value;
    document.querySelectorAll(`[data-name="${name}"]`).forEach(b => b.classList.remove('selected-yes', 'selected-no'));
    btn.classList.add(value === 'SI' ? 'selected-yes' : 'selected-no');
  }

  selectRadio(item, name) {
    document.querySelectorAll(`input[name="${name}"]`).forEach(r => {
      r.checked = false;
      r.closest('.radio-item')?.classList.remove('selected');
    });
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
    if (campo) campo.classList.toggle('hidden', !checkbox.checked);
  }

  // ============================================
  // GUARDADO
  // ============================================

  async guardarEncuesta(tipo, seccion = null) {
    const id = this.generarId();
    const fechaHora = new Date().toISOString();
    const datos = this.recolectarDatos(tipo, seccion);
    if (!datos) return;

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
      datos.cedula = document.getElementById('amCedula').value.trim();
      datos.nombre = document.getElementById('amNombre').value.trim();
      datos.apellido = document.getElementById('amApellido').value.trim();
      datos.fechaNacimiento = document.getElementById('amFechaNacimiento').value;
      datos.edad = document.getElementById('amEdad').value;
      datos.telefono = document.getElementById('amTelefono').value.trim();
      datos.sector = document.getElementById('amSector').value.trim();
      datos.calle = document.getElementById('amCalle').value.trim();
      datos.nroCasa = document.getElementById('amNroCasa').value.trim();
      datos.referencia = document.getElementById('amReferencia').value.trim();
      datos.autocompletado = document.getElementById('amNombre').classList.contains('autocomplete-field') ? 'SI' : 'NO';

      if (!esBorrador) {
        if (!datos.cedula || !datos.nombre || !datos.apellido || !datos.fechaNacimiento) {
          this.mostrarToast('Complete todos los datos personales obligatorios', 'error');
          return null;
        }
        if (parseInt(datos.edad) < 60) {
          this.mostrarToast('El adulto mayor debe tener 60+ anos', 'error');
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
      datos.repCedula = document.getElementById('nnaCedulaRep').value.trim();
      datos.repNombre = document.getElementById('nnaNombreRep').value.trim();
      datos.repTelefono = document.getElementById('nnaTelefonoRep').value.trim();
      datos.repDireccion = document.getElementById('nnaDireccionRep').value.trim();
      datos.repAutocompletado = document.getElementById('nnaNombreRep').classList.contains('autocomplete-field') ? 'SI' : 'NO';

      datos.nnaNombre = document.getElementById('nnaNombre').value.trim();
      datos.nnaFechaNacimiento = document.getElementById('nnaFechaNacimiento').value;
      datos.nnaEdad = document.getElementById('nnaEdad').value;
      datos.nnaSexo = this.getOptionValue('nnaSexo');

      datos.escolarizado = this.getOptionValue('nnaEscolarizado');
      datos.institucion = document.getElementById('nnaInstitucion')?.value?.trim() || '';
      datos.grado = document.getElementById('nnaGrado')?.value?.trim() || '';

      datos.motivoEconomico = document.getElementById('nnaMotivo1').checked ? 'SI' : 'NO';
      datos.motivoDiscapacidad = document.getElementById('nnaMotivo2').checked ? 'SI' : 'NO';
      datos.motivoTrabajo = document.getElementById('nnaMotivo3').checked ? 'SI' : 'NO';
      datos.motivoEmbarazo = document.getElementById('nnaMotivo4').checked ? 'SI' : 'NO';
      datos.motivoViolencia = document.getElementById('nnaMotivo5').checked ? 'SI' : 'NO';
      datos.motivoDesplazamiento = document.getElementById('nnaMotivo6').checked ? 'SI' : 'NO';
      datos.motivoDocumentos = document.getElementById('nnaMotivo7').checked ? 'SI' : 'NO';
      datos.motivoOtro = document.getElementById('nnaMotivoOtroCheck').checked ?
        (document.querySelector('#nnaMotivoOtro input')?.value || 'SI') : 'NO';

      datos.recibeBeneficio = this.getOptionValue('nnaBeneficio');
      datos.tipoVivienda = this.getRadioValue('nnaVivienda');

      datos.necesidad = document.getElementById('nnaNecesidad').value.trim();
      datos.estadoCaso = document.getElementById('nnaEstadoCaso').value;

      if (!esBorrador) {
        if (!datos.nnaNombre || !datos.nnaFechaNacimiento || !datos.nnaSexo) {
          this.mostrarToast('Complete los datos del NNA', 'error');
          return null;
        }
        if (parseInt(datos.nnaEdad) >= 18) {
          this.mostrarToast('El NNA debe ser menor de 18 anos', 'error');
          return null;
        }
      }
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

      if (indicator) indicator.className = online ? 'status-indicator online' : 'status-indicator offline';
      if (text) text.textContent = online ? 'Conectado' : 'Sin conexion';

      if (online) this.sincronizarAutomatica();
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
      await this.descargarBaseVecinos();
      await this.enviarEncuestasPendientes();
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

  async sincronizarEncuestadores() {
    if (!CONFIG.SCRIPT_URL) {
      console.log('[Sync] URL del script no configurada');
      return;
    }

    try {
      this.mostrarLoading('Sincronizando encuestadores...');
      const response = await fetch(`${CONFIG.SCRIPT_URL}?action=getEncuestadores&token=${CONFIG.TOKEN_SEGURIDAD}`);

      if (!response.ok) throw new Error('Error al descargar encuestadores');

      const data = await response.json();
      if (data.success && data.encuestadores && data.encuestadores.length > 0) {
        await this.dbOperation('encuestadores', 'readwrite', store => store.clear());

        for (const enc of data.encuestadores) {
          await this.dbOperation('encuestadores', 'readwrite', store => store.put(enc));
        }

        this.encuestadores = data.encuestadores;
        this.actualizarSelectEncuestadores();
        this.mostrarToast(`${data.encuestadores.length} encuestadores sincronizados`, 'success');
        console.log(`[Sync] ${data.encuestadores.length} encuestadores descargados`);
      } else {
        console.log('[Sync] No hay encuestadores en el servidor');
      }
    } catch (e) {
      console.error('[Sync] Error descargando encuestadores:', e);
      this.mostrarToast('No se pudieron sincronizar encuestadores. Modo offline.', 'warning');
    } finally {
      this.ocultarLoading();
    }
  }

  async descargarBaseVecinos() {
    try {
      const response = await fetch(`${CONFIG.SCRIPT_URL}?action=getVecinos&token=${CONFIG.TOKEN_SEGURIDAD}`);
      if (!response.ok) throw new Error('Error al descargar vecinos');

      const data = await response.json();
      if (data.success && data.vecinos) {
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

  async guardarMetadato(clave, valor) {
    await this.dbOperation('metadatos', 'readwrite', store => store.put({ clave, valor }));
  }

  // ============================================
  // SEGUIMIENTO
  // ============================================

  async abrirSeguimiento() {
    this.mostrarPantalla('screenSeguimiento');
    await this.filtrarCasos();
  }

  async filtrarCasos() {
    try {
      const tipoFiltro = document.getElementById('filtroTipo').value;
      const estadoFiltro = document.getElementById('filtroEstado').value;

      let casos = await this.dbOperation('encuestas', 'readonly', store => store.getAll());
      casos = casos.filter(c => c.encuestadorId === this.session.encuestadorId);

      if (tipoFiltro) casos = casos.filter(c => c.tipo === tipoFiltro);
      if (estadoFiltro) casos = casos.filter(c => c.datos.estadoCaso === estadoFiltro);

      const contenedor = document.getElementById('listaCasos');

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
      ? `${caso.datos.nombre || ''} ${caso.datos.apellido || ''}`
      : caso.datos.nnaNombre || '';
    const tipo = caso.tipo === 'adultos' ? '👴 Adulto Mayor' : '👦 NNA';
    const seccion = caso.seccion ? ` - Sec. ${caso.seccion}` : '';
    const fecha = this.formatearFecha(caso.fecha);
    const sync = caso.estadoSync === 'sincronizado' ? '✅' : '🔴';

    return `<div class="caso-item ${estado}" onclick="app.abrirEditarCaso('${caso.id}')">
      <div class="caso-header">
        <span class="caso-nombre">${nombre}</span>
        <span class="caso-estado ${estado}">${estado.toUpperCase()}</span>
      </div>
      <div class="caso-info">${tipo}${seccion} | ${sync} ${fecha} | ${caso.encuestador}</div>
    </div>`;
  }

  async abrirEditarCaso(id) {
    try {
      const caso = await this.dbOperation('encuestas', 'readonly', store => store.get(id));
      if (!caso) return;

      this.casoEditando = caso;
      const nombre = caso.tipo === 'adultos'
        ? `${caso.datos.nombre || ''} ${caso.datos.apellido || ''}`
        : caso.datos.nnaNombre || '';

      document.getElementById('editarCasoSubtitle').textContent = `Editando: ${nombre}`;
      document.getElementById('editarNecesidad').value = caso.datos.necesidad || '';
      document.getElementById('editarEstadoCaso').value = caso.datos.estadoCaso || 'pendiente';
      document.getElementById('editarNotas').value = caso.datos.notasSeguimiento || '';

      this.mostrarPantalla('screenEditarCaso');
    } catch (e) {
      console.error('[Casos] Error editando:', e);
    }
  }

  volverSeguimiento() {
    this.mostrarPantalla('screenSeguimiento');
    this.casoEditando = null;
  }

  async guardarEdicionCaso() {
    if (!this.casoEditando) return;

    const caso = this.casoEditando;
    caso.datos.necesidad = document.getElementById('editarNecesidad').value.trim();
    caso.datos.estadoCaso = document.getElementById('editarEstadoCaso').value;
    caso.datos.notasSeguimiento = document.getElementById('editarNotas').value.trim();
    caso.estadoSync = 'pendiente';
    caso.fecha = new Date().toISOString();

    await this.dbOperation('encuestas', 'readwrite', store => store.put(caso));
    this.mostrarToast('Caso actualizado', 'success');
    this.volverSeguimiento();
    await this.filtrarCasos();
  }

  // ============================================
  // UTILIDADES
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

  iniciarAutoGuardado() {
    setInterval(() => {
      if (this.currentEncuesta && (this.currentEncuesta.estadoSync === 'borrador' || !this.currentEncuesta.estadoSync)) {
        const tipo = this.currentEncuesta.tipo;
        const seccion = this.currentSeccion;
        this.guardarBorrador(tipo, seccion);
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
      if (e.target.tagName === 'INPUT' && e.target.type === 'number') {
        e.target.style.fontSize = '16px';
      }
    });

    document.getElementById('loginPin')?.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.login();
    });
  }

  async exportarRespaldoCSV() {
    try {
      const encuestas = await this.dbOperation('encuestas', 'readonly', store => store.getAll());
      if (encuestas.length === 0) {
        this.mostrarToast('No hay datos para exportar', 'warning');
        return;
      }

      let csv = 'ID,Tipo,Seccion,Encuestador,Fecha,EstadoSync,Cedula,Nombre,Apellido,Edad\n';
      encuestas.forEach(e => {
        const nombre = e.tipo === 'adultos'
          ? `${e.datos.nombre || ''} ${e.datos.apellido || ''}`
          : `${e.datos.nnaNombre || ''}`;
        const cedula = e.tipo === 'adultos' ? (e.datos.cedula || '') : (e.datos.repCedula || '');
        const edad = e.tipo === 'adultos' ? (e.datos.edad || '') : (e.datos.nnaEdad || '');
        csv += `${e.id},${e.tipo},${e.seccion || ''},${e.encuestador},${e.fecha},${e.estadoSync},${cedula},"${nombre}",${edad}\n`;
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

const app = new DiagSocialApp();
document.addEventListener('DOMContentLoaded', () => { app.init(); });
window.app = app;
