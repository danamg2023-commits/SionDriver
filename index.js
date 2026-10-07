const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) {
        console.error('Error al abrir la base de datos:', err.message);
    } else {
        console.log('Conectado a la base de datos SQLite.');
        
        // Crear tabla principal con todas las columnas necesarias
        db.run(`CREATE TABLE IF NOT EXISTS viajes (
            id TEXT PRIMARY KEY,
            pasajeroNombre TEXT,
            tipoVehiculo TEXT,
            origen TEXT,
            destino TEXT,
            ofertaInicial REAL,
            incremento REAL,
            estado TEXT,
            conductorNombre TEXT,
            codigoVerificacion TEXT,
            coordsOrigen TEXT,
            coordsDestino TEXT,
            socketIdPasajero TEXT
        )`, () => {
            // Autocorrección por si la tabla ya existía incompleta: agrega columnas si faltan
            db.run(`ALTER TABLE viajes ADD COLUMN ofertaInicial REAL`, () => {});
            db.run(`ALTER TABLE viajes ADD COLUMN incremento REAL`, () => {});
            db.run(`ALTER TABLE viajes ADD COLUMN socketIdPasajero TEXT`, () => {});
            db.run(`ALTER TABLE viajes ADD COLUMN coordsOrigen TEXT`, () => {});
            db.run(`ALTER TABLE viajes ADD COLUMN coordsDestino TEXT`, () => {});
            db.run(`ALTER TABLE viajes ADD COLUMN codigoVerificacion TEXT`, () => {});
            db.run(`ALTER TABLE viajes ADD COLUMN conductorNombre TEXT`, () => {});
        });

        db.run(`CREATE TABLE IF NOT EXISTS ofertas_pilotos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            viajeId TEXT,
            conductorNombre TEXT,
            montoOferta REAL
        )`);

        // Limpieza automática al arrancar
        db.run(`UPDATE viajes SET estado = 'cancelado' WHERE estado = 'buscando'`, (err) => {
            if (!err) console.log('🧹 Limpieza de viajes fantasmas anteriores realizada.');
        });
    }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

