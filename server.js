// =========================================
// server.js - Servidor Backend Node.js (Cloudinary Version)
// =========================================
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
const puerto = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// =========================================
// CONFIGURACIÓN DE CLOUDINARY
// =========================================
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
        folder: 'portafolio_upla', // Cloudinary creará esta carpeta
        resource_type: 'auto',     // Súper importante para PDFs, ZIPs, etc.
        public_id: (req, file) => {
            // Nombre limpio sin espacios ni caracteres raros
            return file.originalname.split('.')[0]
                .toLowerCase()
                .replace(/\s+/g, '-')
                .replace(/[^\w.-]/g, '');
        }
    }
});

const upload = multer({ storage: storage });

// =========================================
// CONFIGURACIÓN DE POSTGRESQL (NUBE Y LOCAL)
// =========================================
const pool = new Pool({
    // Render nos dará una URL de base de datos segura (DATABASE_URL)
    // Si no existe, usa la conexión local apuntando a tu base de datos techzone
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:60409441@localhost:5432/techzone',
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

// Ruta POST para recibir Entregas + Archivos en Cloudinary
app.post('/api/entregas', upload.array('archivos'), async (req, res) => {
    const { week, title } = req.body;
    const archivosSubidos = req.files;

    if (!archivosSubidos || archivosSubidos.length === 0) {
        return res.status(400).json({ error: 'No se subieron archivos' });
    }

    // AHORA GUARDAMOS LAS URLs DE CLOUDINARY (path), NO LOS NOMBRES LOCALES
    const urlsCloudinary = archivosSubidos.map(f => f.path).join(', ');
    const pesoTotalBytes = archivosSubidos.reduce((acc, f) => acc + f.size, 0);
    const fileSizeMB = (pesoTotalBytes / (1024 * 1024)).toFixed(2);

    try {
        const consulta = `
            INSERT INTO entregas (unidad_semana, titulo, nombre_archivo, peso_mb) 
            VALUES ($1, $2, $3, $4) RETURNING *;
        `;
        // Guardamos las URLs separadas por coma en la base de datos
        const valores = [week, title, urlsCloudinary, fileSizeMB];

        const resultado = await pool.query(consulta, valores);
        res.status(201).json({ mensaje: 'Entrega registrada y archivos guardados en Cloudinary', datos: resultado.rows[0] });
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

// UPDATE (Editar entrega y gestionar archivos en Cloudinary inteligentemente)
app.put('/api/entregas/:id', upload.array('archivos'), async (req, res) => {
    const id = req.params.id;
    const { week, title, keepOld } = req.body;
    const archivosSubidos = req.files;

    try {
        if (archivosSubidos && archivosSubidos.length > 0) {

            const consultaSelect = 'SELECT nombre_archivo, peso_mb FROM entregas WHERE id = $1';
            const resultadoSelect = await pool.query(consultaSelect, [id]);

            let viejasUrls = '';
            let viejoPeso = 0;

            if (resultadoSelect.rows.length > 0) {
                viejasUrls = resultadoSelect.rows[0].nombre_archivo || '';
                viejoPeso = parseFloat(resultadoSelect.rows[0].peso_mb || 0);
            }

            // Usamos f.path para obtener la URL de Cloudinary
            const nuevasUrls = archivosSubidos.map(f => f.path).join(', ');
            const nuevoPeso = archivosSubidos.reduce((acc, f) => acc + f.size, 0) / (1024 * 1024);

            let urlsFinales = nuevasUrls;
            let pesoFinalMB = nuevoPeso.toFixed(2);

            if (keepOld === 'true') {
                if (viejasUrls && viejasUrls !== 'null') {
                    urlsFinales = viejasUrls + ', ' + nuevasUrls;
                    pesoFinalMB = (viejoPeso + nuevoPeso).toFixed(2);
                }
            }
            // Nota: Si keepOld es 'false', Cloudinary mantiene los archivos viejos en su nube como backup histórico, 
            // pero en nuestra BD solo quedarán las nuevas URLs, reemplazando las anteriores en la vista del usuario.

            const consulta = `UPDATE entregas SET unidad_semana = $1, titulo = $2, nombre_archivo = $3, peso_mb = $4 WHERE id = $5 RETURNING *;`;
            const resultado = await pool.query(consulta, [week, title, urlsFinales, pesoFinalMB, id]);
            res.status(200).json({ mensaje: 'Archivos procesados correctamente en Cloudinary', datos: resultado.rows[0] });

        } else {
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
    console.log(`🚀 Servidor escuchando en puerto ${puerto}`);
});