const express = require('express');
const { createServer } = require('node:http');
const { join } = require('node:path');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const { availableParallelism } = require('node:os');
const cluster = require('node:cluster');
const { createAdapter, setupPrimary } = require('@socket.io/cluster-adapter');

if (cluster.isPrimary) {
  const numCPUs = availableParallelism();
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork({ PORT: 3000 + i });
  }

  return setupPrimary();
}

async function main() {
  await mongoose.connect('mongodb://127.0.0.1:27017/chat', {
    useNewUrlParser: true,
    useUnifiedTopology: true
  });

  const messageSchema = new mongoose.Schema({
    content: String,
    client_offset: { type: String, unique: true },
  });

  const Message = mongoose.model('Message', messageSchema);

  const app = express();
  const server = createServer(app);
  const io = new Server(server, {
    connectionStateRecovery: {},
    adapter: createAdapter()
  });

  app.get('/', (req, res) => {
    res.sendFile(join(__dirname, 'index.html'));
  });

  io.on('connection', async (socket) => {
    socket.on('chat message', async (msg, clientOffset, callback) => {
      try {
        const message = await Message.create({ content: msg, client_offset: clientOffset });
        io.emit('chat message', message.content, message._id.toString());
        callback?.();
      } catch (e) {
        if (e.code === 11000 /* duplicate key */) {
          callback?.(); // already inserted, just acknowledge
        } else {
          console.error('Insert error:', e);
        }
      }
    });

    if (!socket.recovered) {
      const offset = socket.handshake.auth.serverOffset || '000000000000000000000000';
      try {
        const recentMessages = await Message.find({ _id: { $gt: offset } }).sort({ _id: 1 }).exec();
        for (const message of recentMessages) {
          socket.emit('chat message', message.content, message._id.toString());
        }
      } catch (e) {
        console.error('Recovery error:', e);
      }
    }
  });

  const port = process.env.PORT;
  server.listen(port, () => {
    console.log(`server running at http://localhost:${port}`);
  });
}

main();