io.on('connection', (socket) => {
    console.log('Usuario conectado:', socket.id);

    socket.on('solicitar_viajes_pendientes', () => {
        db.all(`SELECT * FROM viajes WHERE estado = 'buscando'`, [], (err, rows) => {
            if (!err && rows) {
                rows.forEach(row => {
                    row.coordsOrigen = row.coordsOrigen ? JSON.parse(row.coordsOrigen) : null;
                    row.coordsDestino = row.coordsDestino ? JSON.parse(row.coordsDestino) : null;
                    socket.emit('nuevo_viaje_disponible', row);
                });
            }
        });
    });

    socket.on('solicitar_viaje', (data) => {
        let viajeId = data.viajeId;
        const esNuevo = !viajeId;

        if (esNuevo) {
            viajeId = 'v_' + Math.random().toString(36).substr(2, 9);
            socket.emit('viaje_creado_id', viajeId);
        }

        const coordsOrigenStr = data.coordsOrigen ? JSON.stringify(data.coordsOrigen) : null;
        const coordsDestinoStr = data.coordsDestino ? JSON.stringify(data.coordsDestino) : null;

        const query = esNuevo 
            ? `INSERT INTO viajes (id, pasajeroNombre, tipoVehiculo, origen, destino, ofertaInicial, incremento, estado, coordsOrigen, coordsDestino, socketIdPasajero) VALUES (?, ?, ?, ?, ?, ?, ?, 'buscando', ?, ?, ?)`
            : `UPDATE viajes SET origen = ?, destino = ?, ofertaInicial = ?, incremento = ?, tipoVehiculo = ?, coordsOrigen = ?, coordsDestino = ? WHERE id = ?`;

        const params = esNuevo 
            ? [viajeId, data.pasajero, data.tipoVehiculo, data.origen, data.destino, data.oferta, data.incremento, coordsOrigenStr, coordsDestinoStr, socket.id]
            : [data.origen, data.destino, data.oferta, data.incremento, data.tipoVehiculo, coordsOrigenStr, coordsDestinoStr, viajeId];

        db.run(query, params, function(err) {
            if (err) {
                console.error('❌ ERROR SQL DETALLADO:', err.message);
                socket.emit('respuesta_viaje', { estado: 'error', mensaje: 'Error al procesar el viaje: ' + err.message });
                return;
            }

            socket.emit('respuesta_viaje', { estado: 'exito', mensaje: esNuevo ? '¡Viaje solicitado!' : '¡Oferta actualizada!' });

            const viajeActualizado = {
                id: viajeId,
                pasajeroNombre: data.pasajero,
                tipoVehiculo: data.tipoVehiculo,
                origen: data.origen,
                destino: data.destino,
                ofertaInicial: data.oferta,
                incremento: data.incremento,
                coordsOrigen: data.coordsOrigen,
                coordsDestino: data.coordsDestino
            };
            io.emit('nuevo_viaje_disponible', viajeActualizado);
        });
    });

    socket.on('cancelar_viaje', (data) => {
        db.run(`UPDATE viajes SET estado = 'cancelado' WHERE id = ?`, [data.viajeId], function(err) {
            if (!err) {
                io.emit('viaje_cancelado_exito', { viajeId: data.viajeId });
                db.run(`DELETE FROM ofertas_pilotos WHERE viajeId = ?`, [data.viajeId]);
            }
        });
    });

    socket.on('contraofertar', (data) => {
        db.get(`SELECT * FROM ofertas_pilotos WHERE viajeId = ? AND conductorNombre = ?`, [data.viajeId, data.conductorNombre], (err, row) => {
            if (row) {
                db.run(`UPDATE ofertas_pilotos SET montoOferta = ? WHERE id = ?`, [data.nuevoPrecio, row.id]);
            } else {
                db.run(`INSERT INTO ofertas_pilotos (viajeId, conductorNombre, montoOferta) VALUES (?, ?, ?)`, [data.viajeId, data.conductorNombre, data.nuevoPrecio]);
            }

            io.emit('contraoferta_recibida', { 
                viajeId: data.viajeId, 
                conductorNombre: data.conductorNombre, 
                oferta: data.nuevoPrecio 
            });
        });
    });

    socket.on('aceptar_oferta_piloto', (data) => {
        const codigoVerificacion = Math.floor(100 + Math.random() * 900).toString();

        db.run(
            `UPDATE viajes SET estado = 'aceptado', conductorNombre = ?, ofertaInicial = ?, codigoVerificacion = ? WHERE id = ?`,
            [data.conductorNombre, data.precioAcordado, codigoVerificacion, data.viajeId],
            function(err) {
                if (!err) {
                    db.get(`SELECT * FROM viajes WHERE id = ?`, [data.viajeId], (err, row) => {
                        if (row) {
                            row.coordsOrigen = row.coordsOrigen ? JSON.parse(row.coordsOrigen) : null;
                            row.coordsDestino = row.coordsDestino ? JSON.parse(row.coordsDestino) : null;
                            io.emit('viaje_aceptado_exito', row);
                        }
                    });
                }
            }
        );
    });

    socket.on('actualizar_ubicacion_piloto', (data) => {
        io.emit('ubicacion_piloto_en_vivo', data);
    });

    socket.on('iniciar_recogida_piloto', (data) => {
        db.run(`UPDATE viajes SET estado = 'en_recogida' WHERE id = ?`, [data.viajeId], (err) => {
            if (!err) {
                io.emit('recogida_iniciada_exito', { viajeId: data.viajeId });
            }
        });
    });

    socket.on('verificar_codigo', (data) => {
        db.get(`SELECT * FROM viajes WHERE id = ?`, [data.viajeId], (err, row) => {
            if (row && row.codigoVerificacion === data.codigo) {
                db.run(`UPDATE viajes SET estado = 'en_curso' WHERE id = ?`, [data.viajeId], (err) => {
                    if (!err) {
                        row.coordsOrigen = row.coordsOrigen ? JSON.parse(row.coordsOrigen) : null;
                        row.coordsDestino = row.coordsDestino ? JSON.parse(row.coordsDestino) : null;
                        io.emit('viaje_iniciado_exito', row);
                    }
                });
            } else {
                socket.emit('error_codigo', { mensaje: '❌ Código incorrecto.' });
            }
        });
    });

    socket.on('disconnect', () => {
        console.log('Usuario desconectado:', socket.id);
        db.all(`SELECT id FROM viajes WHERE socketIdPasajero = ? AND estado = 'buscando'`, [socket.id], (err, rows) => {
            if (!err && rows) {
                rows.forEach(row => {
                    db.run(`UPDATE viajes SET estado = 'cancelado' WHERE id = ?`, [row.id]);
                    io.emit('viaje_cancelado_exito', { viajeId: row.id });
                });
            }
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});