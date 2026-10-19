'use strict';
// Stand-in for the `server-destroy` package (used by refs/jsdom/test/api/helpers/servers.js): adds
// `server.destroy(cb)`, which closes the server and every open connection.
module.exports = function enableDestroy(server) {
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.destroy = (cb) => {
    server.close(cb);
    for (const s of sockets) s.destroy();
  };
};
