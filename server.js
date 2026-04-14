// =========================================
// server.js - Servidor Backend Node.js
// =========================================
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const fs = require('fs');         
const path = require('path');     

const app = express();
const puerto = process.env.PORT || 3000;

app.use(cors()); 
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// =========================================
// CONFIGURACIÓN DE MULTER (ALMACENAMIENTO)
// =========================================
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/'); 
    },
    filename: function (req, file, cb) {
        cb(null, file.originalname);
    }
});

const upload = multer({ storage: storage });

// =========================================
// CONFIGURACIÓN DE POSTGRESQL
// =========================================
// =========================================
// CONFIGURACIÓN DE POSTGRESQL (NUBE Y LOCAL)
// =========================================
const pool = new Pool({
    // Render nos dará una URL de base de datos segura (DATABASE_URL)
    // Si no existe (porque estás en tu PC), usa tus credenciales locales.
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:60409441@localhost:5432/basedatso2',
    // SSL es obligatorio en plataformas como Render
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

pool.connect()
    .then(() => console.log('✅ Conexión a PostgreSQL establecida.'))
    .catch(err => console.error('❌ Error al conectar a PostgreSQL:', err.message));

// =========================================
// RUTAS (ENDPOINTS) DE LA API
// =========================================

// Ruta POST para validar el Inicio de Sesión
app.post('/api/login', async (req, res) => {
    const { codigo, password } = req.body;
    try {
        const consulta = 'SELECT * FROM usuarios WHERE codigo_usuario = $1 AND estado = TRUE';
        const resultado = await pool.query(consulta, [codigo]);
        if (resultado.rows.length > 0) {
            const usuarioBD = resultado.rows[0];
            if (password === usuarioBD.password_hash) {
                res.status(200).json({ success: true, usuario: { nombres: usuarioBD.nombres, rol: usuarioBD.rol } });
            } else {
                res.status(401).json({ success: false, mensaje: 'Contraseña incorrecta' });
            }
        } else {
            res.status(404).json({ success: false, mensaje: 'Usuario no encontrado o inactivo' });
        }
    } catch (error) {
        res.status(500).json({ success: false, mensaje: 'Error interno del servidor' });
    }
});

// Ruta POST para recibir Entregas + Archivos Físicos
app.post('/api/entregas', upload.array('archivos'), async (req, res) => {
    const { week, title } = req.body;
    const archivosSubidos = req.files;

    if (!archivosSubidos || archivosSubidos.length === 0) {
        return res.status(400).json({ error: 'No se subieron archivos' });
    }

    const nombresOriginales = archivosSubidos.map(f => f.originalname).join(', ');
    const pesoTotalBytes = archivosSubidos.reduce((acc, f) => acc + f.size, 0);
    const fileSizeMB = (pesoTotalBytes / (1024 * 1024)).toFixed(2);

    try {
        const consulta = `
            INSERT INTO entregas (unidad_semana, titulo, nombre_archivo, peso_mb) 
            VALUES ($1, $2, $3, $4) RETURNING *;
        `;
        const valores = [week, title, nombresOriginales, fileSizeMB];

        const resultado = await pool.query(consulta, valores);
        res.status(201).json({ mensaje: 'Entrega registrada y archivos guardados', datos: resultado.rows[0] });
    } catch (error) {
        console.error('Error al insertar:', error);
        res.status(500).json({ error: 'Error interno al guardar en BD' });
    }
});

// Ruta GET para obtener historial
app.get('/api/entregas', async (req, res) => {
    try {
        const resultado = await pool.query('SELECT * FROM entregas ORDER BY fecha_subida DESC');
        res.status(200).json(resultado.rows);
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener el historial' });
    }
});

// UPDATE (Editar entrega y gestionar archivos inteligentemente)
app.put('/api/entregas/:id', upload.array('archivos'), async (req, res) => {
    const id = req.params.id;
    // Capturamos el keepOld que nos mandó el Frontend
    const { week, title, keepOld } = req.body; 
    const archivosSubidos = req.files;

    try {
        if (archivosSubidos && archivosSubidos.length > 0) {
            
            // 1. Obtenemos lo que ya estaba en la base de datos
            const consultaSelect = 'SELECT nombre_archivo, peso_mb FROM entregas WHERE id = $1';
            const resultadoSelect = await pool.query(consultaSelect, [id]);
            
            let viejosNombres = '';
            let viejoPeso = 0;

            if (resultadoSelect.rows.length > 0) {
                viejosNombres = resultadoSelect.rows[0].nombre_archivo || '';
                viejoPeso = parseFloat(resultadoSelect.rows[0].peso_mb || 0);
            }

            // 2. Calculamos los datos de los nuevos archivos
            const nuevosNombres = archivosSubidos.map(f => f.originalname).join(', ');
            const nuevoPeso = archivosSubidos.reduce((acc, f) => acc + f.size, 0) / (1024 * 1024);

            let nombresFinales = nuevosNombres;
            let pesoFinalMB = nuevoPeso.toFixed(2);

            // 3. LA LÓGICA DE DECISIÓN
            if (keepOld === 'true') {
                // SUMAR: Concatenamos los textos y sumamos los pesos
                if (viejosNombres && viejosNombres !== 'null') {
                    nombresFinales = viejosNombres + ', ' + nuevosNombres;
                    pesoFinalMB = (viejoPeso + nuevoPeso).toFixed(2);
                }
            } else {
                // REEMPLAZAR: Borramos los físicos viejos (como hacíamos antes)
                if (viejosNombres && viejosNombres !== 'null') {
                    viejosNombres.split(',').map(a => a.trim()).forEach(archivo => {
                        const rutaArchivo = path.join(__dirname, 'uploads', archivo);
                        if (fs.existsSync(rutaArchivo)) { fs.unlinkSync(rutaArchivo); }
                    });
                }
            }

            // 4. Actualizamos la BD con los datos finales combinados
            const consulta = `UPDATE entregas SET unidad_semana = $1, titulo = $2, nombre_archivo = $3, peso_mb = $4 WHERE id = $5 RETURNING *;`;
            const resultado = await pool.query(consulta, [week, title, nombresFinales, pesoFinalMB, id]);
            res.status(200).json({ mensaje: 'Archivos procesados correctamente', datos: resultado.rows[0] });
            
        } else {
            // Si no subió archivos, solo cambiamos texto
            const consulta = `UPDATE entregas SET unidad_semana = $1, titulo = $2 WHERE id = $3 RETURNING *;`;
            const resultado = await pool.query(consulta, [week, title, id]);
            res.status(200).json({ mensaje: 'Actualizado sin cambiar archivos', datos: resultado.rows[0] });
        }

    } catch (error) {
        console.error('Error al editar:', error);
        res.status(500).json({ error: 'Error interno al editar' });
    }
});

// Ruta DELETE para eliminar una entrega
app.delete('/api/entregas/:id', async (req, res) => {
    const id = req.params.id;

    try {
        const consultaSelect = 'SELECT nombre_archivo FROM entregas WHERE id = $1';
        const resultadoSelect = await pool.query(consultaSelect, [id]);

        if (resultadoSelect.rows.length > 0) {
            const archivosString = resultadoSelect.rows[0].nombre_archivo;
            
            if (archivosString && archivosString !== 'null') {
                const archivosArray = archivosString.split(',').map(a => a.trim());
                archivosArray.forEach(archivo => {
                    const rutaArchivo = path.join(__dirname, 'uploads', archivo);
                    if (fs.existsSync(rutaArchivo)) {
                        fs.unlinkSync(rutaArchivo); 
                    }
                });
            }
        }

        const consultaDelete = 'DELETE FROM entregas WHERE id = $1 RETURNING *;';
        const resultadoDelete = await pool.query(consultaDelete, [id]);

        if (resultadoDelete.rows.length > 0) {
            res.status(200).json({ mensaje: 'Entrega eliminada exitosamente de la BD' });
        } else {
            res.status(404).json({ error: 'Entrega no encontrada' });
        }
    } catch (error) {
        console.error('Error al eliminar:', error);
        res.status(500).json({ error: 'Error interno del servidor al eliminar' });
    }
});

app.listen(puerto, () => {
    console.log(`🚀 Servidor escuchando en http://localhost:${puerto}`);
});